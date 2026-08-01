import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BlockedClientCache,
} from '../utils/blockedClientCache.js';
import { getIP } from '../utils/getIP.js';
import {
  MAX_URL_PATTERN_COUNT,
  MAX_URL_PATTERN_LENGTH,
  matchesLiteralUrlPattern,
  parseUrlPatterns,
} from '../utils/requestFiltering.js';
import {
  createBotUrlBlocker,
  createNotFoundHandler,
} from '../utils/requestFilteringMiddleware.js';

function createResponse() {
  return {
    body: undefined,
    renderData: undefined,
    statusCode: 200,
    view: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    render(view, data) {
      this.view = view;
      this.renderData = data;
      return this;
    },
  };
}

function invokeMiddleware(middleware, req) {
  const res = createResponse();
  let nextCalls = 0;
  const result = middleware(req, res, () => {
    nextCalls += 1;
  });
  return { nextCalls, res, result };
}

describe('URL-pattern parsing and literal matching', () => {
  test('missing, empty, and whitespace-only values become new empty arrays', () => {
    const parsed = [
      parseUrlPatterns(undefined),
      parseUrlPatterns(null),
      parseUrlPatterns(''),
      parseUrlPatterns('   '),
    ];

    parsed.forEach(value => assert.deepEqual(value, []));
    assert.notEqual(parsed[0], parsed[1]);
    assert.notEqual(parsed[1], parsed[2]);
  });

  test('entries are trimmed, empty entries removed, and exact duplicates deduplicated', () => {
    assert.deepEqual(parseUrlPatterns('foo'), ['foo']);
    assert.deepEqual(parseUrlPatterns(' foo,bar '), ['foo', 'bar']);
    assert.deepEqual(parseUrlPatterns('foo,, ,bar'), ['foo', 'bar']);
    assert.deepEqual(
      parseUrlPatterns(' foo,bar,foo, Foo,bar '),
      ['foo', 'bar', 'Foo'],
    );
  });

  test('only strings, null, and undefined are accepted', () => {
    for (const value of [0, false, {}, [], Symbol('patterns')]) {
      assert.throws(() => parseUrlPatterns(value), TypeError);
    }
  });

  test('the fixed pattern-count bound keeps the first valid unique entries', () => {
    const configured = Array.from(
      { length: MAX_URL_PATTERN_COUNT + 5 },
      (_, index) => `pattern-${index}`,
    ).join(',');
    const parsed = parseUrlPatterns(configured);

    assert.equal(parsed.length, MAX_URL_PATTERN_COUNT);
    assert.equal(parsed[0], 'pattern-0');
    assert.equal(
      parsed[MAX_URL_PATTERN_COUNT - 1],
      `pattern-${MAX_URL_PATTERN_COUNT - 1}`,
    );
  });

  test('oversized entries are ignored rather than truncated into broader matches', () => {
    const exactLimit = 'a'.repeat(MAX_URL_PATTERN_LENGTH);
    const oversized = 'b'.repeat(MAX_URL_PATTERN_LENGTH + 1);

    assert.deepEqual(
      parseUrlPatterns(`${oversized},${exactLimit},safe`),
      [exactLimit, 'safe'],
    );
  });

  test('matching is case-sensitive literal substring matching, never regular expressions', () => {
    const patterns = parseUrlPatterns('.*,Admin');

    assert.equal(matchesLiteralUrlPattern('/ordinary/path', patterns), false);
    assert.equal(matchesLiteralUrlPattern('/literal/.*', patterns), true);
    assert.equal(matchesLiteralUrlPattern('/Admin/panel', patterns), true);
    assert.equal(matchesLiteralUrlPattern('/admin/panel', patterns), false);
    assert.equal(matchesLiteralUrlPattern('/anything', ['', '']), false);
  });
});

describe('canonical client IP extraction', () => {
  test('uses Express-derived req.ip and supports IPv4 and IPv6', () => {
    assert.equal(getIP({ ip: '203.0.113.8' }), '203.0.113.8');
    assert.equal(getIP({ ip: '2001:db8::8' }), '2001:db8::8');
  });

  test('normalizes IPv4-mapped IPv6 addresses', () => {
    assert.equal(getIP({ ip: '::ffff:192.0.2.9' }), '192.0.2.9');
    assert.equal(getIP({ ip: ' ::FFFF:127.0.0.1 ' }), '127.0.0.1');
  });

  test('permits local and private addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.2', '192.168.1.4', '::1', 'fd00::1']) {
      assert.equal(getIP({ ip }), ip);
    }
  });

  test('returns null for missing, blank, or invalid Express IP values', () => {
    for (const req of [
      undefined,
      {},
      { ip: null },
      { ip: '' },
      { ip: '   ' },
      { ip: '999.1.1.1' },
      { ip: '127.0.0.1:3000' },
      { ip: ['203.0.113.8'] },
    ]) {
      assert.equal(getIP(req), null);
    }
  });

  test('spoofed forwarding headers cannot override an unchanged req.ip', () => {
    const req = {
      ip: '192.168.0.10',
      headers: {
        'x-forwarded-for': '198.51.100.1',
        forwarded: 'for=198.51.100.2',
        'x-real-ip': '198.51.100.3',
        'cf-connecting-ip': '198.51.100.4',
        'true-client-ip': '198.51.100.5',
        'x-client-ip': '198.51.100.6',
        'x-cluster-client-ip': '198.51.100.7',
      },
    };

    assert.equal(getIP(req), '192.168.0.10');
  });

  test('does not inspect the request headers property', () => {
    const req = { ip: '203.0.113.20' };
    Object.defineProperty(req, 'headers', {
      get() {
        throw new Error('headers must not be read');
      },
    });

    assert.equal(getIP(req), '203.0.113.20');
  });
});

