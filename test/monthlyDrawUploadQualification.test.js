import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import ejs from 'ejs';
import mongoose from 'mongoose';

import {
  ADMIN_MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE,
  ADMIN_MONTHLY_DRAW_NOT_FOUND_MESSAGE,
  ADMIN_MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
  ADMIN_MONTHLY_DRAW_PAGE_SIZE,
  ADMIN_MONTHLY_DRAW_ELIGIBILITY_PROJECTION,
  ADMIN_MONTHLY_DRAW_UPLOAD_PROJECTION,
  ADMIN_MONTHLY_DRAW_USER_PROJECTION,
  buildMonthlyDrawReviewUrl,
  createMonthlyDrawUploadReviewHandler,
  createMonthlyDrawUploadStatusHandler,
  normalizeMonthlyDrawReviewQuery,
  serializeMonthlyDrawReviewUpload,
} from '../controllers/monthlyDrawAdmin.js';
import { Upload } from '../models/upload.js';
import adminRouter from '../routes/admin.js';
import { isAdmin } from '../middleware.js';
import {
  MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS,
  MONTHLY_DRAW_INELIGIBILITY_REASONS,
  MONTHLY_DRAW_RULES_VERSION,
  MONTHLY_DRAW_UPLOAD_STATUSES,
  isMonthlyDrawEntrantAccountEligible,
} from '../utils/monthlyDraw.js';
import { createMediaPersistenceService } from '../utils/mediaPersistence.js';
import { PUBLIC_MEDIA_KEYS } from '../utils/publicMediaSerializer.js';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';
import { extractYouTubeVideoId } from '../utils/youtube.js';

const root = process.cwd();
const NOW = new Date('2026-08-03T16:00:00.000Z');
const USER_ID = new mongoose.Types.ObjectId('0123456789abcdef01234567');
const ADMIN_ID = new mongoose.Types.ObjectId('fedcba987654321001234567');
const PARK_ID = new mongoose.Types.ObjectId('111111111111111111111111');
const CAMPSITE_ID = new mongoose.Types.ObjectId('222222222222222222222222');

const read = relativePath => readFile(path.join(root, relativePath), 'utf8');

function uploadBase() {
  return {
    parkId: PARK_ID,
    userId: USER_ID,
  };
}

function pending(overrides = {}) {
  return {
    status: 'pending',
    monthKey: '2026-08',
    rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    reviewedAt: null,
    reviewedBy: null,
    ineligibilityReason: null,
    ...overrides,
  };
}

function reviewed(status, overrides = {}) {
  return {
    ...pending(),
    status,
    reviewedAt: NOW,
    reviewedBy: ADMIN_ID,
    ...overrides,
  };
}

function routeFor(routePath) {
  return adminRouter.stack.find(layer => layer.route?.path === routePath)?.route;
}

function handlersFor(route, method) {
  return route.stack
    .filter(layer => layer.method === method)
    .map(layer => layer.handle);
}

function chainResult(value) {
  const chain = {
    select() { return chain; },
    lean: async () => value,
  };
  return chain;
}

function flashRecorder() {
  const calls = [];
  return {
    calls,
    redirectWithFlash(...args) {
      calls.push(args.slice(2));
      return calls.length;
    },
  };
}

