import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import { MediaCleanupJob } from '../models/mediaCleanupJob.js';
import {
  CLOUDINARY_PROVIDER_RESULT_UNEXPECTED,
  CLOUDINARY_PROVIDER_UNAVAILABLE,
  INVALID_CLOUDINARY_PUBLIC_ID,
  MAX_MEDIA_CLEANUP_BACKOFF_MS,
  createMediaCleanupJobProcessor,
  mediaCleanupBackoffMs,
} from '../utils/mediaCleanupJobs.js';

function objectId() {
  return new mongoose.Types.ObjectId();
}

function idsEqual(left, right) {
  return left?.toString() === right?.toString();
}

function clone(value) {
  if (
    value == null ||
    typeof value !== 'object' ||
    value instanceof mongoose.Types.ObjectId
  ) {
    return value;
  }
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clone(item)]),
  );
}

function isEligible(job, filter) {
  if (filter._id && !idsEqual(job._id, filter._id)) return false;
  if (!filter.$or) return true;
  return filter.$or.some(condition => {
    if (condition.status !== job.status) return false;
    if (condition.nextAttemptAt?.$lte) {
      return job.nextAttemptAt <= condition.nextAttemptAt.$lte;
    }
    if (condition.leaseExpiresAt?.$lte) {
      return job.leaseExpiresAt <= condition.leaseExpiresAt.$lte;
    }
    return true;
  });
}

function makeModel(
  initialJobs,
  {
    failDeleteOnce = false,
    failUpdateOnce = false,
    beforeFindReturn = null,
  } = {},
) {
  const state = {
    jobs: initialJobs.map(clone),
    failDeleteOnce,
    failUpdateOnce,
  };
  const calls = {
    claimAttempts: 0,
    claimedLeaseTokens: [],
    claims: 0,
    updates: [],
    deletes: [],
  };

  const model = {
    async findOneAndUpdate(filter, update) {
      calls.claimAttempts += 1;
      const job = state.jobs.find(item => isEligible(item, filter));
      if (!job) return null;
      calls.claims += 1;
      calls.claimedLeaseTokens.push(update.$set.leaseToken);
      Object.assign(job, clone(update.$set));
      job.attemptCount += update.$inc.attemptCount;
      return clone(job);
    },
    async findOne(filter) {
      return clone(state.jobs.find(job => idsEqual(job._id, filter._id)));
    },
    async updateOne(filter, update) {
      calls.updates.push({ filter: clone(filter), update: clone(update) });
      if (state.failUpdateOnce) {
        state.failUpdateOnce = false;
        throw new Error('raw update failure');
      }
      const job = state.jobs.find(item =>
        idsEqual(item._id, filter._id) &&
        item.leaseToken === filter.leaseToken
      );
      if (!job) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(job, clone(update.$set || {}));
      for (const key of Object.keys(update.$unset || {})) delete job[key];
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter) {
      calls.deletes.push(clone(filter));
      if (state.failDeleteOnce) {
        state.failDeleteOnce = false;
        throw new Error('raw finalization failure');
      }
      const index = state.jobs.findIndex(item =>
        idsEqual(item._id, filter._id) &&
        item.leaseToken === filter.leaseToken
      );
      if (index < 0) return { deletedCount: 0 };
      state.jobs.splice(index, 1);
      return { deletedCount: 1 };
    },
    async find(filter, projection, options) {
      const visibleJobs = state.jobs
        .filter(job => isEligible(job, filter))
        .slice(0, options.limit)
        .map(job => ({ _id: job._id }));
      if (beforeFindReturn) await beforeFindReturn(clone(visibleJobs));
      return visibleJobs;
    },
  };
  return { calls, model, state };
}

