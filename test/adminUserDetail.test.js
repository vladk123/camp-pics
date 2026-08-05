import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';
import mongoose from 'mongoose';

import {
  ADMIN_PARK_LOCATION_PROJECTION,
  ADMIN_UPLOAD_PROJECTION,
  ADMIN_USER_DETAIL_PROJECTION,
  createAdminUserDetailHandler,
  getAdminUserDetailUrl,
  normalizeAdminLoginActivity,
  serializeAdminUpload,
  serializeAdminUser,
} from '../controllers/admin.js';
import { isAdmin } from '../middleware.js';
import adminRouter from '../routes/admin.js';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';

const root = process.cwd();
const read = relativePath => readFile(path.join(root, relativePath), 'utf8');
const TARGET_ID = '64b7f2d4c9f1e8a123456789';
const ADMIN_ID = '74b7f2d4c9f1e8a123456789';
const OTHER_USER_ID = '84b7f2d4c9f1e8a123456789';
const PARK_ID = '94b7f2d4c9f1e8a123456789';
const CAMPGROUND_ID = 'a4b7f2d4c9f1e8a123456789';
const CAMPSITE_ID = 'b4b7f2d4c9f1e8a123456789';

function objectId(value) {
  return new mongoose.Types.ObjectId(value);
}

function routeFor(routePath) {
  return adminRouter.stack.find(layer => layer.route?.path === routePath)?.route;
}

function userRecord(overrides = {}) {
  return {
    _id: objectId(TARGET_ID),
    fname: 'Camper',
    username: 'camper@example.test',
    date_created: new Date('2026-01-02T00:00:00.000Z'),
    email_verified: true,
    blocked: false,
    other_login: {
      last_login: new Date('2026-08-03T15:00:00.000Z'),
      previous_logins: [{
        timestamp: new Date('2026-08-02T14:00:00.000Z'),
        ip_address: '198.51.100.10',
      }],
    },
    hash: 'fixture-password-hash',
    salt: 'fixture-password-salt',
    auth_version: 12,
    sessions: [{ id: 'fixture-session-id' }],
    token: 'fixture-auth-token',
    ...overrides,
  };
}

function uploadRecord(index, overrides = {}) {
  return {
    mediaType: 'photo',
    createdAt: new Date(Date.UTC(2026, 7, 3, 12, 0, index)),
    parkId: objectId(PARK_ID),
    parkName: `Park ${index}`,
    campgroundId: objectId(CAMPGROUND_ID),
    campgroundName: `Campground ${index}`,
    campsiteId: objectId(CAMPSITE_ID),
    campsiteName: `Site ${index}`,
    cloudinaryUrl: `https://cdn.example.test/photo-${index}.jpg`,
    userId: objectId(TARGET_ID),
    ...overrides,
  };
}

function createUserModel(record) {
  const calls = [];
  return {
    calls,
    model: {
      findOne(filter) {
        const call = { filter, projection: null, leanCalls: 0 };
        calls.push(call);
        const chain = {
          select(projection) {
            call.projection = projection;
            return chain;
          },
          async lean() {
            call.leanCalls += 1;
            return record;
          },
        };
        return chain;
      },
    },
  };
}

function idsEqual(left, right) {
  return left?.toString?.() === right?.toString?.();
}

function applyInclusionProjection(record, projection) {
  if (!projection) return record;
  const projected = {};
  for (const [pathName, included] of Object.entries(projection)) {
    if (included !== 1) continue;
    const pathParts = pathName.split('.');
    let source = record;
    for (const pathPart of pathParts) source = source?.[pathPart];
    if (source === undefined) continue;

    let target = projected;
    for (const pathPart of pathParts.slice(0, -1)) {
      target[pathPart] ??= {};
      target = target[pathPart];
    }
    target[pathParts.at(-1)] = source;
  }
  return projected;
}

