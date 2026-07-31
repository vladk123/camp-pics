import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LOGGER_FAILURE_MESSAGE,
  MAX_REQUEST_PATH_LENGTH,
  buildLogEntry,
  buildSafeRequestPath,
  createLogger,
  serializeError,
} from '../utils/logging.js';

const SAFE_USER_ID = '64b7f2d4c9f1e8a123456789';

function assertValuesAbsent(serialized, values) {
  for (const value of values) {
    assert.equal(
      serialized.includes(value),
      false,
      `log output exposed fixture value: ${value}`,
    );
  }
}

function assertNoControlCharacters(value) {
  assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/);
}

describe('operational log entry allowlist', () => {
  test('minimizes authenticated users and request context', () => {
    let toObjectCalls = 0;
    const user = {
      _id: { toHexString: () => SAFE_USER_ID },
      username: 'fixture-user@example.test',
      email: 'fixture-secondary-email@example.test',
      hash: 'fixture-user-hash-value',
      salt: 'fixture-user-salt-value',
      attempts: 17,
      last: 'fixture-authentication-attempt-time',
      auth_version: 42,
      other_login: {
        reset_password_code: 'fixture-reset-password-code',
        reset_password_expiry: 'fixture-reset-password-expiry',
        previous_logins: ['fixture-previous-login-ip'],
      },
      verification: {
        token: 'fixture-verification-token-state',
      },
      token_counter: 12,
      ip_address_registered: 'fixture-registration-ip',
      uploads: ['fixture-upload-history'],
      isAdmin: true,
      trusted: true,
      futureSensitiveField: 'fixture-future-user-secret',
      toObject() {
        toObjectCalls += 1;
        return this;
      },
    };
    const req = {
      method: 'post',
      baseUrl: '/user',
      route: { path: '/account' },
      originalUrl: '/user/account?token=fixture-query-token',
      user,
      session: {
        id: 'fixture-session-id',
        csrf: 'fixture-session-csrf',
        flash: 'fixture-flash-value',
      },
      headers: {
        authorization: 'Bearer fixture-authorization-token',
        cookie: 'fixture-cookie-value',
      },
      cookies: { login: 'fixture-cookie-login' },
      body: { password: 'fixture-body-password' },
      query: { token: 'fixture-query-object-token' },
      params: { code: 'fixture-route-param-code' },
      file: { buffer: 'fixture-upload-buffer' },
    };
    const details = {
      message: 'Account request failed.',
      severity: 2,
      futureDetails: 'fixture-future-log-detail',
      request: req,
    };

    const entry = buildLogEntry(req, 'ERROR', details);

    assert.deepEqual(entry, {
      type: 'error',
      message: 'Account request failed.',
      severity: 2,
      authenticatedUserId: SAFE_USER_ID,
      request: {
        method: 'POST',
        path: '/user/account',
      },
    });
    assert.equal(toObjectCalls, 0);
    assertValuesAbsent(JSON.stringify(entry), [
      'fixture-user@example.test',
      'fixture-secondary-email@example.test',
      'fixture-user-hash-value',
      'fixture-user-salt-value',
      'fixture-authentication-attempt-time',
      'fixture-reset-password-code',
      'fixture-reset-password-expiry',
      'fixture-previous-login-ip',
      'fixture-verification-token-state',
      'fixture-registration-ip',
      'fixture-upload-history',
      'fixture-future-user-secret',
      'fixture-query-token',
      'fixture-session-id',
      'fixture-session-csrf',
      'fixture-flash-value',
      'fixture-authorization-token',
      'fixture-cookie-value',
      'fixture-cookie-login',
      'fixture-body-password',
      'fixture-query-object-token',
      'fixture-route-param-code',
      'fixture-upload-buffer',
      'fixture-future-log-detail',
    ]);
  });

  test('omits invalid details and normalizes unsupported types safely', () => {
    assert.deepEqual(
      buildLogEntry(null, 'not-a-supported-type', {
        message: { secret: 'fixture-object-message-secret' },
        severity: '3',
        arbitrary: 'fixture-arbitrary-detail',
      }),
      { type: 'unknown' },
    );

    assert.deepEqual(
      buildLogEntry(null, 'success', { message: 'Done.', severity: 3 }),
      { type: 'success', message: 'Done.', severity: 3 },
    );
  });
});

