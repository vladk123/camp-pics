import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  EMAIL_LOG_MALFORMED_ISSUES,
  reconcileEmailLogs,
} from '../utils/emailLogReconciliation.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const RECOGNIZED_FIELDS = new Set([
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

const SECRETS = Object.freeze([
  'verification-token-fixture-9f32',
  'reset-token-fixture-6a81',
  'reset-user-id-fixture-44d2',
  'private-contact-message-fixture',
  'secret-recipient@example.test',
  'provider-message-id-fixture-73bc',
]);

function id(number) {
  return new mongoose.Types.ObjectId(
    number.toString(16).padStart(24, '0'),
  );
}

function daysAgo(days) {
  return new Date(NOW.getTime() - (days * DAY));
}

function ageBucket(sentAt, now) {
  if (!(sentAt instanceof Date)) return null;
  if (sentAt > now) return 'futureDated';
  const age = now.getTime() - sentAt.getTime();
  if (age <= 30 * DAY) return 'age0To30Days';
  if (age <= 90 * DAY) return 'age31To90Days';
  if (age <= 180 * DAY) return 'age91To180Days';
  if (age <= 365 * DAY) return 'age181To365Days';
  return 'olderThan365Days';
}

function safeAuditRow(document, now) {
  const hasSentAt = Object.hasOwn(document, 'sentAt');
  const datedBucket = ageBucket(document.sentAt, now);
  const finalAgeBucket = datedBucket || (
    hasSentAt ? 'invalidSentAt' : 'missingSentAt'
  );
  const olderThan = days => (
    document.sentAt instanceof Date &&
    document.sentAt < new Date(now.getTime() - (days * DAY))
  );
  return {
    _id: document._id,
    htmlPresent: Object.hasOwn(document, 'html'),
    subjectPresent: Object.hasOwn(document, 'subject'),
    templatePresent: Object.hasOwn(document, 'template'),
    templateValid: typeof document.template === 'string',
    userIdPresent: Object.hasOwn(document, 'userId'),
    userIdValid: document.userId instanceof mongoose.Types.ObjectId,
    messageIdPresent: Object.hasOwn(document, 'messageId'),
    messageIdValid: typeof document.messageId === 'string',
    recipientValid:
      typeof document.to === 'string' && document.to.length > 0,
    unknownTopLevelFields: Object.keys(document).some(
      field => !RECOGNIZED_FIELDS.has(field),
    ),
    ageBucket: finalAgeBucket,
    olderThan30Days: olderThan(30),
    olderThan90Days: olderThan(90),
    olderThan180Days: olderThan(180),
    olderThan365Days: olderThan(365),
  };
}

function makeHistoricalFixtures() {
  return [
    {
      _id: id(1),
      to: SECRETS[4],
      template: 'verify-account',
      html: `<a>${SECRETS[0]}</a>`,
      subject: 'Verify your account',
      userId: id(101),
      messageId: SECRETS[5],
      sentAt: daysAgo(10),
      __v: 0,
    },
    {
      _id: id(2),
      to: 'legacy-reset@example.test',
      html: `${SECRETS[1]}:${SECRETS[2]}`,
      sentAt: daysAgo(45),
    },
    {
      _id: id(3),
      to: 'contact@example.test',
      subject: SECRETS[3],
      sentAt: daysAgo(120),
    },
    {
      _id: id(4),
      to: 'current@example.test',
      template: 'verify-account',
      userId: id(104),
      messageId: 'valid-provider-id',
      sentAt: daysAgo(250),
    },
    {
      _id: id(5),
      to: 'older@example.test',
      template: 'reset-password',
      sentAt: daysAgo(500),
      unexpectedFixtureField: 'arbitrary-unknown-value',
    },
    {
      _id: id(6),
      to: '',
      template: 'contact',
    },
    {
      _id: id(7),
      to: 'invalid-metadata@example.test',
      template: 42,
      userId: 'not-an-object-id',
      messageId: { provider: 'not-a-string' },
      sentAt: 'not-a-date',
    },
    {
      _id: id(8),
      to: 'future@example.test',
      template: 'verify-account',
      sentAt: new Date(NOW.getTime() + DAY),
    },
  ];
}

