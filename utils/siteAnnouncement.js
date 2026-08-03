export const SITE_ANNOUNCEMENT_KEY = 'site-wide';

export const SITE_ANNOUNCEMENT_LIMITS = Object.freeze({
  title: 80,
  message: 1200,
  navLinkText: 30,
  ctaLabel: 40,
  ctaUrl: 300,
});

export const SITE_ANNOUNCEMENT_DEFAULTS = Object.freeze({
  key: SITE_ANNOUNCEMENT_KEY,
  enabled: false,
  title: '',
  message: '',
  autoOpen: true,
  showNavLink: true,
  navLinkText: 'Announcement',
  ctaLabel: '',
  ctaUrl: '',
  startsOn: null,
  endsOn: null,
  revision: 1,
});

const ADMIN_FORM_FIELDS = new Set([
  '_csrf',
  'enabled',
  'title',
  'message',
  'autoOpen',
  'showNavLink',
  'navLinkText',
  'ctaLabel',
  'ctaUrl',
  'startsOn',
  'endsOn',
  'showAgain',
]);

const PUBLIC_CHANGE_FIELDS = Object.freeze([
  'enabled',
  'title',
  'message',
  'autoOpen',
  'showNavLink',
  'navLinkText',
  'ctaLabel',
  'ctaUrl',
  'startsOn',
  'endsOn',
]);

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ENCODED_CONTROL_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu;
const MALFORMED_PERCENT_PATTERN = /%(?![0-9a-f]{2})/iu;

function isPlainFormObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCheckbox(body, field) {
  if (!(field in body)) return false;
  if (body[field] !== 'true') throw new TypeError('Invalid checkbox value.');
  return true;
}

function normalizeText(body, field, maximum) {
  const value = field in body ? body[field] : '';
  if (typeof value !== 'string') throw new TypeError('Invalid text value.');
  const normalized = value.trim();
  if (normalized.length > maximum) throw new RangeError('Text is too long.');
  return normalized;
}

function parseDateOnly(value, endOfDay) {
  if (value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Invalid date value.');

  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) throw new TypeError('Invalid date value.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError('Invalid date value.');
  }
  return date;
}

function validDateOrNull(value) {
  if (value === null || typeof value === 'undefined') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValue(value) {
  return validDateOrNull(value)?.getTime() ?? null;
}

function boundedStoredText(value, maximum, fallback = '') {
  return typeof value === 'string' && value.length <= maximum
    ? value
    : fallback;
}

export function isValidInternalCtaUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SITE_ANNOUNCEMENT_LIMITS.ctaUrl ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /%5c/iu.test(value) ||
    /\s/u.test(value) ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    ENCODED_CONTROL_PATTERN.test(value) ||
    MALFORMED_PERCENT_PATTERN.test(value)
  ) {
    return false;
  }

  try {
    const base = 'https://camppics.invalid';
    const parsed = new URL(value, base);
    return parsed.origin === base &&
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password;
  } catch {
    return false;
  }
}

export function normalizeSiteAnnouncementForm(body) {
  try {
    if (!isPlainFormObject(body)) throw new TypeError('Invalid form.');
    for (const field of Object.keys(body)) {
      if (!ADMIN_FORM_FIELDS.has(field)) {
        throw new TypeError('Unexpected form field.');
      }
      if (typeof body[field] !== 'string') {
        throw new TypeError('Invalid form field.');
      }
    }

    const enabled = normalizeCheckbox(body, 'enabled');
    const autoOpen = normalizeCheckbox(body, 'autoOpen');
    const showNavLink = normalizeCheckbox(body, 'showNavLink');
    const showAgain = normalizeCheckbox(body, 'showAgain');
    const title = normalizeText(
      body,
      'title',
      SITE_ANNOUNCEMENT_LIMITS.title,
    );
    const message = normalizeText(
      body,
      'message',
      SITE_ANNOUNCEMENT_LIMITS.message,
    );
    const navLinkText = normalizeText(
      body,
      'navLinkText',
      SITE_ANNOUNCEMENT_LIMITS.navLinkText,
    );
    const ctaLabel = normalizeText(
      body,
      'ctaLabel',
      SITE_ANNOUNCEMENT_LIMITS.ctaLabel,
    );
    const ctaUrl = normalizeText(
      body,
      'ctaUrl',
      SITE_ANNOUNCEMENT_LIMITS.ctaUrl,
    );
    const startsOn = parseDateOnly(body.startsOn ?? '', false);
    const endsOn = parseDateOnly(body.endsOn ?? '', true);

    if (enabled && (!title || !message)) {
      throw new TypeError('Enabled content is incomplete.');
    }
    if (enabled && !autoOpen && !showNavLink) {
      throw new TypeError('Enabled content is not visible.');
    }
    if (showNavLink && !navLinkText) {
      throw new TypeError('Navbar text is required.');
    }
    if (Boolean(ctaLabel) !== Boolean(ctaUrl)) {
      throw new TypeError('CTA fields must be paired.');
    }
    if (ctaUrl && !isValidInternalCtaUrl(ctaUrl)) {
      throw new TypeError('CTA URL is invalid.');
    }
    if (startsOn && endsOn && endsOn.getTime() < startsOn.getTime()) {
      throw new TypeError('Date range is invalid.');
    }

    return Object.freeze({
      valid: true,
      announcement: Object.freeze({
        enabled,
        title,
        message,
        autoOpen,
        showNavLink,
        navLinkText,
        ctaLabel,
        ctaUrl,
        startsOn,
        endsOn,
      }),
      showAgain,
    });
  } catch {
    return Object.freeze({ valid: false });
  }
}

