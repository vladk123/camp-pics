import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  REQUIRED_RUNTIME_VARIABLES,
  RUNTIME_CONFIGURATION_MAX_LENGTHS,
  RuntimeConfigurationError,
  parseRuntimeConfig,
} from '../config/runtimeConfig.js';
import {
  MAX_URL_PATTERN_COUNT,
  MAX_URL_PATTERN_LENGTH,
  matchesLiteralUrlPattern,
} from '../utils/requestFiltering.js';

const REQUIRED_ENVIRONMENT = Object.freeze({
  DB_URL: 'mongodb://fixture-user:fixture-db-password@db.example.test/camps',
  SESSION_SECRET: 'fixture-session-secret-never-log',
  CC_DOMAIN: 'https://Example.Test/',
  CLOUDINARY_CLOUD_NAME: 'fixture-cloud',
  CLOUDINARY_KEY: 'fixture-cloudinary-key-never-log',
  CLOUDINARY_SECRET: 'fixture-cloudinary-secret-never-log',
  MAILGUN_API_KEY: 'fixture-mailgun-key-never-log',
  MAILGUN_DOMAIN: 'mail.example.test',
  MAILGUN_FROM: 'CampPics Test <no-reply@example.test>',
  ADMIN_EMAIL: 'admin@example.test',
});

function environment(overrides = {}) {
  return { ...REQUIRED_ENVIRONMENT, ...overrides };
}

function without(variable, overrides = {}) {
  const value = environment(overrides);
  delete value[variable];
  return value;
}

function configurationError(value) {
  try {
    parseRuntimeConfig(value);
  } catch (error) {
    assert.ok(error instanceof RuntimeConfigurationError);
    return error;
  }
  assert.fail('Expected runtime configuration parsing to fail.');
}

function assertVariableIssue(value, variable, reason) {
  const error = configurationError(value);
  assert.deepEqual(error.issues, [{ variable, reason }]);
  return error;
}

describe('valid runtime configuration', () => {
  test('returns the expected normalized nested shape without mutating its source', () => {
    const source = environment({
      NODE_ENV: ' production ',
      COOKIE_NAME: ' camp.sid ',
      PORT: ' 8080 ',
      IP: ' 127.0.0.1 ',
      FIVE_MIN_NUM_REQ_BEFORE_LIMIT: ' 250 ',
      ONE_MIN_NUM_REQ_BEFORE_SLOWDOWN: ' 75 ',
      BLOCK_BOT_URL: ' admin,,probe,admin ',
      IGNORE_URL: ' favicon.ico, scanner ',
    });
    const snapshot = structuredClone(source);

    const result = parseRuntimeConfig(source);

    assert.deepEqual(source, snapshot);
    assert.notStrictEqual(result, source);
    assert.deepEqual(result, {
      environment: {
        name: 'production',
        isDevelopment: false,
        isTest: false,
        isProduction: true,
      },
      database: { url: REQUIRED_ENVIRONMENT.DB_URL },
      session: {
        secret: REQUIRED_ENVIRONMENT.SESSION_SECRET,
        cookieName: 'camp.sid',
      },
      publicSite: { domain: 'https://example.test' },
      cloudinary: {
        cloudName: REQUIRED_ENVIRONMENT.CLOUDINARY_CLOUD_NAME,
        apiKey: REQUIRED_ENVIRONMENT.CLOUDINARY_KEY,
        apiSecret: REQUIRED_ENVIRONMENT.CLOUDINARY_SECRET,
      },
      mailgun: {
        apiKey: REQUIRED_ENVIRONMENT.MAILGUN_API_KEY,
        domain: REQUIRED_ENVIRONMENT.MAILGUN_DOMAIN,
        from: REQUIRED_ENVIRONMENT.MAILGUN_FROM,
        adminEmail: REQUIRED_ENVIRONMENT.ADMIN_EMAIL,
      },
      server: { port: 8080, host: '127.0.0.1' },
      requestLimits: {
        fiveMinuteMaximum: 250,
        oneMinuteDelayAfter: 75,
      },
      requestFiltering: {
        blockedPatterns: ['admin', 'probe'],
        ignoredNotFoundPatterns: ['favicon.ico', 'scanner'],
      },
    });
  });

  test('retains provider and session secrets required by application services', () => {
    const result = parseRuntimeConfig(environment());

    assert.equal(result.session.secret, REQUIRED_ENVIRONMENT.SESSION_SECRET);
    assert.equal(result.cloudinary.apiKey, REQUIRED_ENVIRONMENT.CLOUDINARY_KEY);
    assert.equal(
      result.cloudinary.apiSecret,
      REQUIRED_ENVIRONMENT.CLOUDINARY_SECRET,
    );
    assert.equal(result.mailgun.apiKey, REQUIRED_ENVIRONMENT.MAILGUN_API_KEY);
    assert.equal(Object.hasOwn(result, 'toJSON'), false);
  });
});

