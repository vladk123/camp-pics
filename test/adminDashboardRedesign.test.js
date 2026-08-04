import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';

import {
  ADMIN_UPLOAD_PROJECTION,
  ADMIN_UPLOAD_USER_PROJECTION,
  ADMIN_USER_PROJECTION,
  createAdminDashboardHandler,
} from '../controllers/admin.js';
import adminRouter from '../routes/admin.js';

const root = process.cwd();
const read = relativePath => readFile(path.join(root, relativePath), 'utf8');
const ADMIN_ID = '74b7f2d4c9f1e8a123456789';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createQueryModel({ records, countDocuments }) {
  const findCalls = [];
  const countCalls = [];
  const model = {
    find(filter) {
      const call = {
        filter,
        limit: null,
        populate: null,
        projection: null,
        skip: null,
        sort: null,
      };
      findCalls.push(call);
      const chain = {
        select(value) {
          call.projection = value;
          return chain;
        },
        sort(value) {
          call.sort = value;
          return chain;
        },
        skip(value) {
          call.skip = value;
          return chain;
        },
        limit(value) {
          call.limit = value;
          return chain;
        },
        populate(value) {
          call.populate = value;
          return chain;
        },
        async lean() {
          return records;
        },
      };
      return chain;
    },
    countDocuments(...args) {
      countCalls.push(args);
      return countDocuments(...args);
    },
  };
  return { countCalls, findCalls, model };
}

function uploadRecord() {
  return {
    mediaType: 'photo',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    parkName: 'Test Park',
    campgroundName: 'North',
    campsiteName: '12',
    cloudinaryUrl: 'https://cdn.example.test/photo.jpg',
    userId: { fname: 'Camper', username: 'camper@example.test' },
  };
}

function userRecord(overrides = {}) {
  const user = {
    _id: '64b7f2d4c9f1e8a123456789',
    fname: 'Camper',
    username: 'camper@example.test',
    date_created: new Date('2026-01-02T00:00:00.000Z'),
    email_verified: true,
    blocked: false,
    ...overrides,
  };
  return {
    ...user,
    userDetailUrl: overrides.userDetailUrl ?? `/a/users/${user._id}`,
  };
}

function invokeDashboard(handler, accept = 'text/html') {
  const result = { logs: [], redirects: [], renders: [] };
  const req = {
    headers: { accept },
    query: {},
    user: { _id: ADMIN_ID },
  };
  const res = {
    json(body) {
      result.body = body;
      result.kind = 'json';
      return this;
    },
    render(view, locals) {
      result.kind = 'render';
      result.renders.push({ locals, view });
      return this;
    },
  };
  return {
    promise: handler(req, res, error => {
      throw error;
    }),
    req,
    res,
    result,
  };
}

