export const AUTH_ARTIFACT_DEFAULT_BATCH_SIZE = 100;
export const AUTH_ARTIFACT_MAX_BATCH_SIZE = 1000;
export const AUTH_ARTIFACT_DEFAULT_SAMPLE_LIMIT = 20;
export const AUTH_ARTIFACT_MAX_SAMPLE_LIMIT = 100;

export const AUTH_ARTIFACT_AGE_BUCKETS = Object.freeze({
  WITHIN_LAST_24_HOURS: 'withinLast24Hours',
  DAYS_2_TO_7: 'days2To7',
  DAYS_8_TO_30: 'days8To30',
  DAYS_31_TO_90: 'days31To90',
  MORE_THAN_90_DAYS: 'moreThan90Days',
});

export const VERIFICATION_TOKEN_ISSUES = Object.freeze({
  EXPIRED: 'expired-verification-token',
  MISSING_EXPIRY: 'missing-verification-expiry',
  NULL_EXPIRY: 'null-verification-expiry',
  INVALID_EXPIRY: 'invalid-verification-expiry',
  MISSING_USER_ID: 'missing-verification-user-id',
  NULL_USER_ID: 'null-verification-user-id',
  INVALID_USER_ID: 'invalid-verification-user-id',
  MISSING_CODE: 'missing-verification-code',
  NULL_CODE: 'null-verification-code',
  INVALID_CODE: 'invalid-verification-code',
  UNKNOWN_FIELDS: 'unknown-token-fields',
});

export const PASSWORD_RESET_ISSUES = Object.freeze({
  EXPIRED: 'expired-password-reset-state',
  MISSING_EXPIRY: 'missing-reset-expiry',
  INVALID_EXPIRY: 'invalid-reset-expiry',
  INVALID_CODE: 'invalid-reset-code',
  INVALID_CLAIM: 'invalid-reset-claim',
  INVALID_COUNTER: 'invalid-reset-counter',
  CLAIM_WITHOUT_CODE: 'claim-without-code',
  EXPIRY_WITHOUT_CODE: 'expiry-without-code',
});

const TOKEN_EXPIRY_KINDS = new Set([
  'active-date',
  'expired-date',
  'missing',
  'null',
  'invalid',
]);
const USER_ID_KINDS = new Set(['object-id', 'missing', 'null', 'invalid']);
const STRING_FIELD_KINDS = new Set([
  'non-empty-string',
  'missing',
  'null',
  'invalid',
]);
const RESET_EXPIRY_KINDS = new Set([
  'active-date',
  'expired-date',
  'missing',
  'null',
  'invalid',
]);
const COUNTER_KINDS = new Set([
  'nonnegative-integer',
  'missing',
  'invalid',
]);
const AGE_BUCKET_VALUES = new Set(Object.values(AUTH_ARTIFACT_AGE_BUCKETS));

const REPOSITORY_METHODS = Object.freeze([
  'iterateVerificationAuditBatches',
  'iteratePasswordResetAuditBatches',
  'iterateVerificationCandidateIdBatches',
  'iteratePasswordResetCandidateIdBatches',
  'deleteVerificationCandidateBatch',
  'clearPasswordResetCandidateBatch',
  'countExpiredVerificationCandidates',
  'countExpiredPasswordResetCandidates',
  'getVerificationIndexDefinitions',
  'getUserIndexDefinitions',
]);

function requireRepository(repository) {
  if (
    !repository ||
    REPOSITORY_METHODS.some(method => typeof repository[method] !== 'function')
  ) {
    throw new TypeError('An authentication-artifact repository is required.');
  }
}

function assertBoundedInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
}

function createAgeBuckets() {
  return {
    withinLast24Hours: 0,
    days2To7: 0,
    days8To30: 0,
    days31To90: 0,
    moreThan90Days: 0,
  };
}

function createVerificationSummary() {
  return {
    scanned: 0,
    planned: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    malformed: 0,
    remainingExpired: 0,
    shape: {
      totalDocuments: 0,
      expiryActiveDate: 0,
      expiryExpiredDate: 0,
      expiryMissing: 0,
      expiryNull: 0,
      expiryInvalidType: 0,
      userIdObjectId: 0,
      userIdMissing: 0,
      userIdNull: 0,
      userIdInvalidType: 0,
      verificationCodeNonEmptyString: 0,
      verificationCodeMissing: 0,
      verificationCodeNull: 0,
      verificationCodeEmptyOrInvalid: 0,
      unknownTopLevelFields: 0,
    },
    ageBuckets: createAgeBuckets(),
    samples: {
      candidates: [],
      malformed: [],
    },
  };
}