describe('safe request paths', () => {
  test('uses matched authentication route templates instead of actual secrets', () => {
    const verificationCode = 'fixture-matched-verification-code';
    const resetUserId = 'fixture-matched-reset-user-id';
    const resetCode = 'fixture-matched-reset-code';

    const verificationPath = buildSafeRequestPath({
      baseUrl: '/user',
      route: { path: '/verify/:code' },
      originalUrl: `/user/verify/${verificationCode}`,
    });
    const resetPath = buildSafeRequestPath({
      baseUrl: '/user',
      route: { path: '/forgot-password/:userId/:code' },
      originalUrl: `/user/forgot-password/${resetUserId}/${resetCode}`,
    });

    assert.equal(verificationPath, '/user/verify/:code');
    assert.equal(resetPath, '/user/forgot-password/:userId/:code');
    assertValuesAbsent(`${verificationPath} ${resetPath}`, [
      verificationCode,
      resetUserId,
      resetCode,
    ]);
  });

  test('redacts unmatched verification and reset URLs', () => {
    const verificationCode = 'fixture-unmatched-verification-code';
    const resetUserId = 'fixture-unmatched-reset-user-id';
    const resetCode = 'fixture-unmatched-reset-code';

    const verificationPath = buildSafeRequestPath({
      originalUrl: `/user/verify/${verificationCode}`,
    });
    const resetPath = buildSafeRequestPath({
      originalUrl:
        `https://camppics.example/user/forgot-password/${resetUserId}/${resetCode}`,
    });
    const malformedAbsolutePath = buildSafeRequestPath({
      originalUrl:
        `https://[invalid-host]/user/verify/${verificationCode}`,
    });

    assert.equal(verificationPath, '/user/verify/:code');
    assert.equal(resetPath, '/user/forgot-password/:userId/:code');
    assert.equal(malformedAbsolutePath, '/user/verify/:code');
    assert.equal(resetPath.includes('camppics.example'), false);
    assertValuesAbsent(`${verificationPath} ${resetPath} ${malformedAbsolutePath}`, [
      verificationCode,
      resetUserId,
      resetCode,
    ]);
  });

  test('removes query strings and control characters and bounds paths', () => {
    const queryToken = 'fixture-query-string-secret';
    const controlledPath = buildSafeRequestPath({
      originalUrl: `/parks/list\r\nforged-entry?token=${queryToken}`,
    });
    const longPath = buildSafeRequestPath({
      originalUrl: `/${'a'.repeat(MAX_REQUEST_PATH_LENGTH * 4)}`,
    });

    assert.equal(controlledPath, '/parks/listforged-entry');
    assert.equal(controlledPath.includes(queryToken), false);
    assert.equal(/[\r\n]/.test(controlledPath), false);
    assert.ok(longPath.length <= MAX_REQUEST_PATH_LENGTH);
  });

  test('redacts authentication request paths divided by control characters', () => {
    const verificationCode = 'fixture-controlled-request-verification-code';
    const resetUserId = 'fixture-controlled-request-reset-user-id';
    const resetCode = 'fixture-controlled-request-reset-code';
    const querySecret = 'fixture-controlled-request-query-secret';
    const verificationPath = buildSafeRequestPath({
      originalUrl:
        `/user/verify/\r\n${verificationCode}?token=${querySecret}`,
    });
    const resetPath = buildSafeRequestPath({
      originalUrl:
        `/user/forgot-password/${resetUserId}\u000b/\t${resetCode}?token=${querySecret}`,
    });

    assert.equal(verificationPath, '/user/verify/:code');
    assert.equal(resetPath, '/user/forgot-password/:userId/:code');
    assertNoControlCharacters(verificationPath);
    assertNoControlCharacters(resetPath);
    assertValuesAbsent(`${verificationPath} ${resetPath}`, [
      verificationCode,
      resetUserId,
      resetCode,
      querySecret,
    ]);
  });

  test('does not treat a catch-all route as more useful than the pathname', () => {
    assert.equal(
      buildSafeRequestPath({
        route: { path: '/{*any}' },
        originalUrl: '/missing/page?source=fixture-query-value',
      }),
      '/missing/page',
    );
  });
});

