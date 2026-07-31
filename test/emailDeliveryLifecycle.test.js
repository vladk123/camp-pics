import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createNewUserVerify } from '../utils/createNewUserVerify.js';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const { createEmailSender } = await import('../utils/sendEmail.js');
const {
  createForgotPasswordController,
  createRegisterController,
  createResendVerificationController,
} = await import('../controllers/users.js');

const USER_ID = '64b7f2d4c9f1e8a123456789';
const TOKEN_NOW = new Date('2026-07-31T12:00:00.000Z');
const CLEANUP_NOW = new Date('2026-07-31T12:05:00.000Z');
const DELIVERY_NOW = new Date('2026-07-31T12:01:00.000Z');

function createBoundarySender({ providerError, metadataError }) {
  const providerResult = Object.freeze({ id: '<delivered@example.test>' });
  const providerCalls = [];
  const logCalls = [];
  let metadataConstructions = 0;
  let metadataSaves = 0;

  class EmailModel {
    constructor() {
      metadataConstructions += 1;
    }

    async save() {
      metadataSaves += 1;
      if (metadataError) throw metadataError;
    }
  }

  const sender = createEmailSender({
    renderTemplate: async () => '<p>rendered authentication email</p>',
    mailClient: {
      messages: {
        async create(...args) {
          providerCalls.push(args);
          if (providerError) throw providerError;
          return providerResult;
        },
      },
    },
    EmailModel,
    async log(...args) {
      logCalls.push(args);
    },
    now: () => DELIVERY_NOW,
    domain: 'mail.example.test',
    defaultFrom: 'no-reply@example.test',
  });

  return {
    sender,
    providerResult,
    providerCalls,
    logCalls,
    metadataConstructions: () => metadataConstructions,
    metadataSaves: () => metadataSaves,
  };
}

function createTokenModel({ initialDocuments = [] } = {}) {
  let nextId = 1;

  class TokenModel {
    static documents = initialDocuments.map(document => ({ ...document }));
    static deleteOneCalls = [];
    static deleteManyCalls = [];

    constructor(data) {
      Object.assign(this, data);
      this._id = `token-${nextId}`;
      nextId += 1;
    }

    async save() {
      TokenModel.documents.push(this);
      return this;
    }

    static async deleteOne(filter) {
      TokenModel.deleteOneCalls.push(filter);
      TokenModel.documents = TokenModel.documents.filter(
        document => document._id !== filter._id,
      );
    }

    static async deleteMany(filter) {
      TokenModel.deleteManyCalls.push(filter);
      TokenModel.documents = TokenModel.documents.filter(document => {
        if (document.user_id !== filter.user_id) return true;
        if (!filter._id) return false;
        if (document._id === filter._id.$ne) return true;
        return document.email_verification_expiry >
          filter.email_verification_expiry.$lte;
      });
    }
  }

  return TokenModel;
}

function createRedirectRecorder() {
  const calls = [];
  return {
    calls,
    redirectWithFlash(_req, _res, type, message, path, data) {
      const result = { type, message, path, data };
      calls.push(result);
      return result;
    },
  };
}

const registrationRequest = () => ({
  body: {
    username: 'camper@example.test',
    password: 'CampPics9!',
    password_repeat: 'CampPics9!',
    fname: 'Camper',
    website_user: '',
    hands_check: '5',
  },
});

const response = () => ({
  locals: { ip: '192.0.2.10' },
  redirect() {},
});

test('verification creation keeps the delivered token and continues expired-token cleanup when metadata save fails', async () => {
  const metadataError = Object.freeze(new Error('fixture metadata save failure'));
  const boundary = createBoundarySender({ metadataError });
  const TokenModel = createTokenModel({
    initialDocuments: [{
      _id: 'expired-token',
      user_id: USER_ID,
      email_verification_code: 'expired-digest',
      email_verification_expiry: new Date('2026-07-31T11:00:00.000Z'),
    }],
  });

  const result = await createNewUserVerify({
    userId: USER_ID,
    username: 'camper@example.test',
    TokenModel,
    send: boundary.sender,
    now: TOKEN_NOW,
    cleanupNow: CLEANUP_NOW,
  });

  assert.deepEqual(result, {
    delivered: true,
    expiredTokenCleanupSucceeded: true,
  });
  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(boundary.metadataSaves(), 1);
  assert.equal(boundary.logCalls.length, 1);
  assert.equal(TokenModel.deleteOneCalls.length, 0);
  assert.deepEqual(
    TokenModel.documents.map(document => document._id),
    ['token-1'],
  );
  assert.equal(TokenModel.deleteManyCalls.length, 1);
});

