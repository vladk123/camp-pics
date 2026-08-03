import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';
import mongoose from 'mongoose';

import {
  ADMIN_PARK_LOCATION_PROJECTION,
  ADMIN_UPLOAD_PROJECTION,
  ADMIN_UPLOAD_USER_PROJECTION,
  createAdminDashboardHandler,
  getAdminCampgroundUrl,
  getAdminParkUrl,
  resolveAdminUploadLocationUrls,
  serializeAdminUpload,
} from '../controllers/admin.js';

const root = process.cwd();
const read = relativePath => readFile(path.join(root, relativePath), 'utf8');
const PARK_A_ID = '64b7f2d4c9f1e8a123456701';
const PARK_B_ID = '64b7f2d4c9f1e8a123456702';
const STALE_PARK_ID = '64b7f2d4c9f1e8a123456703';
const CAMPGROUND_ID = '74b7f2d4c9f1e8a123456701';
const STALE_CAMPGROUND_ID = '74b7f2d4c9f1e8a123456702';

function objectId(value) {
  return new mongoose.Types.ObjectId(value);
}

function uploadRecord(overrides = {}) {
  return {
    mediaType: 'photo',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    parkId: objectId(PARK_A_ID),
    parkName: 'Stale Park Display Name',
    campgroundId: objectId(CAMPGROUND_ID),
    campgroundName: 'Stale Campground Display Name',
    campsiteId: objectId('84b7f2d4c9f1e8a123456701'),
    campsiteName: 'Site 12',
    cloudinaryUrl: 'https://cdn.example.test/photo.jpg',
    userId: { fname: 'Camper', username: 'camper@example.test' },
    ...overrides,
  };
}