describe('required runtime variables', () => {
  test('each required variable is independently required', async t => {
    for (const variable of REQUIRED_RUNTIME_VARIABLES) {
      await t.test(variable, () => {
        assertVariableIssue(without(variable), variable, 'missing');
      });
    }
  });

  test('multiple issues are collected in deterministic parser order', () => {
    const source = environment();
    for (const variable of [
      'ADMIN_EMAIL',
      'DB_URL',
      'CLOUDINARY_SECRET',
      'MAILGUN_API_KEY',
    ]) {
      delete source[variable];
    }

    const error = configurationError(source);
    assert.deepEqual(error.issues, [
      { variable: 'DB_URL', reason: 'missing' },
      { variable: 'CLOUDINARY_SECRET', reason: 'missing' },
      { variable: 'MAILGUN_API_KEY', reason: 'missing' },
      { variable: 'ADMIN_EMAIL', reason: 'missing' },
    ]);
  });

  test('blank, wrong-type, oversized, and control-bearing strings are rejected', async t => {
    for (const variable of REQUIRED_RUNTIME_VARIABLES) {
      await t.test(`${variable} blank`, () => {
        assertVariableIssue(
          environment({ [variable]: ' \t ' }),
          variable,
          'missing',
        );
      });
      await t.test(`${variable} wrong type`, () => {
        assertVariableIssue(
          environment({ [variable]: 42 }),
          variable,
          'invalid-type',
        );
      });
      await t.test(`${variable} too long`, () => {
        assertVariableIssue(
          environment({
            [variable]: 'x'.repeat(
              RUNTIME_CONFIGURATION_MAX_LENGTHS[variable] + 1,
            ),
          }),
          variable,
          'too-long',
        );
      });
      await t.test(`${variable} control character`, () => {
        assertVariableIssue(
          environment({ [variable]: 'fixture\u0000value' }),
          variable,
          'invalid-format',
        );
      });
    }
  });

  test('errors and their serialized forms expose names and reasons but no values', () => {
    const source = environment({ PORT: 'fixture-invalid-port-secret' });
    delete source.DB_URL;
    delete source.CLOUDINARY_SECRET;

    const error = configurationError(source);
    const outputs = [
      error.message,
      JSON.stringify(error),
      JSON.stringify(error.issues),
    ];
    assert.equal(JSON.stringify(error), '{}');
    assert.match(error.message, /DB_URL \(missing\)/u);
    assert.match(error.message, /PORT \(invalid-format\)/u);

    for (const configuredValue of Object.values(source)) {
      for (const output of outputs) {
        assert.equal(output.includes(String(configuredValue)), false);
      }
    }
  });
});

describe('public-site domain validation', () => {
  test('accepts and normalizes HTTPS and local HTTP origins', () => {
    assert.equal(
      parseRuntimeConfig(environment({ CC_DOMAIN: 'https://Example.COM/' }))
        .publicSite.domain,
      'https://example.com',
    );
    assert.equal(
      parseRuntimeConfig(environment({
        CC_DOMAIN: ' http://localhost:3000/ ',
      })).publicSite.domain,
      'http://localhost:3000',
    );
  });

  test('rejects credentials, paths, queries, and fragments', async t => {
    const values = [
      'https://user:password@example.test',
      'https://example.test/application',
      'https://example.test?query=1',
      'https://example.test#fragment',
    ];
    for (const value of values) {
      await t.test(value.split(':', 1)[0], () => {
        assertVariableIssue(
          environment({ CC_DOMAIN: value }),
          'CC_DOMAIN',
          'invalid-format',
        );
      });
    }
  });

  test('rejects unsupported and malformed schemes without echoing the value', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/plain,hello',
      'file:///tmp/camppics',
    ]) {
      const error = assertVariableIssue(
        environment({ CC_DOMAIN: value }),
        'CC_DOMAIN',
        'unsupported-value',
      );
      assert.equal(error.message.includes(value), false);
    }

    const malformed = 'not a valid absolute URL';
    const error = assertVariableIssue(
      environment({ CC_DOMAIN: malformed }),
      'CC_DOMAIN',
      'invalid-format',
    );
    assert.equal(error.message.includes(malformed), false);
  });
});

