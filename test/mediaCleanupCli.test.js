import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  parseMediaCleanupArguments,
  runMediaCleanupCli,
} from '../scripts/processMediaCleanupJobs.js';

function objectId() {
  return new mongoose.Types.ObjectId();
}

function matches(job, filter) {
  if (filter._id && job._id.toString() !== filter._id.toString()) {
    return false;
  }
  if (filter.$or) {
    return filter.$or.some(condition => matches(job, condition));
  }
  if (filter.status?.$in) return filter.status.$in.includes(job.status);
  if (typeof filter.status === 'string' && job.status !== filter.status) {
    return false;
  }
  if (filter.leaseExpiresAt?.$lte) {
    return job.leaseExpiresAt <= filter.leaseExpiresAt.$lte;
  }
  return true;
}

function makeCliHarness() {
  const jobs = [
    {
      _id: objectId(),
      mediaId: objectId(),
      status: 'pending',
      cloudinaryPublicId: 'secret/public-id',
      url: 'https://example.test/secret',
    },
    {
      _id: objectId(),
      mediaId: objectId(),
      status: 'processing',
      leaseExpiresAt: new Date('2026-07-30T11:00:00.000Z'),
      cloudinaryPublicId: 'secret/expired',
    },
    {
      _id: objectId(),
      mediaId: objectId(),
      status: 'blocked',
      cloudinaryPublicId: 'secret/blocked',
    },
  ];
  const calls = {
    cloudinary: 0,
    connect: 0,
    disconnect: 0,
    mutation: 0,
    processLimit: null,
    processJobId: null,
  };
  const outputLines = [];
  const CleanupJobModel = {
    async countDocuments(filter) {
      return jobs.filter(job => matches(job, filter)).length;
    },
    async find(filter, projection, options) {
      return jobs
        .filter(job => matches(job, filter))
        .slice(0, options.limit)
        .map(job => ({
          _id: job._id,
          mediaId: job.mediaId,
        }));
    },
  };
  const processor = {
    async processPendingJobs({ limit }) {
      calls.mutation += 1;
      calls.processLimit = limit;
      return {
        scanned: limit,
        claimed: limit,
        completed: limit - 1,
        stillPending: 1,
        blocked: 0,
        skipped: 0,
        failed: 0,
      };
    },
    async processJobById(jobId) {
      calls.mutation += 1;
      calls.processJobId = jobId;
      return {
        claimed: true,
        completed: false,
        status: 'blocked',
      };
    },
  };
  const dependencies = {
    CleanupJobModel,
    processor,
    databaseUrl: 'mongodb://test.invalid/camp-pics',
    clock: () => new Date('2026-07-30T12:00:00.000Z'),
    connect: async () => {
      calls.connect += 1;
    },
    disconnect: async () => {
      calls.disconnect += 1;
    },
    output: {
      log(value) {
        outputLines.push(value);
      },
    },
  };
  return { calls, dependencies, jobs, outputLines };
}

describe('media cleanup CLI arguments', () => {
  test('default mode is dry-run and apply must be explicit', () => {
    assert.deepEqual(
      { ...parseMediaCleanupArguments([]) },
      {
        apply: false,
        limit: 50,
        jobId: null,
      },
    );
    assert.equal(
      parseMediaCleanupArguments(['--apply']).apply,
      true,
    );
  });

  for (const value of ['0', '-1', '1.5', '501', 'not-a-number']) {
    test(`rejects invalid limit ${value}`, () => {
      assert.throws(
        () => parseMediaCleanupArguments(['--limit', value]),
        /--limit/u,
      );
    });
  }

  test('validates an optional exact job ID', () => {
    const jobId = objectId().toString();
    assert.equal(
      parseMediaCleanupArguments(['--job-id', jobId]).jobId,
      jobId,
    );
    assert.throws(
      () => parseMediaCleanupArguments(['--job-id', 'not-an-id']),
      /--job-id/u,
    );
  });
});

describe('media cleanup CLI execution', () => {
  test('dry run reports bounded redacted state with zero mutation or Cloudinary use', async () => {
    const harness = makeCliHarness();
    const summary = await runMediaCleanupCli(
      ['--limit', '2'],
      harness.dependencies,
    );

    assert.equal(summary.pending, 1);
    assert.equal(summary.reclaimableExpiredLeases, 1);
    assert.equal(summary.blocked, 1);
    assert.equal(summary.samples.length, 2);
    assert.equal(harness.calls.mutation, 0);
    assert.equal(harness.calls.cloudinary, 0);
    assert.equal(harness.calls.connect, 1);
    assert.equal(harness.calls.disconnect, 1);
    const output = harness.outputLines.join('\n');
    assert.doesNotMatch(output, /secret|https:/u);
    assert.match(output, /jobId/u);
    assert.match(output, /mediaId/u);
  });

  test('apply mode processes only the requested bounded limit', async () => {
    const harness = makeCliHarness();
    const summary = await runMediaCleanupCli(
      ['--apply', '--limit', '2'],
      harness.dependencies,
    );

    assert.equal(harness.calls.processLimit, 2);
    assert.equal(harness.calls.mutation, 1);
    assert.equal(summary.scanned, 2);
    assert.equal(summary.completed, 1);
    assert.equal(summary.stillPending, 1);
  });

  test('apply mode can select one validated job and reports blocked state', async () => {
    const harness = makeCliHarness();
    const jobId = harness.jobs[2]._id.toString();
    const summary = await runMediaCleanupCli(
      ['--apply', '--job-id', jobId],
      harness.dependencies,
    );

    assert.equal(harness.calls.processJobId, jobId);
    assert.deepEqual({ ...summary }, {
      scanned: 1,
      claimed: 1,
      completed: 0,
      stillPending: 0,
      blocked: 1,
      skipped: 0,
      failed: 0,
    });
  });

  test('one selected job failure is reported without rejecting the CLI run', async () => {
    const harness = makeCliHarness();
    harness.dependencies.processor.processJobById = async () => {
      throw new Error('raw individual failure');
    };
    const summary = await runMediaCleanupCli(
      ['--apply', '--job-id', harness.jobs[0]._id.toString()],
      harness.dependencies,
    );

    assert.deepEqual({ ...summary }, {
      scanned: 1,
      claimed: 0,
      completed: 0,
      stillPending: 0,
      blocked: 0,
      skipped: 0,
      failed: 1,
    });
  });

  test('fatal setup failure disconnects only after a successful connection', async () => {
    const harness = makeCliHarness();
    harness.dependencies.connect = async () => {
      throw new Error('raw database detail');
    };

    await assert.rejects(
      () => runMediaCleanupCli([], harness.dependencies),
      /raw database detail/u,
    );
    assert.equal(harness.calls.disconnect, 0);
  });
});
