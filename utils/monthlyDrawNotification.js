import { createHash, randomBytes } from 'node:crypto';

import { MonthlyDrawNoUploadEntry } from '../models/monthlyDrawNoUploadEntry.js';
import { MonthlyDrawResult } from '../models/monthlyDrawResult.js';
import { Park } from '../models/park.js';
import { Upload } from '../models/upload.js';
import { User } from '../models/user.js';
import {
  ADMIN_PARK_LOCATION_PROJECTION,
  buildAdminParkLocationMap,
  collectAdminUploadParkIds,
  getAdminUserDetailUrl,
  resolveAdminUploadLocationUrls,
} from '../controllers/admin.js';
import {
  MONTHLY_DRAW_TIME_ZONE,
  buildMonthlyDrawEntrantFingerprint,
  buildMonthlyDrawNoUploadEntryId,
  buildMonthlyDrawNoUploadSourceReference,
  buildMonthlyDrawResultId,
  formatMonthlyDrawMonth,
  isMonthlyDrawEntrantAccountEligible,
  isMonthlyDrawUploadSelectableStatus,
  isValidMonthKey,
} from './monthlyDraw.js';
import { parseStrictMongoObjectId } from './mongoObjectId.js';

export const MONTHLY_DRAW_NOTIFICATION_LEASE_MS = 30 * 60 * 1000;
export const MONTHLY_DRAW_NOTIFICATION_FINALIZATION_FAILURE_MESSAGE =
  'Monthly draw notification finalization failed.';

export const MONTHLY_DRAW_NOTIFICATION_UPLOAD_PROJECTION = Object.freeze({
  _id: 1,
  userId: 1,
  mediaType: 1,
  createdAt: 1,
  parkId: 1,
  parkName: 1,
  campgroundId: 1,
  campgroundName: 1,
  campsiteId: 1,
  campsiteName: 1,
  'monthlyDraw.status': 1,
  'monthlyDraw.monthKey': 1,
  'monthlyDraw.rulesVersion': 1,
});
export const MONTHLY_DRAW_NOTIFICATION_NO_UPLOAD_PROJECTION = Object.freeze({
  _id: 1,
  userId: 1,
  monthKey: 1,
  rulesVersion: 1,
});
export const MONTHLY_DRAW_NOTIFICATION_USER_PROJECTION = Object.freeze({
  _id: 1,
  fname: 1,
  username: 1,
  email_verified: 1,
  isAdmin: 1,
  blocked: 1,
});

const RESULT_NOTIFICATION_PROJECTION = Object.freeze({
  _id: 1,
  monthKey: 1,
  rulesVersion: 1,
  status: 1,
  selectedAt: 1,
  candidates: 1,
  poolSummary: 1,
  notification: 1,
});
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/u;
const RANK_LABELS = Object.freeze({
  1: 'Primary selected entrant',
  2: 'First alternate',
  3: 'Second alternate',
});
const UNAVAILABLE_LABELS = Object.freeze({
  sourceMissing: 'Source is no longer available',
  sourceIneligible: 'Source is no longer eligible',
  accountMissing: 'Account is no longer available',
  accountIneligible: 'Account is no longer eligible',
  identity: 'Stored candidate identity could not be verified',
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'long',
  timeZone: MONTHLY_DRAW_TIME_ZONE,
  timeZoneName: 'short',
  year: 'numeric',
});

function requireMonthKey(monthKey) {
  if (!isValidMonthKey(monthKey)) {
    throw new TypeError('A valid YYYY-MM month key is required.');
  }
  return monthKey;
}

function requireNow(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError('Monthly draw notification clock returned no valid Date.');
  }
  return value;
}

function createRawLeaseToken() {
  return randomBytes(32);
}

function requireLeaseToken(value) {
  if (value instanceof Uint8Array && value.byteLength === 32) return value;
  throw new TypeError('Monthly draw notification lease token must be 32 bytes.');
}