describe('administrator dashboard summary controller', () => {
  test('uses concurrent countDocuments calls with exact predicates and unchanged page queries', async () => {
    const pending = {
      uploads: deferred(),
      total: deferred(),
      verified: deferred(),
      blocked: deferred(),
      monthlyDraw: deferred(),
    };
    const uploads = createQueryModel({
      records: [uploadRecord()],
      countDocuments(filter) {
        if (filter === undefined) return 11;
        if (filter?.['monthlyDraw.status'] === 'pending') {
          return pending.monthlyDraw.promise;
        }
        return pending.uploads.promise;
      },
    });
    const users = createQueryModel({
      records: [userRecord()],
      countDocuments(filter) {
        if (filter?._id) return 51;
        if (Object.keys(filter).length === 0) return pending.total.promise;
        if (filter.email_verified === true) return pending.verified.promise;
        return pending.blocked.promise;
      },
    });
    const handler = createAdminDashboardHandler({
      UploadModel: uploads.model,
      UserModel: users.model,
      currentTime: () => new Date('2026-08-03T16:00:00.000Z'),
    });
    const invocation = invokeDashboard(handler);

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(uploads.countCalls, [
      [],
      [{}],
      [{
        'monthlyDraw.monthKey': '2026-08',
        'monthlyDraw.status': 'pending',
      }],
    ]);
    assert.deepEqual(users.countCalls, [
      [{ _id: { $ne: ADMIN_ID } }],
      [{}],
      [{ email_verified: true }],
      [{ blocked: true }],
    ]);
    assert.equal(invocation.result.renders.length, 0);

    pending.uploads.resolve(7);
    pending.total.resolve(60);
    pending.verified.resolve(49);
    pending.blocked.resolve(3);
    pending.monthlyDraw.resolve(4);
    await invocation.promise;

    assert.deepEqual(invocation.result.renders[0].locals.dashboardStats, {
      totalUploads: 7,
      totalUsers: 60,
      verifiedUsers: 49,
      blockedUsers: 3,
      pendingMonthlyDrawUploads: 4,
    });
    assert.equal(
      Object.values(invocation.result.renders[0].locals.dashboardStats)
        .every(value => typeof value === 'number'),
      true,
    );
    assert.deepEqual(uploads.findCalls, [{
      filter: {},
      limit: 10,
      populate: { path: 'userId', select: ADMIN_UPLOAD_USER_PROJECTION },
      projection: ADMIN_UPLOAD_PROJECTION,
      skip: 0,
      sort: { createdAt: -1 },
    }]);
    assert.deepEqual(users.findCalls, [{
      filter: { _id: { $ne: ADMIN_ID } },
      limit: 50,
      populate: null,
      projection: ADMIN_USER_PROJECTION,
      skip: 0,
      sort: { date_created: -1 },
    }]);
  });

  test('keeps pagination JSON exact and does not run or expose summary counts', async () => {
    const uploads = createQueryModel({
      records: [uploadRecord()],
      countDocuments: () => 1,
    });
    const users = createQueryModel({
      records: [userRecord()],
      countDocuments: () => 1,
    });
    const handler = createAdminDashboardHandler({
      UploadModel: uploads.model,
      UserModel: users.model,
    });
    const invocation = invokeDashboard(handler, 'application/json');
    await invocation.promise;

    assert.equal(invocation.result.kind, 'json');
    assert.deepEqual(Object.keys(invocation.result.body), [
      'uploads',
      'users',
      'hasMoreUploads',
      'hasMoreUsers',
    ]);
    assert.deepEqual(uploads.countCalls, [[]]);
    assert.deepEqual(users.countCalls, [[{ _id: { $ne: ADMIN_ID } }]]);
    assert.equal('dashboardStats' in invocation.result.body, false);

    const routePaths = adminRouter.stack
      .filter(layer => layer.route)
      .map(layer => layer.route.path);
    assert.deepEqual(routePaths, [
      '/dashboard',
      '/roadmap',
      '/announcements',
      '/monthly-draw/uploads',
      '/monthly-draw/uploads/:uploadId/status',
      '/users/:userId',
      '/user/:id/block',
      '/user/:id/unblock',
    ]);
  });

  test('count failures and nonnumeric counts reach the existing safe failure boundary', async t => {
    for (const fixture of [
      {
        name: 'rejected count',
        reviewResult: () => Promise.reject(new Error('count failed')),
      },
      { name: 'nonnumeric count', reviewResult: () => '7' },
    ]) {
      await t.test(fixture.name, async () => {
        const uploads = createQueryModel({
          records: [],
          countDocuments(filter) {
            return filter === undefined ? 0 : fixture.reviewResult();
          },
        });
        const users = createQueryModel({
          records: [],
          countDocuments(filter) {
            return filter?._id ? 0 : 0;
          },
        });
        const logCalls = [];
        const redirectCalls = [];
        const handler = createAdminDashboardHandler({
          UploadModel: uploads.model,
          UserModel: users.model,
          log: async (...args) => logCalls.push(args),
          redirectWithFlash: (...args) => {
            redirectCalls.push(args);
            return { redirected: true };
          },
        });
        const invocation = invokeDashboard(handler);
        const response = await invocation.promise;

        assert.deepEqual(response, { redirected: true });
        assert.equal(invocation.result.renders.length, 0);
        assert.equal(logCalls.length, 1);
        assert.deepEqual(logCalls[0].slice(2, 4), [
          'error',
          {
            message: 'Admin dashboard failed to load.',
            error: logCalls[0][3].error,
          },
        ]);
        assert.deepEqual(redirectCalls[0].slice(2), [
          'error',
          'Failed to load dashboard.',
          '/',
        ]);
      });
    }
  });
});

