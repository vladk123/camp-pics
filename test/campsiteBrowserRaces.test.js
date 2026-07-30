import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const locationSource = await readFile(
  new URL('../public/js/campsiteLocation.js', import.meta.url),
  'utf8',
);
const requestsSource = await readFile(
  new URL('../public/js/campsiteRequests.js', import.meta.url),
  'utf8',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(data, ok = true) {
  return {
    ok,
    async json() {
      return data;
    },
  };
}

function apiData({
  campsiteSlug,
  campgroundSlug = null,
}) {
  return {
    _id: `${campgroundSlug || 'standalone'}-${campsiteSlug}`,
    siteNumber: campsiteSlug,
    slug: campsiteSlug,
    type: 'frontcountry',
    campgroundSlug,
    campgroundName: campgroundSlug,
    locationKind: campgroundSlug
      ? 'campground-campsite'
      : 'standalone-campsite',
    photos: [],
    videos: [],
  };
}

function loadHelpers(fetchImpl) {
  const window = {
    AbortController,
    CSS: {
      escape: value => String(value),
    },
    fetch: fetchImpl,
  };
  window.window = window;

  vm.runInNewContext(locationSource, { window });
  vm.runInNewContext(requestsSource, { window });

  return {
    location: window.CampPicsCampsiteLocation,
    requests: window.CampPicsCampsiteRequests,
  };
}

function modalFor(location, locationKind) {
  return {
    dataset: {
      parkSlug: location.parkSlug,
      campsiteSlug: location.campsiteSlug,
      campgroundSlug: location.campgroundSlug || '',
      locationKind,
    },
  };
}

describe('latest campsite open requests', () => {
  test('a late response from request A cannot replace newer request B', async () => {
    const requestA = deferred();
    const requestB = deferred();
    const calls = [];
    const { location, requests } = loadHelpers((url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? requestA.promise : requestB.promise;
    });
    const coordinator = requests.createCoordinator();
    const modal = modalFor({
      parkSlug: 'park',
      campsiteSlug: 'old',
      campgroundSlug: null,
    }, 'standalone-campsite');
    const displayed = [];
    const errors = [];
    const onSuccess = data => {
      displayed.push(data.slug);
      location.applyCanonicalLocation(modal, data);
    };

    const pendingA = coordinator.openLatest({
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    }, { onSuccess, onError: error => errors.push(error) });
    const pendingB = coordinator.openLatest({
      parkSlug: 'park',
      campgroundSlug: 'camp-b',
      campsiteSlug: '12',
    }, { onSuccess, onError: error => errors.push(error) });

    requestB.resolve(response(apiData({
      campgroundSlug: 'camp-b',
      campsiteSlug: '12',
    })));
    assert.equal((await pendingB).status, 'displayed');
    assert.equal(modal.dataset.campgroundSlug, 'camp-b');

    requestA.resolve(response(apiData({
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    })));
    assert.equal((await pendingA).status, 'stale');

    assert.deepEqual(displayed, ['12']);
    assert.equal(modal.dataset.campgroundSlug, 'camp-b');
    assert.equal(modal.dataset.campsiteSlug, '12');
    assert.equal(errors.length, 0);
  });

  test('stale failures and aborted requests show no loading error', async () => {
    const staleA = deferred();
    const successB = deferred();
    let callCount = 0;
    const { requests } = loadHelpers(() => {
      callCount += 1;
      return callCount === 1 ? staleA.promise : successB.promise;
    });
    const coordinator = requests.createCoordinator();
    const errors = [];
    const locationA = {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    };
    const locationB = {
      parkSlug: 'park',
      campgroundSlug: 'camp-b',
      campsiteSlug: '12',
    };

    const pendingA = coordinator.openLatest(locationA, {
      onError: error => errors.push(error),
    });
    const pendingB = coordinator.openLatest(locationB, {
      onError: error => errors.push(error),
    });
    successB.resolve(response(apiData({
      campgroundSlug: 'camp-b',
      campsiteSlug: '12',
    })));
    await pendingB;
    staleA.resolve(response(null, false));
    assert.equal((await pendingA).status, 'stale');
    assert.equal(errors.length, 0);

    let abortCallCount = 0;
    const abortedErrors = [];
    const abortHelpers = loadHelpers((url, options) => {
      abortCallCount += 1;
      if (abortCallCount === 2) {
        return Promise.resolve(response(apiData({
          campgroundSlug: 'camp-b',
          campsiteSlug: '12',
        })));
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const abortCoordinator = abortHelpers.requests.createCoordinator();
    const abortedA = abortCoordinator.openLatest(locationA, {
      onError: error => abortedErrors.push(error),
    });
    const successfulB = abortCoordinator.openLatest(locationB, {
      onError: error => abortedErrors.push(error),
    });

    assert.equal((await successfulB).status, 'displayed');
    assert.equal((await abortedA).status, 'aborted');
    assert.equal(abortedErrors.length, 0);
  });

  test('the newest real failure still reports an error', async () => {
    const { requests } = loadHelpers(async () => response(null, false));
    const coordinator = requests.createCoordinator();
    const errors = [];

    const result = await coordinator.openLatest({
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: null,
    }, {
      onError: error => errors.push(error),
    });

    assert.equal(result.status, 'error');
    assert.equal(errors.length, 1);
  });

  test('cancelOpen suppresses a pending success and a pending failure', async () => {
    const pendingSuccessResponse = deferred();
    const successHelpers = loadHelpers(() => pendingSuccessResponse.promise);
    const successCoordinator = successHelpers.requests.createCoordinator();
    const displayed = [];
    const successErrors = [];
    const pendingSuccess = successCoordinator.openLatest({
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: null,
    }, {
      onSuccess: data => displayed.push(data),
      onError: error => successErrors.push(error),
    });

    successCoordinator.cancelOpen();
    pendingSuccessResponse.resolve(response(apiData({
      campsiteSlug: '12',
    })));

    assert.equal((await pendingSuccess).status, 'stale');
    assert.equal(displayed.length, 0);
    assert.equal(successErrors.length, 0);

    const pendingFailureResponse = deferred();
    const failureHelpers = loadHelpers(() => pendingFailureResponse.promise);
    const failureCoordinator = failureHelpers.requests.createCoordinator();
    const failureErrors = [];
    const pendingFailure = failureCoordinator.openLatest({
      parkSlug: 'park',
      campsiteSlug: '12',
      campgroundSlug: null,
    }, {
      onError: error => failureErrors.push(error),
    });

    failureCoordinator.cancelOpen();
    pendingFailureResponse.resolve(response(null, false));

    assert.equal((await pendingFailure).status, 'stale');
    assert.equal(failureErrors.length, 0);
  });
});

describe('mutation-bound campsite refreshes', () => {
  test('campground A refresh updates A badge without replacing campground B modal', async () => {
    const refreshResponse = deferred();
    const requestedUrls = [];
    const { location, requests } = loadHelpers(url => {
      requestedUrls.push(url);
      return refreshResponse.promise;
    });
    const coordinator = requests.createCoordinator();
    const targetA = {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    };
    const currentB = {
      parkSlug: 'park',
      campgroundSlug: 'camp-b',
      campsiteSlug: '12',
    };
    const modal = modalFor(targetA, 'campground-campsite');
    const badges = [];
    const renders = [];

    const pending = coordinator.refreshTarget(targetA, {
      getCurrentLocation: () =>
        location.readCanonicalLocation(modal, 'park'),
      onBadge: canonical => badges.push({ ...canonical }),
      onRender: data => {
        renders.push(data.slug);
        location.applyCanonicalLocation(modal, data);
      },
    });

    Object.assign(modal.dataset, {
      campsiteSlug: currentB.campsiteSlug,
      campgroundSlug: currentB.campgroundSlug,
      locationKind: 'campground-campsite',
    });
    refreshResponse.resolve(response(apiData({
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    })));
    const result = await pending;

    assert.equal(
      requestedUrls[0],
      '/camp/park/park/campground/camp-a/campsite/12',
    );
    assert.equal(result.status, 'badge-only');
    assert.equal(badges.length, 1);
    assert.equal(badges[0].campgroundSlug, 'camp-a');
    assert.equal(renders.length, 0);
    assert.equal(modal.dataset.campgroundSlug, 'camp-b');
    assert.equal(modal.dataset.campsiteSlug, '12');
  });

  test('standalone site 12 refresh cannot replace campground site 12 modal', async () => {
    const refreshResponse = deferred();
    const requestedUrls = [];
    const { location, requests } = loadHelpers(url => {
      requestedUrls.push(url);
      return refreshResponse.promise;
    });
    const coordinator = requests.createCoordinator();
    const standalone = {
      parkSlug: 'park',
      campgroundSlug: null,
      campsiteSlug: '12',
    };
    const nested = {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    };
    const modal = modalFor(standalone, 'standalone-campsite');
    const badges = [];
    let renderCount = 0;

    const pending = coordinator.refreshTarget(standalone, {
      getCurrentLocation: () =>
        location.readCanonicalLocation(modal, 'park'),
      onBadge: canonical => badges.push({ ...canonical }),
      onRender: () => {
        renderCount += 1;
      },
    });

    Object.assign(modal.dataset, {
      campsiteSlug: nested.campsiteSlug,
      campgroundSlug: nested.campgroundSlug,
      locationKind: 'campground-campsite',
    });
    refreshResponse.resolve(response(apiData({
      campsiteSlug: '12',
      campgroundSlug: null,
    })));
    const result = await pending;

    assert.equal(requestedUrls[0], '/camp/park/park/campsite/12');
    assert.equal(result.status, 'badge-only');
    assert.equal(badges[0].campgroundSlug, null);
    assert.equal(renderCount, 0);
    assert.equal(modal.dataset.campgroundSlug, 'camp-a');
  });

  test('refresh after modal closure updates only the captured target badge', async () => {
    const refreshResponse = deferred();
    const { location, requests } = loadHelpers(() => refreshResponse.promise);
    const coordinator = requests.createCoordinator();
    const target = {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    };
    const modal = {
      ...modalFor(target, 'campground-campsite'),
      hidden: false,
    };
    const badges = [];
    let renderCount = 0;
    const getCurrentLocation = () => {
      if (modal.hidden) return null;
      return location.readCanonicalLocation(modal, 'park');
    };

    const pending = coordinator.refreshTarget(target, {
      getCurrentLocation,
      onBadge: canonical => badges.push({ ...canonical }),
      onRender: data => {
        renderCount += 1;
        modal.hidden = false;
        location.applyCanonicalLocation(modal, data);
      },
    });

    modal.hidden = true;
    location.clearCanonicalLocation(modal);
    refreshResponse.resolve(response(apiData({
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    })));
    const result = await pending;

    assert.equal(result.status, 'badge-only');
    assert.equal(badges.length, 1);
    assert.equal(badges[0].campgroundSlug, 'camp-a');
    assert.equal(badges[0].campsiteSlug, '12');
    assert.equal(renderCount, 0);
    assert.equal(modal.hidden, true);
    assert.equal(modal.dataset.campsiteSlug, '');
    assert.equal(modal.dataset.campgroundSlug, '');
    assert.equal(modal.dataset.locationKind, '');
  });

  test('refresh failure after modal closure shows no modal-specific error', async () => {
    const refreshResponse = deferred();
    const { location, requests } = loadHelpers(() => refreshResponse.promise);
    const coordinator = requests.createCoordinator();
    const target = {
      parkSlug: 'park',
      campgroundSlug: null,
      campsiteSlug: '12',
    };
    const modal = {
      ...modalFor(target, 'standalone-campsite'),
      hidden: false,
    };
    const errors = [];

    const pending = coordinator.refreshTarget(target, {
      getCurrentLocation() {
        if (modal.hidden) return null;
        return location.readCanonicalLocation(modal, 'park');
      },
      onError: error => errors.push(error),
    });

    modal.hidden = true;
    location.clearCanonicalLocation(modal);
    refreshResponse.resolve(response(null, false));
    const result = await pending;

    assert.equal(result.status, 'error');
    assert.equal(errors.length, 0);
    assert.equal(modal.hidden, true);
    assert.equal(modal.dataset.campsiteSlug, '');
    assert.equal(modal.dataset.campgroundSlug, '');
    assert.equal(modal.dataset.locationKind, '');
  });
});