function hashLeaseToken(rawToken) {
  return createHash('sha256')
    .update(requireLeaseToken(rawToken))
    .digest('hex');
}

function plainRecord(value) {
  if (!value) return null;
  return typeof value.toObject === 'function'
    ? value.toObject({ depopulate: true })
    : value;
}

function selectQuery(query, projection) {
  return projection && typeof query?.select === 'function'
    ? query.select(projection)
    : query;
}

async function leanQuery(query) {
  return typeof query?.lean === 'function' ? query.lean() : query;
}

async function findLean(Model, filter, projection) {
  return leanQuery(selectQuery(Model.find(filter), projection));
}

async function findOneLean(Model, filter, projection) {
  return leanQuery(selectQuery(Model.findOne(filter), projection));
}

function normalizeObjectId(value) {
  let rawValue = value;
  if (typeof rawValue !== 'string') {
    try {
      rawValue = value?.toHexString?.();
    } catch {
      rawValue = null;
    }
  }
  const parsed = parseStrictMongoObjectId(rawValue);
  return parsed.valid ? parsed.stringValue : null;
}

function stringValue(value) {
  return typeof value === 'string' ? value : null;
}

function safeText(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeDateLabel(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : dateTimeFormatter.format(date);
}

function safePublicOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function absoluteInternalUrl(origin, pathname) {
  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    pathname.includes('\\')
  ) {
    return null;
  }
  try {
    const absolute = new URL(pathname, `${origin}/`);
    return absolute.origin === origin &&
      absolute.username === '' &&
      absolute.password === ''
      ? absolute.href
      : null;
  } catch {
    return null;
  }
}

function validProviderMessageId(result) {
  const value = result?.id;
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512
    ? value
    : null;
}

function safeNotificationState(notification) {
  return ['pending', 'sending', 'sent'].includes(notification?.state)
    ? notification.state
    : 'pending';
}

function safeAttemptCount(notification) {
  return Number.isSafeInteger(notification?.attemptCount) &&
    notification.attemptCount >= 0
    ? notification.attemptCount
    : 0;
}

function safeCandidateCount(result) {
  return Array.isArray(result?.candidates) ? result.candidates.length : 0;
}

function inspectionFromResult(monthKey, result, at) {
  if (!result) {
    return Object.freeze({
      monthKey,
      resultExists: false,
      resultStatus: null,
      candidateCount: 0,
      notificationState: 'pending',
      attemptCount: 0,
      sentAt: null,
      leaseActive: false,
    });
  }
  const notificationState = safeNotificationState(result.notification);
  const leaseExpiresAt = result.notification?.leaseExpiresAt == null
    ? null
    : new Date(result.notification.leaseExpiresAt);
  const sentAt = result.notification?.sentAt == null
    ? null
    : new Date(result.notification.sentAt);
  return Object.freeze({
    monthKey,
    resultExists: true,
    resultStatus: ['selected', 'no-eligible-entries'].includes(result.status)
      ? result.status
      : null,
    candidateCount: safeCandidateCount(result),
    notificationState,
    attemptCount: safeAttemptCount(result.notification),
    sentAt: sentAt && !Number.isNaN(sentAt.valueOf()) ? sentAt : null,
    leaseActive: notificationState === 'sending' &&
      leaseExpiresAt instanceof Date &&
      !Number.isNaN(leaseExpiresAt.valueOf()) &&
      leaseExpiresAt > at,
  });
}

function serviceOutcome(state, inspection) {
  return Object.freeze({
    state,
    monthKey: inspection.monthKey,
    resultStatus: inspection.resultStatus,
    candidateCount: inspection.candidateCount,
    notificationState: inspection.notificationState,
    attemptCount: inspection.attemptCount,
    sentAt: inspection.sentAt,
  });
}

