import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import mongoose from 'mongoose';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const routeAbuseModule = await import('../utils/routeAbuseLimits.js');
const {
  ROUTE_ABUSE_LIMIT_MESSAGE,
  ROUTE_ABUSE_POLICIES,
  accountDeletionLimiter,
  adminUserStatusLimiter,
  authenticatedUserKeyGenerator,
  campsiteApiLimiter,
  contactLimiter,
  createRouteAbuseLimiters,
  fixedRateLimitHandler,
  forgotPasswordLimiter,
  loginLimiter,
  mediaDeletionLimiter,
  parkMediaApiLimiter,
  parkSearchApiLimiter,
  passwordChangeLimiter,
  passwordResetSubmissionLimiter,
  photoUploadLimiter,
  registrationLimiter,
  verificationResendLimiter,
  videoUploadLimiter,
} = routeAbuseModule;
const {
  addVerificationResendRoutes,
  default: userRouter,
} = await import('../routes/users.js');
const { default: otherRouter } = await import('../routes/other.js');
const { default: campRouter } = await import('../routes/camp.js');
const { default: adminRouter } = await import('../routes/admin.js');
const camp = await import('../controllers/camp.js');
const media = await import('../controllers/media.js');
const { createUserBlockHandler } = await import('../controllers/admin.js');
const {
  isAuthenticatedForVerification,
  catchAsyncErrors,
  isAdmin,
  isLoggedIn,
  isLoggedOut,
  usernameToLowerCaseAndTrim,
} = await import('../middleware.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readSource = relativePath =>
  readFile(path.join(root, relativePath), 'utf8');

const existingExpectedPolicies = Object.freeze([
  Object.freeze({
    limiterName: 'loginLimiter',
    policyName: 'login',
    windowMs: 15 * 60 * 1000,
    limit: 20,
  }),
  Object.freeze({
    limiterName: 'registrationLimiter',
    policyName: 'registration',
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
  Object.freeze({
    limiterName: 'forgotPasswordLimiter',
    policyName: 'forgotPassword',
    windowMs: 60 * 60 * 1000,
    limit: 10,
  }),
  Object.freeze({
    limiterName: 'verificationResendLimiter',
    policyName: 'verificationResend',
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
  Object.freeze({
    limiterName: 'contactLimiter',
    policyName: 'contact',
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
]);

const mediaExpectedPolicies = Object.freeze([
  Object.freeze({
    limiterName: 'photoUploadLimiter',
    policyName: 'photoUpload',
    windowMs: 10 * 60 * 1000,
    limit: 5,
    method: 'POST',
    authenticatedUserKeyed: true,
  }),
  Object.freeze({
    limiterName: 'videoUploadLimiter',
    policyName: 'videoUpload',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    method: 'POST',
    authenticatedUserKeyed: true,
  }),
  Object.freeze({
    limiterName: 'mediaDeletionLimiter',
    policyName: 'mediaDeletion',
    windowMs: 60 * 60 * 1000,
    limit: 60,
    method: 'DELETE',
    authenticatedUserKeyed: true,
  }),
]);

const passwordAndAccountExpectedPolicies = Object.freeze([
  Object.freeze({
    limiterName: 'passwordResetSubmissionLimiter',
    policyName: 'passwordResetSubmission',
    windowMs: 60 * 60 * 1000,
    limit: 10,
  }),
  Object.freeze({
    limiterName: 'passwordChangeLimiter',
    policyName: 'passwordChange',
    windowMs: 60 * 60 * 1000,
    limit: 10,
    authenticatedUserKeyed: true,
  }),
  Object.freeze({
    limiterName: 'accountDeletionLimiter',
    policyName: 'accountDeletion',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    authenticatedUserKeyed: true,
  }),
]);

const publicApiExpectedPolicies = Object.freeze([
  Object.freeze({
    limiterName: 'parkSearchApiLimiter',
    policyName: 'parkSearchApi',
    windowMs: 60 * 1000,
    limit: 30,
    method: 'GET',
  }),
  Object.freeze({
    limiterName: 'parkMediaApiLimiter',
    policyName: 'parkMediaApi',
    windowMs: 5 * 60 * 1000,
    limit: 60,
    method: 'GET',
  }),
  Object.freeze({
    limiterName: 'campsiteApiLimiter',
    policyName: 'campsiteApi',
    windowMs: 5 * 60 * 1000,
    limit: 60,
    method: 'GET',
  }),
]);

const existingFourteenExpectedPolicies = Object.freeze([
  ...existingExpectedPolicies,
  ...mediaExpectedPolicies,
  ...passwordAndAccountExpectedPolicies,
  ...publicApiExpectedPolicies,
]);

const adminExpectedPolicies = Object.freeze([
  Object.freeze({
    limiterName: 'adminUserStatusLimiter',
    policyName: 'adminUserStatus',
    windowMs: 15 * 60 * 1000,
    limit: 30,
    authenticatedUserKeyed: true,
  }),
]);

const expectedPolicies = Object.freeze([
  ...existingFourteenExpectedPolicies,
  ...adminExpectedPolicies,
]);

const photoUploadRoutes = Object.freeze([
  '/park/:parkSlug/photo',
  '/park/:parkSlug/campsite/:campsiteSlug/photo',
  '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo',
]);

const videoUploadRoutes = Object.freeze([
  '/park/:parkSlug/video',
  '/park/:parkSlug/campsite/:campsiteSlug/video',
  '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video',
]);

const mediaDeletionRoutes = Object.freeze([
  ['/park/:parkSlug/photo/:photoId', media.deletePhoto],
  ['/park/:parkSlug/video/:videoId', media.deleteVideo],
  ['/park/:parkSlug/campsite/:campsiteSlug/photo/:photoId', media.deletePhoto],
  ['/park/:parkSlug/campsite/:campsiteSlug/video/:videoId', media.deleteVideo],
  [
    '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo/:photoId',
    media.deletePhoto,
  ],
  [
    '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video/:videoId',
    media.deleteVideo,
  ],
]);

const sensitiveFixture = Object.freeze({
  userId: 'abcdefabcdefabcdefabcdef',
  authenticatedUserId: '0123456789abcdef01234567',
  administratorId: '111111111111111111111111',
  targetUserId: '222222222222222222222222',
  resetUserId: 'fedcbafedcbafedcbafedcba',
  resetCode: 'recognizable-reset-code-secret',
  username: 'recognizable-login-user@example.test',
  email: 'recognizable-contact@example.test',
  administratorUsername: 'recognizable-administrator@example.test',
  administratorEmail: 'recognizable-admin-email@example.test',
  password: 'Recognizable-Password-Secret!',
  currentPassword: 'Recognizable-Current-Password-Secret!',
  forgot_username: 'recognizable-reset-user@example.test',
  fname: 'Recognizable Contact Name',
  email_subject: 'Recognizable Contact Subject',
  email_body: 'Recognizable contact body secret',
  parkSlug: 'recognizable-park-slug-secret',
  campgroundSlug: 'recognizable-campground-slug-secret',
  campsiteSlug: 'recognizable-campsite-slug-secret',
  searchQuery: 'recognizable-search-query-secret',
  ip: '198.51.100.244',
  mediaId: 'deadbeefdeadbeefdeadbeef',
  caption: 'Recognizable media caption secret',
  filename: 'recognizable-upload-filename-secret.jpg',
  bodySecret: 'recognizable-body-secret',
  header: 'recognizable-header-secret',
  session: 'recognizable-session-secret',
});

const sensitiveValues = Object.values(sensitiveFixture);

async function withServer(app, callback) {
  const server = await new Promise(resolve => {
    const listeningServer = app.listen(
      0,
      '127.0.0.1',
      () => resolve(listeningServer),
    );
  });
  const address = server.address();

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

const sendMutation = (
  url,
  {
    body = sensitiveFixture,
    forwardedFor,
    headers = {},
    method = 'POST',
    redirect = 'follow',
    userId = sensitiveFixture.userId,
  } = {},
) => {
  const normalizedMethod = method.toUpperCase();
  return fetch(url, {
    method: normalizedMethod,
    redirect,
    headers: {
      'Content-Type': 'application/json',
      'X-CampPics-Test': sensitiveFixture.header,
      'X-Test-User-Id': userId,
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      ...headers,
    },
    ...(!['GET', 'HEAD'].includes(normalizedMethod)
      ? { body: JSON.stringify(body) }
      : {}),
  });
};

const sendPost = (url, body = sensitiveFixture) =>
  sendMutation(url, { body });

function addAuthenticatedUser(req, res, next) {
  req.user = {
    _id: req.get('X-Test-User-Id') || sensitiveFixture.userId,
    username: req.get('X-Test-Username') || sensitiveFixture.username,
    email: req.get('X-Test-Email') || sensitiveFixture.email,
    email_verified: true,
  };
  req.session = {
    fixture: req.get('X-Test-Session') || sensitiveFixture.session,
  };
  next();
}

function addAuthenticatedAdministrator(req, res, next) {
  addAuthenticatedUser(req, res, () => {
    req.user.isAdmin = true;
    next();
  });
}

async function captureConsole(callback) {
  const methods = ['error', 'info', 'log', 'warn'];
  const originals = new Map();
  const captured = [];

  for (const method of methods) {
    originals.set(method, console[method]);
    console[method] = (...values) => captured.push(values);
  }

  try {
    await callback(captured);
  } finally {
    for (const method of methods) console[method] = originals.get(method);
  }
}

function getRoute(router, routePath) {
  const layer = router.stack.find(candidate => candidate.route?.path === routePath);
  assert.ok(layer, `missing route ${routePath}`);
  return layer.route;
}

const methodHandlers = (route, method) => route.stack
  .filter(layer => layer.method === method)
  .map(layer => layer.handle);

describe('route-abuse policy construction', () => {
  test('constructs fifteen exact independent policies with one fixed handler', () => {
    const capturedOptions = [];
    const createdInstances = [];
    const limiters = createRouteAbuseLimiters({
      rateLimitFactory(options) {
        capturedOptions.push(options);
        const instance = { instanceNumber: createdInstances.length + 1 };
        createdInstances.push(instance);
        return instance;
      },
    });

    assert.equal(capturedOptions.length, 15);
    assert.equal(createdInstances.length, 15);
    assert.equal(new Set(createdInstances).size, 15);
    assert.equal(new Set(Object.values(limiters)).size, 15);
    assert.equal(Object.isFrozen(limiters), true);
    assert.deepEqual(
      Object.keys(ROUTE_ABUSE_POLICIES),
      expectedPolicies.map(policy => policy.policyName),
    );
    assert.equal(new Set(capturedOptions.map(options => options.handler)).size, 1);

    for (const [index, expected] of expectedPolicies.entries()) {
      const policy = ROUTE_ABUSE_POLICIES[expected.policyName];
      const options = capturedOptions[index];

      assert.equal(Object.isFrozen(policy), true);
      assert.deepEqual(policy, {
        windowMs: expected.windowMs,
        limit: expected.limit,
      });
      const expectedOptionKeys = [
        'handler',
        'legacyHeaders',
        'limit',
        'skipFailedRequests',
        'skipSuccessfulRequests',
        'standardHeaders',
        'statusCode',
        'windowMs',
      ];
      if (expected.authenticatedUserKeyed) {
        expectedOptionKeys.push('keyGenerator');
      }
      assert.deepEqual(
        Object.keys(options).sort(),
        expectedOptionKeys.sort(),
      );
      assert.equal(options.windowMs, expected.windowMs);
      assert.equal(options.limit, expected.limit);
      assert.equal(options.statusCode, 429);
      assert.equal(options.standardHeaders, 'draft-8');
      assert.equal(options.legacyHeaders, false);
      assert.equal(options.skipSuccessfulRequests, false);
      assert.equal(options.skipFailedRequests, false);
      assert.strictEqual(options.handler, fixedRateLimitHandler);
      if (expected.authenticatedUserKeyed) {
        assert.strictEqual(
          options.keyGenerator,
          authenticatedUserKeyGenerator,
        );
      } else {
        assert.equal(Object.hasOwn(options, 'keyGenerator'), false);
      }
      assert.equal(Object.hasOwn(options, 'store'), false);
      assert.equal(Object.hasOwn(options, 'max'), false);
    }

    assert.deepEqual(
      existingFourteenExpectedPolicies.map(expected => ({
        policyName: expected.policyName,
        ...ROUTE_ABUSE_POLICIES[expected.policyName],
      })),
      existingFourteenExpectedPolicies.map(expected => ({
        policyName: expected.policyName,
        windowMs: expected.windowMs,
        limit: expected.limit,
      })),
    );

    const serializedOptions = JSON.stringify(capturedOptions);
    const exportedLimiterMetadata = JSON.stringify({
      exportNames: Object.keys(routeAbuseModule),
      limiterProperties: Reflect.ownKeys(adminUserStatusLimiter).map(String),
      policy: ROUTE_ABUSE_POLICIES.adminUserStatus,
    });
    for (const value of sensitiveValues) {
      assert.equal(serializedOptions.includes(value), false);
      assert.equal(exportedLimiterMetadata.includes(value), false);
    }
    assert.equal(
      exportedLimiterMetadata.includes('user:invalid-authenticated-id'),
      false,
    );
  });

  test('creates production instances once during cached module initialization', async () => {
    const secondImport = await import('../utils/routeAbuseLimits.js');
    const limiterNames = expectedPolicies.map(policy => policy.limiterName);
    const productionLimiters = limiterNames.map(name => routeAbuseModule[name]);

    assert.equal(new Set(productionLimiters).size, 15);
    for (const limiterName of limiterNames) {
      assert.strictEqual(routeAbuseModule[limiterName], secondImport[limiterName]);
    }
    assert.equal(
      Object.keys(routeAbuseModule).some(name => /store/i.test(name)),
      false,
    );
  });

  test('uses default independent stores and contains no logging or forwarding path', async () => {
    const source = await readSource('utils/routeAbuseLimits.js');
    const keyGeneratorSource = source.slice(
      source.indexOf('export function authenticatedUserKeyGenerator'),
      source.indexOf('export function fixedRateLimitHandler'),
    );
    assert.doesNotMatch(source, /\bstore\s*:/);
    assert.doesNotMatch(
      source,
      /logger|console\.|reportEvent|req\.(?:body|headers|session|ip|path)/,
    );
    assert.doesNotMatch(source, /toObject|JSON\.stringify|JSON\.parse/);
    assert.match(keyGeneratorSource, /const id = req\?\.user\?\._id/);
    assert.doesNotMatch(
      keyGeneratorSource,
      /username|email|session|params|\.ip\b|\.path\b|headers|socket/,
    );

    for (const header of [
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
    ]) {
      assert.equal(source.toLowerCase().includes(header), false);
    }
  });
});

describe('authenticated-user limiter keying', () => {
  const lowercaseId = 'abcdefabcdefabcdefabcdef';
  const uppercaseId = lowercaseId.toUpperCase();
  const expectedKey = `user:${lowercaseId}`;
  const invalidKey = 'user:invalid-authenticated-id';

  test('normalizes Mongoose, ObjectId-like, lowercase, and uppercase IDs', () => {
    const objectId = new mongoose.Types.ObjectId(lowercaseId);
    const objectIdLike = {
      toHexString() {
        return uppercaseId;
      },
    };

    for (const id of [objectId, objectIdLike, lowercaseId, uppercaseId]) {
      assert.equal(
        authenticatedUserKeyGenerator({ user: { _id: id } }),
        expectedKey,
      );
    }
    assert.equal(
      authenticatedUserKeyGenerator({ user: { _id: objectId } }),
      authenticatedUserKeyGenerator({ user: { _id: lowercaseId } }),
    );
  });

  test('every missing or malformed ID uses one fixed fail-closed key', () => {
    const malformedRequests = [
      { user: { _id: 'not-an-object-id' } },
      { user: { _id: 'abcdefabcdefabcdefabcde' } },
      { user: { _id: null } },
      { user: {} },
      {},
      null,
      { user: { _id: { toHexString: 'not-callable' } } },
      {
        user: {
          _id: {
            toHexString() {
              throw new Error('recognizable-key-error-secret');
            },
          },
        },
      },
      {
        user: Object.defineProperty({}, '_id', {
          get() {
            throw new Error('recognizable-id-getter-secret');
          },
        }),
      },
    ];

    for (const req of malformedRequests) {
      assert.doesNotThrow(() => authenticatedUserKeyGenerator(req));
      assert.equal(authenticatedUserKeyGenerator(req), invalidKey);
    }
  });

  test('ignores unrelated identity, network, and session data without serialization or mutation', () => {
    let serializationCalls = 0;
    const id = {
      unrelatedSecret: 'recognizable-unrelated-id-secret',
      toHexString() {
        return uppercaseId;
      },
      toJSON() {
        serializationCalls += 1;
        throw new Error('must not serialize ID');
      },
    };
    const user = {
      _id: id,
      username: sensitiveFixture.username,
      email: sensitiveFixture.email,
      toObject() {
        serializationCalls += 1;
        throw new Error('must not serialize User');
      },
      toJSON() {
        serializationCalls += 1;
        throw new Error('must not serialize User');
      },
    };
    const req = {
      user,
      ip: '198.51.100.42',
      params: { id: sensitiveFixture.targetUserId },
      path: `/${sensitiveFixture.parkSlug}`,
      session: { id: sensitiveFixture.session },
    };
    const originalId = user._id;
    const originalUsername = user.username;
    const originalEmail = user.email;

    assert.equal(authenticatedUserKeyGenerator(req), expectedKey);
    req.ip = '203.0.113.77';
    req.params = { id: 'different-target-user-id-secret' };
    req.path = `/${sensitiveFixture.campsiteSlug}`;
    req.session = { id: 'different-session-secret' };
    user.username = 'different-username-secret';
    user.email = 'different-email-secret';
    assert.equal(authenticatedUserKeyGenerator(req), expectedKey);
    assert.equal(serializationCalls, 0);
    assert.strictEqual(user._id, originalId);
    assert.equal(id.toHexString(), uppercaseId);

    user.username = originalUsername;
    user.email = originalEmail;
    assert.equal(user.username, sensitiveFixture.username);
    assert.equal(user.email, sensitiveFixture.email);

    const frozenInput = Object.freeze({
      user: Object.freeze({
        _id: uppercaseId,
        username: sensitiveFixture.username,
        email: sensitiveFixture.email,
      }),
      session: Object.freeze({ id: sensitiveFixture.session }),
      ip: '192.0.2.40',
    });
    assert.doesNotThrow(() => authenticatedUserKeyGenerator(frozenInput));
    assert.equal(authenticatedUserKeyGenerator(frozenInput), expectedKey);
    assert.equal(frozenInput.user._id, uppercaseId);
  });
});

describe('real route-abuse limiter behavior', () => {
  for (const expected of expectedPolicies) {
    test(`${expected.policyName} allows ${expected.limit} attempts and blocks the next`, async () => {
      const limiterSet = createRouteAbuseLimiters();
      let controllerCalls = 0;
      const app = express();
      app.use(express.json());
      app.use(addAuthenticatedUser);
      app[expected.method?.toLowerCase() || 'post'](
        '/attempt',
        limiterSet[expected.limiterName],
        (req, res) => {
        controllerCalls += 1;
        if (controllerCalls % 2 === 0) {
          return res.status(400).send('Invalid attempt.');
        }
        return res.status(204).end();
        },
      );

      await captureConsole(async captured => {
        await withServer(app, async baseUrl => {
          for (let attempt = 1; attempt <= expected.limit; attempt += 1) {
            const response = await sendMutation(`${baseUrl}/attempt`, {
              method: expected.method || 'POST',
            });
            assert.equal(response.status, attempt % 2 === 0 ? 400 : 204);
          }

          const blocked = await sendMutation(`${baseUrl}/attempt`, {
            method: expected.method || 'POST',
          });
          const body = await blocked.text();

          assert.equal(blocked.status, 429);
          assert.equal(controllerCalls, expected.limit);
          assert.equal(body, ROUTE_ABUSE_LIMIT_MESSAGE);
          assert.match(blocked.headers.get('content-type'), /^text\/plain\b/);
          assert.equal(blocked.headers.get('cache-control'), 'no-store');
          assert.ok(blocked.headers.get('ratelimit'));
          assert.equal(blocked.headers.get('x-ratelimit-limit'), null);
          const publicMetadata = JSON.stringify([...blocked.headers]);
          for (const value of sensitiveValues) {
            assert.equal(body.includes(value), false);
            assert.equal(publicMetadata.includes(value), false);
          }
        });

        assert.deepEqual(captured, []);
        const capturedOutput = JSON.stringify(captured);
        for (const value of sensitiveValues) {
          assert.equal(capturedOutput.includes(value), false);
        }
      });
    });
  }

  test('both password-reset POST variants share one default-IP counter', async () => {
    const limiters = createRouteAbuseLimiters();
    let controllerCalls = 0;
    const app = express();
    app.set('trust proxy', 1);
    const controller = (req, res) => {
      controllerCalls += 1;
      res.status(204).end();
    };
    app.post(
      '/forgot-password/:userId/:code',
      limiters.passwordResetSubmissionLimiter,
      controller,
    );
    app.post(
      '/forgot-password/:userId',
      limiters.passwordResetSubmissionLimiter,
      controller,
    );

    await withServer(app, async baseUrl => {
      const withCode = `${baseUrl}/forgot-password/${sensitiveFixture.resetUserId}/${sensitiveFixture.resetCode}`;
      const withoutCode = `${baseUrl}/forgot-password/${sensitiveFixture.resetUserId}`;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal((await sendMutation(withCode, {
          forwardedFor: '198.51.100.91',
        })).status, 204);
      }
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assert.equal((await sendMutation(withoutCode, {
          forwardedFor: '198.51.100.91',
        })).status, 204);
      }
      assert.equal((await sendMutation(withCode, {
        forwardedFor: '198.51.100.91',
      })).status, 429);
    });

    assert.equal(controllerCalls, 10);
  });

  test('password-reset submission counters are independent by default-attributed IP', async () => {
    const limiters = createRouteAbuseLimiters();
    const app = express();
    app.set('trust proxy', 1);
    app.post(
      '/forgot-password/:userId/:code',
      limiters.passwordResetSubmissionLimiter,
      (req, res) => res.status(204).end(),
    );

    await withServer(app, async baseUrl => {
      const url = `${baseUrl}/forgot-password/${sensitiveFixture.resetUserId}/${sensitiveFixture.resetCode}`;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await sendMutation(url, {
          forwardedFor: '198.51.100.92',
        })).status, 204);
      }
      assert.equal((await sendMutation(url, {
        forwardedFor: '198.51.100.92',
      })).status, 429);
      assert.equal((await sendMutation(url, {
        forwardedFor: '203.0.113.93',
      })).status, 204);
    });
  });

  test('both campsite API variants share one default-IP counter while another IP has full capacity', async () => {
    const limiters = createRouteAbuseLimiters();
    let controllerCalls = 0;
    const app = express();
    app.set('trust proxy', 1);
    const controller = (req, res) => {
      controllerCalls += 1;
      res.status(204).end();
    };
    app.get(
      '/camp/park/:parkSlug/campsite/:campsiteSlug',
      limiters.campsiteApiLimiter,
      controller,
    );
    app.get(
      '/camp/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug',
      limiters.campsiteApiLimiter,
      controller,
    );

    const standalonePath =
      `/camp/park/${sensitiveFixture.parkSlug}` +
      `/campsite/${sensitiveFixture.campsiteSlug}`;
    const campgroundPath =
      `/camp/park/${sensitiveFixture.parkSlug}` +
      `/campground/${sensitiveFixture.campgroundSlug}` +
      `/campsite/${sensitiveFixture.campsiteSlug}`;

    await captureConsole(async captured => {
      await withServer(app, async baseUrl => {
        for (const [forwardedFor, standaloneAttempts] of [
          [sensitiveFixture.ip, 20],
          ['203.0.113.245', 25],
        ]) {
          for (let attempt = 0; attempt < standaloneAttempts; attempt += 1) {
            assert.equal((await sendMutation(
              `${baseUrl}${standalonePath}`,
              { forwardedFor, method: 'GET' },
            )).status, 204);
          }
          for (
            let attempt = standaloneAttempts;
            attempt < ROUTE_ABUSE_POLICIES.campsiteApi.limit;
            attempt += 1
          ) {
            assert.equal((await sendMutation(
              `${baseUrl}${campgroundPath}`,
              { forwardedFor, method: 'GET' },
            )).status, 204);
          }

          const blocked = await sendMutation(
            `${baseUrl}${campgroundPath}`,
            { forwardedFor, method: 'GET' },
          );
          const body = await blocked.text();
          assert.equal(blocked.status, 429);
          assert.equal(body, ROUTE_ABUSE_LIMIT_MESSAGE);
          for (const value of sensitiveValues) {
            assert.equal(body.includes(value), false);
            assert.equal(
              JSON.stringify([...blocked.headers]).includes(value),
              false,
            );
          }
        }
      });

      assert.deepEqual(captured, []);
    });

    assert.equal(controllerCalls, 120);
  });

  test('public API operations and all existing route counters are independent for one IP', async () => {
    const limiters = createRouteAbuseLimiters();
    const calls = Object.fromEntries(
      expectedPolicies.map(({ policyName }) => [policyName, 0]),
    );
    const app = express();
    app.set('trust proxy', 1);
    app.use(addAuthenticatedUser);
    const addRoute = expected => {
      const method = expected.method?.toLowerCase() || 'post';
      app[method](
        `/operation/${expected.policyName}`,
        limiters[expected.limiterName],
        (req, res) => {
          calls[expected.policyName] += 1;
          res.status(204).end();
        },
      );
    };
    for (const expected of expectedPolicies) addRoute(expected);

    const requestOperation = (baseUrl, policyName, method = 'GET') =>
      sendMutation(`${baseUrl}/operation/${policyName}`, {
        forwardedFor: sensitiveFixture.ip,
        method,
      });

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal(
          (await requestOperation(baseUrl, 'parkSearchApi')).status,
          204,
        );
      }
      assert.equal(
        (await requestOperation(baseUrl, 'parkSearchApi')).status,
        429,
      );
      assert.equal(
        (await requestOperation(baseUrl, 'parkMediaApi')).status,
        204,
      );
      assert.equal(
        (await requestOperation(baseUrl, 'campsiteApi')).status,
        204,
      );

      for (const expected of expectedPolicies.filter(policy =>
        !publicApiExpectedPolicies.includes(policy)
      )) {
        assert.equal((await requestOperation(
          baseUrl,
          expected.policyName,
          expected.method || 'POST',
        )).status, 204, expected.policyName);
      }

      for (let attempt = 1; attempt < 60; attempt += 1) {
        assert.equal(
          (await requestOperation(baseUrl, 'campsiteApi')).status,
          204,
        );
      }
      assert.equal(
        (await requestOperation(baseUrl, 'campsiteApi')).status,
        429,
      );
      assert.equal(
        (await requestOperation(baseUrl, 'parkMediaApi')).status,
        204,
      );
    });

    assert.equal(calls.parkSearchApi, 30);
    assert.equal(calls.campsiteApi, 60);
    assert.equal(calls.parkMediaApi, 2);
    for (const expected of expectedPolicies.filter(policy =>
      !publicApiExpectedPolicies.includes(policy)
    )) {
      assert.equal(calls[expected.policyName], 1, expected.policyName);
    }
  });

  for (const expected of publicApiExpectedPolicies) {
    test(`fresh limiter sets do not share ${expected.policyName} state`, async () => {
      const createApp = limiterSet => {
        const app = express();
        app.set('trust proxy', 1);
        app.get('/public-api', limiterSet[expected.limiterName], (req, res) => {
          res.status(204).end();
        });
        return app;
      };
      const send = baseUrl => sendMutation(`${baseUrl}/public-api`, {
        forwardedFor: sensitiveFixture.ip,
        method: 'GET',
      });

      await withServer(createApp(createRouteAbuseLimiters()), async baseUrl => {
        for (let attempt = 0; attempt < expected.limit; attempt += 1) {
          assert.equal((await send(baseUrl)).status, 204);
        }
        assert.equal((await send(baseUrl)).status, 429);
      });

      await withServer(createApp(createRouteAbuseLimiters()), async baseUrl => {
        assert.equal((await send(baseUrl)).status, 204);
      });
    });
  }

  test('reset submissions and forgot-password email requests have separate counters', async () => {
    const limiters = createRouteAbuseLimiters();
    const calls = { emailRequest: 0, resetSubmission: 0 };
    const app = express();
    app.post(
      '/forgot-password/:userId/:code',
      limiters.passwordResetSubmissionLimiter,
      (req, res) => {
        calls.resetSubmission += 1;
        res.status(204).end();
      },
    );
    app.post('/forgot-password', limiters.forgotPasswordLimiter, (req, res) => {
      calls.emailRequest += 1;
      res.status(204).end();
    });

    await withServer(app, async baseUrl => {
      const resetUrl = `${baseUrl}/forgot-password/${sensitiveFixture.resetUserId}/${sensitiveFixture.resetCode}`;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await sendMutation(resetUrl)).status, 204);
      }
      assert.equal((await sendMutation(resetUrl)).status, 429);
      assert.equal(
        (await sendMutation(`${baseUrl}/forgot-password`)).status,
        204,
      );
    });

    assert.deepEqual(calls, { emailRequest: 1, resetSubmission: 10 });
  });

  for (const expected of passwordAndAccountExpectedPolicies.filter(
    policy => policy.authenticatedUserKeyed,
  )) {
    test(`${expected.policyName} follows one User across IP, username, email, and session changes`, async () => {
      const limiters = createRouteAbuseLimiters();
      const app = express();
      app.set('trust proxy', 1);
      app.use(addAuthenticatedUser);
      app.post('/mutation', limiters[expected.limiterName], (req, res) => {
        res.status(204).end();
      });

      await withServer(app, async baseUrl => {
        for (let attempt = 0; attempt < expected.limit; attempt += 1) {
          const response = await sendMutation(`${baseUrl}/mutation`, {
            forwardedFor: attempt % 2 === 0
              ? '198.51.100.101'
              : '203.0.113.102',
            headers: {
              'X-Test-Username': `changed-${attempt}@example.test`,
              'X-Test-Email': `email-${attempt}@example.test`,
              'X-Test-Session': `changed-session-${attempt}`,
            },
            userId: sensitiveFixture.authenticatedUserId,
          });
          assert.equal(response.status, 204);
        }
        assert.equal((await sendMutation(`${baseUrl}/mutation`, {
          forwardedFor: '192.0.2.103',
          headers: {
            'X-Test-Username': 'final-name@example.test',
            'X-Test-Email': 'final-email@example.test',
            'X-Test-Session': 'final-session-value',
          },
          userId: sensitiveFixture.authenticatedUserId,
        })).status, 429);
      });
    });

    test(`${expected.policyName} keeps different Users independent on one IP`, async () => {
      const limiters = createRouteAbuseLimiters();
      const app = express();
      const firstUserId = '111111111111111111111111';
      const secondUserId = '222222222222222222222222';
      app.set('trust proxy', 1);
      app.use(addAuthenticatedUser);
      app.post('/mutation', limiters[expected.limiterName], (req, res) => {
        res.status(204).end();
      });

      await withServer(app, async baseUrl => {
        for (let attempt = 0; attempt < expected.limit; attempt += 1) {
          assert.equal((await sendMutation(`${baseUrl}/mutation`, {
            forwardedFor: '198.51.100.104',
            userId: firstUserId,
          })).status, 204);
        }
        assert.equal((await sendMutation(`${baseUrl}/mutation`, {
          forwardedFor: '198.51.100.104',
          userId: firstUserId,
        })).status, 429);
        assert.equal((await sendMutation(`${baseUrl}/mutation`, {
          forwardedFor: '198.51.100.104',
          userId: secondUserId,
        })).status, 204);
      });
    });

    test(`${expected.policyName} gives all malformed authenticated IDs the fail-closed key`, async () => {
      const limiters = createRouteAbuseLimiters();
      const app = express();
      app.use(addAuthenticatedUser);
      app.post('/mutation', limiters[expected.limiterName], (req, res) => {
        res.status(204).end();
      });

      await withServer(app, async baseUrl => {
        for (let attempt = 0; attempt < expected.limit; attempt += 1) {
          assert.equal((await sendMutation(`${baseUrl}/mutation`, {
            userId: `malformed-authenticated-id-${attempt}`,
          })).status, 204);
        }
        assert.equal((await sendMutation(`${baseUrl}/mutation`, {
          userId: 'another-malformed-authenticated-id',
        })).status, 429);
        assert.equal((await sendMutation(`${baseUrl}/mutation`, {
          userId: sensitiveFixture.authenticatedUserId,
        })).status, 204);
      });
    });
  }

  test('administrator Block and Unblock share one User counter across simulated IPs', async () => {
    const limiters = createRouteAbuseLimiters();
    const calls = { block: 0, unblock: 0 };
    const app = express();
    app.set('trust proxy', 1);
    app.use(addAuthenticatedAdministrator);
    app.post(
      '/a/user/:id/block',
      isAdmin,
      limiters.adminUserStatusLimiter,
      (req, res) => {
        calls.block += 1;
        res.status(204).end();
      },
    );
    app.post(
      '/a/user/:id/unblock',
      isAdmin,
      limiters.adminUserStatusLimiter,
      (req, res) => {
        calls.unblock += 1;
        res.status(204).end();
      },
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/a/user/${sensitiveFixture.targetUserId}/block`,
          {
            forwardedFor: attempt % 2 === 0
              ? '198.51.100.120'
              : '203.0.113.121',
            userId: sensitiveFixture.administratorId,
          },
        )).status, 204);
      }
      for (let attempt = 0; attempt < 18; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/a/user/${sensitiveFixture.targetUserId}/unblock`,
          {
            forwardedFor: attempt % 2 === 0
              ? '192.0.2.122'
              : '198.51.100.123',
            userId: sensitiveFixture.administratorId,
          },
        )).status, 204);
      }

      assert.equal((await sendMutation(
        `${baseUrl}/a/user/${sensitiveFixture.targetUserId}/block`,
        {
          forwardedFor: '203.0.113.124',
          userId: sensitiveFixture.administratorId,
        },
      )).status, 429);
    });

    assert.deepEqual(calls, { block: 12, unblock: 18 });
  });

  test('administrator counters separate Users on one IP and fail closed for malformed IDs', async () => {
    const limiters = createRouteAbuseLimiters();
    const firstAdministrator = '333333333333333333333333';
    const secondAdministrator = '444444444444444444444444';
    const sharedIp = '198.51.100.125';
    const app = express();
    app.set('trust proxy', 1);
    app.use(addAuthenticatedAdministrator);
    app.post(
      '/a/user/:id/block',
      isAdmin,
      limiters.adminUserStatusLimiter,
      (req, res) => res.status(204).end(),
    );
    app.post(
      '/a/user/:id/unblock',
      isAdmin,
      limiters.adminUserStatusLimiter,
      (req, res) => res.status(204).end(),
    );

    const sendStatusMutation = (baseUrl, action, userId) => sendMutation(
      `${baseUrl}/a/user/${sensitiveFixture.targetUserId}/${action}`,
      { forwardedFor: sharedIp, userId },
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal(
          (await sendStatusMutation(baseUrl, 'block', firstAdministrator)).status,
          204,
        );
        assert.equal(
          (await sendStatusMutation(baseUrl, 'unblock', secondAdministrator)).status,
          204,
        );
      }
      assert.equal(
        (await sendStatusMutation(baseUrl, 'unblock', firstAdministrator)).status,
        429,
      );
      assert.equal(
        (await sendStatusMutation(baseUrl, 'block', secondAdministrator)).status,
        429,
      );

      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal((await sendStatusMutation(
          baseUrl,
          attempt % 2 === 0 ? 'block' : 'unblock',
          `malformed-administrator-${attempt}`,
        )).status, 204);
      }
      assert.equal((await sendStatusMutation(
        baseUrl,
        'block',
        'another-malformed-administrator',
      )).status, 429);
      assert.equal((await sendStatusMutation(
        baseUrl,
        'unblock',
        sensitiveFixture.administratorId,
      )).status, 204);
    });
  });

  test('exhausting administrator status mutations leaves every existing operation and a fresh limiter set available', async () => {
    const firstSet = createRouteAbuseLimiters();
    const calls = Object.fromEntries(
      expectedPolicies.map(({ policyName }) => [policyName, 0]),
    );
    const firstApp = express();
    firstApp.set('trust proxy', 1);
    firstApp.use(addAuthenticatedAdministrator);
    firstApp.post(
      '/operation/adminUserStatus',
      isAdmin,
      firstSet.adminUserStatusLimiter,
      (req, res) => {
        calls.adminUserStatus += 1;
        res.status(204).end();
      },
    );
    for (const expected of existingFourteenExpectedPolicies) {
      const method = expected.method?.toLowerCase() || 'post';
      firstApp[method](
        `/operation/${expected.policyName}`,
        firstSet[expected.limiterName],
        (req, res) => {
          calls[expected.policyName] += 1;
          res.status(204).end();
        },
      );
    }

    await withServer(firstApp, async baseUrl => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/operation/adminUserStatus`,
          {
            forwardedFor: sensitiveFixture.ip,
            userId: sensitiveFixture.administratorId,
          },
        )).status, 204);
      }
      assert.equal((await sendMutation(
        `${baseUrl}/operation/adminUserStatus`,
        {
          forwardedFor: sensitiveFixture.ip,
          userId: sensitiveFixture.administratorId,
        },
      )).status, 429);

      for (const expected of existingFourteenExpectedPolicies) {
        assert.equal((await sendMutation(
          `${baseUrl}/operation/${expected.policyName}`,
          {
            forwardedFor: sensitiveFixture.ip,
            method: expected.method || 'POST',
            userId: sensitiveFixture.administratorId,
          },
        )).status, 204, expected.policyName);
      }
    });

    assert.equal(calls.adminUserStatus, 30);
    for (const expected of existingFourteenExpectedPolicies) {
      assert.equal(calls[expected.policyName], 1, expected.policyName);
    }

    const secondSet = createRouteAbuseLimiters();
    const secondApp = express();
    secondApp.use(addAuthenticatedAdministrator);
    secondApp.post(
      '/operation/adminUserStatus',
      isAdmin,
      secondSet.adminUserStatusLimiter,
      (req, res) => res.status(204).end(),
    );
    await withServer(secondApp, async baseUrl => {
      assert.equal((await sendMutation(
        `${baseUrl}/operation/adminUserStatus`,
        { userId: sensitiveFixture.administratorId },
      )).status, 204);
    });
  });

  test('isAdmin rejects anonymous and non-administrator requests before counter consumption', async () => {
    const limiters = createRouteAbuseLimiters();
    let controllerCalls = 0;
    let limiterCalls = 0;
    const app = express();
    app.use((req, res, next) => {
      const role = req.get('X-Test-Role');
      if (role !== 'anonymous') {
        req.user = {
          _id: req.get('X-Test-User-Id'),
          isAdmin: role === 'administrator',
        };
      }
      next();
    });
    app.post(
      '/a/user/:id/block',
      isAdmin,
      (req, res, next) => {
        limiterCalls += 1;
        limiters.adminUserStatusLimiter(req, res, next);
      },
      (req, res) => {
        controllerCalls += 1;
        res.status(204).end();
      },
    );

    const urlPath = `/a/user/${sensitiveFixture.targetUserId}/block`;
    await withServer(app, async baseUrl => {
      for (const role of ['anonymous', 'non-administrator']) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await sendMutation(`${baseUrl}${urlPath}`, {
            headers: { 'X-Test-Role': role },
            redirect: 'manual',
            userId: sensitiveFixture.administratorId,
          });
          assert.equal(response.status, 302);
          assert.equal(response.headers.get('location'), '/');
        }
      }
      assert.equal(limiterCalls, 0);
      assert.equal(controllerCalls, 0);

      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal((await sendMutation(`${baseUrl}${urlPath}`, {
          headers: { 'X-Test-Role': 'administrator' },
          userId: sensitiveFixture.administratorId,
        })).status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}${urlPath}`, {
        headers: { 'X-Test-Role': 'administrator' },
        userId: sensitiveFixture.administratorId,
      })).status, 429);
    });

    assert.equal(limiterCalls, 31);
    assert.equal(controllerCalls, 30);
  });

  test('administrator request 31 stops before controller validation, persistence, redirects, and logging', async () => {
    const limiters = createRouteAbuseLimiters();
    const nonexistentTarget = '555555555555555555555555';
    const successfulTarget = '666666666666666666666666';
    const failingTarget = '777777777777777777777777';
    const updateCalls = [];
    const redirectCalls = [];
    const logCalls = [];
    let controllerCalls = 0;
    const controller = createUserBlockHandler({
      blocked: true,
      UserModel: {
        async findOneAndUpdate(filter, update, options) {
          const targetId = filter._id.toHexString();
          updateCalls.push({ options, targetId, update });
          if (targetId === failingTarget) {
            throw new Error('recognizable-database-failure-secret');
          }
          return targetId === nonexistentTarget
            ? null
            : { _id: filter._id, blocked: true };
        },
      },
      async log(req, res, type, details) {
        logCalls.push({ details, type });
      },
      redirectWithFlash(req, res, type, message, location) {
        redirectCalls.push({ location, message, type });
        return res.status(204).end();
      },
    });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(addAuthenticatedAdministrator);
    app.post(
      '/a/user/:id/block',
      isAdmin,
      limiters.adminUserStatusLimiter,
      catchAsyncErrors(async (req, res, next) => {
        controllerCalls += 1;
        return controller(req, res, next);
      }),
    );

    const targetSequence = [
      'recognizable-malformed-target-secret',
      sensitiveFixture.administratorId,
      nonexistentTarget,
      successfulTarget,
      failingTarget,
    ];

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const targetId = targetSequence[attempt % targetSequence.length];
        assert.equal((await sendMutation(
          `${baseUrl}/a/user/${targetId}/block`,
          { userId: sensitiveFixture.administratorId },
        )).status, 204);
      }

      assert.equal(controllerCalls, 30);
      assert.equal(updateCalls.length, 18);
      assert.equal(redirectCalls.length, 30);
      assert.equal(logCalls.length, 6);
      assert.ok(logCalls.every(call =>
        call.type === 'error' &&
        call.details.message === 'Admin user block operation failed.' &&
        Object.hasOwn(call.details, 'error') === false
      ));

      await captureConsole(async captured => {
        const blocked = await sendMutation(
          `${baseUrl}/a/user/${sensitiveFixture.targetUserId}/block`,
          {
            body: sensitiveFixture,
            forwardedFor: sensitiveFixture.ip,
            headers: {
              'X-Test-Email': sensitiveFixture.administratorEmail,
              'X-Test-Session': sensitiveFixture.session,
              'X-Test-Username': sensitiveFixture.administratorUsername,
            },
            userId: sensitiveFixture.administratorId,
          },
        );
        const body = await blocked.text();
        const publicMetadata = JSON.stringify([...blocked.headers]);

        assert.equal(blocked.status, 429);
        assert.equal(body, ROUTE_ABUSE_LIMIT_MESSAGE);
        assert.match(blocked.headers.get('content-type'), /^text\/plain\b/);
        assert.equal(blocked.headers.get('cache-control'), 'no-store');
        assert.equal(controllerCalls, 30);
        assert.equal(updateCalls.length, 18);
        assert.equal(redirectCalls.length, 30);
        assert.equal(logCalls.length, 6);
        assert.deepEqual(captured, []);
        for (const value of sensitiveValues) {
          assert.equal(body.includes(value), false);
          assert.equal(publicMetadata.includes(value), false);
        }
      });
    });
  });

  test('password change, account deletion, and media counters are operation-independent', async () => {
    const firstSet = createRouteAbuseLimiters();
    const firstApp = express();
    firstApp.use(addAuthenticatedUser);
    firstApp.post('/change', firstSet.passwordChangeLimiter, (req, res) => {
      res.status(204).end();
    });
    firstApp.post('/delete', firstSet.accountDeletionLimiter, (req, res) => {
      res.status(204).end();
    });
    firstApp.post('/photo', firstSet.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });
    firstApp.post('/video', firstSet.videoUploadLimiter, (req, res) => {
      res.status(204).end();
    });
    firstApp.delete('/media', firstSet.mediaDeletionLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(firstApp, async baseUrl => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await sendMutation(`${baseUrl}/change`)).status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}/change`)).status, 429);
      assert.equal((await sendMutation(`${baseUrl}/delete`)).status, 204);
      assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 204);
      assert.equal((await sendMutation(`${baseUrl}/video`)).status, 204);
      assert.equal((await sendMutation(`${baseUrl}/media`, {
        method: 'DELETE',
      })).status, 204);
    });

    const secondSet = createRouteAbuseLimiters();
    const secondApp = express();
    secondApp.use(addAuthenticatedUser);
    secondApp.post('/delete', secondSet.accountDeletionLimiter, (req, res) => {
      res.status(204).end();
    });
    secondApp.post('/change', secondSet.passwordChangeLimiter, (req, res) => {
      res.status(204).end();
    });
    secondApp.post('/photo', secondSet.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(secondApp, async baseUrl => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await sendMutation(`${baseUrl}/delete`)).status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}/delete`)).status, 429);
      assert.equal((await sendMutation(`${baseUrl}/change`)).status, 204);
      assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 204);
    });
  });

  for (const expected of passwordAndAccountExpectedPolicies) {
    test(`fresh limiter sets do not share ${expected.policyName} state`, async () => {
      const firstSet = createRouteAbuseLimiters();
      const firstApp = express();
      firstApp.use(addAuthenticatedUser);
      firstApp.post('/mutation', firstSet[expected.limiterName], (req, res) => {
        res.status(204).end();
      });

      await withServer(firstApp, async baseUrl => {
        for (let attempt = 0; attempt < expected.limit; attempt += 1) {
          assert.equal((await sendMutation(`${baseUrl}/mutation`)).status, 204);
        }
        assert.equal((await sendMutation(`${baseUrl}/mutation`)).status, 429);
      });

      const secondSet = createRouteAbuseLimiters();
      const secondApp = express();
      secondApp.use(addAuthenticatedUser);
      secondApp.post('/mutation', secondSet[expected.limiterName], (req, res) => {
        res.status(204).end();
      });

      await withServer(secondApp, async baseUrl => {
        assert.equal((await sendMutation(`${baseUrl}/mutation`)).status, 204);
      });
    });
  }

  test('exhausting login leaves contact and registration available for the same client', async () => {
    const limiters = createRouteAbuseLimiters();
    const calls = { contact: 0, login: 0, registration: 0 };
    const app = express();
    app.post('/login', limiters.loginLimiter, (req, res) => {
      calls.login += 1;
      res.status(204).end();
    });
    app.post('/contact', limiters.contactLimiter, (req, res) => {
      calls.contact += 1;
      res.status(204).end();
    });
    app.post('/register', limiters.registrationLimiter, (req, res) => {
      calls.registration += 1;
      res.status(204).end();
    });

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < ROUTE_ABUSE_POLICIES.login.limit; attempt += 1) {
        assert.equal((await sendPost(`${baseUrl}/login`, {})).status, 204);
      }
      assert.equal((await sendPost(`${baseUrl}/login`, {})).status, 429);
      assert.equal((await sendPost(`${baseUrl}/contact`, {})).status, 204);
      assert.equal((await sendPost(`${baseUrl}/register`, {})).status, 204);
    });

    assert.deepEqual(calls, { contact: 1, login: 20, registration: 1 });
  });

  test('one authenticated User shares a photo counter across routes and simulated IPs', async () => {
    const limiters = createRouteAbuseLimiters();
    const app = express();
    const observedIps = [];
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(addAuthenticatedUser);
    for (const route of ['/park-photo', '/campsite-photo', '/nested-photo']) {
      app.post(route, limiters.photoUploadLimiter, (req, res) => {
        observedIps.push(req.ip);
        res.status(204).end();
      });
    }

    await withServer(app, async baseUrl => {
      const attempts = [
        ['/park-photo', '198.51.100.11'],
        ['/campsite-photo', '203.0.113.12'],
        ['/nested-photo', '198.51.100.11'],
        ['/park-photo', '203.0.113.12'],
        ['/campsite-photo', '198.51.100.11'],
      ];
      for (const [route, forwardedFor] of attempts) {
        const response = await sendMutation(`${baseUrl}${route}`, {
          forwardedFor,
        });
        assert.equal(response.status, 204);
      }
      const blocked = await sendMutation(`${baseUrl}/nested-photo`, {
        forwardedFor: '192.0.2.13',
      });
      assert.equal(blocked.status, 429);
    });

    assert.deepEqual(new Set(observedIps), new Set([
      '198.51.100.11',
      '203.0.113.12',
    ]));
  });

  test('different authenticated Users have independent counters on one simulated IP', async () => {
    const limiters = createRouteAbuseLimiters();
    const app = express();
    const firstUserId = '111111111111111111111111';
    const secondUserId = '222222222222222222222222';
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(addAuthenticatedUser);
    app.post('/photo', limiters.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await sendMutation(`${baseUrl}/photo`, {
          forwardedFor: '198.51.100.50',
          userId: firstUserId,
        });
        assert.equal(response.status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}/photo`, {
        forwardedFor: '198.51.100.50',
        userId: firstUserId,
      })).status, 429);
      assert.equal((await sendMutation(`${baseUrl}/photo`, {
        forwardedFor: '198.51.100.50',
        userId: secondUserId,
      })).status, 204);
    });
  });

  test('photo, video, and deletion counters are independent for one User', async () => {
    const limiters = createRouteAbuseLimiters();
    const app = express();
    app.use(express.json());
    app.use(addAuthenticatedUser);
    app.post('/photo', limiters.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });
    app.post('/video', limiters.videoUploadLimiter, (req, res) => {
      res.status(204).end();
    });
    app.delete('/media', limiters.mediaDeletionLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 429);
      assert.equal((await sendMutation(`${baseUrl}/video`)).status, 204);
      assert.equal((await sendMutation(`${baseUrl}/media`, {
        method: 'DELETE',
      })).status, 204);
    });
  });

  test('exhausting deletion leaves a fresh photo counter available', async () => {
    const limiters = createRouteAbuseLimiters();
    const app = express();
    app.use(express.json());
    app.use(addAuthenticatedUser);
    for (const route of ['/photo-delete', '/video-delete']) {
      app.delete(route, limiters.mediaDeletionLimiter, (req, res) => {
        res.status(204).end();
      });
    }
    app.post('/photo', limiters.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const route = attempt % 2 === 0 ? '/photo-delete' : '/video-delete';
        const response = await sendMutation(`${baseUrl}${route}`, {
          method: 'DELETE',
        });
        assert.equal(response.status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}/video-delete`, {
        method: 'DELETE',
      })).status, 429);
      assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 204);
    });
  });

  test('separately created limiter sets do not reuse MemoryStore state', async () => {
    const firstSet = createRouteAbuseLimiters();
    const firstApp = express();
    firstApp.post('/register', firstSet.registrationLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(firstApp, async baseUrl => {
      for (let attempt = 0; attempt < ROUTE_ABUSE_POLICIES.registration.limit; attempt += 1) {
        assert.equal((await sendPost(`${baseUrl}/register`, {})).status, 204);
      }
      assert.equal((await sendPost(`${baseUrl}/register`, {})).status, 429);
    });

    const secondSet = createRouteAbuseLimiters();
    const secondApp = express();
    secondApp.post('/register', secondSet.registrationLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(secondApp, async baseUrl => {
      assert.equal((await sendPost(`${baseUrl}/register`, {})).status, 204);
    });
  });

  test('separately created media limiter sets have fresh state', async () => {
    const firstSet = createRouteAbuseLimiters();
    const firstApp = express();
    firstApp.use(addAuthenticatedUser);
    firstApp.post('/photo', firstSet.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(firstApp, async baseUrl => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 204);
      }
      assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 429);
    });

    const secondSet = createRouteAbuseLimiters();
    const secondApp = express();
    secondApp.use(addAuthenticatedUser);
    secondApp.post('/photo', secondSet.photoUploadLimiter, (req, res) => {
      res.status(204).end();
    });

    await withServer(secondApp, async baseUrl => {
      assert.equal((await sendMutation(`${baseUrl}/photo`)).status, 204);
    });
  });
});