describe('strict numeric runtime variables', () => {
  const specifications = [
    {
      variable: 'PORT',
      path: config => config.server.port,
      defaultValue: 3_000,
      minimum: 1,
      maximum: 65_535,
      zeroAllowed: false,
    },
    {
      variable: 'FIVE_MIN_NUM_REQ_BEFORE_LIMIT',
      path: config => config.requestLimits.fiveMinuteMaximum,
      defaultValue: 100,
      minimum: 1,
      maximum: 1_000_000,
      zeroAllowed: false,
    },
    {
      variable: 'ONE_MIN_NUM_REQ_BEFORE_SLOWDOWN',
      path: config => config.requestLimits.oneMinuteDelayAfter,
      defaultValue: 50,
      minimum: 0,
      maximum: 1_000_000,
      zeroAllowed: true,
    },
  ];

  for (const specification of specifications) {
    describe(specification.variable, () => {
      test('uses its default when missing or blank', () => {
        assert.equal(
          specification.path(parseRuntimeConfig(environment())),
          specification.defaultValue,
        );
        assert.equal(
          specification.path(parseRuntimeConfig(environment({
            [specification.variable]: '   ',
          }))),
          specification.defaultValue,
        );
      });

      test('accepts lower and upper bounds as numbers', () => {
        for (const value of [specification.minimum, specification.maximum]) {
          const parsed = specification.path(parseRuntimeConfig(environment({
            [specification.variable]: `  ${value}  `,
          })));
          assert.equal(parsed, value);
          assert.equal(typeof parsed, 'number');
        }
      });

      test('handles zero according to its declared bound', () => {
        if (specification.zeroAllowed) {
          assert.equal(
            specification.path(parseRuntimeConfig(environment({
              [specification.variable]: '0',
            }))),
            0,
          );
        } else {
          assertVariableIssue(
            environment({ [specification.variable]: '0' }),
            specification.variable,
            'out-of-range',
          );
        }
      });

      test('rejects negative and excessive values as out of range', () => {
        for (const value of ['-1', String(specification.maximum + 1)]) {
          assertVariableIssue(
            environment({ [specification.variable]: value }),
            specification.variable,
            'out-of-range',
          );
        }
      });

      test('rejects fractions, exponentials, hexadecimal, and mixed text', () => {
        for (const value of ['1.5', '1e2', '0x10', '10requests']) {
          assertVariableIssue(
            environment({ [specification.variable]: value }),
            specification.variable,
            'invalid-format',
          );
        }
      });

      test('rejects non-string primitive input', () => {
        assertVariableIssue(
          environment({ [specification.variable]: 10 }),
          specification.variable,
          'invalid-type',
        );
      });
    });
  }
});

describe('environment mode', () => {
  test('missing and blank values default to development', () => {
    for (const value of [undefined, '   ']) {
      const source = environment();
      if (value !== undefined) source.NODE_ENV = value;
      const mode = parseRuntimeConfig(source).environment;
      assert.deepEqual(mode, {
        name: 'development',
        isDevelopment: true,
        isTest: false,
        isProduction: false,
      });
    }
  });

  test('accepts each exact supported mode with matching booleans', () => {
    for (const name of ['development', 'test', 'production']) {
      const mode = parseRuntimeConfig(environment({ NODE_ENV: name }))
        .environment;
      assert.equal(mode.name, name);
      assert.equal(mode.isDevelopment, name === 'development');
      assert.equal(mode.isTest, name === 'test');
      assert.equal(mode.isProduction, name === 'production');
    }
  });

  test('rejects unsupported values and does not reinterpret case', () => {
    for (const value of ['staging', 'Production', 'TEST']) {
      assertVariableIssue(
        environment({ NODE_ENV: value }),
        'NODE_ENV',
        'unsupported-value',
      );
    }
  });
});

