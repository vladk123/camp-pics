const MAX_INDEX_SUMMARIES = 100;
const MAX_INDEX_NAME_LENGTH = 128;
const MAX_INDEX_KEY_FIELDS = 32;

export const EMAIL_LOG_DEFAULT_BATCH_SIZE = 100;
export const EMAIL_LOG_MAX_BATCH_SIZE = 1000;
export const EMAIL_LOG_DEFAULT_SAMPLE_LIMIT = 20;
export const EMAIL_LOG_MAX_SAMPLE_LIMIT = 100;

export const EMAIL_LOG_MALFORMED_ISSUES = Object.freeze({
  INVALID_RECIPIENT: 'missing-or-invalid-recipient',
  MISSING_SENT_AT: 'missing-sent-at',
  INVALID_SENT_AT: 'invalid-sent-at',
  INVALID_TEMPLATE: 'invalid-template-type',
  INVALID_MESSAGE_ID: 'invalid-message-id-type',
  INVALID_USER_ID: 'invalid-user-id-type',
  UNKNOWN_FIELDS: 'unknown-top-level-fields',
});

export const EMAIL_LOG_AGE_BUCKETS = Object.freeze({
  FUTURE_DATED: 'futureDated',
  AGE_0_TO_30_DAYS: 'age0To30Days',
  AGE_31_TO_90_DAYS: 'age31To90Days',
  AGE_91_TO_180_DAYS: 'age91To180Days',
  AGE_181_TO_365_DAYS: 'age181To365Days',
  OLDER_THAN_365_DAYS: 'olderThan365Days',
  MISSING_SENT_AT: 'missingSentAt',
  INVALID_SENT_AT: 'invalidSentAt',
});

const VALID_AGE_BUCKETS = new Set(Object.values(EMAIL_LOG_AGE_BUCKETS));

function assertBoundedInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
}

function requireRepository(repository) {
  const methods = [
    'iterateAuditBatches',
    'iterateCandidateIdBatches',
    'redactCandidateBatch',
    'countSensitiveDocuments',
    'getIndexDefinitions',
  ];
  if (
    !repository ||
    methods.some(method => typeof repository[method] !== 'function')
  ) {
    throw new TypeError('An Email log reconciliation repository is required.');
  }
}

function safeEmailId(value) {
  const direct = typeof value === 'string' ? value : null;
  const objectId = typeof value?.toHexString === 'function'
    ? value.toHexString()
    : null;
  const candidate = direct || objectId;
  return typeof candidate === 'string' && /^[a-f\d]{24}$/iu.test(candidate)
    ? candidate.toLowerCase()
    : 'unavailable';
}

function safeIndexText(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/[^a-z\d_.:$-]/giu, '_')
    .slice(0, MAX_INDEX_NAME_LENGTH);
}

function safeIndexDirection(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = safeIndexText(value);
  return normalized === null ? 'other' : normalized;
}

function safeIndexNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toString === 'function') {
    const text = value.toString();
    if (/^-?\d+(?:\.\d+)?$/u.test(text)) {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function summarizeIndex(index) {
  const summary = {};
  const name = safeIndexText(index?.name);
  if (name !== null) summary.name = name;

  if (index?.key && typeof index.key === 'object') {
    const key = {};
    for (const [field, direction] of Object.entries(index.key)
      .slice(0, MAX_INDEX_KEY_FIELDS)) {
      const safeField = safeIndexText(field);
      if (safeField !== null) {
        key[safeField] = safeIndexDirection(direction);
      }
    }
    summary.key = key;
  }

  for (const option of ['unique', 'sparse']) {
    if (typeof index?.[option] === 'boolean') {
      summary[option] = index[option];
    }
  }

  if (Object.hasOwn(index || {}, 'expireAfterSeconds')) {
    const expireAfterSeconds = safeIndexNumber(index.expireAfterSeconds);
    if (expireAfterSeconds !== null) {
      summary.expireAfterSeconds = expireAfterSeconds;
    }
  }

  return summary;
}

export function summarizeEmailLogIndexes(indexes) {
  if (!Array.isArray(indexes)) {
    throw new TypeError('Email index definitions must be an array.');
  }
  return Object.freeze({
    total: indexes.length,
    truncated: indexes.length > MAX_INDEX_SUMMARIES,
    indexes: Object.freeze(
      indexes.slice(0, MAX_INDEX_SUMMARIES).map(summarizeIndex),
    ),
  });
}

function createSummary(apply) {
  return {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    planned: 0,
    changed: 0,
    skipped: 0,
    malformed: 0,
    failed: 0,
    remainingSensitive: 0,
    incomplete: false,
    legacyFields: {
      html: 0,
      subject: 0,
      both: 0,
      either: 0,
      neither: 0,
    },
    metadataShape: {
      templatePresent: 0,
      templateAbsent: 0,
      templatePresentString: 0,
      templatePresentInvalidType: 0,
      userIdPresent: 0,
      userIdAbsent: 0,
      userIdPresentObjectId: 0,
      userIdPresentInvalidType: 0,
      messageIdPresent: 0,
      messageIdAbsent: 0,
      messageIdPresentString: 0,
      messageIdPresentInvalidType: 0,
      sentAtBsonDate: 0,
      sentAtMissing: 0,
      sentAtPresentNonDate: 0,
      recipientNonEmptyString: 0,
      recipientMissingEmptyOrInvalidType: 0,
      unknownTopLevelFields: 0,
    },
    ageBuckets: {
      futureDated: 0,
      age0To30Days: 0,
      age31To90Days: 0,
      age91To180Days: 0,
      age181To365Days: 0,
      olderThan365Days: 0,
      missingSentAt: 0,
      invalidSentAt: 0,
    },
    retentionCandidates: {
      olderThan30Days: 0,
      olderThan90Days: 0,
      olderThan180Days: 0,
      olderThan365Days: 0,
    },
    indexCount: 0,
    indexesTruncated: false,
    indexes: [],
    samples: {
      redactionCandidates: [],
      malformed: [],
    },
  };
}

function addCandidateSample(summary, emailId, sampleLimit) {
  if (summary.samples.redactionCandidates.length >= sampleLimit) return;
  summary.samples.redactionCandidates.push({
    emailId: safeEmailId(emailId),
  });
}

function addMalformedSample(summary, emailId, issues, sampleLimit) {
  if (summary.samples.malformed.length >= sampleLimit) return;
  summary.samples.malformed.push({
    emailId: safeEmailId(emailId),
    issues: [...issues],
  });
}

function countOptionalShape({
  metadataShape,
  present,
  valid,
  prefix,
  validSuffix,
}) {
  if (!present) {
    metadataShape[`${prefix}Absent`] += 1;
    return;
  }
  metadataShape[`${prefix}Present`] += 1;
  if (valid) {
    metadataShape[`${prefix}Present${validSuffix}`] += 1;
  } else {
    metadataShape[`${prefix}PresentInvalidType`] += 1;
  }
}

function auditRow(summary, row, sampleLimit) {
  if (!row || !VALID_AGE_BUCKETS.has(row.ageBucket)) {
    throw new TypeError('Repository returned an invalid Email audit row.');
  }

  summary.scanned += 1;
  const hasHtml = row.htmlPresent === true;
  const hasSubject = row.subjectPresent === true;
  if (hasHtml) summary.legacyFields.html += 1;
  if (hasSubject) summary.legacyFields.subject += 1;
  if (hasHtml && hasSubject) summary.legacyFields.both += 1;
  if (hasHtml || hasSubject) {
    summary.legacyFields.either += 1;
    summary.planned += 1;
    addCandidateSample(summary, row._id, sampleLimit);
  } else {
    summary.legacyFields.neither += 1;
  }

  countOptionalShape({
    metadataShape: summary.metadataShape,
    present: row.templatePresent === true,
    valid: row.templateValid === true,
    prefix: 'template',
    validSuffix: 'String',
  });
  countOptionalShape({
    metadataShape: summary.metadataShape,
    present: row.userIdPresent === true,
    valid: row.userIdValid === true,
    prefix: 'userId',
    validSuffix: 'ObjectId',
  });
  countOptionalShape({
    metadataShape: summary.metadataShape,
    present: row.messageIdPresent === true,
    valid: row.messageIdValid === true,
    prefix: 'messageId',
    validSuffix: 'String',
  });

  const issues = [];
  if (row.recipientValid === true) {
    summary.metadataShape.recipientNonEmptyString += 1;
  } else {
    summary.metadataShape.recipientMissingEmptyOrInvalidType += 1;
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.INVALID_RECIPIENT);
  }

  if (row.ageBucket === EMAIL_LOG_AGE_BUCKETS.MISSING_SENT_AT) {
    summary.metadataShape.sentAtMissing += 1;
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.MISSING_SENT_AT);
  } else if (row.ageBucket === EMAIL_LOG_AGE_BUCKETS.INVALID_SENT_AT) {
    summary.metadataShape.sentAtPresentNonDate += 1;
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.INVALID_SENT_AT);
  } else {
    summary.metadataShape.sentAtBsonDate += 1;
  }
  summary.ageBuckets[row.ageBucket] += 1;

  if (row.templatePresent === true && row.templateValid !== true) {
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.INVALID_TEMPLATE);
  }
  if (row.messageIdPresent === true && row.messageIdValid !== true) {
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.INVALID_MESSAGE_ID);
  }
  if (row.userIdPresent === true && row.userIdValid !== true) {
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.INVALID_USER_ID);
  }
  if (row.unknownTopLevelFields === true) {
    summary.metadataShape.unknownTopLevelFields += 1;
    issues.push(EMAIL_LOG_MALFORMED_ISSUES.UNKNOWN_FIELDS);
  }

  for (const horizon of [30, 90, 180, 365]) {
    if (row[`olderThan${horizon}Days`] === true) {
      summary.retentionCandidates[`olderThan${horizon}Days`] += 1;
    }
  }

  if (issues.length > 0) {
    summary.malformed += 1;
    addMalformedSample(summary, row._id, issues, sampleLimit);
  }
}