describe('public JSON API route wiring and downstream blocking', () => {
  const publicApiWiring = [
    ['/search-api', parkSearchApiLimiter, camp.searchApi],
    ['/park/:parkSlug/media', parkMediaApiLimiter, camp.getPark],
    [
      '/park/:parkSlug/campsite/:campsiteSlug',
      campsiteApiLimiter,
      camp.getCampsite,
    ],
    [
      '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug',
      campsiteApiLimiter,
      camp.getCampgroundCampsite,
    ],
  ];

  test('production GET stacks have the exact limiter-then-controller order', async () => {
    for (const [routePath, limiter, controller] of publicApiWiring) {
      assert.deepEqual(
        methodHandlers(getRoute(campRouter, routePath), 'get'),
        [limiter, controller],
        routePath,
      );
    }

    const actualWiring = [];
    const publicLimiters = [
      parkSearchApiLimiter,
      parkMediaApiLimiter,
      campsiteApiLimiter,
    ];
    for (const layer of campRouter.stack) {
      if (!layer.route) continue;
      for (const routeLayer of layer.route.stack) {
        if (publicLimiters.includes(routeLayer.handle)) {
          actualWiring.push([
            layer.route.path,
            routeLayer.method,
            routeLayer.handle,
          ]);
        }
      }
    }
    assert.deepEqual(
      actualWiring,
      publicApiWiring.map(([routePath, limiter]) => [
        routePath,
        'get',
        limiter,
      ]),
    );

    const source = await readSource('routes/camp.js');
    assert.match(
      source,
      /router\.route\('\/search-api'\)\s*\.get\(parkSearchApiLimiter, camp\.searchApi\)/u,
    );
    assert.match(
      source,
      /router\.route\('\/park\/:parkSlug\/media'\)\s*\.get\(parkMediaApiLimiter, camp\.getPark\)/u,
    );
    assert.match(
      source,
      /router\.route\('\/park\/:parkSlug\/campsite\/:campsiteSlug'\)\s*\.get\(campsiteApiLimiter, camp\.getCampsite\)/u,
    );
    assert.match(
      source,
      /router\.route\('\/park\/:parkSlug\/campground\/:campgroundSlug\/campsite\/:campsiteSlug'\)\s*\.get\(campsiteApiLimiter, camp\.getCampgroundCampsite\)/u,
    );
  });

  test('new public API limiters are excluded from HTML, mutation, authentication, and administrator routes', async () => {
    const publicLimiters = [
      parkSearchApiLimiter,
      parkMediaApiLimiter,
      campsiteApiLimiter,
    ];
    const excludedCampPaths = [
      '/search',
      '/all-parks',
      '/park/:parkSlug',
      ...photoUploadRoutes,
      ...videoUploadRoutes,
      ...mediaDeletionRoutes.map(([routePath]) => routePath),
    ];

    for (const routePath of excludedCampPaths) {
      const route = getRoute(campRouter, routePath);
      assert.equal(
        route.stack.some(layer => publicLimiters.includes(layer.handle)),
        false,
        routePath,
      );
    }

    const routeFiles = (await readdir(path.join(root, 'routes')))
      .filter(name => name.endsWith('.js') && name !== 'camp.js');
    for (const file of routeFiles) {
      const source = await readSource(path.join('routes', file));
      for (const name of [
        'parkSearchApiLimiter',
        'parkMediaApiLimiter',
        'campsiteApiLimiter',
      ]) {
        assert.equal(source.includes(name), false, `${file}: ${name}`);
      }
    }
  });

  test('blocked public requests stop before cache and database work', async () => {
    const cases = [
      {
        limiterName: 'parkSearchApiLimiter',
        limit: 30,
        path: `/camp/search-api?q=${sensitiveFixture.searchQuery}`,
        calls: {
          parser: 0,
          cacheLoader: 0,
          ranker: 0,
          serializer: 0,
        },
      },
      {
        limiterName: 'parkMediaApiLimiter',
        limit: 60,
        path: `/camp/park/${sensitiveFixture.parkSlug}/media`,
        calls: {
          parkQuery: 0,
          serializer: 0,
          permissionCalculation: 0,
        },
      },
      {
        limiterName: 'campsiteApiLimiter',
        limit: 60,
        path:
          `/camp/park/${sensitiveFixture.parkSlug}` +
          `/campground/${sensitiveFixture.campgroundSlug}` +
          `/campsite/${sensitiveFixture.campsiteSlug}`,
        calls: {
          resolver: 0,
          parkQuery: 0,
          exactIdSecondRead: 0,
          aggregation: 0,
          serializer: 0,
          permissionCalculation: 0,
        },
      },
    ];

    for (const fixture of cases) {
      const limiters = createRouteAbuseLimiters();
      const app = express();
      app.set('trust proxy', 1);
      app.get(
        fixture.path.split('?')[0],
        limiters[fixture.limiterName],
        (req, res) => {
          for (const key of Object.keys(fixture.calls)) fixture.calls[key] += 1;
          res.status(204).end();
        },
      );

      await withServer(app, async baseUrl => {
        for (let attempt = 0; attempt < fixture.limit; attempt += 1) {
          assert.equal((await sendMutation(`${baseUrl}${fixture.path}`, {
            forwardedFor: sensitiveFixture.ip,
            method: 'GET',
          })).status, 204);
        }
        const beforeBlocked = { ...fixture.calls };
        const blocked = await sendMutation(`${baseUrl}${fixture.path}`, {
          forwardedFor: sensitiveFixture.ip,
          method: 'GET',
        });
        assert.equal(blocked.status, 429);
        assert.deepEqual(fixture.calls, beforeBlocked);
      });

      assert.deepEqual(
        new Set(Object.values(fixture.calls)),
        new Set([fixture.limit]),
      );
    }
  });
});

