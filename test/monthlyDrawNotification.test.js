import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import ejs from 'ejs';
import mongoose from 'mongoose';

import { MonthlyDrawResult } from '../models/monthlyDrawResult.js';
import {
  MONTHLY_DRAW_RULES_VERSION,
  buildMonthlyDrawEntrantFingerprint,
  buildMonthlyDrawNoUploadEntryId,
  buildMonthlyDrawNoUploadSourceReference,
  buildMonthlyDrawResultId,
} from '../utils/monthlyDraw.js';
import {
  MONTHLY_DRAW_NOTIFICATION_LEASE_MS,
  MONTHLY_DRAW_NOTIFICATION_NO_UPLOAD_PROJECTION,
  MONTHLY_DRAW_NOTIFICATION_UPLOAD_PROJECTION,
  MONTHLY_DRAW_NOTIFICATION_USER_PROJECTION,
  createMonthlyDrawNotificationService,
} from '../utils/monthlyDrawNotification.js';
import {
  MONTHLY_DRAW_NOTIFICATION_EXIT_CODES,
  MonthlyDrawNotificationArgumentError,
  handleMonthlyDrawNotificationDirectFailure,
  parseMonthlyDrawNotificationArguments,
  runMonthlyDrawNotificationCli,
} from '../scripts/runMonthlyDrawNotification.js';
import { ADMIN_PARK_LOCATION_PROJECTION } from '../controllers/admin.js';

const root = process.cwd();
const MONTH = '2026-07';
const NOW = new Date('2026-08-04T16:00:00.000Z');
const USER_A = new mongoose.Types.ObjectId('111111111111111111111111');
const USER_B = new mongoose.Types.ObjectId('222222222222222222222222');
const USER_C = new mongoose.Types.ObjectId('333333333333333333333333');
const UPLOAD_A = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
const UPLOAD_C = new mongoose.Types.ObjectId('cccccccccccccccccccccccc');
const PARK_ID = new mongoose.Types.ObjectId('444444444444444444444444');
const CAMPGROUND_ID = new mongoose.Types.ObjectId('555555555555555555555555');
const CAMPSITE_ID = new mongoose.Types.ObjectId('666666666666666666666666');
const LEASE_TOKEN = Buffer.alloc(32, 7);
const PROVIDER_ID = '<monthly-draw@example.test>';

function candidate({
  rank = 1,
  userId = USER_A,
  sourceType = 'upload',
  sourceId = UPLOAD_A.toHexString(),
  entryCount = 1,
  entrantFingerprint = buildMonthlyDrawEntrantFingerprint(userId, MONTH),
} = {}) {
  return {
    rank,
    entrantFingerprint,
    sourceType,
    sourceId,
    entryCount,
  };
}

function resultData(overrides = {}) {
  const candidates = overrides.candidates || [candidate()];
  return {
    _id: buildMonthlyDrawResultId(MONTH),
    monthKey: MONTH,
    rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    status: 'selected',
    selectedAt: new Date('2026-08-01T04:02:00.000Z'),
    candidates,
    poolSummary: {
      eligibleUploadEntries: 1,
      eligibleNoUploadEntries: 0,
      totalEligibleEntries: 1,
      eligibleDistinctEntrants: 1,
      excludedAccountEntries: 0,
      candidatesSelected: candidates.length,
      pendingUploadsAtSelection: 0,
    },
    ...overrides,
  };
}

function upload(overrides = {}) {
  return {
    _id: UPLOAD_A,
    userId: USER_A,
    mediaType: 'photo',
    createdAt: new Date('2026-07-12T15:30:00.000Z'),
    parkId: PARK_ID,
    parkName: 'Safe Park',
    campgroundId: CAMPGROUND_ID,
    campgroundName: 'North Loop',
    campsiteId: CAMPSITE_ID,
    campsiteName: 'Site 12',
    monthlyDraw: {
      status: 'eligible',
      monthKey: MONTH,
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    },
    ...overrides,
  };
}

function noUploadEntry(userId = USER_B, overrides = {}) {
  return {
    _id: buildMonthlyDrawNoUploadEntryId(userId, MONTH),
    userId,
    monthKey: MONTH,
    rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    ...overrides,
  };
}

function account(userId, overrides = {}) {
  return {
    _id: userId,
    fname: `Camper-${userId.toHexString().slice(0, 2)}`,
    username: `${userId.toHexString().slice(0, 4)}@example.test`,
    email_verified: true,
    isAdmin: false,
    blocked: false,
    ...overrides,
  };
}

function park() {
  return {
    _id: PARK_ID,
    slug: 'safe-park',
    campgrounds: [{
      _id: CAMPGROUND_ID,
      slug: 'north-loop',
      campsites: [{ _id: CAMPSITE_ID, slug: 'site-12' }],
    }],
    campsites: [],
  };
}

function getPath(record, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], record);
}

function setPath(record, dottedPath, value) {
  const parts = dottedPath.split('.');
  const final = parts.pop();
  let target = record;
  for (const part of parts) {
    target[part] ||= {};
    target = target[part];
  }
  target[final] = value;
}

function unsetPath(record, dottedPath) {
  const parts = dottedPath.split('.');
  const final = parts.pop();
  const target = parts.reduce((value, key) => value?.[key], record);
  if (target) delete target[final];
}

function applyUpdate(record, update) {
  for (const [key, value] of Object.entries(update.$set || {})) {
    setPath(record, key, value);
  }
  for (const [key, value] of Object.entries(update.$inc || {})) {
    setPath(record, key, (getPath(record, key) || 0) + value);
  }
  for (const key of Object.keys(update.$unset || {})) unsetPath(record, key);
}

function queryResult(records, calls, filter) {
  const call = { filter, projection: null, leanCalls: 0 };
  calls.push(call);
  return {
    select(projection) {
      call.projection = projection;
      return this;
    },
    async lean() {
      call.leanCalls += 1;
      return records;
    },
  };
}

