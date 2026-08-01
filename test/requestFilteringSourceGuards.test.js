import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const [
  appSource,
  getIpSource,
  parserSource,
  cacheSource,
  middlewareSource,
] = await Promise.all([
  readFile('app.js', 'utf8'),
  readFile('utils/getIP.js', 'utf8'),
  readFile('utils/requestFiltering.js', 'utf8'),
  readFile('utils/blockedClientCache.js', 'utf8'),
  readFile('utils/requestFilteringMiddleware.js', 'utf8'),
]);

describe('request-filtering production wiring guards', () => {
  test('both environment values use the startup parser without unsafe direct splitting', () => {
    assert.match(
      appSource,
      /parseUrlPatterns\(process\.env\.BLOCK_BOT_URL\)/,
    );
    assert.match(
      appSource,
      /parseUrlPatterns\(process\.env\.IGNORE_URL\)/,
    );
    assert.doesNotMatch(
      appSource,
      /process\.env\.BLOCK_BOT_URL\s*\.\s*split\s*\(/,
    );
    assert.doesNotMatch(
      appSource,
      /process\.env\.IGNORE_URL\s*\|\|\s*\[\]/,
    );
    assert.doesNotMatch(appSource, /for\s*\([^)]*of\s+ignoreURLAttempts/);
    assert.match(parserSource, /MAX_URL_PATTERN_COUNT = \d+/);
    assert.match(parserSource, /MAX_URL_PATTERN_LENGTH = \d+/);
  });

  test('the production blocker receives a cache with explicit duration and capacity', () => {
    assert.match(appSource, /new BlockedClientCache\s*\(\s*\{/);
    assert.match(
      appSource,
      /blockDurationMs:\s*DEFAULT_BOT_BLOCK_DURATION_MS/,
    );
    assert.match(
      appSource,
      /maxEntries:\s*DEFAULT_BOT_BLOCK_MAX_ENTRIES/,
    );
    assert.doesNotMatch(appSource, /const\s+badBotMap\s*=\s*new Map/);
    assert.match(cacheSource, /DEFAULT_BOT_BLOCK_MAX_ENTRIES = 5_000/);
    assert.match(cacheSource, /process-local block cache/);
  });

  test('canonical IP extraction is synchronous and reads req.ip only', () => {
    assert.match(getIpSource, /export function getIP\(req\)/);
    assert.doesNotMatch(getIpSource, /async\s+(?:function\s+)?getIP/);
    assert.match(getIpSource, /req\?\.ip/);
    assert.doesNotMatch(getIpSource, /req\??\.headers|req\[['"]headers['"]\]/);

    const prohibitedHeaders = [
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
      'x-client-ip',
      'x-cluster-client-ip',
    ];
    for (const header of prohibitedHeaders) {
      assert.equal(
        getIpSource.toLowerCase().includes(header),
        false,
        `getIP still references ${header}`,
      );
    }
  });

  test('request filtering uses fixed event messages and excludes raw request objects', () => {
    assert.match(middlewareSource, /Blocked request remains active\./);
    assert.match(middlewareSource, /Blocked bot-pattern request\./);
    assert.match(middlewareSource, /Non-existent route visited\./);
    assert.doesNotMatch(
      middlewareSource,
      /reportEvent\(\s*req\s*,|reportEvent\(\s*req\?\./,
    );
    assert.doesNotMatch(
      middlewareSource,
      /details\s*[:=][^\n]*(?:originalUrl|headers|body|session|user)/,
    );
  });

  test('global view locals no longer expose IP while required audit POSTs retain it', () => {
    const globalLocalsStart = appSource.indexOf(
      '// GET CURRENT USER DETAILS LOCALS MIDDLEWARE',
    );
    const globalLocalsEnd = appSource.indexOf(
      'app.use(csrfSynchronisedProtection)',
      globalLocalsStart,
    );
    assert.ok(globalLocalsStart >= 0 && globalLocalsEnd > globalLocalsStart);
    assert.doesNotMatch(
      appSource.slice(globalLocalsStart, globalLocalsEnd),
      /res\.locals\.ip/,
    );
    assert.match(
      appSource,
      /app\.use\(\['\/user\/register', '\/user\/login'\]/,
    );
    assert.match(
      appSource,
      /if \(req\.method === 'POST'\) res\.locals\.ip = getIP\(req\)/,
    );
  });

  test('new filtering modules introduce no database or external-store operations', () => {
    const combinedSource = [
      parserSource,
      cacheSource,
      middlewareSource,
      getIpSource,
    ].join('\n');

    assert.doesNotMatch(
      combinedSource,
      /mongoose|MongoStore|redis|findOne|findById|updateOne|deleteOne|\.save\s*\(/i,
    );
  });
});