describe('POST/DELETE-only route wiring and middleware order', () => {
  test('production route stacks contain password and account limiters only on intended POSTs', async () => {
    const registration = getRoute(userRouter, '/register');
    const login = getRoute(userRouter, '/login');
    const forgotPassword = getRoute(userRouter, '/forgot-password');
    const resetWithCode = getRoute(
      userRouter,
      '/forgot-password/:userId/:code',
    );
    const resetWithoutCode = getRoute(userRouter, '/forgot-password/:userId');
    const changePassword = getRoute(userRouter, '/change-password');
    const deleteAccount = getRoute(userRouter, '/delete-account');
    const resend = getRoute(userRouter, '/resend-verification');
    const contact = getRoute(otherRouter, '/contact');

    assert.deepEqual(methodHandlers(registration, 'post').slice(0, 2), [
      isLoggedOut,
      registrationLimiter,
    ]);
    assert.deepEqual(methodHandlers(login, 'post').slice(0, 3), [
      isLoggedOut,
      loginLimiter,
      usernameToLowerCaseAndTrim,
    ]);
    assert.deepEqual(methodHandlers(resend, 'post').slice(0, 2), [
      isAuthenticatedForVerification,
      verificationResendLimiter,
    ]);
    assert.strictEqual(methodHandlers(forgotPassword, 'post')[0], forgotPasswordLimiter);
    assert.strictEqual(methodHandlers(contact, 'post')[0], contactLimiter);
    assert.deepEqual(methodHandlers(resetWithCode, 'post').slice(0, 1), [
      passwordResetSubmissionLimiter,
    ]);
    assert.deepEqual(methodHandlers(resetWithoutCode, 'post').slice(0, 1), [
      passwordResetSubmissionLimiter,
    ]);
    assert.deepEqual(methodHandlers(changePassword, 'post').slice(0, 2), [
      isLoggedIn,
      passwordChangeLimiter,
    ]);
    assert.deepEqual(methodHandlers(deleteAccount, 'post').slice(0, 2), [
      isLoggedIn,
      accountDeletionLimiter,
    ]);
    assert.equal(methodHandlers(resetWithCode, 'post').length, 2);
    assert.equal(methodHandlers(resetWithoutCode, 'post').length, 2);
    assert.equal(methodHandlers(changePassword, 'post').length, 3);
    assert.equal(methodHandlers(deleteAccount, 'post').length, 3);

    assert.equal(methodHandlers(forgotPassword, 'get').includes(forgotPasswordLimiter), false);
    assert.equal(methodHandlers(resend, 'get').includes(verificationResendLimiter), false);
    assert.equal(methodHandlers(contact, 'get').includes(contactLimiter), false);
    for (const resetRoute of [resetWithCode, resetWithoutCode]) {
      assert.equal(
        methodHandlers(resetRoute, 'get').includes(
          passwordResetSubmissionLimiter,
        ),
        false,
      );
    }
    assert.equal(
      methodHandlers(forgotPassword, 'post').includes(
        passwordResetSubmissionLimiter,
      ),
      false,
    );

    const expectedWiring = [
      ['user', '/register', 'post', registrationLimiter],
      ['user', '/login', 'post', loginLimiter],
      ['user', '/resend-verification', 'post', verificationResendLimiter],
      ['user', '/forgot-password', 'post', forgotPasswordLimiter],
      [
        'user',
        '/forgot-password/:userId/:code',
        'post',
        passwordResetSubmissionLimiter,
      ],
      [
        'user',
        '/forgot-password/:userId',
        'post',
        passwordResetSubmissionLimiter,
      ],
      ['user', '/change-password', 'post', passwordChangeLimiter],
      ['user', '/delete-account', 'post', accountDeletionLimiter],
      ['other', '/contact', 'post', contactLimiter],
    ];
    const actualWiring = [];
    for (const [routerName, router] of [['user', userRouter], ['other', otherRouter]]) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        for (const routeLayer of layer.route.stack) {
          for (const limiter of [
            contactLimiter,
            forgotPasswordLimiter,
            loginLimiter,
            passwordResetSubmissionLimiter,
            passwordChangeLimiter,
            accountDeletionLimiter,
            registrationLimiter,
            verificationResendLimiter,
          ]) {
            if (routeLayer.handle === limiter) {
              actualWiring.push([
                routerName,
                layer.route.path,
                routeLayer.method,
                limiter,
              ]);
            }
          }
        }
      }
    }
    assert.deepEqual(actualWiring, expectedWiring);

    const source = await readSource('routes/users.js');
    assert.match(
      source,
      /router\.route\('\/forgot-password\/:userId\/:code'\)[\s\S]*?\.post\(\s*passwordResetSubmissionLimiter,\s*catchAsyncErrors\(users\.updateForgotPasswordReset\),\s*\);/,
    );
    assert.match(
      source,
      /router\.route\('\/forgot-password\/:userId'\)[\s\S]*?\.post\(\s*passwordResetSubmissionLimiter,\s*catchAsyncErrors\(users\.updateForgotPasswordReset\),\s*\);/,
    );
    assert.match(
      source,
      /router\.route\('\/change-password'\)\s*\.post\(\s*isLoggedIn,\s*passwordChangeLimiter,\s*catchAsyncErrors\(users\.changePassword\),\s*\);/,
    );
    assert.match(
      source,
      /router\.route\('\/delete-account'\)\s*\.post\(\s*isLoggedIn,\s*accountDeletionLimiter,\s*catchAsyncErrors\(users\.deleteAccount\),\s*\)/,
    );
  });

  test('GET and unrelated user routes contain none of the new limiters', () => {
    const newLimiters = [
      passwordResetSubmissionLimiter,
      passwordChangeLimiter,
      accountDeletionLimiter,
    ];
    const unrelatedRoutes = [
      ['/forgot-password', ['get']],
      ['/forgot-password/:userId/:code', ['get']],
      ['/forgot-password/:userId', ['get']],
      ['/account', ['get']],
      ['/logout', ['post']],
      ['/verify', ['get']],
      ['/verify/:code', ['get']],
      ['/resend-verification', ['get', 'post']],
    ];

    for (const [routePath, methods] of unrelatedRoutes) {
      const route = getRoute(userRouter, routePath);
      for (const method of methods) {
        assert.equal(
          methodHandlers(route, method).some(handler =>
            newLimiters.includes(handler)
          ),
          false,
          `${method.toUpperCase()} ${routePath}`,
        );
      }
    }

    assert.equal(
      methodHandlers(getRoute(userRouter, '/forgot-password'), 'post')
        .includes(passwordResetSubmissionLimiter),
      false,
    );
  });

  test('new limiter names are absent from media, public API, and administrator routers', async () => {
    const routeFiles = (await readdir(path.join(root, 'routes')))
      .filter(name => name.endsWith('.js') && name !== 'users.js');
    const names = [
      'passwordResetSubmissionLimiter',
      'passwordChangeLimiter',
      'accountDeletionLimiter',
    ];

    for (const file of routeFiles) {
      const source = await readSource(path.join('routes', file));
      for (const name of names) {
        assert.equal(source.includes(name), false, `${file}: ${name}`);
      }
    }
  });

  test('administrator status limiter appears only on the two intended production POST routes', () => {
    const unrelatedRouters = [userRouter, otherRouter, campRouter];
    for (const router of unrelatedRouters) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        assert.equal(
          layer.route.stack.some(
            routeLayer => routeLayer.handle === adminUserStatusLimiter,
          ),
          false,
          layer.route.path,
        );
      }
    }

    const actualWiring = [];
    for (const layer of adminRouter.stack) {
      if (!layer.route) continue;
      for (const routeLayer of layer.route.stack) {
        if (routeLayer.handle === adminUserStatusLimiter) {
          actualWiring.push([layer.route.path, routeLayer.method]);
        }
      }
    }

    assert.deepEqual(actualWiring, [
      ['/user/:id/block', 'post'],
      ['/user/:id/unblock', 'post'],
    ]);
    assert.equal(
      methodHandlers(getRoute(adminRouter, '/dashboard'), 'get')
        .includes(adminUserStatusLimiter),
      false,
    );
  });

  test('every media mutation route has the exact limiter middleware order', async () => {
    for (const routePath of photoUploadRoutes) {
      const handlers = methodHandlers(getRoute(campRouter, routePath), 'post');
      assert.equal(handlers.length, 3, routePath);
      assert.strictEqual(handlers[0], isLoggedIn, routePath);
      assert.strictEqual(handlers[1], photoUploadLimiter, routePath);
    }
    for (const routePath of videoUploadRoutes) {
      const handlers = methodHandlers(getRoute(campRouter, routePath), 'post');
      assert.equal(handlers.length, 3, routePath);
      assert.strictEqual(handlers[0], isLoggedIn, routePath);
      assert.strictEqual(handlers[1], videoUploadLimiter, routePath);
    }
    for (const [routePath, controller] of mediaDeletionRoutes) {
      assert.deepEqual(
        methodHandlers(getRoute(campRouter, routePath), 'delete'),
        [isLoggedIn, mediaDeletionLimiter, controller],
        routePath,
      );
    }

    const source = await readSource('routes/camp.js');
    assert.equal(
      (source.match(/\.post\(isLoggedIn, photoUploadLimiter, catchAsyncErrors\(media\.uploadPhoto\)\)/g) || []).length,
      3,
    );
    assert.equal(
      (source.match(/\.post\(isLoggedIn, videoUploadLimiter, catchAsyncErrors\(media\.addVideo\)\)/g) || []).length,
      3,
    );
    assert.equal(
      (source.match(/\.delete\(isLoggedIn, mediaDeletionLimiter, media\.deletePhoto\)/g) || []).length,
      3,
    );
    assert.equal(
      (source.match(/\.delete\(isLoggedIn, mediaDeletionLimiter, media\.deleteVideo\)/g) || []).length,
      3,
    );
  });

  test('the three media limiters appear only on the twelve intended mutations', () => {
    const actualWiring = [];
    for (const layer of campRouter.stack) {
      if (!layer.route) continue;
      for (const routeLayer of layer.route.stack) {
        for (const limiter of [
          photoUploadLimiter,
          videoUploadLimiter,
          mediaDeletionLimiter,
        ]) {
          if (routeLayer.handle === limiter) {
            actualWiring.push([
              layer.route.path,
              routeLayer.method,
              limiter,
            ]);
          }
        }
      }
    }

    assert.deepEqual(actualWiring, [
      [photoUploadRoutes[0], 'post', photoUploadLimiter],
      [videoUploadRoutes[0], 'post', videoUploadLimiter],
      [photoUploadRoutes[1], 'post', photoUploadLimiter],
      [videoUploadRoutes[1], 'post', videoUploadLimiter],
      [photoUploadRoutes[2], 'post', photoUploadLimiter],
      [videoUploadRoutes[2], 'post', videoUploadLimiter],
      ...mediaDeletionRoutes.map(([routePath]) => [
        routePath,
        'delete',
        mediaDeletionLimiter,
      ]),
    ]);
  });

  test('public media and campsite GET routes contain no media mutation limiter', () => {
    const publicGetRoutes = [
      '/park/:parkSlug/media',
      '/park/:parkSlug/campsite/:campsiteSlug',
      '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug',
    ];
    const mediaLimiters = [
      photoUploadLimiter,
      videoUploadLimiter,
      mediaDeletionLimiter,
    ];

    for (const routePath of publicGetRoutes) {
      const handlers = methodHandlers(getRoute(campRouter, routePath), 'get');
      assert.equal(
        handlers.some(handler => mediaLimiters.includes(handler)),
        false,
        routePath,
      );
    }
  });

  test('a blocked photo request stops parsing, buffering, validation, Cloudinary, and persistence', async () => {
    const limiterSet = createRouteAbuseLimiters();
    const calls = {
      buffering: 0,
      cloudinary: 0,
      controller: 0,
      imageValidation: 0,
      mongoPersistence: 0,
      multipart: 0,
    };
    const photoController = async (req, res) => {
      calls.controller += 1;
      calls.multipart += 1;
      calls.buffering += 1;
      calls.imageValidation += 1;
      calls.cloudinary += 1;
      calls.mongoPersistence += 1;
      res.status(204).end();
    };
    const app = express();
    app.use((req, res, next) => {
      req.isAuthenticated = () => true;
      addAuthenticatedUser(req, res, next);
    });
    app.post(
      '/camp/park/park/photo',
      isLoggedIn,
      limiterSet.photoUploadLimiter,
      catchAsyncErrors(photoController),
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/camp/park/park/photo`,
        )).status, 204);
      }
      assert.equal((await sendMutation(
        `${baseUrl}/camp/park/park/photo`,
      )).status, 429);
    });

    assert.deepEqual(calls, {
      buffering: 5,
      cloudinary: 5,
      controller: 5,
      imageValidation: 5,
      mongoPersistence: 5,
      multipart: 5,
    });
  });

  test('a blocked video request stops URL validation, queries, quota checks, and persistence', async () => {
    const limiterSet = createRouteAbuseLimiters();
    const calls = {
      controller: 0,
      mongoPersistence: 0,
      parkQuery: 0,
      quotaCheck: 0,
      youtubeValidation: 0,
    };
    const videoController = async (req, res) => {
      calls.controller += 1;
      calls.youtubeValidation += 1;
      calls.parkQuery += 1;
      calls.quotaCheck += 1;
      calls.mongoPersistence += 1;
      res.status(204).end();
    };
    const app = express();
    app.use((req, res, next) => {
      req.isAuthenticated = () => true;
      addAuthenticatedUser(req, res, next);
    });
    app.post(
      '/camp/park/park/video',
      isLoggedIn,
      limiterSet.videoUploadLimiter,
      catchAsyncErrors(videoController),
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/camp/park/park/video`,
        )).status, 204);
      }
      assert.equal((await sendMutation(
        `${baseUrl}/camp/park/park/video`,
      )).status, 429);
    });

    assert.deepEqual(calls, {
      controller: 20,
      mongoPersistence: 20,
      parkQuery: 20,
      quotaCheck: 20,
      youtubeValidation: 20,
    });
  });

  test('a blocked deletion stops the controller, deletion service, and cleanup processor', async () => {
    const limiterSet = createRouteAbuseLimiters();
    const calls = {
      cleanupProcessor: 0,
      controller: 0,
      deletionService: 0,
    };
    const deleteController = (req, res) => {
      calls.controller += 1;
      calls.deletionService += 1;
      calls.cleanupProcessor += 1;
      res.status(204).end();
    };
    const app = express();
    app.use((req, res, next) => {
      req.isAuthenticated = () => true;
      addAuthenticatedUser(req, res, next);
    });
    app.delete(
      '/camp/park/park/photo/photo-id',
      isLoggedIn,
      limiterSet.mediaDeletionLimiter,
      deleteController,
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/camp/park/park/photo/photo-id`,
          { method: 'DELETE' },
        )).status, 204);
      }
      assert.equal((await sendMutation(
        `${baseUrl}/camp/park/park/photo/photo-id`,
        { method: 'DELETE' },
      )).status, 429);
    });

    assert.deepEqual(calls, {
      cleanupProcessor: 60,
      controller: 60,
      deletionService: 60,
    });
  });

  test('a blocked password reset stops token lookup, hashing, persistence, and session invalidation', async () => {
    const limiterSet = createRouteAbuseLimiters();
    const calls = {
      controller: 0,
      passwordHashing: 0,
      sessionInvalidation: 0,
      tokenLookup: 0,
      userUpdate: 0,
    };
    const resetController = async (req, res) => {
      calls.controller += 1;
      calls.tokenLookup += 1;
      calls.passwordHashing += 1;
      calls.userUpdate += 1;
      calls.sessionInvalidation += 1;
      res.status(204).end();
    };
    const app = express();
    app.post(
      '/user/forgot-password/:userId/:code',
      limiterSet.passwordResetSubmissionLimiter,
      catchAsyncErrors(resetController),
    );

    await withServer(app, async baseUrl => {
      const url = `${baseUrl}/user/forgot-password/${sensitiveFixture.resetUserId}/${sensitiveFixture.resetCode}`;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await sendMutation(url)).status, 204);
      }
      assert.equal((await sendMutation(url)).status, 429);
    });

    assert.deepEqual(calls, {
      controller: 10,
      passwordHashing: 10,
      sessionInvalidation: 10,
      tokenLookup: 10,
      userUpdate: 10,
    });
  });

  test('a blocked password change stops credential verification, persistence, and auth-version updates', async () => {
    const limiterSet = createRouteAbuseLimiters();
    const calls = {
      authVersionUpdate: 0,
      controller: 0,
      originalPasswordVerification: 0,
      userSave: 0,
    };
    const changeController = async (req, res) => {
      calls.controller += 1;
      calls.originalPasswordVerification += 1;
      calls.userSave += 1;
      calls.authVersionUpdate += 1;
      res.status(204).end();
    };
    const app = express();
    app.use((req, res, next) => {
      req.isAuthenticated = () => true;
      addAuthenticatedUser(req, res, next);
    });
    app.post(
      '/user/change-password',
      isLoggedIn,
      limiterSet.passwordChangeLimiter,
      catchAsyncErrors(changeController),
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/user/change-password`,
        )).status, 204);
      }
      assert.equal((await sendMutation(
        `${baseUrl}/user/change-password`,
      )).status, 429);
    });

    assert.deepEqual(calls, {
      authVersionUpdate: 10,
      controller: 10,
      originalPasswordVerification: 10,
      userSave: 10,
    });
  });

  test('a blocked account deletion stops authentication, transaction, cleanup planning, jobs, and session destruction', async () => {
    const limiterSet = createRouteAbuseLimiters();
    const calls = {
      cleanupJob: 0,
      cleanupPlanning: 0,
      controller: 0,
      deletionService: 0,
      passwordAuthentication: 0,
      sessionDestruction: 0,
      transactionRunner: 0,
    };
    const deleteController = async (req, res) => {
      calls.controller += 1;
      calls.passwordAuthentication += 1;
      calls.deletionService += 1;
      calls.transactionRunner += 1;
      calls.cleanupPlanning += 1;
      calls.cleanupJob += 1;
      calls.sessionDestruction += 1;
      res.status(204).end();
    };
    const app = express();
    app.use((req, res, next) => {
      req.isAuthenticated = () => true;
      addAuthenticatedUser(req, res, next);
    });
    app.post(
      '/user/delete-account',
      isLoggedIn,
      limiterSet.accountDeletionLimiter,
      catchAsyncErrors(deleteController),
    );

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await sendMutation(
          `${baseUrl}/user/delete-account`,
        )).status, 204);
      }
      assert.equal((await sendMutation(
        `${baseUrl}/user/delete-account`,
      )).status, 429);
    });

    assert.deepEqual(calls, {
      cleanupJob: 5,
      cleanupPlanning: 5,
      controller: 5,
      deletionService: 5,
      passwordAuthentication: 5,
      sessionDestruction: 5,
      transactionRunner: 5,
    });
  });

  for (const expected of passwordAndAccountExpectedPolicies.filter(
    policy => policy.authenticatedUserKeyed,
  )) {
    test(`unauthenticated ${expected.policyName} requests stop before and do not consume the User limiter`, async () => {
      const limiterSet = createRouteAbuseLimiters();
      let limiterCalls = 0;
      let controllerCalls = 0;
      const app = express();
      app.use((req, res, next) => {
        const authenticated = req.get('X-Test-Authenticated') === 'yes';
        req.isAuthenticated = () => authenticated;
        req.flash = () => {};
        req.session = {
          save(callback) {
            callback();
          },
        };
        if (authenticated) {
          req.user = {
            _id: sensitiveFixture.authenticatedUserId,
            email_verified: true,
          };
        }
        next();
      });
      app.post(
        '/mutation',
        isLoggedIn,
        (req, res, next) => {
          limiterCalls += 1;
          limiterSet[expected.limiterName](req, res, next);
        },
        (req, res) => {
          controllerCalls += 1;
          res.status(204).end();
        },
      );

      await withServer(app, async baseUrl => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const rejected = await sendMutation(`${baseUrl}/mutation`, {
            headers: { 'X-Test-Authenticated': 'no' },
            redirect: 'manual',
          });
          assert.equal(rejected.status, 302);
          assert.equal(rejected.headers.get('location'), '/');
        }
        assert.equal(limiterCalls, 0);
        assert.equal(controllerCalls, 0);

        for (let attempt = 0; attempt < expected.limit; attempt += 1) {
          assert.equal((await sendMutation(`${baseUrl}/mutation`, {
            headers: { 'X-Test-Authenticated': 'yes' },
          })).status, 204);
        }
        assert.equal((await sendMutation(`${baseUrl}/mutation`, {
          headers: { 'X-Test-Authenticated': 'yes' },
        })).status, 429);
      });

      assert.equal(limiterCalls, expected.limit + 1);
      assert.equal(controllerCalls, expected.limit);
    });
  }

  test('authentication rejects before the photo limiter and consumes no authenticated allowance', async () => {
    const limiterSet = createRouteAbuseLimiters();
    let controllerCalls = 0;
    let limiterCalls = 0;
    const app = express();
    app.use((req, res, next) => {
      const authenticated = req.get('X-Test-Authenticated') === 'yes';
      req.isAuthenticated = () => authenticated;
      req.flash = () => {};
      req.session = {
        save(callback) {
          callback();
        },
      };
      if (authenticated) {
        req.user = {
          _id: sensitiveFixture.userId,
          email_verified: true,
        };
      }
      next();
    });
    app.post(
      '/camp/park/park/photo',
      isLoggedIn,
      (req, res, next) => {
        limiterCalls += 1;
        limiterSet.photoUploadLimiter(req, res, next);
      },
      (req, res) => {
        controllerCalls += 1;
        res.status(204).end();
      },
    );

    await withServer(app, async baseUrl => {
      const url = `${baseUrl}/camp/park/park/photo`;
      const rejected = await sendMutation(url, {
        headers: { 'X-Test-Authenticated': 'no' },
        redirect: 'manual',
      });
      assert.equal(rejected.status, 302);
      assert.equal(rejected.headers.get('location'), '/');
      assert.equal(limiterCalls, 0);
      assert.equal(controllerCalls, 0);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await sendMutation(url, {
          headers: { 'X-Test-Authenticated': 'yes' },
        })).status, 204);
      }
      assert.equal((await sendMutation(url, {
        headers: { 'X-Test-Authenticated': 'yes' },
      })).status, 429);
    });

    assert.equal(limiterCalls, 6);
    assert.equal(controllerCalls, 5);
  });

  test('login limiter precedes normalization and Passport authentication', async () => {
    const routes = await readSource('routes/users.js');
    const loginStart = routes.indexOf('router.post(');
    const loginEnd = routes.indexOf("router.route('/logout')", loginStart);
    const loginRoute = routes.slice(loginStart, loginEnd);

    assert.ok(loginStart >= 0 && loginEnd > loginStart);
    assert.ok(loginRoute.indexOf('isLoggedOut') < loginRoute.indexOf('loginLimiter'));
    assert.ok(
      loginRoute.indexOf('loginLimiter') <
        loginRoute.indexOf('usernameToLowerCaseAndTrim'),
    );
    assert.ok(
      loginRoute.indexOf('usernameToLowerCaseAndTrim') <
        loginRoute.indexOf("passport.authenticate('local'"),
    );
  });

  test('verification authentication rejection does not consume the injected limiter', async () => {
    let limiterCalls = 0;
    let controllerCalls = 0;
    const router = express.Router();
    addVerificationResendRoutes(
      router,
      async (req, res) => {
        controllerCalls += 1;
        res.status(204).end();
      },
      (req, res, next) => {
        limiterCalls += 1;
        next();
      },
    );
    const app = express();
    app.use((req, res, next) => {
      req.isAuthenticated = () => false;
      req.flash = () => {};
      req.session = {
        save(callback) {
          callback();
        },
      };
      next();
    });
    app.use('/user', router);

    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/user/resend-verification`, {
        method: 'POST',
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/');
    });

    assert.equal(limiterCalls, 0);
    assert.equal(controllerCalls, 0);
  });

  test('verification resend GET stays an unmetered compatibility redirect', async () => {
    let limiterCalls = 0;
    let controllerCalls = 0;
    const router = express.Router();
    addVerificationResendRoutes(
      router,
      async (req, res) => {
        controllerCalls += 1;
        res.status(204).end();
      },
      (req, res, next) => {
        limiterCalls += 1;
        next();
      },
    );
    const app = express();
    app.use((req, res, next) => {
      req.user = { _id: 'test-user', blocked: false, email_verified: false };
      req.isAuthenticated = () => true;
      next();
    });
    app.use('/user', router);

    await withServer(app, async baseUrl => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await fetch(`${baseUrl}/user/resend-verification`, {
          redirect: 'manual',
        });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), '/user/account');
      }
      assert.equal(limiterCalls, 0);
      assert.equal(controllerCalls, 0);

      assert.equal(
        (await sendPost(`${baseUrl}/user/resend-verification`, {})).status,
        204,
      );
    });

    assert.equal(limiterCalls, 1);
    assert.equal(controllerCalls, 1);
  });
});

describe('dependency, dead-helper, global-protection, and documentation guards', () => {
  test('dependency metadata matches the authorized dependency cleanup', async () => {
    const packageJson = JSON.parse(await readSource('package.json'));
    const packageLock = JSON.parse(await readSource('package-lock.json'));
    const expectedDependencies = {
      bcryptjs: '^3.0.2',
      cloudinary: '1.41.3',
      compression: '^1.8.1',
      'connect-flash': '^0.1.1',
      'connect-mongo': '^5.1.0',
      'csrf-sync': '^4.2.1',
      dotenv: '^17.2.3',
      ejs: '3.1.10',
      'ejs-mate': '^4.0.0',
      express: '^5.1.0',
      'express-rate-limit': '^8.6.1',
      'express-session': '^1.18.2',
      'express-slow-down': '^3.0.0',
      'form-data': '^4.0.4',
      helmet: '^8.1.0',
      'mailgun.js': '^12.1.1',
      'method-override': '^3.0.0',
      mongoose: '^8.19.1',
      multer: '^2.0.2',
      passport: '^0.7.0',
      'passport-local': '^1.0.0',
      'passport-local-mongoose': '^8.0.0',
      sharp: '^0.34.5',
      streamifier: '^0.1.1',
    };

    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(packageJson.dependencies, expectedDependencies);
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
    assert.deepEqual(packageLock.packages[''].dependencies, expectedDependencies);
    assert.equal(
      packageLock.packages['node_modules/express-rate-limit'].version,
      '8.6.1',
    );
    assert.equal(
      packageLock.packages['node_modules/express-slow-down'].version,
      '3.0.0',
    );
    assert.equal(
      (await readSource('package-lock.json')).includes(
        'express-rate-limit/-/express-rate-limit-8.1.0.tgz',
      ),
      false,
    );
  });

  test('dead helpers are absent from middleware and production imports', async () => {
    const middleware = await readSource('middleware.js');
    assert.doesNotMatch(middleware, /express-rate-limit|express-slow-down/);
    assert.doesNotMatch(middleware, /export const (?:rateLimiter|speedLimiter)\b/);

    const productionRoots = [
      'config',
      'controllers',
      'models',
      'public/js',
      'routes',
      'scripts',
      'utils',
    ];
    const files = ['app.js', 'middleware.js'];
    async function collect(directory) {
      const entries = await readdir(path.join(root, directory), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const relativePath = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(relativePath);
        else if (entry.name.endsWith('.js')) files.push(relativePath);
      }
    }
    for (const directory of productionRoots) await collect(directory);

    for (const file of files) {
      const source = await readSource(file);
      assert.doesNotMatch(
        source,
        /\b(?:rateLimiter|speedLimiter)\b/,
        `removed helper referenced by ${file}`,
      );
    }
  });

  test('active global limiter, slowdown, static exclusions, and bot blocker stay unchanged', async () => {
    const app = await readSource('app.js');
    assert.match(app, /const rateLimiterLong = rateLimiting\(\{\s*windowMs: 5 \* 60 \* 1000,\s*max: runtimeConfig\.requestLimits\.fiveMinuteMaximum,\s*message: 'Too many requests, please try again later\.',\s*skip: skipPublicFiles,/s);
    assert.match(app, /const speedLimiterLong = speedLimiting\(\{\s*windowMs: 1 \* 60 \* 1000,\s*delayAfter: runtimeConfig\.requestLimits\.oneMinuteDelayAfter,\s*delayMs: \(hits\) => hits \* 1 \* 1000,\s*skip: skipPublicFiles,/s);
    assert.match(app, /req\.path === '\/favicon\.ico'/);
    for (const staticPath of ['/css/', '/js/', '/images/', '/font/']) {
      assert.ok(app.includes(`req.path.startsWith('${staticPath}')`));
    }

    const rateUse = app.indexOf('app.use(rateLimiterLong)');
    const slowdownUse = app.indexOf('app.use(speedLimiterLong)');
    const botUse = app.indexOf('app.use(createBotUrlBlocker({');
    assert.ok(rateUse >= 0 && rateUse < slowdownUse && slowdownUse < botUse);
  });

  test('documentation records the complete protection model without fixture data', async () => {
    const documentation = await readSource('README-rate-limiting.md');
    assert.match(documentation, /runtime-configured `requestLimits\.fiveMinuteMaximum`/);
    assert.match(documentation, /runtime-configured `requestLimits\.oneMinuteDelayAfter`/);
    assert.match(documentation, /static-file paths/);
    assert.match(documentation, /bot-pattern block cache/);
    for (const row of [
      /Login[^\n]+15 minutes[^\n]+20/,
      /Registration[^\n]+60 minutes[^\n]+5/,
      /Forgotten-password email request[^\n]+60 minutes[^\n]+10/,
      /Verification-email resend[^\n]+60 minutes[^\n]+5/,
      /Contact submission[^\n]+60 minutes[^\n]+5/,
      /Photo upload[^\n]+10 minutes[^\n]+5/,
      /YouTube video addition[^\n]+60 minutes[^\n]+20/,
      /Media deletion[^\n]+60 minutes[^\n]+60/,
      /Forgotten-password reset-form submission[^\n]+60 minutes[^\n]+10/,
      /Authenticated password change[^\n]+60 minutes[^\n]+10/,
      /Account deletion[^\n]+60 minutes[^\n]+5/,
      /Park-search API[^\n]+1 minute[^\n]+30/,
      /Park-media API[^\n]+5 minutes[^\n]+60/,
      /Campsite-detail APIs[^\n]+5 minutes[^\n]+60/,
      /Administrator user-status mutation[^\n]+15 minutes[^\n]+30/,
    ]) assert.match(documentation, row);
    assert.match(documentation, /HTTP 429/);
    assert.match(documentation, /fixed plain-text response/);
    assert.match(documentation, /process memory/);
    assert.match(documentation, /reset whenever the process restarts/);
    assert.match(documentation, /Separate web dynos would have separate counters/);
    assert.match(documentation, /single-instance, basic abuse-prevention stage/);
    assert.match(
      documentation,
      /every limiter must move to a separate shared-store instance\s+with a unique prefix/,
    );
    assert.match(documentation, /not distributed-bot protection/);
    assert.match(documentation, /keyed only by the authenticated User ID/);
    assert.match(documentation, /independent counters/);
    assert.match(documentation, /all route variants for the same operation share/);
    assert.match(documentation, /before multipart parsing or\s+file buffering/);
    assert.match(
      documentation,
      /public API, authenticated media, password-change, account-deletion,\s+administrator user-status, and reset-form submission counters are also\s+process-local/,
    );
    assert.match(documentation, /default client-IP attribution/);
    assert.match(documentation, /Both reset-form POST variants share one\s+reset-submission counter/);
    assert.match(documentation, /separate from the forgotten-password\s+email-request counter/);
    assert.match(
      documentation,
      /Authenticated password changes and account deletion are keyed only by the\s+authenticated User ID and use separate counters/,
    );
    assert.match(
      documentation,
      /account-deletion limiter runs before current-password verification, the\s+database transaction, media inventory and cleanup planning, cleanup-job\s+creation, session destruction, and immediate cleanup processing/,
    );
    assert.match(
      documentation,
      /successful, malformed, incorrect-password,\s+invalid-link, expired-link, and validation-failing submissions/,
    );
    assert.match(documentation, /default client-IP\s+attribution/);
    assert.match(documentation, /relies on Express `req\.ip`/);
    assert.match(
      documentation,
      /two campsite-detail route variants share one campsite API\s+counter/,
    );
    assert.match(
      documentation,
      /Park search, park media, and campsite details have independent\s+counters/,
    );
    assert.match(documentation, /park-media JSON endpoint is covered by\s+this pass/);
    assert.match(
      documentation,
      /Park search is limited\s+before query parsing, cache loading, ranking, and serialization/,
    );
    assert.match(
      documentation,
      /Park media and\s+campsite details are limited before database queries/,
    );
    assert.match(documentation, /search\s+query, slug, URL, header, or media details/);
    assert.match(
      documentation,
      /administrator user-status limiter is keyed only by the authenticated\s+administrator User ID/,
    );
    assert.match(documentation, /Block and Unblock share one counter/);
    assert.match(
      documentation,
      /`isAdmin` executes\s+before the limiter/,
    );
    assert.match(
      documentation,
      /runs before target-ID validation, self-target comparison, database work/,
    );
    assert.match(
      documentation,
      /malformed targets,\s+self-target attempts, nonexistent targets, successful operations, and database\s+failures/,
    );
    assert.match(
      documentation,
      /Route-specific process-local coverage is now implemented\s+for the currently identified public and mutation endpoints/,
    );
    for (const limitation of [
      /distributed attacks/,
      /rotating-IP scraping/,
      /compromised\s+administrator accounts/,
      /abuse across multiple dynos/,
    ]) assert.match(documentation, limitation);
    assert.match(
      documentation,
      /migration of every limiter to a separate shared-store instance with a unique\s+prefix before multiple dynos/,
    );
    assert.doesNotMatch(
      documentation,
      /^[-*]\s+administrator mutations;/m,
    );
    assert.equal(documentation.includes('- public campsite APIs;'), false);
    assert.equal(documentation.includes('- the park search API;'), false);
    assert.doesNotMatch(documentation, /^[-*]\s+account deletion;/m);
    assert.doesNotMatch(
      documentation,
      /^[-*]\s+password-changing and password-reset submissions;/m,
    );
    assert.doesNotMatch(documentation, /^[-*]\s+uploads;/m);
    assert.doesNotMatch(documentation, /^[-*]\s+media deletion;/m);

    for (const value of sensitiveValues) {
      assert.equal(documentation.includes(value), false);
    }
  });

  test('restricted non-CSP surfaces outside ordinary logout remain unchanged', async () => {
    const status = execFileSync(
      'git',
      [
        'status',
        '--short',
        '--',
        'middleware.js',
        'config',
        'controllers',
        'models',
        'package.json',
        'package-lock.json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const browserStatus = execFileSync(
      'git',
      ['status', '--short', '--', 'public/js'],
      { cwd: root, encoding: 'utf8' },
    );
    const allowedExternalizationFiles = new Set([
      'public/js/adminDashboard.js',
      'public/js/allParks.js',
      'public/js/flash-messages.js',
      'public/js/forgotPassword.js',
      'public/js/general.js',
      'public/js/login.js',
      'public/js/mediaRendering.js',
      'public/js/showPark.js',
      'public/js/theme.js',
    ]);
    const unexpectedBrowserChanges = browserStatus
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter(line => !allowedExternalizationFiles.has(
        line.slice(3).replaceAll('\\', '/'),
      ));
    const packageJson = JSON.parse(await readSource('package.json'));
    const packageLock = JSON.parse(await readSource('package-lock.json'));
    const unexpectedProductionChanges = status
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter(line => (
        !new Set([
          'controllers/users.js',
          'middleware.js',
          'package.json',
          'package-lock.json',
        ]).has(line.slice(3).replaceAll('\\', '/'))
      ));

    assert.deepEqual(unexpectedProductionChanges, []);
    assert.deepEqual(unexpectedBrowserChanges, []);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
    assert.equal(
      packageJson.scripts['auth:audit-artifacts'],
      'node scripts/reconcileAuthArtifacts.js',
    );
    assert.equal(
      packageJson.scripts['auth:cleanup-expired-artifacts'],
      'node scripts/reconcileAuthArtifacts.js --apply',
    );
  });
});