function normalizeId(value) {
  return typeof value === 'string' ? value : value?.toHexString?.();
}

function idsFromFilter(filter) {
  return new Set((filter?._id?.$in || []).map(normalizeId));
}

function createHarness({
  result = resultData(),
  uploads = [upload()],
  noUploads = [],
  users = [account(USER_A)],
  parks = [park()],
  sendError = null,
  providerResult = { id: PROVIDER_ID },
  failFinalize = false,
  finalizeError = null,
  sendOverride = null,
} = {}) {
  const state = { result };
  const calls = {
    resultUpdates: [],
    resultFinds: [],
    uploads: [],
    noUploads: [],
    users: [],
    parks: [],
    sends: [],
  };

  const ResultModel = {
    async findOneAndUpdate(filter, update, options) {
      calls.resultUpdates.push({ filter, update, options });
      if (!state.result || state.result._id !== filter._id) return null;
      const notification = state.result.notification;
      if (filter.$or) {
        const stateName = notification?.state;
        const eligible = !notification || !stateName || stateName === 'pending' ||
          (stateName === 'sending' &&
            notification.leaseExpiresAt <=
              filter.$or.at(-1)['notification.leaseExpiresAt'].$lte);
        if (!eligible) return null;
      } else if (
        notification?.state !== filter['notification.state'] ||
        notification?.leaseTokenHash !==
          filter['notification.leaseTokenHash']
      ) {
        return null;
      }
      if (!filter.$or && update.$set?.['notification.state'] === 'sent' &&
        finalizeError) throw finalizeError;
      if (!filter.$or && update.$set?.['notification.state'] === 'sent' &&
        failFinalize) return null;
      applyUpdate(state.result, update);
      return state.result;
    },
    findOne(filter) {
      calls.resultFinds.push({ filter, projection: null, leanCalls: 0 });
      const call = calls.resultFinds.at(-1);
      return {
        select(projection) {
          call.projection = projection;
          return this;
        },
        async lean() {
          call.leanCalls += 1;
          return state.result?._id === filter._id ? state.result : null;
        },
      };
    },
  };
  const UploadModel = {
    find(filter) {
      const ids = idsFromFilter(filter);
      return queryResult(
        uploads.filter(item => ids.has(normalizeId(item._id))),
        calls.uploads,
        filter,
      );
    },
  };
  const NoUploadEntryModel = {
    find(filter) {
      return queryResult(noUploads.filter(item =>
        item.monthKey === filter.monthKey &&
        item.rulesVersion === filter.rulesVersion
      ), calls.noUploads, filter);
    },
  };
  const UserModel = {
    find(filter) {
      const ids = idsFromFilter(filter);
      return queryResult(users.filter(item => ids.has(normalizeId(item._id))),
        calls.users, filter);
    },
  };
  const ParkModel = {
    find(filter) {
      const ids = idsFromFilter(filter);
      return queryResult(parks.filter(item => ids.has(normalizeId(item._id))),
        calls.parks, filter);
    },
  };
  const service = createMonthlyDrawNotificationService({
    ResultModel,
    UploadModel,
    NoUploadEntryModel,
    UserModel,
    ParkModel,
    async send(options) {
      calls.sends.push(options);
      if (sendOverride) return sendOverride(options);
      if (sendError) throw sendError;
      return providerResult;
    },
    now: () => NOW,
    createLeaseToken: () => LEASE_TOKEN,
    publicSiteDomain: 'https://camppics.example.test',
    administratorEmail: 'admin@example.test',
  });
  return { calls, service, state };
}

describe('MonthlyDrawResult notification schema', () => {
  test('keeps legacy results valid and adds one optional unindexed subdocument', () => {
    const legacy = new MonthlyDrawResult(resultData());
    assert.equal(legacy.notification, undefined);
    assert.equal(legacy.validateSync(), undefined);
    assert.equal(
      MonthlyDrawResult.schema.path('notification').options.default,
      undefined,
    );
    assert.deepEqual(MonthlyDrawResult.schema.indexes(), []);
  });

  test('accepts pending, sending and sent state contracts', () => {
    const states = [
      { state: 'pending', attemptCount: 0 },
      {
        state: 'sending',
        attemptCount: 1,
        lastAttemptAt: NOW,
        leaseTokenHash: 'a'.repeat(64),
        leaseExpiresAt: new Date(NOW.valueOf() + 60_000),
      },
      {
        state: 'sent',
        attemptCount: 1,
        lastAttemptAt: NOW,
        sentAt: NOW,
        providerMessageId: PROVIDER_ID,
      },
    ];
    for (const notification of states) {
      assert.equal(
        new MonthlyDrawResult(resultData({ notification })).validateSync(),
        undefined,
        notification.state,
      );
    }
  });

  test('rejects invalid cross-state leases, attempt counts, sent times and provider IDs', () => {
    const invalid = [
      { state: 'pending', attemptCount: 0, leaseTokenHash: 'a'.repeat(64) },
      { state: 'pending', attemptCount: 0, sentAt: NOW },
      { state: 'sending', attemptCount: 0, lastAttemptAt: NOW,
        leaseTokenHash: 'a'.repeat(64), leaseExpiresAt: NOW },
      { state: 'sending', attemptCount: 1,
        leaseTokenHash: 'a'.repeat(64), leaseExpiresAt: NOW },
      { state: 'sending', attemptCount: 1, lastAttemptAt: NOW,
        leaseExpiresAt: NOW },
      { state: 'sending', attemptCount: 1, lastAttemptAt: NOW,
        leaseTokenHash: 'a'.repeat(64) },
      { state: 'sending', attemptCount: 1, lastAttemptAt: NOW,
        leaseTokenHash: 'A'.repeat(64), leaseExpiresAt: NOW },
      { state: 'sending', attemptCount: 1, lastAttemptAt: NOW,
        leaseTokenHash: 'a'.repeat(63), leaseExpiresAt: NOW },
      { state: 'sent', attemptCount: 1, lastAttemptAt: NOW },
      { state: 'sent', attemptCount: 1, sentAt: NOW },
      { state: 'sent', attemptCount: 1, lastAttemptAt: NOW, sentAt: NOW,
        leaseExpiresAt: NOW },
      { state: 'sent', attemptCount: 1, lastAttemptAt: NOW, sentAt: NOW,
        providerMessageId: '' },
      { state: 'sent', attemptCount: 1, lastAttemptAt: NOW, sentAt: NOW,
        providerMessageId: 'x'.repeat(513) },
    ];
    for (const notification of invalid) {
      assert.ok(
        new MonthlyDrawResult(resultData({ notification })).validateSync(),
        JSON.stringify(notification),
      );
    }
  });

  test('does not add contacts, template bodies or mutable selection fields', () => {
    const notificationPaths = Object.keys(
      MonthlyDrawResult.schema.path('notification').schema.paths,
    );
    assert.deepEqual(notificationPaths, [
      'state', 'attemptCount', 'lastAttemptAt', 'lastFailureAt',
      'leaseTokenHash', 'leaseExpiresAt', 'sentAt', 'providerMessageId',
    ]);
    assert.doesNotMatch(notificationPaths.join(' '),
      /email|nickname|contact|html|subject|template|userId|sourceId/iu);
    for (const field of [
      '_id', 'monthKey', 'rulesVersion', 'status', 'selectedAt',
      'candidates', 'poolSummary',
    ]) {
      assert.equal(MonthlyDrawResult.schema.path(field).options.immutable, true);
    }
    assert.notEqual(
      MonthlyDrawResult.schema.path('notification').options.immutable,
      true,
    );
  });
});