test('verification creation still removes only its new token after a real provider failure', async () => {
  const providerError = Object.freeze(new Error('fixture provider failure'));
  const boundary = createBoundarySender({ providerError });
  const TokenModel = createTokenModel();

  await assert.rejects(
    createNewUserVerify({
      userId: USER_ID,
      username: 'camper@example.test',
      TokenModel,
      send: boundary.sender,
      now: TOKEN_NOW,
      cleanupNow: CLEANUP_NOW,
    }),
    error => error === providerError,
  );

  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(boundary.metadataConstructions(), 0);
  assert.deepEqual(TokenModel.deleteOneCalls, [{ _id: 'token-1' }]);
  assert.deepEqual(TokenModel.documents, []);
});

function createRegistrationHarness(boundary) {
  const state = {
    users: [],
    userDeleteCalls: [],
    controllerLogs: [],
  };
  const TokenModel = createTokenModel();
  const redirects = createRedirectRecorder();

  class UserModel {
    constructor(data) {
      Object.assign(this, data);
    }

    static async register(user) {
      user._id = USER_ID;
      state.users.push(user);
      return user;
    }

    static async findByIdAndDelete(userId) {
      state.userDeleteCalls.push(userId);
      state.users = state.users.filter(user => user._id !== userId);
    }
  }

  const controller = createRegisterController({
    UserModel,
    TokenModel,
    createVerification(options) {
      return createNewUserVerify({
        ...options,
        TokenModel,
        now: TOKEN_NOW,
        cleanupNow: CLEANUP_NOW,
      });
    },
    emailSender: boundary.sender,
    async log(...args) {
      state.controllerLogs.push(args);
    },
    redirectWithFlash: redirects.redirectWithFlash,
  });

  return { controller, redirects, state, TokenModel };
}

test('registration keeps its User and verification token after delivered-email metadata failure', async () => {
  const boundary = createBoundarySender({
    metadataError: Object.freeze(new Error('fixture metadata save failure')),
  });
  const harness = createRegistrationHarness(boundary);

  await harness.controller(registrationRequest(), response(), () => {});

  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(harness.state.users.length, 1);
  assert.equal(harness.TokenModel.documents.length, 1);
  assert.equal(harness.TokenModel.deleteOneCalls.length, 0);
  assert.deepEqual(harness.state.userDeleteCalls, []);
  assert.equal(
    harness.TokenModel.deleteManyCalls.some(call => !call._id),
    false,
  );
  assert.equal(harness.redirects.calls.at(-1).type, 'success');
  assert.equal(harness.redirects.calls.at(-1).path, '/user/registered');
  assert.equal(harness.state.controllerLogs.length, 0);
});

test('registration retains its existing rollback after a real provider failure', async () => {
  const boundary = createBoundarySender({
    providerError: Object.freeze(new Error('fixture provider failure')),
  });
  const harness = createRegistrationHarness(boundary);

  await harness.controller(registrationRequest(), response(), () => {});

  assert.equal(boundary.providerCalls.length, 1);
  assert.deepEqual(harness.state.users, []);
  assert.deepEqual(harness.TokenModel.documents, []);
  assert.deepEqual(harness.state.userDeleteCalls, [USER_ID]);
  assert.equal(
    harness.TokenModel.deleteManyCalls.some(call => !call._id),
    true,
  );
  assert.equal(harness.redirects.calls.at(-1).type, 'error');
});

function createResendHarness(boundary) {
  const state = {
    counter: 0,
    rollbackCalls: 0,
    controllerLogs: [],
  };
  const TokenModel = createTokenModel();
  const redirects = createRedirectRecorder();
  const UserModel = {
    async findById() {
      return null;
    },
  };
  const controller = createResendVerificationController({
    UserModel,
    async reserveResend() {
      state.counter += 1;
      return {
        _id: USER_ID,
        username: 'camper@example.test',
        token_counter: state.counter,
      };
    },
    async rollbackResend() {
      state.rollbackCalls += 1;
      state.counter -= 1;
    },
    createVerification(options) {
      return createNewUserVerify({
        ...options,
        TokenModel,
        now: TOKEN_NOW,
        cleanupNow: CLEANUP_NOW,
      });
    },
    emailSender: boundary.sender,
    async log(...args) {
      state.controllerLogs.push(args);
    },
    redirectWithFlash: redirects.redirectWithFlash,
  });

  return { controller, redirects, state, TokenModel };
}

const resendRequest = () => ({
  user: {
    _id: USER_ID,
    username: 'camper@example.test',
    email_verified: false,
  },
});

test('verification resend keeps its allowance and delivered token after metadata failure', async () => {
  const boundary = createBoundarySender({
    metadataError: Object.freeze(new Error('fixture metadata save failure')),
  });
  const harness = createResendHarness(boundary);

  await harness.controller(resendRequest(), response(), () => {});

  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(harness.state.counter, 1);
  assert.equal(harness.state.rollbackCalls, 0);
  assert.equal(harness.TokenModel.documents.length, 1);
  assert.equal(harness.TokenModel.deleteOneCalls.length, 0);
  assert.equal(harness.redirects.calls.at(-1).type, 'info');
  assert.equal(harness.state.controllerLogs.length, 0);
});

