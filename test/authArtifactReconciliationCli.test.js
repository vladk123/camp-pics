import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  AUTH_ARTIFACT_DIRECT_FAILURE_MESSAGE,
  AUTH_ARTIFACT_INCOMPLETE_MESSAGE,
  createMongoAuthArtifactRepository,
  handleAuthArtifactDirectFailure,
  parseAuthArtifactArguments,
  runAuthArtifactReconciliationCli,
} from '../scripts/reconcileAuthArtifacts.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const recordId = new mongoose.Types.ObjectId('000000000000000000000091');

async function* cursor(rows) {
  for (const row of rows) yield row;
}

function emptyRepository(overrides = {}) {
  return {
    iterateVerificationAuditBatches() {
      return cursor([]);
    },
    iteratePasswordResetAuditBatches() {
      return cursor([]);
    },
    iterateVerificationCandidateIdBatches() {
      return cursor([]);
    },
    iteratePasswordResetCandidateIdBatches() {
      return cursor([]);
    },
    async deleteVerificationCandidateBatch() {
      return { deletedCount: 0 };
    },
    async clearPasswordResetCandidateBatch() {
      return { modifiedCount: 0 };
    },
    async countExpiredVerificationCandidates() {
      return 0;
    },
    async countExpiredPasswordResetCandidates() {
      return 0;
    },
    async getVerificationIndexDefinitions() {
      return [];
    },
    async getUserIndexDefinitions() {
      return [];
    },
    ...overrides,
  };
}

function makeCliHarness({ repository = emptyRepository() } = {}) {
  const calls = {
    connect: [],
    disconnect: 0,
    log: [],
    error: [],
    incomplete: 0,
  };
  return {
    calls,
    dependencies: {
      repository,
      databaseUrl: 'mongodb://test.invalid/camp-pics',
      clock: () => new Date(NOW),
      async connect(...args) {
        calls.connect.push(args);
      },
      async disconnect() {
        calls.disconnect += 1;
      },
      output: {
        log(value) {
          calls.log.push(value);
        },
        error(value) {
          calls.error.push(value);
        },
      },
      markIncomplete() {
        calls.incomplete += 1;
      },
    },
  };
}

describe('authentication-artifact CLI argument parsing', () => {
  test('defaults to dry-run and requires explicit apply mode', () => {
    assert.deepEqual({ ...parseAuthArtifactArguments([]) }, {
      apply: false,
      batchSize: 100,
      sampleLimit: 20,
    });
    assert.deepEqual({ ...parseAuthArtifactArguments(['--apply']) }, {
      apply: true,
      batchSize: 100,
      sampleLimit: 20,
    });
  });

  test('accepts valid separated and equals-form numeric values', () => {
    assert.deepEqual({ ...parseAuthArtifactArguments([
      '--batch-size',
      '250',
      '--sample-limit=40',
    ]) }, {
      apply: false,
      batchSize: 250,
      sampleLimit: 40,
    });
    assert.deepEqual({ ...parseAuthArtifactArguments([
      '--batch-size=1000',
      '--sample-limit',
      '100',
    ]) }, {
      apply: false,
      batchSize: 1000,
      sampleLimit: 100,
    });
  });

  for (const value of ['0', '-1', '1.5', '1001', 'nope', '', ' 5']) {
    test(`rejects invalid batch size ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseAuthArtifactArguments(['--batch-size', value]),
        /--batch-size/u,
      );
    });
  }

  for (const value of ['0', '-2', '1.25', '101', 'NaN', '', ' 3']) {
    test(`rejects invalid sample limit ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseAuthArtifactArguments(['--sample-limit', value]),
        /--sample-limit/u,
      );
    });
  }

  test('rejects missing values and unsupported arguments', () => {
    assert.throws(
      () => parseAuthArtifactArguments(['--batch-size']),
      /--batch-size/u,
    );
    assert.throws(
      () => parseAuthArtifactArguments(['--sample-limit']),
      /--sample-limit/u,
    );
    assert.throws(
      () => parseAuthArtifactArguments(['--force']),
      /Unsupported argument/u,
    );
    assert.throws(
      () => parseAuthArtifactArguments(['--apply=true']),
      /Unsupported argument/u,
    );
  });
});

