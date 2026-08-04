import mongoose from 'mongoose';

import {
  MONTHLY_DRAW_RULES_VERSION,
  buildMonthlyDrawResultId,
  isValidMonthKey,
} from '../utils/monthlyDraw.js';

const { Schema } = mongoose;

const RESULT_STATUSES = Object.freeze([
  'selected',
  'no-eligible-entries',
]);
const SOURCE_TYPES = Object.freeze(['upload', 'no-upload']);
const NOTIFICATION_STATES = Object.freeze(['pending', 'sending', 'sent']);
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const LEASE_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const NO_UPLOAD_SOURCE_PATTERN =
  /^monthly-draw-no-upload-ref:(\d{4}-(?:0[1-9]|1[0-2])):[a-f0-9]{64}$/u;

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidSourceId(value) {
  if (typeof value !== 'string') return false;
  if (this.sourceType === 'upload') return OBJECT_ID_PATTERN.test(value);
  if (this.sourceType !== 'no-upload') return false;
  return NO_UPLOAD_SOURCE_PATTERN.test(value);
}

const candidateSchema = new Schema({
  rank: {
    type: Number,
    required: true,
    immutable: true,
    enum: [1, 2, 3],
    validate: {
      validator: Number.isSafeInteger,
      message: 'Candidate rank must be an integer.',
    },
  },
  entrantFingerprint: {
    type: String,
    required: true,
    immutable: true,
    match: FINGERPRINT_PATTERN,
  },
  sourceType: {
    type: String,
    required: true,
    immutable: true,
    enum: SOURCE_TYPES,
  },
  sourceId: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isValidSourceId,
      message: 'Candidate source ID does not match its source type.',
    },
  },
  entryCount: {
    type: Number,
    required: true,
    immutable: true,
    min: 1,
    validate: {
      validator: Number.isSafeInteger,
      message: 'Candidate entry count must be a positive integer.',
    },
  },
}, {
  _id: false,
  strict: 'throw',
});

const poolSummarySchema = new Schema({
  eligibleUploadEntries: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
  eligibleNoUploadEntries: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
  totalEligibleEntries: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
  eligibleDistinctEntrants: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
  excludedAccountEntries: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
  candidatesSelected: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
  pendingUploadsAtSelection: {
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    validate: isNonNegativeInteger,
  },
}, {
  _id: false,
  strict: 'throw',
});

function notificationAttemptCountIsValid(value) {
  return isNonNegativeInteger(value) && (
    this.state === 'pending' || value >= 1
  );
}

function notificationLeaseHashIsValid(value) {
  if (this.state === 'sending') {
    return typeof value === 'string' && LEASE_TOKEN_HASH_PATTERN.test(value);
  }
  return value == null;
}

function notificationLeaseExpiryIsValid(value) {
  if (this.state === 'sending') {
    return value instanceof Date && !Number.isNaN(value.valueOf());
  }
  return value == null;
}

function notificationSentAtIsValid(value) {
  if (this.state === 'sent') {
    return value instanceof Date && !Number.isNaN(value.valueOf());
  }
  return value == null;
}

function notificationAttemptTimeIsValid(value) {
  if (this.state === 'sending' || this.state === 'sent') {
    return value instanceof Date && !Number.isNaN(value.valueOf());
  }
  return value == null || (
    value instanceof Date && !Number.isNaN(value.valueOf())
  );
}

function providerMessageIdIsValid(value) {
  return value == null || (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512
  );
}

const notificationSchema = new Schema({
  state: {
    type: String,
    enum: NOTIFICATION_STATES,
    default: 'pending',
    required: true,
  },
  attemptCount: {
    type: Number,
    default: 0,
    min: 0,
    required: true,
    validate: {
      validator: notificationAttemptCountIsValid,
      message: 'Notification attempt count does not match its state.',
    },
  },
  lastAttemptAt: {
    type: Date,
    default: null,
    required() {
      return this.state === 'sending' || this.state === 'sent';
    },
    validate: {
      validator: notificationAttemptTimeIsValid,
      message: 'Notification attempt time does not match its state.',
    },
  },
  lastFailureAt: {
    type: Date,
    default: null,
  },
  leaseTokenHash: {
    type: String,
    default: null,
    required() {
      return this.state === 'sending';
    },
    validate: {
      validator: notificationLeaseHashIsValid,
      message: 'Notification lease hash does not match its state.',
    },
  },
  leaseExpiresAt: {
    type: Date,
    default: null,
    required() {
      return this.state === 'sending';
    },
    validate: {
      validator: notificationLeaseExpiryIsValid,
      message: 'Notification lease expiry does not match its state.',
    },
  },
  sentAt: {
    type: Date,
    default: null,
    required() {
      return this.state === 'sent';
    },
    validate: {
      validator: notificationSentAtIsValid,
      message: 'Notification sent time does not match its state.',
    },
  },
  providerMessageId: {
    type: String,
    default: null,
    validate: {
      validator: providerMessageIdIsValid,
      message: 'Notification provider message ID is invalid.',
    },
  },
}, {
  _id: false,
  strict: 'throw',
});

function hasValidCandidates(candidates) {
  if (!Array.isArray(candidates)) return false;
  if (this.status === 'selected') {
    if (candidates.length < 1 || candidates.length > 3) return false;
  } else if (this.status === 'no-eligible-entries') {
    if (candidates.length !== 0) return false;
  } else {
    return false;
  }

  const fingerprints = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate.rank !== index + 1) return false;
    if (fingerprints.has(candidate.entrantFingerprint)) return false;
    fingerprints.add(candidate.entrantFingerprint);

    if (candidate.sourceType === 'no-upload') {
      const match = candidate.sourceId?.match(NO_UPLOAD_SOURCE_PATTERN);
      if (!match || match[1] !== this.monthKey) return false;
    }
  }
  return true;
}

function hasValidPoolSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  return summary.candidatesSelected === this.candidates.length &&
    summary.totalEligibleEntries ===
      summary.eligibleUploadEntries + summary.eligibleNoUploadEntries &&
    summary.eligibleDistinctEntrants <= summary.totalEligibleEntries &&
    summary.candidatesSelected === Math.min(
      3,
      summary.eligibleDistinctEntrants,
    );
}

const monthlyDrawResultSchema = new Schema({
  _id: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator(value) {
        try {
          return value === buildMonthlyDrawResultId(this.monthKey);
        } catch {
          return false;
        }
      },
      message: 'Result ID must match the monthly draw month.',
    },
  },
  monthKey: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isValidMonthKey,
      message: 'Month key must use YYYY-MM.',
    },
  },
  rulesVersion: {
    type: String,
    required: true,
    immutable: true,
    enum: [MONTHLY_DRAW_RULES_VERSION],
  },
  status: {
    type: String,
    required: true,
    immutable: true,
    enum: RESULT_STATUSES,
  },
  selectedAt: {
    type: Date,
    required: true,
    immutable: true,
  },
  candidates: {
    type: [candidateSchema],
    required: true,
    default: undefined,
    immutable: true,
    validate: {
      validator: hasValidCandidates,
      message: 'Candidates must match the result status and rank contract.',
    },
  },
  poolSummary: {
    type: poolSummarySchema,
    required: true,
    immutable: true,
    validate: {
      validator: hasValidPoolSummary,
      message: 'Pool summary does not match the stored result.',
    },
  },
  notification: {
    type: notificationSchema,
    default: undefined,
  },
}, {
  timestamps: true,
  strict: 'throw',
});

export const MonthlyDrawResult =
  mongoose.models.MonthlyDrawResult ||
  mongoose.model('MonthlyDrawResult', monthlyDrawResultSchema);
