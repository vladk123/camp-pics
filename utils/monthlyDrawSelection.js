import { randomInt as cryptoRandomInt } from 'node:crypto';
import mongoose from 'mongoose';

import { MonthlyDrawNoUploadEntry } from '../models/monthlyDrawNoUploadEntry.js';
import { MonthlyDrawResult } from '../models/monthlyDrawResult.js';
import { Upload } from '../models/upload.js';
import { User } from '../models/user.js';
import { DEFAULT_TRANSACTION_OPTIONS } from './mongoTransaction.js';
import {
  MONTHLY_DRAW_RULES_VERSION,
  buildMonthlyDrawEntrantFingerprint,
  buildMonthlyDrawNoUploadEntryId,
  buildMonthlyDrawNoUploadSourceReference,
  buildMonthlyDrawResultId,
  isMonthlyDrawEntrantAccountEligible,
  isValidMonthKey,
} from './monthlyDraw.js';

export const MONTHLY_DRAW_SELECTION_BLOCKED_MESSAGE =
  'Monthly draw selection is blocked because uploads are still awaiting review.';

export const MONTHLY_DRAW_UPLOAD_SELECTION_PROJECTION = Object.freeze({
  _id: 1,
  userId: 1,
  'monthlyDraw.status': 1,
  'monthlyDraw.monthKey': 1,
  'monthlyDraw.rulesVersion': 1,
});
export const MONTHLY_DRAW_NO_UPLOAD_SELECTION_PROJECTION = Object.freeze({
  _id: 1,
  userId: 1,
  monthKey: 1,
  rulesVersion: 1,
});
export const MONTHLY_DRAW_ACCOUNT_SELECTION_PROJECTION = Object.freeze({
  _id: 1,
  email_verified: 1,
  isAdmin: 1,
  blocked: 1,
});

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/iu;

function requireMonthKey(monthKey) {
  if (!isValidMonthKey(monthKey)) {
    throw new TypeError('A valid YYYY-MM month key is required.');
  }
  return monthKey;
}

function normalizeObjectId(value) {
  let stringValue;
  try {
    stringValue = typeof value === 'string'
      ? value
      : value?.toHexString?.();
  } catch {
    stringValue = null;
  }
  if (typeof stringValue !== 'string' || !OBJECT_ID_PATTERN.test(stringValue)) {
    throw new TypeError('Monthly draw entry contains an invalid ObjectId.');
  }
  return stringValue.toLowerCase();
}

function normalizeSourceId(sourceType, sourceId, userId, monthKey) {
  if (sourceType === 'upload') return normalizeObjectId(sourceId);
  if (sourceType !== 'no-upload' || typeof sourceId !== 'string') {
    throw new TypeError('Monthly draw entry contains an invalid source.');
  }
  const expected = buildMonthlyDrawNoUploadEntryId(userId, monthKey);
  if (sourceId !== expected) {
    throw new TypeError('Monthly draw no-upload entry identity is invalid.');
  }
  return buildMonthlyDrawNoUploadSourceReference(userId, monthKey);
}

function queryWithSession(query, session) {
  return session && typeof query?.session === 'function'
    ? query.session(session)
    : query;
}

async function countWithSession(Model, filter, session) {
  return queryWithSession(Model.countDocuments(filter), session);
}

async function findLean(Model, filter, projection, session) {
  let query = Model.find(filter).select(projection);
  query = queryWithSession(query, session);
  return query.lean();
}

async function findOneLean(Model, filter, projection, session) {
  let query = Model.findOne(filter).select(projection);
  query = queryWithSession(query, session);
  return query.lean();
}

function isCurrentUploadEntry(upload, monthKey) {
  return upload?.monthlyDraw?.status === 'eligible' &&
    upload.monthlyDraw.monthKey === monthKey &&
    upload.monthlyDraw.rulesVersion === MONTHLY_DRAW_RULES_VERSION;
}

function isCurrentNoUploadEntry(entry, monthKey) {
  return entry?.monthKey === monthKey &&
    entry.rulesVersion === MONTHLY_DRAW_RULES_VERSION;
}

function normalizeEntry(sourceType, source, monthKey) {
  const userId = normalizeObjectId(source?.userId);
  return Object.freeze({
    sourceType,
    sourceId: normalizeSourceId(
      sourceType,
      source?._id,
      userId,
      monthKey,
    ),
    userId,
    entrantFingerprint: buildMonthlyDrawEntrantFingerprint(userId, monthKey),
  });
}

