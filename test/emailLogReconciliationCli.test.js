import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  EMAIL_LOG_DIRECT_FAILURE_MESSAGE,
  EMAIL_LOG_INCOMPLETE_MESSAGE,
  createMongoEmailLogRepository,
  handleEmailLogDirectFailure,
  parseEmailLogArguments,
  runEmailLogReconciliationCli,
} from '../scripts/reconcileEmailLogs.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');

function id(number) {
  return new mongoose.Types.ObjectId(
    number.toString(16).padStart(24, '0'),
  );
}

function cursor(values) {
  return (async function* generate() {
    for (const value of values) yield value;
  })();
}

function emptyRepository(overrides = {}) {
  return {
    iterateAuditBatches() {
      return cursor([]);
    },
    iterateCandidateIdBatches() {
      return cursor([]);
    },
    async redactCandidateBatch() {
      return { modifiedCount: 0 };
    },
    async countSensitiveDocuments() {
      return 0;
    },
    async getIndexDefinitions() {
      return [{ name: '_id_', key: { _id: 1 } }];
    },
    ...overrides,
  };
}

function makeCliHarness({ repository = emptyRepository() } = {}) {
  const calls = {
    connect: [],
    disconnect: 0,
    incomplete: 0,
    log: [],
    error: [],
  };
  return {
    calls,
    dependencies: {
      repository,
      databaseUrl: 'mongodb://test.invalid/camp-pics',
      clock: () => NOW,
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

describe('Email log CLI argument parsing', () => {
  test('defaults to dry-run and only the explicit apply flag enables writes', () => {
    assert.deepEqual({ ...parseEmailLogArguments([]) }, {
      apply: false,
      batchSize: 100,
      sampleLimit: 20,
    });
    assert.equal(parseEmailLogArguments(['--apply']).apply, true);
    assert.throws(
      () => parseEmailLogArguments(['--apply=true']),
      /Unsupported argument/u,
    );
  });

  test('accepts valid bounded batch and sample limits', () => {
    assert.deepEqual(
      { ...parseEmailLogArguments([
        '--batch-size',
        '1',
        '--sample-limit=100',
      ]) },
      { apply: false, batchSize: 1, sampleLimit: 100 },
    );
    assert.deepEqual(
      { ...parseEmailLogArguments([
        '--apply',
        '--batch-size=1000',
        '--sample-limit',
        '1',
      ]) },
      { apply: true, batchSize: 1000, sampleLimit: 1 },
    );
  });

  for (const value of ['0', '-1', '1.5', '1001', 'not-a-number']) {
    test(`rejects invalid batch size ${value}`, () => {
      assert.throws(
        () => parseEmailLogArguments(['--batch-size', value]),
        /--batch-size/u,
      );
    });
  }

  for (const value of ['0', '-1', '1.5', '101', 'not-a-number']) {
    test(`rejects invalid sample limit ${value}`, () => {
      assert.throws(
        () => parseEmailLogArguments(['--sample-limit', value]),
        /--sample-limit/u,
      );
    });
  }

  test('rejects missing numeric values and every unsupported argument', () => {
    assert.throws(
      () => parseEmailLogArguments(['--batch-size']),
      /--batch-size/u,
    );
    assert.throws(
      () => parseEmailLogArguments(['--sample-limit']),
      /--sample-limit/u,
    );
    assert.throws(
      () => parseEmailLogArguments(['--delete']),
      /Unsupported argument/u,
    );
    assert.throws(
      () => parseEmailLogArguments(['positional-value']),
      /Unsupported argument/u,
    );
  });
});

describe('Mongo Email log repository', () => {
  test('projects only safe audit flags, retrieves candidate IDs, and issues the guarded unset', async () => {
    const emailId = id(1);
    const calls = {
      aggregate: [],
      find: [],
      updateMany: [],
      countDocuments: [],
      indexes: 0,
    };
    const collection = {
      aggregate(...args) {
        calls.aggregate.push(args);
        return cursor([{
          _id: emailId,
          htmlPresent: true,
          subjectPresent: true,
          templatePresent: false,
          templateValid: false,
          userIdPresent: false,
          userIdNull: false,
          userIdValid: false,
          messageIdPresent: false,
          messageIdValid: false,
          recipientValid: true,
          unknownTopLevelFields: false,
          ageBucket: 'age0To30Days',
          olderThan30Days: false,
          olderThan90Days: false,
          olderThan180Days: false,
          olderThan365Days: false,
        }]);
      },
      find(...args) {
        calls.find.push(args);
        return cursor([{ _id: emailId }]);
      },
      async updateMany(...args) {
        calls.updateMany.push(args);
        return { modifiedCount: 1 };
      },
      async countDocuments(...args) {
        calls.countDocuments.push(args);
        return 1;
      },
      async indexes() {
        calls.indexes += 1;
        return [{ name: '_id_', key: { _id: 1 }, v: 2 }];
      },
    };
    const repository = createMongoEmailLogRepository({
      EmailModel: { collection },
    });

    const auditBatches = [];
    for await (const batch of repository.iterateAuditBatches({
      batchSize: 10,
      now: NOW,
    })) {
      auditBatches.push(batch);
    }
    assert.equal(auditBatches.length, 1);
    const [pipeline, aggregateOptions] = calls.aggregate[0];
    assert.deepEqual(pipeline[0], { $sort: { _id: 1 } });
    const projection = pipeline[1].$project;
    assert.deepEqual(Object.keys(projection).sort(), [
      '_id',
      'ageBucket',
      'htmlPresent',
      'messageIdPresent',
      'messageIdValid',
      'olderThan180Days',
      'olderThan30Days',
      'olderThan365Days',
      'olderThan90Days',
      'recipientValid',
      'subjectPresent',
      'templatePresent',
      'templateValid',
      'unknownTopLevelFields',
      'userIdNull',
      'userIdPresent',
      'userIdValid',
    ].sort());
    assert.deepEqual(projection.userIdNull, {
      $eq: [{ $type: '$userId' }, 'null'],
    });
    for (const sensitiveOutput of [
      'html',
      'subject',
      'to',
      'template',
      'userId',
      'messageId',
      'sentAt',
    ]) {
      assert.equal(Object.hasOwn(projection, sensitiveOutput), false);
    }
    assert.deepEqual(aggregateOptions, {
      allowDiskUse: true,
      batchSize: 10,
    });

    const candidateBatches = [];
    for await (const batch of repository.iterateCandidateIdBatches({
      batchSize: 10,
      limit: 1,
    })) {
      candidateBatches.push(batch);
    }
    assert.deepEqual(candidateBatches, [[{ _id: emailId }]]);
    const [candidateFilter, candidateOptions] = calls.find[0];
    assert.deepEqual(candidateFilter, {
      $or: [
        { html: { $exists: true } },
        { subject: { $exists: true } },
      ],
    });
    assert.deepEqual(candidateOptions, {
      projection: { _id: 1 },
      sort: { _id: 1 },
      batchSize: 10,
      limit: 1,
    });

    assert.deepEqual(
      await repository.redactCandidateBatch([emailId]),
      { modifiedCount: 1 },
    );
    assert.deepEqual(calls.updateMany, [[
      {
        _id: { $in: [emailId] },
        $or: [
          { html: { $exists: true } },
          { subject: { $exists: true } },
        ],
      },
      { $unset: { html: '', subject: '' } },
    ]]);
    assert.equal(await repository.countSensitiveDocuments(), 1);
    assert.deepEqual(calls.countDocuments[0], [candidateFilter]);
    assert.deepEqual(await repository.getIndexDefinitions(), [
      { name: '_id_', key: { _id: 1 }, v: 2 },
    ]);
    assert.equal(calls.indexes, 1);
    assert.equal('deleteOne' in collection, false);
    assert.equal('deleteMany' in collection, false);
    assert.equal('createIndex' in collection, false);
    assert.equal('dropIndex' in collection, false);
  });
});

describe('Email log CLI lifecycle and safe output', () => {
  test('requires DB_URL before connecting', async () => {
    const harness = makeCliHarness();
    harness.dependencies.databaseUrl = '';

    await assert.rejects(
      () => runEmailLogReconciliationCli([], harness.dependencies),
      /DB_URL is required/u,
    );
    assert.deepEqual(harness.calls.connect, []);
    assert.equal(harness.calls.disconnect, 0);
  });

  test('connects with autoIndex disabled and disconnects after success', async () => {
    const harness = makeCliHarness();

    const summary = await runEmailLogReconciliationCli(
      ['--batch-size', '5', '--sample-limit', '2'],
      harness.dependencies,
    );

    assert.equal(summary.mode, 'dry-run');
    assert.deepEqual(harness.calls.connect, [[
      'mongodb://test.invalid/camp-pics',
      { autoIndex: false },
    ]]);
    assert.equal(harness.calls.disconnect, 1);
    assert.equal(harness.calls.log.length, 1);
    assert.deepEqual(harness.calls.error, []);
  });

  test('disconnects after a post-connect audit failure without outputting it', async () => {
    const harness = makeCliHarness({
      repository: emptyRepository({
        async getIndexDefinitions() {
          throw new Error('raw-index-database-detail');
        },
      }),
    });

    await assert.rejects(
      () => runEmailLogReconciliationCli([], harness.dependencies),
      /raw-index-database-detail/u,
    );
    assert.equal(harness.calls.disconnect, 1);
    assert.deepEqual(harness.calls.log, []);
    assert.deepEqual(harness.calls.error, []);
  });

  test('does not disconnect when connection itself fails', async () => {
    const harness = makeCliHarness();
    harness.dependencies.connect = async () => {
      throw new Error('raw-connection-database-detail');
    };

    await assert.rejects(
      () => runEmailLogReconciliationCli([], harness.dependencies),
      /raw-connection-database-detail/u,
    );
    assert.equal(harness.calls.disconnect, 0);
    assert.deepEqual(harness.calls.log, []);
    assert.deepEqual(harness.calls.error, []);
  });

  test('serialized audit output excludes stored values and arbitrary index options', async () => {
    const emailId = id(10);
    const rawDocument = {
      _id: emailId,
      to: 'secret-recipient@example.test',
      template: 'verify-account',
      subject: 'private-contact-message-fixture',
      html: '<a>verification-token-fixture-9f32</a>',
      userId: 'sensitive-user-id-fixture-5d73',
      messageId: 'provider-message-id-fixture-73bc',
      sentAt: NOW,
    };
    const repository = emptyRepository({
      iterateAuditBatches() {
        return cursor([[
          {
            _id: rawDocument._id,
            htmlPresent: Object.hasOwn(rawDocument, 'html'),
            subjectPresent: Object.hasOwn(rawDocument, 'subject'),
            templatePresent: Object.hasOwn(rawDocument, 'template'),
            templateValid: typeof rawDocument.template === 'string',
            userIdPresent: Object.hasOwn(rawDocument, 'userId'),
            userIdNull: rawDocument.userId === null,
            userIdValid: false,
            messageIdPresent: Object.hasOwn(rawDocument, 'messageId'),
            messageIdValid: typeof rawDocument.messageId === 'string',
            recipientValid:
              typeof rawDocument.to === 'string' &&
              rawDocument.to.length > 0,
            unknownTopLevelFields: false,
            ageBucket: 'age0To30Days',
            olderThan30Days: false,
            olderThan90Days: false,
            olderThan180Days: false,
            olderThan365Days: false,
          },
        ]]);
      },
      async countSensitiveDocuments() {
        return 1;
      },
      async getIndexDefinitions() {
        return [{
          name: '_id_',
          key: { _id: 1 },
          arbitraryOption: 'verification-token-fixture-9f32',
        }];
      },
    });
    const harness = makeCliHarness({ repository });

    await runEmailLogReconciliationCli([], harness.dependencies);

    const output = [
      ...harness.calls.log,
      ...harness.calls.error,
    ].join('\n');
    assert.match(output, /"mode": "dry-run"/u);
    assert.doesNotMatch(
      output,
      /verification-token-fixture|recipient@example|provider-message|private-contact-message|sensitive-user-id/u,
    );
  });

  test('failed apply batches emit only a fixed incomplete message and safe summary', async () => {
    const emailId = id(20);
    const rawFailure = 'mongodb://secret-host/reset-token-fixture';
    const repository = emptyRepository({
      iterateAuditBatches() {
        return cursor([[
          {
            _id: emailId,
            htmlPresent: true,
            subjectPresent: false,
            templatePresent: false,
            templateValid: false,
            userIdPresent: false,
            userIdNull: false,
            userIdValid: false,
            messageIdPresent: false,
            messageIdValid: false,
            recipientValid: true,
            unknownTopLevelFields: false,
            ageBucket: 'age0To30Days',
            olderThan30Days: false,
            olderThan90Days: false,
            olderThan180Days: false,
            olderThan365Days: false,
          },
        ]]);
      },
      iterateCandidateIdBatches() {
        return cursor([[{ _id: emailId }]]);
      },
      async redactCandidateBatch() {
        throw new Error(rawFailure);
      },
      async countSensitiveDocuments() {
        return 1;
      },
    });
    const harness = makeCliHarness({ repository });

    const summary = await runEmailLogReconciliationCli(
      ['--apply'],
      harness.dependencies,
    );

    assert.equal(summary.failed, 1);
    assert.equal(summary.incomplete, true);
    assert.deepEqual(harness.calls.error, [EMAIL_LOG_INCOMPLETE_MESSAGE]);
    assert.equal(harness.calls.incomplete, 1);
    const output = [...harness.calls.log, ...harness.calls.error].join('\n');
    assert.doesNotMatch(output, /mongodb|secret-host|reset-token/u);
    assert.doesNotMatch(output, /Error:/u);
  });

  test('direct fatal handling emits one fixed message and no raw Error', () => {
    const calls = { error: [], exitCodes: [] };
    handleEmailLogDirectFailure({
      output: {
        error(value) {
          calls.error.push(value);
        },
      },
      setExitCode(value) {
        calls.exitCodes.push(value);
      },
    });

    assert.deepEqual(calls.error, [EMAIL_LOG_DIRECT_FAILURE_MESSAGE]);
    assert.deepEqual(calls.exitCodes, [1]);
    assert.equal(typeof calls.error[0], 'string');
    assert.equal(calls.error[0], 'Email log reconciliation failed.');
  });
});