export function isSiteAnnouncementActive(announcement, now = new Date()) {
  if (!announcement || announcement.enabled !== true) return false;
  const current = validDateOrNull(now);
  if (!current) return false;
  const startsOn = validDateOrNull(announcement.startsOn);
  const endsOn = validDateOrNull(announcement.endsOn);
  if (announcement.startsOn && !startsOn) return false;
  if (announcement.endsOn && !endsOn) return false;
  if (startsOn && current.getTime() < startsOn.getTime()) return false;
  if (endsOn && current.getTime() > endsOn.getTime()) return false;
  return true;
}

export function serializePublicSiteAnnouncement(announcement) {
  if (!announcement || announcement.key !== SITE_ANNOUNCEMENT_KEY) return null;

  const title = boundedStoredText(
    announcement.title,
    SITE_ANNOUNCEMENT_LIMITS.title,
  );
  const message = boundedStoredText(
    announcement.message,
    SITE_ANNOUNCEMENT_LIMITS.message,
  );
  const navLinkText = boundedStoredText(
    announcement.navLinkText,
    SITE_ANNOUNCEMENT_LIMITS.navLinkText,
  );
  const ctaLabel = boundedStoredText(
    announcement.ctaLabel,
    SITE_ANNOUNCEMENT_LIMITS.ctaLabel,
  );
  const ctaUrl = boundedStoredText(
    announcement.ctaUrl,
    SITE_ANNOUNCEMENT_LIMITS.ctaUrl,
  );
  const revision = announcement.revision;
  const autoOpen = announcement.autoOpen === true;
  const showNavLink = announcement.showNavLink === true;

  if (
    !title ||
    !message ||
    (!autoOpen && !showNavLink) ||
    (showNavLink && !navLinkText) ||
    Boolean(ctaLabel) !== Boolean(ctaUrl) ||
    (ctaUrl && !isValidInternalCtaUrl(ctaUrl)) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }

  return Object.freeze({
    key: SITE_ANNOUNCEMENT_KEY,
    title,
    message,
    autoOpen,
    showNavLink,
    navLinkText,
    ctaLabel,
    ctaUrl,
    revision,
  });
}

export function hasPublicSiteAnnouncementChanged(current, next) {
  if (!current) return true;
  return PUBLIC_CHANGE_FIELDS.some(field => {
    if (field === 'startsOn' || field === 'endsOn') {
      return dateValue(current[field]) !== dateValue(next[field]);
    }
    return current[field] !== next[field];
  });
}

export function getSiteAnnouncementStatus(announcement, now = new Date()) {
  if (!announcement?.enabled) return 'Disabled';
  const current = validDateOrNull(now);
  const startsOn = validDateOrNull(announcement.startsOn);
  const endsOn = validDateOrNull(announcement.endsOn);
  if (!current) return 'Disabled';
  if (startsOn && current.getTime() < startsOn.getTime()) return 'Scheduled';
  if (endsOn && current.getTime() > endsOn.getTime()) return 'Expired';
  return 'Active';
}

function toDateInputValue(value) {
  return validDateOrNull(value)?.toISOString().slice(0, 10) ?? '';
}

export function serializeAdminSiteAnnouncement(announcement) {
  const source = announcement ?? SITE_ANNOUNCEMENT_DEFAULTS;
  return Object.freeze({
    key: SITE_ANNOUNCEMENT_KEY,
    enabled: source.enabled === true,
    title: boundedStoredText(
      source.title,
      SITE_ANNOUNCEMENT_LIMITS.title,
    ),
    message: boundedStoredText(
      source.message,
      SITE_ANNOUNCEMENT_LIMITS.message,
    ),
    autoOpen: source.autoOpen !== false,
    showNavLink: source.showNavLink !== false,
    navLinkText: boundedStoredText(
      source.navLinkText,
      SITE_ANNOUNCEMENT_LIMITS.navLinkText,
      SITE_ANNOUNCEMENT_DEFAULTS.navLinkText,
    ),
    ctaLabel: boundedStoredText(
      source.ctaLabel,
      SITE_ANNOUNCEMENT_LIMITS.ctaLabel,
    ),
    ctaUrl: boundedStoredText(
      source.ctaUrl,
      SITE_ANNOUNCEMENT_LIMITS.ctaUrl,
    ),
    startsOn: toDateInputValue(source.startsOn),
    endsOn: toDateInputValue(source.endsOn),
    revision: Number.isSafeInteger(source.revision) && source.revision > 0
      ? source.revision
      : SITE_ANNOUNCEMENT_DEFAULTS.revision,
  });
}