describe('stored candidate resolution and administrator delivery', () => {
  test('resolves upload and opaque no-upload candidates with one bounded query per model', async () => {
    const noUploadReference = buildMonthlyDrawNoUploadSourceReference(
      USER_B,
      MONTH,
    );
    const candidates = [
      candidate({ rank: 1, userId: USER_A, entryCount: 3 }),
      candidate({
        rank: 2,
        userId: USER_B,
        sourceType: 'no-upload',
        sourceId: noUploadReference,
      }),
      candidate({
        rank: 3,
        userId: USER_C,
        sourceId: UPLOAD_C.toHexString(),
        entryCount: 2,
      }),
    ];
    const harness = createHarness({
      result: resultData({
        candidates,
        poolSummary: {
          eligibleUploadEntries: 5,
          eligibleNoUploadEntries: 1,
          totalEligibleEntries: 6,
          eligibleDistinctEntrants: 3,
          excludedAccountEntries: 2,
          candidatesSelected: 3,
          pendingUploadsAtSelection: 0,
        },
      }),
      uploads: [
        upload(),
        upload({
          _id: UPLOAD_C,
          userId: USER_C,
          mediaType: 'video',
          campgroundId: null,
          campgroundName: null,
          campsiteId: null,
          campsiteName: null,
        }),
      ],
      noUploads: [noUploadEntry(USER_B)],
      users: [account(USER_A), account(USER_B), account(USER_C)],
    });

    const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });

    assert.equal(outcome.state, 'sent');
    assert.equal(outcome.candidateCount, 3);
    assert.equal(harness.calls.sends.length, 1);
    assert.equal(harness.calls.uploads.length, 1);
    assert.equal(harness.calls.noUploads.length, 1);
    assert.equal(harness.calls.users.length, 1);
    assert.equal(harness.calls.parks.length, 1);
    assert.deepEqual(harness.calls.uploads[0].projection,
      MONTHLY_DRAW_NOTIFICATION_UPLOAD_PROJECTION);
    assert.deepEqual(harness.calls.noUploads[0].projection,
      MONTHLY_DRAW_NOTIFICATION_NO_UPLOAD_PROJECTION);
    assert.deepEqual(harness.calls.users[0].projection,
      MONTHLY_DRAW_NOTIFICATION_USER_PROJECTION);
    assert.deepEqual(harness.calls.parks[0].projection,
      ADMIN_PARK_LOCATION_PROJECTION);
    assert.deepEqual(harness.calls.noUploads[0].filter, {
      monthKey: MONTH,
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    });

    const sent = harness.calls.sends[0];
    assert.equal(sent.to, 'admin@example.test');
    assert.equal(sent.template, 'monthly-draw-admin-notification');
    assert.equal(sent.subject, 'CampPics monthly draw selections — July 2026');
    assert.equal(Object.hasOwn(sent, 'userId'), false);
    assert.deepEqual(sent.templateData.candidates.map(item => item.rank),
      [1, 2, 3]);
    assert.deepEqual(sent.templateData.candidates.map(item => item.entryCount),
      [3, 1, 2]);
    assert.deepEqual(sent.templateData.candidates.map(item => item.sourceLabel),
      ['Photo upload', 'No-upload entry', 'Video upload']);
    assert.equal(
      sent.templateData.candidates[0].locationUrl,
      'https://camppics.example.test/camp/park/safe-park/campground/north-loop/campsite/site-12',
    );
    assert.equal(
      sent.templateData.candidates[2].locationUrl,
      'https://camppics.example.test/camp/park/safe-park',
    );
    assert.match(sent.templateData.candidates[1].userDetailUrl,
      /^https:\/\/camppics\.example\.test\/a\/users\/[a-f0-9]{24}$/u);
    const serialized = JSON.stringify(sent);
    for (const secret of [
      UPLOAD_A.toHexString(),
      UPLOAD_C.toHexString(),
      buildMonthlyDrawNoUploadEntryId(USER_B, MONTH),
      noUploadReference,
      ...candidates.map(item => item.entrantFingerprint),
    ]) assert.equal(serialized.includes(secret), false, secret);
  });

  test('uses campsite, campground and Park location fallback without external paths', async () => {
    const cases = [
      {
        name: 'campsite',
        upload: upload(),
        expected: '/camp/park/safe-park/campground/north-loop/campsite/site-12',
      },
      {
        name: 'campground',
        upload: upload({ campsiteId: null, campsiteName: null }),
        expected: '/camp/park/safe-park#north-loop',
      },
      {
        name: 'park',
        upload: upload({
          campgroundId: null,
          campgroundName: null,
          campsiteId: null,
          campsiteName: null,
        }),
        expected: '/camp/park/safe-park',
      },
    ];
    for (const fixture of cases) {
      const harness = createHarness({ uploads: [fixture.upload] });
      await harness.service.notifyStoredResult({ monthKey: MONTH });
      assert.equal(
        new URL(harness.calls.sends[0].templateData.candidates[0].locationUrl)
          .pathname + new URL(
            harness.calls.sends[0].templateData.candidates[0].locationUrl,
          ).hash,
        fixture.expected,
        fixture.name,
      );
    }

    const hostile = createHarness({
      parks: [{ ...park(), slug: 'https://evil.example/path' }],
    });
    await hostile.service.notifyStoredResult({ monthKey: MONTH });
    assert.equal(
      hostile.calls.sends[0].templateData.candidates[0].locationUrl,
      null,
    );
  });

  test('keeps eligible and legacy pending upload sources resolvable without redrawing', async () => {
    for (const status of ['eligible', 'pending']) {
      const storedCandidate = candidate();
      const harness = createHarness({
        result: resultData({
          candidates: [storedCandidate],
          poolSummary: {
            eligibleUploadEntries: 1,
            eligibleNoUploadEntries: 0,
            totalEligibleEntries: 1,
            eligibleDistinctEntrants: 1,
            excludedAccountEntries: 0,
            candidatesSelected: 1,
            pendingUploadsAtSelection: status === 'pending' ? 1 : 0,
          },
        }),
        uploads: [upload({ monthlyDraw: {
          status,
          monthKey: MONTH,
          rulesVersion: MONTHLY_DRAW_RULES_VERSION,
        } })],
      });

      await harness.service.notifyStoredResult({ monthKey: MONTH });

      const resolved = harness.calls.sends[0].templateData.candidates;
      assert.equal(resolved.length, 1, status);
      assert.equal(resolved[0].rank, storedCandidate.rank, status);
      assert.equal(resolved[0].available, true, status);
      assert.deepEqual(harness.state.result.candidates, [storedCandidate]);
    }
  });

  test('marks missing, ineligible and unverifiable sources unavailable without replacement', async () => {
    const cases = [
      {
        name: 'missing upload',
        uploads: [],
        expected: 'Source is no longer available',
      },
      {
        name: 'status mismatch',
        uploads: [upload({ monthlyDraw: {
          status: 'ineligible', monthKey: MONTH,
          rulesVersion: MONTHLY_DRAW_RULES_VERSION,
        } })],
        expected: 'Source is no longer eligible',
      },
      {
        name: 'month mismatch',
        uploads: [upload({ monthlyDraw: {
          status: 'eligible', monthKey: '2026-06',
          rulesVersion: MONTHLY_DRAW_RULES_VERSION,
        } })],
        expected: 'Source is no longer eligible',
      },
      {
        name: 'fingerprint mismatch',
        uploads: [upload({ userId: USER_B })],
        expected: 'Stored candidate identity could not be verified',
      },
    ];
    for (const fixture of cases) {
      const harness = createHarness({ uploads: fixture.uploads });
      await harness.service.notifyStoredResult({ monthKey: MONTH });
      const resolved = harness.calls.sends[0].templateData.candidates;
      assert.equal(resolved.length, 1, fixture.name);
      assert.equal(resolved[0].rank, 1, fixture.name);
      assert.equal(resolved[0].entryCount, 1, fixture.name);
      assert.equal(resolved[0].available, false, fixture.name);
      assert.equal(resolved[0].unavailableReasonLabel,
        fixture.expected, fixture.name);
    }
  });

  test('verifies deterministic no-upload IDs, opaque references and fingerprints', async () => {
    const stored = candidate({
      sourceType: 'no-upload',
      sourceId: buildMonthlyDrawNoUploadSourceReference(USER_B, MONTH),
      userId: USER_B,
    });
    const cases = [
      {
        name: 'valid',
        entries: [noUploadEntry(USER_B)],
        expectedAvailable: true,
      },
      {
        name: 'missing',
        entries: [],
        expectedAvailable: false,
        expectedReason: 'Source is no longer available',
      },
      {
        name: 'invalid real id',
        entries: [noUploadEntry(USER_B, { _id: 'forged-entry-id' })],
        expectedAvailable: false,
        expectedReason: 'Source is no longer available',
      },
      {
        name: 'fingerprint mismatch',
        entries: [noUploadEntry(USER_B)],
        candidate: { ...stored, entrantFingerprint:
          buildMonthlyDrawEntrantFingerprint(USER_A, MONTH) },
        expectedAvailable: false,
        expectedReason: 'Stored candidate identity could not be verified',
      },
    ];
    for (const fixture of cases) {
      const selected = fixture.candidate || stored;
      const harness = createHarness({
        result: resultData({
          candidates: [selected],
          poolSummary: {
            eligibleUploadEntries: 0,
            eligibleNoUploadEntries: 1,
            totalEligibleEntries: 1,
            eligibleDistinctEntrants: 1,
            excludedAccountEntries: 0,
            candidatesSelected: 1,
            pendingUploadsAtSelection: 0,
          },
        }),
        uploads: [],
        noUploads: fixture.entries,
        users: [account(USER_B)],
        parks: [],
      });
      await harness.service.notifyStoredResult({ monthKey: MONTH });
      const resolved = harness.calls.sends[0].templateData.candidates[0];
      assert.equal(resolved.available, fixture.expectedAvailable, fixture.name);
      assert.equal(resolved.unavailableReasonLabel,
        fixture.expectedReason || null, fixture.name);
    }
  });

  test('rechecks current account existence, verification, administrator and blocked state', async () => {
    const cases = [
      ['missing', [], 'Account is no longer available'],
      ['unverified', [account(USER_A, { email_verified: false })],
        'Account is no longer eligible'],
      ['administrator', [account(USER_A, { isAdmin: true })],
        'Account is no longer eligible'],
      ['blocked', [account(USER_A, { blocked: true })],
        'Account is no longer eligible'],
    ];
    for (const [name, users, reason] of cases) {
      const harness = createHarness({ users });
      await harness.service.notifyStoredResult({ monthKey: MONTH });
      const resolved = harness.calls.sends[0].templateData.candidates[0];
      assert.equal(resolved.available, false, name);
      assert.equal(resolved.unavailableReasonLabel, reason, name);
      assert.equal(resolved.email, null, name);
      assert.equal(resolved.userDetailUrl, null, name);
    }
  });

  test('sends a no-eligible-entries summary without source queries', async () => {
    const harness = createHarness({
      result: resultData({
        status: 'no-eligible-entries',
        candidates: [],
        poolSummary: {
          eligibleUploadEntries: 0,
          eligibleNoUploadEntries: 0,
          totalEligibleEntries: 0,
          eligibleDistinctEntrants: 0,
          excludedAccountEntries: 2,
          candidatesSelected: 0,
          pendingUploadsAtSelection: 0,
        },
      }),
      uploads: [], noUploads: [], users: [], parks: [],
    });
    const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
    assert.equal(outcome.state, 'sent');
    assert.equal(harness.calls.sends.length, 1);
    assert.equal(harness.calls.sends[0].templateData.noEligibleEntries, true);
    assert.deepEqual(harness.calls.sends[0].templateData.candidates, []);
    assert.deepEqual([
      harness.calls.uploads.length,
      harness.calls.noUploads.length,
      harness.calls.users.length,
      harness.calls.parks.length,
    ], [0, 0, 0, 0]);
  });
});

