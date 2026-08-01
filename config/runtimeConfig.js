import { parseUrlPatterns } from '../utils/requestFiltering.js';

export const REQUIRED_RUNTIME_VARIABLES = Object.freeze([
  'DB_URL',
  'SESSION_SECRET',
  'CC_DOMAIN',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_KEY',
  'CLOUDINARY_SECRET',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
  'MAILGUN_FROM',
  'ADMIN_EMAIL',
]);

export const RUNTIME_CONFIGURATION_REASONS = Object.freeze([
  'missing',
  'invalid-type',
  'invalid-format',
  'out-of-range',
  'too-long',
  'unsupported-value',
]);

export const RUNTIME_CONFIGURATION_MAX_LENGTHS = Object.freeze({
  DB_URL: 4_096,
  SESSION_SECRET: 4_096,
  CC_DOMAIN: 2_048,
  CLOUDINARY_CLOUD_NAME: 255,
  CLOUDINARY_KEY: 512,
  CLOUDINARY_SECRET: 4_096,
  MAILGUN_API_KEY: 4_096,
  MAILGUN_DOMAIN: 253,
  MAILGUN_FROM: 512,
  ADMIN_EMAIL: 320,
  NODE_ENV: 32,
  COOKIE_NAME: 256,
  IP: 253,
});

const SUPPORTED_ENVIRONMENTS = new Set([
  'development',
  'test',
  'production',
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const DECIMAL_INTEGER = /^[0-9]+$/u;
const NEGATIVE_DECIMAL_INTEGER = /^-[0-9]+$/u;
const CONFIGURATION_VARIABLES = new Set([
  ...REQUIRED_RUNTIME_VARIABLES,
  'NODE_ENV',
  'COOKIE_NAME',
  'PORT',
  'IP',
  'FIVE_MIN_NUM_REQ_BEFORE_LIMIT',
  'ONE_MIN_NUM_REQ_BEFORE_SLOWDOWN',
  'BLOCK_BOT_URL',
  'IGNORE_URL',
]);
const CONFIGURATION_REASONS = new Set(RUNTIME_CONFIGURATION_REASONS);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }
  return Object.freeze(value);
}

function createIssue(variable, reason) {
  return Object.freeze({ variable, reason });
}

function addIssue(issues, variable, reason) {
  issues.push(createIssue(variable, reason));
  return undefined;
}

function readString(environment, issues, variable, {
  defaultValue,
  maximumLength,
  required = false,
} = {}) {
  const rawValue = environment[variable];

  if (rawValue === undefined) {
    return required
      ? addIssue(issues, variable, 'missing')
      : defaultValue;
  }
  if (typeof rawValue !== 'string') {
    return addIssue(issues, variable, 'invalid-type');
  }

  const value = rawValue.trim();
  if (value.length === 0) {
    return required
      ? addIssue(issues, variable, 'missing')
      : defaultValue;
  }
  if (value.length > maximumLength) {
    return addIssue(issues, variable, 'too-long');
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return addIssue(issues, variable, 'invalid-format');
  }

  return value;
}

function readRequiredString(environment, issues, variable) {
  return readString(environment, issues, variable, {
    maximumLength: RUNTIME_CONFIGURATION_MAX_LENGTHS[variable],
    required: true,
  });
}

function readEnvironmentName(environment, issues) {
  const name = readString(environment, issues, 'NODE_ENV', {
    defaultValue: 'development',
    maximumLength: RUNTIME_CONFIGURATION_MAX_LENGTHS.NODE_ENV,
  });
  if (name === undefined) return undefined;
  if (!SUPPORTED_ENVIRONMENTS.has(name)) {
    return addIssue(issues, 'NODE_ENV', 'unsupported-value');
  }
  return name;
}

function readInteger(environment, issues, variable, {
  defaultValue,
  minimum,
  maximum,
}) {
  const rawValue = environment[variable];
  if (rawValue === undefined) return defaultValue;
  if (typeof rawValue !== 'string') {
    return addIssue(issues, variable, 'invalid-type');
  }

  const value = rawValue.trim();
  if (value.length === 0) return defaultValue;
  if (NEGATIVE_DECIMAL_INTEGER.test(value)) {
    return addIssue(issues, variable, 'out-of-range');
  }
  if (!DECIMAL_INTEGER.test(value)) {
    return addIssue(issues, variable, 'invalid-format');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return addIssue(issues, variable, 'out-of-range');
  }
  return parsed;
}

function readPublicSiteDomain(environment, issues) {
  const value = readRequiredString(environment, issues, 'CC_DOMAIN');
  if (value === undefined) return undefined;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return addIssue(issues, 'CC_DOMAIN', 'invalid-format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return addIssue(issues, 'CC_DOMAIN', 'unsupported-value');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    return addIssue(issues, 'CC_DOMAIN', 'invalid-format');
  }

  return parsed.origin;
}

