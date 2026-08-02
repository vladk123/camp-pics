import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import session from 'express-session';
import ejsMate from 'ejs-mate';
import methodOverride from 'method-override';

import {
  csrfErrorHandler,
  csrfSynchronisedProtection,
  exposeCsrfToken,
  getSubmittedCsrfToken,
  INVALID_CSRF_TOKEN_CODE,
  INVALID_CSRF_TOKEN_MESSAGE,
} from '../utils/csrf.js';
import { createCspNonceMiddleware } from '../utils/cspNonce.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = {
  controllerCalls: 0,
  genericErrors: [],
};
const memoryStore = new session.MemoryStore();

let server;
let baseUrl;

const getSetCookie = response =>
  response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie');

const getCookie = response => {
  const setCookie = getSetCookie(response);
  assert.ok(setCookie, 'expected the response to set a session cookie');
  return setCookie.split(';', 1)[0];
};

const request = (pathname, { cookie, headers = {}, ...options } = {}) =>
  fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  });

const getStoredSessions = () => new Promise((resolve, reject) => {
  memoryStore.all((err, sessions) => err ? reject(err) : resolve(sessions));
});

const getStoredSessionCount = async () =>
  Object.keys(await getStoredSessions()).length;

const getLegacySession = async () =>
  Object.values(await getStoredSessions())
    .find(storedSession => storedSession.legacyState === true);

const extractRenderedTokens = html => {
  const metaToken = html.match(
    /<meta name="csrf-token" content="([a-f0-9]+)">/,
  )?.[1];
  const fieldTokens = [
    ...html.matchAll(
      /<input type="hidden" name="_csrf" value="([a-f0-9]+)">/g,
    ),
  ].map(match => match[1]);

  return { fieldTokens, metaToken };
};

const getSessionToken = async cookie => {
  const response = await request('/rendered-page', { cookie });
  assert.equal(response.status, 200);
  const html = await response.text();
  const { fieldTokens, metaToken } = extractRenderedTokens(html);
  assert.match(metaToken, /^[a-f0-9]+$/);

  return {
    cookie: cookie || getCookie(response),
    fieldTokens,
    html,
    token: metaToken,
  };
};

before(async () => {
  const app = express();
  app.engine('ejs', ejsMate);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({
    store: memoryStore,
    name: 'csrf-test-session',
    secret: 'csrf-test-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: 'strict' },
  }));
  app.use(methodOverride('_method'));
  app.use(createCspNonceMiddleware());
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      canonicalUrl: null,
      currentUser: null,
      error: [],
      ga4EventJson: 'null',
      info: [],
      success: [],
      warning: [],
    });
    next();
  });

  // This route creates a pre-CSRF-style session without CSRF state.
  app.get('/legacy-session', (req, res) => {
    req.session.legacyState = true;
    res.status(204).end();
  });

  app.use(csrfSynchronisedProtection);
  app.use(exposeCsrfToken);

  app.get('/json', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/xml', (req, res) => {
    res.type('application/xml').send('<result>ok</result>');
  });

  app.get('/redirect-only', (req, res) => {
    res.redirect('/redirect-target');
  });

  app.get('/empty', (req, res) => {
    res.status(204).end();
  });

  app.get('/rendered-page', (req, res) => {
    res.render('home', {
      meta: {
        title: 'CSRF render test',
        description: 'CSRF render test',
      },
      data: { isHomepage: true },
    });
  });

  app.all('/protected', (req, res) => {
    state.controllerCalls += 1;
    res.json({ ok: true, calls: state.controllerCalls });
  });

  app.post('/regenerate-session', (req, res, next) => {
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.regeneratedState = true;
      return res.status(204).end();
    });
  });

  app.get('/failure', () => {
    throw new Error('expected non-CSRF failure');
  });

  app.get('/fake-csrf-error', (req, res, next) => {
    next(Object.assign(new Error('not the CSRF middleware error'), {
      code: INVALID_CSRF_TOKEN_CODE,
    }));
  });

  app.use(csrfErrorHandler);
  app.use((err, req, res, next) => {
    state.genericErrors.push(err);
    req.session.genericErrorState = true;
    res.redirect('/generic-error-target');
  });

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
});

