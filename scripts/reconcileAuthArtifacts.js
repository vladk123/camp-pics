import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Token } from '../models/token.js';
import { User } from '../models/user.js';
import {
  AUTH_ARTIFACT_AGE_BUCKETS,
  AUTH_ARTIFACT_DEFAULT_BATCH_SIZE,
  AUTH_ARTIFACT_DEFAULT_SAMPLE_LIMIT,
  AUTH_ARTIFACT_MAX_BATCH_SIZE,
  AUTH_ARTIFACT_MAX_SAMPLE_LIMIT,
  reconcileAuthArtifacts,
} from '../utils/authArtifactReconciliation.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const TOKEN_EXPIRY_PATH = 'email_verification_expiry';
const RESET_CODE_PATH = 'other_login.reset_password_code';
const RESET_EXPIRY_PATH = 'other_login.reset_password_expiry';
const RESET_CLAIM_PATH = 'other_login.reset_password_claim';
const RESET_COUNTER_PATH = 'other_login.reset_password_counter';
const RECOGNIZED_TOKEN_FIELDS = Object.freeze([
  '_id',
  'email_verification_code',
  'user_id',
  'email_verification_expiry',
  'date',
  '__v',
]);

export const AUTH_ARTIFACT_DIRECT_FAILURE_MESSAGE =
  'Authentication-artifact reconciliation failed.';
export const AUTH_ARTIFACT_INCOMPLETE_MESSAGE =
  'Authentication-artifact cleanup incomplete; review the safe summary and rerun.';

function parseBoundedInteger(value, argument, maximum) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${argument} must be an integer from 1 to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${argument} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export function parseAuthArtifactArguments(args) {
  let apply = false;
  let batchSize = AUTH_ARTIFACT_DEFAULT_BATCH_SIZE;
  let sampleLimit = AUTH_ARTIFACT_DEFAULT_SAMPLE_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--batch-size') {
      index += 1;
      batchSize = parseBoundedInteger(
        args[index],
        '--batch-size',
        AUTH_ARTIFACT_MAX_BATCH_SIZE,
      );
    } else if (argument.startsWith('--batch-size=')) {
      batchSize = parseBoundedInteger(
        argument.slice('--batch-size='.length),
        '--batch-size',
        AUTH_ARTIFACT_MAX_BATCH_SIZE,
      );
    } else if (argument === '--sample-limit') {
      index += 1;
      sampleLimit = parseBoundedInteger(
        args[index],
        '--sample-limit',
        AUTH_ARTIFACT_MAX_SAMPLE_LIMIT,
      );
    } else if (argument.startsWith('--sample-limit=')) {
      sampleLimit = parseBoundedInteger(
        argument.slice('--sample-limit='.length),
        '--sample-limit',
        AUTH_ARTIFACT_MAX_SAMPLE_LIMIT,
      );
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  return Object.freeze({ apply, batchSize, sampleLimit });
}

function fieldType(pathName) {
  return { $type: `$${pathName}` };
}

function typeEquals(pathName, bsonType) {
  return { $eq: [fieldType(pathName), bsonType] };
}

function stringKindExpression(pathName) {
  return {
    $switch: {
      branches: [
        { case: typeEquals(pathName, 'missing'), then: 'missing' },
        { case: typeEquals(pathName, 'null'), then: 'null' },
        {
          case: {
            $cond: [
              typeEquals(pathName, 'string'),
              { $gt: [{ $strLenBytes: `$${pathName}` }, 0] },
              false,
            ],
          },
          then: 'non-empty-string',
        },
      ],
      default: 'invalid',
    },
  };
}

function expiryKindExpression(pathName, now) {
  return {
    $switch: {
      branches: [
        { case: typeEquals(pathName, 'missing'), then: 'missing' },
        { case: typeEquals(pathName, 'null'), then: 'null' },
        {
          case: {
            $and: [
              typeEquals(pathName, 'date'),
              { $gt: [`$${pathName}`, now] },
            ],
          },
          then: 'active-date',
        },
        {
          case: {
            $and: [
              typeEquals(pathName, 'date'),
              { $lte: [`$${pathName}`, now] },
            ],
          },
          then: 'expired-date',
        },
      ],
      default: 'invalid',
    },
  };
}