describe('additive Upload monthly draw qualification schema', () => {
  test('legacy records remain valid and keep approved semantics unchanged', () => {
    const legacy = new Upload(uploadBase());
    assert.equal(legacy.monthlyDraw, undefined);
    assert.equal(legacy.approved, false);
    assert.equal(legacy.validateSync(), undefined);
    assert.equal(Upload.schema.path('approved').options.default, false);
  });

  test('declares the exact optional nested fields without a note or custom index', async () => {
    assert.equal(Upload.schema.path('monthlyDraw').options.default, undefined);
    assert.deepEqual(MONTHLY_DRAW_UPLOAD_STATUSES, [
      'pending', 'eligible', 'ineligible',
    ]);
    assert.deepEqual(MONTHLY_DRAW_INELIGIBILITY_REASONS, [
      'duplicate',
      'wrong-location',
      'not-useful',
      'insufficient-quality',
      'rights-or-policy',
      'account-ineligible',
      'other-ineligible',
    ]);
    assert.equal(Upload.schema.path('monthlyDraw.note'), undefined);
    assert.deepEqual(Upload.schema.indexes(), []);
    assert.doesNotMatch(
      await read('models/upload.js'),
      /\.index\s*\(|autoIndex|syncIndexes|ensureIndexes|createIndex/iu,
    );
  });

  test('accepts the three exact state contracts', () => {
    for (const monthlyDraw of [
      pending(),
      reviewed('eligible'),
      reviewed('ineligible', { ineligibilityReason: 'duplicate' }),
    ]) {
      assert.equal(
        new Upload({ ...uploadBase(), monthlyDraw }).validateSync(),
        undefined,
        monthlyDraw.status,
      );
    }
  });

  test('rejects malformed months, old rules and pending review metadata', () => {
    for (const monthlyDraw of [
      pending({ monthKey: '2026-8' }),
      pending({ monthKey: '2026-13' }),
      pending({ rulesVersion: 'old-rules' }),
      pending({ reviewedAt: NOW }),
      pending({ reviewedBy: ADMIN_ID }),
      pending({ ineligibilityReason: 'duplicate' }),
    ]) {
      assert.ok(new Upload({ ...uploadBase(), monthlyDraw }).validateSync());
    }
  });

  test('requires reviewer/date for eligible and forbids its reason', () => {
    for (const monthlyDraw of [
      reviewed('eligible', { reviewedAt: null }),
      reviewed('eligible', { reviewedBy: null }),
      reviewed('eligible', { ineligibilityReason: 'duplicate' }),
    ]) {
      assert.ok(new Upload({ ...uploadBase(), monthlyDraw }).validateSync());
    }
  });

  test('requires one fixed reason, reviewer and date for ineligible', () => {
    for (const monthlyDraw of [
      reviewed('ineligible', { reviewedAt: null, ineligibilityReason: 'duplicate' }),
      reviewed('ineligible', { reviewedBy: null, ineligibilityReason: 'duplicate' }),
      reviewed('ineligible', { ineligibilityReason: null }),
      reviewed('ineligible', { ineligibilityReason: 'free text' }),
    ]) {
      assert.ok(new Upload({ ...uploadBase(), monthlyDraw }).validateSync());
    }
  });

  test('month and rules paths are immutable and exact', () => {
    assert.equal(
      Upload.schema.path('monthlyDraw.monthKey').options.immutable,
      true,
    );
    assert.equal(
      Upload.schema.path('monthlyDraw.rulesVersion').options.immutable,
      true,
    );
    assert.deepEqual(
      Upload.schema.path('monthlyDraw.rulesVersion').options.enum,
      [MONTHLY_DRAW_RULES_VERSION],
    );
    for (const pathName of [
      '_id',
      'userId',
      'createdAt',
      'mediaId',
      'parkId',
      'monthlyDraw.status',
      'monthlyDraw.monthKey',
      'monthlyDraw.rulesVersion',
    ]) {
      assert.ok(Upload.schema.path(pathName), pathName);
    }
  });
});

describe('monthly draw account eligibility', () => {
  test('uses only the exact known account conditions', () => {
    const account = {
      _id: USER_ID,
      email_verified: true,
      isAdmin: false,
      blocked: false,
    };
    assert.equal(isMonthlyDrawEntrantAccountEligible(account), true);
    assert.equal(isMonthlyDrawEntrantAccountEligible({ ...account, _id: null }), false);
    assert.equal(isMonthlyDrawEntrantAccountEligible({ ...account, email_verified: false }), false);
    assert.equal(isMonthlyDrawEntrantAccountEligible({ ...account, isAdmin: true }), false);
    assert.equal(isMonthlyDrawEntrantAccountEligible({ ...account, blocked: true }), false);
    for (const prohibited of ['age', 'province', 'household', 'phone', 'address']) {
      assert.equal(Object.hasOwn(account, prohibited), false);
    }
  });
});

function createMediaHarness({ account, failCommit = false } = {}) {
  const state = { uploads: [] };
  let attemptUploads = [];
  const session = { id: 'monthly-draw-media-session' };
  const park = {
    _id: PARK_ID,
    name: 'Qualification Park',
    slug: 'qualification-park',
    photos: [],
    videos: [],
    campsites: [{
      _id: CAMPSITE_ID,
      siteNumber: '12',
      slug: '12',
      photos: [],
      videos: [],
    }],
    campgrounds: [],
    async save(options) {
      assert.equal(options.session, session);
      return park;
    },
  };
  const service = createMediaPersistenceService({
    ParkModel: { async findOne() { return park; } },
    UploadModel: {
      async insertMany(records, options) {
        assert.equal(options.session, session);
        attemptUploads.push(...records.map(record => ({ ...record })));
        return records;
      },
    },
    UserModel: {
      async updateOne(filter, update, options) {
        assert.equal(options.session, session);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    campsiteResolver(currentPark) {
      return {
        target: currentPark.campsites[0],
        campsite: currentPark.campsites[0],
        campground: null,
        campsiteSlug: '12',
        campgroundSlug: null,
      };
    },
    transactionRunner: async work => {
      attemptUploads = [];
      const result = await work(session);
      if (failCommit) throw new Error('injected transaction failure');
      state.uploads = attemptUploads;
      return result;
    },
    currentTime: () => NOW,
  });
  return { account, service, state };
}

function preparedMedia(mediaType) {
  return [{
    mediaId: new mongoose.Types.ObjectId(),
    uploadId: new mongoose.Types.ObjectId(),
    caption: 'Hostile-safe caption',
    showUsername: false,
    username: null,
    dateTaken: NOW,
    ...(mediaType === 'photo'
      ? {
        cloudinaryUrl: 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
        cloudinaryPublicId: 'photo',
      }
      : { youtubeUrl: 'https://youtu.be/AAAAAAAAAAA' }),
    monthlyDraw: {
      status: 'eligible',
      monthKey: '1999-01',
      reviewedBy: ADMIN_ID,
      ineligibilityReason: 'duplicate',
    },
  }];
}

async function commitMedia(harness, mediaType, campsite) {
  return harness.service.commitMediaCreation({
    parkSlug: 'qualification-park',
    locationInput: campsite ? { campsiteSlug: '12' } : {},
    userId: USER_ID,
    entrantAccount: harness.account,
    mediaType,
    preparedMedia: preparedMedia(mediaType),
  });
}

describe('transactional prospective upload creation', () => {
  const eligibleAccount = {
    _id: USER_ID,
    email_verified: true,
    isAdmin: false,
    blocked: false,
  };

  for (const [label, mediaType, campsite] of [
    ['park photo', 'photo', false],
    ['campsite photo', 'photo', true],
    ['park video', 'video', false],
    ['campsite video', 'video', true],
  ]) {
    test(`${label} creates exactly one server-authored pending entry`, async () => {
      const harness = createMediaHarness({ account: eligibleAccount });
      await commitMedia(harness, mediaType, campsite);
      assert.equal(harness.state.uploads.length, 1);
      assert.deepEqual(harness.state.uploads[0].monthlyDraw, pending());
    });
  }

  for (const [label, account] of [
    ['administrator', { ...eligibleAccount, isAdmin: true }],
    ['blocked account', { ...eligibleAccount, blocked: true }],
    ['unverified account', { ...eligibleAccount, email_verified: false }],
  ]) {
    test(`${label} receives no draw subdocument`, async () => {
      const harness = createMediaHarness({ account });
      await commitMedia(harness, 'photo', false);
      assert.equal(harness.state.uploads.length, 1);
      assert.equal(harness.state.uploads[0].monthlyDraw, undefined);
    });
  }

  test('failed transaction commits no Upload or qualification metadata', async () => {
    const harness = createMediaHarness({
      account: eligibleAccount,
      failCommit: true,
    });
    await assert.rejects(commitMedia(harness, 'video', true));
    assert.deepEqual(harness.state.uploads, []);
  });
});

describe('administrator qualification routes and parsing', () => {
  test('registers an admin-first GET and an admin-first limited POST', () => {
    const getRoute = routeFor('/monthly-draw/uploads');
    const postRoute = routeFor('/monthly-draw/uploads/:uploadId/status');
    assert.ok(getRoute);
    assert.ok(postRoute);
    assert.deepEqual(Object.keys(getRoute.methods), ['get']);
    assert.deepEqual(Object.keys(postRoute.methods), ['post']);
    assert.strictEqual(handlersFor(getRoute, 'get')[0], isAdmin);
    assert.strictEqual(handlersFor(postRoute, 'post')[0], isAdmin);
    assert.strictEqual(
      handlersFor(postRoute, 'post')[1],
      adminUserStatusLimiter,
    );
  });

  test('strictly normalizes month, status and positive page filters', () => {
    assert.deepEqual(normalizeMonthlyDrawReviewQuery({
      month: '2026-07', status: 'all', page: '12',
    }, NOW), { month: '2026-07', status: 'all', page: 12 });
    for (const query of [
      { month: '2026-7', status: 'pending', page: '1' },
      { month: ['2026-07'], status: ['all'], page: ['2'] },
      { month: 'bad', status: 'winner', page: '0' },
      { month: '2026-13', status: 'PENDING', page: '1.5' },
    ]) {
      assert.deepEqual(normalizeMonthlyDrawReviewQuery(query, NOW), {
        month: '2026-08', status: 'pending', page: 1,
      });
    }
    assert.equal(ADMIN_MONTHLY_DRAW_PAGE_SIZE, 20);
    assert.equal(
      buildMonthlyDrawReviewUrl({
        month: '2026-08', status: 'ineligible', page: 3,
      }),
      '/a/monthly-draw/uploads?month=2026-08&status=ineligible&page=3',
    );
  });

  test('uses narrow Upload and account projections', () => {
    assert.equal(ADMIN_MONTHLY_DRAW_UPLOAD_PROJECTION.monthlyDraw, 1);
    assert.equal(ADMIN_MONTHLY_DRAW_UPLOAD_PROJECTION.userId, 1);
    assert.deepEqual(ADMIN_MONTHLY_DRAW_USER_PROJECTION, {
      _id: 1,
      fname: 1,
      email_verified: 1,
      isAdmin: 1,
      blocked: 1,
    });
    assert.deepEqual(ADMIN_MONTHLY_DRAW_ELIGIBILITY_PROJECTION, {
      _id: 1,
      email_verified: 1,
      isAdmin: 1,
      blocked: 1,
    });
    for (const privateField of [
      'username', 'hash', 'salt', 'other_login', 'uploads', 'auth_version',
    ]) {
      assert.equal(Object.hasOwn(ADMIN_MONTHLY_DRAW_USER_PROJECTION, privateField), false);
    }
  });

  test('counts the selected month exactly, clamps pages and uses bounded batch queries', async () => {
    const countCalls = [];
    const findCalls = [];
    const parkCalls = [];
    const uploadRecord = {
      _id: PARK_ID,
      mediaType: 'photo',
      mediaId: CAMPSITE_ID,
      createdAt: NOW,
      parkId: PARK_ID,
      parkName: 'Review Park',
      cloudinaryUrl: 'https://example.test/review.jpg',
      userId: {
        _id: USER_ID,
        fname: 'Camper',
        email_verified: true,
        isAdmin: false,
        blocked: false,
      },
      monthlyDraw: pending(),
    };
    const UploadModel = {
      async countDocuments(filter) {
        countCalls.push(filter);
        if (filter['monthlyDraw.status'] === 'pending') return 21;
        if (filter['monthlyDraw.status'] === 'eligible') return 3;
        if (filter['monthlyDraw.status'] === 'ineligible') return 2;
        return 26;
      },
      find(filter) {
        const call = { filter };
        findCalls.push(call);
        const chain = {
          select(value) { call.projection = value; return chain; },
          sort(value) { call.sort = value; return chain; },
          skip(value) { call.skip = value; return chain; },
          limit(value) { call.limit = value; return chain; },
          populate(value) { call.populate = value; return chain; },
          async lean() { return [uploadRecord]; },
        };
        return chain;
      },
    };
    const ParkModel = {
      find(filter) {
        const call = { filter };
        parkCalls.push(call);
        const chain = {
          select(value) { call.projection = value; return chain; },
          async lean() {
            return [{
              _id: PARK_ID,
              slug: 'review-park',
              photos: [{ _id: CAMPSITE_ID, caption: 'Useful caption' }],
              videos: [],
              campsites: [],
              campgrounds: [],
            }];
          },
        };
        return chain;
      },
    };
    const rendered = {};
    const handler = createMonthlyDrawUploadReviewHandler({
      UploadModel,
      ParkModel,
      currentTime: () => NOW,
    });
    await handler({
      query: { month: '2026-08', status: 'pending', page: '999' },
    }, {
      locals: { csrfToken: 'token' },
      render(view, locals) {
        rendered.view = view;
        rendered.locals = locals;
        return this;
      },
    });

    assert.equal(rendered.view, 'admin/monthlyDrawUploads');
    assert.deepEqual(rendered.locals.counts, {
      pending: 21,
      eligible: 3,
      ineligible: 2,
      total: 26,
    });
    assert.deepEqual(rendered.locals.filters, {
      month: '2026-08', status: 'pending', page: 2,
    });
    assert.equal(countCalls.length, 4);
    assert.ok(countCalls.every(filter =>
      filter.monthlyDraw?.$exists === true &&
      filter['monthlyDraw.monthKey'] === '2026-08'
    ));
    assert.equal(findCalls.length, 1);
    assert.deepEqual(findCalls[0], {
      filter: {
        monthlyDraw: { $exists: true },
        'monthlyDraw.monthKey': '2026-08',
        'monthlyDraw.status': 'pending',
      },
      projection: ADMIN_MONTHLY_DRAW_UPLOAD_PROJECTION,
      sort: { createdAt: -1 },
      skip: 20,
      limit: 20,
      populate: {
        path: 'userId',
        select: ADMIN_MONTHLY_DRAW_USER_PROJECTION,
      },
    });
    assert.equal(parkCalls.length, 1);
    assert.equal(rendered.locals.uploads.length, 1);
    assert.equal(rendered.locals.uploads[0].caption, 'Useful caption');
    assert.equal('userId' in rendered.locals.uploads[0], false);
    assert.equal('mediaId' in rendered.locals.uploads[0], false);
  });
});

function statusHarness({ account = null, uploadMonthlyDraw = pending() } = {}) {
  const updates = [];
  const userQueries = [];
  const userSelects = [];
  const uploadQueries = [];
  const logs = [];
  const flash = flashRecorder();
  const upload = uploadMonthlyDraw === null ? {
    _id: PARK_ID,
    userId: USER_ID,
  } : {
    _id: PARK_ID,
    userId: USER_ID,
    monthlyDraw: uploadMonthlyDraw,
  };
  const handler = createMonthlyDrawUploadStatusHandler({
    UploadModel: {
      findOne(filter) {
        uploadQueries.push(filter);
        return chainResult(upload);
      },
      async findOneAndUpdate(filter, update, options) {
        updates.push({ filter, update, options });
        return { _id: PARK_ID };
      },
    },
    UserModel: {
      findOne(filter) {
        userQueries.push(filter);
        const chain = {
          select(value) { userSelects.push(value); return chain; },
          lean: async () => account,
        };
        return chain;
      },
    },
    currentTime: () => NOW,
    log: async (...args) => logs.push(args),
    redirectWithFlash: flash.redirectWithFlash,
  });
  const invoke = body => handler({
    params: { uploadId: PARK_ID.toHexString() },
    query: { month: '2026-08', status: 'pending', page: '2' },
    body: { _csrf: 'token', ...body },
    user: { _id: ADMIN_ID, isAdmin: true },
  }, {});
  return {
    flash,
    handler,
    invoke,
    logs,
    updates,
    uploadQueries,
    userQueries,
    userSelects,
  };
}

describe('administrator qualification state mutation', () => {
  const eligibleAccount = {
    _id: USER_ID,
    email_verified: true,
    isAdmin: false,
    blocked: false,
  };

  test('eligible rechecks the exact account and sets reviewer/date while clearing reason', async () => {
    const harness = statusHarness({ account: eligibleAccount });
    await harness.invoke({ status: 'eligible', ineligibilityReason: 'duplicate' });
    assert.equal(harness.userQueries.length, 1);
    assert.deepEqual(harness.userSelects, [
      ADMIN_MONTHLY_DRAW_ELIGIBILITY_PROJECTION,
    ]);
    assert.equal(harness.updates.length, 1);
    assert.deepEqual(harness.updates[0].update.$set.monthlyDraw, reviewed('eligible'));
    assert.equal(harness.updates[0].options.runValidators, true);
    assert.equal(harness.updates[0].options.upsert, false);
    assert.deepEqual(harness.updates[0].filter, {
      _id: PARK_ID,
      monthlyDraw: { $exists: true },
    });
    assert.deepEqual(Object.keys(harness.updates[0].update.$set), [
      'monthlyDraw',
    ]);
    assert.equal(Object.hasOwn(harness.updates[0].update.$set, 'approved'), false);
  });

  for (const [label, account] of [
    ['missing', null],
    ['administrator', { ...eligibleAccount, isAdmin: true }],
    ['blocked', { ...eligibleAccount, blocked: true }],
    ['unverified', { ...eligibleAccount, email_verified: false }],
  ]) {
    test(`eligible rejects a ${label} account without an Upload update`, async () => {
      const harness = statusHarness({ account });
      await harness.invoke({ status: 'eligible' });
      assert.equal(harness.updates.length, 0);
      assert.equal(harness.flash.calls[0][1], ADMIN_MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE);
    });
  }

  test('ineligible requires one fixed reason and performs no account query', async () => {
    const rejected = statusHarness();
    await rejected.invoke({ status: 'ineligible', ineligibilityReason: 'free text' });
    assert.equal(rejected.updates.length, 0);

    const accepted = statusHarness();
    await accepted.invoke({
      status: 'ineligible',
      ineligibilityReason: 'wrong-location',
    });
    assert.equal(accepted.userQueries.length, 0);
    assert.deepEqual(
      accepted.updates[0].update.$set.monthlyDraw,
      reviewed('ineligible', { ineligibilityReason: 'wrong-location' }),
    );
  });

  test('pending clears every review field and preserves month/version', async () => {
    const harness = statusHarness({
      uploadMonthlyDraw: reviewed('ineligible', {
        ineligibilityReason: 'duplicate',
      }),
    });
    await harness.invoke({ status: 'pending', ineligibilityReason: 'duplicate' });
    assert.deepEqual(harness.updates[0].update.$set.monthlyDraw, pending());
    assert.equal(harness.userQueries.length, 0);
  });

  test('malformed IDs, legacy Uploads and unexpected fields never update', async () => {
    const malformed = statusHarness();
    await malformed.handler({
      params: { uploadId: 'not-an-object-id' },
      query: {},
      body: { status: 'pending' },
      user: { _id: ADMIN_ID },
    }, {});
    assert.equal(malformed.uploadQueries.length, 0);
    assert.equal(malformed.flash.calls[0][1], ADMIN_MONTHLY_DRAW_NOT_FOUND_MESSAGE);

    const legacy = statusHarness({ uploadMonthlyDraw: null });
    await legacy.invoke({ status: 'pending' });
    assert.equal(legacy.updates.length, 0);

    const forged = statusHarness();
    await forged.invoke({ status: 'eligible', monthKey: '1999-01' });
    assert.equal(forged.updates.length, 0);
    assert.equal(forged.userQueries.length, 0);
  });

  test('operational failure logs only the fixed event', async () => {
    const logs = [];
    const flash = flashRecorder();
    const hostile = '</p><script>attack()</script>';
    const handler = createMonthlyDrawUploadStatusHandler({
      UploadModel: {
        findOne() {
          return {
            select() { return this; },
            async lean() { throw new Error(hostile); },
          };
        },
      },
      currentTime: () => NOW,
      log: async (...args) => logs.push(args),
      redirectWithFlash: flash.redirectWithFlash,
    });
    await handler({
      params: { uploadId: PARK_ID.toHexString() },
      query: {},
      body: { status: 'pending' },
      user: { _id: ADMIN_ID },
    }, {});
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].slice(0, 3), [null, null, 'error']);
    assert.deepEqual(logs[0][3], {
      message: ADMIN_MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
    });
    assert.equal(JSON.stringify(logs).includes(hostile), false);
  });
});

describe('administrator qualification rendering and source guards', () => {
  test('serializes only safe review fields and current account eligibility', () => {
    const hostile = '</dd><script id="draw-xss">attack()</script>';
    const upload = serializeMonthlyDrawReviewUpload({
      _id: PARK_ID,
      mediaType: 'photo',
      mediaId: CAMPSITE_ID,
      createdAt: NOW,
      parkName: hostile,
      cloudinaryUrl: 'https://example.test/photo.jpg',
      userId: {
        _id: USER_ID,
        fname: hostile,
        email_verified: true,
        isAdmin: false,
        blocked: false,
        hash: hostile,
      },
      monthlyDraw: reviewed('ineligible', {
        ineligibilityReason: 'rights-or-policy',
      }),
    });
    assert.equal(upload.accountEligible, true);
    assert.equal(upload.ineligibilityReasonLabel, 'Rights or policy issue');
    assert.equal('hash' in upload.uploader, false);
    assert.equal('username' in upload.uploader, false);
  });

  test('renders one heading, counts, filters, badges, reasons, CSRF and escaped text', async () => {
    const hostile = '</dd><script id="draw-xss">attack()</script>';
    const html = await ejs.renderFile(
      path.join(root, 'views', 'admin', 'monthlyDrawUploads.ejs'),
      {
        layout() {},
        currentPath: '/a/monthly-draw/uploads',
        filters: { month: '2026-08', status: 'pending', page: 1 },
        counts: { pending: 1, eligible: 2, ineligible: 3, total: 6 },
        totalPages: 1,
        hasPreviousPage: false,
        hasNextPage: false,
        csrfToken: '<csrf-token>',
        reasonLabels: MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS,
        reasonValues: MONTHLY_DRAW_INELIGIBILITY_REASONS,
        extractYouTubeVideoId,
        uploads: [{
          _id: PARK_ID.toHexString(),
          mediaType: 'photo',
          createdAt: NOW,
          reviewedAt: null,
          adminPhotoUrl: 'https://example.test/photo.jpg',
          youtubeId: null,
          parkName: hostile,
          parkUrl: '/camp/park/safe-park',
          campgroundName: null,
          campgroundUrl: null,
          campsiteName: null,
          campsiteUrl: null,
          caption: hostile,
          monthKey: '2026-08',
          status: 'pending',
          ineligibilityReason: null,
          ineligibilityReasonLabel: null,
          uploader: { fname: hostile, userDetailUrl: `/a/users/${USER_ID}` },
          accountEligible: false,
        }],
      },
    );
    assert.equal((html.match(/<h1\b/gu) || []).length, 1);
    assert.match(html, /Monthly draw upload review/u);
    assert.match(html, /Total prospective uploads/u);
    assert.match(html, /Draw: Pending/u);
    for (const label of Object.values(MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS)) {
      assert.match(html, new RegExp(label, 'u'));
    }
    assert.match(html, /name="_csrf" value="&lt;csrf-token&gt;"/u);
    assert.match(html, /This account is not currently eligible for the monthly draw\./u);
    assert.equal(html.includes('<script id="draw-xss">'), false);
    assert.match(html, /&lt;script id=&#34;draw-xss&#34;&gt;/u);
    assert.doesNotMatch(html, /\b(?:hash|salt|session|auth_version|previous_logins)\b/iu);
  });

  test('renders the empty state and shared badges only when metadata exists', async () => {
    const page = await ejs.renderFile(
      path.join(root, 'views', 'admin', 'monthlyDrawUploads.ejs'),
      {
        layout() {},
        currentPath: '/a/monthly-draw/uploads',
        filters: { month: '2026-08', status: 'pending', page: 1 },
        counts: { pending: 0, eligible: 0, ineligible: 0, total: 0 },
        uploads: [],
        totalPages: 1,
        hasPreviousPage: false,
        hasNextPage: false,
        csrfToken: 'token',
        reasonLabels: MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS,
        reasonValues: MONTHLY_DRAW_INELIGIBILITY_REASONS,
        extractYouTubeVideoId,
      },
    );
    assert.match(page, /No prospective uploads match these review filters\./u);

    const cardPath = path.join(root, 'views', 'admin', 'partials', 'uploadCard.ejs');
    const base = {
      mediaType: 'photo',
      createdAt: NOW,
      adminPhotoUrl: null,
      youtubeId: null,
      uploader: {},
      parkName: null,
      parkUrl: null,
      campgroundName: null,
      campgroundUrl: null,
      campsiteName: null,
      campsiteUrl: null,
    };
    const legacy = await ejs.renderFile(cardPath, {
      upload: { ...base, monthlyDrawStatus: null },
      showUploader: false,
      extractYouTubeVideoId,
    });
    const eligible = await ejs.renderFile(cardPath, {
      upload: { ...base, monthlyDrawStatus: 'eligible' },
      showUploader: false,
      extractYouTubeVideoId,
    });
    assert.doesNotMatch(legacy, /Draw:/u);
    assert.match(eligible, /Draw: Eligible/u);
    assert.doesNotMatch(legacy + eligible, /monthly-draw\/uploads\/.+\/status/iu);
  });

  test('has no inline executable/style sinks and keeps mutation controls dedicated', async () => {
    const [page, css, dashboard, detail, card] = await Promise.all([
      read('views/admin/monthlyDrawUploads.ejs'),
      read('public/css/adminMonthlyDrawUploads.css'),
      read('views/admin/dashboard.ejs'),
      read('views/admin/userDetail.ejs'),
      read('views/admin/partials/uploadCard.ejs'),
    ]);
    assert.doesNotMatch(page, /<script\b|<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu);
    assert.doesNotMatch(page, /<%-\s*JSON|application\/json/iu);
    assert.match(css, /:focus-visible/u);
    assert.match(css, /@media \(max-width: 760px\)/u);
    for (const source of [dashboard, detail, card]) {
      assert.doesNotMatch(source, /monthly-draw\/uploads\/<%=.+status/iu);
      assert.doesNotMatch(source, /name="ineligibilityReason"/u);
      assert.doesNotMatch(source, /Upload\.approved|upload\.approved/iu);
    }
    assert.equal(PUBLIC_MEDIA_KEYS.includes('monthlyDraw'), false);
  });
});

describe('non-retroactive and deferred-scope guards', () => {
  test('states the narrow non-retroactive qualification rule', async () => {
    const rules = await read('views/other/monthlyDraw.ejs');
    assert.match(rules, /Earlier uploads are not entered retroactively\./u);
    assert.match(rules, /must be found qualifying/u);
    assert.equal((rules.match(/2026-08-03-v1/gu) || []).length, 0);
  });

  test('adds no migration, backfill, winner selection, email or scheduler implementation', async () => {
    const scopedSources = await Promise.all([
      read('models/upload.js'),
      read('utils/mediaPersistence.js'),
      read('controllers/monthlyDrawAdmin.js'),
      read('routes/admin.js'),
    ]);
    const combined = scopedSources.join('\n');
    assert.doesNotMatch(combined, /winner|alternate|gift.?card|skill.?test/iu);
    assert.doesNotMatch(combined, /scheduler|scheduled|cron/iu);
    assert.doesNotMatch(combined, /migrat|backfill|bulkWrite/iu);
    assert.doesNotMatch(combined, /sendEmail|Mailgun|MonthlyDrawResult/iu);

    const scripts = await readdir(path.join(root, 'scripts'));
    assert.equal(
      scripts.some(name => /monthly.*draw|draw.*monthly/iu.test(name)),
      false,
    );
  });
});
