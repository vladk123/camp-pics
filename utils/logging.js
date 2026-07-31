const SUPPORTED_TYPES = new Set(['error', 'success', 'general', 'unknown']);
const MIN_SEVERITY = 1;
const MAX_SEVERITY = 3;

export const MAX_LOG_MESSAGE_LENGTH = 1024;
export const MAX_ERROR_STACK_LENGTH = 8192;
export const MAX_REQUEST_PATH_LENGTH = 512;
export const LOGGER_FAILURE_MESSAGE = 'Operational logger failed.';

const MAX_ERROR_CAUSE_DEPTH = 2;
const MAX_ERROR_NAME_LENGTH = 128;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_USER_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 20;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const AUTHENTICATION_PATHS = [
  {
    pattern: /(\/user\/forgot-password\/)[^/?#\s"'<>\]\[}{),;]+\/[^/?#\s"'<>\]\[}{),;]+/gi,
    replacement: '$1:userId/:code',
  },
  {
    pattern: /(\/user\/verify\/)[^/?#\s"'<>\]\[}{),;]+/gi,
    replacement: '$1:code',
  },
];
const CREDENTIAL_ASSIGNMENT = /(["']?)(authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|secret|token|hash|salt|csrf(?:[_-]?token)?|session(?:[_-]?id)?)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_STRING = /\?[^\s"'<>]*/g;

function readProperty(value, property) {
  try {
    return value?.[property];
  } catch {
    return undefined;
  }
}

function truncate(value, maximumLength) {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 1)}…`;
}

export function redactSensitiveText(value) {
  let redacted = value;

  for (const { pattern, replacement } of AUTHENTICATION_PATHS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted
    .replace(QUERY_STRING, '?[REDACTED_QUERY]')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, '$2=[REDACTED]');
}

function sanitizeString(value, maximumLength) {
  if (typeof value !== 'string') return undefined;

  const boundedInput = value.slice(0, maximumLength * 4);
  const normalized = boundedInput.replace(CONTROL_CHARACTERS, '');
  return truncate(redactSensitiveText(normalized), maximumLength);
}

export function normalizeLogType(type) {
  if (typeof type !== 'string') return 'unknown';
  const normalized = type.trim().toLowerCase();
  return SUPPORTED_TYPES.has(normalized) ? normalized : 'unknown';
}

function normalizeSeverity(severity) {
  return Number.isInteger(severity) &&
    severity >= MIN_SEVERITY &&
    severity <= MAX_SEVERITY
    ? severity
    : undefined;
}

function serializeAuthenticatedUserId(req) {
  const user = readProperty(req, 'user');
  const id = readProperty(user, '_id');

  if (typeof id === 'string') {
    return sanitizeString(id, MAX_USER_ID_LENGTH);
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return String(id);
  }
  if (typeof id === 'bigint') {
    return String(id);
  }

  const toHexString = readProperty(id, 'toHexString');
  if (typeof toHexString !== 'function') return undefined;

  try {
    return sanitizeString(toHexString.call(id), MAX_USER_ID_LENGTH);
  } catch {
    return undefined;
  }
}

function normalizeMethod(method) {
  if (typeof method !== 'string') return undefined;
  const normalized = method.trim().toUpperCase();
  if (!/^[A-Z][A-Z-]*$/.test(normalized)) return undefined;
  return truncate(normalized, MAX_METHOD_LENGTH);
}

function redactAuthenticationPath(pathname) {
  let redacted = pathname;
  for (const { pattern, replacement } of AUTHENTICATION_PATHS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function pathnameOnly(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const boundedInput = value.slice(0, MAX_REQUEST_PATH_LENGTH * 4);
  const looksAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(boundedInput);
  const looksProtocolRelative = boundedInput.startsWith('//');

  if (looksAbsolute || looksProtocolRelative) {
    try {
      return new URL(boundedInput, 'http://logger.invalid').pathname;
    } catch {
      const authorityStart = looksProtocolRelative
        ? 2
        : boundedInput.indexOf('://') + 3;
      const pathStart = boundedInput.indexOf('/', authorityStart);
      return pathStart >= 0
        ? boundedInput.slice(pathStart).split(/[?#]/, 1)[0]
        : '/';
    }
  }

  return boundedInput.split(/[?#]/, 1)[0];
}

function isUsefulRouteTemplate(routePath) {
  if (typeof routePath !== 'string' || !routePath.trim()) return false;
  return !/^\/?(?:\*|\{\*[^}]+\})$/.test(routePath.trim());
}

function matchedRoutePath(req) {
  const route = readProperty(req, 'route');
  const routePath = readProperty(route, 'path');
  if (!isUsefulRouteTemplate(routePath)) return undefined;

  const baseUrl = readProperty(req, 'baseUrl');
  const safeBaseUrl = typeof baseUrl === 'string' ? baseUrl : '';
  return `${safeBaseUrl.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`;
}

export function buildSafeRequestPath(req) {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    return undefined;
  }

  const candidate = matchedRoutePath(req) ??
    readProperty(req, 'path') ??
    readProperty(req, 'originalUrl') ??
    readProperty(req, 'url');
  let pathname = pathnameOnly(candidate);
  if (!pathname) return undefined;

  pathname = pathname.replace(CONTROL_CHARACTERS, '');
  pathname = redactAuthenticationPath(pathname);
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return truncate(pathname, MAX_REQUEST_PATH_LENGTH);
}

function buildRequestContext(req) {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    return undefined;
  }

  const request = {};
  const method = normalizeMethod(readProperty(req, 'method'));
  const path = buildSafeRequestPath(req);

  if (method) request.method = method;
  if (path) request.path = path;
  return Object.keys(request).length > 0 ? request : undefined;
}

function nonErrorDescription(value) {
  const kind = value === null ? 'null' : typeof value;
  return {
    name: 'NonErrorThrown',
    message: `A non-Error ${kind} value was thrown.`,
  };
}

function isError(value) {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function serializeErrorInternal(error, depth, seen) {
  if (!isError(error)) return nonErrorDescription(error);
  if (seen.has(error)) {
    return {
      name: 'ErrorCauseOmitted',
      message: 'A circular error cause was omitted.',
    };
  }

  seen.add(error);
  const serialized = {};
  const name = sanitizeString(readProperty(error, 'name'), MAX_ERROR_NAME_LENGTH);
  const message = sanitizeString(
    readProperty(error, 'message'),
    MAX_LOG_MESSAGE_LENGTH,
  );
  const codeValue = readProperty(error, 'code');
  const code = typeof codeValue === 'string'
    ? sanitizeString(codeValue, MAX_ERROR_CODE_LENGTH)
    : typeof codeValue === 'number' && Number.isFinite(codeValue)
      ? codeValue
      : undefined;
  const stack = sanitizeString(
    readProperty(error, 'stack'),
    MAX_ERROR_STACK_LENGTH,
  );

  if (name) serialized.name = name;
  if (message) serialized.message = message;
  if (code !== undefined) serialized.code = code;
  if (stack) serialized.stack = stack;

  const cause = readProperty(error, 'cause');
  if (cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
    serialized.cause = serializeErrorInternal(cause, depth + 1, seen);
  }

  seen.delete(error);
  return serialized;
}

export function serializeError(error) {
  return serializeErrorInternal(error, 0, new WeakSet());
}

export function buildLogEntry(req, type, otherDetails) {
  const entry = { type: normalizeLogType(type) };
  const details = otherDetails && typeof otherDetails === 'object'
    ? otherDetails
    : undefined;
  const message = sanitizeString(
    readProperty(details, 'message'),
    MAX_LOG_MESSAGE_LENGTH,
  );
  const severity = normalizeSeverity(readProperty(details, 'severity'));
  const authenticatedUserId = serializeAuthenticatedUserId(req);
  const request = buildRequestContext(req);
  const error = readProperty(details, 'error');

  if (message) entry.message = message;
  if (severity !== undefined) entry.severity = severity;
  if (authenticatedUserId) entry.authenticatedUserId = authenticatedUserId;
  if (request) entry.request = request;
  if (error !== undefined && error !== null) {
    entry.error = serializeError(error);
  }

  return entry;
}

const defaultNormalOutput = entry => console.log(entry);
const defaultErrorOutput = entry => console.error(entry);
const defaultFallbackOutput = message => console.error(message);

export function createLogger({
  normalOutput = defaultNormalOutput,
  errorOutput = defaultErrorOutput,
  fallbackOutput = defaultFallbackOutput,
} = {}) {
  return async (req = null, _res = null, type, otherDetails = null) => {
    try {
      const entry = buildLogEntry(req, type, otherDetails);
      const output = entry.type === 'error' ? errorOutput : normalOutput;
      await output(entry);
    } catch {
      try {
        await fallbackOutput(LOGGER_FAILURE_MESSAGE);
      } catch {
        // Operational logging must never disrupt application work.
      }
    }
  };
}

export const logger = createLogger();