describe('notification lease and retry behavior', () => {
  test('claims with one hashed 30-minute lease, sends once and finalizes sent', async () => {
    const harness = createHarness();
    const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
    assert.equal(outcome.state, 'sent');
    assert.equal(outcome.notificationState, 'sent');
    assert.equal(outcome.attemptCount, 1);
    assert.equal(harness.calls.sends.length, 1);
    assert.equal(harness.calls.resultUpdates.length, 2);
    const claim = harness.calls.resultUpdates[0];
    const hash = claim.update.$set['notification.leaseTokenHash'];
    assert.match(hash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(claim).includes(LEASE_TOKEN.toString('hex')), false);
    assert.equal(
      claim.update.$set['notification.leaseExpiresAt'].valueOf() - NOW.valueOf(),
      MONTHLY_DRAW_NOTIFICATION_LEASE_MS,
    );
    const finalize = harness.calls.resultUpdates[1];
    assert.equal(finalize.filter['notification.leaseTokenHash'], hash);
    assert.equal(harness.state.result.notification.state, 'sent');
    assert.equal(harness.state.result.notification.providerMessageId, PROVIDER_ID);
    assert.equal(harness.state.result.notification.leaseTokenHash, undefined);
    assert.equal(harness.state.result.notification.leaseExpiresAt, undefined);
  });

  test('active lease and already-sent result do not resolve sources or send', async () => {
    const cases = [
      ['lease-active', {
        state: 'sending', attemptCount: 1, lastAttemptAt: NOW,
        leaseTokenHash: 'a'.repeat(64),
        leaseExpiresAt: new Date(NOW.valueOf() + 60_000), sentAt: null,
      }],
      ['already-sent', {
        state: 'sent', attemptCount: 1, lastAttemptAt: NOW,
        sentAt: NOW,
      }],
    ];
    for (const [expectedState, notification] of cases) {
      const harness = createHarness({ result: resultData({ notification }) });
      const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
      assert.equal(outcome.state, expectedState);
      assert.equal(harness.calls.sends.length, 0);
      assert.deepEqual([
        harness.calls.uploads.length,
        harness.calls.noUploads.length,
        harness.calls.users.length,
        harness.calls.parks.length,
      ], [0, 0, 0, 0]);
    }
  });

  test('concurrent callers share one claim and one successful delivery', async () => {
    let releaseProvider;
    const providerGate = new Promise(resolve => {
      releaseProvider = resolve;
    });
    const harness = createHarness({
      async sendOverride() {
        await providerGate;
        return { id: PROVIDER_ID };
      },
    });
    const first = harness.service.notifyStoredResult({ monthKey: MONTH });
    await new Promise(resolve => setImmediate(resolve));
    const second = await harness.service.notifyStoredResult({ monthKey: MONTH });
    assert.equal(second.state, 'lease-active');
    assert.equal(harness.calls.sends.length, 1);
    releaseProvider();
    assert.equal((await first).state, 'sent');
    assert.equal(harness.calls.sends.length, 1);
  });

  test('an expired lease is reclaimed and increments the preserved attempt count', async () => {
    const harness = createHarness({
      result: resultData({ notification: {
        state: 'sending', attemptCount: 2,
        lastAttemptAt: new Date(NOW.valueOf() - 60 * 60 * 1000),
        leaseTokenHash: 'b'.repeat(64),
        leaseExpiresAt: new Date(NOW.valueOf() - 1),
        sentAt: null,
      } }),
    });
    const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
    assert.equal(outcome.state, 'sent');
    assert.equal(outcome.attemptCount, 3);
    assert.equal(harness.calls.sends.length, 1);
  });

  test('definite provider failure releases only the matching lease for retry', async () => {
    const providerError = new Error('raw provider failure');
    const harness = createHarness({ sendError: providerError });
    await assert.rejects(
      () => harness.service.notifyStoredResult({ monthKey: MONTH }),
      error => error === providerError,
    );
    assert.equal(harness.calls.resultUpdates.length, 2);
    const claimHash = harness.calls.resultUpdates[0]
      .update.$set['notification.leaseTokenHash'];
    const release = harness.calls.resultUpdates[1];
    assert.equal(release.filter['notification.leaseTokenHash'], claimHash);
    assert.equal(harness.state.result.notification.state, 'pending');
    assert.equal(harness.state.result.notification.attemptCount, 1);
    assert.equal(harness.state.result.notification.lastAttemptAt, NOW);
    assert.equal(harness.state.result.notification.lastFailureAt, NOW);
    assert.equal(harness.state.result.notification.leaseTokenHash, undefined);
    assert.equal(harness.state.result.notification.leaseExpiresAt, undefined);
    assert.equal(JSON.stringify(harness.state.result).includes(providerError.message),
      false);
  });

  test('finalization failure after provider success leaves the active lease and never releases', async () => {
    const harness = createHarness({ failFinalize: true });
    await assert.rejects(
      () => harness.service.notifyStoredResult({ monthKey: MONTH }),
      /Monthly draw notification finalization failed\./u,
    );
    assert.equal(harness.calls.sends.length, 1);
    assert.equal(harness.calls.resultUpdates.length, 2);
    assert.equal(harness.state.result.notification.state, 'sending');
    assert.match(harness.state.result.notification.leaseTokenHash,
      /^[a-f0-9]{64}$/u);
    assert.ok(harness.state.result.notification.leaseExpiresAt > NOW);
    assert.equal(harness.state.result.notification.lastFailureAt, undefined);
  });

  test('finalization database errors are replaced with the fixed failure and keep the lease', async () => {
    const rawFailure = new Error('raw database and provider detail');
    const harness = createHarness({ finalizeError: rawFailure });
    await assert.rejects(
      () => harness.service.notifyStoredResult({ monthKey: MONTH }),
      error => error.message ===
        'Monthly draw notification finalization failed.' &&
        !error.message.includes(rawFailure.message),
    );
    assert.equal(harness.calls.sends.length, 1);
    assert.equal(harness.calls.resultUpdates.length, 2);
    assert.equal(harness.state.result.notification.state, 'sending');
    assert.match(harness.state.result.notification.leaseTokenHash,
      /^[a-f0-9]{64}$/u);
    assert.equal(harness.state.result.notification.lastFailureAt, undefined);
  });

  test('invalid provider IDs are omitted while a resolved sender still counts as success', async () => {
    for (const providerResult of [
      {}, { id: '' }, { id: 42 }, { id: 'x'.repeat(513) },
    ]) {
      const harness = createHarness({ providerResult });
      const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
      assert.equal(outcome.state, 'sent');
      assert.equal(
        Object.hasOwn(harness.state.result.notification, 'providerMessageId'),
        false,
      );
    }
  });

  test('existing email boundary persists only allowlisted metadata and tolerates metadata failure', async () => {
    const { createEmailSender } = await import('../utils/sendEmail.js');
    for (const failMetadata of [false, true]) {
      const metadata = [];
      const providerCalls = [];
      const logCalls = [];
      class EmailModel {
        constructor(value) {
          metadata.push(value);
        }

        async save() {
          if (failMetadata) throw new Error('fixture metadata failure');
        }
      }
      const boundary = createEmailSender({
        async renderTemplate(_templatePath, templateData) {
          return JSON.stringify(templateData);
        },
        mailClient: {
          messages: {
            async create(...args) {
              providerCalls.push(args);
              return { id: PROVIDER_ID };
            },
          },
        },
        EmailModel,
        async log(...args) { logCalls.push(args); },
        now: () => NOW,
        domain: 'mail.example.test',
        defaultFrom: 'no-reply@example.test',
      });
      const harness = createHarness({ sendOverride: boundary });
      const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
      assert.equal(outcome.state, 'sent');
      assert.equal(providerCalls.length, 1);
      assert.deepEqual(metadata, [{
        to: 'admin@example.test',
        template: 'monthly-draw-admin-notification',
        messageId: PROVIDER_ID,
        sentAt: NOW,
      }]);
      assert.deepEqual(Object.keys(metadata[0]),
        ['to', 'template', 'messageId', 'sentAt']);
      assert.equal(Object.hasOwn(metadata[0], 'userId'), false);
      assert.equal(Object.hasOwn(metadata[0], 'html'), false);
      assert.equal(Object.hasOwn(metadata[0], 'subject'), false);
      assert.equal(logCalls.length, failMetadata ? 1 : 0);
    }
  });

  test('missing result returns safely without selection, sources or delivery', async () => {
    const harness = createHarness({ result: null });
    const outcome = await harness.service.notifyStoredResult({ monthKey: MONTH });
    assert.equal(outcome.state, 'missing-result');
    assert.equal(outcome.candidateCount, 0);
    assert.equal(harness.calls.sends.length, 0);
    assert.equal(harness.calls.resultUpdates.length, 1);
    assert.equal(harness.calls.resultFinds.length, 1);
  });

  test('inspection is read-only and returns only safe notification fields', async () => {
    const harness = createHarness({
      result: resultData({ notification: {
        state: 'sending', attemptCount: 2, lastAttemptAt: NOW,
        leaseTokenHash: 'c'.repeat(64),
        leaseExpiresAt: new Date(NOW.valueOf() + 1000), sentAt: null,
      } }),
    });
    const inspection = await harness.service.inspectNotification({ monthKey: MONTH });
    assert.deepEqual(Object.keys(inspection), [
      'monthKey', 'resultExists', 'resultStatus', 'candidateCount',
      'notificationState', 'attemptCount', 'sentAt', 'leaseActive',
    ]);
    assert.equal(inspection.leaseActive, true);
    assert.equal(harness.calls.resultUpdates.length, 0);
    assert.equal(harness.calls.sends.length, 0);
    assert.doesNotMatch(JSON.stringify(inspection),
      /sourceId|fingerprint|email|leaseTokenHash|userId/iu);
  });
});

