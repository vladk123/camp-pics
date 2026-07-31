import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Email } from '../models/email.js';
import {
  EMAIL_LOG_AGE_BUCKETS,
  EMAIL_LOG_DEFAULT_BATCH_SIZE,
  EMAIL_LOG_DEFAULT_SAMPLE_LIMIT,
  EMAIL_LOG_MAX_BATCH_SIZE,
  EMAIL_LOG_MAX_SAMPLE_LIMIT,
  reconcileEmailLogs,
} from '../utils/emailLogReconciliation.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const RECOGNIZED_EMAIL_FIELDS = Object.freeze([
  '_id',
  'to',
  'template',
  'subject',
  'html',
  'userId',
  'messageId',
  'sentAt',
  '__v',
]);

export const EMAIL_LOG_DIRECT_FAILURE_MESSAGE =
  'Email log reconciliation failed.';
export const EMAIL_LOG_INCOMPLETE_MESSAGE =
  'Email log redaction incomplete; review the summary and rerun safely.';

const sensitiveFieldFilter = Object.freeze({
  $or: [
    { html: { $exists: true } },
    { subject: { $exists: true } },
  ],
});

function parseBoundedInteger(value, argument, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(
      `${argument} must be an integer from 1 to ${maximum}`,
    );
  }
  return parsed;
}

export function parseEmailLogArguments(args) {
  let apply = false;
  let batchSize = EMAIL_LOG_DEFAULT_BATCH_SIZE;
  let sampleLimit = EMAIL_LOG_DEFAULT_SAMPLE_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--batch-size') {
      index += 1;
      batchSize = parseBoundedInteger(
        args[index],
        '--batch-size',
        EMAIL_LOG_MAX_BATCH_SIZE,
      );
    } else if (argument.startsWith('--batch-size=')) {
      batchSize = parseBoundedInteger(
        argument.slice('--batch-size='.length),
        '--batch-size',
        EMAIL_LOG_MAX_BATCH_SIZE,
      );
    } else if (argument === '--sample-limit') {
      index += 1;
      sampleLimit = parseBoundedInteger(
        args[index],
        '--sample-limit',
        EMAIL_LOG_MAX_SAMPLE_LIMIT,
      );
    } else if (argument.startsWith('--sample-limit=')) {
      sampleLimit = parseBoundedInteger(
        argument.slice('--sample-limit='.length),
        '--sample-limit',
        EMAIL_LOG_MAX_SAMPLE_LIMIT,
      );
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  return Object.freeze({ apply, batchSize, sampleLimit });
}

function fieldType(field) {
  return { $type: `$${field}` };
}

function fieldPresent(field) {
  return { $ne: [fieldType(field), 'missing'] };
}

function fieldHasType(field, type) {
  return { $eq: [fieldType(field), type] };
}

function dateBefore(field, date) {
  return {
    $cond: [
      fieldHasType(field, 'date'),
      { $lt: [`$${field}`, date] },
      false,
    ],
  };
}

function ageBucketExpression(now) {
  const daysAgo = days => new Date(
    now.getTime() - (days * DAY_IN_MILLISECONDS),
  );
  return {
    $cond: [
      fieldHasType('sentAt', 'date'),
      {
        $switch: {
          branches: [
            {
              case: { $gt: ['$sentAt', now] },
              then: EMAIL_LOG_AGE_BUCKETS.FUTURE_DATED,
            },
            {
              case: { $gte: ['$sentAt', daysAgo(30)] },
              then: EMAIL_LOG_AGE_BUCKETS.AGE_0_TO_30_DAYS,
            },
            {
              case: { $gte: ['$sentAt', daysAgo(90)] },
              then: EMAIL_LOG_AGE_BUCKETS.AGE_31_TO_90_DAYS,
            },
            {
              case: { $gte: ['$sentAt', daysAgo(180)] },
              then: EMAIL_LOG_AGE_BUCKETS.AGE_91_TO_180_DAYS,
            },
            {
              case: { $gte: ['$sentAt', daysAgo(365)] },
              then: EMAIL_LOG_AGE_BUCKETS.AGE_181_TO_365_DAYS,
            },
          ],
          default: EMAIL_LOG_AGE_BUCKETS.OLDER_THAN_365_DAYS,
        },
      },
      {
        $cond: [
          { $eq: [fieldType('sentAt'), 'missing'] },
          EMAIL_LOG_AGE_BUCKETS.MISSING_SENT_AT,
          EMAIL_LOG_AGE_BUCKETS.INVALID_SENT_AT,
        ],
      },
    ],
  };
}

