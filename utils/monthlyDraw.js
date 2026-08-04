import { createHash } from 'node:crypto';

export const MONTHLY_DRAW_RULES_VERSION = '2026-08-03-v1';
export const MONTHLY_DRAW_TIME_ZONE = 'America/Toronto';
export const MONTHLY_DRAW_UPLOAD_STATUSES = Object.freeze([
  'pending',
  'eligible',
  'ineligible',
]);
export const MONTHLY_DRAW_INELIGIBILITY_REASONS = Object.freeze([
  'duplicate',
  'wrong-location',
  'not-useful',
  'insufficient-quality',
  'rights-or-policy',
  'account-ineligible',
  'other-ineligible',
]);
export const MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS = Object.freeze({
  duplicate: 'Duplicate upload',
  'wrong-location': 'Incorrect location',
  'not-useful': 'Not useful to campers',
  'insufficient-quality': 'Insufficient quality',
  'rights-or-policy': 'Rights or policy issue',
  'account-ineligible': 'Account not eligible',
  'other-ineligible': 'Other ineligible upload',
});

const MONTH_KEY_PATTERN = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u;
const OBJECT_ID_HEX_PATTERN = /^[a-f0-9]{24}$/iu;
const NO_UPLOAD_ENTRY_ID_PREFIX = 'monthly-draw-no-upload';
const NO_UPLOAD_SOURCE_REFERENCE_PREFIX = 'monthly-draw-no-upload-ref';
const RESULT_ID_PREFIX = 'monthly-draw-result';
const MONTH_NAMES = Object.freeze(Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat('en-CA', {
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, index, 1)))));
const ALLOWED_NO_UPLOAD_FORM_FIELDS = new Set([
  '_csrf',
  'ageOfMajorityConfirmed',
  'rulesAccepted',
  'website',
]);

const easternMonthFormatter = new Intl.DateTimeFormat('en-CA', {
  month: '2-digit',
  timeZone: MONTHLY_DRAW_TIME_ZONE,
  year: 'numeric',
});
const easternCalendarDayFormatter = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  timeZone: MONTHLY_DRAW_TIME_ZONE,
});

function monthKeyParts(monthKey) {
  if (typeof monthKey !== 'string') return null;
  const match = monthKey.match(MONTH_KEY_PATTERN);
  if (!match) return null;

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  if (year < 1 || year > 9999) return null;
  return { month, year };
}

function normalizedObjectIdHex(userId) {
  let userIdHex;
  try {
    if (typeof userId === 'string') {
      userIdHex = userId;
    } else if (
      userId &&
      typeof userId === 'object' &&
      userId._bsontype === 'ObjectId' &&
      typeof userId.toHexString === 'function'
    ) {
      userIdHex = userId.toHexString();
    }
  } catch {
    throw new TypeError('A valid ObjectId is required.');
  }

  if (
    typeof userIdHex !== 'string' ||
    !OBJECT_ID_HEX_PATTERN.test(userIdHex)
  ) {
    throw new TypeError('A valid ObjectId is required.');
  }
  return userIdHex.toLowerCase();
}

export function deriveEasternMonthKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new TypeError('A valid Date is required.');
  }

  const parts = Object.fromEntries(
    easternMonthFormatter
      .formatToParts(date)
      .filter(part => part.type === 'year' || part.type === 'month')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
}

export function getPreviousMonthlyDrawMonthKey(date = new Date()) {
  const currentMonth = monthKeyParts(deriveEasternMonthKey(date));
  const previousMonth = currentMonth.month === 1 ? 12 : currentMonth.month - 1;
  const previousYear = currentMonth.month === 1
    ? currentMonth.year - 1
    : currentMonth.year;
  if (previousYear < 1) {
    throw new TypeError('A previous monthly draw month is unavailable.');
  }
  return `${String(previousYear).padStart(4, '0')}-${String(previousMonth).padStart(2, '0')}`;
}