test('verification resend retains allowance rollback after a real provider failure', async () => {
  const boundary = createBoundarySender({
    providerError: Object.freeze(new Error('fixture provider failure')),
  });
  const harness = createResendHarness(boundary);

  await harness.controller(resendRequest(), response(), () => {});

  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(harness.state.counter, 0);
  assert.equal(harness.state.rollbackCalls, 1);
  assert.deepEqual(harness.TokenModel.documents, []);
  assert.equal(harness.redirects.calls.at(-1).type, 'error');
});

function createPasswordResetModel() {
  const state = {
    _id: USER_ID,
    username: 'camper@example.test',
    blocked: false,
    hash: 'existing-hash',
    salt: 'existing-salt',
    other_login: {},
  };
  const calls = {
    finalize: 0,
    rollback: 0,
  };
  const snapshot = () => ({
    ...state,
    other_login: { ...state.other_login },
  });
  const setPath = (path, value) => {
    const [, key] = path.split('.');
    state.other_login[key] = value;
  };
  const unsetPath = path => {
    const [, key] = path.split('.');
    delete state.other_login[key];
  };

  const UserModel = {
    findOne() {
      return {
        async select() {
          return state;
        },
      };
    },

    async findOneAndUpdate(_filter, update) {
      const previous = snapshot();
      for (const [path, value] of Object.entries(update.$set || {})) {
        setPath(path, value);
      }
      return previous;
    },

    async findById() {
      return state;
    },

    async updateOne(filter, update) {
      if (
        state.other_login.reset_password_code !==
          filter['other_login.reset_password_code'] ||
        state.other_login.reset_password_expiry !==
          filter['other_login.reset_password_expiry'] ||
        state.other_login.reset_password_claim !==
          filter['other_login.reset_password_claim']
      ) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      const unsetPaths = Object.keys(update.$unset || {});
      if (
        unsetPaths.length === 1 &&
        unsetPaths[0] === 'other_login.reset_password_claim'
      ) {
        calls.finalize += 1;
      } else {
        calls.rollback += 1;
      }

      for (const [path, value] of Object.entries(update.$set || {})) {
        setPath(path, value);
      }
      for (const path of unsetPaths) {
        unsetPath(path);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  return { UserModel, state, calls };
}

function createPasswordResetHarness(boundary) {
  const reset = createPasswordResetModel();
  const redirects = createRedirectRecorder();
  const controllerLogs = [];
  const controller = createForgotPasswordController({
    UserModel: reset.UserModel,
    emailSender: boundary.sender,
    async log(...args) {
      controllerLogs.push(args);
    },
    redirectWithFlash: redirects.redirectWithFlash,
  });

  return { controller, redirects, controllerLogs, reset };
}

const passwordResetRequest = () => ({
  body: { forgot_username: 'Camper@Example.Test' },
});

test('password reset finalizes delivered state and skips rollback after metadata failure', async () => {
  const boundary = createBoundarySender({
    metadataError: Object.freeze(new Error('fixture metadata save failure')),
  });
  const harness = createPasswordResetHarness(boundary);

  await harness.controller(passwordResetRequest(), response(), () => {});

  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(harness.reset.calls.finalize, 1);
  assert.equal(harness.reset.calls.rollback, 0);
  assert.equal(harness.reset.state.other_login.reset_password_counter, 1);
  assert.equal(
    typeof harness.reset.state.other_login.reset_password_code,
    'string',
  );
  assert.equal(
    'reset_password_claim' in harness.reset.state.other_login,
    false,
  );
  assert.equal(harness.redirects.calls.at(-1).type, 'success');
  assert.deepEqual(harness.redirects.calls.at(-1).data, {
    GA4: { event: 'reset_password_request' },
  });
  assert.equal(harness.controllerLogs.length, 0);
});

test('password reset retains state rollback after a real provider failure', async () => {
  const boundary = createBoundarySender({
    providerError: Object.freeze(new Error('fixture provider failure')),
  });
  const harness = createPasswordResetHarness(boundary);

  await harness.controller(passwordResetRequest(), response(), () => {});

  assert.equal(boundary.providerCalls.length, 1);
  assert.equal(harness.reset.calls.finalize, 0);
  assert.equal(harness.reset.calls.rollback, 1);
  assert.deepEqual(harness.reset.state.other_login, {});
  assert.equal(harness.redirects.calls.at(-1).type, 'success');
  assert.deepEqual(harness.redirects.calls.at(-1).data, {});
  assert.equal(harness.controllerLogs.length, 1);
});