describe('bounded blocked-client cache', () => {
  test('stores an active block and deletes it at the exact expiry boundary', () => {
    let now = 1_000;
    const cache = new BlockedClientCache({
      blockDurationMs: 100,
      maxEntries: 5,
      clock: () => now,
    });

    assert.equal(cache.block('client-a'), true);
    assert.equal(cache.size, 1);
    assert.equal(cache.isBlocked('client-a'), true);
    now = 1_099;
    assert.equal(cache.isBlocked('client-a'), true);
    now = 1_100;
    assert.equal(cache.isBlocked('client-a'), false);
    assert.equal(cache.size, 0);
  });

  test('refreshing an existing key changes expiry without increasing size', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 10,
      maxEntries: 2,
      clock: () => now,
    });

    cache.block('client-a');
    now = 5;
    cache.block('client-a');
    assert.equal(cache.size, 1);
    now = 14;
    assert.equal(cache.isBlocked('client-a'), true);
    now = 15;
    assert.equal(cache.isBlocked('client-a'), false);
  });

  test('null, blank, non-string, and oversized client IDs are not stored', () => {
    const cache = new BlockedClientCache({ maxEntries: 2 });
    for (const clientId of [null, undefined, '', '   ', {}, 'x'.repeat(129)]) {
      assert.equal(cache.block(clientId), false);
      assert.equal(cache.isBlocked(clientId), false);
    }
    assert.equal(cache.size, 0);
  });

  test('expired entries are pruned before capacity enforcement', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 10,
      maxEntries: 2,
      clock: () => now,
    });

    cache.block('client-a');
    now = 5;
    cache.block('client-b');
    now = 10;
    cache.block('client-c');

    assert.equal(cache.size, 2);
    assert.equal(cache.isBlocked('client-a'), false);
    assert.equal(cache.isBlocked('client-b'), true);
    assert.equal(cache.isBlocked('client-c'), true);
  });

  test('capacity deterministically evicts the oldest-expiring active entry', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 100,
      maxEntries: 2,
      clock: () => now,
    });

    cache.block('client-a');
    now = 1;
    cache.block('client-b');
    now = 2;
    cache.block('client-c');

    assert.equal(cache.size, 2);
    assert.equal(cache.isBlocked('client-a'), false);
    assert.equal(cache.isBlocked('client-b'), true);
    assert.equal(cache.isBlocked('client-c'), true);
  });

  test('the maximum size is never exceeded across many inserts', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 100,
      maxEntries: 3,
      clock: () => now,
    });

    for (let index = 0; index < 25; index += 1) {
      now = index;
      cache.block(`client-${index}`);
      assert.ok(cache.size <= 3);
    }
  });
});