function createPasswordResetSummary() {
  return {
    scanned: 0,
    planned: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    malformed: 0,
    remainingExpired: 0,
    shape: {
      noResetFields: 0,
      counterOnlyState: 0,
      invalidCounterOnlyState: 0,
      transientResetArtifactsPresent: 0,
      expiryActiveDate: 0,
      expiryExpiredDate: 0,
      expiryMissingWithOtherArtifact: 0,
      expiryNullWithOtherArtifact: 0,
      expiryInvalidType: 0,
      codeNonEmptyString: 0,
      codeMissing: 0,
      codeNull: 0,
      codeEmptyOrInvalid: 0,
      claimMissing: 0,
      claimNull: 0,
      claimNonEmptyString: 0,
      claimEmptyOrInvalid: 0,
      counterMissing: 0,
      counterNonnegativeInteger: 0,
      counterInvalid: 0,
    },
    ageBuckets: createAgeBuckets(),
    samples: {
      candidates: [],
      malformed: [],
    },
  };
}

function safeRecordId(value) {
  const candidate = typeof value === 'string'
    ? value
    : typeof value?.toHexString === 'function'
      ? value.toHexString()
      : null;
  return typeof candidate === 'string' && /^[a-f\d]{24}$/iu.test(candidate)
    ? candidate.toLowerCase()
    : 'unavailable';
}

function addSample(samples, rowId, issues, sampleLimit) {
  if (samples.length >= sampleLimit) return;
  samples.push({
    recordId: safeRecordId(rowId),
    issues: [...issues],
  });
}

function validateAuditBatch(batch, batchSize, label) {
  if (!Array.isArray(batch) || batch.length > batchSize) {
    throw new TypeError(`Repository returned an invalid ${label} audit batch.`);
  }
}

function validateAgeBucket(row, expired, label) {
  if (expired && !AGE_BUCKET_VALUES.has(row.ageBucket)) {
    throw new TypeError(`Repository returned an invalid ${label} age bucket.`);
  }
  if (!expired && row.ageBucket != null) {
    throw new TypeError(`Repository returned an unexpected ${label} age bucket.`);
  }
}

function incrementExpiryShape(shape, kind, prefix = 'expiry') {
  const property = {
    'active-date': `${prefix}ActiveDate`,
    'expired-date': `${prefix}ExpiredDate`,
    missing: `${prefix}Missing`,
    null: `${prefix}Null`,
    invalid: `${prefix}InvalidType`,
  }[kind];
  shape[property] += 1;
}

function auditVerificationRow(summary, row, sampleLimit) {
  if (
    !row ||
    !Object.hasOwn(row, '_id') ||
    !TOKEN_EXPIRY_KINDS.has(row.expiryKind) ||
    !USER_ID_KINDS.has(row.userIdKind) ||
    !STRING_FIELD_KINDS.has(row.codeKind) ||
    typeof row.unknownTopLevelFields !== 'boolean'
  ) {
    throw new TypeError('Repository returned an invalid verification audit row.');
  }

  const expired = row.expiryKind === 'expired-date';
  validateAgeBucket(row, expired, 'verification-token');
  summary.scanned += 1;
  summary.shape.totalDocuments += 1;
  incrementExpiryShape(summary.shape, row.expiryKind);

  const issues = [];
  const expiryIssue = {
    missing: VERIFICATION_TOKEN_ISSUES.MISSING_EXPIRY,
    null: VERIFICATION_TOKEN_ISSUES.NULL_EXPIRY,
    invalid: VERIFICATION_TOKEN_ISSUES.INVALID_EXPIRY,
  }[row.expiryKind];
  if (expiryIssue) issues.push(expiryIssue);

  const userIdShape = {
    'object-id': 'userIdObjectId',
    missing: 'userIdMissing',
    null: 'userIdNull',
    invalid: 'userIdInvalidType',
  }[row.userIdKind];
  summary.shape[userIdShape] += 1;
  const userIdIssue = {
    missing: VERIFICATION_TOKEN_ISSUES.MISSING_USER_ID,
    null: VERIFICATION_TOKEN_ISSUES.NULL_USER_ID,
    invalid: VERIFICATION_TOKEN_ISSUES.INVALID_USER_ID,
  }[row.userIdKind];
  if (userIdIssue) issues.push(userIdIssue);

  const codeShape = {
    'non-empty-string': 'verificationCodeNonEmptyString',
    missing: 'verificationCodeMissing',
    null: 'verificationCodeNull',
    invalid: 'verificationCodeEmptyOrInvalid',
  }[row.codeKind];
  summary.shape[codeShape] += 1;
  const codeIssue = {
    missing: VERIFICATION_TOKEN_ISSUES.MISSING_CODE,
    null: VERIFICATION_TOKEN_ISSUES.NULL_CODE,
    invalid: VERIFICATION_TOKEN_ISSUES.INVALID_CODE,
  }[row.codeKind];
  if (codeIssue) issues.push(codeIssue);

  if (row.unknownTopLevelFields) {
    summary.shape.unknownTopLevelFields += 1;
    issues.push(VERIFICATION_TOKEN_ISSUES.UNKNOWN_FIELDS);
  }

  if (expired) {
    summary.planned += 1;
    summary.ageBuckets[row.ageBucket] += 1;
    addSample(
      summary.samples.candidates,
      row._id,
      [VERIFICATION_TOKEN_ISSUES.EXPIRED],
      sampleLimit,
    );
  }

  if (issues.length > 0) {
    summary.malformed += 1;
    addSample(summary.samples.malformed, row._id, issues, sampleLimit);
  }
}

