import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  RuntimeConfigurationError,
} from '../config/runtimeConfig.js';
import {
  INVALID_RUNTIME_CONFIGURATION_MESSAGE,
  createSafeRuntimeConfigurationFailure,
  startWithRuntimeConfig,
} from '../config/runtimeStartup.js';

const SECRET_FIXTURES = Object.freeze([
  'fixture-database-password-never-report',
  'fixture-session-secret-never-report',
  'fixture-provider-key-never-report',
]);

function invalidEnvironment() {
  return {
    SESSION_SECRET: SECRET_FIXTURES[1],
    CLOUDINARY_SECRET: SECRET_FIXTURES[2],
    DB_URL: `mongodb://user:${SECRET_FIXTURES[0]}@db.example.test/camps`,
  };
}

describe('startup runtime-configuration boundary', () => {
  test('invalid configuration prevents every application startup operation', async () => {
    const calls = {
      sessionStoreConstructions: 0,
      mongoConnections: 0,
      listeners: 0,
      reports: [],
      exits: [],
    };

    const result = await startWithRuntimeConfig({
      environment: invalidEnvironment(),
      start() {
        calls.sessionStoreConstructions += 1;
        calls.mongoConnections += 1;
        calls.listeners += 1;
      },
      async report(failure) {
        calls.reports.push(failure);
      },
      exit(code) {
        calls.exits.push(code);
      },
    });

    assert.equal(result, undefined);
    assert.equal(calls.sessionStoreConstructions, 0);
    assert.equal(calls.mongoConnections, 0);
    assert.equal(calls.listeners, 0);
    assert.deepEqual(calls.exits, [1]);
    assert.equal(calls.reports.length, 1);
    assert.equal(calls.reports[0].message, INVALID_RUNTIME_CONFIGURATION_MESSAGE);
    assert.equal(Object.isFrozen(calls.reports[0]), true);
    assert.equal(Object.isFrozen(calls.reports[0].issues), true);

    const reported = JSON.stringify(calls.reports);
    for (const secret of SECRET_FIXTURES) {
      assert.equal(reported.includes(secret), false);
    }
  });

  test('only fixed variable names and reasons reach the reporter', async () => {
    const captured = [];
    await startWithRuntimeConfig({
      environment: invalidEnvironment(),
      start() {
        assert.fail('invalid configuration must not start');
      },
      report(failure) {
        captured.push(structuredClone(failure));
      },
      exit() {},
    });

    assert.deepEqual(captured, [{
      message: INVALID_RUNTIME_CONFIGURATION_MESSAGE,
      issues: [
        { variable: 'CC_DOMAIN', reason: 'missing' },
        { variable: 'CLOUDINARY_CLOUD_NAME', reason: 'missing' },
        { variable: 'CLOUDINARY_KEY', reason: 'missing' },
        { variable: 'MAILGUN_API_KEY', reason: 'missing' },
        { variable: 'MAILGUN_DOMAIN', reason: 'missing' },
        { variable: 'MAILGUN_FROM', reason: 'missing' },
        { variable: 'ADMIN_EMAIL', reason: 'missing' },
      ],
    }]);
  });

  test('logger failure uses safe fallback output and still exits nonzero', async () => {
    const output = [];
    const exits = [];
    const result = await startWithRuntimeConfig({
      environment: invalidEnvironment(),
      start() {
        assert.fail('invalid configuration must not start');
      },
      report() {
        throw new Error(`logger failed with ${SECRET_FIXTURES[1]}`);
      },
      fallbackOutput(message) {
        output.push(message);
      },
      exit(code) {
        exits.push(code);
      },
    });

    assert.equal(result, undefined);
    assert.deepEqual(exits, [1]);
    assert.equal(output[0], INVALID_RUNTIME_CONFIGURATION_MESSAGE);
    assert.ok(output.some(line => line.includes('CC_DOMAIN (missing)')));
    for (const secret of SECRET_FIXTURES) {
      assert.equal(output.join('\n').includes(secret), false);
    }
  });

  test('fallback logger failure cannot permit startup or suppress nonzero exit', async () => {
    let starts = 0;
    const exits = [];
    await startWithRuntimeConfig({
      environment: invalidEnvironment(),
      start() {
        starts += 1;
      },
      report() {
        throw new Error('logger unavailable');
      },
      fallbackOutput() {
        throw new Error('fallback unavailable');
      },
      exit(code) {
        exits.push(code);
      },
    });

    assert.equal(starts, 0);
    assert.deepEqual(exits, [1]);
  });

  test('unexpected parser failures are reduced to the fixed safe contract', async () => {
    const parserSecret = 'fixture-unexpected-parser-secret';
    const reports = [];
    await startWithRuntimeConfig({
      environment: {},
      parse() {
        throw new Error(parserSecret);
      },
      start() {
        assert.fail('failed parsing must not start');
      },
      report(failure) {
        reports.push(failure);
      },
      exit() {},
    });

    assert.deepEqual(reports, [{
      message: INVALID_RUNTIME_CONFIGURATION_MESSAGE,
      issues: [],
    }]);
    assert.equal(JSON.stringify(reports).includes(parserSecret), false);
  });

  test('valid parsing passes the immutable config to startup without reporting', async () => {
    const runtimeConfig = Object.freeze({ marker: 'typed-runtime-config' });
    const starts = [];
    const result = await startWithRuntimeConfig({
      environment: Object.freeze({ injected: true }),
      parse(source) {
        assert.deepEqual(source, { injected: true });
        return runtimeConfig;
      },
      start(config) {
        starts.push(config);
        return 'started';
      },
      report() {
        assert.fail('valid configuration must not be reported');
      },
      exit() {
        assert.fail('valid configuration must not exit');
      },
    });

    assert.equal(result, 'started');
    assert.deepEqual(starts, [runtimeConfig]);
  });

  test('safe failure serialization never includes the Error or runtime values', () => {
    const error = new RuntimeConfigurationError([
      { variable: 'SESSION_SECRET', reason: 'missing' },
    ]);
    const failure = createSafeRuntimeConfigurationFailure(error);
    const serialized = JSON.stringify(failure);

    assert.deepEqual(failure, {
      message: INVALID_RUNTIME_CONFIGURATION_MESSAGE,
      issues: [{ variable: 'SESSION_SECRET', reason: 'missing' }],
    });
    assert.equal(serialized.includes('stack'), false);
    assert.equal(serialized.includes('error'), false);
    for (const secret of SECRET_FIXTURES) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});
