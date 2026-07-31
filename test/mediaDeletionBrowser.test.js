import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const responseHelperSource = await readFile(
  new URL('../public/js/mediaDeletionResponse.js', import.meta.url),
  'utf8',
);
const parkSliderSource = await readFile(
  new URL('../public/js/parkMediaSlider.js', import.meta.url),
  'utf8',
);
const showParkSource = await readFile(
  new URL('../public/js/showPark.js', import.meta.url),
  'utf8',
);

function loadResponseHelper() {
  const window = {};
  vm.runInNewContext(responseHelperSource, { window });
  return { helper: window.CampPicsMediaDeletionResponse, window };
}

describe('browser media-deletion response classification', () => {
  test('200 and 202 are successful and preserve the safe server message', () => {
    const { helper } = loadResponseHelper();

    const completed = helper.classify(
      { ok: true, status: 200 },
      { message: 'Photo deleted successfully.' },
      'fallback',
    );
    const pending = helper.classify(
      { ok: true, status: 202 },
      {
        cleanupPending: true,
        message: 'Photo deleted from CampPics. Storage cleanup is pending.',
      },
      'fallback',
    );

    assert.equal(completed.success, true);
    assert.equal(completed.cleanupPending, false);
    assert.equal(pending.success, true);
    assert.equal(pending.cleanupPending, true);
    assert.equal(
      pending.message,
      'Photo deleted from CampPics. Storage cleanup is pending.',
    );
  });

  test('an error status is never reclassified as success', () => {
    const { helper } = loadResponseHelper();
    const outcome = helper.classify(
      { ok: false, status: 500 },
      { message: 'Unsafe provider detail' },
      'fallback',
    );

    assert.equal(outcome.success, false);
  });
});

test('park deletion treats 202 as success, emits analytics, and refreshes', async () => {
  const flash = [];
  let refreshes = 0;
  const window = {
    CampPicsMedia: {},
    PARK: { slug: 'park' },
    location: { href: 'https://camppics.test/park' },
    dataLayer: [],
    CampPicsCsrf: {
      async fetch() {
        return {
          ok: true,
          status: 202,
          async json() {
            return {
              success: true,
              cleanupPending: true,
              message:
                'Photo deleted from CampPics. Storage cleanup is pending.',
            };
          },
        };
      },
      responseErrorMessage() {
        return 'delete failed';
      },
    },
  };
  vm.runInNewContext(responseHelperSource, { window });
  const context = {
    window,
    confirm: () => true,
    createFlashMsg(type, message) {
      flash.push({ message, type });
    },
    async refreshParkMedia() {
      refreshes += 1;
    },
    formatDate: () => '',
  };
  vm.runInNewContext(parkSliderSource, context);

  await context.deleteParkMedia({
    _id: 'photo-id',
    type: 'photo',
  });

  assert.deepEqual(flash, [{
    type: 'success',
    message: 'Photo deleted from CampPics. Storage cleanup is pending.',
  }]);
  assert.equal(refreshes, 1);
  assert.equal(window.dataLayer[0].event, 'media_delete');
});

test('campsite deletion treats 202 as success, emits analytics, and refreshes', async () => {
  const start = showParkSource.indexOf('async function deleteMedia(item)');
  const end = showParkSource.indexOf(
    'function openCampsiteFullscreen',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const deleteFunctionSource = showParkSource.slice(start, end);

  const flash = [];
  const refreshed = [];
  const location = {
    parkSlug: 'park',
    campgroundSlug: 'campground',
    campsiteSlug: 'site',
  };
  const window = {
    PARK: { slug: 'park' },
    location: { href: 'https://camppics.test/park' },
    dataLayer: [],
    CampPicsCsrf: {
      async fetch() {
        return {
          ok: true,
          status: 202,
          async json() {
            return {
              success: true,
              cleanupPending: true,
              message:
                'Photo deleted from CampPics. Storage cleanup is pending.',
            };
          },
        };
      },
      responseErrorMessage() {
        return 'delete failed';
      },
    },
  };
  vm.runInNewContext(responseHelperSource, { window });
  const context = {
    window,
    console: { error() {} },
    document: {
      getElementById() {
        return {};
      },
    },
    campsiteLocation: {
      readCanonicalLocation() {
        return location;
      },
      photoDeleteUrl() {
        return '/photo';
      },
      videoDeleteUrl() {
        return '/video';
      },
    },
    mediaDeletionResponse: window.CampPicsMediaDeletionResponse,
    createFlashMsg(type, message) {
      flash.push({ message, type });
    },
    async refreshCampsiteTarget(value) {
      refreshed.push(value);
    },
  };
  vm.runInNewContext(deleteFunctionSource, context);

  await context.deleteMedia({
    _id: 'photo-id',
    type: 'photo',
  });

  assert.deepEqual(flash, [{
    type: 'success',
    message: 'Photo deleted from CampPics. Storage cleanup is pending.',
  }]);
  assert.deepEqual(refreshed, [location]);
  assert.equal(window.dataLayer[0].event, 'media_delete');
});