describe('error serialization', () => {
  test('redacts authentication URLs divided by control characters', () => {
    const topResetUserId = 'fixture-controlled-top-reset-user-id';
    const topResetCode = 'fixture-controlled-top-reset-code';
    const verificationCode = 'fixture-controlled-error-verification-code';
    const resetUserId = 'fixture-controlled-stack-reset-user-id';
    const resetCode = 'fixture-controlled-stack-reset-code';
    const causeVerificationCode =
      'fixture-controlled-cause-verification-code';
    const querySecret = 'fixture-controlled-auth-query-secret';
    const cause = new Error(
      `Cause /user/verify/\u0000${causeVerificationCode}?token=${querySecret}`,
    );
    const error = new Error(
      `/user/verify/\r\n${verificationCode}?token=${querySecret}`,
      { cause },
    );
    error.stack =
      `Error at /user/forgot-password/${resetUserId}\r\n/\t` +
      `${resetCode}?token=${querySecret}`;

    const entry = buildLogEntry(null, 'error', {
      message:
        `Top /user/forgot-password/${topResetUserId}\u0008/\u000b` +
        `${topResetCode}?token=${querySecret}`,
      error,
    });

    assert.match(
      entry.message,
      /\/user\/forgot-password\/:userId\/:code/,
    );
    assert.match(entry.error.message, /\/user\/verify\/:code/);
    assert.match(
      entry.error.stack,
      /\/user\/forgot-password\/:userId\/:code/,
    );
    assert.match(entry.error.cause.message, /\/user\/verify\/:code/);
    for (const value of [
      entry.message,
      entry.error.message,
      entry.error.stack,
      entry.error.cause.message,
      entry.error.cause.stack,
    ]) {
      assertNoControlCharacters(value);
    }

    assertValuesAbsent(JSON.stringify(entry), [
      topResetUserId,
      topResetCode,
      verificationCode,
      resetUserId,
      resetCode,
      causeVerificationCode,
      querySecret,
    ]);
  });

  test('copies only explicit Error fields and redacts sensitive text', () => {
    const resetUserId = 'fixture-error-reset-user-id';
    const resetCode = 'fixture-error-reset-code';
    const querySecretSuffix = 'fixture-error-query-secret-suffix';
    const querySecret = `fixture-error-query-secret(${querySecretSuffix})`;
    const passwordSuffix = 'fixture-error-password-suffix';
    const password = `fixture-error-password(${passwordSuffix})`;
    const stackToken = 'fixture-error-stack-token';
    const causeCode = 'fixture-error-cause-code';
    const causeSalt = 'fixture-error-cause-salt';
    const providerSecrets = [
      'fixture-provider-request',
      'fixture-provider-response',
      'fixture-provider-config',
      'fixture-provider-header',
      'fixture-provider-body',
      'fixture-provider-data',
      'fixture-provider-user-hash',
      'fixture-provider-api-key',
    ];
    const cause = new Error(
      `Cause at /user/verify/${causeCode}?token=${querySecret} salt=${causeSalt}`,
    );
    cause.stack =
      `Error: /user/verify/${causeCode}?token=${querySecret} salt=${causeSalt}`;
    const error = new Error(
      `Provider failed at https://example.test/user/forgot-password/${resetUserId}/${resetCode}?token=${querySecret} password=${password}`,
      { cause },
    );
    error.name = 'ProviderError';
    error.code = 'E_PROVIDER';
    error.stack =
      `ProviderError: token=${stackToken}\n` +
      `at https://example.test/user/forgot-password/${resetUserId}/${resetCode}?token=${querySecret}`;
    error.request = { marker: providerSecrets[0] };
    error.response = { marker: providerSecrets[1] };
    error.config = { marker: providerSecrets[2] };
    error.headers = { authorization: providerSecrets[3] };
    error.body = providerSecrets[4];
    error.data = { renderedHtml: providerSecrets[5] };
    error.user = { hash: providerSecrets[6] };
    error.password = password;
    error.token = stackToken;
    error.hash = providerSecrets[6];
    error.salt = causeSalt;
    error.apiKey = providerSecrets[7];

    const serialized = serializeError(error);

    assert.deepEqual(Object.keys(serialized), [
      'name',
      'message',
      'code',
      'stack',
      'cause',
    ]);
    assert.deepEqual(Object.keys(serialized.cause), [
      'name',
      'message',
      'stack',
    ]);
    assert.equal(serialized.name, 'ProviderError');
    assert.equal(serialized.code, 'E_PROVIDER');
    assert.match(serialized.message, /\/user\/forgot-password\/:userId\/:code/);
    assert.match(serialized.stack, /\[REDACTED\]/);
    assert.match(serialized.cause.message, /\/user\/verify\/:code/);

    const output = JSON.stringify(serialized);
    assertValuesAbsent(output, [
      resetUserId,
      resetCode,
      querySecret,
      querySecretSuffix,
      password,
      passwordSuffix,
      stackToken,
      causeCode,
      causeSalt,
      ...providerSecrets,
    ]);
    for (const key of [
      'request',
      'response',
      'config',
      'headers',
      'body',
      'data',
      'user',
      'password',
      'token',
      'hash',
      'salt',
      'apiKey',
    ]) {
      assert.equal(key in serialized, false);
    }
  });

  test('does not inspect or dump non-Error thrown objects', () => {
    let conversionCalls = 0;
    const thrown = {
      message: 'fixture-non-error-message-secret',
      token: 'fixture-non-error-token-secret',
      toString() {
        conversionCalls += 1;
        return 'fixture-non-error-conversion-secret';
      },
      toJSON() {
        conversionCalls += 1;
        return 'fixture-non-error-json-secret';
      },
    };

    assert.deepEqual(serializeError(thrown), {
      name: 'NonErrorThrown',
      message: 'A non-Error object value was thrown.',
    });
    assert.equal(conversionCalls, 0);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.deepEqual(serializeError(revoked.proxy), {
      name: 'NonErrorThrown',
      message: 'A non-Error object value was thrown.',
    });
  });
});

