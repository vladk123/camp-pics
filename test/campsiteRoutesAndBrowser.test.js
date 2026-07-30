import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

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