async function renderDashboard(overrides = {}) {
  const filename = path.join(root, 'views/admin/dashboard.ejs');
  const source = await read('views/admin/dashboard.ejs');
  return ejs.render(source, {
    csrfToken: 'page-csrf-token',
    dashboardStats: {
      totalUploads: 4,
      totalUsers: 20,
      verifiedUsers: 15,
      blockedUsers: 2,
      pendingMonthlyDrawUploads: 3,
    },
    monthlyDrawMonthKey: '2026-08',
    data: { currentPath: '/a/dashboard' },
    extractYouTubeVideoId: () => null,
    hasMoreUploads: true,
    hasMoreUsers: true,
    layout: () => {},
    uploadPage: 1,
    uploads: [],
    userPage: 1,
    users: [],
    ...overrides,
  }, { filename });
}

describe('administrator dashboard rendering', () => {
  test('renders the operational layout, escaped fixtures, statuses and existing forms', async () => {
    const hostile = '</span><script id="dashboard-xss">attack()</script>';
    const html = await renderDashboard({
      extractYouTubeVideoId: value => value === 'safe-video'
        ? 'abc123DEF45'
        : null,
      uploads: [
        {
          adminPhotoUrl: 'https://cdn.example.test/photo.jpg',
          cloudinaryPublicId: 'must-not-render-public-id',
          campgroundName: hostile,
          campsiteName: hostile,
          createdAt: '2026-08-01T00:00:00.000Z',
          mediaType: 'photo',
          parkName: hostile,
          uploader: { fname: hostile, username: hostile },
        },
      ],
      users: [
        userRecord({
          fname: hostile,
          hash: 'must-not-render-password-hash',
          username: hostile,
        }),
        userRecord({
          _id: '64b7f2d4c9f1e8a123456780',
          blocked: true,
          email_verified: false,
        }),
      ],
    });

    assert.match(html, /aria-label="Administrator pages"/u);
    assert.equal((html.match(/<h1\b/gu) || []).length, 1);
    assert.match(html, /<h1>Admin dashboard<\/h1>/u);
    assert.match(html, /href="\/a\/roadmap">Roadmap<\/a>/u);
    assert.match(html, /href="\/">View public site<\/a>/u);
    for (const [label, value] of [
      ['Total uploads', 4],
      ['Total users', 20],
      ['Verified users', 15],
      ['Blocked users', 2],
    ]) {
      assert.match(html, new RegExp(`${label}[\\s\\S]*?>${value}<`, 'u'));
    }
    assert.match(html, /Tracked upload records/u);
    assert.match(html, /Includes administrators/u);
    assert.doesNotMatch(html, /Needs review|Uploads not yet approved/u);
    assert.match(html, /id="admin-uploads-heading">Recent uploads<\/h2>/u);
    assert.match(html, /class="upload-item admin-upload-card"/u);
    assert.match(html, /id="admin-users-heading">Users<\/h2>/u);
    assert.match(html, /class="user-item admin-user-row"/u);
    assert.match(html, />\s*Verified\s*<\/span>/u);
    assert.match(html, />\s*Unverified\s*<\/span>/u);
    assert.match(html, />\s*Active\s*<\/span>/u);
    assert.match(html, />\s*Blocked\s*<\/span>/u);
    assert.match(html, /action="\/a\/user\/64b7f2d4c9f1e8a123456789\/block"/u);
    assert.match(html, /action="\/a\/user\/64b7f2d4c9f1e8a123456780\/unblock"/u);
    assert.equal((html.match(/name="_csrf" value="page-csrf-token"/gu) || []).length, 2);
    assert.equal((html.match(/aria-live="polite"/gu) || []).length, 2);
    assert.match(html, /href="\/css\/adminDashboard\.css"/u);
    assert.equal(html.includes(hostile), false);
    assert.match(html, /&lt;\/span&gt;&lt;script/u);
    assert.equal(html.includes('dashboard-xss'), true);
    assert.doesNotMatch(html, /<script id="dashboard-xss">/u);
    assert.equal(html.includes('must-not-render-public-id'), false);
    assert.equal(html.includes('must-not-render-password-hash'), false);

    const active = html.replace(/<!--[\s\S]*?-->/gu, '');
    assert.doesNotMatch(active, /<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu);
    assert.equal(
      [...active.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)]
        .every(match => /\bsrc\s*=/.test(match[1]) && match[2].trim() === ''),
      true,
    );
  });

  test('renders accurate empty states and preserves initial Load More visibility', async () => {
    const empty = await renderDashboard({
      hasMoreUploads: false,
      hasMoreUsers: false,
    });
    assert.match(empty, /id="uploadsEmpty" class="admin-empty-state">\s*No tracked uploads found\./u);
    assert.match(empty, /id="usersEmpty" class="admin-empty-state">\s*No users found\./u);
    assert.doesNotMatch(empty, /id="loadMoreUploads"/u);
    assert.doesNotMatch(empty, /id="loadMoreUsers"/u);

    const mixed = await renderDashboard({
      hasMoreUploads: true,
      hasMoreUsers: false,
    });
    assert.match(mixed, /id="loadMoreUploads"/u);
    assert.doesNotMatch(mixed, /id="loadMoreUsers"/u);
  });
});

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.removed = false;
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      contains: value => classes.has(value),
      remove: (...values) => values.forEach(value => classes.delete(value)),
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  closest(selector) {
    return selector === '.user-status-form' &&
      this.className.split(/\s+/u).includes('user-status-form')
      ? this
      : null;
  }

  remove() {
    this.removed = true;
  }

  replaceChildren(...children) {
    this.children = [];
    this.textContent = '';
    this.append(...children);
  }
}

