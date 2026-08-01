import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const [appSource, parserSource, startupSource] = await Promise.all([
  readFile('app.js', 'utf8'),
  readFile('config/runtimeConfig.js', 'utf8'),
  readFile('config/runtimeStartup.js', 'utf8'),
]);

describe('runtime configuration production wiring guards', () => {
  test('dotenv is the first import and the old conditional loader is absent', () => {
    assert.ok(appSource.startsWith("import 'dotenv/config';"));
    assert.doesNotMatch(appSource, /await import\(['"]dotenv\/config['"]\)/u);
    assert.doesNotMatch(appSource, /dotenv loaded in development mode|Dev mode!/u);
  });

  test('app.js makes one global-environment handoff and no individual reads', () => {
    const environmentReads = appSource.match(/process\.env/gu) ?? [];
    assert.equal(environmentReads.length, 1);
    assert.match(
      appSource,
      /startWithRuntimeConfig\(\{[\s\S]*environment:\s*process\.env,[\s\S]*start:\s*startApplication/u,
    );
    assert.equal((startupSource.match(/parse\(environment\)/gu) ?? []).length, 1);
    assert.doesNotMatch(parserSource, /process\.env/u);
  });

  test('typed numeric values and pre-parsed request patterns reach consumers', () => {
    assert.match(
      appSource,
      /max:\s*runtimeConfig\.requestLimits\.fiveMinuteMaximum/u,
    );
    assert.match(
      appSource,
      /delayAfter:\s*runtimeConfig\.requestLimits\.oneMinuteDelayAfter/u,
    );
    assert.match(
      appSource,
      /blockedPatterns = runtimeConfig\.requestFiltering\.blockedPatterns/u,
    );
    assert.match(
      appSource,
      /ignoreURLAttempts = runtimeConfig\.requestFiltering\.ignoredNotFoundPatterns/u,
    );
    assert.doesNotMatch(
      appSource,
      /(?:max|delayAfter):\s*process\.env/u,
    );
  });

  test('database, session, CSP, metadata, and listener use the typed shape', () => {
    const expectedReads = [
      'runtimeConfig.database.url',
      'runtimeConfig.session.secret',
      'runtimeConfig.session.cookieName',
      'runtimeConfig.cloudinary.cloudName',
      'runtimeConfig.publicSite.domain',
      'runtimeConfig.server.port',
      'runtimeConfig.server.host',
    ];
    for (const read of expectedReads) assert.ok(appSource.includes(read), read);

    assert.match(appSource, /await mongoose\.connect\(dbUrl\)/u);
    assert.match(appSource, /const store = MongoStore\.create\(\{/u);
    assert.match(
      appSource,
      /app\.listen\(port, runtimeConfig\.server\.host/u,
    );
  });

  test('configuration is not attached to request, response locals, or sessions', () => {
    assert.doesNotMatch(
      appSource,
      /(?:req(?:uest)?|res\.locals|req\.session|sessionConfig)\s*(?:\.|\[)[^\n=]*runtimeConfig\s*=/u,
    );
    assert.doesNotMatch(
      appSource,
      /(?:res\.locals|req|req\.session)\.runtimeConfig/u,
    );
  });

  test('trust proxy, HTTPS redirect, and CSP policy guards remain present', () => {
    assert.match(appSource, /app\.set\('trust proxy', 1\)/u);
    assert.match(appSource, /runtimeConfig\.environment\.isProduction/u);
    assert.match(
      appSource,
      /req\.headers\['x-forwarded-proto'\]\?\.split\(','\)\[0\] !== 'https'/u,
    );
    assert.match(appSource, /contentSecurityPolicy:\s*\{/u);
    assert.match(appSource, /upgradeInsecureRequests:\s*\[\]/u);
    assert.match(appSource, /frameAncestors:\s*\["'self'"\]/u);
  });

  test('invalid parsing is caught before the startup callback can run', () => {
    const parsePosition = startupSource.indexOf('runtimeConfig = parse(environment)');
    const startPosition = startupSource.indexOf('return start(runtimeConfig)');
    const exitPosition = startupSource.indexOf('await exit(1)');
    assert.ok(parsePosition >= 0);
    assert.ok(exitPosition > parsePosition);
    assert.ok(startPosition > exitPosition);
    assert.match(startupSource, /catch \(error\)/u);
  });
});
