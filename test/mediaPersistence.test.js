import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import { Park } from '../models/park.js';
import { CampsiteTargetError } from '../utils/campsiteTarget.js';
import {
  MEDIA_PERSISTENCE_FAILED,
  MEDIA_QUOTA_CHANGED,
  MEDIA_TARGET_CHANGED,
  MEDIA_UPLOADER_NOT_FOUND,
  createMediaPersistenceService,
} from '../utils/mediaPersistence.js';

const USER_ID = new mongoose.Types.ObjectId();
const DATE_TAKEN = new Date('2026-01-01T00:00:00.000Z');

function baseParkData() {
  return new Park({
    name: 'Transactional Park',
    slug: 'transactional-park',
    province: 'Ontario',
    photos: [],
    videos: [],
    campsites: [{
      siteNumber: 'Standalone 12',
      slug: '12',
      photos: [],
      videos: [],
    }],
    campgrounds: [{
      name: 'Original Campground',
      slug: 'camp-a',
      campsites: [{
        siteNumber: 'A-12',
        slug: '12',
        photos: [],
        videos: [],
      }],
    }],
  }).toObject();
}

function preparedPhoto(index = 1) {
  return Object.freeze({
    mediaId: new mongoose.Types.ObjectId(),
    uploadId: new mongoose.Types.ObjectId(),
    cloudinaryUrl:
      `https://res.cloudinary.com/demo/image/upload/v1/camp-parks/${index}.jpg`,
    cloudinaryPublicId: `camp-parks/${index}`,
    caption: `Photo ${index}`,
    showUsername: true,
    username: 'Camper',
    dateTaken: DATE_TAKEN,
  });
}

function preparedVideo(index = 1) {
  return Object.freeze({
    mediaId: new mongoose.Types.ObjectId(),
    uploadId: new mongoose.Types.ObjectId(),
    youtubeUrl: `https://youtu.be/${String(index).padStart(11, 'A')}`,
    caption: `Video ${index}`,
    showUsername: false,
    username: null,
    dateTaken: DATE_TAKEN,
  });
}

function mediaAt(data, location, field) {
  if (!location?.campsiteSlug) return data[field];
  if (location.campgroundSlug) {
    return data.campgrounds
      .find(item => item.slug === location.campgroundSlug)
      .campsites.find(item => item.slug === location.campsiteSlug)[field];
  }
  return data.campsites
    .find(item => item.slug === location.campsiteSlug)[field];
}

