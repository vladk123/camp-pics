import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import {
  ADMIN_UPLOAD_PROJECTION,
  ADMIN_UPLOAD_USER_PROJECTION,
  ADMIN_USER_PROJECTION,
  createAdminDashboardHandler,
  serializeAdminUpload,
  serializeAdminUser,
} from '../controllers/admin.js';

const ADMIN_USER_KEYS = [
  '_id',
  'fname',
  'username',
  'date_created',
  'email_verified',
  'blocked',
  'userDetailUrl',
];

const ADMIN_UPLOAD_KEYS = [
  'mediaType',
  'createdAt',
  'parkName',
  'campgroundName',
  'campsiteName',
  'parkUrl',
  'campgroundUrl',
  'campsiteUrl',
  'youtubeId',
  'adminPhotoUrl',
  'uploader',
  'monthlyDrawStatus',
  'monthlyDrawLabel',
];

function sensitiveUser(overrides = {}) {
  return {
    _id: 'user-id',
    fname: 'Camper',
    username: 'camper@example.test',
    date_created: new Date('2026-01-02T00:00:00.000Z'),
    email_verified: true,
    blocked: false,
    hash: 'password-hash',
    salt: 'password-salt',
    attempts: 4,
    last: Date.now(),
    auth_version: 8,
    other_login: {
      reset_password_code: 'reset-code',
      previous_logins: [{ ip_address: '192.0.2.1' }],
    },
    ip_address_registered: '192.0.2.2',
    uploads: [{ mediaId: 'media-id' }],
    token_counter: 9,
    isAdmin: true,
    trusted: true,
    futureSensitiveField: 'future-value',
    ...overrides,
  };
}

function sensitiveUpload(overrides = {}) {
  return {
    _id: 'upload-id',
    mediaType: 'photo',
    mediaId: 'embedded-media-id',
    cloudinaryId: 'camp-pics/private-public-id',
    cloudinaryUrl:
      'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
    cloudinaryPublicId: 'camp-pics/private-public-id',
    youtubeId: null,
    parkId: 'park-id',
    parkName: 'Test Park',
    campgroundId: 'campground-id',
    campgroundName: 'North',
    campsiteId: 'campsite-id',
    campsiteName: '12',
    approved: false,
    moderationState: 'internal',
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    userId: sensitiveUser(),
    futureUploadField: 'future-value',
    ...overrides,
  };
}

function queryModel(records, count) {
  const calls = {
    finds: 0,
    selects: [],
    populates: [],
  };

  return {
    calls,
    model: {
      find() {
        calls.finds += 1;
        const chain = {
          select(value) {
            calls.selects.push(value);
            return chain;
          },
          sort() { return chain; },
          skip() { return chain; },
          limit() { return chain; },
          populate(value) {
            calls.populates.push(value);
            return chain;
          },
          async lean() { return records; },
        };
        return chain;
      },
      async countDocuments() { return count; },
    },
  };
}

async function invokeDashboard(handler, accept) {
  const result = {};
  await handler(
    {
      query: {},
      headers: { accept },
      user: { _id: 'administrator-id' },
    },
    {
      render(view, locals) {
        result.kind = 'render';
        result.view = view;
        result.locals = locals;
        return this;
      },
      json(body) {
        result.kind = 'json';
        result.body = body;
        return this;
      },
    },
    error => {
      throw error;
    },
  );
  return result;
}