describe('logger immutability and output behavior', () => {
  test('does not mutate details, Error objects, Users, or inspect the Response', async () => {
    const error = new Error('fixture-immutability-error');
    error.code = 'E_IMMUTABLE';
    error.request = { marker: 'fixture-immutable-request' };
    const user = {
      _id: SAFE_USER_ID,
      hash: 'fixture-immutable-user-hash',
      nested: { marker: 'fixture-immutable-user-nested' },
    };
    const details = {
      message: 'Immutability check.',
      error,
      nested: { marker: 'fixture-immutable-details-nested' },
    };
    const originalDetailKeys = Reflect.ownKeys(details);
    const originalErrorKeys = Reflect.ownKeys(error);
    const originalUser = JSON.stringify(user);
    const outputs = [];
    const log = createLogger({
      errorOutput: (...args) => outputs.push(args),
      normalOutput: (...args) => outputs.push(args),
      fallbackOutput: (...args) => outputs.push(args),
    });
    const response = new Proxy({}, {
      get() {
        throw new Error('Response must not be inspected.');
      },
    });

    await log({ method: 'GET', path: '/safe', user }, response, 'error', details);

    assert.deepEqual(Reflect.ownKeys(details), originalDetailKeys);
    assert.deepEqual(Reflect.ownKeys(error), originalErrorKeys);
    assert.equal(details.error, error);
    assert.equal(details.user, undefined);
    assert.deepEqual(details.nested, {
      marker: 'fixture-immutable-details-nested',
    });
    assert.equal(error.request.marker, 'fixture-immutable-request');
    assert.equal(JSON.stringify(user), originalUser);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].length, 1);
  });

  test('routes errors to error output and all other types to normal output', async () => {
    const calls = [];
    const log = createLogger({
      normalOutput: (...args) => calls.push({ channel: 'normal', args }),
      errorOutput: (...args) => calls.push({ channel: 'error', args }),
      fallbackOutput: (...args) => calls.push({ channel: 'fallback', args }),
    });
    const rawError = new Error('Safe diagnostic');
    rawError.request = { secret: 'fixture-output-provider-request' };

    await log(null, null, 'error', {
      message: 'Error event.',
      error: rawError,
      arbitrary: 'fixture-output-arbitrary-detail',
    });
    await log(null, null, 'general', { message: 'General event.' });
    await log(null, null, 'success', { message: 'Success event.' });
    await log(null, null, 'unknown', { message: 'Unknown event.' });
    await log(null, null, 'invalid', { message: 'Invalid event.' });

    assert.deepEqual(calls.map(call => call.channel), [
      'error',
      'normal',
      'normal',
      'normal',
      'normal',
    ]);
    assert.ok(calls.every(call => call.args.length === 1));
    assert.equal(calls[0].args[0].error instanceof Error, false);
    assert.deepEqual(calls.map(call => call.args[0].type), [
      'error',
      'general',
      'success',
      'unknown',
      'unknown',
    ]);
    assertValuesAbsent(JSON.stringify(calls), [
      'fixture-output-provider-request',
      'fixture-output-arbitrary-detail',
    ]);
  });

  test('sink failures resolve and emit only the fixed fallback payload', async () => {
    const attemptedOutputs = [];
    const fallbackOutputs = [];
    const originalSecret = 'fixture-sink-original-payload-secret';
    const sinkFailureSecret = 'fixture-sink-internal-failure-secret';
    const log = createLogger({
      errorOutput: (...args) => {
        attemptedOutputs.push(args);
        throw new Error(`sink failed password=${sinkFailureSecret}`);
      },
      fallbackOutput: (...args) => fallbackOutputs.push(args),
    });

    await assert.doesNotReject(() => log(null, null, 'error', {
      message: 'Sink failure event.',
      arbitrary: originalSecret,
      error: Object.assign(new Error('Allowed error message.'), {
        body: originalSecret,
      }),
    }));

    assert.equal(attemptedOutputs.length, 1);
    assert.equal(attemptedOutputs[0].length, 1);
    assert.deepEqual(fallbackOutputs, [[LOGGER_FAILURE_MESSAGE]]);
    assertValuesAbsent(JSON.stringify(attemptedOutputs), [originalSecret]);
    assertValuesAbsent(JSON.stringify(fallbackOutputs), [
      originalSecret,
      sinkFailureSecret,
    ]);
  });

  test('a failing fallback output still cannot reject application work', async () => {
    const log = createLogger({
      normalOutput: () => {
        throw new Error('primary output failure');
      },
      fallbackOutput: () => {
        throw new Error('fallback output failure');
      },
    });

    await assert.doesNotReject(() =>
      log(null, null, 'general', { message: 'Still resolves.' }));
  });
});
