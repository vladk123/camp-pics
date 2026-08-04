import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  isFirstEasternCalendarDay,
} from '../utils/monthlyDraw.js';
import {
  SCHEDULED_MONTHLY_DRAW_EXIT_CODES,
  handleScheduledMonthlyDrawFailure,
  runScheduledMonthlyDraw,
} from '../scripts/runScheduledMonthlyDraw.js';

const root = process.cwd();
const FIRST_DAY = new Date('2026-08-01T04:01:00.000Z');
const MONTH = '2026-07';

const source = relativePath => readFile(path.join(root, relativePath), 'utf8');

function runtimeConfig() {
  return {
    database: { url: 'mongodb://fixture-never-connected' },
    publicSite: { domain: 'https://camppics.example.test' },
    mailgun: {
      adminEmail: 'admin@example.test',
      domain: 'mail.example.test',
      from: 'no-reply@example.test',
    },
  };
}

function result(status = 'selected') {
  return {
    _id: `monthly-draw-result:${MONTH}`,
    monthKey: MONTH,
    status,
    candidates: status === 'selected' ? [{ rank: 1 }] : [],
  };
}

function createHarness({
  selectionOutcome = {
    state: 'result', created: true, monthKey: MONTH,
    result: result(),
  },
  notificationOutcome = {
    state: 'sent', monthKey: MONTH, resultStatus: 'selected',
    candidateCount: 1, notificationState: 'sent', attemptCount: 1,
    sentAt: FIRST_DAY,
  },
  notificationError = null,
} = {}) {
  const calls = {
    connect: 0,
    disconnect: 0,
    select: [],
    notify: [],
    initializeEmail: 0,
    loadRuntime: 0,
    createSelection: 0,
    createNotification: 0,
  };
  const lines = [];
  const errors = [];
  const exits = [];
  const dependencies = {
    runtimeConfig: runtimeConfig(),
    currentTime: () => FIRST_DAY,
    async connect(url, options) {
      calls.connect += 1;
      assert.equal(url, 'mongodb://fixture-never-connected');
      assert.deepEqual(options, { autoIndex: false });
    },
    async disconnect() { calls.disconnect += 1; },
    selectionService: {
      async selectAndPersist(options) {
        calls.select.push(options);
        return selectionOutcome;
      },
    },
    notificationService: {
      async notifyStoredResult(options) {
        calls.notify.push(options);
        if (notificationError) throw notificationError;
        return notificationOutcome;
      },
    },
    async initializeEmailSender() {
      calls.initializeEmail += 1;
      return async () => ({});
    },
    async loadRuntimeConfig() {
      calls.loadRuntime += 1;
      return runtimeConfig();
    },
    async createSelectionService() {
      calls.createSelection += 1;
      return this.selectionService;
    },
    async createNotificationService() {
      calls.createNotification += 1;
      return this.notificationService;
    },
    output: {
      log(value) { lines.push(value); },
      error(value) { errors.push(value); },
    },
    setExitCode(value) { exits.push(value); },
  };
  return { calls, dependencies, errors, exits, lines };
}

describe('first Eastern calendar day gate', () => {
  test('handles Eastern standard and daylight boundaries exactly', () => {
    const cases = [
      ['2026-03-01T04:59:59.999Z', false],
      ['2026-03-01T05:00:00.000Z', true],
      ['2026-07-01T03:59:59.999Z', false],
      ['2026-07-01T04:00:00.000Z', true],
      ['2026-11-01T03:59:59.999Z', false],
      ['2026-11-01T04:00:00.000Z', true],
      ['2026-08-02T03:59:59.999Z', true],
      ['2026-08-02T04:00:00.000Z', false],
    ];
    for (const [timestamp, expected] of cases) {
      assert.equal(isFirstEasternCalendarDay(new Date(timestamp)), expected,
        timestamp);
    }
    assert.throws(() => isFirstEasternCalendarDay(new Date('invalid')),
      TypeError);
    assert.throws(() => isFirstEasternCalendarDay('2026-08-01'), TypeError);
  });

  test('non-first day exits successfully before configuration, database or email setup', async () => {
    const harness = createHarness();
    delete harness.dependencies.runtimeConfig;
    harness.dependencies.currentTime = () =>
      new Date('2026-08-02T04:00:00.000Z');
    const report = await runScheduledMonthlyDraw([], harness.dependencies);
    assert.deepEqual(report, { state: 'not-first-eastern-day' });
    assert.deepEqual(harness.calls, {
      connect: 0, disconnect: 0, select: [], notify: [],
      initializeEmail: 0, loadRuntime: 0,
      createSelection: 0, createNotification: 0,
    });
    assert.deepEqual(harness.exits, []);
    assert.equal(harness.lines.length, 1);
  });

  test('rejects every supplied argument before time, database or provider work', async () => {
    for (const args of [
      ['--apply'], ['--month', MONTH], ['--dry-run'], ['raw-id'],
    ]) {
      const harness = createHarness();
      let clockCalls = 0;
      harness.dependencies.currentTime = () => {
        clockCalls += 1;
        return FIRST_DAY;
      };
      const report = await runScheduledMonthlyDraw(args, harness.dependencies);
      assert.deepEqual(report, { state: 'invalid-arguments' });
      assert.equal(clockCalls, 0);
      assert.equal(harness.calls.connect, 0);
      assert.equal(harness.calls.initializeEmail, 0);
      assert.deepEqual(harness.exits,
        [SCHEDULED_MONTHLY_DRAW_EXIT_CODES.invalidArguments]);
      assert.deepEqual(harness.errors,
        ['Scheduled monthly draw accepts no arguments.']);
    }
  });
});