function readUrlPatterns(environment, issues, variable) {
  try {
    return parseUrlPatterns(environment[variable]);
  } catch (error) {
    if (error instanceof TypeError) {
      return addIssue(issues, variable, 'invalid-type');
    }
    throw error;
  }
}

function assertPlainEnvironment(environment) {
  if (
    environment === null ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new RuntimeConfigurationError([
      createIssue('ENVIRONMENT', 'invalid-type'),
    ]);
  }
}

export class RuntimeConfigurationError extends Error {
  constructor(issues) {
    const safeIssues = issues.map(issue => {
      const variable = CONFIGURATION_VARIABLES.has(issue?.variable) ||
        issue?.variable === 'ENVIRONMENT'
        ? issue.variable
        : 'ENVIRONMENT';
      const reason = CONFIGURATION_REASONS.has(issue?.reason)
        ? issue.reason
        : 'invalid-format';
      return createIssue(variable, reason);
    });
    const message = `Runtime configuration is invalid: ${safeIssues
      .map(issue => `${issue.variable} (${issue.reason})`)
      .join(', ')}.`;
    super(message);

    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'RuntimeConfigurationError',
    });
    Object.defineProperty(this, 'issues', {
      configurable: false,
      enumerable: false,
      value: Object.freeze(safeIssues),
      writable: false,
    });
    Object.freeze(this);
  }
}

/**
 * Parse injected application environment input without reading global state.
 */
export function parseRuntimeConfig(environment) {
  assertPlainEnvironment(environment);
  const issues = [];

  const databaseUrl = readRequiredString(environment, issues, 'DB_URL');
  const sessionSecret = readRequiredString(
    environment,
    issues,
    'SESSION_SECRET',
  );
  const publicSiteDomain = readPublicSiteDomain(environment, issues);
  const cloudName = readRequiredString(
    environment,
    issues,
    'CLOUDINARY_CLOUD_NAME',
  );
  const cloudinaryApiKey = readRequiredString(
    environment,
    issues,
    'CLOUDINARY_KEY',
  );
  const cloudinaryApiSecret = readRequiredString(
    environment,
    issues,
    'CLOUDINARY_SECRET',
  );
  const mailgunApiKey = readRequiredString(
    environment,
    issues,
    'MAILGUN_API_KEY',
  );
  const mailgunDomain = readRequiredString(
    environment,
    issues,
    'MAILGUN_DOMAIN',
  );
  const mailgunFrom = readRequiredString(environment, issues, 'MAILGUN_FROM');
  const adminEmail = readRequiredString(environment, issues, 'ADMIN_EMAIL');

  const environmentName = readEnvironmentName(environment, issues);
  const cookieName = readString(environment, issues, 'COOKIE_NAME', {
    defaultValue: 'connect.sid',
    maximumLength: RUNTIME_CONFIGURATION_MAX_LENGTHS.COOKIE_NAME,
  });
  const port = readInteger(environment, issues, 'PORT', {
    defaultValue: 3_000,
    minimum: 1,
    maximum: 65_535,
  });
  const host = readString(environment, issues, 'IP', {
    defaultValue: undefined,
    maximumLength: RUNTIME_CONFIGURATION_MAX_LENGTHS.IP,
  });
  const fiveMinuteMaximum = readInteger(
    environment,
    issues,
    'FIVE_MIN_NUM_REQ_BEFORE_LIMIT',
    {
      defaultValue: 100,
      minimum: 1,
      maximum: 1_000_000,
    },
  );
  const oneMinuteDelayAfter = readInteger(
    environment,
    issues,
    'ONE_MIN_NUM_REQ_BEFORE_SLOWDOWN',
    {
      defaultValue: 50,
      minimum: 0,
      maximum: 1_000_000,
    },
  );
  const blockedPatterns = readUrlPatterns(
    environment,
    issues,
    'BLOCK_BOT_URL',
  );
  const ignoredNotFoundPatterns = readUrlPatterns(
    environment,
    issues,
    'IGNORE_URL',
  );

  if (issues.length > 0) {
    throw new RuntimeConfigurationError(issues);
  }

  return deepFreeze({
    environment: {
      name: environmentName,
      isDevelopment: environmentName === 'development',
      isTest: environmentName === 'test',
      isProduction: environmentName === 'production',
    },
    database: {
      url: databaseUrl,
    },
    session: {
      secret: sessionSecret,
      cookieName,
    },
    publicSite: {
      domain: publicSiteDomain,
    },
    cloudinary: {
      cloudName,
      apiKey: cloudinaryApiKey,
      apiSecret: cloudinaryApiSecret,
    },
    mailgun: {
      apiKey: mailgunApiKey,
      domain: mailgunDomain,
      from: mailgunFrom,
      adminEmail,
    },
    server: {
      port,
      host,
    },
    requestLimits: {
      fiveMinuteMaximum,
      oneMinuteDelayAfter,
    },
    requestFiltering: {
      blockedPatterns,
      ignoredNotFoundPatterns,
    },
  });
}