function createUploadModel(records) {
  const calls = { counts: [], finds: [] };
  return {
    calls,
    model: {
      find(filter) {
        const call = {
          filter,
          limit: null,
          populate: null,
          projection: null,
          skip: null,
          sort: null,
        };
        calls.finds.push(call);
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
      async countDocuments(...args) {
        calls.counts.push(args);
        return records.length;
      },
    },
  };
}

function createParkModel(records) {
  const calls = [];
  return {
    calls,
    model: {
      find(filter) {
        const call = { filter, leanCalls: 0, projection: null };
        calls.push(call);
        const chain = {
          select(value) {
            call.projection = value;
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

function createUserModel() {
  return {
    find() {
      const chain = {
        select() { return chain; },
        sort() { return chain; },
        skip() { return chain; },
        limit() { return chain; },
        async lean() { return []; },
      };
      return chain;
    },
    async countDocuments() { return 0; },
  };
}

async function invokeJsonDashboard({ uploads, parks }) {
  const uploadState = createUploadModel(uploads);
  const parkState = createParkModel(parks);
  const result = {};
  const handler = createAdminDashboardHandler({
    ParkModel: parkState.model,
    UploadModel: uploadState.model,
    UserModel: createUserModel(),
  });
  await handler(
    {
      headers: { accept: 'application/json' },
      query: {},
      user: { _id: objectId('94b7f2d4c9f1e8a123456701') },
    },
    {
      json(body) {
        result.body = body;
        return this;
      },
    },
    error => { throw error; },
  );
  return { parkState, result, uploadState };
}

describe('administrator upload location lookup', () => {
  test('uses one deduplicated Park query for the bounded page and restrictive projections', async () => {
    const records = [
      uploadRecord(),
      uploadRecord({ campgroundId: null }),
      uploadRecord({ parkId: objectId(PARK_B_ID), campgroundId: null }),
      uploadRecord({ parkId: 'not-an-object-id' }),
    ];
    const { parkState, result, uploadState } = await invokeJsonDashboard({
      uploads: records,
      parks: [
        {
          _id: objectId(PARK_A_ID),
          slug: 'current-park',
          campgrounds: [{ _id: objectId(CAMPGROUND_ID), slug: 'north-loop' }],
        },
        {
          _id: objectId(PARK_B_ID),
          slug: 'second-park',
          campgrounds: [],
        },
      ],
    });

    assert.equal(uploadState.calls.finds.length, 1);
    assert.deepEqual(uploadState.calls.finds[0], {
      filter: {},
      limit: 10,
      populate: { path: 'userId', select: ADMIN_UPLOAD_USER_PROJECTION },
      projection: ADMIN_UPLOAD_PROJECTION,
      skip: 0,
      sort: { createdAt: -1 },
    });
    assert.equal(ADMIN_UPLOAD_PROJECTION.parkId, 1);
    assert.equal(ADMIN_UPLOAD_PROJECTION.campgroundId, 1);

    assert.equal(parkState.calls.length, 1);
    assert.deepEqual(parkState.calls[0].projection, ADMIN_PARK_LOCATION_PROJECTION);
    assert.equal(parkState.calls[0].leanCalls, 1);
    assert.deepEqual(
      parkState.calls[0].filter._id.$in.map(id => id.toHexString()),
      [PARK_A_ID, PARK_B_ID],
    );
    assert.deepEqual(ADMIN_PARK_LOCATION_PROJECTION, {
      _id: 1,
      slug: 1,
      'campgrounds._id': 1,
      'campgrounds.slug': 1,
    });

    assert.deepEqual(Object.keys(result.body), [
      'uploads',
      'users',
      'hasMoreUploads',
      'hasMoreUsers',
    ]);
    assert.equal(result.body.uploads[0].parkUrl, '/camp/park/current-park');
    assert.equal(
      result.body.uploads[0].campgroundUrl,
      '/camp/park/current-park#north-loop',
    );
    assert.equal(result.body.uploads[1].parkUrl, '/camp/park/current-park');
    assert.equal(result.body.uploads[1].campgroundUrl, null);
    assert.equal(result.body.uploads[2].parkUrl, '/camp/park/second-park');
    assert.equal(result.body.uploads[2].campgroundUrl, null);
    assert.equal(result.body.uploads[3].parkUrl, null);
    assert.equal(result.body.uploads[3].campgroundUrl, null);

    for (const serialized of result.body.uploads) {
      assert.deepEqual(Object.keys(serialized), [
        'mediaType',
        'createdAt',
        'parkName',
        'campgroundName',
        'campsiteName',
        'parkUrl',
        'campgroundUrl',
        'youtubeId',
        'adminPhotoUrl',
        'uploader',
      ]);
      for (const rawId of ['parkId', 'campgroundId', 'campsiteId']) {
        assert.equal(rawId in serialized, false);
      }
    }
    assert.doesNotMatch(
      JSON.stringify(result.body),
      new RegExp(`${PARK_A_ID}|${PARK_B_ID}|${CAMPGROUND_ID}`, 'u'),
    );
  });

  test('performs no Park query for an empty upload page', async () => {
    const { parkState, result } = await invokeJsonDashboard({
      uploads: [],
      parks: [],
    });

    assert.equal(parkState.calls.length, 0);
    assert.deepEqual(result.body.uploads, []);
  });
});

describe('administrator upload location URL resolution', () => {
  test('generates only validated current Park and Campground URLs', () => {
    assert.equal(getAdminParkUrl('current-park'), '/camp/park/current-park');
    assert.equal(
      getAdminCampgroundUrl('current-park', 'north-loop'),
      '/camp/park/current-park#north-loop',
    );

    for (const unsafeSlug of [
      '',
      'UPPERCASE',
      '-leading',
      'trailing-',
      'two--hyphens',
      'path/segment',
      'path\\segment',
      'park?query=1',
      'park#fragment',
      'https://example.test',
      `control${String.fromCharCode(10)}value`,
    ]) {
      assert.equal(getAdminParkUrl(unsafeSlug), null, unsafeSlug);
      assert.equal(getAdminCampgroundUrl('current-park', unsafeSlug), null, unsafeSlug);
    }
    assert.equal(getAdminCampgroundUrl('bad/park', 'north-loop'), null);
  });

  test('matches current embedded IDs, preserves Park-only links and ignores names', () => {
    const currentPark = {
      _id: objectId(PARK_A_ID),
      slug: 'authoritative-current-park',
      campgrounds: [{
        _id: objectId(CAMPGROUND_ID),
        slug: 'authoritative-current-campground',
      }],
    };
    const parks = new Map([[PARK_A_ID, currentPark]]);

    assert.deepEqual(resolveAdminUploadLocationUrls(uploadRecord({
      parkName: 'name-that-must-not-be-slugged',
      campgroundName: 'another-stale-name',
    }), parks), {
      parkUrl: '/camp/park/authoritative-current-park',
      campgroundUrl:
        '/camp/park/authoritative-current-park#authoritative-current-campground',
    });
    assert.deepEqual(resolveAdminUploadLocationUrls(uploadRecord({
      campgroundId: null,
    }), parks), {
      parkUrl: '/camp/park/authoritative-current-park',
      campgroundUrl: null,
    });
    assert.deepEqual(resolveAdminUploadLocationUrls(uploadRecord({
      campgroundId: objectId(STALE_CAMPGROUND_ID),
    }), parks), {
      parkUrl: '/camp/park/authoritative-current-park',
      campgroundUrl: null,
    });
    assert.deepEqual(resolveAdminUploadLocationUrls(uploadRecord({
      parkId: objectId(STALE_PARK_ID),
    }), parks), {
      parkUrl: null,
      campgroundUrl: null,
    });

    currentPark.slug = 'unsafe/park';
    assert.deepEqual(resolveAdminUploadLocationUrls(uploadRecord(), parks), {
      parkUrl: null,
      campgroundUrl: null,
    });
    currentPark.slug = 'safe-park';
    currentPark.campgrounds[0].slug = 'unsafe?campground';
    assert.deepEqual(resolveAdminUploadLocationUrls(uploadRecord(), parks), {
      parkUrl: '/camp/park/safe-park',
      campgroundUrl: null,
    });
  });

  test('serializer rejects injected URL values and exposes no raw location IDs', () => {
    const serialized = serializeAdminUpload(uploadRecord(), {
      parkUrl: 'https://evil.example/camp/park/current-park',
      campgroundUrl: '/camp/park/current-park#north-loop?attack=1',
    });

    assert.equal(serialized.parkUrl, null);
    assert.equal(serialized.campgroundUrl, null);

    const mismatched = serializeAdminUpload(uploadRecord(), {
      parkUrl: '/camp/park/current-park',
      campgroundUrl: '/camp/park/different-park#north-loop',
    });
    assert.equal(mismatched.parkUrl, '/camp/park/current-park');
    assert.equal(mismatched.campgroundUrl, null);

    const campgroundWithoutPark = serializeAdminUpload(uploadRecord(), {
      campgroundUrl: '/camp/park/current-park#north-loop',
    });
    assert.equal(campgroundWithoutPark.parkUrl, null);
    assert.equal(campgroundWithoutPark.campgroundUrl, null);
    for (const rawId of ['parkId', 'campgroundId', 'campsiteId']) {
      assert.equal(rawId in serialized, false);
    }
  });
});

async function renderDashboard(uploads) {
  const filename = path.join(root, 'views/admin/dashboard.ejs');
  return ejs.render(await read('views/admin/dashboard.ejs'), {
    csrfToken: 'csrf-token',
    dashboardStats: {
      totalUploads: uploads.length,
      totalUsers: 0,
      verifiedUsers: 0,
      blockedUsers: 0,
    },
    data: { currentPath: '/a/dashboard' },
    extractYouTubeVideoId: () => null,
    hasMoreUploads: false,
    hasMoreUsers: false,
    layout: () => {},
    uploadPage: 1,
    uploads,
    userPage: 1,
    users: [],
  }, { filename });
}

describe('server-rendered administrator location links', () => {
  test('links valid escaped names and renders null or malicious URLs as text', async () => {
    const hostile = '<script id="location-xss">attack()</script>';
    const linked = serializeAdminUpload(uploadRecord({
      parkName: hostile,
      campgroundName: hostile,
      campsiteName: hostile,
    }), {
      parkUrl: '/camp/park/current-park',
      campgroundUrl: '/camp/park/current-park#north-loop',
    });
    const plain = serializeAdminUpload(uploadRecord({
      parkName: 'Plain Park',
      campgroundName: 'Plain Campground',
      campsiteName: 'Plain Campsite',
    }));
    const rejected = serializeAdminUpload(uploadRecord({
      parkName: 'Rejected Park URL',
      campgroundName: 'Rejected Campground URL',
    }), {
      parkUrl: '//evil.example/camp/park/current-park',
      campgroundUrl: 'javascript:alert(1)',
    });
    const html = await renderDashboard([linked, plain, rejected]);

    assert.match(
      html,
      /<a class="admin-upload-card__location-link" href="\/camp\/park\/current-park" target="_blank" rel="noopener noreferrer">/u,
    );
    assert.match(
      html,
      /<a class="admin-upload-card__location-link" href="\/camp\/park\/current-park#north-loop" target="_blank" rel="noopener noreferrer">/u,
    );
    assert.equal(
      (html.match(/class="admin-upload-card__location-link"/gu) || []).length,
      2,
    );
    assert.equal(html.includes(hostile), false);
    assert.doesNotMatch(html, /<script id="location-xss">/u);
    assert.match(html, /&lt;script id=&#34;location-xss&#34;&gt;/u);
    assert.match(html, /<dd>\s*Plain Park\s*<\/dd>/u);
    assert.match(html, /<dd>\s*Plain Campground\s*<\/dd>/u);
    assert.match(html, /<dd>\s*Plain Campsite\s*<\/dd>/u);
    assert.match(html, /<dd>\s*Rejected Park URL\s*<\/dd>/u);
    assert.match(html, /<dd>\s*Rejected Campground URL\s*<\/dd>/u);
    assert.doesNotMatch(html, /evil\.example|javascript:alert/u);
    assert.doesNotMatch(
      html,
      new RegExp(`${PARK_A_ID}|${CAMPGROUND_ID}`, 'u'),
    );
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
      remove: (...values) => values.forEach(value => classes.delete(value)),
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    this.children.push(...children);
  }

  closest() {
    return null;
  }

  remove() {
    this.removed = true;
  }

  replaceChildren(...children) {
    this.children = [...children];
    this.textContent = '';
  }
}

function findAll(element, predicate) {
  const matches = predicate(element) ? [element] : [];
  for (const child of element.children) {
    matches.push(...findAll(child, predicate));
  }
  return matches;
}

function combinedText(element) {
  return element.textContent + element.children.map(combinedText).join('');
}

function createBrowserHarness(uploadPayload) {
  const state = new FakeElement();
  Object.assign(state.dataset, { uploadPage: '1', userPage: '1' });
  const uploads = new FakeElement();
  const uploadButton = new FakeElement('button');
  uploadButton.textContent = 'Load more uploads';
  const elements = new Map([
    ['admin-dashboard-state', state],
    ['uploads', uploads],
    ['users', new FakeElement('tbody')],
    ['loadMoreUploads', uploadButton],
    ['loadMoreUsers', new FakeElement('button')],
    ['uploadsStatus', new FakeElement('p')],
    ['usersStatus', new FakeElement('p')],
    ['uploadsEmpty', new FakeElement('p')],
    ['usersEmpty', new FakeElement('p')],
    ['uploadsVisibleCount', new FakeElement('span')],
    ['usersVisibleCount', new FakeElement('span')],
  ]);
  const fetchCalls = [];
  const document = {
    addEventListener() {},
    createElement: tagName => new FakeElement(tagName),
    getElementById: id => elements.get(id) || null,
  };
  const window = { CampPicsCsrf: { getToken: () => 'csrf-token' } };
  const context = vm.createContext({
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ options, url });
      return {
        ok: true,
        async json() { return uploadPayload; },
      };
    },
    window,
  });
  return { context, fetchCalls, uploadButton, uploads, window };
}

describe('dynamically loaded administrator location links', () => {
  test('accepts only exact internal URLs and otherwise retains visible text', async () => {
    const fixtures = [
      {
        parkName: 'Valid Park',
        parkUrl: '/camp/park/valid-park',
        campgroundName: 'Valid Campground',
        campgroundUrl: '/camp/park/valid-park#valid-campground',
      },
      {
        parkName: 'External Park',
        parkUrl: 'https://evil.example/camp/park/valid-park',
        campgroundName: 'Protocol Relative Campground',
        campgroundUrl: '//evil.example/camp/park/valid-park',
      },
      {
        parkName: 'Query Park',
        parkUrl: '/camp/park/valid-park?attack=1',
        campgroundName: 'Query Campground',
        campgroundUrl: '/camp/park/valid-park#valid-campground?attack=1',
      },
      {
        parkName: 'Backslash Park',
        parkUrl: '\\camp\\park\\valid-park',
        campgroundName: 'Malformed Fragment Campground',
        campgroundUrl: '/camp/park/valid-park##valid-campground',
      },
      {
        parkName: 'Fragment Park',
        parkUrl: '/camp/park/valid-park#wrong-shape',
        campgroundName: 'Fragmentless Campground',
        campgroundUrl: '/camp/park/valid-park',
      },
      {
        parkName: 'Park Link Survives',
        parkUrl: '/camp/park/valid-park',
        campgroundName: 'Rejected Campground',
        campgroundUrl: 'javascript:alert(1)',
        campsiteName: 'Campsite Remains Text',
      },
    ].map((fixture, index) => ({
      createdAt: '2026-08-01T00:00:00.000Z',
      mediaType: 'unknown',
      uploader: { fname: `Camper ${index}`, username: null },
      ...fixture,
    }));
    const source = await read('public/js/adminDashboard.js');
    const harness = createBrowserHarness({
      uploads: fixtures,
      hasMoreUploads: false,
    });
    const initialWindowKeys = Object.keys(harness.window).sort();

    vm.runInContext(source, harness.context);
    await harness.uploadButton.listeners.get('click')[0]();

    assert.deepEqual(harness.fetchCalls.map(call => call.url), [
      '/a/dashboard?uploadPage=2',
    ]);
    assert.equal(harness.uploadButton.removed, true);
    assert.equal(harness.uploads.children.length, fixtures.length);
    assert.deepEqual(Object.keys(harness.window).sort(), initialWindowKeys);

    const anchorsByRow = harness.uploads.children.map(row => findAll(
      row,
      element => element.tagName === 'A' &&
        element.className === 'admin-upload-card__location-link',
    ));
    assert.deepEqual(
      anchorsByRow.map(anchors => anchors.length),
      [2, 0, 0, 0, 0, 1],
    );
    assert.deepEqual(anchorsByRow[0].map(link => ({
      href: link.href,
      rel: link.rel,
      target: link.target,
      text: link.textContent,
    })), [
      {
        href: '/camp/park/valid-park',
        rel: 'noopener noreferrer',
        target: '_blank',
        text: 'Valid Park',
      },
      {
        href: '/camp/park/valid-park#valid-campground',
        rel: 'noopener noreferrer',
        target: '_blank',
        text: 'Valid Campground',
      },
    ]);
    assert.equal(anchorsByRow[5][0].textContent, 'Park Link Survives');
    for (let index = 0; index < fixtures.length; index += 1) {
      assert.equal(
        combinedText(harness.uploads.children[index]).includes(fixtures[index].parkName),
        true,
      );
      assert.equal(
        combinedText(harness.uploads.children[index]).includes(fixtures[index].campgroundName),
        true,
      );
    }
    assert.equal(
      findAll(
        harness.uploads.children[5],
        element => element.tagName === 'A' &&
          element.textContent === 'Campsite Remains Text',
      ).length,
      0,
    );
    assert.doesNotMatch(
      source,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|\bon[a-z]+\s*=/iu,
    );
  });
});
