import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import * as camp from '../controllers/camp.js';
import campRouter from '../routes/camp.js';

const helperSource = await readFile(
  new URL('../public/js/campsiteLocation.js', import.meta.url),
  'utf8',
);
const showParkSource = await readFile(
  new URL('../public/js/showPark.js', import.meta.url),
  'utf8',
);
const appSource = await readFile(
  new URL('../app.js', import.meta.url),
  'utf8',
);

function loadBrowserHelper(document = {}) {
  const window = {
    document,
    CSS: {
      escape: value => String(value),
    },
  };
  window.window = window;
  vm.runInNewContext(helperSource, { window });
  return window.CampPicsCampsiteLocation;
}

function routeEntries() {
  return campRouter.stack
    .filter(layer => layer.route)
    .flatMap(layer =>
      Object.keys(layer.route.methods)
        .filter(method => layer.route.methods[method])
        .map(method => ({
          method: method.toUpperCase(),
          path: layer.route.path,
          handlers: layer.route.stack.map(routeLayer => routeLayer.handle),
        })),
    );
}

const campsiteRouteMatrix = [
  ['GET', '/park/:parkSlug/campsite/:campsiteSlug'],
  ['GET', '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug'],
  ['POST', '/park/:parkSlug/campsite/:campsiteSlug/photo'],
  ['POST', '/park/:parkSlug/campsite/:campsiteSlug/video'],
  ['POST', '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo'],
  ['POST', '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video'],
  ['DELETE', '/park/:parkSlug/campsite/:campsiteSlug/photo/:photoId'],
  ['DELETE', '/park/:parkSlug/campsite/:campsiteSlug/video/:videoId'],
  ['DELETE', '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo/:photoId'],
  ['DELETE', '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video/:videoId'],
];

test('every campsite API/upload/delete route exists exactly once', () => {
  const entries = routeEntries();

  for (const [method, path] of campsiteRouteMatrix) {
    const matches = entries.filter(entry =>
      entry.method === method && entry.path === path);
    assert.equal(matches.length, 1, `${method} ${path}`);
  }
});

test('public park HTML and campsite JSON GET routes keep distinct handlers', () => {
  const entries = routeEntries();
  const parkPage = entries.find(entry =>
    entry.method === 'GET' && entry.path === '/park/:parkSlug');
  const standaloneApi = entries.find(entry =>
    entry.method === 'GET' &&
    entry.path === '/park/:parkSlug/campsite/:campsiteSlug');
  const campgroundApi = entries.find(entry =>
    entry.method === 'GET' &&
    entry.path ===
      '/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug');

  assert.equal(parkPage.handlers.at(-1), camp.showPark);
  assert.equal(standaloneApi.handlers.at(-1), camp.getCampsite);
  assert.equal(
    campgroundApi.handlers.at(-1),
    camp.getCampgroundCampsite,
  );
  assert.notEqual(standaloneApi.handlers.at(-1), camp.showPark);
  assert.notEqual(campgroundApi.handlers.at(-1), camp.showPark);
});

test('every campsite POST/DELETE route preserves authentication and global CSRF coverage', () => {
  const entries = routeEntries();
  const unsafeRoutes = campsiteRouteMatrix.filter(([method]) => method !== 'GET');

  for (const [method, path] of unsafeRoutes) {
    const route = entries.find(entry =>
      entry.method === method && entry.path === path);
    assert.equal(route.handlers[0].name, 'isLoggedIn', `${method} ${path}`);
  }

  const csrfPosition = appSource.indexOf('app.use(csrfSynchronisedProtection)');
  const campMountPosition = appSource.indexOf("app.use('/camp', campRoutes)");
  assert.ok(csrfPosition >= 0);
  assert.ok(campMountPosition > csrfPosition);
});

