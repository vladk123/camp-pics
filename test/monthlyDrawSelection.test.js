import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { adminRoadmap } from '../config/adminRoadmap.js';
import { MonthlyDrawResult } from '../models/monthlyDrawResult.js';
import {
  MONTHLY_DRAW_SELECTION_EXIT_CODES,
  MONTHLY_DRAW_SELECTION_INVALID_APPLY_MONTH_MESSAGE,
  MonthlyDrawSelectionArgumentError,
  handleMonthlyDrawSelectionDirectFailure,
  parseMonthlyDrawSelectionArguments,
  runMonthlyDrawSelectionCli,
} from '../scripts/runMonthlyDrawSelection.js';
import {
  MONTHLY_DRAW_RULES_VERSION,
  buildMonthlyDrawEntrantFingerprint,
  buildMonthlyDrawNoUploadEntryId,
  buildMonthlyDrawNoUploadSourceReference,
  buildMonthlyDrawResultId,
  getPreviousMonthlyDrawMonthKey,
} from '../utils/monthlyDraw.js';
import {
  MONTHLY_DRAW_ACCOUNT_SELECTION_PROJECTION,
  MONTHLY_DRAW_NO_UPLOAD_SELECTION_PROJECTION,
  MONTHLY_DRAW_SELECTION_BLOCKED_MESSAGE,
  MONTHLY_DRAW_UPLOAD_SELECTION_PROJECTION,
  createMonthlyDrawSelectionService,
  selectWeightedDistinctCandidates,
} from '../utils/monthlyDrawSelection.js';

const root = process.cwd();
const MONTH = '2026-07';
const SELECTED_AT = new Date('2026-08-01T04:05:00.000Z');
const USER_A = '000000000000000000000001';
const USER_B = '000000000000000000000002';
const USER_C = '000000000000000000000003';
const USER_D = '000000000000000000000004';
const USER_E = '000000000000000000000005';
const USER_F = '000000000000000000000006';
const UPLOAD_1 = '100000000000000000000001';
const UPLOAD_2 = '100000000000000000000002';
const UPLOAD_3 = '100000000000000000000003';

const read = relativePath => readFile(path.join(root, relativePath), 'utf8');

function fingerprint(userId = USER_A, monthKey = MONTH) {
  return buildMonthlyDrawEntrantFingerprint(userId, monthKey);
}

function noUploadSourceReference(userId = USER_A, monthKey = MONTH) {
  return buildMonthlyDrawNoUploadSourceReference(userId, monthKey);
}

function candidate({
  rank = 1,
  userId = USER_A,
  sourceType = 'upload',
  sourceId = UPLOAD_1,
  entryCount = 1,
} = {}) {
  return {
    rank,
    entrantFingerprint: fingerprint(userId),
    sourceType,
    sourceId,
    entryCount,
  };
}

function validResultData(overrides = {}) {
  const {
    candidates = [candidate()],
    poolSummary: poolOverrides = {},
    ...topLevelOverrides
  } = overrides;
  const eligibleUploadEntries = poolOverrides.eligibleUploadEntries ??
    candidates.length;
  const eligibleNoUploadEntries = poolOverrides.eligibleNoUploadEntries ?? 0;
  return {
    _id: buildMonthlyDrawResultId(MONTH),
    monthKey: MONTH,
    rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    status: 'selected',
    selectedAt: SELECTED_AT,
    candidates,
    poolSummary: {
      eligibleUploadEntries,
      eligibleNoUploadEntries,
      totalEligibleEntries: eligibleUploadEntries + eligibleNoUploadEntries,
      eligibleDistinctEntrants: candidates.length,
      excludedAccountEntries: 0,
      candidatesSelected: candidates.length,
      pendingUploadsAtSelection: 0,
      ...poolOverrides,
    },
    ...topLevelOverrides,
  };
}

function validationError(data) {
  return new MonthlyDrawResult(data).validateSync();
}

function normalizedEntry({
  sourceType = 'upload',
  sourceId = UPLOAD_1,
  userId = USER_A,
} = {}) {
  return Object.freeze({
    sourceType,
    sourceId,
    userId,
    entrantFingerprint: fingerprint(userId),
  });
}

function upload({
  _id = UPLOAD_1,
  userId = USER_A,
  status = 'eligible',
  monthKey = MONTH,
  rulesVersion = MONTHLY_DRAW_RULES_VERSION,
  monthlyDraw = true,
} = {}) {
  return {
    _id,
    userId,
    ...(monthlyDraw ? {
      monthlyDraw: { status, monthKey, rulesVersion },
    } : {}),
  };
}

function noUpload({
  userId = USER_A,
  monthKey = MONTH,
  rulesVersion = MONTHLY_DRAW_RULES_VERSION,
  _id = buildMonthlyDrawNoUploadEntryId(userId, monthKey),
} = {}) {
  return { _id, userId, monthKey, rulesVersion };
}