function createUploadModel(records) {
  const calls = { counts: [], finds: [] };
  return {
    calls,
    model: {
      async countDocuments(filter) {
        calls.counts.push(filter);
        return records.filter(record => idsEqual(record.userId, filter.userId)).length;
      },
      find(filter) {
        const call = {
          filter,
          limit: null,
          projection: null,
          skip: null,
          sort: null,
        };
        calls.finds.push(call);
        const chain = {
          select(projection) {
            call.projection = projection;
            return chain;
          },
          sort(sort) {
            call.sort = sort;
            return chain;
          },
          skip(skip) {
            call.skip = skip;
            return chain;
          },
          limit(limit) {
            call.limit = limit;
            return chain;
          },
          async lean() {
            return records
              .filter(record => idsEqual(record.userId, filter.userId))
              .sort((left, right) => right.createdAt - left.createdAt)
              .slice(call.skip, call.skip + call.limit)
              .map(record => applyInclusionProjection(
                record,
                call.projection,
              ));
          },
        };
        return chain;
      },
    },
  };
}

function createParkModel(records = []) {
  const calls = [];
  return {
    calls,
    model: {
      find(filter) {
        const call = { filter, projection: null, leanCalls: 0 };
        calls.push(call);
        const chain = {
          select(projection) {
            call.projection = projection;
            return chain;
          },
          async lean() {
            call.leanCalls += 1;
            return records;
          },
        };
        return chain;
      },
    },
  };
}

function createRecorder() {
  const state = { logs: [], redirects: [], renders: [] };
  return {
    state,
    log: async (...args) => state.logs.push(args),
    redirectWithFlash: (...args) => {
      state.redirects.push(args);
      return { redirected: true };
    },
  };
}

async function invokeDetail({
  page,
  record = userRecord(),
  uploads = [],
  parks = [],
  targetId = TARGET_ID,
  administratorId = ADMIN_ID,
} = {}) {
  const users = createUserModel(record);
  const uploadState = createUploadModel(uploads);
  const parkState = createParkModel(parks);
  const recorder = createRecorder();
  const handler = createAdminUserDetailHandler({
    UserModel: users.model,
    UploadModel: uploadState.model,
    ParkModel: parkState.model,
    log: recorder.log,
    redirectWithFlash: recorder.redirectWithFlash,
  });
  const req = {
    params: { userId: targetId },
    query: page === undefined ? {} : { page },
    user: { _id: objectId(administratorId) },
  };
  const res = {
    locals: { csrfToken: 'detail-csrf-token' },
    render(view, locals) {
      recorder.state.renders.push({ view, locals });
      return this;
    },
  };
  const result = await handler(req, res, error => { throw error; });
  return { parkState, recorder, req, res, result, uploadState, users };
}

async function renderDetail(locals) {
  const filename = path.join(root, 'views/admin/userDetail.ejs');
  return ejs.render(await read('views/admin/userDetail.ejs'), {
    csrfToken: 'detail-csrf-token',
    data: { currentPath: locals.currentPath },
    layout: () => {},
    ...locals,
  }, { filename });
}

describe('administrator user-detail route protection', () => {
  test('is GET-only, runs isAdmin first and has no status limiter', async () => {
    const route = routeFor('/users/:userId');

    assert.ok(route);
    assert.deepEqual(Object.keys(route.methods), ['get']);
    assert.equal(route.stack.length, 2);
    assert.equal(route.stack[0].handle, isAdmin);
    assert.equal(
      route.stack.some(layer => layer.handle === adminUserStatusLimiter),
      false,
    );
    for (const method of ['post', 'put', 'patch', 'delete']) {
      assert.equal(route.methods[method], undefined);
    }

    const adminRoutes = await read('routes/admin.js');
    const userRoutes = await read('routes/users.js');
    assert.match(adminRoutes, /router\.route\('\/users\/:userId'\)\s*\.get\(isAdmin, catchAsyncErrors\(admin\.userDetail\)\);/u);
    assert.doesNotMatch(userRoutes, /users\/:userId|admin\.userDetail/u);
  });

  test('malformed IDs are rejected before any model call with the safe existing response', async () => {
    let modelCalls = 0;
    const model = new Proxy({}, {
      get() {
        return () => {
          modelCalls += 1;
          throw new Error('database boundary should not run');
        };
      },
    });
    const recorder = createRecorder();
    const handler = createAdminUserDetailHandler({
      UserModel: model,
      UploadModel: model,
      ParkModel: model,
      redirectWithFlash: recorder.redirectWithFlash,
    });
    const req = {
      params: { userId: 'malformed-attacker-id' },
      query: {},
      user: { _id: objectId(ADMIN_ID) },
    };
    const res = {};

    assert.deepEqual(await handler(req, res, () => {}), { redirected: true });
    assert.equal(modelCalls, 0);
    assert.deepEqual(recorder.state.redirects, [[
      req,
      res,
      'error',
      'Invalid user target.',
      '/a/dashboard',
    ]]);
    assert.doesNotMatch(
      JSON.stringify(recorder.state.redirects[0].slice(2)),
      /malformed-attacker-id/u,
    );
  });

  test('a valid missing user uses the safe existing not-found response and no upload query', async () => {
    const invocation = await invokeDetail({ record: null });

    assert.equal(invocation.users.calls.length, 1);
    assert.equal(invocation.uploadState.calls.counts.length, 0);
    assert.equal(invocation.uploadState.calls.finds.length, 0);
    assert.deepEqual(invocation.recorder.state.redirects[0].slice(2), [
      'error',
      'User was not found.',
      '/a/dashboard',
    ]);
  });
});