describe('browser campsite location helper', () => {
  test('all API/upload/delete URLs preserve the exact target scope', () => {
    const helper = loadBrowserHelper();
    const standalone = {
      parkSlug: 'test park',
      campsiteSlug: '12/A',
      campgroundSlug: null,
    };
    const nested = {
      parkSlug: 'test park',
      campsiteSlug: '12/A',
      campgroundSlug: 'north loop',
    };

    assert.equal(
      helper.apiUrl(standalone),
      '/camp/park/test%20park/campsite/12%2FA',
    );
    assert.equal(
      helper.photoUploadUrl(standalone),
      '/camp/park/test%20park/campsite/12%2FA/photo',
    );
    assert.equal(
      helper.videoUploadUrl(standalone),
      '/camp/park/test%20park/campsite/12%2FA/video',
    );
    assert.equal(
      helper.photoDeleteUrl(standalone, 'photo/1'),
      '/camp/park/test%20park/campsite/12%2FA/photo/photo%2F1',
    );
    assert.equal(
      helper.videoDeleteUrl(standalone, 'video/1'),
      '/camp/park/test%20park/campsite/12%2FA/video/video%2F1',
    );

    assert.equal(
      helper.apiUrl(nested),
      '/camp/park/test%20park/campground/north%20loop/campsite/12%2FA',
    );
    assert.equal(
      helper.photoUploadUrl(nested),
      '/camp/park/test%20park/campground/north%20loop/campsite/12%2FA/photo',
    );
    assert.equal(
      helper.videoUploadUrl(nested),
      '/camp/park/test%20park/campground/north%20loop/campsite/12%2FA/video',
    );
    assert.equal(
      helper.photoDeleteUrl(nested, 'photo-id'),
      '/camp/park/test%20park/campground/north%20loop/campsite/12%2FA/photo/photo-id',
    );
    assert.equal(
      helper.videoDeleteUrl(nested, 'video-id'),
      '/camp/park/test%20park/campground/north%20loop/campsite/12%2FA/video/video-id',
    );
  });

  test('canonical API location replaces stale modal dataset values', () => {
    const helper = loadBrowserHelper();
    const modal = {
      dataset: {
        parkSlug: 'park',
        campsiteSlug: 'old-site',
        campgroundSlug: 'old-campground',
        locationKind: 'campground-campsite',
      },
    };

    helper.applyCanonicalLocation(modal, {
      slug: 'standalone-12',
      campgroundSlug: 'stale-client-value',
      locationKind: 'standalone-campsite',
    });

    assert.deepEqual(
      { ...modal.dataset },
      {
        parkSlug: 'park',
        campsiteSlug: 'standalone-12',
        campgroundSlug: '',
        locationKind: 'standalone-campsite',
      },
    );
    assert.deepEqual(
      { ...helper.readCanonicalLocation(modal, 'park') },
      {
        parkSlug: 'park',
        campsiteSlug: 'standalone-12',
        campgroundSlug: null,
      },
    );

    helper.applyCanonicalLocation(modal, {
      slug: '12',
      campgroundSlug: 'north',
      locationKind: 'campground-campsite',
    });
    assert.equal(modal.dataset.campgroundSlug, 'north');
  });

  test('location equality includes park, campground scope, and campsite slug', () => {
    const helper = loadBrowserHelper();
    const standalone = {
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: null,
    };
    const standaloneWithEmptyCampground = {
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: '',
    };
    const campgroundA = {
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: 'camp-a',
    };
    const campgroundACopy = { ...campgroundA };
    const campgroundB = {
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: 'camp-b',
    };

    assert.equal(helper.sameLocation(
      standalone,
      standaloneWithEmptyCampground,
    ), true);
    assert.equal(helper.sameLocation(campgroundA, campgroundACopy), true);
    assert.equal(helper.sameLocation(campgroundA, campgroundB), false);
    assert.equal(helper.sameLocation(standalone, campgroundA), false);

    const malformed = [
      null,
      {},
      { parkSlug: 'park', campsiteSlug: '' },
      { parkSlug: '', campsiteSlug: '12' },
      { parkSlug: 'park', campsiteSlug: '12', campgroundSlug: '   ' },
    ];
    for (const value of malformed) {
      assert.equal(helper.locationKey(value), null);
      assert.equal(helper.sameLocation(value, value), false);
    }
  });

  test('duplicate campsite badges update only in the requested campground', () => {
    const siteA = new FakeSite();
    const siteB = new FakeSite();
    const standalone = new FakeSite();
    const root = new FakeRoot({ siteA, siteB, standalone });
    const helper = loadBrowserHelper(root);

    assert.equal(
      helper.updateBadge({
        campgroundSlug: 'camp-a',
        campsiteSlug: '12',
      }, 3, root),
      true,
    );
    assert.equal(siteA.badge.textContent, '3');
    assert.equal(siteB.badge, null);
    assert.equal(standalone.badge, null);

    helper.updateBadge({
      campgroundSlug: 'camp-b',
      campsiteSlug: '12',
    }, 2, root);
    assert.equal(siteA.badge.textContent, '3');
    assert.equal(siteB.badge.textContent, '2');
  });

  test('standalone badge updates never touch a campground campsite with the same slug', () => {
    const siteA = new FakeSite();
    const siteB = new FakeSite();
    const standalone = new FakeSite();
    const root = new FakeRoot({ siteA, siteB, standalone });
    const helper = loadBrowserHelper(root);

    helper.updateBadge({
      campgroundSlug: null,
      campsiteSlug: '12',
    }, 4, root);
    assert.equal(standalone.badge.textContent, '4');
    assert.equal(siteA.badge, null);
    assert.equal(siteB.badge, null);

    helper.updateBadge({
      campgroundSlug: null,
      campsiteSlug: '12',
    }, 0, root);
    assert.equal(standalone.badge, null);
    assert.equal(standalone.classes.has('no-media'), true);
    assert.equal(standalone.classes.has('has-media'), false);
  });

  test('showPark uses the shared helper for all five campsite URL contexts', () => {
    const requiredCalls = [
      'campsiteLocation.apiUrl(',
      'campsiteLocation.photoUploadUrl(',
      'campsiteLocation.videoUploadUrl(',
      'campsiteLocation.photoDeleteUrl(',
      'campsiteLocation.videoDeleteUrl(',
    ];

    requiredCalls.forEach(call => assert.match(showParkSource, new RegExp(call.replace('(', '\\('))));
    assert.doesNotMatch(showParkSource, /`\/camp\/park\/\$\{[^`]*\/campsite\//);
    assert.match(helperSource, /CSS\.escape/);
  });

  test('campsite mutations preserve and refresh their captured target', () => {
    assert.ok(
      (showParkSource.match(/campsiteTarget:\s*location/g) || []).length >= 2,
    );
    assert.match(
      showParkSource,
      /await refreshCampsiteTarget\(campsiteTarget\)/,
    );
    assert.match(
      showParkSource,
      /await refreshCampsiteTarget\(location\)/,
    );
    assert.doesNotMatch(showParkSource, /refreshCampsiteTarget\(\s*\)/);
    assert.doesNotMatch(showParkSource, /refreshCampsitePopup/);
  });

  test('campsite closure cancels opens, clears canonical state, and hides selection', () => {
    assert.match(
      showParkSource,
      /function closeCampsiteModal\(\)[\s\S]*campsiteRequests\.cancelOpen\(\)[\s\S]*campsiteLocation\.clearCanonicalLocation\(modal\)[\s\S]*modal\.classList\.add\('hidden'\)/,
    );
    assert.match(
      showParkSource,
      /\.modal-backdrop\[data-modal-id="campsite-modal"\]/,
    );
    assert.match(
      showParkSource,
      /if \(!popup \|\| popup\.classList\.contains\('hidden'\)\) return null/,
    );
  });
});

class DeepLinkClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  remove(...values) {
    values.forEach(value => this.values.delete(value));
  }
}

function deepLinkCampsite({
  campsiteSlug,
  campgroundSlug = '',
  hasCampground = false,
}) {
  return {
    dataset: {
      csSlug: campsiteSlug,
      cgSlug: campgroundSlug,
      hasCg: String(hasCampground),
    },
    scrollCalls: [],
    scrollIntoView(options) {
      this.scrollCalls.push(options);
    },
  };
}

function createShowParkDeepLinkHarness({ search = '', campsites = [] } = {}) {
  const documentListeners = new Map();
  const campsiteClickListeners = [];
  const querySelectorAllCalls = [];
  const coordinatorCalls = [];
  const fetchCalls = [];
  const clearedModals = [];
  const modal = { dataset: {} };
  const slider = { classList: new DeepLinkClassList() };
  const noMedia = {
    classList: new DeepLinkClassList(),
    replaceChildren() {},
    textContent: '',
  };
  const parkCampsites = {
    addEventListener(type, listener) {
      assert.equal(type, 'click');
      campsiteClickListeners.push(listener);
    },
  };
  const document = {
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    getElementById(id) {
      if (id === 'park-campsites') return parkCampsites;
      if (id === 'campsite-modal-parent') return modal;
      if (id === 'park-media-slider') return slider;
      if (id === 'no-park-media') return noMedia;
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      querySelectorAllCalls.push(selector);
      if (selector === '.campsite') return campsites;
      return [];
    },
  };
  let coordinatorCreateCalls = 0;
  const window = {
    CampPicsCampsiteLocation: {
      clearCanonicalLocation(element) {
        clearedModals.push(element);
        element.dataset.campsiteSlug = '';
        element.dataset.campgroundSlug = '';
        element.dataset.locationKind = '';
      },
    },
    CampPicsCampsiteRequests: {
      createCoordinator() {
        coordinatorCreateCalls += 1;
        return {
          cancelOpen() {},
          async openLatest(location) {
            coordinatorCalls.push({ ...location });
            return { status: 'displayed' };
          },
          async refreshTarget() {
            throw new Error('Unexpected campsite refresh');
          },
        };
      },
    },
    CampPicsMedia: {},
    CampPicsMediaDeletionResponse: {},
    CURRENT_USER_ID: '',
    PARK: { slug: 'safe-park' },
    location: {
      href: `https://camppics.example.test/camp/park/safe-park${search}`,
      search,
    },
  };
  window.window = window;
  const initialWindowKeys = Object.keys(window).sort();
  const context = vm.createContext({
    console,
    document,
    fetch: async url => {
      fetchCalls.push(url);
      return {
        ok: true,
        async json() { return { photos: [], videos: [] }; },
      };
    },
    initializeParkSlider() {},
    URLSearchParams,
    window,
  });
  vm.runInContext(showParkSource, context);

  return {
    campsiteClickListeners,
    clearedModals,
    coordinatorCalls,
    get coordinatorCreateCalls() { return coordinatorCreateCalls; },
    documentListeners,
    fetchCalls,
    initialWindowKeys,
    modal,
    querySelectorAllCalls,
    window,
    async initialize() {
      const listeners = documentListeners.get('DOMContentLoaded') || [];
      for (const listener of listeners) await listener();
    },
  };
}