function unavailableCandidate(candidate, reason, sourceLabel = null) {
  return Object.freeze({
    rank: candidate.rank,
    rankLabel: RANK_LABELS[candidate.rank] || 'Stored candidate',
    available: false,
    unavailableReasonLabel: reason,
    sourceLabel,
    entryCount: candidate.entryCount,
    nickname: null,
    email: null,
    mediaType: null,
    uploadedAt: null,
    parkName: null,
    campgroundName: null,
    campsiteName: null,
    locationUrl: null,
    userDetailUrl: null,
  });
}

function sourceLabelForUpload(upload) {
  if (upload?.mediaType === 'photo') return 'Photo upload';
  if (upload?.mediaType === 'video') return 'Video upload';
  return null;
}

function isCurrentUpload(upload, result, candidate) {
  return isMonthlyDrawUploadSelectableStatus(upload?.monthlyDraw?.status) &&
    upload.monthlyDraw.monthKey === result.monthKey &&
    upload.monthlyDraw.rulesVersion === result.rulesVersion &&
    buildMonthlyDrawEntrantFingerprint(upload.userId, result.monthKey) ===
      candidate.entrantFingerprint;
}

async function resolveStoredCandidates({
  result,
  UploadModel,
  NoUploadEntryModel,
  UserModel,
  ParkModel,
  publicOrigin,
}) {
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const sourceState = candidates.map(candidate => ({
    candidate,
    source: null,
    userId: null,
    unavailableReason: null,
  }));
  const uploadSourceIds = [...new Set(candidates
    .filter(candidate => candidate?.sourceType === 'upload')
    .map(candidate => candidate.sourceId)
    .filter(sourceId => typeof sourceId === 'string' &&
      OBJECT_ID_PATTERN.test(sourceId)))];
  const uploadRecords = uploadSourceIds.length > 0
    ? await findLean(UploadModel, {
      _id: { $in: uploadSourceIds },
    }, MONTHLY_DRAW_NOTIFICATION_UPLOAD_PROJECTION)
    : [];
  const uploadsById = new Map();
  for (const upload of uploadRecords) {
    const uploadId = normalizeObjectId(upload?._id);
    if (uploadId) uploadsById.set(uploadId, upload);
  }

  const hasNoUploadCandidates = candidates.some(candidate =>
    candidate?.sourceType === 'no-upload'
  );
  const noUploadRecords = hasNoUploadCandidates
    ? await findLean(NoUploadEntryModel, {
      monthKey: result.monthKey,
      rulesVersion: result.rulesVersion,
    }, MONTHLY_DRAW_NOTIFICATION_NO_UPLOAD_PROJECTION)
    : [];
  const noUploadsByReference = new Map();
  for (const entry of noUploadRecords) {
    const userId = normalizeObjectId(entry?.userId);
    if (!userId || entry?.monthKey !== result.monthKey ||
      entry?.rulesVersion !== result.rulesVersion) continue;
    let expectedId;
    let reference;
    try {
      expectedId = buildMonthlyDrawNoUploadEntryId(userId, result.monthKey);
      reference = buildMonthlyDrawNoUploadSourceReference(
        userId,
        result.monthKey,
      );
    } catch {
      continue;
    }
    if (stringValue(entry?._id) !== expectedId) continue;
    if (!noUploadsByReference.has(reference)) {
      noUploadsByReference.set(reference, { entry, userId });
    }
  }

  for (const item of sourceState) {
    const { candidate } = item;
    if (candidate?.sourceType === 'upload') {
      if (typeof candidate.sourceId !== 'string' ||
        !OBJECT_ID_PATTERN.test(candidate.sourceId)) {
        item.unavailableReason = UNAVAILABLE_LABELS.identity;
        continue;
      }
      const upload = uploadsById.get(candidate.sourceId);
      if (!upload) {
        item.unavailableReason = UNAVAILABLE_LABELS.sourceMissing;
        continue;
      }
      let current = false;
      try {
        current = isCurrentUpload(upload, result, candidate);
      } catch {
        item.unavailableReason = UNAVAILABLE_LABELS.identity;
        continue;
      }
      if (!current) {
        const uploadUserId = normalizeObjectId(upload.userId);
        const fingerprintMatches = uploadUserId &&
          buildMonthlyDrawEntrantFingerprint(
            uploadUserId,
            result.monthKey,
          ) === candidate.entrantFingerprint;
        item.unavailableReason = fingerprintMatches
          ? UNAVAILABLE_LABELS.sourceIneligible
          : UNAVAILABLE_LABELS.identity;
        continue;
      }
      item.source = upload;
      item.userId = normalizeObjectId(upload.userId);
      continue;
    }

    if (candidate?.sourceType === 'no-upload') {
      const resolved = noUploadsByReference.get(candidate.sourceId);
      if (!resolved) {
        item.unavailableReason = UNAVAILABLE_LABELS.sourceMissing;
        continue;
      }
      if (buildMonthlyDrawEntrantFingerprint(
        resolved.userId,
        result.monthKey,
      ) !== candidate.entrantFingerprint) {
        item.unavailableReason = UNAVAILABLE_LABELS.identity;
        continue;
      }
      item.source = resolved.entry;
      item.userId = resolved.userId;
      continue;
    }

    item.unavailableReason = UNAVAILABLE_LABELS.identity;
  }

  const userIds = [...new Set(sourceState
    .map(item => item.userId)
    .filter(Boolean))];
  const users = userIds.length > 0
    ? await findLean(UserModel, {
      _id: { $in: userIds },
    }, MONTHLY_DRAW_NOTIFICATION_USER_PROJECTION)
    : [];
  const usersById = new Map();
  for (const user of users) {
    const userId = normalizeObjectId(user?._id);
    if (userId) usersById.set(userId, user);
  }

  const resolvableUploads = sourceState
    .filter(item => item.candidate?.sourceType === 'upload' && item.source)
    .map(item => item.source);
  const parkIds = collectAdminUploadParkIds(resolvableUploads);
  const parkRecords = parkIds.length > 0
    ? await findLean(ParkModel, {
      _id: { $in: parkIds },
    }, ADMIN_PARK_LOCATION_PROJECTION)
    : [];
  const parksById = buildAdminParkLocationMap(parkRecords);

  return Object.freeze(sourceState.map(item => {
    const { candidate } = item;
    const sourceLabel = candidate?.sourceType === 'no-upload'
      ? 'No-upload entry'
      : sourceLabelForUpload(item.source);
    if (item.unavailableReason) {
      return unavailableCandidate(
        candidate,
        item.unavailableReason,
        sourceLabel,
      );
    }

    const user = usersById.get(item.userId);
    if (!user) {
      return unavailableCandidate(
        candidate,
        UNAVAILABLE_LABELS.accountMissing,
        sourceLabel,
      );
    }
    let fingerprintMatches = false;
    try {
      fingerprintMatches = buildMonthlyDrawEntrantFingerprint(
        user._id,
        result.monthKey,
      ) === candidate.entrantFingerprint;
    } catch {
      fingerprintMatches = false;
    }
    if (!fingerprintMatches) {
      return unavailableCandidate(
        candidate,
        UNAVAILABLE_LABELS.identity,
        sourceLabel,
      );
    }
    if (!isMonthlyDrawEntrantAccountEligible(user)) {
      return unavailableCandidate(
        candidate,
        UNAVAILABLE_LABELS.accountIneligible,
        sourceLabel,
      );
    }

    let mediaType = null;
    let uploadedAt = null;
    let parkName = null;
    let campgroundName = null;
    let campsiteName = null;
    let locationUrl = null;
    if (candidate.sourceType === 'upload') {
      const urls = resolveAdminUploadLocationUrls(item.source, parksById);
      const preferredPath = urls.campsiteUrl ||
        urls.campgroundUrl ||
        urls.parkUrl;
      mediaType = ['photo', 'video'].includes(item.source.mediaType)
        ? item.source.mediaType
        : null;
      uploadedAt = safeDateLabel(item.source.createdAt);
      parkName = safeText(item.source.parkName);
      campgroundName = safeText(item.source.campgroundName);
      campsiteName = safeText(item.source.campsiteName);
      locationUrl = absoluteInternalUrl(publicOrigin, preferredPath);
    }
    const userDetailUrl = absoluteInternalUrl(
      publicOrigin,
      getAdminUserDetailUrl(user._id),
    );
    return Object.freeze({
      rank: candidate.rank,
      rankLabel: RANK_LABELS[candidate.rank] || 'Stored candidate',
      available: true,
      unavailableReasonLabel: null,
      sourceLabel,
      entryCount: candidate.entryCount,
      nickname: safeText(user.fname),
      email: safeText(user.username),
      mediaType,
      uploadedAt,
      parkName,
      campgroundName,
      campsiteName,
      locationUrl,
      userDetailUrl,
    });
  }));
}

