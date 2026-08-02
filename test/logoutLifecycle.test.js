import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const {
  createLogoutController,
  logout,
} = await import('../controllers/users.js');
const { default: userRouter } = await import('../routes/users.js');
const {
  isAdmin,
  isAuthenticatedForVerification,
  isLoggedIn,
  isLoggedOut,
} = await import('../middleware.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readSource = relativePath =>
  readFile(path.join(root, relativePath), 'utf8');

const createResponse = () => {
  const redirects = [];
  return {
    redirects,
    res: {
      headersSent: false,
      redirect(target) {
        redirects.push(target);
        return this;
      },
    },
  };
};

const createNextRecorder = () => {
  const errors = [];
  return {
    errors,
    next(error) {
      errors.push(error);
    },
  };
};

const assertNoSuccessResponse = ({
  flashCalls,
  redirects,
  nextErrors,
  expectedError,
}) => {
  assert.equal(flashCalls, 0);
  assert.deepEqual(redirects, []);
  assert.equal(nextErrors.length, 1);
  if (expectedError) {
    assert.strictEqual(nextErrors[0], expectedError);
  }
};

describe('ordinary logout lifecycle', () => {
  describe('already-anonymous requests', () => {
    for (const authenticationFixture of ['false', 'missing']) {
      test(`${authenticationFixture} isAuthenticated redirects without session work`, async () => {
        let logoutCalls = 0;
        let regenerateCalls = 0;
        let flashCalls = 0;
        const session = {
          marker: 'existing-anonymous-session',
          returnTo: '/private-location',
          auth_version: 17,
          regenerate() {
            regenerateCalls += 1;
          },
        };
        const originalState = {
          marker: session.marker,
          returnTo: session.returnTo,
          auth_version: session.auth_version,
        };
        const req = {
          session,
          logout() {
            logoutCalls += 1;
          },
          flash() {
            flashCalls += 1;
          },
        };
        if (authenticationFixture === 'false') {
          req.isAuthenticated = () => false;
        }
        const { res, redirects } = createResponse();
        const { next, errors } = createNextRecorder();

        await logout(req, res, next);

        assert.deepEqual(redirects, ['/']);
        assert.equal(logoutCalls, 0);
        assert.equal(regenerateCalls, 0);
        assert.equal(flashCalls, 0);
        assert.equal('__GA4_EVENT__' in session, false);
        assert.strictEqual(req.session, session);
        assert.deepEqual({
          marker: session.marker,
          returnTo: session.returnTo,
          auth_version: session.auth_version,
        }, originalState);
        assert.deepEqual(errors, []);
      });
    }
  });

  test('an authentication-check throw reaches next by identity without other work', async () => {
    const authenticationError = new Error('authentication check failed');
    let logoutCalls = 0;
    let regenerateCalls = 0;
    let flashCalls = 0;
    const session = {
      regenerate() {
        regenerateCalls += 1;
      },
    };
    const req = {
      session,
      isAuthenticated() {
        throw authenticationError;
      },
      logout() {
        logoutCalls += 1;
      },
      flash() {
        flashCalls += 1;
      },
    };
    const { res, redirects } = createResponse();
    const { next, errors } = createNextRecorder();

    await logout(req, res, next);

    assert.deepEqual(errors, [authenticationError]);
    assert.equal(logoutCalls, 0);
    assert.equal(regenerateCalls, 0);
    assert.equal(flashCalls, 0);
    assert.deepEqual(redirects, []);
    assert.equal('__GA4_EVENT__' in session, false);
  });

  describe('authenticated success', () => {
    const userFixtures = {
      unverified: { email_verified: false },
      blocked: { blocked: true },
      administrator: { isAdmin: true },
      minimal: {},
    };

    for (const [fixtureName, user] of Object.entries(userFixtures)) {
      test(`${fixtureName} authenticated User logs out through a regenerated session`, async () => {
        const order = [];
        const oldSession = {
          marker: 'old-authenticated-session',
          returnTo: '/private-location',
          auth_version: 23,
          __GA4_EVENT__: { event: 'old-event', user_id: 'old-user' },
          regenerate(callback) {
            order.push('regenerate');
            req.session = newSession;
            callback();
          },
        };
        const newSession = {
          marker: 'new-anonymous-session',
          save(callback) {
            callback();
          },
        };
        const req = {
          user,
          session: oldSession,
          isAuthenticated: () => true,
          logout(callback) {
            order.push('logout');
            callback();
          },
          flash(type, message) {
            order.push('flash/redirect');
            assert.strictEqual(req.session, newSession);
            req.session.flash ||= {};
            req.session.flash[type] ||= [];
            req.session.flash[type].push(message);
          },
        };
        const redirects = [];
        const res = {
          headersSent: false,
          redirect(target) {
            order.push('redirect');
            redirects.push(target);
            return this;
          },
        };
        const { next, errors } = createNextRecorder();

        await logout(req, res, next);

        assert.deepEqual(order, [
          'logout',
          'regenerate',
          'flash/redirect',
          'redirect',
        ]);
        assert.strictEqual(req.session, newSession);
        assert.deepEqual(newSession.flash, { success: ['Logged Out!'] });
        assert.deepEqual(newSession.__GA4_EVENT__, {
          event: 'logout',
          user_id: null,
        });
        assert.equal('returnTo' in newSession, false);
        assert.equal('auth_version' in newSession, false);
        assert.equal('flash' in oldSession, false);
        assert.deepEqual(oldSession.__GA4_EVENT__, {
          event: 'old-event',
          user_id: 'old-user',
        });
        assert.deepEqual(redirects, ['/']);
        assert.deepEqual(errors, []);
      });
    }
  });

  describe('logout callback failures', () => {
    test('a missing logout function produces one fixed local Error', async () => {
      const controller = createLogoutController();
      const receivedErrors = [];
      let regenerateCalls = 0;
      let flashCalls = 0;
      const redirects = [];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const req = {
          isAuthenticated: () => true,
          session: {
            regenerate() {
              regenerateCalls += 1;
            },
          },
          flash() {
            flashCalls += 1;
          },
        };
        await controller(req, {
          redirect(target) {
            redirects.push(target);
          },
        }, error => receivedErrors.push(error));
      }

      assert.equal(receivedErrors.length, 2);
      assert.strictEqual(receivedErrors[0], receivedErrors[1]);
      assert.equal(receivedErrors[0].message, 'Logout is unavailable.');
      assert.equal(regenerateCalls, 0);
      assert.equal(flashCalls, 0);
      assert.deepEqual(redirects, []);
    });

    for (const fixture of [
      {
        name: 'a synchronous logout throw',
        invoke(callback, error) {
          void callback;
          throw error;
        },
      },
      {
        name: 'a logout callback Error',
        invoke(callback, error) {
          callback(error);
        },
      },
      {
        name: 'a duplicate logout callback whose first result is an Error',
        invoke(callback, error) {
          callback(error);
          callback();
        },
      },
    ]) {
      test(`${fixture.name} preserves identity and stops regeneration`, async () => {
        const authoritativeError = new Error(fixture.name);
        let logoutCalls = 0;
        let regenerateCalls = 0;
        let flashCalls = 0;
        const req = {
          isAuthenticated: () => true,
          logout(callback) {
            logoutCalls += 1;
            fixture.invoke(callback, authoritativeError);
          },
          session: {
            regenerate() {
              regenerateCalls += 1;
            },
          },
          flash() {
            flashCalls += 1;
          },
        };
        const { res, redirects } = createResponse();
        const { next, errors } = createNextRecorder();

        await logout(req, res, next);

        assert.equal(logoutCalls, 1);
        assert.equal(regenerateCalls, 0);
        assertNoSuccessResponse({
          flashCalls,
          redirects,
          nextErrors: errors,
          expectedError: authoritativeError,
        });
      });
    }

    test('a duplicate logout callback whose first result succeeds responds once', async () => {
      const lateError = new Error('ignored duplicate logout error');
      let logoutCalls = 0;
      let regenerateCalls = 0;
      let flashCalls = 0;
      const oldSession = {
        regenerate(callback) {
          regenerateCalls += 1;
          req.session = newSession;
          callback();
        },
      };
      const newSession = {
        save(callback) {
          callback();
        },
      };
      const req = {
        session: oldSession,
        isAuthenticated: () => true,
        logout(callback) {
          logoutCalls += 1;
          callback();
          callback(lateError);
        },
        flash() {
          flashCalls += 1;
        },
      };
      const { res, redirects } = createResponse();
      const { next, errors } = createNextRecorder();

      await logout(req, res, next);

      assert.equal(logoutCalls, 1);
      assert.equal(regenerateCalls, 1);
      assert.equal(flashCalls, 1);
      assert.deepEqual(redirects, ['/']);
      assert.deepEqual(errors, []);
    });
  });

  describe('session-regeneration failures', () => {
    const runRegenerationFailure = async ({
      session,
      expectedError,
    }) => {
      let logoutCalls = 0;
      let flashCalls = 0;
      const req = {
        isAuthenticated: () => true,
        logout(callback) {
          logoutCalls += 1;
          callback();
        },
        flash() {
          flashCalls += 1;
        },
      };
      if (session !== undefined) {
        req.session = session;
      }
      const { res, redirects } = createResponse();
      const { next, errors } = createNextRecorder();

      await logout(req, res, next);

      assert.equal(logoutCalls, 1);
      assertNoSuccessResponse({
        flashCalls,
        redirects,
        nextErrors: errors,
        expectedError,
      });
      if (session) {
        assert.equal('__GA4_EVENT__' in session, false);
      }
      return errors[0];
    };

    test('a missing session produces the fixed regeneration Error', async () => {
      const error = await runRegenerationFailure({ session: undefined });
      assert.equal(error.message, 'Session regeneration is unavailable.');
    });

    test('a missing regenerate function produces the same fixed Error', async () => {
      const firstError = await runRegenerationFailure({ session: {} });
      const secondError = await runRegenerationFailure({ session: {} });

      assert.strictEqual(firstError, secondError);
      assert.equal(firstError.message, 'Session regeneration is unavailable.');
    });

    for (const fixture of [
      {
        name: 'a synchronous regeneration throw',
        invoke(callback, error) {
          void callback;
          throw error;
        },
      },
      {
        name: 'a regeneration callback Error',
        invoke(callback, error) {
          callback(error);
        },
      },
      {
        name: 'a duplicate regeneration callback whose first result is an Error',
        invoke(callback, error) {
          callback(error);
          callback();
        },
      },
    ]) {
      test(`${fixture.name} is authoritative and cannot flash`, async () => {
        const authoritativeError = new Error(fixture.name);
        let regenerateCalls = 0;
        const session = {
          regenerate(callback) {
            regenerateCalls += 1;
            fixture.invoke(callback, authoritativeError);
          },
        };

        await runRegenerationFailure({
          session,
          expectedError: authoritativeError,
        });

        assert.equal(regenerateCalls, 1);
      });
    }

    test('a duplicate regeneration callback whose first result succeeds responds once', async () => {
      const lateError = new Error('ignored duplicate regeneration error');
      let logoutCalls = 0;
      let regenerateCalls = 0;
      let flashCalls = 0;
      const oldSession = {
        regenerate(callback) {
          regenerateCalls += 1;
          req.session = newSession;
          callback();
          callback(lateError);
        },
      };
      const newSession = {
        save(callback) {
          callback();
        },
      };
      const req = {
        session: oldSession,
        isAuthenticated: () => true,
        logout(callback) {
          logoutCalls += 1;
          callback();
        },
        flash() {
          flashCalls += 1;
        },
      };
      const { res, redirects } = createResponse();
      const { next, errors } = createNextRecorder();

      await logout(req, res, next);

      assert.equal(logoutCalls, 1);
      assert.equal(regenerateCalls, 1);
      assert.equal(flashCalls, 1);
      assert.deepEqual(redirects, ['/']);
      assert.deepEqual(errors, []);
      assert.deepEqual(newSession.__GA4_EVENT__, {
        event: 'logout',
        user_id: null,
      });
    });
  });

  test('logout errors remain secret from output, flash and redirect data', async () => {
    const privateValues = {
      userId: 'user-id-logout-secret',
      sessionId: 'session-id-logout-secret',
      cookie: 'cookie-logout-secret',
      username: 'username-logout-secret',
      password: 'password-like-logout-secret',
    };
    const privateError = Object.assign(
      new Error(Object.values(privateValues).join(' ')),
      privateValues,
    );
    const printed = [];
    const originalConsoleMethods = {
      error: console.error,
      log: console.log,
      warn: console.warn,
    };
    let flashCalls = 0;
    const req = {
      isAuthenticated: () => true,
      logout(callback) {
        callback(privateError);
      },
      session: {
        regenerate() {
          throw new Error('regeneration must not start');
        },
      },
      flash() {
        flashCalls += 1;
      },
    };
    const { res, redirects } = createResponse();
    const { next, errors } = createNextRecorder();

    console.error = (...args) => printed.push(args);
    console.log = (...args) => printed.push(args);
    console.warn = (...args) => printed.push(args);
    try {
      await logout(req, res, next);
    } finally {
      console.error = originalConsoleMethods.error;
      console.log = originalConsoleMethods.log;
      console.warn = originalConsoleMethods.warn;
    }

    assert.deepEqual(printed, []);
    assert.strictEqual(errors[0], privateError);
    assert.equal(errors.length, 1);
    assert.equal(flashCalls, 0);
    assert.deepEqual(redirects, []);
    const responseData = JSON.stringify({ flashCalls, redirects });
    for (const privateValue of Object.values(privateValues)) {
      assert.equal(responseData.includes(privateValue), false);
    }
  });
});

