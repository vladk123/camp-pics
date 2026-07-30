import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const helperSource = await readFile(
  new URL('../public/js/csrf.js', import.meta.url),
  'utf8',
);

const loadHelper = ({ token = 'test-csrf-token', fetchImpl } = {}) => {
  const calls = [];
  const window = {
    document: {
      querySelector(selector) {
        assert.equal(selector, 'meta[name="csrf-token"]');
        if (token === null) return null;
        return {
          getAttribute(name) {
            assert.equal(name, 'content');
            return token;
          },
        };
      },
    },
    location: new URL('https://camppics.test/parks'),
    fetch: fetchImpl || (async (input, options) => {
      calls.push({ input, options });
      return { ok: true, status: 200 };
    }),
  };
  window.window = window;

  vm.runInNewContext(helperSource, {
    window,
    URL,
    Headers,
    FormData,
  });

  return { calls, helper: window.CampPicsCsrf };
};

test('unsafe same-origin requests receive the CSRF header and default credentials', async () => {
  const { calls, helper } = loadHelper();
  await helper.fetch('/write', { method: 'POST' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.get('X-CSRF-Token'), 'test-csrf-token');
  assert.equal(calls[0].options.credentials, 'same-origin');
});

test('GET receives no CSRF header', async () => {
  const { calls, helper } = loadHelper();
  await helper.fetch('/read', { method: 'GET' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers, undefined);
});

test('existing headers are preserved on unsafe requests', async () => {
  const { calls, helper } = loadHelper();
  await helper.fetch('/write', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  const headers = calls[0].options.headers;
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-CSRF-Token'), 'test-csrf-token');
});

test('JSON request bodies remain unchanged', async () => {
  const { calls, helper } = loadHelper();
  const body = JSON.stringify({ caption: 'Quiet site' });
  await helper.fetch('/write', { method: 'POST', body });

  assert.equal(calls[0].options.body, body);
});

test('FormData remains usable and unchanged', async () => {
  const { calls, helper } = loadHelper();
  const body = new FormData();
  body.append('caption', 'Lake view');
  await helper.fetch('/upload', { method: 'POST', body });

  assert.equal(calls[0].options.body, body);
  assert.equal(calls[0].options.body.get('caption'), 'Lake view');
});

test('method casing is normalized before safety checks', async () => {
  const { calls, helper } = loadHelper();
  await helper.fetch('/write', { method: 'pAtCh' });

  assert.equal(calls[0].options.headers.get('X-CSRF-Token'), 'test-csrf-token');
});

test('an unsafe request rejects clearly when the meta token is missing', async () => {
  const { calls, helper } = loadHelper({ token: null });

  await assert.rejects(
    helper.fetch('/write', { method: 'POST' }),
    /security token is unavailable/i,
  );
  assert.equal(calls.length, 0);
});

test('a safe cross-origin request does not receive the token', async () => {
  const { calls, helper } = loadHelper();
  await helper.fetch('https://example.test/read', { method: 'GET' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers, undefined);
});

test('unsafe cross-origin requests are rejected before fetch and cannot leak the token', async () => {
  const { calls, helper } = loadHelper();

  await assert.rejects(
    helper.fetch('https://example.test/write', { method: 'DELETE' }),
    /Unsafe cross-origin requests are not allowed/,
  );
  assert.equal(calls.length, 0);
});

test('the shared response helper returns the safe refresh instruction for CSRF 403s', () => {
  const { helper } = loadHelper();
  const message = helper.responseErrorMessage(
    { status: 403 },
    { code: 'INVALID_CSRF_TOKEN', error: 'server message' },
    'fallback',
  );

  assert.equal(
    message,
    'Your security token is invalid or expired. Refresh the page and try again.',
  );
});