function findAll(rootElement, predicate) {
  const matches = predicate(rootElement) ? [rootElement] : [];
  for (const child of rootElement.children) {
    matches.push(...findAll(child, predicate));
  }
  return matches;
}

function combinedText(element) {
  return element.textContent + element.children.map(combinedText).join('');
}

function createBrowserHarness({
  uploadPage = '1',
  userPage = '1',
  fetchImplementation,
} = {}) {
  const state = new FakeElement('div');
  Object.assign(state.dataset, { uploadPage, userPage });
  const uploads = new FakeElement('div');
  const users = new FakeElement('tbody');
  const uploadButton = new FakeElement('button');
  uploadButton.textContent = 'Load more uploads';
  const userButton = new FakeElement('button');
  userButton.textContent = 'Load more users';
  const uploadsStatus = new FakeElement('p');
  const usersStatus = new FakeElement('p');
  const uploadsEmpty = new FakeElement('p');
  const usersEmpty = new FakeElement('p');
  const uploadsVisibleCount = new FakeElement('span');
  const usersVisibleCount = new FakeElement('span');
  const elements = new Map([
    ['admin-dashboard-state', state],
    ['uploads', uploads],
    ['users', users],
    ['loadMoreUploads', uploadButton],
    ['loadMoreUsers', userButton],
    ['uploadsStatus', uploadsStatus],
    ['usersStatus', usersStatus],
    ['uploadsEmpty', uploadsEmpty],
    ['usersEmpty', usersEmpty],
    ['uploadsVisibleCount', uploadsVisibleCount],
    ['usersVisibleCount', usersVisibleCount],
  ]);
  const documentListeners = new Map();
  const document = {
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    createElement: tagName => new FakeElement(tagName),
    getElementById: id => elements.get(id) || null,
  };
  const fetchCalls = [];
  const mediaCalls = { images: [], photoUrls: [], youtubeValues: [] };
  const confirmCalls = [];
  let confirmResult = true;
  const window = {
    CampPicsCsrf: { getToken: () => 'page-csrf-token' },
    CampPicsMedia: {
      createImageElement(options) {
        mediaCalls.images.push(options);
        const image = new FakeElement('img');
        Object.assign(image, options);
        return image;
      },
      extractYouTubeId(value) {
        mediaCalls.youtubeValues.push(value);
        return value === 'https://youtu.be/abc123DEF45'
          ? 'abc123DEF45'
          : null;
      },
      getSafeHttpUrl(value) {
        mediaCalls.photoUrls.push(value);
        return typeof value === 'string' && value.startsWith('https://')
          ? value
          : null;
      },
    },
    confirm(message) {
      confirmCalls.push(message);
      return confirmResult;
    },
  };
  const context = vm.createContext({
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ options, url });
      return fetchImplementation(url, options);
    },
    window,
  });

  return {
    confirmCalls,
    context,
    documentListeners,
    fetchCalls,
    mediaCalls,
    setConfirmResult(value) {
      confirmResult = value;
    },
    state,
    uploadButton,
    uploads,
    uploadsEmpty,
    uploadsStatus,
    uploadsVisibleCount,
    userButton,
    users,
    usersEmpty,
    usersStatus,
    usersVisibleCount,
    window,
  };
}

