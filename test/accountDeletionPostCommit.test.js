import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCOUNT_DELETE_IMMEDIATE_CLEANUP_CONCURRENCY,
  ACCOUNT_DELETE_IMMEDIATE_CLEANUP_LIMIT,
  processCommittedAccountCleanupJobs,
} from '../utils/accountDeletionPostCommit.js';

describe('bounded immediate account cleanup', () => {
  test('completed ok/not-found outcomes and pending outcomes are summarized', async () => {
    const results = [
      { completed: true, providerResult: 'ok' },
      { completed: true, providerResult: 'not found' },
      { completed: false, status: 'pending' },
    ];
    let index = 0;

    const summary = await processCommittedAccountCleanupJobs({
      cleanupJobIds: ['ok', 'not-found', 'pending'],
      async processJobById() {
        const result = results[index];
        index += 1;
        return result;
      },
    });

    assert.deepEqual(summary, {
      attempted: 3,
      completed: 2,
      pending: 1,
      failed: 0,
      unattempted: 0,
    });
  });

  test('processor exceptions are counted without rejecting committed deletion', async () => {
    const summary = await processCommittedAccountCleanupJobs({
      cleanupJobIds: ['job'],
      async processJobById() {
        throw new Error('provider unavailable');
      },
    });

    assert.deepEqual(summary, {
      attempted: 1,
      completed: 0,
      pending: 0,
      failed: 1,
      unattempted: 0,
    });
  });

  test('default limit leaves excess durable jobs unattempted', async () => {
    const jobIds = Array.from(
      { length: ACCOUNT_DELETE_IMMEDIATE_CLEANUP_LIMIT + 5 },
      (_, index) => `job-${index}`,
    );
    let active = 0;
    let maximumActive = 0;
    const attempted = [];

    const summary = await processCommittedAccountCleanupJobs({
      cleanupJobIds: jobIds,
      async processJobById(jobId) {
        attempted.push(jobId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return { completed: true };
      },
    });

    assert.equal(attempted.length, ACCOUNT_DELETE_IMMEDIATE_CLEANUP_LIMIT);
    assert.equal(summary.unattempted, 5);
    assert.equal(summary.completed, ACCOUNT_DELETE_IMMEDIATE_CLEANUP_LIMIT);
    assert.ok(maximumActive <= ACCOUNT_DELETE_IMMEDIATE_CLEANUP_CONCURRENCY);
    assert.ok(maximumActive > 1);
  });
});
