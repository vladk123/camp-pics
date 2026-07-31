import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MediaCleanupJob } from '../models/mediaCleanupJob.js';
import {
  MAX_MEDIA_CLEANUP_BATCH,
  createMediaCleanupJobProcessor,
} from '../utils/mediaCleanupJobs.js';

const DEFAULT_LIMIT = 50;

function parseJobId(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-f\d]{24}$/iu.test(value) ||
    !mongoose.Types.ObjectId.isValid(value)
  ) {
    throw new Error('--job-id must be a 24-character MongoDB ObjectId');
  }
  return value;
}

export function parseMediaCleanupArguments(args) {
  let apply = false;
  let limit = DEFAULT_LIMIT;
  let jobId = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--limit') {
      index += 1;
      limit = Number(args[index]);
    } else if (argument.startsWith('--limit=')) {
      limit = Number(argument.slice('--limit='.length));
    } else if (argument === '--job-id') {
      index += 1;
      jobId = parseJobId(args[index]);
    } else if (argument.startsWith('--job-id=')) {
      jobId = parseJobId(argument.slice('--job-id='.length));
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_MEDIA_CLEANUP_BATCH
  ) {
    throw new Error(
      `--limit must be an integer from 1 to ${MAX_MEDIA_CLEANUP_BATCH}`,
    );
  }

  return Object.freeze({ apply, limit, jobId });
}

function scopedFilter(jobId, filter) {
  return jobId ? { _id: jobId, ...filter } : filter;
}

function redactedSample(job) {
  return Object.freeze({
    jobId: job?._id?.toString?.() ?? String(job?._id),
    mediaId: job?.mediaId?.toString?.() ?? String(job?.mediaId),
  });
}

export async function auditMediaCleanupJobs({
  CleanupJobModel,
  limit,
  jobId = null,
  now = new Date(),
}) {
  const [pending, reclaimableExpiredLeases, blocked, samples] =
    await Promise.all([
      CleanupJobModel.countDocuments(
        scopedFilter(jobId, { status: 'pending' }),
      ),
      CleanupJobModel.countDocuments(scopedFilter(jobId, {
        status: 'processing',
        leaseExpiresAt: { $lte: now },
      })),
      CleanupJobModel.countDocuments(
        scopedFilter(jobId, { status: 'blocked' }),
      ),
      CleanupJobModel.find(
        scopedFilter(jobId, {
          $or: [
            { status: 'pending' },
            {
              status: 'processing',
              leaseExpiresAt: { $lte: now },
            },
            { status: 'blocked' },
          ],
        }),
        {
          _id: 1,
          mediaId: 1,
        },
        {
          limit,
          sort: { _id: 1 },
        },
      ),
    ]);

  return Object.freeze({
    mode: 'dry-run',
    pending,
    reclaimableExpiredLeases,
    blocked,
    samples: Object.freeze(samples.map(redactedSample)),
  });
}

function summarizeSingleResult(result, failed = 0) {
  return Object.freeze({
    scanned: 1,
    claimed: result?.claimed ? 1 : 0,
    completed: result?.completed ? 1 : 0,
    stillPending:
      result?.status === 'pending' ||
      result?.status === 'processing'
        ? 1
        : 0,
    blocked: result?.status === 'blocked' ? 1 : 0,
    skipped: failed > 0 ? 0 : (
      !result?.completed &&
      result?.status !== 'pending' &&
      result?.status !== 'processing' &&
      result?.status !== 'blocked'
        ? 1
        : 0
    ),
    failed,
  });
}

export async function runMediaCleanupCli(
  args = process.argv.slice(2),
  {
    CleanupJobModel = MediaCleanupJob,
    processor,
    connect = (url, options) => mongoose.connect(url, options),
    disconnect = () => mongoose.disconnect(),
    databaseUrl = process.env.DB_URL,
    clock = () => new Date(),
    output = console,
  } = {},
) {
  const options = parseMediaCleanupArguments(args);
  if (!databaseUrl) throw new Error('DB_URL is required');

  await connect(databaseUrl, { autoIndex: false });
  try {
    if (!options.apply) {
      const summary = await auditMediaCleanupJobs({
        CleanupJobModel,
        limit: options.limit,
        jobId: options.jobId,
        now: clock(),
      });
      output.log(JSON.stringify(summary, null, 2));
      return summary;
    }

    const activeProcessor = processor ||
      createMediaCleanupJobProcessor({ CleanupJobModel });
    let summary;
    if (options.jobId) {
      try {
        const result = await activeProcessor.processJobById(
          options.jobId,
        );
        summary = summarizeSingleResult(result);
      } catch {
        summary = summarizeSingleResult(null, 1);
      }
    } else {
      summary = await activeProcessor.processPendingJobs({
        limit: options.limit,
      });
    }
    output.log(JSON.stringify({ mode: 'apply', ...summary }, null, 2));
    return summary;
  } finally {
    await disconnect();
  }
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runMediaCleanupCli().catch(() => {
    console.error('Media cleanup job processor failed to start.');
    process.exitCode = 1;
  });
}
