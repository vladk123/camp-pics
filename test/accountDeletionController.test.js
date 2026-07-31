import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED,
  ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE,
  AccountDeletionError,
} from '../utils/accountDeletion.js';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const {
  createDeleteAccountController,
} = await import('../controllers/users.js');

function makeHarness({
  bodyPassword = 'CorrectPassword9',
  omitPassword = false,
  authenticated = true,
  authenticationThrows = false,
  admin = false,
  missingUser = false,
  serviceError = null,
  logoutFails = false,
  destroyFails = false,
  cleanupThrows = false,
  redirectThrowsAfterCommit = false,
} = {}) {
  const userId = new mongoose.Types.ObjectId();
  const cleanupJobId = new mongoose.Types.ObjectId();
  const calls = {
    selected: [],
    passwords: [],
    service: [],
    cleanup: [],
    logs: [],
    redirects: [],
    clearCookies: [],
    logout: 0,
    destroy: 0,
    regenerate: 0,
  };
  const credentialUser = {
    _id: userId,
    hash: 'credential-hash',
    salt: 'credential-salt',
  };
  const freshUser = missingUser
    ? null
    : {
      ...credentialUser,
      isAdmin: admin,
      async authenticate(password) {
        calls.passwords.push(password);
        if (authenticationThrows) {
          throw new Error(`internal auth failure ${password}`);
        }
        return authenticated
          ? { user: credentialUser }
          : { user: false, error: new Error('incorrect') };
      },
    };
  const UserModel = {
    findById(receivedUserId) {
      assert.equal(receivedUserId, userId);
      return {
        async select(projection) {
          calls.selected.push(projection);
          return freshUser;
        },
      };
    },
  };
  const deletionService = {
    async deleteAccount(request) {
      calls.service.push(request);
      if (serviceError) throw serviceError;
      return {
        cleanupJobIds: [cleanupJobId],
        counts: { usersDeleted: 1 },
      };
    },
  };
  const cleanupProcessor = {
    async processJobById(jobId) {
      calls.cleanup.push(jobId);
      if (cleanupThrows) throw new Error('raw cleanup failure');
      return { completed: true, status: 'completed' };
    },
  };
  const req = {
    body: omitPassword
      ? {}
      : { current_password: bodyPassword },
    user: { _id: userId },
    logout(callback) {
      calls.logout += 1;
      if (logoutFails) return callback(new Error('raw logout failure'));
      this.user = undefined;
      return callback();
    },
  };
  const session = {
    destroy(callback) {
      calls.destroy += 1;
      if (destroyFails) return callback(new Error('raw destroy failure'));
      delete req.session;
      return callback();
    },
    regenerate(callback) {
      calls.regenerate += 1;
      req.session = { anonymous: true };
      return callback();
    },
  };
  req.session = session;
  const res = {
    headersSent: false,
    clearCookie(name, options) {
      calls.clearCookies.push({ name, options });
    },
    redirect(url) {
      calls.redirects.push(url);
      this.headersSent = true;
      return this;
    },
  };
  let committed = false;
  const redirectWithFlash = async (request, response, type, message, url) => {
    if (redirectThrowsAfterCommit && committed) {
      throw new Error('raw redirect failure');
    }
    calls.redirects.push({ type, message, url });
    response.headersSent = true;
  };
  const originalDelete = deletionService.deleteAccount;
  deletionService.deleteAccount = async request => {
    const result = await originalDelete(request);
    committed = true;
    return result;
  };
  const controller = createDeleteAccountController({
    UserModel,
    deletionService,
    cleanupProcessor,
    log: async (request, response, type, details) => {
      calls.logs.push({ request, response, type, details });
    },
    redirectWithFlash,
    sessionCookieName: 'camp-session',
  });

  const invoke = async () => {
    let nextError;
    await controller(req, res, error => {
      nextError = error;
    });
    return { nextError, req, res };
  };

  return { calls, cleanupJobId, invoke, userId };
}