function chunks(values, size) {
  return (async function* generate() {
    for (let index = 0; index < values.length; index += size) {
      yield values.slice(index, index + size);
    }
  })();
}

function makeRepository(documents, {
  indexes = [{ name: '_id_', key: { _id: 1 }, v: 2 }],
  failedBatchNumbers = [],
} = {}) {
  const state = documents;
  const failed = new Set(failedBatchNumbers);
  const calls = {
    auditBatchSizes: [],
    candidateReadShapes: [],
    candidateBatchSizes: [],
    writeBatches: [],
    writeNumber: 0,
  };
  const repository = {
    getIndexDefinitions: async () => indexes,

    iterateAuditBatches({ batchSize, now }) {
      const rows = state.map(document => safeAuditRow(document, now));
      return (async function* generate() {
        for await (const batch of chunks(rows, batchSize)) {
          calls.auditBatchSizes.push(batch.length);
          yield batch;
        }
      })();
    },

    iterateCandidateIdBatches({ batchSize, limit }) {
      const candidates = state
        .filter(document =>
          Object.hasOwn(document, 'html') ||
          Object.hasOwn(document, 'subject')
        )
        .slice(0, limit)
        .map(document => ({ _id: document._id }));
      calls.candidateReadShapes.push(
        ...candidates.map(candidate => Object.keys(candidate)),
      );
      return (async function* generate() {
        for await (const batch of chunks(candidates, batchSize)) {
          calls.candidateBatchSizes.push(batch.length);
          yield batch;
        }
      })();
    },

    async redactCandidateBatch(emailIds) {
      calls.writeNumber += 1;
      calls.writeBatches.push([...emailIds]);
      if (failed.has(calls.writeNumber)) {
        throw new Error(
          'mongodb://raw-database-detail/reset-token-fixture-6a81',
        );
      }
      let modifiedCount = 0;
      for (const emailId of emailIds) {
        const document = state.find(candidate =>
          candidate._id.toString() === emailId.toString()
        );
        if (
          !document ||
          (!Object.hasOwn(document, 'html') &&
            !Object.hasOwn(document, 'subject'))
        ) {
          continue;
        }
        delete document.html;
        delete document.subject;
        modifiedCount += 1;
      }
      return { modifiedCount };
    },

    async countSensitiveDocuments() {
      return state.filter(document =>
        Object.hasOwn(document, 'html') ||
        Object.hasOwn(document, 'subject')
      ).length;
    },
  };
  return { calls, repository, state };
}

function withoutLegacyContent(document) {
  const copy = { ...document };
  delete copy.html;
  delete copy.subject;
  return copy;
}