describe('administrator user-detail safe account and login contract', () => {
  test('selects only intended fields and passes no raw User document', async () => {
    const invocation = await invokeDetail();
    const rendered = invocation.recorder.state.renders[0];

    assert.equal(invocation.users.calls.length, 1);
    assert.equal(
      invocation.users.calls[0].filter._id.toHexString(),
      TARGET_ID,
    );
    assert.deepEqual(
      invocation.users.calls[0].projection,
      ADMIN_USER_DETAIL_PROJECTION,
    );
    assert.deepEqual(Object.keys(ADMIN_USER_DETAIL_PROJECTION), [
      '_id',
      'fname',
      'username',
      'date_created',
      'email_verified',
      'blocked',
      'other_login.last_login',
      'other_login.previous_logins.timestamp',
    ]);
    for (const field of [
      'hash',
      'salt',
      'auth_version',
      'reset_password_code',
      'session',
      'token',
      'ip_address',
    ]) {
      assert.equal(JSON.stringify(ADMIN_USER_DETAIL_PROJECTION).includes(field), false);
    }

    assert.equal(rendered.view, 'admin/userDetail');
    assert.deepEqual(Object.keys(rendered.locals.user), [
      '_id',
      'fname',
      'username',
      'date_created',
      'email_verified',
      'blocked',
      'canChangeBlockedStatus',
    ]);
    const visibleModel = JSON.stringify(rendered.locals);
    for (const sensitive of [
      'fixture-password-hash',
      'fixture-password-salt',
      'fixture-session-id',
      'fixture-auth-token',
      '198.51.100.10',
      'auth_version',
    ]) {
      assert.equal(visibleModel.includes(sensitive), false, sensitive);
    }
    assert.equal(Object.values(rendered.locals).includes(userRecord()), false);
  });

  test('normalizes the stored timestamp-object shape, deduplicates, sorts and caps at 20', () => {
    const previousLogins = Array.from({ length: 25 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 6, index + 1)),
      ip_address: `198.51.100.${index}`,
      user_agent: `fixture-agent-${index}`,
      session_id: `fixture-session-${index}`,
      token: `fixture-token-${index}`,
    }));
    previousLogins.push(
      { timestamp: new Date('2026-07-25T00:00:00.000Z') },
      { timestamp: 'not-a-date', ip_address: '203.0.113.1' },
      { ip_address: '203.0.113.2' },
      null,
    );
    const activity = normalizeAdminLoginActivity({
      other_login: {
        last_login: new Date('2026-07-26T00:00:00.000Z'),
        previous_logins: previousLogins,
      },
    });

    assert.equal(activity.length, 20);
    assert.equal(new Set(activity.map(value => value.toISOString())).size, 20);
    assert.equal(activity[0].toISOString(), '2026-07-26T00:00:00.000Z');
    assert.equal(activity.at(-1).toISOString(), '2026-07-07T00:00:00.000Z');
    assert.equal(
      activity.every((value, index) => index === 0 || activity[index - 1] >= value),
      true,
    );
    assert.equal(
      JSON.stringify(activity).includes('198.51.100'),
      false,
    );
    assert.deepEqual(normalizeAdminLoginActivity({ other_login: {} }), []);
  });
});