describe('administrator dashboard serialization', () => {
  test('users serialize to exactly the seven safe dashboard fields', () => {
    const serialized = serializeAdminUser(sensitiveUser());

    assert.deepEqual(Object.keys(serialized), ADMIN_USER_KEYS);
    assert.deepEqual(serialized, {
      _id: 'user-id',
      fname: 'Camper',
      username: 'camper@example.test',
      date_created: new Date('2026-01-02T00:00:00.000Z'),
      email_verified: true,
      blocked: false,
      userDetailUrl: null,
    });
  });

  test('uploads serialize to exactly the rendered shape without document or uploader IDs', () => {
    const serialized = serializeAdminUpload(sensitiveUpload());

    assert.deepEqual(Object.keys(serialized), ADMIN_UPLOAD_KEYS);
    assert.deepEqual(Object.keys(serialized.uploader), [
      'fname',
      'username',
      'userDetailUrl',
    ]);
    assert.deepEqual(serialized.uploader, {
      fname: 'Camper',
      username: 'camper@example.test',
      userDetailUrl: null,
    });
    assert.equal(
      serialized.adminPhotoUrl,
      'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
    );
    assert.equal('_id' in serialized, false);
    assert.equal('_id' in serialized.uploader, false);
    assert.equal(serialized.parkUrl, null);
    assert.equal(serialized.campgroundUrl, null);
    assert.equal(serialized.campsiteUrl, null);
    assert.equal(serialized.monthlyDrawStatus, null);
    assert.equal(serialized.monthlyDrawLabel, 'Not entered');
    for (const rawId of ['parkId', 'campgroundId', 'campsiteId']) {
      assert.equal(rawId in serialized, false);
    }
  });

  test('uses one safe uploader detail URL and one authoritative draw label contract', () => {
    const userId = '64b7f2d4c9f1e8a123456789';
    assert.deepEqual(ADMIN_UPLOAD_USER_PROJECTION, {
      _id: 1,
      fname: 1,
      username: 1,
    });

    for (const [status, expectedLabel] of [
      ['eligible', 'Eligible'],
      ['pending', 'Eligible (legacy)'],
      ['ineligible', 'Ineligible'],
      ['malformed', 'Not entered'],
      [null, 'Not entered'],
    ]) {
      const upload = sensitiveUpload({
        userId: sensitiveUser({ _id: userId }),
        ...(status === null ? {} : { monthlyDraw: { status } }),
      });
      const serialized = serializeAdminUpload(upload);
      assert.equal(serialized.monthlyDrawLabel, expectedLabel, String(status));
      assert.equal(
        serialized.monthlyDrawStatus,
        ['eligible', 'pending', 'ineligible'].includes(status) ? status : null,
      );
      assert.equal(serialized.uploader.userDetailUrl, `/a/users/${userId}`);
      assert.equal('_id' in serialized.uploader, false);
      assert.equal(JSON.stringify(serialized.uploader).includes(userId), true);
      assert.deepEqual(Object.keys(serialized.uploader), [
        'fname',
        'username',
        'userDetailUrl',
      ]);
    }

    for (const invalidId of [
      null,
      'missing',
      'https://example.test/a/users/64b7f2d4c9f1e8a123456789',
      '//example.test/a/users/64b7f2d4c9f1e8a123456789',
      '/a/users/64b7f2d4c9f1e8a123456789',
    ]) {
      const serialized = serializeAdminUpload(sensitiveUpload({
        userId: sensitiveUser({ _id: invalidId }),
      }));
      assert.equal(serialized.uploader.userDetailUrl, null, String(invalidId));
    }
  });

  test('serializing upload display state does not modify the Upload data', () => {
    const upload = sensitiveUpload({
      monthlyDraw: {
        status: 'eligible',
        monthKey: '2026-08',
        ineligibilityReason: null,
      },
      userId: sensitiveUser({ _id: '64b7f2d4c9f1e8a123456789' }),
    });
    const before = structuredClone(upload);

    serializeAdminUpload(upload);

    assert.deepEqual(upload, before);
  });

  test('initial rendering and JSON pagination share serializers and restrictive queries', async () => {
    const users = queryModel([sensitiveUser()], 1);
    const uploads = queryModel([sensitiveUpload()], 1);
    const handler = createAdminDashboardHandler({
      UserModel: users.model,
      UploadModel: uploads.model,
    });

    const rendered = await invokeDashboard(handler, 'text/html');
    const paginated = await invokeDashboard(handler, 'application/json');

    assert.equal(rendered.kind, 'render');
    assert.equal(rendered.view, 'admin/dashboard');
    assert.equal(paginated.kind, 'json');
    assert.deepEqual(rendered.locals.users, paginated.body.users);
    assert.deepEqual(rendered.locals.uploads, paginated.body.uploads);
    assert.deepEqual(rendered.locals.users, [
      serializeAdminUser(sensitiveUser()),
    ]);
    assert.deepEqual(rendered.locals.uploads, [
      serializeAdminUpload(sensitiveUpload()),
    ]);

    assert.deepEqual(users.calls.selects, [
      ADMIN_USER_PROJECTION,
      ADMIN_USER_PROJECTION,
    ]);
    assert.deepEqual(uploads.calls.selects, [
      ADMIN_UPLOAD_PROJECTION,
      ADMIN_UPLOAD_PROJECTION,
    ]);
    assert.deepEqual(uploads.calls.populates, [
      { path: 'userId', select: ADMIN_UPLOAD_USER_PROJECTION },
      { path: 'userId', select: ADMIN_UPLOAD_USER_PROJECTION },
    ]);
    assert.equal(uploads.calls.finds, 2);
    assert.equal(users.calls.finds, 2);
  });
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

describe('dynamic administrator user rows', () => {
  test('blocked and unblocked rows contain matching POST controls and page CSRF token', async () => {
    const browser = await readFile('public/js/adminDashboard.js', 'utf8');
    const start = browser.indexOf('function createTextElement(');
    const end = browser.indexOf('async function fetchMoreUploads()', start);
    assert.ok(start >= 0 && end > start);
    const functionSource = browser.slice(start, end);

    const document = {
      createElement: tagName => new FakeElement(tagName),
      createTextNode(value) {
        const node = new FakeElement('#text');
        node.textContent = String(value);
        return node;
      },
    };
    const context = {
      document,
      window: {
        CampPicsCsrf: { getToken: () => 'page-csrf-token' },
      },
      encodeURIComponent,
    };
    vm.runInNewContext(
      'const DASHBOARD_USER_DETAIL_URL_PATTERN = ' +
        '/^\\/a\\/users\\/[a-f0-9]{24}$/u;\n' +
        `const csrf = window.CampPicsCsrf;\n${functionSource}\n` +
        'this.createUserRow = createUserRow;',
      context,
    );

    for (const fixture of [
      { blocked: false, action: 'block', label: 'Block' },
      { blocked: true, action: 'unblock', label: 'Unblock' },
    ]) {
      const row = context.createUserRow({
        _id: 'user/id',
        fname: 'Camper',
        username: 'camper@example.test',
        date_created: '2026-01-02T00:00:00.000Z',
        email_verified: fixture.blocked,
        blocked: fixture.blocked,
      });
      const form = findElement(row, element => element.tagName === 'FORM');
      const input = findElement(row, element => element.tagName === 'INPUT');
      const button = findElement(row, element => element.tagName === 'BUTTON');
      const verification = findElement(
        row,
        element => element.className.split(/\s+/u).includes('admin-email-status'),
      );

      assert.equal(form.action, `/a/user/user%2Fid/${fixture.action}`);
      assert.equal(form.method, 'POST');
      assert.equal(form.className, 'inline-form user-status-form');
      assert.equal(form.dataset.action, fixture.action);
      assert.equal(input.type, 'hidden');
      assert.equal(input.name, '_csrf');
      assert.equal(input.value, 'page-csrf-token');
      assert.equal(button.type, 'submit');
      assert.equal(button.className, `${fixture.action}-btn`);
      assert.equal(button.textContent, fixture.label);
      assert.equal(
        verification.textContent,
        fixture.blocked ? 'Verified' : 'Unverified',
      );
      assert.equal(
        verification.className,
        fixture.blocked
          ? 'admin-email-status'
          : 'admin-email-status admin-email-status--unverified',
      );
    }

    assert.doesNotMatch(
      functionSource,
      /innerHTML|outerHTML|insertAdjacentHTML|on(?:click|submit)\s*=/,
    );
    const userStatusBrowser = await readFile(
      'public/js/adminUserStatus.js',
      'utf8',
    );
    assert.match(userStatusBrowser, /confirm\(`\$\{action\} this user\?`\)/);
  });
});