test('installing the local is lazy and repeated property reads are request-cached', () => {
  const req = { session: {} };
  const res = { locals: {} };
  let nextCalls = 0;

  exposeCsrfToken(req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(req.session.csrfToken, undefined);
  const descriptor = Object.getOwnPropertyDescriptor(
    res.locals,
    'csrfToken',
  );
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.enumerable, true);

  const firstToken = res.locals.csrfToken;
  const secondToken = res.locals.csrfToken;
  assert.match(firstToken, /^[a-f0-9]+$/);
  assert.equal(secondToken, firstToken);
  assert.equal(req.session.csrfToken, firstToken);
});

test('a rendered EJS page generates one token, stores it, and sets a cookie', async () => {
  const beforeSessions = await getStoredSessionCount();
  const response = await request('/rendered-page');
  const html = await response.text();
  const { fieldTokens, metaToken } = extractRenderedTokens(html);
  const cookie = getCookie(response);
  const storedSessions = await getStoredSessions();

  assert.equal(response.status, 200);
  assert.match(metaToken, /^[a-f0-9]+$/);
  assert.ok(cookie);
  assert.ok(fieldTokens.length >= 2);
  assert.ok(fieldTokens.every(token => token === metaToken));
  assert.equal(Object.keys(storedSessions).length, beforeSessions + 1);
  assert.ok(
    Object.values(storedSessions)
      .some(storedSession => storedSession.csrfToken === metaToken),
  );
});

test('request extraction accepts only string headers or string body fields', () => {
  assert.equal(getSubmittedCsrfToken({
    headers: { 'x-csrf-token': 'header-token' },
    body: { _csrf: 'body-token' },
  }), 'header-token');
  assert.equal(getSubmittedCsrfToken({
    headers: { 'x-csrf-token': ['array-token'] },
    body: { _csrf: 'valid-body-token' },
  }), undefined);
  assert.equal(getSubmittedCsrfToken({
    headers: {},
    body: { _csrf: 12345 },
  }), undefined);
  assert.equal(getSubmittedCsrfToken({
    headers: {},
    body: { _csrf: 'body-token' },
  }), 'body-token');
});

test('two rendered pages in one session receive the same token', async () => {
  const first = await getSessionToken();
  const second = await getSessionToken(first.cookie);
  assert.equal(second.token, first.token);
});

test('separate sessions receive different tokens', async () => {
  const first = await getSessionToken();
  const second = await getSessionToken();
  assert.notEqual(second.token, first.token);
});

test('anonymous non-rendered safe responses create no session or cookie', async () => {
  const cases = [
    ['/json', 200],
    ['/xml', 200],
    ['/redirect-only', 302],
    ['/empty', 204],
  ];

  for (const [pathname, expectedStatus] of cases) {
    const beforeSessions = await getStoredSessionCount();
    const response = await request(pathname);

    assert.equal(response.status, expectedStatus, pathname);
    assert.equal(getSetCookie(response), null, pathname);
    assert.equal(
      await getStoredSessionCount(),
      beforeSessions,
      pathname,
    );
  }
});