describe('Mongo authentication-artifact repository', () => {
  test('uses metadata-only audits, ID-only candidates and exact guarded writes', async () => {
    const calls = {
      tokenAggregate: [],
      userAggregate: [],
      tokenFind: [],
      userFind: [],
      tokenDeleteMany: [],
      userUpdateMany: [],
      tokenCount: [],
      userCount: [],
      tokenIndexes: 0,
      userIndexes: 0,
    };
    const tokenCollection = {
      aggregate(...args) {
        calls.tokenAggregate.push(args);
        return cursor([]);
      },
      find(...args) {
        calls.tokenFind.push(args);
        return cursor([{ _id: recordId }]);
      },
      async deleteMany(...args) {
        calls.tokenDeleteMany.push(args);
        return { deletedCount: 1 };
      },
      async countDocuments(...args) {
        calls.tokenCount.push(args);
        return 1;
      },
      async indexes() {
        calls.tokenIndexes += 1;
        return [{ name: '_id_', key: { _id: 1 }, v: 2 }];
      },
    };
    const userCollection = {
      aggregate(...args) {
        calls.userAggregate.push(args);
        return cursor([]);
      },
      find(...args) {
        calls.userFind.push(args);
        return cursor([{ _id: recordId }]);
      },
      async updateMany(...args) {
        calls.userUpdateMany.push(args);
        return { modifiedCount: 1 };
      },
      async countDocuments(...args) {
        calls.userCount.push(args);
        return 1;
      },
      async indexes() {
        calls.userIndexes += 1;
        return [{ name: '_id_', key: { _id: 1 }, v: 2 }];
      },
    };
    const repository = createMongoAuthArtifactRepository({
      TokenModel: { collection: tokenCollection },
      UserModel: { collection: userCollection },
    });

    for await (const unused of repository.iterateVerificationAuditBatches({
      batchSize: 10,
      now: NOW,
    })) void unused;
    for await (const unused of repository.iteratePasswordResetAuditBatches({
      batchSize: 10,
      now: NOW,
    })) void unused;
    const tokenCandidates = [];
    for await (const batch of repository.iterateVerificationCandidateIdBatches({
      batchSize: 10,
      limit: 1,
      now: NOW,
    })) tokenCandidates.push(...batch);
    const userCandidates = [];
    for await (const batch of repository.iteratePasswordResetCandidateIdBatches({
      batchSize: 10,
      limit: 1,
      now: NOW,
    })) userCandidates.push(...batch);

    assert.deepEqual(tokenCandidates, [{ _id: recordId }]);
    assert.deepEqual(userCandidates, [{ _id: recordId }]);
    const expiredTokenFilter = {
      email_verification_expiry: { $type: 'date', $lte: NOW },
    };
    const expiredUserFilter = {
      'other_login.reset_password_expiry': { $type: 'date', $lte: NOW },
    };
    assert.deepEqual(calls.tokenFind, [[expiredTokenFilter, {
      projection: { _id: 1 },
      sort: { _id: 1 },
      batchSize: 10,
      limit: 1,
    }]]);
    assert.deepEqual(calls.userFind, [[expiredUserFilter, {
      projection: { _id: 1 },
      sort: { _id: 1 },
      batchSize: 10,
      limit: 1,
    }]]);

    assert.deepEqual(
      await repository.deleteVerificationCandidateBatch({
        candidateIds: [recordId],
        now: NOW,
      }),
      { deletedCount: 1 },
    );
    assert.deepEqual(calls.tokenDeleteMany, [[{
      _id: { $in: [recordId] },
      ...expiredTokenFilter,
    }]]);

    assert.deepEqual(
      await repository.clearPasswordResetCandidateBatch({
        candidateIds: [recordId],
        now: NOW,
      }),
      { modifiedCount: 1 },
    );
    assert.deepEqual(calls.userUpdateMany, [[
      {
        _id: { $in: [recordId] },
        ...expiredUserFilter,
      },
      {
        $unset: {
          'other_login.reset_password_code': '',
          'other_login.reset_password_expiry': '',
          'other_login.reset_password_claim': '',
        },
        $set: {
          'other_login.reset_password_counter': 0,
        },
      },
    ]]);

    assert.equal(await repository.countExpiredVerificationCandidates({ now: NOW }), 1);
    assert.equal(await repository.countExpiredPasswordResetCandidates({ now: NOW }), 1);
    assert.deepEqual(calls.tokenCount, [[expiredTokenFilter]]);
    assert.deepEqual(calls.userCount, [[expiredUserFilter]]);
    assert.deepEqual(await repository.getVerificationIndexDefinitions(), [
      { name: '_id_', key: { _id: 1 }, v: 2 },
    ]);
    assert.deepEqual(await repository.getUserIndexDefinitions(), [
      { name: '_id_', key: { _id: 1 }, v: 2 },
    ]);
    assert.equal(calls.tokenIndexes, 1);
    assert.equal(calls.userIndexes, 1);

    const tokenProjection = calls.tokenAggregate[0][0][1].$project;
    const userProjection = calls.userAggregate[0][0][1].$project;
    assert.deepEqual(Object.keys(tokenProjection).sort(), [
      '_id',
      'ageBucket',
      'codeKind',
      'expiryKind',
      'unknownTopLevelFields',
      'userIdKind',
    ]);
    assert.deepEqual(Object.keys(userProjection).sort(), [
      '_id',
      'ageBucket',
      'claimKind',
      'codeKind',
      'counterKind',
      'expiryKind',
      'hasTransientResetArtifact',
      'noResetFields',
    ]);
    assert.deepEqual(userProjection.hasTransientResetArtifact, {
      $or: [
        {
          $ne: [
            { $type: '$other_login.reset_password_code' },
            'missing',
          ],
        },
        {
          $ne: [
            { $type: '$other_login.reset_password_expiry' },
            'missing',
          ],
        },
        {
          $ne: [
            { $type: '$other_login.reset_password_claim' },
            'missing',
          ],
        },
      ],
    });
    assert.equal(
      JSON.stringify(userProjection.hasTransientResetArtifact).includes(
        'reset_password_counter',
      ),
      false,
    );
    assert.equal('createIndex' in tokenCollection, false);
    assert.equal('dropIndex' in tokenCollection, false);
    assert.equal('createIndex' in userCollection, false);
    assert.equal('dropIndex' in userCollection, false);
  });
});