function expiredAgeBucketExpression(pathName, now) {
  const daysAgo = days => new Date(
    now.getTime() - (days * DAY_IN_MILLISECONDS),
  );
  return {
    $cond: [
      {
        $and: [
          typeEquals(pathName, 'date'),
          { $lte: [`$${pathName}`, now] },
        ],
      },
      {
        $switch: {
          branches: [
            {
              case: { $gte: [`$${pathName}`, daysAgo(1)] },
              then: AUTH_ARTIFACT_AGE_BUCKETS.WITHIN_LAST_24_HOURS,
            },
            {
              case: { $gte: [`$${pathName}`, daysAgo(7)] },
              then: AUTH_ARTIFACT_AGE_BUCKETS.DAYS_2_TO_7,
            },
            {
              case: { $gte: [`$${pathName}`, daysAgo(30)] },
              then: AUTH_ARTIFACT_AGE_BUCKETS.DAYS_8_TO_30,
            },
            {
              case: { $gte: [`$${pathName}`, daysAgo(90)] },
              then: AUTH_ARTIFACT_AGE_BUCKETS.DAYS_31_TO_90,
            },
          ],
          default: AUTH_ARTIFACT_AGE_BUCKETS.MORE_THAN_90_DAYS,
        },
      },
      null,
    ],
  };
}

function counterKindExpression() {
  const numericTypes = ['int', 'long', 'double', 'decimal'];
  return {
    $switch: {
      branches: [
        {
          case: typeEquals(RESET_COUNTER_PATH, 'missing'),
          then: 'missing',
        },
        {
          case: {
            $cond: [
              { $in: [fieldType(RESET_COUNTER_PATH), numericTypes] },
              {
                $and: [
                  { $gte: [`$${RESET_COUNTER_PATH}`, 0] },
                  {
                    $eq: [
                      `$${RESET_COUNTER_PATH}`,
                      { $trunc: `$${RESET_COUNTER_PATH}` },
                    ],
                  },
                ],
              },
              false,
            ],
          },
          then: 'nonnegative-integer',
        },
      ],
      default: 'invalid',
    },
  };
}

function verificationAuditProjection(now) {
  return {
    _id: 1,
    expiryKind: expiryKindExpression(TOKEN_EXPIRY_PATH, now),
    userIdKind: {
      $switch: {
        branches: [
          { case: typeEquals('user_id', 'missing'), then: 'missing' },
          { case: typeEquals('user_id', 'null'), then: 'null' },
          { case: typeEquals('user_id', 'objectId'), then: 'object-id' },
        ],
        default: 'invalid',
      },
    },
    codeKind: stringKindExpression('email_verification_code'),
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
              RECOGNIZED_TOKEN_FIELDS,
            ],
          },
        },
        0,
      ],
    },
    ageBucket: expiredAgeBucketExpression(TOKEN_EXPIRY_PATH, now),
  };
}

function passwordResetAuditProjection(now) {
  const transientResetPaths = [
    RESET_CODE_PATH,
    RESET_EXPIRY_PATH,
    RESET_CLAIM_PATH,
  ];
  const allResetPaths = [...transientResetPaths, RESET_COUNTER_PATH];
  return {
    _id: 1,
    noResetFields: {
      $and: allResetPaths.map(pathName => typeEquals(pathName, 'missing')),
    },
    hasTransientResetArtifact: {
      $or: transientResetPaths.map(pathName => ({
        $ne: [fieldType(pathName), 'missing'],
      })),
    },
    expiryKind: expiryKindExpression(RESET_EXPIRY_PATH, now),
    codeKind: stringKindExpression(RESET_CODE_PATH),
    claimKind: stringKindExpression(RESET_CLAIM_PATH),
    counterKind: counterKindExpression(),
    ageBucket: expiredAgeBucketExpression(RESET_EXPIRY_PATH, now),
  };
}