test('legacy session state survives JSON and receives CSRF state only on render', async () => {
  const legacyResponse = await request('/legacy-session');
  const legacyCookie = getCookie(legacyResponse);
  const initialLegacySession = await getLegacySession();
  assert.equal(initialLegacySession.legacyState, true);
  assert.equal(initialLegacySession.csrfToken, undefined);

  const jsonResponse = await request('/json', {
    cookie: legacyCookie,
  });
  assert.equal(jsonResponse.status, 200);
  assert.equal(getSetCookie(jsonResponse), null);
  const afterJsonSession = await getLegacySession();
  assert.equal(afterJsonSession.legacyState, true);
  assert.equal(afterJsonSession.csrfToken, undefined);

  const renderedResponse = await request('/rendered-page', {
    cookie: legacyCookie,
  });
  const { metaToken } = extractRenderedTokens(await renderedResponse.text());
  const afterRenderSession = await getLegacySession();

  assert.equal(renderedResponse.status, 200);
  assert.match(metaToken, /^[a-f0-9]+$/);
  assert.equal(afterRenderSession.legacyState, true);
  assert.equal(afterRenderSession.csrfToken, metaToken);
});

for (const method of ['GET', 'HEAD', 'OPTIONS']) {
  test(`${method} is allowed without a submitted token`, async () => {
    const beforeCalls = state.controllerCalls;
    const response = await request('/protected', { method });

    assert.equal(response.status, 200);
    assert.equal(state.controllerCalls, beforeCalls + 1);
  });
}

test('an invalid anonymous POST generates no token, session, or cookie', async () => {
  const beforeSessions = await getStoredSessionCount();
  const response = await request('/protected', {
    method: 'POST',
    headers: { Accept: 'text/html' },
  });
  const html = await response.text();

  assert.equal(response.status, 403);
  assert.equal(getSetCookie(response), null);
  assert.equal(await getStoredSessionCount(), beforeSessions);
  assert.doesNotMatch(html, /csrf-token/);
  assert.doesNotMatch(html, /name="_csrf"/);
});

test('POST without a token returns 403 and never reaches the controller', async () => {
  const sessionState = await getSessionToken();
  const beforeCalls = state.controllerCalls;
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
  });

  assert.equal(response.status, 403);
  assert.equal(state.controllerCalls, beforeCalls);
});

test('POST with the wrong token returns 403', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'X-CSRF-Token': 'wrong-token' },
  });

  assert.equal(response.status, 403);
});

test('POST with an array body token returns 403', async () => {
  const sessionState = await getSessionToken();
  const body = new URLSearchParams([
    ['_csrf', sessionState.token],
    ['_csrf', sessionState.token],
  ]);
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  assert.equal(response.status, 403);
});

test('POST with an object body token returns 403', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _csrf: { value: sessionState.token } }),
  });

  assert.equal(response.status, 403);
});

test('POST with the correct URL-encoded body token succeeds', async () => {
  const sessionState = await getSessionToken();
  const beforeCalls = state.controllerCalls;
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: sessionState.token }),
  });

  assert.equal(response.status, 200);
  assert.equal(state.controllerCalls, beforeCalls + 1);
});

test('POST with the correct JSON body token succeeds', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _csrf: sessionState.token }),
  });

  assert.equal(response.status, 200);
});

test('POST with the correct header token succeeds', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'X-CSRF-Token': sessionState.token },
  });

  assert.equal(response.status, 200);
});

test('DELETE with the correct header token succeeds', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'DELETE',
    headers: { 'X-CSRF-Token': sessionState.token },
  });

  assert.equal(response.status, 200);
});

test('the header takes precedence over a correct body token', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'wrong-header-token',
    },
    body: JSON.stringify({ _csrf: sessionState.token }),
  });

  assert.equal(response.status, 403);
});

test('a token in the query string is rejected', async () => {
  const sessionState = await getSessionToken();
  const response = await request(
    `/protected?_csrf=${encodeURIComponent(sessionState.token)}`,
    {
      cookie: sessionState.cookie,
      method: 'POST',
    },
  );

  assert.equal(response.status, 403);
});

test('a cookie value alone is not accepted as the submitted token', async () => {
  const sessionState = await getSessionToken();
  const response = await request('/protected', {
    cookie: `${sessionState.cookie}; csrfToken=${sessionState.token}`,
    method: 'POST',
  });

  assert.equal(response.status, 403);
});