function pendingJob(overrides = {}) {
  return {
    _id: objectId(),
    mediaId: objectId(),
    parkId: objectId(),
    kind: 'cloudinary-photo-delete',
    cloudinaryPublicId: 'camp-parks/photo',
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: new Date('2026-07-30T11:59:00.000Z'),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test('cleanup-job schema is focused, validates public IDs, and adds no index', async () => {
  const paths = Object.keys(MediaCleanupJob.schema.paths);
  for (const requiredPath of [
    'kind',
    'mediaId',
    'parkId',
    'cloudinaryPublicId',
    'status',
    'attemptCount',
    'nextAttemptAt',
    'createdAt',
    'updatedAt',
  ]) {
    assert.ok(paths.includes(requiredPath), requiredPath);
  }
  for (const forbiddenPath of [
    'caption',
    'url',
    'username',
    'email',
    'requestBody',
    'providerResponse',
    'credentials',
  ]) {
    assert.equal(paths.includes(forbiddenPath), false, forbiddenPath);
  }
  assert.deepEqual(MediaCleanupJob.schema.indexes(), []);

  const valid = new MediaCleanupJob({
    mediaId: objectId(),
    parkId: objectId(),
    cloudinaryPublicId: 'camp-parks/photo',
  });
  await valid.validate();

  const malformed = new MediaCleanupJob({
    mediaId: objectId(),
    parkId: objectId(),
    cloudinaryPublicId:
      'https://res.cloudinary.com/demo/image/upload/photo.jpg',
  });
  await assert.rejects(() => malformed.validate());
});

describe('media cleanup claiming and provider handling', () => {
  test('overlapping batches discover one job but only one lease performs provider work', async () => {
    const job = pendingJob();
    const bothBatchesDiscovered = deferred();
    const discoveries = [];
    const { calls, model, state } = makeModel([job], {
      async beforeFindReturn(visibleJobs) {
        discoveries.push(visibleJobs.map(item => item._id.toString()));
        if (discoveries.length === 2) bothBatchesDiscovered.resolve();
        await bothBatchesDiscovered.promise;
      },
    });
    const providerCalls = [];
    const processorDependencies = {
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy(publicId) {
            providerCalls.push(publicId);
            return { result: 'ok' };
          },
        },
      },
      clock: () => new Date('2026-07-30T12:00:00.000Z'),
      leaseMs: 60_000,
    };
    const firstProcessor = createMediaCleanupJobProcessor({
      ...processorDependencies,
      leaseTokenGenerator: () => 'first-batch-lease',
    });
    const secondProcessor = createMediaCleanupJobProcessor({
      ...processorDependencies,
      leaseTokenGenerator: () => 'second-batch-lease',
    });

    const summaries = await Promise.all([
      firstProcessor.processPendingJobs({ limit: 50 }),
      secondProcessor.processPendingJobs({ limit: 50 }),
    ]);
    const completedRun = summaries.find(summary => summary.completed === 1);
    const overlappingRun = summaries.find(summary => summary.completed === 0);

    assert.deepEqual(discoveries, [
      [job._id.toString()],
      [job._id.toString()],
    ]);
    assert.equal(calls.claimAttempts, 2);
    assert.equal(calls.claims, 1);
    assert.deepEqual(providerCalls, ['camp-parks/photo']);
    assert.ok(completedRun);
    assert.ok(overlappingRun);
    assert.equal(overlappingRun.scanned, 1);
    assert.equal(overlappingRun.claimed, 0);
    assert.equal(
      overlappingRun.stillPending + overlappingRun.skipped,
      1,
    );
    assert.equal(calls.deletes.length, 1);
    assert.equal(
      calls.deletes[0].leaseToken,
      calls.claimedLeaseTokens[0],
    );
    assert.equal(state.jobs.length, 0);
  });

  test('two workers cannot claim the same active lease', async () => {
    const job = pendingJob();
    const { model, state } = makeModel([job]);
    const provider = deferred();
    let calls = 0;
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          destroy() {
            calls += 1;
            return provider.promise;
          },
        },
      },
      clock: () => new Date('2026-07-30T12:00:00.000Z'),
      leaseTokenGenerator: (() => {
        let token = 0;
        return () => `lease-${++token}`;
      })(),
      leaseMs: 60_000,
    });

    const first = processor.processJobById(job._id);
    await Promise.resolve();
    const second = await processor.processJobById(job._id);

    assert.equal(second.claimed, false);
    assert.equal(second.status, 'processing');
    assert.equal(calls, 1);
    assert.equal(state.jobs[0].attemptCount, 1);
    provider.resolve({ result: 'ok' });
    assert.equal((await first).completed, true);
  });

  test('an expired lease is reclaimed with a new token and incremented attempt', async () => {
    const job = pendingJob({
      status: 'processing',
      attemptCount: 2,
      leaseToken: 'expired-token',
      leaseExpiresAt: new Date('2026-07-30T11:59:59.000Z'),
    });
    const { calls, model } = makeModel([job]);
    const providerCalls = [];
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy(publicId) {
            providerCalls.push(publicId);
            return { result: 'ok' };
          },
        },
      },
      clock: () => new Date('2026-07-30T12:00:00.000Z'),
      leaseTokenGenerator: () => 'new-token',
      leaseMs: 60_000,
    });

    const result = await processor.processJobById(job._id);

    assert.equal(result.completed, true);
    assert.equal(calls.deletes[0].leaseToken, 'new-token');
    assert.deepEqual(providerCalls, ['camp-parks/photo']);
  });

  test('a stale worker cannot finalize after another worker reclaims', async () => {
    const job = pendingJob();
    const { calls, model, state } = makeModel([job]);
    const firstProvider = deferred();
    let providerCall = 0;
    let now = new Date('2026-07-30T12:00:00.000Z');
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          destroy() {
            providerCall += 1;
            return providerCall === 1
              ? firstProvider.promise
              : Promise.resolve({ result: 'ok' });
          },
        },
      },
      clock: () => now,
      leaseTokenGenerator: (() => {
        let token = 0;
        return () => `lease-${++token}`;
      })(),
      leaseMs: 1_000,
    });

    const staleWorker = processor.processJobById(job._id);
    await Promise.resolve();
    now = new Date('2026-07-30T12:00:02.000Z');
    const currentWorker = await processor.processJobById(job._id);
    firstProvider.resolve({ result: 'ok' });
    const staleResult = await staleWorker;

    assert.equal(currentWorker.completed, true);
    assert.equal(staleResult.staleLease, true);
    assert.deepEqual(
      calls.deletes.map(call => call.leaseToken),
      ['lease-2', 'lease-1'],
    );
    assert.equal(state.jobs.length, 0);
  });

  test('a stale worker cannot release another worker’s active lease', async () => {
    const job = pendingJob();
    const { calls, model, state } = makeModel([job]);
    const firstProvider = deferred();
    const secondProvider = deferred();
    let providerCall = 0;
    let now = new Date('2026-07-30T12:00:00.000Z');
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          destroy() {
            providerCall += 1;
            return providerCall === 1
              ? firstProvider.promise
              : secondProvider.promise;
          },
        },
      },
      clock: () => now,
      leaseTokenGenerator: (() => {
        let token = 0;
        return () => `lease-${++token}`;
      })(),
      leaseMs: 1_000,
    });

    const staleWorker = processor.processJobById(job._id);
    await Promise.resolve();
    now = new Date('2026-07-30T12:00:02.000Z');
    const currentWorker = processor.processJobById(job._id);
    await Promise.resolve();
    firstProvider.reject(new Error('raw stale failure'));
    const staleResult = await staleWorker;

    assert.equal(staleResult.staleLease, true);
    assert.equal(calls.updates[0].filter.leaseToken, 'lease-1');
    assert.equal(state.jobs[0].status, 'processing');
    assert.equal(state.jobs[0].leaseToken, 'lease-2');
    secondProvider.resolve({ result: 'ok' });
    assert.equal((await currentWorker).completed, true);
    assert.equal(calls.deletes[0].leaseToken, 'lease-2');
    assert.equal(state.jobs.length, 0);
  });

  for (const providerResult of ['ok', 'not found']) {
    test(`${providerResult} finalizes the exact leased job`, async () => {
      const job = pendingJob();
      const { model, state } = makeModel([job]);
      const processor = createMediaCleanupJobProcessor({
        CleanupJobModel: model,
        cloudinaryClient: {
          uploader: {
            async destroy() {
              return { result: providerResult };
            },
          },
        },
        clock: () => new Date('2026-07-30T12:00:00.000Z'),
        leaseTokenGenerator: () => 'lease-token',
        leaseMs: 60_000,
      });

      const result = await processor.processJobById(job._id);

      assert.equal(result.completed, true);
      assert.equal(state.jobs.length, 0);
    });
  }

  test('a slow network error schedules backoff from failure time', async () => {
    const job = pendingJob();
    const { model, state } = makeModel([job]);
    const providerCall = deferred();
    const providerStarted = deferred();
    let now = new Date('2026-07-30T12:00:00.000Z');
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy() {
            providerStarted.resolve();
            return providerCall.promise;
          },
        },
      },
      clock: () => now,
      leaseTokenGenerator: () => 'lease-token',
      leaseMs: 60_000,
    });

    const processing = processor.processJobById(job._id);
    await providerStarted.promise;
    now = new Date('2026-07-30T12:04:00.000Z');
    providerCall.reject(
      new Error('raw secret provider response https://example.test/photo'),
    );
    const result = await processing;

    assert.equal(result.status, 'pending');
    assert.equal(state.jobs[0].status, 'pending');
    assert.equal(
      state.jobs[0].lastFailureCode,
      CLOUDINARY_PROVIDER_UNAVAILABLE,
    );
    assert.equal(state.jobs[0].leaseToken, undefined);
    assert.equal(state.jobs[0].leaseExpiresAt, undefined);
    assert.equal(
      state.jobs[0].lastAttemptAt.toISOString(),
      '2026-07-30T12:00:00.000Z',
    );
    assert.equal(
      state.jobs[0].nextAttemptAt.toISOString(),
      '2026-07-30T12:05:00.000Z',
    );
    assert.notEqual(
      state.jobs[0].nextAttemptAt.toISOString(),
      '2026-07-30T12:01:00.000Z',
    );
    assert.doesNotMatch(JSON.stringify(state.jobs[0]), /secret|example/u);
  });

  test('a slow unexpected provider result schedules backoff from result time', async () => {
    const job = pendingJob();
    const { model, state } = makeModel([job]);
    const providerCall = deferred();
    const providerStarted = deferred();
    let now = new Date('2026-07-30T12:00:00.000Z');
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy() {
            providerStarted.resolve();
            return providerCall.promise;
          },
        },
      },
      clock: () => now,
      leaseTokenGenerator: () => 'lease-token',
      leaseMs: 60_000,
    });

    const processing = processor.processJobById(job._id);
    await providerStarted.promise;
    now = new Date('2026-07-30T12:04:00.000Z');
    providerCall.resolve({
      result: 'provider raw error',
      url: 'https://example.test/raw',
    });
    const result = await processing;

    assert.equal(result.status, 'pending');
    assert.equal(state.jobs[0].status, 'pending');
    assert.equal(
      state.jobs[0].lastFailureCode,
      CLOUDINARY_PROVIDER_RESULT_UNEXPECTED,
    );
    assert.equal(state.jobs[0].leaseToken, undefined);
    assert.equal(state.jobs[0].leaseExpiresAt, undefined);
    assert.equal(
      state.jobs[0].lastAttemptAt.toISOString(),
      '2026-07-30T12:00:00.000Z',
    );
    assert.equal(
      state.jobs[0].nextAttemptAt.toISOString(),
      '2026-07-30T12:05:00.000Z',
    );
    assert.doesNotMatch(JSON.stringify(state.jobs[0]), /raw|https:/u);
  });

  for (const retryCase of [
    {
      name: 'later attempts double from failure time',
      initialAttemptCount: 1,
      expectedAttemptCount: 2,
      expectedNextAttemptAt: '2026-07-30T12:06:00.000Z',
    },
    {
      name: 'later attempts retain the 24-hour cap from failure time',
      initialAttemptCount: 99,
      expectedAttemptCount: 100,
      expectedNextAttemptAt: '2026-07-31T12:04:00.000Z',
    },
  ]) {
    test(retryCase.name, async () => {
      const job = pendingJob({
        attemptCount: retryCase.initialAttemptCount,
      });
      const { model, state } = makeModel([job]);
      let now = new Date('2026-07-30T12:00:00.000Z');
      const processor = createMediaCleanupJobProcessor({
        CleanupJobModel: model,
        cloudinaryClient: {
          uploader: {
            async destroy() {
              now = new Date('2026-07-30T12:04:00.000Z');
              throw new Error('provider unavailable');
            },
          },
        },
        clock: () => now,
        leaseTokenGenerator: () => 'lease-token',
        leaseMs: 60_000,
      });

      const result = await processor.processJobById(job._id);

      assert.equal(result.status, 'pending');
      assert.equal(
        state.jobs[0].attemptCount,
        retryCase.expectedAttemptCount,
      );
      assert.equal(
        state.jobs[0].lastAttemptAt.toISOString(),
        '2026-07-30T12:00:00.000Z',
      );
      assert.equal(
        state.jobs[0].nextAttemptAt.toISOString(),
        retryCase.expectedNextAttemptAt,
      );
    });
  }

  test('an invalid failure-time clock leaves the processing lease intact', async () => {
    const job = pendingJob();
    const { calls, model, state } = makeModel([job]);
    let clockCalls = 0;
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy() {
            throw new Error('provider unavailable');
          },
        },
      },
      clock: () => {
        clockCalls += 1;
        return clockCalls === 1
          ? new Date('2026-07-30T12:00:00.000Z')
          : new Date('invalid');
      },
      leaseTokenGenerator: () => 'lease-token',
      leaseMs: 60_000,
    });

    await assert.rejects(
      processor.processJobById(job._id),
      /clock must return a valid Date/u,
    );

    assert.equal(clockCalls, 2);
    assert.equal(calls.updates.length, 0);
    assert.equal(state.jobs[0].status, 'processing');
    assert.equal(state.jobs[0].leaseToken, 'lease-token');
    assert.equal(
      state.jobs[0].leaseExpiresAt.toISOString(),
      '2026-07-30T12:01:00.000Z',
    );
    assert.equal(
      state.jobs[0].lastAttemptAt.toISOString(),
      '2026-07-30T12:00:00.000Z',
    );
    assert.equal(
      state.jobs[0].nextAttemptAt.toISOString(),
      '2026-07-30T11:59:00.000Z',
    );
  });

  for (const malformed of [
    null,
    'https://res.cloudinary.com/demo/image/upload/photo.jpg',
    'bad\u0000value',
    ' camp-parks/photo ',
  ]) {
    test(`malformed public ID is blocked without provider use: ${String(malformed)}`, async () => {
      const job = pendingJob({ cloudinaryPublicId: malformed });
      const { model, state } = makeModel([job]);
      let providerCalls = 0;
      const processor = createMediaCleanupJobProcessor({
        CleanupJobModel: model,
        cloudinaryClient: {
          uploader: {
            async destroy() {
              providerCalls += 1;
              return { result: 'ok' };
            },
          },
        },
        clock: () => new Date('2026-07-30T12:00:00.000Z'),
        leaseTokenGenerator: () => 'lease-token',
        leaseMs: 60_000,
      });

      const result = await processor.processJobById(job._id);

      assert.equal(result.status, 'blocked');
      assert.equal(providerCalls, 0);
      assert.equal(state.jobs[0].status, 'blocked');
      assert.equal(
        state.jobs[0].lastFailureCode,
        INVALID_CLOUDINARY_PUBLIC_ID,
      );
    });
  }

  test('finalization failure leaves an expired job retryable through not found', async () => {
    const job = pendingJob();
    const { model, state } = makeModel([job], {
      failDeleteOnce: true,
    });
    const providerResults = ['ok', 'not found'];
    let now = new Date('2026-07-30T12:00:00.000Z');
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy() {
            return { result: providerResults.shift() };
          },
        },
      },
      clock: () => now,
      leaseTokenGenerator: (() => {
        let token = 0;
        return () => `lease-${++token}`;
      })(),
      leaseMs: 1_000,
    });

    const first = await processor.processJobById(job._id);
    assert.equal(first.status, 'processing');
    assert.equal(state.jobs.length, 1);

    now = new Date('2026-07-30T12:00:02.000Z');
    const second = await processor.processJobById(job._id);
    assert.equal(second.completed, true);
    assert.equal(state.jobs.length, 0);
  });

  test('pending processing is bounded', async () => {
    const jobs = [pendingJob(), pendingJob(), pendingJob()];
    const { model } = makeModel(jobs);
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy() {
            return { result: 'ok' };
          },
        },
      },
      clock: () => new Date('2026-07-30T12:00:00.000Z'),
      leaseTokenGenerator: () => 'lease-token',
      leaseMs: 60_000,
    });

    const summary = await processor.processPendingJobs({ limit: 2 });

    assert.deepEqual({ ...summary }, {
      scanned: 2,
      claimed: 2,
      completed: 2,
      stillPending: 0,
      blocked: 0,
      skipped: 0,
      failed: 0,
    });
  });

  test('pending processing continues after one job throws unexpectedly', async () => {
    const jobs = [pendingJob(), pendingJob()];
    const { model } = makeModel(jobs, { failUpdateOnce: true });
    const processor = createMediaCleanupJobProcessor({
      CleanupJobModel: model,
      cloudinaryClient: {
        uploader: {
          async destroy() {
            throw new Error('provider unavailable');
          },
        },
      },
      clock: () => new Date('2026-07-30T12:00:00.000Z'),
      leaseTokenGenerator: (() => {
        let token = 0;
        return () => `lease-${++token}`;
      })(),
      leaseMs: 60_000,
    });

    const summary = await processor.processPendingJobs({ limit: 2 });

    assert.deepEqual({ ...summary }, {
      scanned: 2,
      claimed: 1,
      completed: 0,
      stillPending: 1,
      blocked: 0,
      skipped: 0,
      failed: 1,
    });
  });
});

test('exponential backoff is bounded', () => {
  assert.equal(mediaCleanupBackoffMs(1), 60_000);
  assert.equal(mediaCleanupBackoffMs(2), 120_000);
  assert.equal(
    mediaCleanupBackoffMs(100),
    MAX_MEDIA_CLEANUP_BACKOFF_MS,
  );
});
