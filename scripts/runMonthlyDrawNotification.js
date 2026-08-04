import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRuntimeConfig } from '../config/runtimeConfig.js';
import {
  deriveEasternMonthKey,
  getPreviousMonthlyDrawMonthKey,
  isValidMonthKey,
} from '../utils/monthlyDraw.js';

export const MONTHLY_DRAW_NOTIFICATION_EXIT_CODES = Object.freeze({
  operationalFailure: 1,
  invalidArguments: 2,
  invalidApplyMonth: 4,
  missingResult: 5,
});
export const MONTHLY_DRAW_NOTIFICATION_OPERATIONAL_FAILURE_MESSAGE =
  'Monthly draw notification failed.';
export const MONTHLY_DRAW_NOTIFICATION_INVALID_ARGUMENTS_MESSAGE =
  'Invalid monthly draw notification arguments.';
export const MONTHLY_DRAW_NOTIFICATION_INVALID_APPLY_MONTH_MESSAGE =
  'Apply month must be earlier than the current Eastern calendar month.';

export class MonthlyDrawNotificationArgumentError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'MonthlyDrawNotificationArgumentError';
    this.exitCode = exitCode;
  }
}

function invalidArguments() {
  throw new MonthlyDrawNotificationArgumentError(
    MONTHLY_DRAW_NOTIFICATION_INVALID_ARGUMENTS_MESSAGE,
    MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.invalidArguments,
  );
}

export function parseMonthlyDrawNotificationArguments(
  args,
  currentTime = new Date(),
) {
  if (!Array.isArray(args)) invalidArguments();
  let mode = 'dry-run';
  let modeArgument = null;
  let monthKey = null;
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
    throw new MonthlyDrawNotificationArgumentError(
      MONTHLY_DRAW_NOTIFICATION_INVALID_APPLY_MONTH_MESSAGE,
      MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.invalidApplyMonth,
    );
  }
  return Object.freeze({ mode, monthKey });
}

export async function loadMonthlyDrawCommandRuntimeConfig() {
  await import('dotenv/config');
  return parseRuntimeConfig(process.env);
}

export async function createMonthlyDrawCommandEmailSender(runtimeConfig) {
  const { createEmailSender } = await import('../utils/sendEmail.js');
  return createEmailSender({
    domain: runtimeConfig.mailgun.domain,
    defaultFrom: runtimeConfig.mailgun.from,
  });
}

export async function createMonthlyDrawCommandNotificationService(options) {
  const { createMonthlyDrawNotificationService } =
    await import('../utils/monthlyDrawNotification.js');
  return createMonthlyDrawNotificationService(options);
}

function safeSentAt(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function outputInspection(output, inspection) {
  const report = Object.freeze({
    mode: 'dry-run',
    targetMonth: inspection.monthKey,
    resultExists: inspection.resultExists,
    resultStatus: inspection.resultStatus,
    candidateCount: inspection.candidateCount,
    notificationState: inspection.notificationState,
    attemptCount: inspection.attemptCount,
    sentAt: safeSentAt(inspection.sentAt),
    leaseActive: inspection.leaseActive,
  });
  output.log(JSON.stringify(report, null, 2));
  return report;
}

function outputApply(output, outcome) {
  const report = Object.freeze({
    mode: 'apply',
    targetMonth: outcome.monthKey,
    state: outcome.state,
    resultStatus: outcome.resultStatus,
    candidateCount: outcome.candidateCount,
    notificationState: outcome.notificationState,
    attemptCount: outcome.attemptCount,
    sentAt: safeSentAt(outcome.sentAt),
  });
  output.log(JSON.stringify(report, null, 2));
  return report;
}

export async function runMonthlyDrawNotificationCli(
  args = process.argv.slice(2),
  {
    service,
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
  const options = parseMonthlyDrawNotificationArguments(args, currentTime());
  const activeRuntimeConfig = runtimeConfig || await loadRuntimeConfig();
  const databaseUrl = activeRuntimeConfig?.database?.url;
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('DB_URL is required');
  }

  await connect(databaseUrl, { autoIndex: false });
  try {
    let activeService = service;
    if (!activeService) {
      let send;
      if (options.mode === 'apply') {
        send = await initializeEmailSender(activeRuntimeConfig);
      }
      activeService = await createNotificationService({
        send,
        publicSiteDomain: activeRuntimeConfig.publicSite.domain,
        administratorEmail: activeRuntimeConfig.mailgun.adminEmail,
      });
    }

    if (options.mode === 'dry-run') {
      const inspection = await activeService.inspectNotification({
        monthKey: options.monthKey,
      });
      const report = outputInspection(output, inspection);
      if (!inspection.resultExists) {
        setExitCode(MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.missingResult);
      }
      return report;
    }

    const outcome = await activeService.notifyStoredResult({
      monthKey: options.monthKey,
    });
    const report = outputApply(output, outcome);
    if (outcome.state === 'missing-result') {
      setExitCode(MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.missingResult);
    }
    return report;
  } finally {
    await disconnect();
  }
}

export function handleMonthlyDrawNotificationDirectFailure(
  error,
  {
    output = console,
    setExitCode = value => {
      process.exitCode = value;
    },
  } = {},
) {
  if (error instanceof MonthlyDrawNotificationArgumentError) {
    output.error(error.message);
    setExitCode(error.exitCode);
    return;
  }
  output.error(MONTHLY_DRAW_NOTIFICATION_OPERATIONAL_FAILURE_MESSAGE);
  setExitCode(MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.operationalFailure);
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runMonthlyDrawNotificationCli().catch(error => {
    handleMonthlyDrawNotificationDirectFailure(error);
  });
}