function validateAuditBatch(batch, batchSize) {
  if (!Array.isArray(batch) || batch.length > batchSize) {
    throw new TypeError('Repository returned an invalid Email audit batch.');
  }
}

function candidateIdsFromBatch(batch, batchSize) {
  if (!Array.isArray(batch) || batch.length > batchSize) {
    throw new TypeError('Repository returned an invalid candidate batch.');
  }
  return batch.map(candidate => {
    if (
      !candidate ||
      !Object.hasOwn(candidate, '_id') ||
      Object.keys(candidate).some(key => key !== '_id')
    ) {
      throw new TypeError('Candidate batches may contain only Email IDs.');
    }
    return candidate._id;
  });
}

function requireModifiedCount(result, batchLength) {
  const modifiedCount = result?.modifiedCount;
  if (
    !Number.isInteger(modifiedCount) ||
    modifiedCount < 0 ||
    modifiedCount > batchLength
  ) {
    throw new TypeError('Email redaction returned an invalid write count.');
  }
  return modifiedCount;
}

export async function reconcileEmailLogs({
  repository,
  apply = false,
  batchSize = EMAIL_LOG_DEFAULT_BATCH_SIZE,
  sampleLimit = EMAIL_LOG_DEFAULT_SAMPLE_LIMIT,
  now = () => new Date(),
} = {}) {
  requireRepository(repository);
  if (typeof apply !== 'boolean') {
    throw new TypeError('Email reconciliation apply mode must be boolean.');
  }
  assertBoundedInteger(
    batchSize,
    'Email reconciliation batch size',
    EMAIL_LOG_MAX_BATCH_SIZE,
  );
  assertBoundedInteger(
    sampleLimit,
    'Email reconciliation sample limit',
    EMAIL_LOG_MAX_SAMPLE_LIMIT,
  );
  if (typeof now !== 'function') {
    throw new TypeError('Email reconciliation requires a clock function.');
  }
  const auditNow = now();
  if (!(auditNow instanceof Date) || Number.isNaN(auditNow.getTime())) {
    throw new TypeError('Email reconciliation clock returned an invalid date.');
  }

  const summary = createSummary(apply);
  const indexAudit = summarizeEmailLogIndexes(
    await repository.getIndexDefinitions(),
  );
  summary.indexCount = indexAudit.total;
  summary.indexesTruncated = indexAudit.truncated;
  summary.indexes = [...indexAudit.indexes];

  for await (const batch of repository.iterateAuditBatches({
    batchSize,
    now: new Date(auditNow),
  })) {
    validateAuditBatch(batch, batchSize);
    for (const row of batch) auditRow(summary, row, sampleLimit);
  }

  summary.skipped = summary.legacyFields.neither;

  if (apply && summary.planned > 0) {
    let candidateIdsSeen = 0;
    for await (const batch of repository.iterateCandidateIdBatches({
      batchSize,
      limit: summary.planned,
    })) {
      const emailIds = candidateIdsFromBatch(batch, batchSize);
      candidateIdsSeen += emailIds.length;
      try {
        const result = await repository.redactCandidateBatch(emailIds);
        const modifiedCount = requireModifiedCount(result, emailIds.length);
        summary.changed += modifiedCount;
        summary.skipped += emailIds.length - modifiedCount;
      } catch {
        summary.failed += emailIds.length;
      }
    }
    summary.skipped += Math.max(0, summary.planned - candidateIdsSeen);
  }

  const remainingSensitive = await repository.countSensitiveDocuments();
  if (!Number.isInteger(remainingSensitive) || remainingSensitive < 0) {
    throw new TypeError('Email sensitive-document count is invalid.');
  }
  summary.remainingSensitive = remainingSensitive;
  summary.incomplete = apply && (
    summary.failed > 0 || summary.remainingSensitive > 0
  );

  return summary;
}