describe('logout route, CSRF and source guards', () => {
  test('logout remains a single POST-only route using the corrected controller', async () => {
    const routeLayer = userRouter.stack.find(
      layer => layer.route?.path === '/logout',
    );
    assert.ok(routeLayer);
    assert.equal(routeLayer.route.methods.post, true);
    assert.equal(Boolean(routeLayer.route.methods.get), false);

    const postHandlers = routeLayer.route.stack
      .filter(layer => layer.method === 'post')
      .map(layer => layer.handle);
    assert.equal(postHandlers.length, 1);
    assert.notStrictEqual(postHandlers[0], isLoggedIn);
    assert.notStrictEqual(postHandlers[0], isLoggedOut);
    assert.notStrictEqual(postHandlers[0], isAuthenticatedForVerification);
    assert.notStrictEqual(postHandlers[0], isAdmin);

    const redirects = [];
    await new Promise((resolve, reject) => {
      postHandlers[0]({}, {
        redirect(target) {
          redirects.push(target);
          resolve();
        },
      }, reject);
    });
    assert.deepEqual(redirects, ['/']);

    const routesSource = await readSource('routes/users.js');
    const logoutStart = routesSource.indexOf("router.route('/logout')");
    const logoutEnd = routesSource.indexOf('// When user clicks', logoutStart);
    const logoutRouteSource = routesSource.slice(logoutStart, logoutEnd);
    assert.match(
      logoutRouteSource,
      /router\.route\('\/logout'\)\s*\.post\(catchAsyncErrors\(users\.logout\)\)/,
    );
    assert.doesNotMatch(logoutRouteSource, /\.get\s*\(/);
    assert.doesNotMatch(
      logoutRouteSource,
      /\b(?:isLoggedIn|isLoggedOut|isAuthenticatedForVerification|isAdmin)\b/,
    );
  });

  test('navbar submission and application-level CSRF protection stay intact', async () => {
    const [navbar, loginScript, appSource] = await Promise.all([
      readSource('views/partials/navbar.ejs'),
      readSource('public/js/login.js'),
      readSource('app.js'),
    ]);

    assert.match(
      navbar,
      /<form id="logout-form" class="logout-form" action="\/user\/logout" method="POST">/,
    );
    assert.match(navbar, /include\('\.\/csrfField'\)/);
    assert.match(navbar, /<div id="nav-logout">Logout<\/div>/);
    assert.match(
      loginScript,
      /getElementById\('logout-form'\)[\s\S]*?logoutForm\.submit\(\)/,
    );

    const csrfPosition = appSource.indexOf(
      'app.use(csrfSynchronisedProtection)',
    );
    const userRoutesPosition = appSource.indexOf(
      "app.use('/user', userRoutes)",
    );
    assert.ok(csrfPosition >= 0);
    assert.ok(userRoutesPosition > csrfPosition);
  });

  test('the focused controller reuses the callback helper without raw nested chains or logging', async () => {
    const usersSource = await readSource('controllers/users.js');
    const logoutStart = usersSource.indexOf(
      'export const createLogoutController',
    );
    const logoutEnd = usersSource.indexOf('export const verify', logoutStart);
    const logoutSource = usersSource.slice(logoutStart, logoutEnd);

    assert.ok(logoutStart >= 0 && logoutEnd > logoutStart);
    assert.match(logoutSource, /runCallback\s*=\s*runCallbackOperation/);
    assert.equal((logoutSource.match(/await runCallback\(/g) || []).length, 2);
    assert.match(logoutSource, /export const logout = createLogoutController\(\)/);
    assert.doesNotMatch(logoutSource, /req\.logout\s*\(\s*function/);
    assert.doesNotMatch(
      logoutSource,
      /req\.logout\s*\(\s*(?:err|error)\s*=>\s*\{/,
    );
    assert.doesNotMatch(
      logoutSource,
      /session\.regenerate\s*\(\s*\(?\s*(?:err|error)\b/,
    );
    assert.doesNotMatch(logoutSource, /\b(?:logger|console)\b/);
    assert.doesNotMatch(
      logoutSource,
      /req\.user|email_verified|blocked|isAdmin|username/,
    );
  });

  test('account-deletion session helpers retain their separate post-commit flow', async () => {
    const usersSource = await readSource('controllers/users.js');
    const start = usersSource.indexOf('async function endDeletedAccountSession');
    const end = usersSource.indexOf(
      'export const createDeleteAccountController',
      start,
    );
    const accountDeletionSessionSource = usersSource.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(
      accountDeletionSessionSource,
      /runCallbackOperation\(callback => req\.logout\(callback\)\)/,
    );
    assert.match(
      accountDeletionSessionSource,
      /runCallbackOperation\(callback => session\.destroy\(callback\)\)/,
    );
    assert.match(
      accountDeletionSessionSource,
      /ensureAnonymousResponseSession\([\s\S]*destroyedSession/,
    );
    assert.match(
      accountDeletionSessionSource,
      /Post-commit account deletion logout failed\./,
    );
    assert.match(
      accountDeletionSessionSource,
      /Post-commit account deletion session destruction failed\./,
    );
  });

  test('Node and npm engine policy remains exact in both manifests', async () => {
    const [packageSource, lockSource] = await Promise.all([
      readSource('package.json'),
      readSource('package-lock.json'),
    ]);
    const packageData = JSON.parse(packageSource);
    const lockData = JSON.parse(lockSource);
    const expectedEngines = { node: '24.x', npm: '11.x' };

    assert.deepEqual(packageData.engines, expectedEngines);
    assert.deepEqual(lockData.packages[''].engines, expectedEngines);
  });
});