export function isFirstEasternCalendarDay(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new TypeError('A valid Date is required.');
  }
  const day = easternCalendarDayFormatter
    .formatToParts(date)
    .find(part => part.type === 'day')?.value;
  return day === '01';
}

export function isValidMonthKey(monthKey) {
  return monthKeyParts(monthKey) !== null;
}

export function buildMonthlyDrawNoUploadEntryId(userId, monthKey) {
  const userIdHex = normalizedObjectIdHex(userId);
  if (!isValidMonthKey(monthKey)) {
    throw new TypeError('A valid YYYY-MM month key is required.');
  }

  return `${NO_UPLOAD_ENTRY_ID_PREFIX}:${monthKey}:${userIdHex}`;
}

export function buildMonthlyDrawNoUploadSourceReference(userId, monthKey) {
  const entryId = buildMonthlyDrawNoUploadEntryId(userId, monthKey);
  const digest = createHash('sha256')
    .update(entryId, 'utf8')
    .digest('hex');
  return `${NO_UPLOAD_SOURCE_REFERENCE_PREFIX}:${monthKey}:${digest}`;
}

export function buildMonthlyDrawResultId(monthKey) {
  if (!isValidMonthKey(monthKey)) {
    throw new TypeError('A valid YYYY-MM month key is required.');
  }
  return `${RESULT_ID_PREFIX}:${monthKey}`;
}

export function buildMonthlyDrawEntrantFingerprint(userId, monthKey) {
  if (!isValidMonthKey(monthKey)) {
    throw new TypeError('A valid YYYY-MM month key is required.');
  }
  const userIdHex = normalizedObjectIdHex(userId);
  return createHash('sha256')
    .update(`${monthKey}:${userIdHex}`, 'utf8')
    .digest('hex');
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function formatMonthlyDrawPeriod(monthKey) {
  const parts = monthKeyParts(monthKey);
  if (!parts) throw new TypeError('A valid YYYY-MM month key is required.');

  const finalDay = daysInMonth(parts.year, parts.month);
  return `${MONTH_NAMES[parts.month - 1]} 1–${finalDay}, ${parts.year} (Eastern Time)`;
}

export function formatMonthlyDrawMonth(monthKey) {
  const parts = monthKeyParts(monthKey);
  if (!parts) throw new TypeError('A valid YYYY-MM month key is required.');
  return `${MONTH_NAMES[parts.month - 1]} ${parts.year}`;
}

export function isMonthlyDrawEntrantAccountEligible(user) {
  return Boolean(
    user?._id &&
    user.email_verified === true &&
    user.isAdmin !== true &&
    user.blocked !== true,
  );
}

export function isNoUploadEntrantAccountEligible(user) {
  return isMonthlyDrawEntrantAccountEligible(user);
}

export function maySubmitNoUploadEntry({
  user,
  alreadyEntered = false,
  entryStatusAvailable = true,
} = {}) {
  return Boolean(
    isNoUploadEntrantAccountEligible(user) &&
    alreadyEntered === false &&
    entryStatusAvailable === true,
  );
}

export function validateNoUploadEntryBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false };
  }

  const fields = Object.keys(body);
  if (
    Object.getOwnPropertySymbols(body).length > 0 ||
    fields.some(field => !ALLOWED_NO_UPLOAD_FORM_FIELDS.has(field)) ||
    !Object.hasOwn(body, 'ageOfMajorityConfirmed') ||
    !Object.hasOwn(body, 'rulesAccepted') ||
    !Object.hasOwn(body, 'website')
  ) {
    return { valid: false };
  }
  if (
    body.ageOfMajorityConfirmed !== 'true' ||
    body.rulesAccepted !== 'true' ||
    body.website !== '' ||
    (body._csrf !== undefined && typeof body._csrf !== 'string')
  ) {
    return { valid: false };
  }

  return {
    valid: true,
    confirmations: Object.freeze({
      ageOfMajorityConfirmed: true,
      rulesAccepted: true,
    }),
  };
}
