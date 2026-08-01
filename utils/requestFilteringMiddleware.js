import { getIP } from './getIP.js';
import { BlockedClientCache } from './blockedClientCache.js';
import { matchesLiteralUrlPattern } from './requestFiltering.js';

const ACTIVE_BLOCK_EVENT = Object.freeze({
  message: 'Blocked request remains active.',
  severity: 1,
});
const BOT_PATTERN_EVENT = Object.freeze({
  message: 'Blocked bot-pattern request.',
  severity: 1,
});
const NOT_FOUND_EVENT = Object.freeze({
  message: 'Non-existent route visited.',
  severity: 1,
});

function createReportingRequest(req) {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    return null;
  }

  const reportingRequest = {};
  try {
    if (typeof req.method === 'string') reportingRequest.method = req.method;
  } catch {
    // Ignore unsafe request properties at the reporting boundary.
  }
  try {
    if (typeof req.path === 'string') reportingRequest.path = req.path;
  } catch {
    // Ignore unsafe request properties at the reporting boundary.
  }

  return Object.keys(reportingRequest).length > 0 ? reportingRequest : null;
}

function reportBestEffort(reportEvent, reportingRequest, type, details) {
  try {
    const result = reportEvent(
      reportingRequest,
      null,
      type,
      details,
    );
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Operational reporting must never alter request-filtering decisions.
  }
}

export function createBotUrlBlocker({
  blockedPatterns = [],
  cache = new BlockedClientCache(),
  getClientIp = getIP,
  reportEvent = () => {},
} = {}) {
  const patterns = Array.isArray(blockedPatterns)
    ? blockedPatterns.filter(pattern =>
      typeof pattern === 'string' && pattern.length > 0)
    : [];

  return (req, res, next) => {
    if (patterns.length === 0) return next();

    let clientIp = null;
    try {
      clientIp = getClientIp(req);
    } catch {
      clientIp = null;
    }

    if (clientIp && cache.isBlocked(clientIp)) {
      reportBestEffort(reportEvent, null, 'general', ACTIVE_BLOCK_EVENT);
      return res.status(403).send('Nope.');
    }

    const originalUrl = typeof req?.originalUrl === 'string'
      ? req.originalUrl
      : '';
    if (!matchesLiteralUrlPattern(originalUrl, patterns)) return next();

    if (clientIp) cache.block(clientIp);
    reportBestEffort(reportEvent, null, 'error', BOT_PATTERN_EVENT);
    return res.status(403).send('No.');
  };
}

export function createNotFoundHandler({
  ignoredPatterns = [],
  reportEvent = () => {},
} = {}) {
  const patterns = Array.isArray(ignoredPatterns)
    ? ignoredPatterns.filter(pattern =>
      typeof pattern === 'string' && pattern.length > 0)
    : [];

  return (req, res) => {
    const originalUrl = typeof req?.originalUrl === 'string'
      ? req.originalUrl
      : '';
    if (!matchesLiteralUrlPattern(originalUrl, patterns)) {
      reportBestEffort(
        reportEvent,
        createReportingRequest(req),
        'error',
        NOT_FOUND_EVENT,
      );
    }

    return res.status(404).render('404', {
      meta: {
        title: 'Page not found',
        description: 'This page does not exist.',
      },
      data: {},
    });
  };
}