describe('Email log reconciliation audit', () => {
  test('reports exact content-free shapes, ages, and malformed documents', async () => {
    const fixtures = makeHistoricalFixtures();
    const before = JSON.stringify(fixtures);
    const { calls, repository } = makeRepository(fixtures);

    const summary = await reconcileEmailLogs({
      repository,
      batchSize: 3,
      sampleLimit: 2,
      now: () => NOW,
    });

    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.scanned, 8);
    assert.equal(summary.planned, 3);
    assert.equal(summary.changed, 0);
    assert.equal(summary.skipped, 5);
    assert.equal(summary.malformed, 3);
    assert.equal(summary.failed, 0);
    assert.equal(summary.remainingSensitive, 3);
    assert.equal(summary.incomplete, false);
    assert.deepEqual(summary.legacyFields, {
      html: 2,
      subject: 2,
      both: 1,
      either: 3,
      neither: 5,
    });
    assert.deepEqual(summary.metadataShape, {
      templatePresent: 6,
      templateAbsent: 2,
      templatePresentString: 5,
      templatePresentInvalidType: 1,
      userIdPresent: 3,
      userIdAbsent: 5,
      userIdPresentObjectId: 2,
      userIdPresentInvalidType: 1,
      messageIdPresent: 3,
      messageIdAbsent: 5,
      messageIdPresentString: 2,
      messageIdPresentInvalidType: 1,
      sentAtBsonDate: 6,
      sentAtMissing: 1,
      sentAtPresentNonDate: 1,
      recipientNonEmptyString: 7,
      recipientMissingEmptyOrInvalidType: 1,
      unknownTopLevelFields: 1,
    });
    assert.deepEqual(summary.ageBuckets, {
      futureDated: 1,
      age0To30Days: 1,
      age31To90Days: 1,
      age91To180Days: 1,
      age181To365Days: 1,
      olderThan365Days: 1,
      missingSentAt: 1,
      invalidSentAt: 1,
    });
    assert.deepEqual(summary.retentionCandidates, {
      olderThan30Days: 4,
      olderThan90Days: 3,
      olderThan180Days: 2,
      olderThan365Days: 1,
    });
    assert.equal(summary.samples.redactionCandidates.length, 2);
    assert.equal(summary.samples.malformed.length, 2);
    assert.equal(JSON.stringify(fixtures), before);
    assert.deepEqual(calls.writeBatches, []);
    assert.deepEqual(calls.candidateReadShapes, []);
    assert.ok(calls.auditBatchSizes.every(size => size <= 3));

    for (const sample of summary.samples.redactionCandidates) {
      assert.deepEqual(Object.keys(sample), ['emailId']);
    }
    for (const sample of summary.samples.malformed) {
      assert.deepEqual(Object.keys(sample), ['emailId', 'issues']);
      assert.ok(sample.issues.every(issue =>
        Object.values(EMAIL_LOG_MALFORMED_ISSUES).includes(issue)
      ));
    }

    const serialized = JSON.stringify(summary);
    for (const secret of [
      ...SECRETS,
      'legacy-reset@example.test',
      'arbitrary-unknown-value',
      'not-an-object-id',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
    }
  });

  test('does not classify legacy content or a missing template as malformed', async () => {
    const documents = [{
      _id: id(20),
      to: 'legacy@example.test',
      html: '<p>legacy</p>',
      subject: 'legacy',
      sentAt: NOW,
    }];
    const { repository } = makeRepository(documents);

    const summary = await reconcileEmailLogs({
      repository,
      now: () => NOW,
    });

    assert.equal(summary.planned, 1);
    assert.equal(summary.metadataShape.templateAbsent, 1);
    assert.equal(summary.malformed, 0);
  });
});