describe('public park campsite deep links', () => {
  test('opens valid standalone and campground targets exactly once through the coordinator', async () => {
    const cases = [
      {
        name: 'standalone',
        search: '?campsite=standalone-12',
        sites: [
          deepLinkCampsite({
            campsiteSlug: 'standalone-12',
            campgroundSlug: 'north-loop',
            hasCampground: true,
          }),
          deepLinkCampsite({ campsiteSlug: 'standalone-12' }),
        ],
        expected: {
          parkSlug: 'safe-park',
          campsiteSlug: 'standalone-12',
          campgroundSlug: null,
        },
        matchedIndex: 1,
      },
      {
        name: 'campground',
        search: '?campground=north-loop&campsite=site-12',
        sites: [
          deepLinkCampsite({
            campsiteSlug: 'site-12',
            campgroundSlug: 'south-loop',
            hasCampground: true,
          }),
          deepLinkCampsite({ campsiteSlug: 'site-12' }),
          deepLinkCampsite({
            campsiteSlug: 'site-12',
            campgroundSlug: 'north-loop',
            hasCampground: true,
          }),
        ],
        expected: {
          parkSlug: 'safe-park',
          campsiteSlug: 'site-12',
          campgroundSlug: 'north-loop',
        },
        matchedIndex: 2,
      },
    ];

    for (const fixture of cases) {
      const harness = createShowParkDeepLinkHarness({
        search: fixture.search,
        campsites: fixture.sites,
      });
      await harness.initialize();

      assert.equal(harness.coordinatorCreateCalls, 1, fixture.name);
      assert.deepEqual(harness.coordinatorCalls, [fixture.expected], fixture.name);
      assert.equal(harness.clearedModals.length, 1, fixture.name);
      assert.equal(
        fixture.sites[fixture.matchedIndex].scrollCalls.length,
        1,
        fixture.name,
      );
      assert.deepEqual(
        harness.fetchCalls,
        ['/camp/park/safe-park/media'],
        fixture.name,
      );
      assert.deepEqual(
        Object.keys(harness.window).sort().filter(key =>
          !harness.initialWindowKeys.includes(key)),
        [
          'openCampsiteFullscreen',
          'openFullscreenImage',
          'openFullscreenVideo',
        ],
        fixture.name,
      );
    }
  });

  test('does nothing for scope mismatches or absent, duplicate, blank, malformed and unknown parameters', async () => {
    const nested = deepLinkCampsite({
      campsiteSlug: 'site-12',
      campgroundSlug: 'north-loop',
      hasCampground: true,
    });
    const standalone = deepLinkCampsite({ campsiteSlug: 'standalone-12' });
    const cases = [
      ['', [nested, standalone]],
      ['?campground=north-loop', [nested]],
      ['?campsite=', [standalone]],
      ['?campsite=site-12&campsite=site-12', [nested]],
      ['?campground=north-loop&campground=south-loop&campsite=site-12', [nested]],
      ['?campground=south-loop&campsite=site-12', [nested]],
      ['?campsite=site-12', [nested]],
      ['?campground=north-loop&campsite=standalone-12', [standalone]],
      ['?campsite=UPPERCASE', [standalone]],
      ['?campsite=unsafe%2Fpath', [standalone]],
      ['?campsite=-leading', [standalone]],
      ['?campsite=two--hyphens', [standalone]],
      ['?campsite=standalone-12&extra=value', [standalone]],
      ['?campsite=site-12&campground=north-loop', [nested]],
    ];

    for (const [search, sites] of cases) {
      const harness = createShowParkDeepLinkHarness({ search, campsites: sites });
      await harness.initialize();
      assert.deepEqual(harness.coordinatorCalls, [], search || 'no parameters');
      assert.equal(harness.clearedModals.length, 0, search || 'no parameters');
      assert.equal(
        sites.every(site => site.scrollCalls.length === 0),
        true,
        search || 'no parameters',
      );
      assert.deepEqual(harness.fetchCalls, ['/camp/park/safe-park/media']);
    }
  });

  test('requires one unambiguous dataset match without selector interpolation or unsafe sinks', async () => {
    const duplicateA = deepLinkCampsite({ campsiteSlug: 'duplicate-12' });
    const duplicateB = deepLinkCampsite({ campsiteSlug: 'duplicate-12' });
    const harness = createShowParkDeepLinkHarness({
      search: '?campsite=duplicate-12',
      campsites: [duplicateA, duplicateB],
    });
    await harness.initialize();

    assert.deepEqual(harness.coordinatorCalls, []);
    assert.equal(
      harness.querySelectorAllCalls.filter(selector => selector === '.campsite')
        .length,
      1,
    );
    const start = showParkSource.indexOf('const findDeepLinkedCampsite =');
    const end = showParkSource.indexOf('// Listen to campsite clicks', start);
    assert.ok(start >= 0 && end > start);
    const deepLinkSource = showParkSource.slice(start, end);
    assert.match(deepLinkSource, /document\.querySelectorAll\('\.campsite'\)/u);
    assert.match(deepLinkSource, /dataset\.csSlug === campsiteSlug/u);
    assert.match(deepLinkSource, /dataset\.cgSlug === campgroundSlug/u);
    assert.match(deepLinkSource, /dataset\.hasCg === 'false'/u);
    assert.match(deepLinkSource, /dataset\.hasCg === 'true'/u);
    assert.doesNotMatch(
      deepLinkSource,
      /querySelector(?:All)?\s*\(\s*`|innerHTML|outerHTML|insertAdjacentHTML|window\.[A-Za-z_$][\w$]*\s*=/u,
    );
  });
});

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  add(...values) {
    values.forEach(value => this.owner.classes.add(value));
  }

  remove(...values) {
    values.forEach(value => this.owner.classes.delete(value));
  }
}

class FakeSite {
  constructor() {
    this.badge = null;
    this.classes = new Set(['no-media']);
    this.classList = new FakeClassList(this);
  }

  querySelector(selector) {
    assert.equal(selector, '.media-badge');
    return this.badge;
  }

  appendChild(badge) {
    this.badge = badge;
    badge.parent = this;
  }
}

class FakeRoot {
  constructor({ siteA, siteB, standalone }) {
    this.siteA = siteA;
    this.siteB = siteB;
    this.standalone = standalone;
  }

  querySelector(selector) {
    if (selector === '.campground[data-cg-slug="camp-a"]') {
      return this.campground(this.siteA);
    }
    if (selector === '.campground[data-cg-slug="camp-b"]') {
      return this.campground(this.siteB);
    }
    if (selector === '.standalone-campsites') {
      return this.campground(this.standalone);
    }
    return null;
  }

  campground(site) {
    return {
      querySelector(selector) {
        return selector === '.campsite[data-cs-slug="12"]' ? site : null;
      },
    };
  }

  createElement(tagName) {
    assert.equal(tagName, 'span');
    return {
      className: '',
      textContent: '',
      parent: null,
      remove() {
        this.parent.badge = null;
      },
    };
  }
}