function incrementStringShape(shape, kind, properties) {
  shape[properties[kind]] += 1;
}

function auditPasswordResetRow(summary, row, sampleLimit) {
  if (
    !row ||
    !Object.hasOwn(row, '_id') ||
    typeof row.noResetFields !== 'boolean' ||
    typeof row.hasTransientResetArtifact !== 'boolean' ||
    !RESET_EXPIRY_KINDS.has(row.expiryKind) ||
    !STRING_FIELD_KINDS.has(row.codeKind) ||
    !STRING_FIELD_KINDS.has(row.claimKind) ||
    !COUNTER_KINDS.has(row.counterKind)
  ) {
    throw new TypeError('Repository returned an invalid password-reset audit row.');
  }
  const inferredTransientArtifact =
    row.expiryKind !== 'missing' ||
    row.codeKind !== 'missing' ||
    row.claimKind !== 'missing';
  const inferredNoResetFields =
    !inferredTransientArtifact && row.counterKind === 'missing';
  if (
    row.hasTransientResetArtifact !== inferredTransientArtifact ||
    row.noResetFields !== inferredNoResetFields
  ) {
    throw new TypeError('Repository returned inconsistent password-reset state.');
  }

  const expired = row.expiryKind === 'expired-date';
  validateAgeBucket(row, expired, 'password-reset');
  summary.scanned += 1;
  if (row.noResetFields) summary.shape.noResetFields += 1;
  if (row.hasTransientResetArtifact) {
    summary.shape.transientResetArtifactsPresent += 1;
  } else if (row.counterKind === 'nonnegative-integer') {
    summary.shape.counterOnlyState += 1;
  } else if (row.counterKind === 'invalid') {
    summary.shape.invalidCounterOnlyState += 1;
  }

  if (row.expiryKind === 'missing') {
    if (row.hasTransientResetArtifact) {
      summary.shape.expiryMissingWithOtherArtifact += 1;
    }
  } else if (row.expiryKind === 'null') {
    summary.shape.expiryNullWithOtherArtifact += 1;
  } else {
    incrementExpiryShape(summary.shape, row.expiryKind);
  }

  incrementStringShape(summary.shape, row.codeKind, {
    'non-empty-string': 'codeNonEmptyString',
    missing: 'codeMissing',
    null: 'codeNull',
    invalid: 'codeEmptyOrInvalid',
  });
  incrementStringShape(summary.shape, row.claimKind, {
    'non-empty-string': 'claimNonEmptyString',
    missing: 'claimMissing',
    null: 'claimNull',
    invalid: 'claimEmptyOrInvalid',
  });
  incrementStringShape(summary.shape, row.counterKind, {
    'nonnegative-integer': 'counterNonnegativeInteger',
    missing: 'counterMissing',
    invalid: 'counterInvalid',
  });

  const issues = [];
  if (
    row.hasTransientResetArtifact &&
    (row.expiryKind === 'missing' || row.expiryKind === 'null')
  ) {
    issues.push(PASSWORD_RESET_ISSUES.MISSING_EXPIRY);
  } else if (row.expiryKind === 'invalid') {
    issues.push(PASSWORD_RESET_ISSUES.INVALID_EXPIRY);
  }
  if (row.codeKind === 'invalid') {
    issues.push(PASSWORD_RESET_ISSUES.INVALID_CODE);
  }
  if (row.claimKind === 'invalid') {
    issues.push(PASSWORD_RESET_ISSUES.INVALID_CLAIM);
  }
  if (row.counterKind === 'invalid') {
    issues.push(PASSWORD_RESET_ISSUES.INVALID_COUNTER);
  }
  if (
    row.claimKind === 'non-empty-string' &&
    row.codeKind !== 'non-empty-string'
  ) {
    issues.push(PASSWORD_RESET_ISSUES.CLAIM_WITHOUT_CODE);
  }
  if (
    row.expiryKind !== 'missing' &&
    row.codeKind !== 'non-empty-string'
  ) {
    issues.push(PASSWORD_RESET_ISSUES.EXPIRY_WITHOUT_CODE);
  }

  if (expired) {
    summary.planned += 1;
    summary.ageBuckets[row.ageBucket] += 1;
    addSample(
      summary.samples.candidates,
      row._id,
      [PASSWORD_RESET_ISSUES.EXPIRED],
      sampleLimit,
    );
  }

  if (issues.length > 0) {
    summary.malformed += 1;
    addSample(summary.samples.malformed, row._id, issues, sampleLimit);
  }
}