describe('bot URL blocker middleware', () => {
  test('no patterns passes through without IP lookup, URL classification, or cache work', () => {
    let ipLookups = 0;
    const req = {};
    Object.defineProperty(req, 'originalUrl', {
      get() {
        throw new Error('originalUrl must not be classified');
      },
    });
    const blocker = createBotUrlBlocker({
      blockedPatterns: [],
      cache: {
        isBlocked() {
          throw new Error('cache must not be read');
        },
        block() {
          throw new Error('cache must not be written');
        },
      },
      getClientIp() {
        ipLookups += 1;
        return '203.0.113.1';
      },
    });

    const { nextCalls, res } = invokeMiddleware(blocker, req);
    assert.equal(nextCalls, 1);
    assert.equal(ipLookups, 0);
    assert.equal(res.statusCode, 200);
  });

  test('a normal request calls next exactly once and does not write the cache', () => {
    let cacheWrites = 0;
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache: {
        isBlocked: () => false,
        block() {
          cacheWrites += 1;
        },
      },
      getClientIp: () => '203.0.113.2',
    });

    const { nextCalls, res } = invokeMiddleware(blocker, {
      originalUrl: '/ordinary',
    });
    assert.equal(nextCalls, 1);
    assert.equal(cacheWrites, 0);
    assert.equal(res.statusCode, 200);
  });

  test('a matching URL returns 403, caches its usable IP, and emits fixed safe metadata', () => {
    const cache = new BlockedClientCache({ maxEntries: 5 });
    const reportCalls = [];
    const matchedPattern = 'private-bot-fragment';
    const blocker = createBotUrlBlocker({
      blockedPatterns: [matchedPattern],
      cache,
      getClientIp: () => '203.0.113.3',
      reportEvent: (...args) => reportCalls.push(args),
    });
    const sensitiveValues = [
      matchedPattern,
      'spoofed-forwarding-value',
      'body-secret',
      'session-secret',
      'user-secret',
    ];
    const req = {
      method: 'GET',
      path: '/safe-path',
      originalUrl: `/scan/${matchedPattern}?query-secret`,
      headers: { 'x-forwarded-for': 'spoofed-forwarding-value' },
      body: { value: 'body-secret' },
      session: { value: 'session-secret' },
      user: { username: 'user-secret' },
    };

    const { nextCalls, res } = invokeMiddleware(blocker, req);

    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, 'No.');
    assert.equal(cache.isBlocked('203.0.113.3'), true);
    assert.deepEqual(reportCalls, [[
      null,
      null,
      'error',
      { message: 'Blocked bot-pattern request.', severity: 1 },
    ]]);
    const capturedMetadata = JSON.stringify(reportCalls);
    sensitiveValues.forEach(value => assert.equal(
      capturedMetadata.includes(value),
      false,
      `${value} leaked into operational metadata`,
    ));
  });

  test('an active cached client is blocked on an unrelated URL', () => {
    const cache = new BlockedClientCache({ maxEntries: 5 });
    cache.block('203.0.113.4');
    const reportCalls = [];
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp: () => '203.0.113.4',
      reportEvent: (...args) => reportCalls.push(args),
    });

    const { nextCalls, res } = invokeMiddleware(blocker, {
      originalUrl: '/ordinary',
    });
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, 'Nope.');
    assert.equal(reportCalls[0][2], 'general');
    assert.deepEqual(reportCalls[0][3], {
      message: 'Blocked request remains active.',
      severity: 1,
    });
  });

  test('an expired client is removed and the current unmatched URL proceeds', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 10,
      maxEntries: 5,
      clock: () => now,
    });
    cache.block('203.0.113.5');
    now = 10;
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp: () => '203.0.113.5',
    });

    const { nextCalls, res } = invokeMiddleware(blocker, {
      originalUrl: '/ordinary',
    });
    assert.equal(nextCalls, 1);
    assert.equal(res.statusCode, 200);
    assert.equal(cache.size, 0);
  });

  test('an expired client is reevaluated and recached when the current URL matches', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 10,
      maxEntries: 5,
      clock: () => now,
    });
    cache.block('203.0.113.6');
    now = 10;
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp: () => '203.0.113.6',
    });

    const { nextCalls, res } = invokeMiddleware(blocker, {
      originalUrl: '/blocked-fragment',
    });
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(cache.size, 1);
    assert.equal(cache.isBlocked('203.0.113.6'), true);
  });

  test('a matching request without a usable IP is blocked but never cached', () => {
    const cache = new BlockedClientCache({ maxEntries: 5 });
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp: () => null,
    });

    const blocked = invokeMiddleware(blocker, {
      originalUrl: '/blocked-fragment',
    });
    const unrelated = invokeMiddleware(blocker, {
      originalUrl: '/ordinary',
    });
    assert.equal(blocked.res.statusCode, 403);
    assert.equal(blocked.nextCalls, 0);
    assert.equal(cache.size, 0);
    assert.equal(unrelated.nextCalls, 1);
    assert.equal(unrelated.res.statusCode, 200);
  });

  test('failure to resolve an IP still blocks the matching request without caching', () => {
    const cache = new BlockedClientCache({ maxEntries: 5 });
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp() {
        throw new Error('simulated IP helper failure');
      },
    });

    const { nextCalls, res } = invokeMiddleware(blocker, {
      originalUrl: '/blocked-fragment',
    });
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(cache.size, 0);
  });

  test('repeat requests from an active client do not extend its block', () => {
    let now = 0;
    const cache = new BlockedClientCache({
      blockDurationMs: 100,
      maxEntries: 5,
      clock: () => now,
    });
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp: () => '203.0.113.7',
    });

    assert.equal(invokeMiddleware(blocker, {
      originalUrl: '/blocked-fragment',
    }).res.statusCode, 403);
    now = 50;
    assert.equal(invokeMiddleware(blocker, {
      originalUrl: '/ordinary',
    }).res.statusCode, 403);
    now = 100;
    const expired = invokeMiddleware(blocker, { originalUrl: '/ordinary' });
    assert.equal(expired.nextCalls, 1);
    assert.equal(expired.res.statusCode, 200);
  });

  test('middleware-driven cache inserts never exceed the configured maximum', () => {
    let clientIp;
    const cache = new BlockedClientCache({ maxEntries: 3 });
    const blocker = createBotUrlBlocker({
      blockedPatterns: ['/blocked-fragment'],
      cache,
      getClientIp: () => clientIp,
    });

    for (let index = 0; index < 20; index += 1) {
      clientIp = `203.0.113.${index + 1}`;
      const result = invokeMiddleware(blocker, {
        originalUrl: '/blocked-fragment',
      });
      assert.equal(result.res.statusCode, 403);
      assert.ok(cache.size <= 3);
    }
  });

  test('synchronous and asynchronous reporting failures do not change a block decision', async t => {
    for (const fixture of [
      {
        name: 'synchronous throw',
        reportEvent() {
          throw new Error('simulated synchronous reporter failure');
        },
      },
      {
        name: 'rejected promise',
        reportEvent() {
          return Promise.reject(new Error('simulated asynchronous reporter failure'));
        },
      },
    ]) {
      await t.test(fixture.name, async () => {
        const blocker = createBotUrlBlocker({
          blockedPatterns: ['/blocked-fragment'],
          getClientIp: () => '203.0.113.8',
          reportEvent: fixture.reportEvent,
        });
        const { nextCalls, res } = invokeMiddleware(blocker, {
          originalUrl: '/blocked-fragment',
        });

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(nextCalls, 0);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body, 'No.');
      });
    }
  });
});