describe('Email log reconciliation index audit', () => {
  test('allowlists index metadata and reports an existing TTL without mutation', async () => {
    const documents = makeHistoricalFixtures();
    const indexes = [
      { name: '_id_', key: { _id: 1 }, v: 2 },
      {
        name: 'sentAt_ttl',
        key: { sentAt: 1 },
        unique: false,
        sparse: true,
        expireAfterSeconds: 86400,
        partialFilterExpression: { secret: 'do-not-output-this-value' },
        storageEngine: { secret: 'also-not-output' },
        v: 2,
      },
    ];
    const { calls, repository } = makeRepository(documents, { indexes });

    const summary = await reconcileEmailLogs({
      repository,
      now: () => NOW,
    });

    assert.equal(summary.indexCount, 2);
    assert.equal(summary.indexesTruncated, false);
    assert.deepEqual(summary.indexes, [
      { name: '_id_', key: { _id: 1 } },
      {
        name: 'sentAt_ttl',
        key: { sentAt: 1 },
        unique: false,
        sparse: true,
        expireAfterSeconds: 86400,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(summary), /do-not-output|storageEngine/u);
    assert.deepEqual(calls.writeBatches, []);
    assert.equal('createIndex' in repository, false);
    assert.equal('dropIndex' in repository, false);
  });
});

describe('Email log reconciliation apply behavior', () => {
  test('redacts every sensitive candidate in bounded ID-only batches and reruns idempotently', async () => {
    const documents = [
      {
        _id: id(30),
        to: 'first@example.test',
        template: 'verify-account',
        html: '<p>verification-token-fixture-9f32</p>',
        subject: 'First',
        userId: id(130),
        messageId: 'first-provider-id',
        sentAt: daysAgo(10),
        preservedUnknown: { nested: true },
      },
      {
        _id: id(31),
        to: 42,
        html: '<p>malformed but sensitive</p>',
        sentAt: daysAgo(20),
      },
      {
        _id: id(32),
        to: 'current@example.test',
        template: 'contact',
        sentAt: NOW,
      },
    ];
    const originals = documents.map(document => ({ ...document }));
    const { calls, repository } = makeRepository(documents);

    const first = await reconcileEmailLogs({
      repository,
      apply: true,
      batchSize: 1,
      now: () => NOW,
    });

    assert.equal(first.planned, 2);
    assert.equal(first.changed, 2);
    assert.equal(first.skipped, 1);
    assert.equal(first.malformed, 2);
    assert.equal(first.failed, 0);
    assert.equal(first.remainingSensitive, 0);
    assert.equal(first.incomplete, false);
    assert.ok(calls.candidateBatchSizes.every(size => size <= 1));
    assert.ok(calls.candidateReadShapes.every(keys =>
      keys.length === 1 && keys[0] === '_id'
    ));
    assert.deepEqual(
      documents.map(withoutLegacyContent),
      originals.map(withoutLegacyContent),
    );
    assert.ok(documents.every(document =>
      !Object.hasOwn(document, 'html') &&
      !Object.hasOwn(document, 'subject')
    ));

    const writesAfterFirstRun = calls.writeBatches.length;
    const second = await reconcileEmailLogs({
      repository,
      apply: true,
      batchSize: 1,
      now: () => NOW,
    });
    assert.equal(second.planned, 0);
    assert.equal(second.changed, 0);
    assert.equal(second.skipped, 3);
    assert.equal(second.remainingSensitive, 0);
    assert.equal(calls.writeBatches.length, writesAfterFirstRun);
  });

  test('counts disappeared and concurrently redacted candidates as skipped', async () => {
    const documents = [
      { _id: id(40), to: 'one@example.test', html: 'one', sentAt: NOW },
      { _id: id(41), to: 'two@example.test', html: 'two', sentAt: NOW },
      { _id: id(42), to: 'three@example.test', subject: 'three', sentAt: NOW },
      { _id: id(43), to: 'current@example.test', sentAt: NOW },
    ];
    const { repository, state } = makeRepository(documents);
    const originalIterator = repository.iterateCandidateIdBatches;
    repository.iterateCandidateIdBatches = options => {
      state.splice(1, 1);
      return originalIterator(options);
    };
    const originalWrite = repository.redactCandidateBatch;
    let writeNumber = 0;
    repository.redactCandidateBatch = async emailIds => {
      writeNumber += 1;
      if (writeNumber === 2) {
        const document = state.find(candidate =>
          candidate._id.toString() === emailIds[0].toString()
        );
        delete document?.html;
        delete document?.subject;
      }
      return originalWrite(emailIds);
    };

    const summary = await reconcileEmailLogs({
      repository,
      apply: true,
      batchSize: 1,
      now: () => NOW,
    });

    assert.equal(summary.scanned, 4);
    assert.equal(summary.planned, 3);
    assert.equal(summary.changed, 1);
    assert.equal(summary.skipped, 3);
    assert.equal(summary.failed, 0);
    assert.equal(summary.remainingSensitive, 0);
  });

  test('continues after a failed batch, reports incomplete work, and remains safely rerunnable', async () => {
    const documents = [
      { _id: id(50), to: 'one@example.test', html: 'one', sentAt: NOW },
      { _id: id(51), to: 'two@example.test', subject: 'two', sentAt: NOW },
      { _id: id(52), to: 'three@example.test', html: 'three', sentAt: NOW },
    ];
    const harness = makeRepository(documents, {
      failedBatchNumbers: [1],
    });

    const first = await reconcileEmailLogs({
      repository: harness.repository,
      apply: true,
      batchSize: 2,
      now: () => NOW,
    });

    assert.equal(first.planned, 3);
    assert.equal(first.changed, 1);
    assert.equal(first.failed, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.remainingSensitive, 2);
    assert.equal(first.incomplete, true);
    assert.equal(harness.calls.writeBatches.length, 2);
    assert.doesNotMatch(
      JSON.stringify(first),
      /mongodb|raw-database-detail|reset-token-fixture/u,
    );

    const rerun = makeRepository(documents);
    const second = await reconcileEmailLogs({
      repository: rerun.repository,
      apply: true,
      batchSize: 2,
      now: () => NOW,
    });
    assert.equal(second.planned, 2);
    assert.equal(second.changed, 2);
    assert.equal(second.failed, 0);
    assert.equal(second.remainingSensitive, 0);
    assert.equal(second.incomplete, false);
  });
});