describe('administrator user upload ownership, pagination and locations', () => {
  test('uses exact ownership, page size 20, descending order and one Park query', async () => {
    const owned = Array.from({ length: 22 }, (_, index) => uploadRecord(index));
    const otherUserUpload = uploadRecord(99, {
      parkName: 'Other user private upload',
      userId: objectId(OTHER_USER_ID),
    });
    const invocation = await invokeDetail({
      page: '2',
      uploads: [...owned, otherUserUpload],
      parks: [{
        _id: objectId(PARK_ID),
        slug: 'safe-park',
        campgrounds: [{
          _id: objectId(CAMPGROUND_ID),
          slug: 'safe-campground',
          campsites: [{
            _id: objectId(CAMPSITE_ID),
            slug: 'safe-campsite',
          }],
        }],
      }],
    });
    const locals = invocation.recorder.state.renders[0].locals;

    assert.equal(invocation.uploadState.calls.counts.length, 1);
    assert.equal(
      invocation.uploadState.calls.counts[0].userId.toHexString(),
      TARGET_ID,
    );
    assert.equal(invocation.uploadState.calls.finds.length, 1);
    const find = invocation.uploadState.calls.finds[0];
    assert.equal(find.filter.userId.toHexString(), TARGET_ID);
    const expectedUploadProjection = {
      _id: 0,
      mediaType: 1,
      createdAt: 1,
      parkId: 1,
      parkName: 1,
      campgroundId: 1,
      campgroundName: 1,
      campsiteId: 1,
      campsiteName: 1,
      youtubeId: 1,
      cloudinaryUrl: 1,
      cloudinaryId: 1,
      userId: 1,
      'monthlyDraw.status': 1,
    };
    assert.equal(ADMIN_UPLOAD_PROJECTION.campsiteId, 1);
    assert.deepEqual(ADMIN_UPLOAD_PROJECTION, expectedUploadProjection);
    assert.deepEqual(find.projection, expectedUploadProjection);
    assert.deepEqual(find.sort, { createdAt: -1 });
    assert.equal(find.skip, 20);
    assert.equal(find.limit, 20);
    assert.equal(locals.totalUploadCount, 22);
    assert.equal(locals.currentPage, 2);
    assert.equal(locals.totalPages, 2);
    assert.equal(locals.hasPreviousPage, true);
    assert.equal(locals.hasNextPage, false);
    assert.equal(locals.uploads.length, 2);
    assert.equal(
      JSON.stringify(locals.uploads).includes('Other user private upload'),
      false,
    );

    assert.equal(invocation.parkState.calls.length, 1);
    assert.deepEqual(
      invocation.parkState.calls[0].projection,
      ADMIN_PARK_LOCATION_PROJECTION,
    );
    assert.equal(invocation.parkState.calls[0].filter._id.$in.length, 1);
    assert.equal(locals.uploads[0].parkUrl, '/camp/park/safe-park');
    assert.equal(
      locals.uploads[0].campgroundUrl,
      '/camp/park/safe-park#safe-campground',
    );
    assert.equal(
      locals.uploads[0].campsiteUrl,
      '/camp/park/safe-park?campground=safe-campground&campsite=safe-campsite',
    );
    for (const upload of locals.uploads) {
      for (const rawId of ['parkId', 'campgroundId', 'campsiteId', 'userId']) {
        assert.equal(rawId in upload, false);
      }
    }
  });

  test('invalid low pages fall back to one and excessive pages clamp safely', async () => {
    const uploads = Array.from({ length: 21 }, (_, index) => uploadRecord(index));
    const low = await invokeDetail({ page: '0', uploads });
    const excessive = await invokeDetail({ page: '999999', uploads });

    assert.equal(low.uploadState.calls.finds[0].skip, 0);
    assert.equal(low.recorder.state.renders[0].locals.currentPage, 1);
    assert.equal(low.recorder.state.renders[0].locals.uploads.length, 20);
    assert.equal(excessive.uploadState.calls.finds[0].skip, 20);
    assert.equal(excessive.recorder.state.renders[0].locals.currentPage, 2);
    assert.equal(excessive.recorder.state.renders[0].locals.uploads.length, 1);
  });

  test('an empty upload page performs no Park query', async () => {
    const invocation = await invokeDetail();
    assert.equal(invocation.parkState.calls.length, 0);
    assert.deepEqual(invocation.recorder.state.renders[0].locals.uploads, []);
  });
});