describe('administrator dashboard browser behavior', () => {
  test('builds equivalent safe upload and user structures with unchanged controls', async () => {
    const source = await read('public/js/adminDashboard.js');
    const userStatusSource = await read('public/js/adminUserStatus.js');
    const hostile = '<img src=x onerror=alert(1)><script>attack()</script>';
    const harness = createBrowserHarness({
      fetchImplementation: async url => ({
        ok: true,
        async json() {
          return url.includes('uploadPage')
            ? {
                uploads: [{
                  adminPhotoUrl: 'https://cdn.example.test/photo.jpg',
                  campgroundName: hostile,
                  campsiteName: hostile,
                  createdAt: '2026-08-01T00:00:00.000Z',
                  mediaType: 'photo',
                  parkName: hostile,
                  uploader: { fname: hostile, username: hostile },
                }],
                hasMoreUploads: false,
              }
            : {
                users: [userRecord({
                  _id: 'user/id',
                  blocked: false,
                  email_verified: false,
                  fname: hostile,
                  username: hostile,
                })],
                hasMoreUsers: false,
              };
        },
      }),
    });
    const initialWindowKeys = Object.keys(harness.window).sort();
    vm.runInContext(userStatusSource, harness.context);
    vm.runInContext(source, harness.context);
    await harness.uploadButton.listeners.get('click')[0]();
    await harness.userButton.listeners.get('click')[0]();

    assert.deepEqual(Object.keys(harness.window).sort(), initialWindowKeys);
    assert.equal(harness.uploads.children[0].tagName, 'ARTICLE');
    assert.equal(
      harness.uploads.children[0].className,
      'upload-item admin-upload-card',
    );
    assert.equal(combinedText(harness.uploads.children[0]).includes(hostile), true);
    assert.deepEqual(harness.mediaCalls.photoUrls, [
      'https://cdn.example.test/photo.jpg',
    ]);
    assert.equal(harness.mediaCalls.images.length, 1);

    const userRow = harness.users.children[0];
    assert.equal(userRow.tagName, 'TR');
    assert.equal(userRow.className, 'user-item admin-user-row');
    assert.deepEqual(
      userRow.children.map(cell => cell.dataset.label),
      ['User', 'Email status', 'Account status', 'Joined', 'Action'],
    );
    assert.equal(combinedText(userRow).includes(hostile), true);
    const form = findAll(userRow, element => element.tagName === 'FORM')[0];
    const csrfField = findAll(form, element => element.tagName === 'INPUT')[0];
    const button = findAll(form, element => element.tagName === 'BUTTON')[0];
    assert.equal(form.action, '/a/user/user%2Fid/block');
    assert.equal(form.method, 'POST');
    assert.equal(form.dataset.action, 'block');
    assert.equal(csrfField.name, '_csrf');
    assert.equal(csrfField.value, 'page-csrf-token');
    assert.equal(button.className, 'block-btn');

    let prevented = 0;
    harness.setConfirmResult(false);
    harness.documentListeners.get('submit')[0]({
      preventDefault: () => { prevented += 1; },
      target: form,
    });
    assert.equal(prevented, 1);
    assert.deepEqual(harness.confirmCalls, ['Block this user?']);
    assert.equal(harness.uploadButton.removed, true);
    assert.equal(harness.userButton.removed, true);
    assert.equal(harness.uploadsEmpty.hidden, true);
    assert.equal(harness.usersEmpty.hidden, true);
    assert.equal(harness.uploadsVisibleCount.textContent, '1');
    assert.equal(harness.usersVisibleCount.textContent, '1');
  });

  test('isolates loading state, prevents duplicate requests and permits retry after failure', async () => {
    const source = await read('public/js/adminDashboard.js');
    const requests = [];
    const harness = createBrowserHarness({
      uploadPage: '01',
      userPage: 'not-a-page',
      fetchImplementation: (url, options) => {
        const pending = deferred();
        requests.push({ ...pending, options, url });
        return pending.promise;
      },
    });
    vm.runInContext(source, harness.context);
    const clickUpload = harness.uploadButton.listeners.get('click')[0];
    const first = clickUpload();
    const duplicate = clickUpload();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/a/dashboard?uploadPage=2');
    assert.deepEqual(
      JSON.parse(JSON.stringify(requests[0].options.headers)),
      { Accept: 'application/json' },
    );
    assert.equal(harness.uploadButton.disabled, true);
    assert.equal(harness.uploadButton.textContent, 'Loading\u2026');
    assert.equal(harness.userButton.disabled, false);
    assert.equal(harness.userButton.textContent, 'Load more users');

    requests[0].resolve({ ok: false, json: async () => ({}) });
    await Promise.all([first, duplicate]);
    assert.equal(harness.uploadButton.disabled, false);
    assert.equal(harness.uploadButton.textContent, 'Load more uploads');
    assert.equal(
      harness.uploadsStatus.textContent,
      'Unable to load more uploads. Please try again.',
    );

    const retry = clickUpload();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, '/a/dashboard?uploadPage=2');
    requests[1].resolve({
      ok: true,
      json: async () => ({ uploads: [], hasMoreUploads: true }),
    });
    await retry;
    assert.equal(harness.uploadButton.disabled, false);
    assert.equal(harness.uploadButton.textContent, 'Load more uploads');
    assert.equal(harness.uploadsStatus.textContent, '');

    const clickUser = harness.userButton.listeners.get('click')[0];
    const userRequest = clickUser();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, '/a/dashboard?userPage=2');
    assert.equal(harness.userButton.disabled, true);
    assert.equal(harness.uploadButton.disabled, false);
    requests[2].reject(new Error('simulated request failure'));
    await userRequest;
    assert.equal(harness.userButton.disabled, false);
    assert.equal(harness.userButton.textContent, 'Load more users');
    assert.equal(
      harness.usersStatus.textContent,
      'Unable to load more users. Please try again.',
    );
  });

  test('initializes once, creates no public global and tolerates an absent dashboard', async () => {
    const source = await read('public/js/adminDashboard.js');
    const userStatusSource = await read('public/js/adminUserStatus.js');
    const harness = createBrowserHarness({
      fetchImplementation: async () => ({
        ok: true,
        json: async () => ({ uploads: [], users: [] }),
      }),
    });
    const initialWindowKeys = Object.keys(harness.window).sort();
    vm.runInContext(userStatusSource, harness.context);
    vm.runInContext(source, harness.context);
    vm.runInContext(source, harness.context);
    assert.equal(harness.uploadButton.listeners.get('click').length, 1);
    assert.equal(harness.userButton.listeners.get('click').length, 1);
    assert.equal(harness.documentListeners.get('submit').length, 1);
    assert.deepEqual(Object.keys(harness.window).sort(), initialWindowKeys);

    assert.doesNotThrow(() => vm.runInNewContext(source, {
      document: { getElementById: () => null },
      window: {},
    }));
    assert.doesNotMatch(
      `${source}\n${userStatusSource}`,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|setAttribute\s*\(\s*['"]style|\bon[a-z]+\s*=/iu,
    );
  });
});