describe('cookie name and listen host', () => {
  test('defaults missing and blank values and trims configured values', () => {
    const defaults = parseRuntimeConfig(environment());
    assert.equal(defaults.session.cookieName, 'connect.sid');
    assert.equal(defaults.server.host, undefined);

    const blanks = parseRuntimeConfig(environment({
      COOKIE_NAME: '  ',
      IP: '  ',
    }));
    assert.equal(blanks.session.cookieName, 'connect.sid');
    assert.equal(blanks.server.host, undefined);

    const configured = parseRuntimeConfig(environment({
      COOKIE_NAME: ' camp.sid ',
      IP: ' localhost ',
    }));
    assert.equal(configured.session.cookieName, 'camp.sid');
    assert.equal(configured.server.host, 'localhost');
  });

  test('accepts exact maximum lengths and rejects longer values', () => {
    for (const [variable, path] of [
      ['COOKIE_NAME', config => config.session.cookieName],
      ['IP', config => config.server.host],
    ]) {
      const exact = 'x'.repeat(RUNTIME_CONFIGURATION_MAX_LENGTHS[variable]);
      assert.equal(
        path(parseRuntimeConfig(environment({ [variable]: exact }))),
        exact,
      );
      assertVariableIssue(
        environment({ [variable]: `${exact}x` }),
        variable,
        'too-long',
      );
    }
  });

  test('rejects control characters and wrong primitive types', () => {
    for (const variable of ['COOKIE_NAME', 'IP']) {
      assertVariableIssue(
        environment({ [variable]: 'safe\nunsafe' }),
        variable,
        'invalid-format',
      );
      assertVariableIssue(
        environment({ [variable]: false }),
        variable,
        'invalid-type',
      );
    }
  });
});

describe('request-filtering configuration integration', () => {
  test('missing values produce separate empty arrays that cannot match everything', () => {
    const filtering = parseRuntimeConfig(environment()).requestFiltering;
    assert.deepEqual(filtering.blockedPatterns, []);
    assert.deepEqual(filtering.ignoredNotFoundPatterns, []);
    assert.notStrictEqual(
      filtering.blockedPatterns,
      filtering.ignoredNotFoundPatterns,
    );
    assert.equal(matchesLiteralUrlPattern('/anything', filtering.blockedPatterns), false);
  });

  test('preserves trimming, blank removal, and exact deduplication', () => {
    const filtering = parseRuntimeConfig(environment({
      BLOCK_BOT_URL: ' foo,, ,bar,foo,Foo ',
      IGNORE_URL: ' ,scanner,scanner, ',
    })).requestFiltering;
    assert.deepEqual(filtering.blockedPatterns, ['foo', 'bar', 'Foo']);
    assert.deepEqual(filtering.ignoredNotFoundPatterns, ['scanner']);
  });

  test('preserves the existing pattern count and entry-length bounds', () => {
    const exactLength = 'x'.repeat(MAX_URL_PATTERN_LENGTH);
    const oversized = `${exactLength}x`;
    const many = Array.from(
      { length: MAX_URL_PATTERN_COUNT + 2 },
      (_, index) => `pattern-${index}`,
    ).join(',');
    const filtering = parseRuntimeConfig(environment({
      BLOCK_BOT_URL: `${oversized},${exactLength}`,
      IGNORE_URL: many,
    })).requestFiltering;

    assert.deepEqual(filtering.blockedPatterns, [exactLength]);
    assert.equal(filtering.ignoredNotFoundPatterns.length, MAX_URL_PATTERN_COUNT);
    assert.equal(filtering.ignoredNotFoundPatterns.at(-1), 'pattern-199');
  });

  test('maps established parser type failures to a safe issue', () => {
    assertVariableIssue(
      environment({ BLOCK_BOT_URL: ['unsafe'] }),
      'BLOCK_BOT_URL',
      'invalid-type',
    );
  });
});

describe('deep runtime configuration immutability', () => {
  test('freezes every nested object and pattern array', () => {
    const config = parseRuntimeConfig(environment({
      BLOCK_BOT_URL: 'blocked',
      IGNORE_URL: 'ignored',
    }));

    for (const value of [
      config,
      config.environment,
      config.database,
      config.session,
      config.publicSite,
      config.cloudinary,
      config.mailgun,
      config.server,
      config.requestLimits,
      config.requestFiltering,
      config.requestFiltering.blockedPatterns,
      config.requestFiltering.ignoredNotFoundPatterns,
    ]) {
      assert.equal(Object.isFrozen(value), true);
    }

    assert.throws(() => {
      config.database.url = 'mongodb://mutated.example.test';
    }, TypeError);
    assert.throws(() => {
      config.requestFiltering.blockedPatterns.push('mutated');
    }, TypeError);
    assert.equal(config.database.url, REQUIRED_ENVIRONMENT.DB_URL);
    assert.deepEqual(config.requestFiltering.blockedPatterns, ['blocked']);
  });
});