function requireRandomIndex(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) {
    throw new TypeError('Random selection returned an invalid pool index.');
  }
  return value;
}

export function selectWeightedDistinctCandidates(
  entries,
  randomInt = cryptoRandomInt,
) {
  if (!Array.isArray(entries) || typeof randomInt !== 'function') {
    throw new TypeError('A monthly draw entry array and random source are required.');
  }

  const entryCounts = new Map();
  let remaining = entries.map(entry => {
    if (
      !entry ||
      !['upload', 'no-upload'].includes(entry.sourceType) ||
      typeof entry.sourceId !== 'string' ||
      typeof entry.userId !== 'string' ||
      typeof entry.entrantFingerprint !== 'string'
    ) {
      throw new TypeError('A normalized monthly draw entry is required.');
    }
    entryCounts.set(entry.userId, (entryCounts.get(entry.userId) || 0) + 1);
    return entry;
  });

  const candidates = [];
  while (remaining.length > 0 && candidates.length < 3) {
    const selectedIndex = requireRandomIndex(
      randomInt(remaining.length),
      remaining.length,
    );
    const selectedEntry = remaining[selectedIndex];
    candidates.push(Object.freeze({
      rank: candidates.length + 1,
      entrantFingerprint: selectedEntry.entrantFingerprint,
      sourceType: selectedEntry.sourceType,
      sourceId: selectedEntry.sourceId,
      entryCount: entryCounts.get(selectedEntry.userId),
    }));
    remaining = remaining.filter(entry => entry.userId !== selectedEntry.userId);
  }

  return Object.freeze(candidates);
}

function plainResult(value) {
  if (!value) return null;
  return typeof value.toObject === 'function'
    ? value.toObject({ depopulate: true })
    : value;
}

function isDuplicateKeyError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 11000) return true;
  return error.cause && error.cause !== error
    ? isDuplicateKeyError(error.cause)
    : false;
}