async function* batchesFromCursor(cursor, batchSize) {
  let batch = [];
  for await (const row of cursor) {
    batch.push(row);
    if (batch.length === batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

function expiredDateFilter(pathName, now) {
  return {
    [pathName]: {
      $type: 'date',
      $lte: now,
    },
  };
}

function candidateIdBatches(collection, pathName, { batchSize, limit, now }) {
  const cursor = collection.find(expiredDateFilter(pathName, now), {
    projection: { _id: 1 },
    sort: { _id: 1 },
    batchSize,
    limit,
  });
  return batchesFromCursor(cursor, batchSize);
}

function normalizedCount(result, currentProperty, legacyProperty) {
  if (Number.isInteger(result?.[currentProperty])) {
    return result[currentProperty];
  }
  if (Number.isInteger(result?.[legacyProperty])) return result[legacyProperty];
  return null;
}

export function createMongoAuthArtifactRepository({
  TokenModel = Token,
  UserModel = User,
} = {}) {
  if (!TokenModel?.collection || !UserModel?.collection) {
    throw new TypeError('Token and User collections are required.');
  }
  const tokenCollection = TokenModel.collection;
  const userCollection = UserModel.collection;

  return {
    iterateVerificationAuditBatches({ batchSize, now }) {
      const cursor = tokenCollection.aggregate([
        { $sort: { _id: 1 } },
        { $project: verificationAuditProjection(now) },
      ], { allowDiskUse: true, batchSize });
      return batchesFromCursor(cursor, batchSize);
    },

    iteratePasswordResetAuditBatches({ batchSize, now }) {
      const cursor = userCollection.aggregate([
        { $sort: { _id: 1 } },
        { $project: passwordResetAuditProjection(now) },
      ], { allowDiskUse: true, batchSize });
      return batchesFromCursor(cursor, batchSize);
    },

    iterateVerificationCandidateIdBatches(options) {
      return candidateIdBatches(
        tokenCollection,
        TOKEN_EXPIRY_PATH,
        options,
      );
    },

    iteratePasswordResetCandidateIdBatches(options) {
      return candidateIdBatches(
        userCollection,
        RESET_EXPIRY_PATH,
        options,
      );
    },

    async deleteVerificationCandidateBatch({ candidateIds, now }) {
      const result = await tokenCollection.deleteMany({
        _id: { $in: candidateIds },
        ...expiredDateFilter(TOKEN_EXPIRY_PATH, now),
      });
      return {
        deletedCount: normalizedCount(result, 'deletedCount', 'n'),
      };
    },

    async clearPasswordResetCandidateBatch({ candidateIds, now }) {
      const result = await userCollection.updateMany(
        {
          _id: { $in: candidateIds },
          ...expiredDateFilter(RESET_EXPIRY_PATH, now),
        },
        {
          $unset: {
            [RESET_CODE_PATH]: '',
            [RESET_EXPIRY_PATH]: '',
            [RESET_CLAIM_PATH]: '',
          },
          $set: {
            [RESET_COUNTER_PATH]: 0,
          },
        },
      );
      return {
        modifiedCount: normalizedCount(result, 'modifiedCount', 'nModified'),
      };
    },

    countExpiredVerificationCandidates({ now }) {
      return tokenCollection.countDocuments(
        expiredDateFilter(TOKEN_EXPIRY_PATH, now),
      );
    },

    countExpiredPasswordResetCandidates({ now }) {
      return userCollection.countDocuments(
        expiredDateFilter(RESET_EXPIRY_PATH, now),
      );
    },

    getVerificationIndexDefinitions() {
      return tokenCollection.indexes();
    },

    getUserIndexDefinitions() {
      return userCollection.indexes();
    },
  };
}

export async function runAuthArtifactReconciliationCli(
  args = process.argv.slice(2),
  {
    TokenModel = Token,
    UserModel = User,
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
  const options = parseAuthArtifactArguments(args);
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('DB_URL is required');
  }

  await connect(databaseUrl, { autoIndex: false });
  try {
    const summary = await reconcileAuthArtifacts({
      repository: repository || createMongoAuthArtifactRepository({
        TokenModel,
        UserModel,
      }),
      ...options,
      clock,
    });
    output.log(JSON.stringify(summary, null, 2));
    if (options.apply && !summary.complete) {
      output.error(AUTH_ARTIFACT_INCOMPLETE_MESSAGE);
      markIncomplete();
    }
    return summary;
  } finally {
    await disconnect();
  }
}

export function handleAuthArtifactDirectFailure({
  output = console,
  setExitCode = value => {
    process.exitCode = value;
  },
} = {}) {
  output.error(AUTH_ARTIFACT_DIRECT_FAILURE_MESSAGE);
  setExitCode(1);
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runAuthArtifactReconciliationCli().catch(() => {
    handleAuthArtifactDirectFailure();
  });
}
