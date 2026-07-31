import { randomBytes } from 'node:crypto';

import cloudinary from '../config/cloudinary.js';
import {
  CLOUDINARY_PROVIDER_RESULT_UNEXPECTED,
  CLOUDINARY_PROVIDER_UNAVAILABLE,
  INVALID_CLOUDINARY_PUBLIC_ID,
  MediaCleanupJob,
} from '../models/mediaCleanupJob.js';
import {
  normalizeCloudinaryPublicId,
} from './cloudinaryPhotoIdentity.js';

export {
  CLOUDINARY_PROVIDER_RESULT_UNEXPECTED,
  CLOUDINARY_PROVIDER_UNAVAILABLE,
  INVALID_CLOUDINARY_PUBLIC_ID,
};

export const DEFAULT_MEDIA_CLEANUP_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_MEDIA_CLEANUP_BACKOFF_MS = 60 * 1000;
export const MAX_MEDIA_CLEANUP_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const MAX_MEDIA_CLEANUP_BATCH = 500;

function generatedLeaseToken() {
  return randomBytes(32).toString('hex');
}

function resultCount(result, currentName, legacyName) {
  const value = result?.[currentName] ?? result?.[legacyName];
  return Number.isInteger(value) ? value : null;
}

function requireNow(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('Cleanup job clock must return a valid Date.');
  }
  return value;
}

function eligibilityFilter(now, jobId = null) {
  return {
    ...(jobId == null ? {} : { _id: jobId }),
    $or: [
      {
        status: 'pending',
        nextAttemptAt: { $lte: now },
      },
      {
        status: 'processing',
        leaseExpiresAt: { $lte: now },
      },
    ],
  };
}

export function mediaCleanupBackoffMs(
  attemptCount,
  {
    initialMs = DEFAULT_MEDIA_CLEANUP_BACKOFF_MS,
    maximumMs = MAX_MEDIA_CLEANUP_BACKOFF_MS,
  } = {},
) {
  const safeAttempt = Number.isInteger(attemptCount) && attemptCount > 0
    ? attemptCount
    : 1;
  const exponent = Math.min(safeAttempt - 1, 30);
  return Math.min(maximumMs, initialMs * (2 ** exponent));
}

function validateLimit(limit) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_MEDIA_CLEANUP_BATCH
  ) {
    throw new RangeError(
      `Cleanup limit must be an integer from 1 to ${MAX_MEDIA_CLEANUP_BATCH}.`,
    );
  }
}

