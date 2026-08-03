import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMediaCleanupCli } from './processMediaCleanupJobs.js';

const SCHEDULED_MEDIA_CLEANUP_ARGS = Object.freeze([
  '--apply',
  '--limit',
  '50',
]);
const SCHEDULED_MEDIA_CLEANUP_FAILURE_MESSAGE =
  'Scheduled media cleanup failed and requires attention.';
const SCHEDULED_MEDIA_CLEANUP_FAILURE =
  new Error(SCHEDULED_MEDIA_CLEANUP_FAILURE_MESSAGE);

export async function runScheduledMediaCleanup({
  runCleanup = runMediaCleanupCli,
  dependencies,
} = {}) {
  let summary;
  try {
    summary = await runCleanup(
      SCHEDULED_MEDIA_CLEANUP_ARGS,
      dependencies,
    );
  } catch {
    throw SCHEDULED_MEDIA_CLEANUP_FAILURE;
  }

  if (summary?.failed > 0 || summary?.blocked > 0) {
    throw SCHEDULED_MEDIA_CLEANUP_FAILURE;
  }
  return summary;
}

export function handleScheduledMediaCleanupFailure({
  output = console,
  processObject = process,
} = {}) {
  output.error(SCHEDULED_MEDIA_CLEANUP_FAILURE_MESSAGE);
  processObject.exitCode = 1;
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runScheduledMediaCleanup().catch(() => {
    handleScheduledMediaCleanupFailure();
  });
}
