export const ACCOUNT_DELETE_IMMEDIATE_CLEANUP_LIMIT = 30;
export const ACCOUNT_DELETE_IMMEDIATE_CLEANUP_CONCURRENCY = 3;

export async function processCommittedAccountCleanupJobs({
  cleanupJobIds,
  processJobById,
  limit = ACCOUNT_DELETE_IMMEDIATE_CLEANUP_LIMIT,
  concurrency = ACCOUNT_DELETE_IMMEDIATE_CLEANUP_CONCURRENCY,
}) {
  if (!Array.isArray(cleanupJobIds)) {
    throw new TypeError('Cleanup job IDs must be an array.');
  }
  if (typeof processJobById !== 'function') {
    throw new TypeError('A cleanup job processor is required.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Immediate cleanup limit must be from 1 to 100.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new RangeError('Immediate cleanup concurrency must be from 1 to 10.');
  }

  const selected = cleanupJobIds.slice(0, limit);
  const summary = {
    attempted: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    unattempted: cleanupJobIds.length - selected.length,
  };
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < selected.length) {
      const index = nextIndex;
      nextIndex += 1;
      summary.attempted += 1;
      try {
        const result = await processJobById(selected[index]);
        if (result?.completed === true) {
          summary.completed += 1;
        } else {
          summary.pending += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(concurrency, selected.length);
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return Object.freeze(summary);
}
