import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const routeAbuseModule = await import('../utils/routeAbuseLimits.js');
const {
  ROUTE_ABUSE_LIMIT_MESSAGE,
  ROUTE_ABUSE_POLICIES,
  contactLimiter,
  createRouteAbuseLimiters,
  fixedRateLimitHandler,
  forgotPasswordLimiter,
  loginLimiter,
  registrationLimiter,
  verificationResendLimiter,
} = routeAbuseModule;
const {
  addVerificationResendRoutes,
  default: userRouter,
} = await import('../routes/users.js');
const { default: otherRouter } = await import('../routes/other.js');
const {
  isAuthenticatedForVerification,
  isLoggedOut,
  usernameToLowerCaseAndTrim,
} = await import('../middleware.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readSource = relativePath =>
  readFile(path.join(root, relativePath), 'utf8');

const expectedPolicies = Object.freeze([
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

const sensitiveFixture = Object.freeze({
  username: 'recognizable-login-user@example.test',
  password: 'Recognizable-Password-Secret!',
  forgot_username: 'recognizable-reset-user@example.test',
  fname: 'Recognizable Contact Name',
  email: 'recognizable-contact@example.test',
  email_subject: 'Recognizable Contact Subject',
  email_body: 'Recognizable contact body secret',
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

const sendPost = (url, body = sensitiveFixture) => fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CampPics-Test': sensitiveFixture.header,
  },
  body: JSON.stringify(body),
});

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
  test('constructs five exact independent policies with one fixed handler', () => {
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

    assert.equal(capturedOptions.length, 5);
    assert.equal(createdInstances.length, 5);
    assert.equal(new Set(createdInstances).size, 5);
    assert.equal(new Set(Object.values(limiters)).size, 5);
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
      assert.deepEqual(Object.keys(options).sort(), [
        'handler',
        'legacyHeaders',
        'limit',
        'skipFailedRequests',
        'skipSuccessfulRequests',
        'standardHeaders',
        'statusCode',
        'windowMs',
      ].sort());
      assert.equal(options.windowMs, expected.windowMs);
      assert.equal(options.limit, expected.limit);
      assert.equal(options.statusCode, 429);
      assert.equal(options.standardHeaders, 'draft-8');
      assert.equal(options.legacyHeaders, false);
      assert.equal(options.skipSuccessfulRequests, false);
      assert.equal(options.skipFailedRequests, false);
      assert.strictEqual(options.handler, fixedRateLimitHandler);
      assert.equal(Object.hasOwn(options, 'keyGenerator'), false);
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

    assert.equal(new Set(productionLimiters).size, 5);
    for (const limiterName of limiterNames) {
      assert.strictEqual(routeAbuseModule[limiterName], secondImport[limiterName]);
    }
    assert.equal(
      Object.keys(routeAbuseModule).some(name => /store/i.test(name)),
      false,
    );
  });

  test('uses the package attribution defaults and contains no logging path', async () => {
    const source = await readSource('utils/routeAbuseLimits.js');
    assert.doesNotMatch(source, /keyGenerator|\bstore\s*:/);
    assert.doesNotMatch(source, /logger|console\.|reportEvent|req\.(?:body|headers|session|ip)/);

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

describe('real route-abuse limiter behavior', () => {
  for (const expected of expectedPolicies) {
    test(`${expected.policyName} allows ${expected.limit} attempts and blocks the next`, async () => {
      const limiterSet = createRouteAbuseLimiters();
      let controllerCalls = 0;
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        req.session = { fixture: sensitiveFixture.session };
        next();
      });
      app.post('/attempt', limiterSet[expected.limiterName], (req, res) => {
        controllerCalls += 1;
        if (controllerCalls % 2 === 0) {
          return res.status(400).send('Invalid attempt.');
        }
        return res.status(204).end();
      });

      await captureConsole(async captured => {
        await withServer(app, async baseUrl => {
          for (let attempt = 1; attempt <= expected.limit; attempt += 1) {
            const response = await sendPost(`${baseUrl}/attempt`);
            assert.equal(response.status, attempt % 2 === 0 ? 400 : 204);
          }

          const blocked = await sendPost(`${baseUrl}/attempt`);
          const body = await blocked.text();

          assert.equal(blocked.status, 429);
          assert.equal(controllerCalls, expected.limit);
          assert.equal(body, ROUTE_ABUSE_LIMIT_MESSAGE);
          assert.match(blocked.headers.get('content-type'), /^text\/plain\b/);
          assert.equal(blocked.headers.get('cache-control'), 'no-store');
          assert.ok(blocked.headers.get('ratelimit'));
          assert.equal(blocked.headers.get('x-ratelimit-limit'), null);
          for (const value of sensitiveValues) {
            assert.equal(body.includes(value), false);
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
});

describe('POST-only route wiring and middleware order', () => {
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
    ]) assert.match(documentation, row);
    assert.match(documentation, /HTTP 429/);
    assert.match(documentation, /fixed plain-text response/);
    assert.match(documentation, /process memory/);
    assert.match(documentation, /reset whenever the process restarts/);
    assert.match(documentation, /Separate web dynos would have separate counters/);
    assert.match(documentation, /single-instance, basic abuse-prevention stage/);
    assert.match(documentation, /own shared-store instance with a unique prefix/);
    assert.match(documentation, /not distributed-bot protection/);
    for (const deferred of [
      'uploads',
      'media deletion',
      'account deletion',
      'public campsite APIs',
      'park search API',
      'administrator mutations',
    ]) assert.ok(documentation.includes(deferred));

    for (const value of sensitiveValues) {
      assert.equal(documentation.includes(value), false);
    }
  });
});