function auditProjection(now) {
  const daysAgo = days => new Date(
    now.getTime() - (days * DAY_IN_MILLISECONDS),
  );
  return {
    _id: 1,
    htmlPresent: fieldPresent('html'),
    subjectPresent: fieldPresent('subject'),
    templatePresent: fieldPresent('template'),
    templateValid: fieldHasType('template', 'string'),
    userIdPresent: fieldPresent('userId'),
    userIdValid: fieldHasType('userId', 'objectId'),
    messageIdPresent: fieldPresent('messageId'),
    messageIdValid: fieldHasType('messageId', 'string'),
    recipientValid: {
      $cond: [
        fieldHasType('to', 'string'),
        { $gt: [{ $strLenBytes: '$to' }, 0] },
        false,
      ],
    },
    unknownTopLevelFields: {
      $gt: [
        {
          $size: {
            $setDifference: [
              {
                $map: {
                  input: { $objectToArray: '$$ROOT' },
                  as: 'field',
                  in: '$$field.k',
                },
              },
              RECOGNIZED_EMAIL_FIELDS,
            ],
          },
        },
        0,
      ],
    },
    ageBucket: ageBucketExpression(now),
    olderThan30Days: dateBefore('sentAt', daysAgo(30)),
    olderThan90Days: dateBefore('sentAt', daysAgo(90)),
    olderThan180Days: dateBefore('sentAt', daysAgo(180)),
    olderThan365Days: dateBefore('sentAt', daysAgo(365)),
  };
}

async function* batchesFromCursor(cursor, batchSize) {
  let batch = [];
  for await (const value of cursor) {
    batch.push(value);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

function modifiedCount(result) {
  return Number.isInteger(result?.modifiedCount)
    ? result.modifiedCount
    : Number.isInteger(result?.nModified)
      ? result.nModified
      : null;
}

export function createMongoEmailLogRepository({ EmailModel = Email } = {}) {
  if (!EmailModel?.collection) {
    throw new TypeError('An Email collection is required.');
  }
  const collection = EmailModel.collection;

  return {
    iterateAuditBatches({ batchSize, now }) {
      const cursor = collection.aggregate([
        { $sort: { _id: 1 } },
        { $project: auditProjection(now) },
      ], {
        allowDiskUse: true,
        batchSize,
      });
      return batchesFromCursor(cursor, batchSize);
    },

    iterateCandidateIdBatches({ batchSize, limit }) {
      const cursor = collection.find(sensitiveFieldFilter, {
        projection: { _id: 1 },
        sort: { _id: 1 },
        batchSize,
        limit,
      });
      return batchesFromCursor(cursor, batchSize);
    },

    async redactCandidateBatch(emailIds) {
      const result = await collection.updateMany(
        {
          _id: { $in: emailIds },
          $or: sensitiveFieldFilter.$or,
        },
        {
          $unset: {
            html: '',
            subject: '',
          },
        },
      );
      return { modifiedCount: modifiedCount(result) };
    },

    countSensitiveDocuments() {
      return collection.countDocuments(sensitiveFieldFilter);
    },

    getIndexDefinitions() {
      return collection.indexes();
    },
  };
}

export async function runEmailLogReconciliationCli(
  args = process.argv.slice(2),
  {
    EmailModel = Email,
    repository,
    connect = (url, options) => mongoose.connect(url, options),
    disconnect = () => mongoose.disconnect(),
    databaseUrl = process.env.DB_URL,
    clock = () => new Date(),
    output = console,
    markIncomplete = () => {
      process.exitCode = 2;
    },
  } = {},
) {
  const options = parseEmailLogArguments(args);
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('DB_URL is required');
  }

  await connect(databaseUrl, { autoIndex: false });
  try {
    const summary = await reconcileEmailLogs({
      repository: repository || createMongoEmailLogRepository({ EmailModel }),
      ...options,
      now: clock,
    });
    output.log(JSON.stringify(summary, null, 2));
    if (summary.incomplete) {
      output.error(EMAIL_LOG_INCOMPLETE_MESSAGE);
      markIncomplete();
    }
    return summary;
  } finally {
    await disconnect();
  }
}

export function handleEmailLogDirectFailure({
  output = console,
  setExitCode = value => {
    process.exitCode = value;
  },
} = {}) {
  output.error(EMAIL_LOG_DIRECT_FAILURE_MESSAGE);
  setExitCode(1);
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runEmailLogReconciliationCli().catch(() => {
    handleEmailLogDirectFailure();
  });
}
