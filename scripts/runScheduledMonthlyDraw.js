import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getPreviousMonthlyDrawMonthKey,
  isFirstEasternCalendarDay,
} from '../utils/monthlyDraw.js';
import {
  createMonthlyDrawCommandEmailSender,
  createMonthlyDrawCommandNotificationService,
  loadMonthlyDrawCommandRuntimeConfig,
} from './runMonthlyDrawNotification.js';

export const SCHEDULED_MONTHLY_DRAW_EXIT_CODES = Object.freeze({
  operationalFailure: 1,
  invalidArguments: 2,
  pendingReviews: 3,
});
export const SCHEDULED_MONTHLY_DRAW_OPERATIONAL_FAILURE_MESSAGE =
  'Scheduled monthly draw failed.';
export const SCHEDULED_MONTHLY_DRAW_INVALID_ARGUMENTS_MESSAGE =
  'Scheduled monthly draw accepts no arguments.';

async function createDefaultSelectionService() {
  const { createMonthlyDrawSelectionService } =
    await import('../utils/monthlyDrawSelection.js');
  return createMonthlyDrawSelectionService();
}

function safeSentAt(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function writeReport(output, report) {
  const frozen = Object.freeze(report);
  output.log(JSON.stringify(frozen, null, 2));
  return frozen;
}

export async function runScheduledMonthlyDraw(
  args = process.argv.slice(2),
  {
    selectionService,
    notificationService,
    createSelectionService = createDefaultSelectionService,
    createNotificationService = createMonthlyDrawCommandNotificationService,
    initializeEmailSender = createMonthlyDrawCommandEmailSender,
    loadRuntimeConfig = loadMonthlyDrawCommandRuntimeConfig,
    runtimeConfig,
    connect = (url, options) => mongoose.connect(url, options),
    disconnect = () => mongoose.disconnect(),
    currentTime = () => new Date(),
    output = console,
    setExitCode = value => {
      process.exitCode = value;
    },
  } = {},
) {
  if (!Array.isArray(args) || args.length > 0) {
    output.error(SCHEDULED_MONTHLY_DRAW_INVALID_ARGUMENTS_MESSAGE);
    setExitCode(SCHEDULED_MONTHLY_DRAW_EXIT_CODES.invalidArguments);
    return Object.freeze({ state: 'invalid-arguments' });
  }

  const runTime = currentTime();
  if (!isFirstEasternCalendarDay(runTime)) {
    return writeReport(output, { state: 'not-first-eastern-day' });
  }

  const monthKey = getPreviousMonthlyDrawMonthKey(runTime);
  const activeRuntimeConfig = runtimeConfig || await loadRuntimeConfig();
  const databaseUrl = activeRuntimeConfig?.database?.url;
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('DB_URL is required');
  }

  await connect(databaseUrl, { autoIndex: false });
  try {
    const activeSelectionService = selectionService ||
      await createSelectionService();
    const selection = await activeSelectionService.selectAndPersist({
      monthKey,
    });
    if (selection.state !== 'result' || !selection.result) {
      throw new Error('Monthly draw selection returned no result.');
    }

    let activeNotificationService = notificationService;
    if (!activeNotificationService) {
      const send = await initializeEmailSender(activeRuntimeConfig);
      activeNotificationService = await createNotificationService({
        send,
        publicSiteDomain: activeRuntimeConfig.publicSite.domain,
        administratorEmail: activeRuntimeConfig.mailgun.adminEmail,
      });
    }
    const notification = await activeNotificationService.notifyStoredResult({
      monthKey,
    });
    if (notification.state === 'missing-result') {
      throw new Error('Monthly draw notification result is missing.');
    }
    return writeReport(output, {
      targetMonth: monthKey,
      selectionState: selection.created
        ? 'newly-created'
        : 'already-existed',
      resultStatus: selection.result.status,
      candidateCount: Array.isArray(selection.result.candidates)
        ? selection.result.candidates.length
        : 0,
      notificationState: notification.state,
      notificationAttemptCount: notification.attemptCount,
      notificationSentAt: safeSentAt(notification.sentAt),
    });
  } finally {
    await disconnect();
  }
}

export function handleScheduledMonthlyDrawFailure(
  {
    output = console,
    setExitCode = value => {
      process.exitCode = value;
    },
  } = {},
) {
  output.error(SCHEDULED_MONTHLY_DRAW_OPERATIONAL_FAILURE_MESSAGE);
  setExitCode(SCHEDULED_MONTHLY_DRAW_EXIT_CODES.operationalFailure);
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runScheduledMonthlyDraw().catch(() => {
    handleScheduledMonthlyDrawFailure();
  });
}