describe('administrator email template', () => {
  test('escapes hostile values, omits identifiers and includes the complete workflow', async () => {
    const hostile = '</p><script id="monthly-draw-xss">attack()</script>';
    const hidden = {
      sourceId: 'monthly-draw-no-upload-ref:2026-07:hidden-reference',
      entrantFingerprint: 'hidden-fingerprint',
      userId: '111111111111111111111111',
      uploadId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const html = await ejs.renderFile(
      path.join(root, 'views/emails/monthly-draw-admin-notification.ejs'),
      {
        drawMonth: hostile,
        selectedAt: hostile,
        resultStatus: hostile,
        poolSummary: {
          eligibleUploadEntries: 2,
          eligibleNoUploadEntries: 1,
          totalEligibleEntries: 3,
          eligibleDistinctEntrants: 2,
          excludedAccountEntries: 1,
        },
        noEligibleEntries: false,
        candidates: [
          {
            rank: 1, rankLabel: 'Primary selected entrant', available: true,
            unavailableReasonLabel: null, sourceLabel: 'Photo upload',
            entryCount: 2, nickname: hostile, email: hostile,
            mediaType: 'photo', uploadedAt: hostile, parkName: hostile,
            campgroundName: hostile, campsiteName: hostile,
            locationUrl: `https://camppics.example.test/${encodeURIComponent(hostile)}`,
            userDetailUrl: 'https://camppics.example.test/a/users/safe',
            ...hidden,
          },
          {
            rank: 2, rankLabel: 'First alternate', available: true,
            unavailableReasonLabel: null, sourceLabel: 'No-upload entry',
            entryCount: 1, nickname: 'Alternate', email: 'alt@example.test',
            mediaType: null, uploadedAt: null, parkName: null,
            campgroundName: null, campsiteName: null, locationUrl: null,
            userDetailUrl: 'https://camppics.example.test/a/users/safe-two',
          },
          {
            rank: 3, rankLabel: 'Second alternate', available: false,
            unavailableReasonLabel: 'Source is no longer available',
            sourceLabel: null, entryCount: 1, nickname: null, email: null,
            mediaType: null, uploadedAt: null, parkName: null,
            campgroundName: null, campsiteName: null, locationUrl: null,
            userDetailUrl: null,
          },
        ],
      },
    );
    assert.doesNotMatch(html, /<script id="monthly-draw-xss">/u);
    assert.match(html, /&lt;\/p&gt;&lt;script id=&#34;monthly-draw-xss&#34;&gt;/u);
    for (const value of Object.values(hidden)) {
      assert.equal(html.includes(value), false, value);
    }
    assert.match(html, /Photo upload/u);
    assert.match(html, /No-upload entry/u);
    assert.match(html, /Source is no longer available/u);
    assert.match(html, /must not redraw or replace/u);
    for (const phrase of [
      'one prize', 'seven calendar days', 'Canadian residency',
      'age of majority', 'mathematical skill-testing question',
      'preferred gift card', 'consent before publishing',
      'does not automatically contact entrants or deliver a prize',
    ]) assert.match(html, new RegExp(phrase, 'iu'), phrase);
  });

  test('renders the explicit no-eligible-entries result', async () => {
    const html = await ejs.renderFile(
      path.join(root, 'views/emails/monthly-draw-admin-notification.ejs'),
      {
        drawMonth: 'July 2026', selectedAt: 'August 1, 2026',
        resultStatus: 'no-eligible-entries', noEligibleEntries: true,
        candidates: [],
        poolSummary: {
          eligibleUploadEntries: 0, eligibleNoUploadEntries: 0,
          totalEligibleEntries: 0, eligibleDistinctEntrants: 0,
          excludedAccountEntries: 0,
        },
      },
    );
    assert.match(html, /No eligible entries existed for this draw month\./u);
  });

  test('uses no unescaped candidate or summary output', async () => {
    const source = await readFile(
      path.join(root, 'views/emails/monthly-draw-admin-notification.ejs'),
      'utf8',
    );
    assert.deepEqual(
      [...source.matchAll(/<%-\s*([^%]+)%>/gu)].map(match => match[1].trim()),
      ["include('./partials/signature')"],
    );
    assert.doesNotMatch(source, /sourceId|entrantFingerprint|userId|uploadId/iu);
  });
});

function cliRuntimeConfig() {
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

describe('manual monthly draw notification command', () => {
  test('defaults to dry-run and previous Eastern month', () => {
    assert.deepEqual(parseMonthlyDrawNotificationArguments([], NOW), {
      mode: 'dry-run', monthKey: MONTH,
    });
    assert.deepEqual(parseMonthlyDrawNotificationArguments(
      ['--apply', '--month', MONTH], NOW,
    ), { mode: 'apply', monthKey: MONTH });
  });

  test('rejects conflicts, repeats, unknown values, IDs and malformed months', () => {
    for (const args of [
      ['--apply', '--dry-run'], ['--apply', '--apply'],
      ['--dry-run', '--dry-run'], ['--month'],
      ['--month', MONTH, '--month', MONTH], ['--month=2026-07'],
      ['--month', '2026-7'], ['--unknown'], [USER_A.toHexString()],
      ['--email', 'admin@example.test'],
    ]) {
      assert.throws(
        () => parseMonthlyDrawNotificationArguments(args, NOW),
        error => error instanceof MonthlyDrawNotificationArgumentError &&
          error.exitCode === MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.invalidArguments,
      );
    }
  });

  test('rejects current and future apply months while allowing historical dry runs', () => {
    for (const month of ['2026-08', '2026-09', '9999-12']) {
      assert.throws(
        () => parseMonthlyDrawNotificationArguments(
          ['--apply', '--month', month], NOW,
        ),
        error => error.exitCode ===
          MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.invalidApplyMonth,
      );
    }
    assert.equal(parseMonthlyDrawNotificationArguments(
      ['--month', '9999-12'], NOW,
    ).mode, 'dry-run');
  });

  test('dry-run only inspects and never initializes email, claims or sends', async () => {
    const calls = { connect: 0, disconnect: 0, inspect: 0, notify: 0,
      initializeEmail: 0, createService: 0 };
    const lines = [];
    const report = await runMonthlyDrawNotificationCli(
      ['--month', MONTH],
      {
        runtimeConfig: cliRuntimeConfig(),
        connect: async (_url, options) => {
          calls.connect += 1;
          assert.deepEqual(options, { autoIndex: false });
        },
        disconnect: async () => { calls.disconnect += 1; },
        initializeEmailSender: async () => { calls.initializeEmail += 1; },
        async createNotificationService(options) {
          calls.createService += 1;
          assert.equal(options.send, undefined);
          return {
            async inspectNotification({ monthKey }) {
              calls.inspect += 1;
              return {
                monthKey, resultExists: true, resultStatus: 'selected',
                candidateCount: 2, notificationState: 'pending',
                attemptCount: 0, sentAt: null, leaseActive: false,
              };
            },
            async notifyStoredResult() { calls.notify += 1; },
          };
        },
        currentTime: () => NOW,
        output: { log: line => lines.push(line) },
      },
    );
    assert.deepEqual(calls, { connect: 1, disconnect: 1, inspect: 1,
      notify: 0, initializeEmail: 0, createService: 1 });
    assert.equal(report.mode, 'dry-run');
    assert.doesNotMatch(lines.join('\n'),
      /email|sourceId|fingerprint|nickname|location|mongodb:\/\//iu);
  });

  test('dry-run missing result remains inspection-only and exits nonzero', async () => {
    const exits = [];
    const report = await runMonthlyDrawNotificationCli(
      ['--month', MONTH],
      {
        service: {
          async inspectNotification({ monthKey }) {
            return {
              monthKey, resultExists: false, resultStatus: null,
              candidateCount: 0, notificationState: 'pending',
              attemptCount: 0, sentAt: null, leaseActive: false,
            };
          },
        },
        runtimeConfig: cliRuntimeConfig(),
        connect: async () => {}, disconnect: async () => {},
        currentTime: () => NOW, output: { log() {} },
        setExitCode: value => exits.push(value),
      },
    );
    assert.equal(report.resultExists, false);
    assert.deepEqual(exits,
      [MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.missingResult]);
  });

  test('apply initializes an injected sender and invokes notify exactly once', async () => {
    const calls = { initialize: 0, create: 0, notify: 0 };
    const lines = [];
    const report = await runMonthlyDrawNotificationCli(
      ['--apply', '--month', MONTH],
      {
        runtimeConfig: cliRuntimeConfig(),
        connect: async () => {}, disconnect: async () => {},
        async initializeEmailSender() {
          calls.initialize += 1;
          return async () => ({ id: PROVIDER_ID });
        },
        async createNotificationService(options) {
          calls.create += 1;
          assert.equal(typeof options.send, 'function');
          return {
            async notifyStoredResult({ monthKey }) {
              calls.notify += 1;
              return {
                state: 'sent', monthKey, resultStatus: 'selected',
                candidateCount: 2, notificationState: 'sent',
                attemptCount: 1, sentAt: NOW,
              };
            },
          };
        },
        currentTime: () => NOW,
        output: { log: line => lines.push(line) },
      },
    );
    assert.deepEqual(calls, { initialize: 1, create: 1, notify: 1 });
    assert.equal(report.state, 'sent');
    assert.doesNotMatch(lines.join('\n'),
      /admin@example|sourceId|fingerprint|nickname|location|provider/iu);
  });

  test('already sent and active lease are successful while missing result exits nonzero', async () => {
    for (const state of ['already-sent', 'lease-active', 'missing-result']) {
      const exits = [];
      const report = await runMonthlyDrawNotificationCli(
        ['--apply', '--month', MONTH],
        {
          service: {
            async notifyStoredResult({ monthKey }) {
              return {
                state, monthKey, resultStatus: state === 'missing-result'
                  ? null : 'selected',
                candidateCount: state === 'missing-result' ? 0 : 1,
                notificationState: state === 'already-sent'
                  ? 'sent' : state === 'lease-active' ? 'sending' : 'pending',
                attemptCount: state === 'missing-result' ? 0 : 1,
                sentAt: state === 'already-sent' ? NOW : null,
              };
            },
          },
          runtimeConfig: cliRuntimeConfig(),
          connect: async () => {}, disconnect: async () => {},
          currentTime: () => NOW, output: { log() {} },
          setExitCode: value => exits.push(value),
        },
      );
      assert.equal(report.state, state);
      assert.deepEqual(exits, state === 'missing-result'
        ? [MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.missingResult]
        : []);
    }
  });

  test('direct operational failures use one fixed identity-free message', () => {
    const messages = [];
    const exits = [];
    handleMonthlyDrawNotificationDirectFailure(
      new Error('raw provider and candidate email detail'),
      {
        output: { error: value => messages.push(value) },
        setExitCode: value => exits.push(value),
      },
    );
    assert.deepEqual(exits, [MONTHLY_DRAW_NOTIFICATION_EXIT_CODES.operationalFailure]);
    assert.deepEqual(messages, ['Monthly draw notification failed.']);
  });
});