describe('Scheduler-ready combined selection and notification workflow', () => {
  test('selects the previous Eastern month, notifies and disconnects once', async () => {
    const harness = createHarness();
    const report = await runScheduledMonthlyDraw([], harness.dependencies);
    assert.deepEqual(harness.calls.select, [{ monthKey: MONTH }]);
    assert.deepEqual(harness.calls.notify, [{ monthKey: MONTH }]);
    assert.equal(harness.calls.connect, 1);
    assert.equal(harness.calls.disconnect, 1);
    assert.equal(report.selectionState, 'newly-created');
    assert.equal(report.resultStatus, 'selected');
    assert.equal(report.candidateCount, 1);
    assert.equal(report.notificationState, 'sent');
    assert.doesNotMatch(harness.lines.join('\n'),
      /sourceId|fingerprint|nickname|email|location|mongodb:\/\//iu);
  });

  test('an existing stored result is reused and still passed to notification', async () => {
    const harness = createHarness({
      selectionOutcome: {
        state: 'result', created: false, monthKey: MONTH,
        result: result(),
      },
      notificationOutcome: {
        state: 'already-sent', monthKey: MONTH, resultStatus: 'selected',
        candidateCount: 1, notificationState: 'sent', attemptCount: 1,
        sentAt: FIRST_DAY,
      },
    });
    const report = await runScheduledMonthlyDraw([], harness.dependencies);
    assert.equal(report.selectionState, 'already-existed');
    assert.equal(report.notificationState, 'already-sent');
    assert.deepEqual(harness.calls.notify, [{ monthKey: MONTH }]);
    assert.deepEqual(harness.exits, []);
  });

  test('no-eligible-entries result is notified with zero candidate count', async () => {
    const harness = createHarness({
      selectionOutcome: {
        state: 'result', created: true, monthKey: MONTH,
        result: result('no-eligible-entries'),
      },
      notificationOutcome: {
        state: 'sent', monthKey: MONTH,
        resultStatus: 'no-eligible-entries', candidateCount: 0,
        notificationState: 'sent', attemptCount: 1, sentAt: FIRST_DAY,
      },
    });
    const report = await runScheduledMonthlyDraw([], harness.dependencies);
    assert.equal(report.resultStatus, 'no-eligible-entries');
    assert.equal(report.candidateCount, 0);
    assert.equal(report.notificationState, 'sent');
    assert.equal(harness.calls.notify.length, 1);
  });

  test('pending review exits nonzero without provider initialization or notification', async () => {
    const harness = createHarness({
      selectionOutcome: {
        state: 'blocked-pending-review', monthKey: MONTH,
        pendingUploads: 3,
      },
    });
    delete harness.dependencies.notificationService;
    const report = await runScheduledMonthlyDraw([], harness.dependencies);
    assert.equal(report.selectionState, 'blocked-pending-review');
    assert.equal(report.pendingReviewCount, 3);
    assert.equal(report.notificationState, 'not-attempted');
    assert.equal(harness.calls.notify.length, 0);
    assert.equal(harness.calls.initializeEmail, 0);
    assert.equal(harness.calls.createNotification, 0);
    assert.equal(harness.calls.disconnect, 1);
    assert.deepEqual(harness.exits,
      [SCHEDULED_MONTHLY_DRAW_EXIT_CODES.pendingReviews]);
  });

  test('active notification lease is a successful no-op', async () => {
    const harness = createHarness({
      notificationOutcome: {
        state: 'lease-active', monthKey: MONTH, resultStatus: 'selected',
        candidateCount: 1, notificationState: 'sending', attemptCount: 1,
        sentAt: null,
      },
    });
    const report = await runScheduledMonthlyDraw([], harness.dependencies);
    assert.equal(report.notificationState, 'lease-active');
    assert.deepEqual(harness.exits, []);
    assert.equal(harness.calls.disconnect, 1);
  });

  test('definite provider failure rejects for retry and still disconnects once', async () => {
    const providerError = new Error('raw provider response');
    const harness = createHarness({ notificationError: providerError });
    await assert.rejects(
      () => runScheduledMonthlyDraw([], harness.dependencies),
      error => error === providerError,
    );
    assert.equal(harness.calls.notify.length, 1);
    assert.equal(harness.calls.disconnect, 1);
    assert.deepEqual(harness.exits, []);
  });

  test('default factories initialize email only after selection succeeds', async () => {
    const harness = createHarness();
    delete harness.dependencies.selectionService;
    delete harness.dependencies.notificationService;
    const selectionService = {
      async selectAndPersist(options) {
        harness.calls.select.push(options);
        return {
          state: 'result', created: false, monthKey: MONTH,
          result: result(),
        };
      },
    };
    const notificationService = {
      async notifyStoredResult(options) {
        harness.calls.notify.push(options);
        return {
          state: 'sent', monthKey: MONTH, resultStatus: 'selected',
          candidateCount: 1, notificationState: 'sent', attemptCount: 1,
          sentAt: FIRST_DAY,
        };
      },
    };
    harness.dependencies.createSelectionService = async () => {
      harness.calls.createSelection += 1;
      return selectionService;
    };
    harness.dependencies.initializeEmailSender = async () => {
      harness.calls.initializeEmail += 1;
      return async () => ({});
    };
    harness.dependencies.createNotificationService = async options => {
      harness.calls.createNotification += 1;
      assert.equal(typeof options.send, 'function');
      assert.equal(options.administratorEmail, 'admin@example.test');
      return notificationService;
    };
    await runScheduledMonthlyDraw([], harness.dependencies);
    assert.equal(harness.calls.createSelection, 1);
    assert.equal(harness.calls.initializeEmail, 1);
    assert.equal(harness.calls.createNotification, 1);
  });

  test('direct failure boundary emits one fixed safe error', () => {
    const errors = [];
    const exits = [];
    handleScheduledMonthlyDrawFailure({
      output: { error: value => errors.push(value) },
      setExitCode: value => exits.push(value),
    });
    assert.deepEqual(errors, ['Scheduled monthly draw failed.']);
    assert.deepEqual(exits,
      [SCHEDULED_MONTHLY_DRAW_EXIT_CODES.operationalFailure]);
  });
});

describe('scheduled monthly draw source and package guards', () => {
  test('adds only repository commands without cron, Heroku configuration or routes', async () => {
    const [scheduled, notification, app, adminRoutes, otherRoutes] =
      await Promise.all([
        source('scripts/runScheduledMonthlyDraw.js'),
        source('scripts/runMonthlyDrawNotification.js'),
        source('app.js'),
        source('routes/admin.js'),
        source('routes/other.js'),
      ]);
    assert.doesNotMatch(`${scheduled}\n${notification}`,
      /cron(?:job|expression)|schedule\.yaml|Procfile/iu);
    assert.doesNotMatch(`${app}\n${adminRoutes}\n${otherRoutes}`,
      /runScheduledMonthlyDraw|runMonthlyDrawNotification|MonthlyDrawResult/iu);
    assert.doesNotMatch(`${adminRoutes}\n${otherRoutes}`,
      /monthly-draw.*(?:notify|select|result)/iu);
    assert.doesNotMatch(scheduled, /--apply|--month|--dry-run/iu);
  });

  test('preserves dependencies, package lock and exact engines', async () => {
    const packageJson = JSON.parse(await source('package.json'));
    const headPackage = JSON.parse(execFileSync(
      'git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8' },
    ));
    assert.equal(packageJson.scripts['monthly-draw:notify'],
      'node scripts/runMonthlyDrawNotification.js');
    assert.equal(packageJson.scripts['monthly-draw:scheduled'],
      'node scripts/runScheduledMonthlyDraw.js');
    assert.deepEqual(packageJson.dependencies, headPackage.dependencies);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.equal(
      execFileSync('git', ['hash-object', 'package-lock.json'], {
        cwd: root, encoding: 'utf8',
      }).trim(),
      execFileSync('git', ['rev-parse', 'HEAD:package-lock.json'], {
        cwd: root, encoding: 'utf8',
      }).trim(),
    );
  });

  test('does not add migrations, startup mutation, public results or draw buttons', async () => {
    const files = await Promise.all([
      source('utils/monthlyDrawNotification.js'),
      source('scripts/runMonthlyDrawNotification.js'),
      source('scripts/runScheduledMonthlyDraw.js'),
      source('models/monthlyDrawResult.js'),
    ]);
    const combined = files.join('\n');
    assert.doesNotMatch(combined, /migrat|backfill|bulkWrite|syncIndexes|createIndex/iu);
    assert.doesNotMatch(combined, /winner claim|publish winner|gift.?card delivery/iu);
    assert.doesNotMatch(await source('app.js'),
      /monthlyDrawNotification|runScheduledMonthlyDraw/iu);
    assert.doesNotMatch(await source('views/admin/dashboard.ejs'),
      /monthly.*(?:select|draw|notify).*button/iu);
  });
});