describe('administrator dashboard user-detail links', () => {
  test('serializes only exact lowercase ObjectId detail URLs', () => {
    assert.equal(
      getAdminUserDetailUrl(objectId(TARGET_ID)),
      `/a/users/${TARGET_ID}`,
    );
    assert.equal(
      serializeAdminUser({ _id: objectId(TARGET_ID) }).userDetailUrl,
      `/a/users/${TARGET_ID}`,
    );
    for (const invalid of [
      null,
      'user-id',
      `/a/users/${TARGET_ID}`,
      `${TARGET_ID}?page=2`,
      'javascript:alert(1)',
    ]) {
      assert.equal(getAdminUserDetailUrl(invalid), null);
    }
  });

  test('server-rendered valid identities link and invalid identities remain text', async () => {
    const filename = path.join(root, 'views/admin/dashboard.ejs');
    const html = ejs.render(await read('views/admin/dashboard.ejs'), {
      csrfToken: 'csrf-token',
      dashboardStats: {
        totalUploads: 0,
        totalUsers: 2,
        verifiedUsers: 0,
        blockedUsers: 0,
      },
      data: { currentPath: '/a/dashboard' },
      extractYouTubeVideoId: () => null,
      hasMoreUploads: false,
      hasMoreUsers: false,
      layout: () => {},
      uploadPage: 1,
      uploads: [],
      userPage: 1,
      users: [
        {
          ...serializeAdminUser({
            _id: objectId(TARGET_ID),
            fname: 'Linked user',
          }),
        },
        {
          ...serializeAdminUser({ _id: 'invalid-id', fname: 'Plain user' }),
        },
      ],
    }, { filename });

    assert.match(
      html,
      new RegExp(`href="/a/users/${TARGET_ID}"[^>]*>Linked user</a>`, 'u'),
    );
    assert.doesNotMatch(html, /href="[^"]*">Plain user<\/a>/u);
    assert.equal((html.match(/user-status-form/gu) || []).length, 2);
  });

  test('dynamic rows validate the same URL and preserve Block/Unblock actions', async () => {
    const browser = await read('public/js/adminDashboard.js');
    const start = browser.indexOf('function createTextElement(');
    const end = browser.indexOf('function clearStatus(', start);
    const functionSource = browser.slice(start, end);

    class FakeElement {
      constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.textContent = '';
      }
      append(...children) { this.children.push(...children); }
    }
    const context = {
      document: { createElement: tagName => new FakeElement(tagName) },
      encodeURIComponent,
      window: { CampPicsCsrf: { getToken: () => 'csrf-token' } },
    };
    vm.runInNewContext(
      'const DASHBOARD_USER_DETAIL_URL_PATTERN = ' +
        '/^\\/a\\/users\\/[a-f0-9]{24}$/u;\n' +
        'const csrf = window.CampPicsCsrf;\n' +
        `${functionSource}\nthis.createUserRow = createUserRow;`,
      context,
    );
    const findAll = (element, predicate) => [
      ...(predicate(element) ? [element] : []),
      ...element.children.flatMap(child => findAll(child, predicate)),
    ];
    const valid = context.createUserRow({
      _id: TARGET_ID,
      fname: 'Linked',
      userDetailUrl: `/a/users/${TARGET_ID}`,
      blocked: false,
    });
    const invalid = context.createUserRow({
      _id: TARGET_ID,
      fname: 'Plain',
      userDetailUrl: 'javascript:alert(1)',
      blocked: true,
    });

    const validLinks = findAll(valid, element =>
      element.tagName === 'A' && element.className === 'admin-user-detail-link');
    const invalidLinks = findAll(invalid, element => element.tagName === 'A');
    assert.equal(validLinks.length, 1);
    assert.equal(validLinks[0].href, `/a/users/${TARGET_ID}`);
    assert.equal(invalidLinks.length, 0);
    assert.equal(
      findAll(valid, element => element.tagName === 'FORM')[0].action,
      `/a/user/${TARGET_ID}/block`,
    );
    assert.equal(
      findAll(invalid, element => element.tagName === 'FORM')[0].action,
      `/a/user/${TARGET_ID}/unblock`,
    );
    assert.doesNotMatch(
      functionSource,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bon[a-z]+\s*=/iu,
    );
  });
});