function summarizeResults(scanned, results, failed) {
  const summary = {
    scanned,
    claimed: 0,
    completed: 0,
    stillPending: 0,
    blocked: 0,
    skipped: 0,
    failed,
  };

  for (const result of results) {
    if (result?.claimed) summary.claimed += 1;
    if (result?.completed) {
      summary.completed += 1;
    } else if (result?.status === 'blocked') {
      summary.blocked += 1;
    } else if (
      result?.status === 'pending' ||
      result?.status === 'processing'
    ) {
      summary.stillPending += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return Object.freeze(summary);
}

export function createMediaCleanupJobProcessor({
  CleanupJobModel = MediaCleanupJob,
  cloudinaryClient = cloudinary,
  clock = () => new Date(),
  leaseTokenGenerator = generatedLeaseToken,
  leaseMs = DEFAULT_MEDIA_CLEANUP_LEASE_MS,
  backoff = mediaCleanupBackoffMs,
} = {}) {
  if (
    !CleanupJobModel ||
    !cloudinaryClient?.uploader ||
    typeof cloudinaryClient.uploader.destroy !== 'function'
  ) {
    throw new TypeError('Cleanup job dependencies are required.');
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60 * 60 * 1000) {
    throw new RangeError('Cleanup job lease must be from 1 second to 1 hour.');
  }

  async function describeUnclaimed(jobId) {
    const job = await CleanupJobModel.findOne(
      { _id: jobId },
      { status: 1 },
    );
    if (!job) {
      return Object.freeze({
        claimed: false,
        completed: false,
        status: 'skipped',
      });
    }
    return Object.freeze({
      claimed: false,
      completed: false,
      status: job.status === 'blocked'
        ? 'blocked'
        : job.status === 'processing'
          ? 'processing'
          : 'pending',
    });
  }

  async function releasePending({
    job,
    leaseToken,
    failureTime,
    failureCode,
  }) {
    const nextAttemptAt = new Date(
      failureTime.getTime() + backoff(job.attemptCount),
    );
    const result = await CleanupJobModel.updateOne(
      {
        _id: job._id,
        leaseToken,
      },
      {
        $set: {
          status: 'pending',
          nextAttemptAt,
          lastFailureCode: failureCode,
        },
        $unset: {
          leaseToken: '',
          leaseExpiresAt: '',
        },
      },
    );
    if (resultCount(result, 'matchedCount', 'n') !== 1) {
      return Object.freeze({
        claimed: true,
        completed: false,
        status: 'skipped',
        staleLease: true,
      });
    }
    return Object.freeze({
      claimed: true,
      completed: false,
      status: 'pending',
      failureCode,
      nextAttemptAt,
    });
  }

  async function blockMalformed(job, leaseToken) {
    const result = await CleanupJobModel.updateOne(
      {
        _id: job._id,
        leaseToken,
      },
      {
        $set: {
          status: 'blocked',
          lastFailureCode: INVALID_CLOUDINARY_PUBLIC_ID,
        },
        $unset: {
          leaseToken: '',
          leaseExpiresAt: '',
        },
      },
    );
    if (resultCount(result, 'matchedCount', 'n') !== 1) {
      return Object.freeze({
        claimed: true,
        completed: false,
        status: 'skipped',
        staleLease: true,
      });
    }
    return Object.freeze({
      claimed: true,
      completed: false,
      status: 'blocked',
      failureCode: INVALID_CLOUDINARY_PUBLIC_ID,
    });
  }

  async function processJobById(jobId) {
    if (!jobId) {
      return Object.freeze({
        claimed: false,
        completed: false,
        status: 'skipped',
      });
    }

    const claimTime = requireNow(clock);
    const leaseToken = leaseTokenGenerator();
    if (typeof leaseToken !== 'string' || leaseToken.length < 1) {
      throw new TypeError('Cleanup lease token generator returned no token.');
    }
    const leaseExpiresAt = new Date(claimTime.getTime() + leaseMs);
    const job = await CleanupJobModel.findOneAndUpdate(
      eligibilityFilter(claimTime, jobId),
      {
        $set: {
          status: 'processing',
          leaseToken,
          leaseExpiresAt,
          lastAttemptAt: claimTime,
        },
        $inc: {
          attemptCount: 1,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!job) return describeUnclaimed(jobId);

    const publicId = normalizeCloudinaryPublicId(
      job.cloudinaryPublicId,
    );
    if (!publicId || publicId !== job.cloudinaryPublicId) {
      return blockMalformed(job, leaseToken);
    }

    let providerResult;
    try {
      providerResult = await cloudinaryClient.uploader.destroy(publicId);
    } catch {
      const failureTime = requireNow(clock);
      return releasePending({
        job,
        leaseToken,
        failureTime,
        failureCode: CLOUDINARY_PROVIDER_UNAVAILABLE,
      });
    }

    if (
      providerResult?.result !== 'ok' &&
      providerResult?.result !== 'not found'
    ) {
      const failureTime = requireNow(clock);
      return releasePending({
        job,
        leaseToken,
        failureTime,
        failureCode: CLOUDINARY_PROVIDER_RESULT_UNEXPECTED,
      });
    }

    let finalized;
    try {
      finalized = await CleanupJobModel.deleteOne({
        _id: job._id,
        leaseToken,
      });
    } catch {
      return Object.freeze({
        claimed: true,
        completed: false,
        status: 'processing',
        failureCode: 'CLEANUP_FINALIZATION_FAILED',
      });
    }

    if (resultCount(finalized, 'deletedCount', 'n') !== 1) {
      return Object.freeze({
        claimed: true,
        completed: false,
        status: 'skipped',
        staleLease: true,
      });
    }
    return Object.freeze({
      claimed: true,
      completed: true,
      status: 'completed',
    });
  }

  async function processPendingJobs({ limit = 50 } = {}) {
    validateLimit(limit);
    const now = requireNow(clock);
    const jobs = await CleanupJobModel.find(
      eligibilityFilter(now),
      { _id: 1 },
      {
        limit,
        sort: {
          nextAttemptAt: 1,
          leaseExpiresAt: 1,
          _id: 1,
        },
      },
    );
    const results = [];
    let failed = 0;

    for (const job of jobs) {
      try {
        results.push(await processJobById(job._id));
      } catch {
        failed += 1;
      }
    }

    return summarizeResults(jobs.length, results, failed);
  }

  return Object.freeze({
    processJobById,
    processPendingJobs,
  });
}

const defaultMediaCleanupJobProcessor =
  createMediaCleanupJobProcessor();

export const processJobById =
  defaultMediaCleanupJobProcessor.processJobById;
export const processPendingJobs =
  defaultMediaCleanupJobProcessor.processPendingJobs;
