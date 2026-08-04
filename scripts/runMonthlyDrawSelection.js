import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMonthlyDrawSelectionService,
} from '../utils/monthlyDrawSelection.js';
import {
  deriveEasternMonthKey,
  getPreviousMonthlyDrawMonthKey,
  isValidMonthKey,
} from '../utils/monthlyDraw.js';

export const MONTHLY_DRAW_SELECTION_EXIT_CODES = Object.freeze({
  operationalFailure: 1,
  invalidArguments: 2,
  pendingReviews: 3,
  invalidApplyMonth: 4,
});
export const MONTHLY_DRAW_SELECTION_OPERATIONAL_FAILURE_MESSAGE =
  'Monthly draw selection failed.';
export const MONTHLY_DRAW_SELECTION_INVALID_ARGUMENTS_MESSAGE =
  'Invalid monthly draw selection arguments.';
export const MONTHLY_DRAW_SELECTION_INVALID_APPLY_MONTH_MESSAGE =
  'Apply month must be earlier than the current Eastern calendar month.';

export class MonthlyDrawSelectionArgumentError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'MonthlyDrawSelectionArgumentError';
    this.exitCode = exitCode;
  }
}

function invalidArguments() {
  throw new MonthlyDrawSelectionArgumentError(
    MONTHLY_DRAW_SELECTION_INVALID_ARGUMENTS_MESSAGE,
    MONTHLY_DRAW_SELECTION_EXIT_CODES.invalidArguments,
  );
}

export function parseMonthlyDrawSelectionArguments(
  args,
  currentTime = new Date(),
) {
  if (!Array.isArray(args)) invalidArguments();
  let mode = 'dry-run';
  let monthKey = null;
  let modeArgument = null;
  let monthSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (modeArgument !== null) invalidArguments();
      modeArgument = argument;
      mode = argument === '--apply' ? 'apply' : 'dry-run';
      continue;
    }
    if (argument === '--month') {
      if (monthSeen || index + 1 >= args.length) invalidArguments();
      monthSeen = true;
      monthKey = args[index + 1];
      index += 1;
      if (!isValidMonthKey(monthKey)) invalidArguments();
      continue;
    }
    invalidArguments();
  }

  if (!(currentTime instanceof Date) || Number.isNaN(currentTime.valueOf())) {
    invalidArguments();
  }
  monthKey ||= getPreviousMonthlyDrawMonthKey(currentTime);
  if (mode === 'apply' && monthKey >= deriveEasternMonthKey(currentTime)) {
    throw new MonthlyDrawSelectionArgumentError(
      MONTHLY_DRAW_SELECTION_INVALID_APPLY_MONTH_MESSAGE,
      MONTHLY_DRAW_SELECTION_EXIT_CODES.invalidApplyMonth,
    );
  }

  return Object.freeze({ mode, monthKey });
}

function safePoolSummary(summary) {
  return Object.freeze({
    eligibleUploadEntries: summary.eligibleUploadEntries,
    eligibleNoUploadEntries: summary.eligibleNoUploadEntries,
    totalEligibleEntries: summary.totalEligibleEntries,
    eligibleDistinctEntrants: summary.eligibleDistinctEntrants,
    excludedAccountEntries: summary.excludedAccountEntries,
    candidatesSelected: summary.candidatesSelected,
    pendingUploadsAtSelection: summary.pendingUploadsAtSelection,
  });
}

function outputDryRun(output, inspection) {
  const report = Object.freeze({
    mode: 'dry-run',
    targetMonth: inspection.monthKey,
    pendingReviewCount: inspection.pendingUploads,
    eligibleUploadCount: inspection.eligibleUploadEntries,
    eligibleNoUploadCount: inspection.eligibleNoUploadEntries,
    eligibleDistinctEntrantCount: inspection.eligibleDistinctEntrants,
    excludedAccountEntryCount: inspection.excludedAccountEntries,
    selectionReady: inspection.selectionReady,
    resultAlreadyExists: inspection.resultAlreadyExists,
  });
  output.log(JSON.stringify(report, null, 2));
  return report;
}

function outputApply(output, outcome) {
  if (outcome.state === 'blocked-pending-review') {
    const report = Object.freeze({
      mode: 'apply',
      targetMonth: outcome.monthKey,
      pendingReviewCount: outcome.pendingUploads,
      selectionReady: false,
      message: outcome.message,
    });
    output.log(JSON.stringify(report, null, 2));
    return report;
  }

  const result = outcome.result;
  const report = Object.freeze({
    mode: 'apply',
    targetMonth: outcome.monthKey,
    resultId: String(result._id),
    resultStatus: result.status,
    persistence: outcome.created ? 'newly-created' : 'already-existed',
    candidateCount: Array.isArray(result.candidates)
      ? result.candidates.length
      : 0,
    poolSummary: safePoolSummary(result.poolSummary),
  });
  output.log(JSON.stringify(report, null, 2));
  return report;
}

export async function runMonthlyDrawSelectionCli(
  args = process.argv.slice(2),
  {
    service,
    connect = (url, options) => mongoose.connect(url, options),
    disconnect = () => mongoose.disconnect(),
    databaseUrl = process.env.DB_URL,
    currentTime = () => new Date(),
    output = console,
    setExitCode = value => {
      process.exitCode = value;
    },
  } = {},
) {
  const options = parseMonthlyDrawSelectionArguments(args, currentTime());
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('DB_URL is required');
  }

  await connect(databaseUrl, { autoIndex: false });
  try {
    const activeService = service || createMonthlyDrawSelectionService();
    if (options.mode === 'dry-run') {
      const inspection = await activeService.inspectPool({
        monthKey: options.monthKey,
      });
      const report = outputDryRun(output, inspection);
      if (
        inspection.pendingUploads > 0 &&
        inspection.resultAlreadyExists === false
      ) {
        setExitCode(MONTHLY_DRAW_SELECTION_EXIT_CODES.pendingReviews);
      }
      return report;
    }

    const outcome = await activeService.selectAndPersist({
      monthKey: options.monthKey,
    });
    const report = outputApply(output, outcome);
    if (outcome.state === 'blocked-pending-review') {
      setExitCode(MONTHLY_DRAW_SELECTION_EXIT_CODES.pendingReviews);
    }
    return report;
  } finally {
    await disconnect();
  }
}

export function handleMonthlyDrawSelectionDirectFailure(
  error,
  {
    output = console,
    setExitCode = value => {
      process.exitCode = value;
    },
  } = {},
) {
  if (error instanceof MonthlyDrawSelectionArgumentError) {
    output.error(error.message);
    setExitCode(error.exitCode);
    return;
  }
  output.error(MONTHLY_DRAW_SELECTION_OPERATIONAL_FAILURE_MESSAGE);
  setExitCode(MONTHLY_DRAW_SELECTION_EXIT_CODES.operationalFailure);
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  await import('dotenv/config');
  runMonthlyDrawSelectionCli().catch(error => {
    handleMonthlyDrawSelectionDirectFailure(error);
  });
}