describe('administrator dashboard responsive source', () => {
  test('contains responsive cards, labelled mobile rows, bounded media and focus states', async () => {
    const css = await read('public/css/adminDashboard.css');
    assert.match(css, /\.admin-summary\s*\{[\s\S]*?display:\s*grid/u);
    assert.match(css, /\.admin-upload-list\s*\{[\s\S]*?display:\s*grid/u);
    assert.match(css, /\.admin-upload-card\s*\{[\s\S]*?grid-template-columns/u);
    assert.match(css, /\.admin-users-table/u);
    assert.match(css, /\.admin-user-cell::before\s*\{[\s\S]*?content:\s*attr\(data-label\)/u);
    assert.match(css, /@media\s*\(max-width:\s*980px\)/u);
    assert.match(css, /@media\s*\(max-width:\s*700px\)/u);
    assert.match(css, /@media\s*\(max-width:\s*520px\)/u);
    assert.match(css, /\.admin-section-actions\s*\{[\s\S]*?flex-wrap:\s*wrap/u);
    assert.match(css, /overflow-wrap:\s*anywhere/u);
    assert.match(css, /overflow:\s*hidden/u);
    assert.match(css, /:focus-visible/u);
    assert.match(css, /\[data-theme="dark"\]\s+\.admin-dashboard-page/u);
  });
});
