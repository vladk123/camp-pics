import assert from 'node:assert/strict';
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
  authenticatedUserKeyGenerator,
  contactLimiter,
  createRouteAbuseLimiters,
  fixedRateLimitHandler,
  forgotPasswordLimiter,
  loginLimiter,
  mediaDeletionLimiter,
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
const media = await import('../controllers/media.js');
const {
  isAuthenticatedForVerification,
  catchAsyncErrors,
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

const expectedPolicies = Object.freeze([
  ...existingExpectedPolicies,
  ...mediaExpectedPolicies,
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
  username: 'recognizable-login-user@example.test',
  password: 'Recognizable-Password-Secret!',
  forgot_username: 'recognizable-reset-user@example.test',
  fname: 'Recognizable Contact Name',
  email: 'recognizable-contact@example.test',
  email_subject: 'Recognizable Contact Subject',
  email_body: 'Recognizable contact body secret',
  parkSlug: 'recognizable-park-slug-secret',
  campgroundSlug: 'recognizable-campground-slug-secret',
  campsiteSlug: 'recognizable-campsite-slug-secret',
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
) => fetch(url, {
  method,
  redirect,
  headers: {
    'Content-Type': 'application/json',
    'X-CampPics-Test': sensitiveFixture.header,
    'X-Test-User-Id': userId,
    ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
    ...headers,
  },
  body: JSON.stringify(body),
});

const sendPost = (url, body = sensitiveFixture) =>
  sendMutation(url, { body });

function addAuthenticatedUser(req, res, next) {
  req.user = {
    _id: req.get('X-Test-User-Id') || sensitiveFixture.userId,
    username: sensitiveFixture.username,
    email: sensitiveFixture.email,
    email_verified: true,
  };
  req.session = { fixture: sensitiveFixture.session };
  next();
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
  test('constructs eight exact independent policies with one fixed handler', () => {
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

    assert.equal(capturedOptions.length, 8);
    assert.equal(createdInstances.length, 8);
    assert.equal(new Set(createdInstances).size, 8);
    assert.equal(new Set(Object.values(limiters)).size, 8);
    assert.equal(Object.isFrozen(limiters), true);
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

    const serializedOptions = JSON.stringify(capturedOptions);
    for (const value of sensitiveValues) {
      assert.equal(serializedOptions.includes(value), false);
    }
  });

  test('creates production instances once during cached module initialization', async () => {
    const secondImport = await import('../utils/routeAbuseLimits.js');
    const limiterNames = expectedPolicies.map(policy => policy.limiterName);
    const productionLimiters = limiterNames.map(name => routeAbuseModule[name]);

    assert.equal(new Set(productionLimiters).size, 8);
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
      /username|email|session|\.ip\b|\.path\b|headers|socket/,
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
      path: `/${sensitiveFixture.parkSlug}`,
      session: { id: sensitiveFixture.session },
    };
    const originalId = user._id;
    const originalUsername = user.username;
    const originalEmail = user.email;

    assert.equal(authenticatedUserKeyGenerator(req), expectedKey);
    req.ip = '203.0.113.77';
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

describe('POST/DELETE-only route wiring and middleware order', () => {
  test('production route stacks contain the five limiters only on intended POSTs', () => {
    const registration = getRoute(userRouter, '/register');
    const login = getRoute(userRouter, '/login');
    const forgotPassword = getRoute(userRouter, '/forgot-password');
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

    assert.equal(methodHandlers(forgotPassword, 'get').includes(forgotPasswordLimiter), false);
    assert.equal(methodHandlers(resend, 'get').includes(verificationResendLimiter), false);
    assert.equal(methodHandlers(contact, 'get').includes(contactLimiter), false);

    const expectedWiring = [
      ['user', '/register', 'post', registrationLimiter],
      ['user', '/login', 'post', loginLimiter],
      ['user', '/resend-verification', 'post', verificationResendLimiter],
      ['user', '/forgot-password', 'post', forgotPasswordLimiter],
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
  test('dependency metadata contains only the requested direct range addition', async () => {
    const packageJson = JSON.parse(await readSource('package.json'));
    const packageLock = JSON.parse(await readSource('package-lock.json'));
    const expectedDependencies = {
      bcryptjs: '^3.0.2',
      compression: '^1.8.1',
      'connect-flash': '^0.1.1',
      'connect-mongo': '^5.1.0',
      'csrf-sync': '^4.2.1',
      'csv-parser': '^3.2.0',
      csvtojson: '^2.0.10',
      dotenv: '^17.2.3',
      'ejs-mate': '^4.0.0',
      express: '^5.1.0',
      'express-rate-limit': '^8.6.1',
      'express-session': '^1.18.2',
      'express-slow-down': '^3.0.0',
      'express-validator': '^7.3.0',
      'form-data': '^4.0.4',
      helmet: '^8.1.0',
      'mailgun.js': '^12.1.1',
      'method-override': '^3.0.0',
      mongoose: '^8.19.1',
      multer: '^2.0.2',
      'multer-storage-cloudinary': '^4.0.0',
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
    ]) assert.match(documentation, row);
    assert.match(documentation, /HTTP 429/);
    assert.match(documentation, /fixed plain-text response/);
    assert.match(documentation, /process memory/);
    assert.match(documentation, /reset whenever the process restarts/);
    assert.match(documentation, /Separate web dynos would have separate counters/);
    assert.match(documentation, /single-instance, basic abuse-prevention stage/);
    assert.match(
      documentation,
      /own shared-store\s+instance with a unique prefix/,
    );
    assert.match(documentation, /not distributed-bot protection/);
    assert.match(documentation, /keyed only by the authenticated User ID/);
    assert.match(documentation, /independent counters/);
    assert.match(documentation, /all route variants for the same operation share/);
    assert.match(documentation, /before multipart parsing or\s+file buffering/);
    assert.match(documentation, /authenticated media counters are also process-local/);
    for (const deferred of [
      'account deletion',
      'password-changing and password-reset submissions',
      'public campsite APIs',
      'park search API',
      'administrator mutations',
    ]) assert.ok(documentation.includes(deferred));
    assert.doesNotMatch(documentation, /^[-*]\s+uploads;/m);
    assert.doesNotMatch(documentation, /^[-*]\s+media deletion;/m);

    for (const value of sensitiveValues) {
      assert.equal(documentation.includes(value), false);
    }
  });
});