test('valid CSRF reaches the protected controller exactly once', async () => {
  const sessionState = await getSessionToken();
  const beforeCalls = state.controllerCalls;
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: { 'X-CSRF-Token': sessionState.token },
  });

  assert.equal(response.status, 200);
  assert.equal(state.controllerCalls, beforeCalls + 1);
});

test('JSON-accepting invalid requests receive the stable 403 shape', async () => {
  const sessionState = await getSessionToken();
  const submittedToken = 'json-submitted-token-must-not-leak';
  const bodyValue = 'json-body-value-must-not-leak';
  const genericErrorsBefore = state.genericErrors.length;
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': submittedToken,
    },
    body: JSON.stringify({ privateValue: bodyValue }),
  });
  const responseText = await response.text();

  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(responseText), {
    error: INVALID_CSRF_TOKEN_MESSAGE,
    code: INVALID_CSRF_TOKEN_CODE,
  });
  assert.doesNotMatch(responseText, new RegExp(sessionState.token));
  assert.doesNotMatch(responseText, new RegExp(submittedToken));
  assert.doesNotMatch(responseText, new RegExp(bodyValue));
  assert.equal(state.genericErrors.length, genericErrorsBefore);
});

test('ordinary form requests receive safe 403 HTML without token or body leakage', async () => {
  const sessionState = await getSessionToken();
  const submittedToken = 'submitted-token-must-not-leak';
  const bodyValue = 'body-value-must-not-leak';
  const genericErrorsBefore = state.genericErrors.length;
  const response = await request('/protected', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: {
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': submittedToken,
    },
    body: new URLSearchParams({ privateValue: bodyValue }),
  });
  const html = await response.text();

  assert.equal(response.status, 403);
  assert.match(html, /Security Check Failed/);
  assert.match(html, /Refresh the page and try again/);
  assert.doesNotMatch(html, new RegExp(sessionState.token));
  assert.doesNotMatch(html, new RegExp(submittedToken));
  assert.doesNotMatch(html, new RegExp(bodyValue));
  assert.equal(state.genericErrors.length, genericErrorsBefore);
});

test('generic redirect errors do not generate CSRF state', async () => {
  const beforeErrors = state.genericErrors.length;
  const failureResponse = await request('/failure');
  const failureCookie = getCookie(failureResponse);
  const sessionsAfterFailure = await getStoredSessions();
  const genericErrorSession = Object.values(sessionsAfterFailure)
    .find(storedSession => storedSession.genericErrorState === true);
  const fakeResponse = await request('/fake-csrf-error');

  assert.equal(failureResponse.status, 302);
  assert.ok(failureCookie);
  assert.equal(genericErrorSession.genericErrorState, true);
  assert.equal(genericErrorSession.csrfToken, undefined);
  assert.equal(fakeResponse.status, 302);
  assert.equal(state.genericErrors.length, beforeErrors + 2);
});

test('session regeneration invalidates the old token and a new page receives a new token', async () => {
  const sessionState = await getSessionToken();
  const regenerationResponse = await request('/regenerate-session', {
    cookie: sessionState.cookie,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'X-CSRF-Token': sessionState.token,
    },
  });

  assert.equal(regenerationResponse.status, 204);
  const newCookie = getCookie(regenerationResponse);
  const regeneratedSession = Object.values(await getStoredSessions())
    .find(storedSession => storedSession.regeneratedState === true);
  assert.equal(regeneratedSession.csrfToken, undefined);
  const newPage = await getSessionToken(newCookie);
  assert.notEqual(newPage.token, sessionState.token);

  const staleResponse = await request('/protected', {
    cookie: newCookie,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'X-CSRF-Token': sessionState.token,
    },
  });
  assert.equal(staleResponse.status, 403);

  const freshResponse = await request('/protected', {
    cookie: newCookie,
    method: 'POST',
    headers: {
      'X-CSRF-Token': newPage.token,
    },
  });
  assert.equal(freshResponse.status, 200);
});