describe('account deletion password confirmation', () => {
  for (const scenario of [
    { label: 'undefined', options: { omitPassword: true } },
    { label: 'empty', options: { bodyPassword: '' } },
    { label: 'whitespace', options: { bodyPassword: '   ' } },
  ]) {
    test(`missing password value ${scenario.label} rejects before service`, async () => {
      const harness = makeHarness(scenario.options);
      await harness.invoke();

      assert.equal(harness.calls.selected.length, 0);
      assert.equal(harness.calls.service.length, 0);
      assert.equal(harness.calls.redirects.length, 1);
    });
  }

  test('incorrect password rejects before the service', async () => {
    const harness = makeHarness({ authenticated: false });
    await harness.invoke();

    assert.deepEqual(harness.calls.selected, ['+hash +salt']);
    assert.equal(harness.calls.service.length, 0);
    assert.equal(harness.calls.logout, 0);
    assert.equal(harness.calls.redirects.length, 1);
  });

  test('correct password passes only the credential fingerprint to the service', async () => {
    const harness = makeHarness();
    await harness.invoke();

    assert.equal(harness.calls.service.length, 1);
    assert.deepEqual(harness.calls.service[0], {
      userId: harness.userId,
      authenticatedHash: 'credential-hash',
      authenticatedSalt: 'credential-salt',
    });
    assert.equal('current_password' in harness.calls.service[0], false);
  });

  test('authentication errors use the same outward message and never log password', async () => {
    const password = 'DoNotLogThisPassword9';
    const harness = makeHarness({
      bodyPassword: password,
      authenticationThrows: true,
    });
    await harness.invoke();

    assert.equal(harness.calls.service.length, 0);
    assert.equal(harness.calls.logs.length, 1);
    assert.doesNotMatch(JSON.stringify(harness.calls.logs), new RegExp(password));
    assert.match(
      harness.calls.redirects[0].message,
      /incorrect or could not be verified/u,
    );
  });

  test('fresh administrator status rejects a direct POST server-side', async () => {
    const harness = makeHarness({ admin: true });
    await harness.invoke();

    assert.equal(harness.calls.passwords.length, 0);
    assert.equal(harness.calls.service.length, 0);
    assert.match(
      harness.calls.redirects[0].message,
      /cannot be deleted through self-service/u,
    );
  });
});

describe('account deletion safe errors', () => {
  test('media review is a safe conflict form response', async () => {
    const harness = makeHarness({
      serviceError: new AccountDeletionError(
        ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED,
      ),
    });
    await harness.invoke();

    assert.match(
      harness.calls.redirects[0].message,
      /Support must review old media records/u,
    );
    assert.doesNotMatch(
      harness.calls.redirects[0].message,
      /public|cloudinary|url|media id/iu,
    );
    assert.equal(harness.calls.logout, 0);
  });

  test('transaction unavailability is a safe temporary form response', async () => {
    const harness = makeHarness({
      serviceError: new AccountDeletionError(
        ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE,
      ),
    });
    await harness.invoke();

    assert.match(harness.calls.redirects[0].message, /temporarily unavailable/u);
    assert.equal(harness.calls.cleanup.length, 0);
  });
});

describe('post-commit account deletion behavior', () => {
  test('commit is followed by logout, session destruction, cookie clearing and cleanup', async () => {
    const harness = makeHarness();
    await harness.invoke();

    assert.equal(harness.calls.service.length, 1);
    assert.equal(harness.calls.logout, 1);
    assert.equal(harness.calls.destroy, 1);
    assert.deepEqual(harness.calls.clearCookies, [{
      name: 'camp-session',
      options: { path: '/' },
    }]);
    assert.deepEqual(harness.calls.cleanup, [harness.cleanupJobId]);
    assert.equal(harness.calls.regenerate, 1);
    assert.equal(harness.calls.redirects.length, 1);
    assert.match(
      harness.calls.redirects[0].message,
      /Storage cleanup may continue/u,
    );
  });

  test('processor exception remains queued behavior and returns success', async () => {
    const harness = makeHarness({ cleanupThrows: true });
    await harness.invoke();

    assert.equal(harness.calls.service.length, 1);
    assert.equal(harness.calls.redirects.length, 1);
    assert.equal(harness.calls.redirects[0].type, 'success');
    assert.ok(harness.calls.logs.some(log =>
      log.details.message ===
        'Post-commit account deletion cleanup processing failed.'
    ));
    assert.doesNotMatch(JSON.stringify(harness.calls.logs), /raw cleanup failure/u);
  });

  test('logout failure cannot restore or report failure for committed deletion', async () => {
    const harness = makeHarness({ logoutFails: true });
    await harness.invoke();

    assert.equal(harness.calls.service.length, 1);
    assert.equal(harness.calls.destroy, 1);
    assert.equal(harness.calls.redirects[0].type, 'success');
    assert.ok(harness.calls.logs.some(log =>
      log.details.message ===
        'Post-commit account deletion logout failed.'
    ));
  });

  test('session-destroy failure cannot restore or report failure for committed deletion', async () => {
    const harness = makeHarness({ destroyFails: true });
    await harness.invoke();

    assert.equal(harness.calls.service.length, 1);
    assert.equal(harness.calls.cleanup.length, 1);
    assert.equal(harness.calls.redirects[0].type, 'success');
    assert.ok(harness.calls.logs.some(log =>
      log.details.message ===
        'Post-commit account deletion session destruction failed.'
    ));
  });

  test('flash failure after commit falls back to one direct redirect without retrying deletion', async () => {
    const harness = makeHarness({ redirectThrowsAfterCommit: true });
    await harness.invoke();

    assert.equal(harness.calls.service.length, 1);
    assert.deepEqual(harness.calls.redirects, ['/']);
    assert.ok(harness.calls.logs.some(log =>
      log.details.message ===
        'Post-commit account deletion response handling failed.'
    ));
  });
});