function account(_id, overrides = {}) {
  return {
    _id,
    email_verified: true,
    isAdmin: false,
    blocked: false,
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function fakeQuery(value, call) {
  return {
    select(projection) {
      call.projection = projection;
      return this;
    },
    session(session) {
      call.session = session;
      return this;
    },
    async lean() {
      return clone(value);
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function storedResult(overrides = {}) {
  return validResultData(overrides);
}

function createSelectionHarness({
  uploads = [upload()],
  noUploads = [],
  users = [account(USER_A)],
  existingResult = null,
  duplicateResult = null,
  retryTransaction = false,
  randomValues = [0, 0, 0],
} = {}) {
  const state = { result: existingResult ? clone(existingResult) : null };
  const calls = {
    resultFinds: [],
    uploadCounts: [],
    uploadFinds: [],
    noUploadFinds: [],
    userFinds: [],
    creates: [],
    sessions: [],
    randomMaximums: [],
    transactionAttempts: 0,
    endSessions: 0,
  };
  let currentAttempt = 0;
  let randomIndex = 0;

  const ResultModel = {
    findOne(filter) {
      const call = { filter: clone(filter), session: null, projection: null };
      calls.resultFinds.push(call);
      const found = state.result?._id === filter._id ? state.result : null;
      return fakeQuery(found, call);
    },
    async create(records, options) {
      calls.creates.push({ records: clone(records), options });
      if (duplicateResult) {
        state.result = clone(duplicateResult);
        const error = new Error('duplicate monthly result');
        error.code = 11000;
        throw error;
      }
      if (!retryTransaction || currentAttempt === 2) {
        state.result = clone(records[0]);
      }
      return records.map(record => ({
        ...clone(record),
        toObject() {
          return clone(record);
        },
      }));
    },
  };
  const UploadModel = {
    countDocuments(filter) {
      const call = { filter: clone(filter), session: null };
      calls.uploadCounts.push(call);
      const count = uploads.filter(item =>
        item.monthlyDraw?.monthKey === filter['monthlyDraw.monthKey'] &&
        item.monthlyDraw?.status === filter['monthlyDraw.status']
      ).length;
      return fakeQuery(count, call);
    },
    find(filter) {
      const call = { filter: clone(filter), session: null, projection: null };
      calls.uploadFinds.push(call);
      return fakeQuery(uploads, call);
    },
  };
  const NoUploadEntryModel = {
    find(filter) {
      const call = { filter: clone(filter), session: null, projection: null };
      calls.noUploadFinds.push(call);
      return fakeQuery(noUploads, call);
    },
  };
  const UserModel = {
    find(filter) {
      const call = { filter: clone(filter), session: null, projection: null };
      calls.userFinds.push(call);
      const ids = new Set(filter._id.$in.map(String));
      return fakeQuery(users.filter(user => ids.has(String(user._id))), call);
    },
  };
  const startSession = async () => {
    const session = {
      async withTransaction(work, options) {
        this.transactionOptions = options;
        const attempts = retryTransaction ? 2 : 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          currentAttempt = attempt;
          calls.transactionAttempts += 1;
          await work();
        }
      },
      async endSession() {
        calls.endSessions += 1;
      },
    };
    calls.sessions.push(session);
    return session;
  };
  const randomInt = maximum => {
    calls.randomMaximums.push(maximum);
    const value = randomValues[randomIndex] ?? 0;
    randomIndex += 1;
    return value;
  };
  const service = createMonthlyDrawSelectionService({
    ResultModel,
    UploadModel,
    NoUploadEntryModel,
    UserModel,
    startSession,
    randomInt,
    now: () => new Date(SELECTED_AT),
  });
  return { calls, service, state };
}

describe('monthly draw month and deterministic identity helpers', () => {
  test('derives the previous America/Toronto month at ordinary and UTC-boundary times', () => {
    assert.equal(
      getPreviousMonthlyDrawMonthKey(new Date('2026-08-15T16:00:00.000Z')),
      '2026-07',
    );
    assert.equal(
      getPreviousMonthlyDrawMonthKey(new Date('2026-01-15T17:00:00.000Z')),
      '2025-12',
    );
    assert.equal(
      getPreviousMonthlyDrawMonthKey(new Date('2026-03-01T04:30:00.000Z')),
      '2026-01',
    );
  });

  test('builds only the exact deterministic result ID', () => {
    assert.equal(buildMonthlyDrawResultId(MONTH), `monthly-draw-result:${MONTH}`);
    for (const value of [null, undefined, 202607, '2026-7', '2026-13']) {
      assert.throws(() => buildMonthlyDrawResultId(value), TypeError);
    }
  });

  test('builds stable lowercase SHA-256 monthly entrant fingerprints', () => {
    const first = fingerprint(USER_A.toUpperCase(), MONTH);
    assert.match(first, /^[a-f0-9]{64}$/u);
    assert.equal(first, fingerprint(USER_A, MONTH));
    assert.notEqual(first, fingerprint(USER_B, MONTH));
    assert.notEqual(first, fingerprint(USER_A, '2026-06'));
  });

  test('rejects malformed fingerprint inputs', () => {
    for (const userId of [null, '', 'abc', `${USER_A}00`]) {
      assert.throws(
        () => buildMonthlyDrawEntrantFingerprint(userId, MONTH),
        TypeError,
      );
    }
    for (const monthKey of [null, '2026-7', '2026-00', '2026-13']) {
      assert.throws(
        () => buildMonthlyDrawEntrantFingerprint(USER_A, monthKey),
        TypeError,
      );
    }
  });

  test('builds opaque deterministic no-upload source references', () => {
    const reference = noUploadSourceReference(USER_A, MONTH);
    assert.match(
      reference,
      /^monthly-draw-no-upload-ref:2026-07:[a-f0-9]{64}$/u,
    );
    assert.equal(
      reference,
      noUploadSourceReference(USER_A.toUpperCase(), MONTH),
    );
    assert.notEqual(reference, noUploadSourceReference(USER_B, MONTH));
    assert.notEqual(reference, noUploadSourceReference(USER_A, '2026-06'));
    assert.equal(reference.includes(USER_A), false);
    assert.notEqual(reference, buildMonthlyDrawNoUploadEntryId(USER_A, MONTH));
  });

  test('rejects malformed no-upload source-reference inputs', () => {
    for (const userId of [null, '', 'abc', `${USER_A}00`]) {
      assert.throws(
        () => buildMonthlyDrawNoUploadSourceReference(userId, MONTH),
        TypeError,
      );
    }
    for (const monthKey of [null, '2026-7', '2026-00', '2026-13']) {
      assert.throws(
        () => buildMonthlyDrawNoUploadSourceReference(USER_A, monthKey),
        TypeError,
      );
    }
  });
});

describe('privacy-minimal MonthlyDrawResult model', () => {
  test('has the exact top-level, candidate and numeric summary fields', () => {
    assert.deepEqual(Object.keys(MonthlyDrawResult.schema.paths), [
      '_id',
      'monthKey',
      'rulesVersion',
      'status',
      'selectedAt',
      'candidates',
      'poolSummary',
      'createdAt',
      'updatedAt',
      '__v',
    ]);
    assert.deepEqual(
      Object.keys(MonthlyDrawResult.schema.path('candidates').schema.paths),
      ['rank', 'entrantFingerprint', 'sourceType', 'sourceId', 'entryCount'],
    );
    assert.deepEqual(
      Object.keys(MonthlyDrawResult.schema.path('poolSummary').schema.paths),
      [
        'eligibleUploadEntries',
        'eligibleNoUploadEntries',
        'totalEligibleEntries',
        'eligibleDistinctEntrants',
        'excludedAccountEntries',
        'candidatesSelected',
        'pendingUploadsAtSelection',
      ],
    );
    assert.equal(MonthlyDrawResult.schema.options.strict, 'throw');
    assert.equal(MonthlyDrawResult.schema.options.timestamps, true);
    assert.deepEqual(MonthlyDrawResult.schema.indexes(), []);
  });

  test('requires its deterministic ID, valid month, current rules and immutable result fields', () => {
    assert.equal(validationError(validResultData()), undefined);
    assert.ok(validationError(validResultData({ _id: 'monthly-draw-result:2026-06' })));
    assert.ok(validationError(validResultData({ monthKey: '2026-7' })));
    assert.ok(validationError(validResultData({ rulesVersion: 'legacy' })));
    for (const field of [
      '_id', 'monthKey', 'rulesVersion', 'status', 'selectedAt', 'candidates',
      'poolSummary',
    ]) {
      assert.equal(MonthlyDrawResult.schema.path(field).options.immutable, true);
    }
  });

  test('selected accepts one to three candidates and no-eligible accepts none', () => {
    const candidates = [
      candidate({ rank: 1, userId: USER_A, sourceId: UPLOAD_1 }),
      candidate({ rank: 2, userId: USER_B, sourceId: UPLOAD_2 }),
      candidate({ rank: 3, userId: USER_C, sourceId: UPLOAD_3 }),
    ];
    for (let count = 1; count <= 3; count += 1) {
      assert.equal(
        validationError(validResultData({
          candidates: candidates.slice(0, count),
          poolSummary: {
            eligibleUploadEntries: count,
            totalEligibleEntries: count,
            eligibleDistinctEntrants: count,
            candidatesSelected: count,
          },
        })),
        undefined,
      );
    }
    assert.ok(validationError(validResultData({ candidates: [] })));
    const withoutCandidates = validResultData();
    delete withoutCandidates.candidates;
    assert.ok(validationError(withoutCandidates));
    assert.equal(validationError(validResultData({
      status: 'no-eligible-entries',
      candidates: [],
      poolSummary: {
        eligibleUploadEntries: 0,
        totalEligibleEntries: 0,
        eligibleDistinctEntrants: 0,
        candidatesSelected: 0,
      },
    })), undefined);
    assert.ok(validationError(validResultData({ status: 'no-eligible-entries' })));
  });

  test('requires contiguous unique ranks and distinct fingerprints', () => {
    assert.ok(validationError(validResultData({ candidates: [
      candidate(),
      candidate({ rank: 1, userId: USER_B, sourceId: UPLOAD_2 }),
    ] })));
    assert.ok(validationError(validResultData({ candidates: [
      candidate(),
      candidate({ rank: 3, userId: USER_B, sourceId: UPLOAD_2 }),
    ] })));
    assert.ok(validationError(validResultData({ candidates: [
      candidate(),
      { ...candidate({ rank: 2, userId: USER_B, sourceId: UPLOAD_2 }),
        entrantFingerprint: fingerprint(USER_A) },
    ] })));
  });

  test('enforces upload and opaque no-upload source ID contracts', () => {
    const exactNoUpload = candidate({
      sourceType: 'no-upload',
      sourceId: noUploadSourceReference(USER_A, MONTH),
    });
    assert.equal(validationError(validResultData({
      candidates: [exactNoUpload],
      poolSummary: {
        eligibleUploadEntries: 0,
        eligibleNoUploadEntries: 1,
        totalEligibleEntries: 1,
      },
    })), undefined);
    assert.equal(
      validationError(validResultData({ candidates: [candidate()] })),
      undefined,
    );

    const badNoUploadReferences = [
      buildMonthlyDrawNoUploadEntryId(USER_A, MONTH),
      noUploadSourceReference(USER_A, '2026-06'),
      `monthly-draw-no-upload-ref:${MONTH}:${'A'.repeat(64)}`,
      `monthly-draw-no-upload-ref:${MONTH}:${'a'.repeat(63)}`,
      UPLOAD_1,
    ];
    for (const sourceId of badNoUploadReferences) {
      assert.ok(validationError(validResultData({
        candidates: [candidate({ sourceType: 'no-upload', sourceId })],
        poolSummary: {
          eligibleUploadEntries: 0,
          eligibleNoUploadEntries: 1,
          totalEligibleEntries: 1,
        },
      })));
    }
    for (const badCandidate of [
      candidate({ sourceType: 'legacy' }),
      candidate({ sourceId: 'ABCDEFABCDEFABCDEFABCDEF' }),
      candidate({ entryCount: 0 }),
      candidate({ entryCount: 1.5 }),
    ]) {
      assert.ok(validationError(validResultData({
        candidates: [badCandidate],
      })));
    }
  });

  test('enforces non-negative integer and exact pool-summary relationships', () => {
    const invalidSummaries = [
      { eligibleUploadEntries: -1 },
      { eligibleNoUploadEntries: 0.5 },
      { totalEligibleEntries: 9 },
      { eligibleDistinctEntrants: 2 },
      {
        eligibleUploadEntries: 4,
        totalEligibleEntries: 4,
        eligibleDistinctEntrants: 4,
        candidatesSelected: 1,
      },
      { candidatesSelected: 0 },
      { pendingUploadsAtSelection: 1 },
    ];
    for (const poolSummary of invalidSummaries) {
      assert.ok(validationError(validResultData({ poolSummary })));
    }
    assert.ok(validationError(validResultData({
      status: 'no-eligible-entries',
      candidates: [],
      poolSummary: {
        eligibleUploadEntries: 1,
        totalEligibleEntries: 1,
        eligibleDistinctEntrants: 1,
        candidatesSelected: 0,
      },
    })));
  });

  test('declares no direct identity, contact, location or caption storage', () => {
    const schemaText = [
      ...Object.keys(MonthlyDrawResult.schema.paths),
      ...Object.keys(MonthlyDrawResult.schema.path('candidates').schema.paths),
      ...Object.keys(MonthlyDrawResult.schema.path('poolSummary').schema.paths),
    ].join(' ');
    assert.doesNotMatch(
      schemaText,
      /userId|email|username|nickname|caption|province|address|phone|park|campground|campsite|location|ip|agent/iu,
    );
    assert.throws(
      () => new MonthlyDrawResult({ ...validResultData(), userId: USER_A }),
      /strict/iu,
    );
  });
});

describe('weighted distinct-person selection', () => {
  test('uses every position as weight, preserves the selected source and removes the person', () => {
    const entries = [
      normalizedEntry({ sourceId: UPLOAD_1, userId: USER_A }),
      normalizedEntry({ sourceId: UPLOAD_2, userId: USER_A }),
      normalizedEntry({
        sourceType: 'no-upload',
        sourceId: noUploadSourceReference(USER_B, MONTH),
        userId: USER_B,
      }),
      normalizedEntry({ sourceId: UPLOAD_3, userId: USER_C }),
    ];
    const maximums = [];
    const values = [1, 1, 0];
    const selected = selectWeightedDistinctCandidates(entries, maximum => {
      maximums.push(maximum);
      return values.shift();
    });

    assert.deepEqual(maximums, [4, 2, 1]);
    assert.deepEqual(selected.map(item => item.sourceId), [
      UPLOAD_2,
      UPLOAD_3,
      noUploadSourceReference(USER_B, MONTH),
    ]);
    assert.deepEqual(selected.map(item => item.entryCount), [2, 1, 1]);
    assert.equal(new Set(selected.map(item => item.entrantFingerprint)).size, 3);
    assert.deepEqual(entries.map(item => item.sourceId), [
      UPLOAD_1,
      UPLOAD_2,
      noUploadSourceReference(USER_B, MONTH),
      UPLOAD_3,
    ]);
  });

  test('returns exactly one, two or three people without fabricating alternates', () => {
    const entries = [
      normalizedEntry({ userId: USER_A, sourceId: UPLOAD_1 }),
      normalizedEntry({ userId: USER_B, sourceId: UPLOAD_2 }),
      normalizedEntry({ userId: USER_C, sourceId: UPLOAD_3 }),
    ];
    for (const count of [1, 2, 3]) {
      const result = selectWeightedDistinctCandidates(
        entries.slice(0, count),
        () => 0,
      );
      assert.equal(result.length, count);
      assert.deepEqual(result.map(item => item.rank),
        Array.from({ length: count }, (_, index) => index + 1));
    }
  });

  test('does not call Math.random or add ordering before choosing a position', () => {
    const original = Math.random;
    Math.random = () => assert.fail('Math.random must not be used');
    try {
      const entries = [
        normalizedEntry({ userId: USER_C, sourceId: UPLOAD_3 }),
        normalizedEntry({ userId: USER_A, sourceId: UPLOAD_1 }),
        normalizedEntry({ userId: USER_B, sourceId: UPLOAD_2 }),
      ];
      const result = selectWeightedDistinctCandidates(entries, () => 0);
      assert.equal(result[0].sourceId, UPLOAD_3);
      assert.equal(result[1].sourceId, UPLOAD_1);
      assert.equal(result[2].sourceId, UPLOAD_2);
    } finally {
      Math.random = original;
    }
  });
});

describe('monthly draw pool inspection', () => {
  test('combines current entries, counts pending separately and rechecks accounts once', async () => {
    const uploads = [
      upload({ _id: UPLOAD_1, userId: USER_A }),
      upload({ _id: UPLOAD_2, userId: USER_A }),
      upload({ _id: UPLOAD_3, userId: USER_B, status: 'pending' }),
      upload({ _id: '100000000000000000000004', userId: USER_B, status: 'ineligible' }),
      upload({ _id: '100000000000000000000005', userId: USER_C, monthlyDraw: false }),
      upload({ _id: '100000000000000000000006', userId: USER_C, monthKey: '2026-06' }),
      upload({ _id: '100000000000000000000007', userId: USER_C, rulesVersion: 'legacy' }),
      upload({ _id: '100000000000000000000008', userId: USER_C }),
      upload({ _id: '100000000000000000000009', userId: USER_D }),
      upload({ _id: '10000000000000000000000a', userId: USER_E }),
      upload({ _id: '10000000000000000000000b', userId: USER_F }),
    ];
    const noUploads = [
      noUpload({ userId: USER_A }),
      noUpload({ userId: USER_B }),
      noUpload({ userId: USER_C }),
      noUpload({ userId: USER_F }),
      noUpload({ userId: USER_A, monthKey: '2026-06' }),
      noUpload({ userId: USER_A, rulesVersion: 'legacy' }),
    ];
    const users = [
      account(USER_A),
      account(USER_B),
      account(USER_C, { blocked: true }),
      account(USER_D, { isAdmin: true }),
      account(USER_E, { email_verified: false }),
    ];
    const originalUploads = clone(uploads);
    const originalNoUploads = clone(noUploads);
    const originalUsers = clone(users);
    const harness = createSelectionHarness({ uploads, noUploads, users });

    const inspection = await harness.service.inspectPool({ monthKey: MONTH });

    assert.deepEqual(inspection, {
      monthKey: MONTH,
      pendingUploads: 1,
      eligibleUploadEntries: 2,
      eligibleNoUploadEntries: 2,
      totalEligibleEntries: 4,
      eligibleDistinctEntrants: 2,
      excludedAccountEntries: 6,
      selectionReady: false,
      resultAlreadyExists: false,
    });
    assert.equal(harness.calls.userFinds.length, 1);
    assert.deepEqual(
      new Set(harness.calls.userFinds[0].filter._id.$in),
      new Set([USER_A, USER_C, USER_D, USER_E, USER_F, USER_B]),
    );
    assert.deepEqual(
      harness.calls.uploadFinds[0].projection,
      MONTHLY_DRAW_UPLOAD_SELECTION_PROJECTION,
    );
    assert.deepEqual(
      harness.calls.noUploadFinds[0].projection,
      MONTHLY_DRAW_NO_UPLOAD_SELECTION_PROJECTION,
    );
    assert.deepEqual(
      harness.calls.userFinds[0].projection,
      MONTHLY_DRAW_ACCOUNT_SELECTION_PROJECTION,
    );
    assert.doesNotMatch(
      JSON.stringify(inspection),
      /userId|sourceId|fingerprint|email|caption|location/iu,
    );
    assert.deepEqual(uploads, originalUploads);
    assert.deepEqual(noUploads, originalNoUploads);
    assert.deepEqual(users, originalUsers);
  });

  test('reports result existence without exposing the stored result', async () => {
    const harness = createSelectionHarness({ existingResult: storedResult() });
    const inspection = await harness.service.inspectPool({ monthKey: MONTH });
    assert.equal(inspection.resultAlreadyExists, true);
    assert.equal(inspection.selectionReady, false);
    assert.equal(Object.hasOwn(inspection, 'result'), false);
  });

  test('uses one bounded User query even when the candidate-source pool is empty', async () => {
    const harness = createSelectionHarness({
      uploads: [],
      noUploads: [],
      users: [],
    });
    const inspection = await harness.service.inspectPool({ monthKey: MONTH });
    assert.equal(inspection.totalEligibleEntries, 0);
    assert.equal(harness.calls.userFinds.length, 1);
    assert.deepEqual(harness.calls.userFinds[0].filter, {
      _id: { $in: [] },
    });
  });

  test('rejects a no-upload record whose real document ID is inconsistent', async () => {
    const harness = createSelectionHarness({
      uploads: [],
      noUploads: [noUpload({
        userId: USER_A,
        _id: buildMonthlyDrawNoUploadEntryId(USER_B, MONTH),
      })],
      users: [account(USER_A)],
    });

    await assert.rejects(
      harness.service.inspectPool({ monthKey: MONTH }),
      /no-upload entry identity is invalid/u,
    );
    assert.equal(harness.calls.userFinds.length, 0);
  });
});

describe('transactional persistence, idempotence and concurrency', () => {
  test('pending uploads block before pool reads, randomness and creation', async () => {
    const harness = createSelectionHarness({
      uploads: [upload({ status: 'pending' })],
    });
    const outcome = await harness.service.selectAndPersist({ monthKey: MONTH });
    assert.deepEqual(outcome, {
      state: 'blocked-pending-review',
      monthKey: MONTH,
      pendingUploads: 1,
      message: MONTHLY_DRAW_SELECTION_BLOCKED_MESSAGE,
    });
    assert.equal(harness.calls.uploadFinds.length, 0);
    assert.equal(harness.calls.userFinds.length, 0);
    assert.equal(harness.calls.randomMaximums.length, 0);
    assert.equal(harness.calls.creates.length, 0);
    assert.equal(harness.state.result, null);
  });

  test('creates one ready result and uses the same session for every query and write', async () => {
    const harness = createSelectionHarness({
      uploads: [upload({ userId: USER_A })],
      noUploads: [noUpload({ userId: USER_B })],
      users: [account(USER_A), account(USER_B)],
      randomValues: [1, 0],
    });
    const outcome = await harness.service.selectAndPersist({ monthKey: MONTH });
    const session = harness.calls.sessions[0];

    assert.equal(outcome.created, true);
    assert.equal(outcome.result._id, buildMonthlyDrawResultId(MONTH));
    assert.equal(outcome.result.status, 'selected');
    assert.deepEqual(outcome.result.candidates.map(item => item.rank), [1, 2]);
    assert.deepEqual(outcome.result.candidates.map(item => item.sourceId), [
      noUploadSourceReference(USER_B, MONTH),
      UPLOAD_1,
    ]);
    assert.equal(
      outcome.result.candidates[0].sourceId.includes(USER_B),
      false,
    );
    const serializedResult = JSON.stringify(outcome.result);
    assert.equal(
      serializedResult.includes(buildMonthlyDrawNoUploadEntryId(USER_B, MONTH)),
      false,
    );
    assert.equal(serializedResult.includes(USER_B), false);
    assert.deepEqual(harness.calls.randomMaximums, [2, 1]);
    assert.equal(harness.calls.creates.length, 1);
    assert.equal(harness.calls.creates[0].options.session, session);
    const transactionQueries = [
      ...harness.calls.resultFinds,
      ...harness.calls.uploadCounts,
      ...harness.calls.uploadFinds,
      ...harness.calls.noUploadFinds,
      ...harness.calls.userFinds,
    ];
    assert.equal(transactionQueries.every(call => call.session === session), true);
    assert.equal(harness.calls.endSessions, 1);
    assert.equal(outcome.result.poolSummary.pendingUploadsAtSelection, 0);
  });

  test('returns an existing result without recounting or rerunning randomness', async () => {
    const existing = storedResult();
    const harness = createSelectionHarness({ existingResult: existing });
    const outcome = await harness.service.selectAndPersist({ monthKey: MONTH });
    assert.equal(outcome.created, false);
    assert.deepEqual(outcome.result.candidates, existing.candidates);
    assert.equal(harness.calls.uploadCounts.length, 0);
    assert.equal(harness.calls.uploadFinds.length, 0);
    assert.equal(harness.calls.randomMaximums.length, 0);
    assert.equal(harness.calls.creates.length, 0);
  });

  test('repeated calls reuse identical candidates and one deterministic record', async () => {
    const harness = createSelectionHarness({ randomValues: [0, 0, 0] });
    const first = await harness.service.selectAndPersist({ monthKey: MONTH });
    const second = await harness.service.selectAndPersist({ monthKey: MONTH });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.result.candidates, first.result.candidates);
    assert.equal(harness.calls.creates.length, 1);
    assert.equal(harness.calls.randomMaximums.length, 1);
    assert.equal(harness.state.result._id, buildMonthlyDrawResultId(MONTH));
  });

  test('duplicate-key concurrency loads the committed deterministic result', async () => {
    const committed = storedResult({
      candidates: [candidate({ sourceId: UPLOAD_2 })],
    });
    const harness = createSelectionHarness({
      duplicateResult: committed,
      randomValues: [0],
    });
    const outcome = await harness.service.selectAndPersist({ monthKey: MONTH });
    assert.equal(outcome.created, false);
    assert.deepEqual(outcome.result, committed);
    assert.equal(harness.calls.creates.length, 1);
    assert.equal(harness.calls.resultFinds.length, 2);
    assert.equal(
      harness.calls.resultFinds[1].session,
      harness.calls.sessions[0],
    );
  });

  test('transaction callback retry uses attempt-local candidates and arrays', async () => {
    const harness = createSelectionHarness({
      uploads: [
        upload({ _id: UPLOAD_1, userId: USER_A }),
        upload({ _id: UPLOAD_2, userId: USER_B }),
      ],
      users: [account(USER_A), account(USER_B)],
      retryTransaction: true,
      randomValues: [0, 0, 1, 0],
    });
    const outcome = await harness.service.selectAndPersist({ monthKey: MONTH });
    assert.equal(harness.calls.transactionAttempts, 2);
    assert.equal(harness.calls.creates.length, 2);
    assert.equal(outcome.result.candidates.length, 2);
    assert.deepEqual(outcome.result.candidates.map(item => item.rank), [1, 2]);
    assert.equal(new Set(outcome.result.candidates
      .map(item => item.entrantFingerprint)).size, 2);
  });

  test('persists one no-eligible-entries result after account filtering', async () => {
    const harness = createSelectionHarness({
      users: [account(USER_A, { blocked: true })],
    });
    const outcome = await harness.service.selectAndPersist({ monthKey: MONTH });
    assert.equal(outcome.created, true);
    assert.equal(outcome.result.status, 'no-eligible-entries');
    assert.deepEqual(outcome.result.candidates, []);
    assert.deepEqual(outcome.result.poolSummary, {
      eligibleUploadEntries: 0,
      eligibleNoUploadEntries: 0,
      totalEligibleEntries: 0,
      eligibleDistinctEntrants: 0,
      excludedAccountEntries: 1,
      candidatesSelected: 0,
      pendingUploadsAtSelection: 0,
    });
    assert.equal(harness.calls.randomMaximums.length, 0);
    assert.equal(harness.calls.creates.length, 1);
  });
});

describe('monthly draw repository command', () => {
  const now = new Date('2026-08-04T16:00:00.000Z');

  test('parses default dry-run, previous Eastern month and explicit modes', () => {
    assert.deepEqual(parseMonthlyDrawSelectionArguments([], now), {
      mode: 'dry-run',
      monthKey: '2026-07',
    });
    assert.deepEqual(parseMonthlyDrawSelectionArguments(
      ['--month', '2025-12'], now,
    ), { mode: 'dry-run', monthKey: '2025-12' });
    assert.deepEqual(parseMonthlyDrawSelectionArguments(
      ['--apply', '--month', '2026-07'], now,
    ), { mode: 'apply', monthKey: '2026-07' });
    assert.deepEqual(parseMonthlyDrawSelectionArguments(
      ['--dry-run', '--month', '2026-08'], now,
    ), { mode: 'dry-run', monthKey: '2026-08' });
  });

  test('rejects conflicts, repeats, unknowns, missing values and malformed months', () => {
    for (const args of [
      ['--apply', '--dry-run'],
      ['--apply', '--apply'],
      ['--dry-run', '--dry-run'],
      ['--month', MONTH, '--month', MONTH],
      ['--month'],
      ['--month', '2026-7'],
      ['--month=2026-07'],
      ['--unknown'],
      [USER_A],
    ]) {
      assert.throws(
        () => parseMonthlyDrawSelectionArguments(args, now),
        error => error instanceof MonthlyDrawSelectionArgumentError &&
          error.exitCode === MONTHLY_DRAW_SELECTION_EXIT_CODES.invalidArguments,
      );
    }
  });

  test('rejects current and future apply months but permits historical months', () => {
    for (const monthKey of ['2026-08', '2026-09', '9999-12']) {
      assert.throws(
        () => parseMonthlyDrawSelectionArguments(
          ['--apply', '--month', monthKey], now,
        ),
        error => error.message ===
          MONTHLY_DRAW_SELECTION_INVALID_APPLY_MONTH_MESSAGE &&
          error.exitCode ===
            MONTHLY_DRAW_SELECTION_EXIT_CODES.invalidApplyMonth,
      );
    }
    assert.equal(parseMonthlyDrawSelectionArguments(
      ['--apply', '--month', '2020-01'], now,
    ).monthKey, '2020-01');
  });

  test('dry-run inspects once, never selects and emits only safe fields', async () => {
    const calls = { inspect: 0, select: 0, connect: 0, disconnect: 0 };
    const lines = [];
    const report = await runMonthlyDrawSelectionCli(
      ['--month', MONTH],
      {
        service: {
          async inspectPool() {
            calls.inspect += 1;
            return {
              monthKey: MONTH,
              pendingUploads: 0,
              eligibleUploadEntries: 4,
              eligibleNoUploadEntries: 2,
              eligibleDistinctEntrants: 3,
              excludedAccountEntries: 1,
              selectionReady: true,
              resultAlreadyExists: false,
            };
          },
          async selectAndPersist() {
            calls.select += 1;
          },
        },
        connect: async () => { calls.connect += 1; },
        disconnect: async () => { calls.disconnect += 1; },
        databaseUrl: 'mongodb://fixture-secret-never-output',
        currentTime: () => now,
        output: { log: line => lines.push(line) },
      },
    );
    assert.deepEqual(calls, { inspect: 1, select: 0, connect: 1, disconnect: 1 });
    assert.deepEqual(Object.keys(report), [
      'mode',
      'targetMonth',
      'pendingReviewCount',
      'eligibleUploadCount',
      'eligibleNoUploadCount',
      'eligibleDistinctEntrantCount',
      'excludedAccountEntryCount',
      'selectionReady',
      'resultAlreadyExists',
    ]);
    assert.doesNotMatch(lines.join('\n'),
      /fixture-secret|userId|fingerprint|sourceId|email|username|caption|location/iu);
  });

  test('dry-run with pending reviews and no result exits nonzero without selecting', async () => {
    const calls = { inspect: 0, select: 0 };
    const exits = [];
    const report = await runMonthlyDrawSelectionCli(
      ['--month', MONTH],
      {
        service: {
          async inspectPool() {
            calls.inspect += 1;
            return {
              monthKey: MONTH,
              pendingUploads: 2,
              eligibleUploadEntries: 1,
              eligibleNoUploadEntries: 0,
              eligibleDistinctEntrants: 1,
              excludedAccountEntries: 0,
              selectionReady: false,
              resultAlreadyExists: false,
            };
          },
          async selectAndPersist() {
            calls.select += 1;
          },
        },
        connect: async () => {},
        disconnect: async () => {},
        databaseUrl: 'mongodb://fixture',
        currentTime: () => now,
        output: { log() {} },
        setExitCode: code => exits.push(code),
      },
    );

    assert.deepEqual(calls, { inspect: 1, select: 0 });
    assert.equal(report.pendingReviewCount, 2);
    assert.equal(report.resultAlreadyExists, false);
    assert.deepEqual(exits, [
      MONTHLY_DRAW_SELECTION_EXIT_CODES.pendingReviews,
    ]);
  });

  test('dry-run keeps an existing result successful while reporting pending reviews', async () => {
    const calls = { inspect: 0, select: 0 };
    const exits = [];
    const report = await runMonthlyDrawSelectionCli(
      ['--month', MONTH],
      {
        service: {
          async inspectPool() {
            calls.inspect += 1;
            return {
              monthKey: MONTH,
              pendingUploads: 2,
              eligibleUploadEntries: 1,
              eligibleNoUploadEntries: 0,
              eligibleDistinctEntrants: 1,
              excludedAccountEntries: 0,
              selectionReady: false,
              resultAlreadyExists: true,
            };
          },
          async selectAndPersist() {
            calls.select += 1;
          },
        },
        connect: async () => {},
        disconnect: async () => {},
        databaseUrl: 'mongodb://fixture',
        currentTime: () => now,
        output: { log() {} },
        setExitCode: code => exits.push(code),
      },
    );

    assert.deepEqual(calls, { inspect: 1, select: 0 });
    assert.equal(report.pendingReviewCount, 2);
    assert.equal(report.resultAlreadyExists, true);
    assert.deepEqual(exits, []);
  });

  test('apply invokes persistence once and does not print candidate identities', async () => {
    const calls = { select: 0 };
    const lines = [];
    const sourceReference = noUploadSourceReference(USER_A, MONTH);
    const rawNoUploadEntryId = buildMonthlyDrawNoUploadEntryId(USER_A, MONTH);
    const persistedFixture = storedResult({
      candidates: [candidate({
        userId: USER_A,
        sourceType: 'no-upload',
        sourceId: sourceReference,
      })],
      poolSummary: {
        eligibleUploadEntries: 0,
        eligibleNoUploadEntries: 1,
        totalEligibleEntries: 1,
      },
    });
    assert.equal(JSON.stringify(persistedFixture).includes(USER_A), false);
    assert.equal(
      JSON.stringify(persistedFixture).includes(rawNoUploadEntryId),
      false,
    );
    const report = await runMonthlyDrawSelectionCli(
      ['--apply', '--month', MONTH],
      {
        service: {
          async selectAndPersist() {
            calls.select += 1;
            return {
              state: 'result',
              created: true,
              monthKey: MONTH,
              result: persistedFixture,
            };
          },
        },
        connect: async () => {},
        disconnect: async () => {},
        databaseUrl: 'mongodb://fixture-secret-never-output',
        currentTime: () => now,
        output: { log: line => lines.push(line) },
      },
    );
    assert.equal(calls.select, 1);
    assert.equal(report.persistence, 'newly-created');
    assert.equal(report.candidateCount, 1);
    assert.doesNotMatch(lines.join('\n'),
      new RegExp(
        `${USER_A}|${rawNoUploadEntryId}|${sourceReference}|fingerprint|sourceId|email|username|caption`,
        'iu',
      ));
  });

  test('pending state exits nonzero while an existing result is successful', async () => {
    const pendingExits = [];
    await runMonthlyDrawSelectionCli(['--apply', '--month', MONTH], {
      service: {
        async selectAndPersist() {
          return {
            state: 'blocked-pending-review',
            monthKey: MONTH,
            pendingUploads: 2,
            message: MONTHLY_DRAW_SELECTION_BLOCKED_MESSAGE,
          };
        },
      },
      connect: async () => {},
      disconnect: async () => {},
      databaseUrl: 'mongodb://fixture',
      currentTime: () => now,
      output: { log() {} },
      setExitCode: code => pendingExits.push(code),
    });
    assert.deepEqual(pendingExits, [
      MONTHLY_DRAW_SELECTION_EXIT_CODES.pendingReviews,
    ]);

    const existingExits = [];
    const report = await runMonthlyDrawSelectionCli(
      ['--apply', '--month', MONTH],
      {
        service: {
          async selectAndPersist() {
            return {
              state: 'result',
              created: false,
              monthKey: MONTH,
              result: storedResult(),
            };
          },
        },
        connect: async () => {},
        disconnect: async () => {},
        databaseUrl: 'mongodb://fixture',
        currentTime: () => now,
        output: { log() {} },
        setExitCode: code => existingExits.push(code),
      },
    );
    assert.equal(report.persistence, 'already-existed');
    assert.deepEqual(existingExits, []);
  });

  test('direct failures use distinct safe nonzero exit codes', () => {
    const messages = [];
    const exits = [];
    handleMonthlyDrawSelectionDirectFailure(
      new MonthlyDrawSelectionArgumentError(
        MONTHLY_DRAW_SELECTION_INVALID_APPLY_MONTH_MESSAGE,
        MONTHLY_DRAW_SELECTION_EXIT_CODES.invalidApplyMonth,
      ),
      {
        output: { error: message => messages.push(message) },
        setExitCode: code => exits.push(code),
      },
    );
    handleMonthlyDrawSelectionDirectFailure(new Error('secret failure'), {
      output: { error: message => messages.push(message) },
      setExitCode: code => exits.push(code),
    });
    assert.deepEqual(exits, [4, 1]);
    assert.doesNotMatch(messages.join('\n'), /secret failure/u);
  });
});

describe('rules, roadmap and deferred-scope source guards', () => {
  test('clarifies up to two alternates while retaining prize and response terms', async () => {
    const rules = await read('views/other/monthlyDraw.ejs');
    assert.match(
      rules,
      /One primary selected entrant and up to two distinct ranked alternates are selected when enough distinct eligible entrants exist\./u,
    );
    assert.match(rules, /one prize per monthly draw/iu);
    assert.match(rules, /seven calendar days to respond/u);
    assert.match(rules, /mathematical skill-testing question/u);
    assert.match(rules, /legal residents of Canada, including Quebec/u);
    assert.match(rules, /CAD \$10/u);
    assert.match(rules, /No-upload entry method/u);
    assert.match(rules, /Earlier uploads are not entered retroactively/u);
  });

  test('keeps selection in progress with core complete, email remaining and Scheduler blocked', () => {
    const items = adminRoadmap.phases.flatMap(phase => phase.items);
    const selection = items.find(item =>
      item.id === 'monthly-draw-selection-and-notification'
    );
    const scheduler = items.find(item =>
      item.id === 'monthly-draw-scheduler-activation'
    );
    assert.equal(adminRoadmap.updatedOn, '2026-08-04');
    assert.equal(selection.status, 'in_progress');
    assert.equal(selection.completedOn, null);
    assert.match(selection.notes.join('\n'),
      /Completed in this pass: deterministic monthly result identity/u);
    assert.match(selection.notes.join('\n'),
      /Completed in this pass: idempotent repeated and concurrent execution/u);
    assert.match(selection.notes.join('\n'),
      /Still required before completion: administrator notification email/u);
    assert.match(
      selection.notes.join('\n'),
      /querying the result month's current no-upload entries with a minimal projection, computing buildMonthlyDrawNoUploadSourceReference for each and matching the stored opaque source reference/u,
    );
    assert.match(
      selection.notes.join('\n'),
      /no current opaque-reference match as an unavailable historical candidate and never redraw/u,
    );
    assert.equal(scheduler.status, 'blocked');
  });

  test('keeps providers, email, Scheduler, routes, migrations and startup mutation deferred', async () => {
    const [selection, model, command, app, routes] = await Promise.all([
      read('utils/monthlyDrawSelection.js'),
      read('models/monthlyDrawResult.js'),
      read('scripts/runMonthlyDrawSelection.js'),
      read('app.js'),
      read('routes/admin.js'),
    ]);
    const newRuntime = `${selection}\n${model}\n${command}`;
    assert.doesNotMatch(
      newRuntime,
      /Mailgun|sendEmail|SentEmail|cloudinary|gift.?card|skill.?test|winner contact/iu,
    );
    assert.doesNotMatch(
      newRuntime,
      /notification|notify|resolveMonthlyDrawCandidate/iu,
    );
    assert.doesNotMatch(newRuntime, /scheduler|cron/iu);
    assert.doesNotMatch(newRuntime, /migrat|backfill|bulkWrite/iu);
    assert.doesNotMatch(model, /\.index\s*\(/u);
    assert.doesNotMatch(`${app}\n${routes}`,
      /runMonthlyDrawSelection|MonthlyDrawResult|monthly-draw\/result/iu);
    assert.doesNotMatch(routes, /monthly-draw.*(?:select|draw|result)/iu);
  });

  test('adds only the command script, preserves engines, dependencies and package lock', async () => {
    const packageJson = JSON.parse(await read('package.json'));
    const headPackage = JSON.parse(execFileSync(
      'git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8' },
    ));
    assert.equal(
      packageJson.scripts['monthly-draw:select'],
      'node scripts/runMonthlyDrawSelection.js',
    );
    assert.deepEqual(packageJson.dependencies, headPackage.dependencies);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.equal(
      execFileSync('git', ['hash-object', 'package-lock.json'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      execFileSync('git', ['rev-parse', 'HEAD:package-lock.json'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    );
  });

  test('does not change protected schemas or account-deletion behavior', () => {
    const status = execFileSync('git', [
      'status',
      '--short',
      '--',
      'models/user.js',
      'models/upload.js',
      'models/park.js',
      'utils/accountDeletion.js',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(status.trim(), '');
  });
});