describe('ignored 404 URL behavior', () => {
  test('missing and empty IGNORE_URL values report ordinary 404s without crashing', () => {
    for (const configuredValue of [undefined, '']) {
      const reportCalls = [];
      const handler = createNotFoundHandler({
        ignoredPatterns: parseUrlPatterns(configuredValue),
        reportEvent: (...args) => reportCalls.push(args),
      });
      const res = createResponse();

      handler({ originalUrl: '/missing' }, res);
      assert.equal(reportCalls.length, 1);
      assert.equal(res.statusCode, 404);
      assert.equal(res.view, '404');
    }
  });

  test('comma-delimited values are whole patterns rather than individual characters', () => {
    const ignoredPatterns = parseUrlPatterns('foo,bar');
    const reportCalls = [];
    const handler = createNotFoundHandler({
      ignoredPatterns,
      reportEvent: (...args) => reportCalls.push(args),
    });

    handler({ originalUrl: '/f' }, createResponse());
    handler({ originalUrl: '/path/foo' }, createResponse());
    handler({ originalUrl: '/path/bar' }, createResponse());

    assert.equal(reportCalls.length, 1);
    assert.deepEqual(ignoredPatterns, ['foo', 'bar']);
  });

  test('an ignored URL suppresses only the event and preserves the exact 404 render', () => {
    const reportCalls = [];
    const handler = createNotFoundHandler({
      ignoredPatterns: ['known-crawler-fragment'],
      reportEvent: (...args) => reportCalls.push(args),
    });
    const res = createResponse();

    handler({ originalUrl: '/known-crawler-fragment?query=value' }, res);

    assert.equal(reportCalls.length, 0);
    assert.equal(res.statusCode, 404);
    assert.equal(res.view, '404');
    assert.deepEqual(res.renderData, {
      meta: {
        title: 'Page not found',
        description: 'This page does not exist.',
      },
      data: {},
    });
  });

  test('an ordinary URL emits only fixed metadata and preserves the 404 render', () => {
    const reportCalls = [];
    const handler = createNotFoundHandler({
      ignoredPatterns: ['ignored-fragment'],
      reportEvent: (...args) => reportCalls.push(args),
    });
    const res = createResponse();

    handler({
      method: 'GET',
      path: '/missing',
      originalUrl: '/missing?secret=query',
      headers: { 'x-forwarded-for': 'header-secret' },
      body: { secret: 'body-secret' },
      session: { secret: 'session-secret' },
      user: { secret: 'user-secret' },
    }, res);

    assert.deepEqual(reportCalls, [[
      { method: 'GET', path: '/missing' },
      null,
      'error',
      { message: 'Non-existent route visited.', severity: 1 },
    ]]);
    assert.equal(res.statusCode, 404);
    assert.equal(res.view, '404');
  });

  test('reporting failure does not change 404 response behavior', () => {
    const handler = createNotFoundHandler({
      reportEvent() {
        throw new Error('simulated reporter failure');
      },
    });
    const res = createResponse();

    assert.doesNotThrow(() => handler({ originalUrl: '/missing' }, res));
    assert.equal(res.statusCode, 404);
    assert.equal(res.view, '404');
  });
});