function createHarness({
  failStage = null,
  retryCallback = false,
  parkData = baseParkData(),
  userExists = true,
} = {}) {
  const state = {
    parkData,
    uploads: [],
    userUploads: [],
    userExists,
  };
  const calls = {
    events: [],
    find: [],
    saves: [],
    uploadBatches: [],
    userUpdates: [],
    transactionAttempts: 0,
  };
  const session = { id: 'shared-transaction-session' };
  let active = null;

  function startAttempt() {
    const park = new Park(state.parkData);
    park.save = async options => {
      calls.events.push('park-save');
      calls.saves.push(options);
      assert.equal(options.session, session);
      if (failStage === 'park-save') {
        throw new Error('injected Park save failure');
      }
      if (failStage === 'park-verification') {
        const arrays = [
          park.photos,
          park.videos,
          ...park.campsites.flatMap(site => [site.photos, site.videos]),
          ...park.campgrounds.flatMap(campground =>
            campground.campsites.flatMap(site => [
              site.photos,
              site.videos,
            ])
          ),
        ];
        arrays.find(items => items.length > 0)?.pop();
      }
      return park;
    };
    active = {
      park,
      uploads: state.uploads.map(record => ({ ...record })),
      userUploads: state.userUploads.map(record => ({ ...record })),
    };
  }

  function commitAttempt() {
    state.parkData = active.park.toObject();
    state.uploads = active.uploads;
    state.userUploads = active.userUploads;
  }

  const ParkModel = {
    async findOne(...args) {
      calls.events.push('park-find');
      calls.find.push(args);
      assert.equal(args[2].session, session);
      if (failStage === 'fresh-park') {
        throw new Error('injected fresh Park lookup failure');
      }
      if (failStage === 'park-missing') return null;
      return active.park;
    },
  };
  const UploadModel = {
    async insertMany(records, options) {
      calls.events.push('upload-insert');
      calls.uploadBatches.push({ records, options });
      assert.equal(options.session, session);
      if (failStage === 'upload-insert') {
        throw new Error('injected Upload insertion failure');
      }
      active.uploads.push(...records.map(record => ({ ...record })));
      if (failStage === 'upload-short') return records.slice(0, -1);
      return records;
    },
  };
  const UserModel = {
    async updateOne(filter, update, options) {
      calls.events.push('user-update');
      calls.userUpdates.push({ filter, update, options });
      assert.equal(options.session, session);
      if (failStage === 'user-update') {
        throw new Error('injected User update failure');
      }
      if (!state.userExists || failStage === 'user-missing') {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (failStage === 'user-unmodified') {
        return { matchedCount: 1, modifiedCount: 0 };
      }
      active.userUploads.push(
        ...update.$push.uploads.$each.map(record => ({ ...record })),
      );
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  const transactionRunner = async work => {
    const attempts = retryCallback ? 2 : 1;
    let result;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      calls.transactionAttempts += 1;
      startAttempt();
      result = await work(session);
      if (failStage === 'commit') {
        throw new Error('injected transaction commit failure');
      }
      if (attempt === attempts - 1) commitAttempt();
    }
    return result;
  };
  const campsiteResolver = (park, location) => {
    if (failStage === 'target-resolution') {
      throw new CampsiteTargetError('CAMPSITE_NOT_FOUND');
    }
    const campground = location.campgroundSlug
      ? park.campgrounds.find(
        item => item.slug === location.campgroundSlug,
      )
      : null;
    const campsite = campground
      ? campground.campsites.find(
        item => item.slug === location.campsiteSlug,
      )
      : park.campsites.find(item => item.slug === location.campsiteSlug);
    if (!campsite) {
      throw new CampsiteTargetError('CAMPSITE_NOT_FOUND');
    }
    return {
      target: campsite,
      campsite,
      campground,
      campsiteSlug: campsite.slug,
      campgroundSlug: campground?.slug ?? null,
    };
  };

  const service = createMediaPersistenceService({
    ParkModel,
    UploadModel,
    UserModel,
    transactionRunner,
    campsiteResolver,
  });
  return { calls, service, session, state };
}

function request(mediaType, preparedMedia, locationInput = {}) {
  return {
    parkSlug: 'transactional-park',
    locationInput,
    userId: USER_ID,
    mediaType,
    preparedMedia: Object.freeze(preparedMedia),
  };
}

describe('shared transactional media persistence', () => {
  for (const count of [1, 2]) {
    test(`commits ${count} photo(s) with one write per representation`, async () => {
      const harness = createHarness();
      const prepared = Array.from({ length: count }, (_, index) =>
        preparedPhoto(index + 1)
      );

      const result = await harness.service.commitMediaCreation(
        request('photo', prepared),
      );

      assert.equal(result.remaining, 2 - count);
      assert.equal(harness.state.parkData.photos.length, count);
      assert.equal(harness.state.uploads.length, count);
      assert.equal(harness.state.userUploads.length, count);
      assert.equal(harness.calls.saves.length, 1);
      assert.equal(harness.calls.uploadBatches.length, 1);
      assert.equal(harness.calls.userUpdates.length, 1);
      assert.deepEqual(harness.calls.events, [
        'park-find',
        'park-save',
        'upload-insert',
        'user-update',
      ]);

      const batch = harness.calls.uploadBatches[0];
      assert.equal(batch.options.session, harness.session);
      assert.equal(harness.calls.saves[0].session, harness.session);
      assert.equal(
        harness.calls.userUpdates[0].options.session,
        harness.session,
      );
      assert.deepEqual(
        harness.state.parkData.photos.map(photo => [
          photo._id.toString(),
          photo.url,
          photo.cloudinaryPublicId,
        ]),
        prepared.map(photo => [
          photo.mediaId.toString(),
          photo.cloudinaryUrl,
          photo.cloudinaryPublicId,
        ]),
      );
      assert.deepEqual(
        harness.state.uploads.map(upload => [
          upload._id.toString(),
          upload.mediaId.toString(),
          upload.cloudinaryUrl,
          upload.cloudinaryPublicId,
          upload.cloudinaryId,
        ]),
        prepared.map(photo => [
          photo.uploadId.toString(),
          photo.mediaId.toString(),
          photo.cloudinaryUrl,
          photo.cloudinaryPublicId,
          photo.cloudinaryUrl,
        ]),
      );
      assert.equal(
        harness.calls.userUpdates[0].update.$push.uploads.$each.length,
        count,
      );
    });
  }

  test('builds all location metadata once from the transaction-resolved target', async () => {
    const harness = createHarness();
    const locationInput = {
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    };

    await harness.service.commitMediaCreation(
      request('photo', [preparedPhoto()], locationInput),
    );

    const upload = harness.state.uploads[0];
    const history = harness.state.userUploads[0];
    assert.equal(upload.campgroundName, 'Original Campground');
    assert.equal(upload.campsiteName, 'A-12');
    assert.equal(history.parkSlug, 'transactional-park');
    assert.equal(history.campgroundSlug, 'camp-a');
    assert.equal(history.campsiteSlug, '12');
    assert.equal(history.campgroundId.toString(), upload.campgroundId.toString());
    assert.equal(history.campsiteId.toString(), upload.campsiteId.toString());
  });

  test('commits a video with the same preassigned media ID everywhere', async () => {
    const harness = createHarness();
    const prepared = preparedVideo();

    await harness.service.commitMediaCreation(
      request('video', [prepared]),
    );

    assert.equal(
      harness.state.parkData.videos[0]._id.toString(),
      prepared.mediaId.toString(),
    );
    assert.equal(
      harness.state.uploads[0].mediaId.toString(),
      prepared.mediaId.toString(),
    );
    assert.equal(harness.state.uploads[0].youtubeId, prepared.youtubeUrl);
    assert.equal(
      harness.state.userUploads[0].mediaId.toString(),
      prepared.mediaId.toString(),
    );
    assert.equal(
      harness.state.userUploads[0].youtubeUrl,
      prepared.youtubeUrl,
    );
  });

  const failureCases = [
    ['fresh Park lookup', 'fresh-park', MEDIA_PERSISTENCE_FAILED, {}],
    ['target resolution', 'target-resolution', MEDIA_TARGET_CHANGED, {
      campsiteSlug: '12',
    }],
    ['Park disappeared', 'park-missing', MEDIA_TARGET_CHANGED, {}],
    ['Park save', 'park-save', MEDIA_PERSISTENCE_FAILED, {}],
    ['Park verification', 'park-verification', MEDIA_PERSISTENCE_FAILED, {}],
    ['Upload insertion', 'upload-insert', MEDIA_PERSISTENCE_FAILED, {}],
    ['short Upload insertion', 'upload-short', MEDIA_PERSISTENCE_FAILED, {}],
    ['User update', 'user-update', MEDIA_PERSISTENCE_FAILED, {}],
    ['unmodified User update', 'user-unmodified', MEDIA_PERSISTENCE_FAILED, {}],
    ['transaction commit', 'commit', MEDIA_PERSISTENCE_FAILED, {}],
  ];

  for (const [name, failStage, code, locationInput] of failureCases) {
    test(`${name} failure commits none of the three representations`, async () => {
      const harness = createHarness({ failStage });

      await assert.rejects(
        harness.service.commitMediaCreation(
          request('photo', [preparedPhoto()], locationInput),
        ),
        error => error.code === code,
      );
      assert.equal(harness.state.parkData.photos.length, 0);
      assert.equal(harness.state.uploads.length, 0);
      assert.equal(harness.state.userUploads.length, 0);
    });
  }

  test('a missing uploader aborts every write with a stable code', async () => {
    const harness = createHarness({ failStage: 'user-missing' });

    await assert.rejects(
      harness.service.commitMediaCreation(
        request('video', [preparedVideo()]),
      ),
      error => error.code === MEDIA_UPLOADER_NOT_FOUND,
    );
    assert.equal(harness.state.parkData.videos.length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.userUploads.length, 0);
  });

  test('fresh quota rejects the entire prepared batch before any write', async () => {
    const parkData = baseParkData();
    parkData.photos.push({
      _id: new mongoose.Types.ObjectId(),
      user: USER_ID,
      url:
        'https://res.cloudinary.com/demo/image/upload/v1/historical.jpg',
      dateTaken: DATE_TAKEN,
    });
    const harness = createHarness({ parkData });

    await assert.rejects(
      harness.service.commitMediaCreation(
        request('photo', [preparedPhoto(1), preparedPhoto(2)]),
      ),
      error => error.code === MEDIA_QUOTA_CHANGED,
    );
    assert.equal(harness.state.parkData.photos.length, 1);
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.userUploads.length, 0);
    assert.deepEqual(harness.calls.events, ['park-find']);
  });

  test('driver callback retry reuses IDs, reevaluates quota and does not duplicate', async () => {
    const harness = createHarness({ retryCallback: true });
    const prepared = [preparedPhoto()];

    await harness.service.commitMediaCreation(
      request('photo', prepared),
    );

    assert.equal(harness.calls.transactionAttempts, 2);
    assert.equal(harness.calls.find.length, 2);
    assert.equal(harness.state.parkData.photos.length, 1);
    assert.equal(harness.state.uploads.length, 1);
    assert.equal(harness.state.userUploads.length, 1);
    assert.equal(
      harness.state.parkData.photos[0]._id.toString(),
      prepared[0].mediaId.toString(),
    );
    assert.equal(
      harness.state.uploads[0]._id.toString(),
      prepared[0].uploadId.toString(),
    );
  });

  test('video write failures also commit none', async () => {
    for (const failStage of [
      'park-save',
      'upload-insert',
      'user-update',
      'commit',
    ]) {
      const harness = createHarness({ failStage });
      await assert.rejects(
        harness.service.commitMediaCreation(
          request('video', [preparedVideo()]),
        ),
      );
      assert.equal(harness.state.parkData.videos.length, 0);
      assert.equal(harness.state.uploads.length, 0);
      assert.equal(harness.state.userUploads.length, 0);
    }
  });
});
