import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createAdminDashboardHandler,
  createUserBlockHandler,
} from '../controllers/admin.js';
import {
  createSearchApiHandler,
  createSearchResultsHandler,
} from '../controllers/camp.js';
import { createRedirectedFlash } from '../utils/redirectedFlash.js';

function createLogRecorder() {
  const calls = [];
  return {
    calls,
    async log(...args) {
      calls.push(args);
    },
  };
}

function createRedirectRecorder() {
  const calls = [];
  return {
    calls,
    redirectWithFlash(...args) {
      calls.push(args);
      return { redirected: true };
    },
  };
}

describe('runtime failure paths retain their responses', () => {
  test('admin dashboard still redirects with the same failure message', async () => {
    const failure = new Error('simulated dashboard query failure');
    const logs = createLogRecorder();
    const redirects = createRedirectRecorder();
    const handler = createAdminDashboardHandler({
      UserModel: {},
      UploadModel: {
        find() {
          throw failure;
        },
      },
      log: logs.log,
      redirectWithFlash: redirects.redirectWithFlash,
    });
    const req = {
      query: {},
      headers: { accept: 'text/html' },
      user: { _id: 'administrator-id' },
    };
    const res = {};

    const result = await handler(req, res, () => {});

    assert.deepEqual(result, { redirected: true });
    assert.deepEqual(redirects.calls, [[
      req,
      res,
      'error',
      'Failed to load dashboard.',
      '/',
    ]]);
    assert.equal(logs.calls.length, 1);
    assert.equal(logs.calls[0][0], req);
    assert.equal(logs.calls[0][1], res);
    assert.equal(logs.calls[0][2], 'error');
    assert.equal(logs.calls[0][3].error, failure);
  });

  test('block and unblock failures retain their existing redirects', async t => {
    for (const fixture of [
      {
        blocked: true,
        message: 'Failed to block user.',
      },
      {
        blocked: false,
        message: 'Failed to unblock user.',
      },
    ]) {
      await t.test(fixture.blocked ? 'block' : 'unblock', async () => {
        const failure = new Error('simulated user update failure');
        const logs = createLogRecorder();
        const redirects = createRedirectRecorder();
        const updates = [];
        const handler = createUserBlockHandler({
          blocked: fixture.blocked,
          UserModel: {
            async findByIdAndUpdate(id, update) {
              updates.push({ id, update });
              throw failure;
            },
          },
          log: logs.log,
          redirectWithFlash: redirects.redirectWithFlash,
        });
        const req = { params: { id: 'target-user-id' } };
        const res = {};

        const result = await handler(req, res, () => {});

        assert.deepEqual(result, { redirected: true });
        assert.deepEqual(updates, [{
          id: 'target-user-id',
          update: { blocked: fixture.blocked },
        }]);
        assert.deepEqual(redirects.calls, [[
          req,
          res,
          'error',
          fixture.message,
          '/a/dashboard',
        ]]);
        assert.equal(logs.calls.length, 1);
        assert.equal(logs.calls[0][3].error, failure);
      });
    }
  });

  test('search API failures keep the same status and response body', async () => {
    const failure = new Error('simulated search API failure');
    const logs = createLogRecorder();
    const nextCalls = [];
    const handler = createSearchApiHandler({
      async loadSearchData() {
        throw failure;
      },
      log: logs.log,
    });
    const req = { query: { q: 'park' } };
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };

    await handler(req, res, error => nextCalls.push(error));

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Search failed' });
    assert.deepEqual(nextCalls, []);
    assert.equal(logs.calls.length, 1);
    assert.equal(logs.calls[0][3].error, failure);
  });

  test('search-page failures still reach the generic error handler', async () => {
    const failure = new Error('simulated search page failure');
    const nextCalls = [];
    const handler = createSearchResultsHandler({
      async loadSearchData() {
        throw failure;
      },
    });

    await handler(
      { query: { q: 'park' } },
      {
        redirect() {
          throw new Error('unexpected redirect');
        },
        render() {
          throw new Error('unexpected render');
        },
      },
      error => nextCalls.push(error),
    );

    assert.deepEqual(nextCalls, [failure]);
  });

  test('session-save logging does not change redirect behavior', async () => {
    const failure = new Error('simulated session save failure');
    const logs = createLogRecorder();
    const redirects = [];
    const flashes = [];
    const redirectWithFlash = createRedirectedFlash({ log: logs.log });
    const req = {
      flash(type, message) {
        flashes.push({ type, message });
      },
      session: {
        save(callback) {
          callback(failure);
        },
      },
    };
    const res = {
      headersSent: false,
      redirect(path) {
        redirects.push(path);
        return this;
      },
    };

    await redirectWithFlash(
      req,
      res,
      'error',
      'Existing user-facing failure.',
      '/unchanged-target',
    );

    assert.deepEqual(flashes, [{
      type: 'error',
      message: 'Existing user-facing failure.',
    }]);
    assert.deepEqual(redirects, ['/unchanged-target']);
    assert.equal(logs.calls.length, 1);
    assert.equal(logs.calls[0][3].error, failure);
    assert.equal(
      logs.calls[0][3].message,
      'Session save failed before redirect.',
    );
  });
});