function templateDataForResult(result, candidates) {
  return Object.freeze({
    drawMonth: formatMonthlyDrawMonth(result.monthKey),
    selectedAt: safeDateLabel(result.selectedAt),
    resultStatus: result.status,
    poolSummary: Object.freeze({
      eligibleUploadEntries: result.poolSummary.eligibleUploadEntries,
      eligibleNoUploadEntries: result.poolSummary.eligibleNoUploadEntries,
      totalEligibleEntries: result.poolSummary.totalEligibleEntries,
      eligibleDistinctEntrants: result.poolSummary.eligibleDistinctEntrants,
      excludedAccountEntries: result.poolSummary.excludedAccountEntries,
    }),
    candidates,
    noEligibleEntries: result.status === 'no-eligible-entries',
  });
}

export function createMonthlyDrawNotificationService({
  ResultModel = MonthlyDrawResult,
  UploadModel = Upload,
  NoUploadEntryModel = MonthlyDrawNoUploadEntry,
  UserModel = User,
  ParkModel = Park,
  send,
  now = () => new Date(),
  createLeaseToken = createRawLeaseToken,
  publicSiteDomain,
  administratorEmail,
} = {}) {
  if (!ResultModel || typeof now !== 'function' ||
    typeof createLeaseToken !== 'function') {
    throw new TypeError('Monthly draw notification dependencies are required.');
  }

  async function inspectAt(monthKey, at) {
    const result = await findOneLean(
      ResultModel,
      { _id: buildMonthlyDrawResultId(monthKey) },
      RESULT_NOTIFICATION_PROJECTION,
    );
    return inspectionFromResult(monthKey, result, at);
  }

  async function inspectNotification({ monthKey }) {
    requireMonthKey(monthKey);
    return inspectAt(monthKey, requireNow(now));
  }

  async function releaseLease(resultId, leaseTokenHash) {
    const failureTime = requireNow(now);
    return ResultModel.findOneAndUpdate(
      {
        _id: resultId,
        'notification.state': 'sending',
        'notification.leaseTokenHash': leaseTokenHash,
      },
      {
        $set: {
          'notification.state': 'pending',
          'notification.lastFailureAt': failureTime,
        },
        $unset: {
          'notification.leaseTokenHash': '',
          'notification.leaseExpiresAt': '',
        },
      },
      { new: true, upsert: false },
    );
  }

  async function finalizeLease(
    resultId,
    leaseTokenHash,
    providerResult,
  ) {
    try {
      const sentAt = requireNow(now);
      const providerMessageId = validProviderMessageId(providerResult);
      const update = {
        $set: {
          'notification.state': 'sent',
          'notification.sentAt': sentAt,
        },
        $unset: {
          'notification.leaseTokenHash': '',
          'notification.leaseExpiresAt': '',
        },
      };
      if (providerMessageId) {
        update.$set['notification.providerMessageId'] = providerMessageId;
      } else {
        update.$unset['notification.providerMessageId'] = '';
      }
      const finalized = await ResultModel.findOneAndUpdate(
        {
          _id: resultId,
          'notification.state': 'sending',
          'notification.leaseTokenHash': leaseTokenHash,
        },
        update,
        { new: true, upsert: false },
      );
      if (!finalized) {
        throw new Error(MONTHLY_DRAW_NOTIFICATION_FINALIZATION_FAILURE_MESSAGE);
      }
      return plainRecord(finalized);
    } catch {
      throw new Error(MONTHLY_DRAW_NOTIFICATION_FINALIZATION_FAILURE_MESSAGE);
    }
  }

  async function notifyStoredResult({ monthKey }) {
    requireMonthKey(monthKey);
    if (
      typeof send !== 'function' ||
      !UploadModel ||
      !NoUploadEntryModel ||
      !UserModel ||
      !ParkModel
    ) {
      throw new TypeError('Monthly draw notification delivery dependencies are required.');
    }
    const publicOrigin = safePublicOrigin(publicSiteDomain);
    if (!publicOrigin || typeof administratorEmail !== 'string' ||
      !administratorEmail.trim() || administratorEmail.length > 320) {
      throw new TypeError('Monthly draw notification configuration is invalid.');
    }

    const claimTime = requireNow(now);
    const rawLeaseToken = createLeaseToken();
    const leaseTokenHash = hashLeaseToken(rawLeaseToken);
    const resultId = buildMonthlyDrawResultId(monthKey);
    const leaseExpiresAt = new Date(
      claimTime.valueOf() + MONTHLY_DRAW_NOTIFICATION_LEASE_MS,
    );
    const claimedValue = await ResultModel.findOneAndUpdate(
      {
        _id: resultId,
        $or: [
          { notification: { $exists: false } },
          { 'notification.state': { $exists: false } },
          { 'notification.state': 'pending' },
          {
            'notification.state': 'sending',
            'notification.leaseExpiresAt': { $lte: claimTime },
          },
        ],
      },
      {
        $set: {
          'notification.state': 'sending',
          'notification.lastAttemptAt': claimTime,
          'notification.leaseTokenHash': leaseTokenHash,
          'notification.leaseExpiresAt': leaseExpiresAt,
          'notification.sentAt': null,
        },
        $inc: {
          'notification.attemptCount': 1,
        },
      },
      { new: true, upsert: false },
    );
    const claimed = plainRecord(claimedValue);
    if (!claimed) {
      const inspection = await inspectAt(monthKey, claimTime);
      if (!inspection.resultExists) {
        return serviceOutcome('missing-result', inspection);
      }
      return serviceOutcome(
        inspection.notificationState === 'sent'
          ? 'already-sent'
          : 'lease-active',
        inspection,
      );
    }

    let providerResult;
    try {
      const candidates = await resolveStoredCandidates({
        result: claimed,
        UploadModel,
        NoUploadEntryModel,
        UserModel,
        ParkModel,
        publicOrigin,
      });
      providerResult = await send({
        to: administratorEmail,
        subject: `CampPics monthly draw selections — ${formatMonthlyDrawMonth(monthKey)}`,
        template: 'monthly-draw-admin-notification',
        templateData: templateDataForResult(claimed, candidates),
      });
    } catch (error) {
      try {
        await releaseLease(resultId, leaseTokenHash);
      } catch {
        // The original definite failure remains authoritative.
      }
      throw error;
    }

    const finalized = await finalizeLease(
      resultId,
      leaseTokenHash,
      providerResult,
    );
    return serviceOutcome(
      'sent',
      inspectionFromResult(monthKey, finalized, claimTime),
    );
  }

  return Object.freeze({ inspectNotification, notifyStoredResult });
}
