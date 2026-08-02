import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  AUTH_ARTIFACT_AGE_BUCKETS,
  PASSWORD_RESET_ISSUES,
  reconcileAuthArtifacts,
  VERIFICATION_TOKEN_ISSUES,
} from '../utils/authArtifactReconciliation.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SECRET_CODE = 'recognizable-reset-code-secret-7d11';
const SECRET_CLAIM = 'recognizable-reset-claim-secret-81a2';
const SECRET_TOKEN = 'recognizable-verification-digest-secret-93bf';

const id = number => new mongoose.Types.ObjectId(
  number.toString(16).padStart(24, '0'),
);
const dateAgo = days => new Date(NOW.getTime() - (days * DAY));
const dateAhead = days => new Date(NOW.getTime() + (days * DAY));

function valueAtPath(document, pathName) {
  let value = document;
  for (const part of pathName.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      return { present: false, value: undefined };
    }
    value = value[part];
  }
  return { present: true, value };
}

function stringKind(document, pathName) {
  const field = valueAtPath(document, pathName);
  if (!field.present) return 'missing';
  if (field.value === null) return 'null';
  if (typeof field.value === 'string' && field.value.length > 0) {
    return 'non-empty-string';
  }
  return 'invalid';
}

function expiryKind(document, pathName, now) {
  const field = valueAtPath(document, pathName);
  if (!field.present) return 'missing';
  if (field.value === null) return 'null';
  if (!(field.value instanceof Date) || Number.isNaN(field.value.getTime())) {
    return 'invalid';
  }
  return field.value > now ? 'active-date' : 'expired-date';
}

function ageBucket(value, now) {
  const age = now.getTime() - value.getTime();
  if (age <= DAY) return AUTH_ARTIFACT_AGE_BUCKETS.WITHIN_LAST_24_HOURS;
  if (age <= 7 * DAY) return AUTH_ARTIFACT_AGE_BUCKETS.DAYS_2_TO_7;
  if (age <= 30 * DAY) return AUTH_ARTIFACT_AGE_BUCKETS.DAYS_8_TO_30;
  if (age <= 90 * DAY) return AUTH_ARTIFACT_AGE_BUCKETS.DAYS_31_TO_90;
  return AUTH_ARTIFACT_AGE_BUCKETS.MORE_THAN_90_DAYS;
}

function tokenAuditRow(document, now) {
  const expiry = expiryKind(document, 'email_verification_expiry', now);
  const userId = valueAtPath(document, 'user_id');
  let userIdKind = 'invalid';
  if (!userId.present) userIdKind = 'missing';
  else if (userId.value === null) userIdKind = 'null';
  else if (userId.value instanceof mongoose.Types.ObjectId) {
    userIdKind = 'object-id';
  }
  const recognized = new Set([
    '_id',
    'email_verification_code',
    'user_id',
    'email_verification_expiry',
    'date',
    '__v',
  ]);
  return {
    _id: document._id,
    expiryKind: expiry,
    userIdKind,
    codeKind: stringKind(document, 'email_verification_code'),
    unknownTopLevelFields: Object.keys(document).some(
      field => !recognized.has(field),
    ),
    ageBucket: expiry === 'expired-date'
      ? ageBucket(document.email_verification_expiry, now)
      : null,
  };
}

function passwordAuditRow(document, now) {
  const paths = {
    code: 'other_login.reset_password_code',
    expiry: 'other_login.reset_password_expiry',
    claim: 'other_login.reset_password_claim',
    counter: 'other_login.reset_password_counter',
  };
  const fields = Object.fromEntries(
    Object.entries(paths).map(([name, pathName]) => [
      name,
      valueAtPath(document, pathName),
    ]),
  );
  const expiry = expiryKind(document, paths.expiry, now);
  const hasTransientResetArtifact = [
    fields.code,
    fields.expiry,
    fields.claim,
  ].some(field => field.present);
  let counterKind = 'invalid';
  if (!fields.counter.present) counterKind = 'missing';
  else if (
    Number.isSafeInteger(fields.counter.value) &&
    fields.counter.value >= 0
  ) {
    counterKind = 'nonnegative-integer';
  }
  return {
    _id: document._id,
    noResetFields: Object.values(fields).every(field => !field.present),
    hasTransientResetArtifact,
    expiryKind: expiry,
    codeKind: stringKind(document, paths.code),
    claimKind: stringKind(document, paths.claim),
    counterKind,
    ageBucket: expiry === 'expired-date'
      ? ageBucket(fields.expiry.value, now)
      : null,
  };
}