export function createMonthlyDrawSelectionService({
  ResultModel = MonthlyDrawResult,
  UploadModel = Upload,
  NoUploadEntryModel = MonthlyDrawNoUploadEntry,
  UserModel = User,
  startSession = () => mongoose.connection.startSession(),
  randomInt = cryptoRandomInt,
  now = () => new Date(),
} = {}) {
  if (
    !ResultModel ||
    !UploadModel ||
    !NoUploadEntryModel ||
    !UserModel ||
    typeof startSession !== 'function' ||
    typeof randomInt !== 'function' ||
    typeof now !== 'function'
  ) {
    throw new TypeError('Monthly draw selection dependencies are required.');
  }

  async function countPending(monthKey, session) {
    const count = await countWithSession(UploadModel, {
      monthlyDraw: { $exists: true },
      'monthlyDraw.monthKey': monthKey,
      'monthlyDraw.status': 'pending',
    }, session);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('Invalid pending monthly draw upload count.');
    }
    return count;
  }

  async function readEligiblePool(monthKey, session) {
    const uploadRecords = await findLean(UploadModel, {
      monthlyDraw: { $exists: true },
      'monthlyDraw.status': 'eligible',
      'monthlyDraw.monthKey': monthKey,
      'monthlyDraw.rulesVersion': MONTHLY_DRAW_RULES_VERSION,
    }, MONTHLY_DRAW_UPLOAD_SELECTION_PROJECTION, session);
    const noUploadRecords = await findLean(NoUploadEntryModel, {
      monthKey,
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    }, MONTHLY_DRAW_NO_UPLOAD_SELECTION_PROJECTION, session);

    const normalized = [
      ...uploadRecords
        .filter(upload => isCurrentUploadEntry(upload, monthKey))
        .map(upload => normalizeEntry('upload', upload, monthKey)),
      ...noUploadRecords
        .filter(entry => isCurrentNoUploadEntry(entry, monthKey))
        .map(entry => normalizeEntry('no-upload', entry, monthKey)),
    ];
    const candidateUserIds = [...new Set(normalized.map(entry => entry.userId))];
    const accounts = await findLean(UserModel, {
      _id: { $in: candidateUserIds },
    }, MONTHLY_DRAW_ACCOUNT_SELECTION_PROJECTION, session);
    const eligibleAccountIds = new Set(accounts
      .filter(isMonthlyDrawEntrantAccountEligible)
      .map(account => normalizeObjectId(account._id)));
    const entries = normalized.filter(entry => eligibleAccountIds.has(entry.userId));
    const eligibleUploadEntries = entries
      .filter(entry => entry.sourceType === 'upload').length;
    const eligibleNoUploadEntries = entries.length - eligibleUploadEntries;

    return Object.freeze({
      entries: Object.freeze(entries),
      summary: Object.freeze({
        eligibleUploadEntries,
        eligibleNoUploadEntries,
        totalEligibleEntries: entries.length,
        eligibleDistinctEntrants: new Set(entries.map(entry => entry.userId)).size,
        excludedAccountEntries: normalized.length - entries.length,
      }),
    });
  }

  async function resultExists(monthKey, session) {
    const result = await findOneLean(
      ResultModel,
      { _id: buildMonthlyDrawResultId(monthKey) },
      { _id: 1 },
      session,
    );
    return Boolean(result);
  }

  async function inspectPool({ monthKey }) {
    requireMonthKey(monthKey);
    const [pendingUploads, existing, pool] = await Promise.all([
      countPending(monthKey),
      resultExists(monthKey),
      readEligiblePool(monthKey),
    ]);
    return Object.freeze({
      monthKey,
      pendingUploads,
      ...pool.summary,
      selectionReady: pendingUploads === 0 && !existing,
      resultAlreadyExists: existing,
    });
  }

  async function selectAndPersist({ monthKey }) {
    requireMonthKey(monthKey);
    const resultId = buildMonthlyDrawResultId(monthKey);
    const session = await startSession();
    if (!session || typeof session.withTransaction !== 'function') {
      try {
        await session?.endSession?.();
      } catch {
        // The stable setup failure below remains authoritative.
      }
      throw new TypeError('A transaction-capable MongoDB session is required.');
    }

    let transactionOutcome;
    try {
      try {
        await session.withTransaction(async () => {
          transactionOutcome = undefined;
          const existing = await findOneLean(
            ResultModel,
            { _id: resultId },
            null,
            session,
          );
          if (existing) {
            transactionOutcome = Object.freeze({
              state: 'result',
              created: false,
              monthKey,
              result: existing,
            });
            return;
          }

          const pendingUploads = await countPending(monthKey, session);
          if (pendingUploads > 0) {
            transactionOutcome = Object.freeze({
              state: 'blocked-pending-review',
              monthKey,
              pendingUploads,
              message: MONTHLY_DRAW_SELECTION_BLOCKED_MESSAGE,
            });
            return;
          }

          const pool = await readEligiblePool(monthKey, session);
          const candidates = selectWeightedDistinctCandidates(
            pool.entries,
            randomInt,
          );
          const selectedAt = now();
          if (
            !(selectedAt instanceof Date) ||
            Number.isNaN(selectedAt.valueOf())
          ) {
            throw new TypeError('A valid selection time is required.');
          }
          const resultData = {
            _id: resultId,
            monthKey,
            rulesVersion: MONTHLY_DRAW_RULES_VERSION,
            status: candidates.length > 0
              ? 'selected'
              : 'no-eligible-entries',
            selectedAt,
            candidates,
            poolSummary: {
              ...pool.summary,
              candidatesSelected: candidates.length,
              pendingUploadsAtSelection: 0,
            },
          };
          const created = await ResultModel.create([resultData], {
            session,
          });
          if (!Array.isArray(created) || created.length !== 1) {
            throw new TypeError('Monthly draw result creation failed.');
          }
          transactionOutcome = Object.freeze({
            state: 'result',
            created: true,
            monthKey,
            result: plainResult(created[0]),
          });
        }, DEFAULT_TRANSACTION_OPTIONS);
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await findOneLean(
          ResultModel,
          { _id: resultId },
          null,
          session,
        );
        if (!existing) throw error;
        transactionOutcome = Object.freeze({
          state: 'result',
          created: false,
          monthKey,
          result: existing,
        });
      }

      if (!transactionOutcome) {
        throw new TypeError('Monthly draw transaction returned no outcome.');
      }
      return transactionOutcome;
    } finally {
      try {
        await session.endSession?.();
      } catch {
        // Session teardown cannot change a committed result.
      }
    }
  }

  return Object.freeze({ inspectPool, selectAndPersist });
}

export const monthlyDrawSelection = createMonthlyDrawSelectionService();