describe('administrator user-detail rendering and source guards', () => {
  test('renders escaped account, timestamps, uploads, pagination and protected status form', async () => {
    const hostile = '</h1><script id="user-detail-xss">attack()</script>';
    const upload = serializeAdminUpload(uploadRecord(1, {
      parkName: hostile,
      campgroundName: hostile,
      campsiteName: hostile,
    }), {
      parkUrl: '/camp/park/safe-park',
      campgroundUrl: '/camp/park/safe-park#safe-campground',
      campsiteUrl:
        '/camp/park/safe-park?campground=safe-campground&campsite=safe-campsite',
    });
    const html = await renderDetail({
      currentPath: `/a/users/${TARGET_ID}`,
      currentPage: 1,
      extractYouTubeVideoId: () => null,
      hasNextPage: true,
      hasPreviousPage: false,
      loginActivity: [
        new Date('2026-08-03T15:00:00.000Z'),
        new Date('2026-08-02T14:00:00.000Z'),
      ],
      totalPages: 2,
      totalUploadCount: 21,
      uploads: [upload],
      user: {
        _id: TARGET_ID,
        fname: hostile,
        username: hostile,
        date_created: new Date('2026-01-02T00:00:00.000Z'),
        email_verified: false,
        blocked: true,
        canChangeBlockedStatus: true,
      },
    });

    assert.equal((html.match(/<h1\b/gu) || []).length, 1);
    assert.match(html, /aria-label="Administrator pages"/u);
    assert.match(html, /href="\/a\/dashboard">Back to dashboard<\/a>/u);
    assert.match(html, /id="user-summary-heading">Account summary<\/h2>/u);
    assert.match(html, />\s*Unverified\s*<\/span>/u);
    assert.match(html, />\s*Blocked\s*<\/span>/u);
    assert.match(html, /id="login-activity-heading">Login activity<\/h2>/u);
    assert.match(html, /Login timestamps are shown for account administration and security review\./u);
    const loginSection = html.slice(
      html.indexOf('id="login-activity-heading"'),
      html.indexOf('id="user-uploads-heading"'),
    );
    assert.equal(
      (loginSection.match(/<time datetime="2026-08-0[23]T/gu) || []).length,
      2,
    );
    assert.match(html, /id="user-uploads-heading">Uploads<\/h2>/u);
    assert.match(html, /class="upload-item admin-upload-card"/u);
    assert.match(html, /href="\/camp\/park\/safe-park"/u);
    assert.match(html, /href="\/camp\/park\/safe-park#safe-campground"/u);
    assert.match(
      html,
      /href="\/camp\/park\/safe-park\?campground=safe-campground&amp;campsite=safe-campsite"/u,
    );
    assert.match(html, /href="\/a\/users\/64b7f2d4c9f1e8a123456789\?page=2">Next<\/a>/u);
    assert.match(html, /Page 1 of 2/u);
    assert.match(html, /action="\/a\/user\/64b7f2d4c9f1e8a123456789\/unblock"/u);
    assert.match(html, /name="_csrf" value="detail-csrf-token"/u);
    assert.match(html, /data-action="unblock"/u);
    assert.equal(html.includes(hostile), false);
    assert.doesNotMatch(html, /<script id="user-detail-xss">/u);
    assert.doesNotMatch(html, /fixture-password|fixture-session|fixture-token|198\.51\.100/u);

    const active = html.replace(/<!--[\s\S]*?-->/gu, '');
    assert.doesNotMatch(active, /<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu);
    assert.equal(
      [...active.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)]
        .every(match => /\bsrc\s*=/.test(match[1]) && match[2].trim() === ''),
      true,
    );
  });

  test('uses the shared draw labels on every user-detail upload card', async () => {
    const uploads = [
      serializeAdminUpload(uploadRecord(1, {
        monthlyDraw: { status: 'eligible' },
      })),
      serializeAdminUpload(uploadRecord(2, {
        monthlyDraw: { status: 'pending' },
      })),
      serializeAdminUpload(uploadRecord(3, {
        monthlyDraw: { status: 'ineligible' },
      })),
      serializeAdminUpload(uploadRecord(4, {
        monthlyDraw: { status: 'malformed' },
      })),
    ];
    const html = await renderDetail({
      currentPath: `/a/users/${TARGET_ID}`,
      currentPage: 1,
      extractYouTubeVideoId: () => null,
      hasNextPage: false,
      hasPreviousPage: false,
      loginActivity: [],
      totalPages: 1,
      totalUploadCount: uploads.length,
      uploads,
      user: {
        _id: TARGET_ID,
        fname: 'Camper',
        username: 'camper@example.test',
        date_created: new Date('2026-01-02T00:00:00.000Z'),
        email_verified: true,
        blocked: false,
        canChangeBlockedStatus: true,
      },
    });

    for (const label of [
      'Draw: Eligible',
      'Draw: Eligible (legacy)',
      'Draw: Ineligible',
      'Draw: Not entered',
    ]) {
      assert.match(html, new RegExp(label.replace(/[()]/gu, '\\$&'), 'u'));
    }
    assert.equal(
      (html.match(/admin-status-badge--draw(?:\s|")/gu) || []).length,
      uploads.length,
    );
    assert.doesNotMatch(html, /name="ineligibilityReason"/u);
    assert.doesNotMatch(html, /monthly-draw\/uploads\/.+\/status/iu);
  });

  test('renders empty login/upload states and no self-block action', async () => {
    const html = await renderDetail({
      currentPath: `/a/users/${ADMIN_ID}`,
      currentPage: 1,
      extractYouTubeVideoId: () => null,
      hasNextPage: false,
      hasPreviousPage: false,
      loginActivity: [],
      totalPages: 1,
      totalUploadCount: 0,
      uploads: [],
      user: {
        _id: ADMIN_ID,
        fname: 'Administrator',
        username: 'admin@example.test',
        date_created: null,
        email_verified: true,
        blocked: false,
        canChangeBlockedStatus: false,
      },
    });

    assert.match(html, /No recorded login activity\./u);
    assert.match(html, /No uploads found for this user\./u);
    assert.match(html, /Page 1 of 1/u);
    assert.doesNotMatch(html, /class="(?:block|unblock)-btn"/u);
    assert.doesNotMatch(html, /action="\/a\/user\//u);
  });

  test('the detail stylesheet is page-only, responsive, themed and focus-visible', async () => {
    const css = await read('public/css/adminUserDetail.css');
    const viewRoot = path.join(root, 'views');
    const viewFiles = (await readdir(viewRoot, { recursive: true }))
      .filter(file => file.endsWith('.ejs'));
    const stylesheetReferences = [];
    for (const relativePath of viewFiles) {
      const viewSource = await readFile(path.join(viewRoot, relativePath), 'utf8');
      if (viewSource.includes('/css/adminUserDetail.css')) {
        stylesheetReferences.push(relativePath.replaceAll('\\', '/'));
      }
    }

    assert.deepEqual(stylesheetReferences, ['admin/userDetail.ejs']);
    assert.match(css, /\[data-theme="dark"\]\s+\.admin-user-detail-page/u);
    assert.match(css, /@media\s*\(max-width:\s*980px\)/u);
    assert.match(css, /@media\s*\(max-width:\s*700px\)/u);
    assert.match(css, /@media\s*\(max-width:\s*520px\)/u);
    assert.match(css, /:focus-visible/u);
    assert.match(css, /overflow-wrap:\s*anywhere/u);
    assert.match(css, /flex-wrap:\s*wrap/u);

    const browserSources = [
      await read('public/js/adminDashboard.js'),
      await read('public/js/adminUserStatus.js'),
    ].join('\n');
    assert.doesNotMatch(
      browserSources,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|setAttribute\s*\(\s*['"]style|\bon[a-z]+\s*=/iu,
    );
    assert.doesNotMatch(browserSources, /window\.[A-Za-z_$][\w$]*\s*=/u);
  });
});