describe('authentication-artifact CLI lifecycle and safe output', () => {
  test('requires DB_URL before connecting', async () => {
    const harness = makeCliHarness();
    harness.dependencies.databaseUrl = '   ';
    await assert.rejects(
      () => runAuthArtifactReconciliationCli([], harness.dependencies),
      /DB_URL is required/u,
    );
    assert.deepEqual(harness.calls.connect, []);
    assert.equal(harness.calls.disconnect, 0);
  });

  test('connects with autoIndex disabled and disconnects after a successful connection', async () => {
    const harness = makeCliHarness();
    const summary = await runAuthArtifactReconciliationCli(
      ['--batch-size', '5', '--sample-limit=2'],
      harness.dependencies,
    );
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.complete, true);
    assert.deepEqual(harness.calls.connect, [[
      'mongodb://test.invalid/camp-pics',
      { autoIndex: false },
    ]]);
    assert.equal(harness.calls.disconnect, 1);
    assert.equal(harness.calls.log.length, 1);
    assert.deepEqual(harness.calls.error, []);
  });

  test('disconnects after post-connect audit failure and prints no raw data', async () => {
    const harness = makeCliHarness({
      repository: emptyRepository({
        async getVerificationIndexDefinitions() {
          throw new Error('raw-index-secret-mongodb://private-host');
        },
      }),
    });
    await assert.rejects(
      () => runAuthArtifactReconciliationCli([], harness.dependencies),
      /raw-index-secret/u,
    );
    assert.equal(harness.calls.disconnect, 1);
    assert.deepEqual(harness.calls.log, []);
    assert.deepEqual(harness.calls.error, []);
  });

  test('does not disconnect when the initial connection fails', async () => {
    const harness = makeCliHarness();
    harness.dependencies.connect = async () => {
      throw new Error('raw-connection-secret');
    };
    await assert.rejects(
      () => runAuthArtifactReconciliationCli([], harness.dependencies),
      /raw-connection-secret/u,
    );
    assert.equal(harness.calls.disconnect, 0);
    assert.deepEqual(harness.calls.log, []);
    assert.deepEqual(harness.calls.error, []);
  });

  test('safe output never contains stored authentication/account values', async () => {
    const repository = emptyRepository({
      iterateVerificationAuditBatches() {
        return cursor([[
          {
            _id: recordId,
            expiryKind: 'expired-date',
            userIdKind: 'object-id',
            codeKind: 'non-empty-string',
            unknownTopLevelFields: false,
            ageBucket: 'withinLast24Hours',
            rawSecret: 'verification-secret-fixture',
          },
        ]]);
      },
      iteratePasswordResetAuditBatches() {
        return cursor([[
          {
            _id: recordId,
            noResetFields: false,
            hasTransientResetArtifact: true,
            expiryKind: 'active-date',
            codeKind: 'non-empty-string',
            claimKind: 'non-empty-string',
            counterKind: 'nonnegative-integer',
            ageBucket: null,
            reset_password_code: 'reset-secret-fixture',
            reset_password_claim: 'claim-secret-fixture',
            username: 'private@example.test',
          },
        ]]);
      },
      async countExpiredVerificationCandidates() {
        return 1;
      },
      async getVerificationIndexDefinitions() {
        return [{
          name: '_id_',
          key: { _id: 1 },
          arbitrarySecret: 'index-secret-fixture',
        }];
      },
    });
    const harness = makeCliHarness({ repository });
    await runAuthArtifactReconciliationCli([], harness.dependencies);
    const output = [...harness.calls.log, ...harness.calls.error].join('\n');
    assert.doesNotMatch(
      output,
      /secret-fixture|private@example|reset_password_code|reset_password_claim/u,
    );
  });

  test('incomplete apply emits a fixed message and requests a nonzero exit', async () => {
    const rawFailure = 'raw-write-secret-mongodb://private-host';
    const repository = emptyRepository({
      iterateVerificationAuditBatches() {
        return cursor([[
          {
            _id: recordId,
            expiryKind: 'expired-date',
            userIdKind: 'object-id',
            codeKind: 'non-empty-string',
            unknownTopLevelFields: false,
            ageBucket: 'withinLast24Hours',
          },
        ]]);
      },
      iterateVerificationCandidateIdBatches() {
        return cursor([[{ _id: recordId }]]);
      },
      async deleteVerificationCandidateBatch() {
        throw new Error(rawFailure);
      },
      async countExpiredVerificationCandidates() {
        return 1;
      },
    });
    const harness = makeCliHarness({ repository });
    const summary = await runAuthArtifactReconciliationCli(
      ['--apply'],
      harness.dependencies,
    );
    assert.equal(summary.complete, false);
    assert.equal(summary.verificationTokens.failed, 1);
    assert.deepEqual(harness.calls.error, [AUTH_ARTIFACT_INCOMPLETE_MESSAGE]);
    assert.equal(harness.calls.incomplete, 1);
    assert.equal(harness.calls.disconnect, 1);
    const output = [...harness.calls.log, ...harness.calls.error].join('\n');
    assert.doesNotMatch(output, /raw-write|mongodb|private-host|Error:/u);
  });

  test('direct failures use one fixed content-free message and nonzero exit', () => {
    const calls = { error: [], exitCodes: [] };
    handleAuthArtifactDirectFailure({
      output: {
        error(value) {
          calls.error.push(value);
        },
      },
      setExitCode(value) {
        calls.exitCodes.push(value);
      },
    });
    assert.deepEqual(calls.error, [AUTH_ARTIFACT_DIRECT_FAILURE_MESSAGE]);
    assert.deepEqual(calls.exitCodes, [1]);
    assert.equal(calls.error[0], 'Authentication-artifact reconciliation failed.');
  });
});