async function* batches(values, batchSize) {
  for (let index = 0; index < values.length; index += batchSize) {
    yield values.slice(index, index + batchSize);
  }
}

function cloneFixture(value) {
  if (value instanceof Date) return new Date(value);
  if (value instanceof mongoose.Types.ObjectId) {
    return new mongoose.Types.ObjectId(value.toHexString());
  }
  if (Array.isArray(value)) return value.map(cloneFixture);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneFixture(nested)]),
    );
  }
  return value;
}

function isExpired(document, pathName, now) {
  const field = valueAtPath(document, pathName);
  return field.present && field.value instanceof Date && field.value <= now;
}

function makeRepository({
  tokens = [],
  users = [],
  tokenIndexes = [],
  userIndexes = [],
  beforeTokenWrite,
  beforeUserWrite,
  failTokenWriteAt = 0,
  failUserWriteAt = 0,
} = {}) {
  const state = {
    tokens: cloneFixture(tokens),
    users: cloneFixture(users),
    tokenAuditBatchSizes: [],
    userAuditBatchSizes: [],
    tokenCandidateBatchSizes: [],
    userCandidateBatchSizes: [],
    tokenWrites: [],
    userWrites: [],
    tokenWriteAttempts: 0,
    userWriteAttempts: 0,
    tokenRecounts: 0,
    userRecounts: 0,
    failTokenWriteAt,
    failUserWriteAt,
  };

  const repository = {
    async *iterateVerificationAuditBatches({ batchSize, now }) {
      const rows = state.tokens.map(token => tokenAuditRow(token, now));
      for await (const batch of batches(rows, batchSize)) {
        state.tokenAuditBatchSizes.push(batch.length);
        yield batch;
      }
    },
    async *iteratePasswordResetAuditBatches({ batchSize, now }) {
      const rows = state.users.map(user => passwordAuditRow(user, now));
      for await (const batch of batches(rows, batchSize)) {
        state.userAuditBatchSizes.push(batch.length);
        yield batch;
      }
    },
    async *iterateVerificationCandidateIdBatches({ batchSize, limit, now }) {
      const candidates = state.tokens
        .filter(token => isExpired(token, 'email_verification_expiry', now))
        .slice(0, limit)
        .map(token => ({ _id: token._id }));
      for await (const batch of batches(candidates, batchSize)) {
        state.tokenCandidateBatchSizes.push(batch.length);
        yield batch;
      }
    },
    async *iteratePasswordResetCandidateIdBatches({ batchSize, limit, now }) {
      const candidates = state.users
        .filter(user => isExpired(
          user,
          'other_login.reset_password_expiry',
          now,
        ))
        .slice(0, limit)
        .map(user => ({ _id: user._id }));
      for await (const batch of batches(candidates, batchSize)) {
        state.userCandidateBatchSizes.push(batch.length);
        yield batch;
      }
    },
    async deleteVerificationCandidateBatch({ candidateIds, now }) {
      state.tokenWriteAttempts += 1;
      state.tokenWrites.push({ candidateIds: [...candidateIds], now });
      if (beforeTokenWrite) await beforeTokenWrite({ state, candidateIds, now });
      if (state.tokenWriteAttempts === state.failTokenWriteAt) {
        throw new Error('raw-token-write-secret-mongodb://private-host');
      }
      const ids = new Set(candidateIds.map(value => value.toString()));
      const before = state.tokens.length;
      state.tokens = state.tokens.filter(token => !(
        ids.has(token._id.toString()) &&
        isExpired(token, 'email_verification_expiry', now)
      ));
      return { deletedCount: before - state.tokens.length };
    },
    async clearPasswordResetCandidateBatch({ candidateIds, now }) {
      state.userWriteAttempts += 1;
      state.userWrites.push({ candidateIds: [...candidateIds], now });
      if (beforeUserWrite) await beforeUserWrite({ state, candidateIds, now });
      if (state.userWriteAttempts === state.failUserWriteAt) {
        throw new Error('raw-user-write-secret-reset-code');
      }
      const ids = new Set(candidateIds.map(value => value.toString()));
      let modifiedCount = 0;
      for (const user of state.users) {
        if (
          ids.has(user._id.toString()) &&
          isExpired(user, 'other_login.reset_password_expiry', now)
        ) {
          delete user.other_login.reset_password_code;
          delete user.other_login.reset_password_expiry;
          delete user.other_login.reset_password_claim;
          user.other_login.reset_password_counter = 0;
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
    countExpiredVerificationCandidates({ now }) {
      state.tokenRecounts += 1;
      return state.tokens.filter(
        token => isExpired(token, 'email_verification_expiry', now),
      ).length;
    },
    countExpiredPasswordResetCandidates({ now }) {
      state.userRecounts += 1;
      return state.users.filter(user => isExpired(
        user,
        'other_login.reset_password_expiry',
        now,
      )).length;
    },
    async getVerificationIndexDefinitions() {
      return tokenIndexes;
    },
    async getUserIndexDefinitions() {
      return userIndexes;
    },
  };
  return { repository, state };
}

function dryRunFixtures() {
  const validToken = (number, expiry) => ({
    _id: id(number),
    email_verification_code: SECRET_TOKEN,
    user_id: id(100 + number),
    email_verification_expiry: expiry,
  });
  const tokens = [
    validToken(1, dateAhead(1)),
    validToken(2, new Date(NOW.getTime() - (2 * 60 * 60 * 1000))),
    validToken(3, dateAgo(3)),
    validToken(4, dateAgo(20)),
    validToken(5, dateAgo(60)),
    validToken(6, dateAgo(120)),
    { _id: id(7), arbitrarySecretField: 'do-not-output-this-value' },
    {
      _id: id(8),
      email_verification_code: null,
      user_id: null,
      email_verification_expiry: null,
    },
    {
      _id: id(9),
      email_verification_code: '',
      user_id: 'not-an-object-id',
      email_verification_expiry: 'not-a-date',
    },
  ];
  const fullReset = (number, expiry) => ({
    _id: id(number),
    username: `private-${number}@example.test`,
    hash: `private-hash-${number}`,
    uploads: [{ caption: 'private upload' }],
    other_login: {
      reset_password_code: SECRET_CODE,
      reset_password_expiry: expiry,
      reset_password_counter: 1,
    },
  });
  const users = [
    { _id: id(20), username: 'no-reset@example.test' },
    fullReset(21, dateAhead(1)),
    fullReset(22, new Date(NOW.getTime() - (2 * 60 * 60 * 1000))),
    fullReset(23, dateAgo(3)),
    fullReset(24, dateAgo(20)),
    fullReset(25, dateAgo(60)),
    fullReset(26, dateAgo(120)),
    {
      _id: id(27),
      other_login: { reset_password_code: SECRET_CODE },
    },
    {
      _id: id(28),
      other_login: {
        reset_password_code: SECRET_CODE,
        reset_password_expiry: null,
        reset_password_claim: null,
        reset_password_counter: 0,
      },
    },
    {
      _id: id(29),
      other_login: {
        reset_password_code: '',
        reset_password_expiry: 'not-a-date',
        reset_password_claim: '',
        reset_password_counter: -1,
      },
    },
    {
      _id: id(30),
      other_login: {
        reset_password_expiry: dateAhead(2),
        reset_password_claim: null,
      },
    },
    {
      _id: id(31),
      other_login: {
        reset_password_code: null,
        reset_password_expiry: new Date(
          NOW.getTime() - (3 * 60 * 60 * 1000),
        ),
        reset_password_claim: SECRET_CLAIM,
        reset_password_counter: 1.5,
      },
    },
  ];
  return { tokens, users };
}

function assertContentFreeSamples(samples) {
  const allowedIssues = new Set([
    ...Object.values(VERIFICATION_TOKEN_ISSUES),
    ...Object.values(PASSWORD_RESET_ISSUES),
  ]);
  for (const sample of samples) {
    assert.deepEqual(Object.keys(sample), ['recordId', 'issues']);
    assert.match(sample.recordId, /^(?:[a-f\d]{24}|unavailable)$/u);
    assert.ok(sample.issues.length > 0);
    for (const issue of sample.issues) assert.equal(allowedIssues.has(issue), true);
  }
}

describe('authentication-artifact dry-run audit', () => {
  test('reports exact shapes, unique malformed counts, ages and safe samples', async () => {
    const fixtures = dryRunFixtures();
    const tokenIndexes = [{
      name: 'email_verification_expiry_1',
      key: { email_verification_expiry: 1 },
      expireAfterSeconds: 0,
      background: true,
      arbitrarySecret: SECRET_TOKEN,
    }];
    const userIndexes = [{
      name: 'username_1',
      key: { username: 1 },
      unique: true,
      sparse: false,
      v: 2,
      arbitrarySecret: SECRET_CLAIM,
    }];
    const harness = makeRepository({ ...fixtures, tokenIndexes, userIndexes });

    const summary = await reconcileAuthArtifacts({
      repository: harness.repository,
      batchSize: 3,
      sampleLimit: 100,
      clock: () => new Date(NOW),
    });

    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.complete, true);
    assert.deepEqual(
      {
        scanned: summary.verificationTokens.scanned,
        planned: summary.verificationTokens.planned,
        changed: summary.verificationTokens.changed,
        skipped: summary.verificationTokens.skipped,
        failed: summary.verificationTokens.failed,
        malformed: summary.verificationTokens.malformed,
        remainingExpired: summary.verificationTokens.remainingExpired,
      },
      {
        scanned: 9,
        planned: 5,
        changed: 0,
        skipped: 4,
        failed: 0,
        malformed: 3,
        remainingExpired: 5,
      },
    );
    assert.deepEqual(summary.verificationTokens.shape, {
      totalDocuments: 9,
      expiryActiveDate: 1,
      expiryExpiredDate: 5,
      expiryMissing: 1,
      expiryNull: 1,
      expiryInvalidType: 1,
      userIdObjectId: 6,
      userIdMissing: 1,
      userIdNull: 1,
      userIdInvalidType: 1,
      verificationCodeNonEmptyString: 6,
      verificationCodeMissing: 1,
      verificationCodeNull: 1,
      verificationCodeEmptyOrInvalid: 1,
      unknownTopLevelFields: 1,
    });
    assert.deepEqual(summary.verificationTokens.ageBuckets, {
      withinLast24Hours: 1,
      days2To7: 1,
      days8To30: 1,
      days31To90: 1,
      moreThan90Days: 1,
    });
    assert.deepEqual(summary.verificationTokens.samples.malformed, [
      {
        recordId: id(7).toString(),
        issues: [
          VERIFICATION_TOKEN_ISSUES.MISSING_EXPIRY,
          VERIFICATION_TOKEN_ISSUES.MISSING_USER_ID,
          VERIFICATION_TOKEN_ISSUES.MISSING_CODE,
          VERIFICATION_TOKEN_ISSUES.UNKNOWN_FIELDS,
        ],
      },
      {
        recordId: id(8).toString(),
        issues: [
          VERIFICATION_TOKEN_ISSUES.NULL_EXPIRY,
          VERIFICATION_TOKEN_ISSUES.NULL_USER_ID,
          VERIFICATION_TOKEN_ISSUES.NULL_CODE,
        ],
      },
      {
        recordId: id(9).toString(),
        issues: [
          VERIFICATION_TOKEN_ISSUES.INVALID_EXPIRY,
          VERIFICATION_TOKEN_ISSUES.INVALID_USER_ID,
          VERIFICATION_TOKEN_ISSUES.INVALID_CODE,
        ],
      },
    ]);

    assert.deepEqual(
      {
        scanned: summary.passwordResetUsers.scanned,
        planned: summary.passwordResetUsers.planned,
        changed: summary.passwordResetUsers.changed,
        skipped: summary.passwordResetUsers.skipped,
        failed: summary.passwordResetUsers.failed,
        malformed: summary.passwordResetUsers.malformed,
        remainingExpired: summary.passwordResetUsers.remainingExpired,
      },
      {
        scanned: 12,
        planned: 6,
        changed: 0,
        skipped: 6,
        failed: 0,
        malformed: 5,
        remainingExpired: 6,
      },
    );
    assert.deepEqual(summary.passwordResetUsers.shape, {
      noResetFields: 1,
      counterOnlyState: 0,
      invalidCounterOnlyState: 0,
      transientResetArtifactsPresent: 11,
      expiryActiveDate: 2,
      expiryExpiredDate: 6,
      expiryMissingWithOtherArtifact: 1,
      expiryNullWithOtherArtifact: 1,
      expiryInvalidType: 1,
      codeNonEmptyString: 8,
      codeMissing: 2,
      codeNull: 1,
      codeEmptyOrInvalid: 1,
      claimMissing: 8,
      claimNull: 2,
      claimNonEmptyString: 1,
      claimEmptyOrInvalid: 1,
      counterMissing: 3,
      counterNonnegativeInteger: 7,
      counterInvalid: 2,
    });
    assert.deepEqual(summary.passwordResetUsers.ageBuckets, {
      withinLast24Hours: 2,
      days2To7: 1,
      days8To30: 1,
      days31To90: 1,
      moreThan90Days: 1,
    });
    assert.deepEqual(summary.passwordResetUsers.samples.malformed, [
      {
        recordId: id(27).toString(),
        issues: [PASSWORD_RESET_ISSUES.MISSING_EXPIRY],
      },
      {
        recordId: id(28).toString(),
        issues: [PASSWORD_RESET_ISSUES.MISSING_EXPIRY],
      },
      {
        recordId: id(29).toString(),
        issues: [
          PASSWORD_RESET_ISSUES.INVALID_EXPIRY,
          PASSWORD_RESET_ISSUES.INVALID_CODE,
          PASSWORD_RESET_ISSUES.INVALID_CLAIM,
          PASSWORD_RESET_ISSUES.INVALID_COUNTER,
          PASSWORD_RESET_ISSUES.EXPIRY_WITHOUT_CODE,
        ],
      },
      {
        recordId: id(30).toString(),
        issues: [PASSWORD_RESET_ISSUES.EXPIRY_WITHOUT_CODE],
      },
      {
        recordId: id(31).toString(),
        issues: [
          PASSWORD_RESET_ISSUES.INVALID_COUNTER,
          PASSWORD_RESET_ISSUES.CLAIM_WITHOUT_CODE,
          PASSWORD_RESET_ISSUES.EXPIRY_WITHOUT_CODE,
        ],
      },
    ]);

    assert.deepEqual(summary.indexes, {
      tokens: [{
        name: 'email_verification_expiry_1',
        key: { email_verification_expiry: 1 },
        expireAfterSeconds: 0,
      }],
      users: [{
        name: 'username_1',
        key: { username: 1 },
        unique: true,
        sparse: false,
      }],
    });
    assert.equal(harness.state.tokenWrites.length, 0);
    assert.equal(harness.state.userWrites.length, 0);
    assert.deepEqual(harness.state.tokenAuditBatchSizes, [3, 3, 3]);
    assert.deepEqual(harness.state.userAuditBatchSizes, [3, 3, 3, 3]);

    const allSamples = [
      ...summary.verificationTokens.samples.candidates,
      ...summary.verificationTokens.samples.malformed,
      ...summary.passwordResetUsers.samples.candidates,
      ...summary.passwordResetUsers.samples.malformed,
    ];
    assertContentFreeSamples(allSamples);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(
      serialized,
      /recognizable|private-|do-not-output|example\.test|upload/u,
    );
  });

  test('bounds each independent sample category', async () => {
    const harness = makeRepository(dryRunFixtures());
    const summary = await reconcileAuthArtifacts({
      repository: harness.repository,
      sampleLimit: 2,
      clock: () => new Date(NOW),
    });
    assert.equal(summary.verificationTokens.samples.candidates.length, 2);
    assert.equal(summary.verificationTokens.samples.malformed.length, 2);
    assert.equal(summary.passwordResetUsers.samples.candidates.length, 2);
    assert.equal(summary.passwordResetUsers.samples.malformed.length, 2);
  });

  test('accepts no-state and valid counter-only steady states', async () => {
    const users = [
      { _id: id(80) },
      { _id: id(81), other_login: {} },
      {
        _id: id(82),
        other_login: { reset_password_counter: 0 },
      },
      {
        _id: id(83),
        other_login: { reset_password_counter: 7 },
      },
      {
        _id: id(84),
        other_login: { last_login: dateAgo(10) },
      },
    ];
    const harness = makeRepository({ users });

    const summary = await reconcileAuthArtifacts({
      repository: harness.repository,
      sampleLimit: 100,
      clock: () => new Date(NOW),
    });

    assert.equal(summary.passwordResetUsers.scanned, 5);
    assert.equal(summary.passwordResetUsers.planned, 0);
    assert.equal(summary.passwordResetUsers.changed, 0);
    assert.equal(summary.passwordResetUsers.skipped, 5);
    assert.equal(summary.passwordResetUsers.malformed, 0);
    assert.equal(summary.passwordResetUsers.remainingExpired, 0);
    assert.equal(summary.passwordResetUsers.shape.noResetFields, 3);
    assert.equal(summary.passwordResetUsers.shape.counterOnlyState, 2);
    assert.equal(summary.passwordResetUsers.shape.invalidCounterOnlyState, 0);
    assert.equal(
      summary.passwordResetUsers.shape.transientResetArtifactsPresent,
      0,
    );
    assert.equal(
      summary.passwordResetUsers.shape.expiryMissingWithOtherArtifact,
      0,
    );
    assert.equal(summary.passwordResetUsers.shape.counterMissing, 3);
    assert.equal(summary.passwordResetUsers.shape.counterNonnegativeInteger, 2);
    assert.deepEqual(summary.passwordResetUsers.samples.candidates, []);
    assert.deepEqual(summary.passwordResetUsers.samples.malformed, []);
  });

  test('reports invalid counter-only values without inventing missing expiry', async () => {
    const invalidCounters = [
      -1,
      1.5,
      'invalid-counter-secret',
      null,
      { privateCounterValue: 'counter-object-secret' },
    ];
    const users = invalidCounters.map((counter, index) => ({
      _id: id(90 + index),
      other_login: { reset_password_counter: counter },
    }));
    const harness = makeRepository({ users });

    const summary = await reconcileAuthArtifacts({
      repository: harness.repository,
      sampleLimit: 100,
      clock: () => new Date(NOW),
    });

    assert.equal(summary.passwordResetUsers.planned, 0);
    assert.equal(summary.passwordResetUsers.malformed, 5);
    assert.equal(summary.passwordResetUsers.shape.counterOnlyState, 0);
    assert.equal(summary.passwordResetUsers.shape.invalidCounterOnlyState, 5);
    assert.equal(
      summary.passwordResetUsers.shape.transientResetArtifactsPresent,
      0,
    );
    assert.equal(
      summary.passwordResetUsers.shape.expiryMissingWithOtherArtifact,
      0,
    );
    assert.equal(summary.passwordResetUsers.shape.counterInvalid, 5);
    assert.deepEqual(
      summary.passwordResetUsers.samples.malformed,
      users.map(user => ({
        recordId: user._id.toString(),
        issues: [PASSWORD_RESET_ISSUES.INVALID_COUNTER],
      })),
    );
    assert.doesNotMatch(
      JSON.stringify(summary),
      /invalid-counter-secret|counter-object-secret|privateCounterValue/u,
    );
  });

  test('retains missing-expiry findings for genuine transient reset state', async () => {
    const transientCode = 'genuine-missing-expiry-code-secret';
    const transientClaim = 'genuine-missing-expiry-claim-secret';
    const users = [
      {
        _id: id(100),
        other_login: { reset_password_code: transientCode },
      },
      {
        _id: id(101),
        other_login: { reset_password_claim: transientClaim },
      },
      {
        _id: id(102),
        other_login: {
          reset_password_code: transientCode,
          reset_password_expiry: null,
          reset_password_claim: transientClaim,
        },
      },
    ];
    const harness = makeRepository({ users });

    const summary = await reconcileAuthArtifacts({
      repository: harness.repository,
      sampleLimit: 100,
      clock: () => new Date(NOW),
    });

    assert.equal(summary.passwordResetUsers.planned, 0);
    assert.equal(summary.passwordResetUsers.malformed, 3);
    assert.equal(summary.passwordResetUsers.shape.counterOnlyState, 0);
    assert.equal(
      summary.passwordResetUsers.shape.transientResetArtifactsPresent,
      3,
    );
    assert.equal(
      summary.passwordResetUsers.shape.expiryMissingWithOtherArtifact,
      2,
    );
    assert.equal(summary.passwordResetUsers.shape.expiryNullWithOtherArtifact, 1);
    for (const sample of summary.passwordResetUsers.samples.malformed) {
      assert.equal(
        sample.issues.includes(PASSWORD_RESET_ISSUES.MISSING_EXPIRY),
        true,
      );
    }
    assert.doesNotMatch(
      JSON.stringify(summary),
      /genuine-missing-expiry-(?:code|claim)-secret/u,
    );
  });
});

describe('authentication-artifact apply behavior', () => {
  test('cleans only expired real-date records in bounded batches and reruns safely', async () => {
    const fixtures = dryRunFixtures();
    for (const user of fixtures.users) {
      user.unrelated = { auth_version: 7, uploads: ['preserve-me'] };
    }
    const harness = makeRepository(fixtures);
    const beforeUnrelated = harness.state.users.map(user => ({
      id: user._id.toString(),
      unrelated: structuredClone(user.unrelated),
    }));

    const first = await reconcileAuthArtifacts({
      repository: harness.repository,
      apply: true,
      batchSize: 2,
      sampleLimit: 5,
      clock: () => new Date(NOW),
    });

    assert.equal(first.complete, true);
    assert.equal(first.verificationTokens.changed, 5);
    assert.equal(first.verificationTokens.failed, 0);
    assert.equal(first.verificationTokens.remainingExpired, 0);
    assert.equal(first.passwordResetUsers.changed, 6);
    assert.equal(first.passwordResetUsers.failed, 0);
    assert.equal(first.passwordResetUsers.remainingExpired, 0);
    assert.deepEqual(harness.state.tokenCandidateBatchSizes, [2, 2, 1]);
    assert.deepEqual(harness.state.userCandidateBatchSizes, [2, 2, 2]);
    assert.equal(
      harness.state.tokens.some(token =>
        token.email_verification_expiry === null ||
        token.email_verification_expiry === 'not-a-date' ||
        !Object.hasOwn(token, 'email_verification_expiry')),
      true,
    );
    assert.equal(
      harness.state.tokens.some(token =>
        token.email_verification_expiry instanceof Date &&
        token.email_verification_expiry > NOW),
      true,
    );
    assert.equal(harness.state.users[1].other_login.reset_password_code, SECRET_CODE);
    assert.equal(
      harness.state.users.some(user =>
        user.other_login?.reset_password_expiry === null),
      true,
    );
    assert.deepEqual(
      harness.state.users.map(user => ({
        id: user._id.toString(),
        unrelated: user.unrelated,
      })),
      beforeUnrelated,
    );
    for (const userNumber of [22, 23, 24, 25, 26, 31]) {
      const user = harness.state.users.find(value => value._id.equals(id(userNumber)));
      assert.equal(Object.hasOwn(user.other_login, 'reset_password_code'), false);
      assert.equal(Object.hasOwn(user.other_login, 'reset_password_expiry'), false);
      assert.equal(Object.hasOwn(user.other_login, 'reset_password_claim'), false);
      assert.equal(user.other_login.reset_password_counter, 0);
    }

    const second = await reconcileAuthArtifacts({
      repository: harness.repository,
      apply: true,
      batchSize: 2,
      clock: () => new Date(NOW),
    });
    assert.equal(second.complete, true);
    assert.equal(second.verificationTokens.changed, 0);
    assert.equal(second.passwordResetUsers.changed, 0);
    assert.equal(second.verificationTokens.remainingExpired, 0);
    assert.equal(second.passwordResetUsers.remainingExpired, 0);
  });

  test('a cleaned User audits as valid counter-only metadata', async () => {
    const cleanupCode = 'post-cleanup-code-secret';
    const cleanupClaim = 'post-cleanup-claim-secret';
    const user = {
      _id: id(115),
      username: 'post-cleanup-private@example.test',
      uploads: [{ caption: 'post-cleanup-private-upload' }],
      other_login: {
        reset_password_code: cleanupCode,
        reset_password_expiry: dateAgo(3),
        reset_password_claim: cleanupClaim,
        reset_password_counter: 4,
        last_login: dateAgo(5),
      },
    };
    const harness = makeRepository({ users: [user] });

    const applied = await reconcileAuthArtifacts({
      repository: harness.repository,
      apply: true,
      clock: () => new Date(NOW),
    });
    const rerun = await reconcileAuthArtifacts({
      repository: harness.repository,
      clock: () => new Date(NOW),
    });

    assert.equal(applied.passwordResetUsers.changed, 1);
    assert.equal(applied.passwordResetUsers.remainingExpired, 0);
    assert.equal(rerun.mode, 'dry-run');
    assert.equal(rerun.passwordResetUsers.changed, 0);
    assert.equal(rerun.passwordResetUsers.planned, 0);
    assert.equal(rerun.passwordResetUsers.remainingExpired, 0);
    assert.equal(rerun.passwordResetUsers.malformed, 0);
    assert.equal(rerun.passwordResetUsers.shape.noResetFields, 0);
    assert.equal(rerun.passwordResetUsers.shape.counterOnlyState, 1);
    assert.equal(rerun.passwordResetUsers.shape.invalidCounterOnlyState, 0);
    assert.equal(
      rerun.passwordResetUsers.shape.transientResetArtifactsPresent,
      0,
    );
    assert.equal(
      rerun.passwordResetUsers.shape.expiryMissingWithOtherArtifact,
      0,
    );
    assert.deepEqual(rerun.passwordResetUsers.samples.malformed, []);
    assert.equal(harness.state.users[0].other_login.reset_password_counter, 0);
    assert.equal(
      harness.state.users[0].other_login.last_login.getTime(),
      dateAgo(5).getTime(),
    );
    assert.doesNotMatch(
      JSON.stringify({ applied, rerun }),
      /post-cleanup|private@example|private-upload/u,
    );
  });

  test('counts disappeared, already-cleaned and newly active races as skipped', async () => {
    let tokenRaceApplied = false;
    let userRaceApplied = false;
    const tokens = [1, 2, 3].map(number => ({
      _id: id(40 + number),
      email_verification_expiry: dateAgo(2),
      email_verification_code: SECRET_TOKEN,
      user_id: id(140 + number),
    }));
    const users = [1, 2, 3].map(number => ({
      _id: id(50 + number),
      other_login: {
        reset_password_code: SECRET_CODE,
        reset_password_expiry: dateAgo(2),
        reset_password_counter: 1,
      },
    }));
    const harness = makeRepository({
      tokens,
      users,
      beforeTokenWrite({ state, candidateIds }) {
        if (tokenRaceApplied) return;
        tokenRaceApplied = true;
        state.tokens = state.tokens.filter(
          token => !token._id.equals(candidateIds[0]),
        );
        delete state.tokens.find(
          token => token._id.equals(candidateIds[1]),
        ).email_verification_expiry;
        state.tokens.find(
          token => token._id.equals(candidateIds[2]),
        ).email_verification_expiry = dateAhead(2);
      },
      beforeUserWrite({ state, candidateIds }) {
        if (userRaceApplied) return;
        userRaceApplied = true;
        state.users = state.users.filter(
          user => !user._id.equals(candidateIds[0]),
        );
        const cleaned = state.users.find(user => user._id.equals(candidateIds[1]));
        delete cleaned.other_login.reset_password_expiry;
        const renewed = state.users.find(user => user._id.equals(candidateIds[2]));
        renewed.other_login.reset_password_expiry = dateAhead(2);
        renewed.other_login.reset_password_code = 'new-active-secret';
      },
    });

    const summary = await reconcileAuthArtifacts({
      repository: harness.repository,
      apply: true,
      batchSize: 3,
      clock: () => new Date(NOW),
    });

    assert.equal(summary.complete, true);
    assert.equal(summary.verificationTokens.changed, 0);
    assert.equal(summary.verificationTokens.skipped, 3);
    assert.equal(summary.passwordResetUsers.changed, 0);
    assert.equal(summary.passwordResetUsers.skipped, 3);
    assert.equal(summary.verificationTokens.remainingExpired, 0);
    assert.equal(summary.passwordResetUsers.remainingExpired, 0);
    assert.equal(
      harness.state.users.some(user =>
        user.other_login?.reset_password_code === 'new-active-secret'),
      true,
    );
  });

  test('stops every later write after the first failed batch and recounts safely', async () => {
    const tokens = [1, 2, 3, 4].map(number => ({
      _id: id(60 + number),
      email_verification_expiry: dateAgo(2),
      email_verification_code: SECRET_TOKEN,
      user_id: id(160 + number),
    }));
    const users = [{
      _id: id(70),
      other_login: {
        reset_password_expiry: dateAgo(2),
        reset_password_code: SECRET_CODE,
      },
    }];
    const harness = makeRepository({ tokens, users, failTokenWriteAt: 1 });

    const failed = await reconcileAuthArtifacts({
      repository: harness.repository,
      apply: true,
      batchSize: 2,
      clock: () => new Date(NOW),
    });

    assert.equal(failed.complete, false);
    assert.equal(failed.verificationTokens.failed, 2);
    assert.equal(failed.verificationTokens.changed, 0);
    assert.equal(failed.verificationTokens.remainingExpired, 4);
    assert.equal(failed.passwordResetUsers.remainingExpired, 1);
    assert.equal(harness.state.tokenWriteAttempts, 1);
    assert.equal(harness.state.userWriteAttempts, 0);
    assert.equal(harness.state.tokenRecounts, 1);
    assert.equal(harness.state.userRecounts, 1);
    assert.doesNotMatch(JSON.stringify(failed), /raw-|mongodb|private-host/u);

    harness.state.failTokenWriteAt = 0;
    const rerun = await reconcileAuthArtifacts({
      repository: harness.repository,
      apply: true,
      batchSize: 2,
      clock: () => new Date(NOW),
    });
    assert.equal(rerun.complete, true);
    assert.equal(rerun.verificationTokens.changed, 4);
    assert.equal(rerun.passwordResetUsers.changed, 1);
  });
});