function candidateIdsFromBatch(batch, batchSize, label) {
  if (!Array.isArray(batch) || batch.length > batchSize || batch.length === 0) {
    throw new TypeError(`Repository returned an invalid ${label} candidate batch.`);
  }
  return batch.map(candidate => {
    if (
      !candidate ||
      !Object.hasOwn(candidate, '_id') ||
      Object.keys(candidate).some(key => key !== '_id')
    ) {
      throw new TypeError(`${label} candidate batches may contain only IDs.`);
    }
    return candidate._id;
  });
}

function requireWriteCount(result, property, batchLength, label) {
  const count = result?.[property];
  if (!Number.isInteger(count) || count < 0 || count > batchLength) {
    throw new TypeError(`${label} returned an invalid write count.`);
  }
  return count;
}

function safeIndexNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = value?.toString?.();
  if (typeof text === 'string' && /^-?\d+(?:\.\d+)?$/u.test(text)) {
    const converted = Number(text);
    if (Number.isFinite(converted)) return converted;
  }
  return null;
}

function summarizeIndex(index) {
  const summary = {};
  if (typeof index?.name === 'string') summary.name = index.name;
  if (index?.key && typeof index.key === 'object' && !Array.isArray(index.key)) {
    summary.key = Object.fromEntries(
      Object.entries(index.key).filter(([, direction]) =>
        typeof direction === 'string' ||
        (typeof direction === 'number' && Number.isFinite(direction))),
    );
  }
  if (typeof index?.unique === 'boolean') summary.unique = index.unique;
  if (typeof index?.sparse === 'boolean') summary.sparse = index.sparse;
  if (Object.hasOwn(index || {}, 'expireAfterSeconds')) {
    const value = safeIndexNumber(index.expireAfterSeconds);
    if (value !== null) summary.expireAfterSeconds = value;
  }
  return summary;
}

export function summarizeAuthArtifactIndexes(indexes) {
  if (!Array.isArray(indexes)) {
    throw new TypeError('Authentication-artifact indexes must be an array.');
  }
  return indexes.map(summarizeIndex);
}

async function processCandidateBatches({
  iterator,
  writeBatch,
  summary,
  batchSize,
  planned,
  now,
  countProperty,
  label,
}) {
  let candidateIdsSeen = 0;
  try {
    for await (const batch of iterator({ batchSize, limit: planned, now })) {
      const candidateIds = candidateIdsFromBatch(batch, batchSize, label);
      candidateIdsSeen += candidateIds.length;
      try {
        const result = await writeBatch(candidateIds, now);
        const changed = requireWriteCount(
          result,
          countProperty,
          candidateIds.length,
          label,
        );
        summary.changed += changed;
        summary.skipped += candidateIds.length - changed;
      } catch {
        summary.failed += candidateIds.length;
        return false;
      }
    }
  } catch {
    throw new TypeError(`${label} candidate iteration failed.`);
  }
  summary.skipped += Math.max(0, planned - candidateIdsSeen);
  return true;
}

function requireCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} returned an invalid count.`);
  }
  return value;
}

async function recountRemaining(repository, now) {
  const [verificationResult, passwordResult] = await Promise.allSettled([
    repository.countExpiredVerificationCandidates({ now }),
    repository.countExpiredPasswordResetCandidates({ now }),
  ]);
  if (
    verificationResult.status !== 'fulfilled' ||
    passwordResult.status !== 'fulfilled'
  ) {
    throw new TypeError('Authentication-artifact recount failed.');
  }
  return {
    verification: requireCount(
      verificationResult.value,
      'Verification-token recount',
    ),
    password: requireCount(
      passwordResult.value,
      'Password-reset recount',
    ),
  };
}

export async function reconcileAuthArtifacts({
  repository,
  apply = false,
  batchSize = AUTH_ARTIFACT_DEFAULT_BATCH_SIZE,
  sampleLimit = AUTH_ARTIFACT_DEFAULT_SAMPLE_LIMIT,
  clock = () => new Date(),
} = {}) {
  requireRepository(repository);
  if (typeof apply !== 'boolean') {
    throw new TypeError('Authentication-artifact apply mode must be boolean.');
  }
  assertBoundedInteger(
    batchSize,
    'Authentication-artifact batch size',
    AUTH_ARTIFACT_MAX_BATCH_SIZE,
  );
  assertBoundedInteger(
    sampleLimit,
    'Authentication-artifact sample limit',
    AUTH_ARTIFACT_MAX_SAMPLE_LIMIT,
  );
  if (typeof clock !== 'function') {
    throw new TypeError('Authentication-artifact reconciliation needs a clock.');
  }
  const auditNow = clock();
  if (!(auditNow instanceof Date) || Number.isNaN(auditNow.getTime())) {
    throw new TypeError('Authentication-artifact clock returned an invalid date.');
  }
  const now = new Date(auditNow);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    complete: true,
    verificationTokens: createVerificationSummary(),
    passwordResetUsers: createPasswordResetSummary(),
    indexes: {
      tokens: [],
      users: [],
    },
  };

  const [tokenIndexes, userIndexes] = await Promise.all([
    repository.getVerificationIndexDefinitions(),
    repository.getUserIndexDefinitions(),
  ]);
  summary.indexes.tokens = summarizeAuthArtifactIndexes(tokenIndexes);
  summary.indexes.users = summarizeAuthArtifactIndexes(userIndexes);

  for await (const batch of repository.iterateVerificationAuditBatches({
    batchSize,
    now,
  })) {
    validateAuditBatch(batch, batchSize, 'verification-token');
    for (const row of batch) {
      auditVerificationRow(summary.verificationTokens, row, sampleLimit);
    }
  }
  for await (const batch of repository.iteratePasswordResetAuditBatches({
    batchSize,
    now,
  })) {
    validateAuditBatch(batch, batchSize, 'password-reset');
    for (const row of batch) {
      auditPasswordResetRow(summary.passwordResetUsers, row, sampleLimit);
    }
  }

  summary.verificationTokens.skipped =
    summary.verificationTokens.scanned - summary.verificationTokens.planned;
  summary.passwordResetUsers.skipped =
    summary.passwordResetUsers.scanned - summary.passwordResetUsers.planned;

  if (apply) {
    let writesMayContinue = true;
    if (summary.verificationTokens.planned > 0) {
      writesMayContinue = await processCandidateBatches({
        iterator: options =>
          repository.iterateVerificationCandidateIdBatches(options),
        writeBatch: (candidateIds, writeNow) =>
          repository.deleteVerificationCandidateBatch({
            candidateIds,
            now: writeNow,
          }),
        summary: summary.verificationTokens,
        batchSize,
        planned: summary.verificationTokens.planned,
        now,
        countProperty: 'deletedCount',
        label: 'Verification-token cleanup',
      });
    }
    if (writesMayContinue && summary.passwordResetUsers.planned > 0) {
      writesMayContinue = await processCandidateBatches({
        iterator: options =>
          repository.iteratePasswordResetCandidateIdBatches(options),
        writeBatch: (candidateIds, writeNow) =>
          repository.clearPasswordResetCandidateBatch({
            candidateIds,
            now: writeNow,
          }),
        summary: summary.passwordResetUsers,
        batchSize,
        planned: summary.passwordResetUsers.planned,
        now,
        countProperty: 'modifiedCount',
        label: 'Password-reset cleanup',
      });
    }
    if (!writesMayContinue) summary.complete = false;
  }

  const remaining = await recountRemaining(repository, now);
  summary.verificationTokens.remainingExpired = remaining.verification;
  summary.passwordResetUsers.remainingExpired = remaining.password;
  if (apply && (remaining.verification > 0 || remaining.password > 0)) {
    summary.complete = false;
  }

  return summary;
}
