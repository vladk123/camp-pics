import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  createMongoMediaIdentifierRepository,
  RECONCILIATION_INVALID_SELECTOR,
} from '../scripts/reconcileMediaIdentifiers.js';

function objectId() {
  return new mongoose.Types.ObjectId();
}

function makeModels({
  parkUpdate = async () => ({ modifiedCount: 1 }),
  uploadUpdate = async () => ({ modifiedCount: 1 }),
  userUpdate = async () => ({ modifiedCount: 1 }),
} = {}) {
  const calls = {
    park: [],
    upload: [],
    user: [],
  };
  return {
    calls,
    ParkModel: {
      collection: { name: 'parks' },
      async updateOne(...args) {
        calls.park.push(args);
        return parkUpdate(...args);
      },
    },
    UploadModel: {
      async updateOne(...args) {
        calls.upload.push(args);
        return uploadUpdate(...args);
      },
    },
    UserModel: {
      async updateOne(...args) {
        calls.user.push(args);
        return userUpdate(...args);
      },
    },
  };
}

function hasNullishSelector(value) {
  if (value == null) return true;
  if (mongoose.isObjectIdOrHexString(value)) return false;
  if (Array.isArray(value)) return value.some(hasNullishSelector);
  if (typeof value !== 'object') return false;
  return Object.values(value).some(hasNullishSelector);
}

function assertObjectIdEqual(actual, expected) {
  assert.equal(actual.toString(), expected.toString());
}

describe('Mongo reconciliation repository selector guards', () => {
  test('malformed selector tuples throw before any updateOne call', async () => {
    const models = makeModels();
    const repository = createMongoMediaIdentifierRepository(models);
    const valid = {
      parkId: objectId(),
      mediaId: objectId(),
      recordId: objectId(),
      userId: objectId(),
      campgroundId: objectId(),
      campsiteId: objectId(),
    };
    const changes = [
      {
        kind: 'uploadPublicId',
        recordId: undefined,
        mediaId: valid.mediaId,
        value: 'camp-parks/example',
      },
      {
        kind: 'uploadUrl',
        recordId: valid.recordId,
        mediaId: null,
        value: 'https://example.test/photo.jpg',
      },
      {
        kind: 'uploadPublicId',
        recordId: 'not-an-object-id',
        mediaId: valid.mediaId,
        value: 'camp-parks/example',
      },
      {
        kind: 'userHistoryPublicId',
        userId: null,
        recordId: valid.recordId,
        mediaId: valid.mediaId,
        value: 'camp-parks/example',
      },
      {
        kind: 'userHistoryPublicId',
        userId: valid.userId,
        recordId: {},
        mediaId: valid.mediaId,
        value: 'camp-parks/example',
      },
      {
        kind: 'userHistoryPublicId',
        userId: valid.userId,
        recordId: valid.recordId,
        mediaId: '',
        value: 'camp-parks/example',
      },
      {
        kind: 'parkPhotoPublicId',
        parkId: undefined,
        mediaId: valid.mediaId,
        locator: { level: 'park' },
        value: 'camp-parks/example',
      },
      {
        kind: 'parkPhotoPublicId',
        parkId: valid.parkId,
        mediaId: null,
        locator: { level: 'park' },
        value: 'camp-parks/example',
      },
      {
        kind: 'parkPhotoPublicId',
        parkId: valid.parkId,
        mediaId: valid.mediaId,
        locator: { level: 'standaloneCampsite' },
        value: 'camp-parks/example',
      },
      {
        kind: 'parkPhotoPublicId',
        parkId: valid.parkId,
        mediaId: valid.mediaId,
        locator: {
          level: 'campgroundCampsite',
          campsiteId: valid.campsiteId,
        },
        value: 'camp-parks/example',
      },
      {
        kind: 'parkPhotoPublicId',
        parkId: valid.parkId,
        mediaId: valid.mediaId,
        locator: {
          level: 'campgroundCampsite',
          campgroundId: valid.campgroundId,
        },
        value: 'camp-parks/example',
      },
    ];

    for (const change of changes) {
      await assert.rejects(
        repository.applyChange(change),
        error => {
          assert.equal(error.code, RECONCILIATION_INVALID_SELECTOR);
          return true;
        },
      );
    }

    assert.equal(models.calls.park.length, 0);
    assert.equal(models.calls.upload.length, 0);
    assert.equal(models.calls.user.length, 0);
  });

  test('valid writes contain every exact selector and no nullish value', async () => {
    const models = makeModels();
    const repository = createMongoMediaIdentifierRepository(models);
    const ids = {
      parkId: objectId(),
      mediaId: objectId(),
      uploadId: objectId(),
      userId: objectId(),
      entryId: objectId(),
      standaloneSiteId: objectId(),
      campgroundId: objectId(),
      campgroundSiteId: objectId(),
    };

    assert.equal(await repository.applyChange({
      kind: 'uploadPublicId',
      recordId: ids.uploadId.toString(),
      mediaId: ids.mediaId,
      value: 'camp-parks/example',
    }), 1);
    assert.equal(await repository.applyChange({
      kind: 'uploadUrl',
      recordId: ids.uploadId,
      mediaId: ids.mediaId,
      value:
        'https://res.cloudinary.com/demo/image/upload/v1/example.jpg',
    }), 1);
    assert.equal(await repository.applyChange({
      kind: 'userHistoryPublicId',
      userId: ids.userId,
      recordId: ids.entryId,
      mediaId: ids.mediaId.toString(),
      value: 'camp-parks/example',
    }), 1);
    assert.equal(await repository.applyChange({
      kind: 'parkPhotoPublicId',
      parkId: ids.parkId,
      mediaId: ids.mediaId,
      locator: { level: 'park' },
      value: 'camp-parks/root',
    }), 1);
    assert.equal(await repository.applyChange({
      kind: 'parkPhotoPublicId',
      parkId: ids.parkId,
      mediaId: ids.mediaId,
      locator: {
        level: 'standaloneCampsite',
        campsiteId: ids.standaloneSiteId,
      },
      value: 'camp-parks/standalone',
    }), 1);
    assert.equal(await repository.applyChange({
      kind: 'parkPhotoPublicId',
      parkId: ids.parkId,
      mediaId: ids.mediaId,
      locator: {
        level: 'campgroundCampsite',
        campgroundId: ids.campgroundId,
        campsiteId: ids.campgroundSiteId,
      },
      value: 'camp-parks/campground',
    }), 1);

    const [uploadFilter] = models.calls.upload[0];
    assertObjectIdEqual(uploadFilter._id, ids.uploadId);
    assert.equal(uploadFilter.mediaType, 'photo');
    assertObjectIdEqual(uploadFilter.mediaId, ids.mediaId);
    assert.deepEqual(uploadFilter.cloudinaryPublicId, { $exists: false });
    const [uploadUrlFilter] = models.calls.upload[1];
    assertObjectIdEqual(uploadUrlFilter._id, ids.uploadId);
    assert.equal(uploadUrlFilter.mediaType, 'photo');
    assertObjectIdEqual(uploadUrlFilter.mediaId, ids.mediaId);
    assert.deepEqual(uploadUrlFilter.cloudinaryUrl, { $exists: false });

    const [userFilter, , userOptions] = models.calls.user[0];
    assertObjectIdEqual(userFilter._id, ids.userId);
    assertObjectIdEqual(userFilter.uploads.$elemMatch._id, ids.entryId);
    assertObjectIdEqual(
      userFilter.uploads.$elemMatch.mediaId,
      ids.mediaId,
    );
    assert.equal(userFilter.uploads.$elemMatch.mediaType, 'photo');
    assert.deepEqual(
      userFilter.uploads.$elemMatch.cloudinaryPublicId,
      { $exists: false },
    );
    const entryFilter = userOptions.arrayFilters[0];
    assertObjectIdEqual(entryFilter['entry._id'], ids.entryId);
    assertObjectIdEqual(entryFilter['entry.mediaId'], ids.mediaId);
    assert.equal(entryFilter['entry.mediaType'], 'photo');
    assert.deepEqual(
      entryFilter['entry.cloudinaryPublicId'],
      { $exists: false },
    );

    const [, , rootOptions] = models.calls.park[0];
    assertObjectIdEqual(
      rootOptions.arrayFilters[0]['photo._id'],
      ids.mediaId,
    );
    assert.deepEqual(
      rootOptions.arrayFilters[0]['photo.cloudinaryPublicId'],
      { $exists: false },
    );

    const [, , standaloneOptions] = models.calls.park[1];
    assertObjectIdEqual(
      standaloneOptions.arrayFilters[0]['site._id'],
      ids.standaloneSiteId,
    );
    assertObjectIdEqual(
      standaloneOptions.arrayFilters[1]['photo._id'],
      ids.mediaId,
    );

    models.calls.park.forEach(([filter]) => {
      assertObjectIdEqual(filter._id, ids.parkId);
    });

    const [, , campgroundOptions] = models.calls.park[2];
    assertObjectIdEqual(
      campgroundOptions.arrayFilters[0]['campground._id'],
      ids.campgroundId,
    );
    assertObjectIdEqual(
      campgroundOptions.arrayFilters[1]['site._id'],
      ids.campgroundSiteId,
    );
    assertObjectIdEqual(
      campgroundOptions.arrayFilters[2]['photo._id'],
      ids.mediaId,
    );

    [
      ...models.calls.upload,
      ...models.calls.user,
      ...models.calls.park,
    ].forEach(call => assert.equal(hasNullishSelector(call), false));
  });

  test('duplicate corrupt entry IDs are disambiguated by exact mediaId', async () => {
    const userId = objectId();
    const sharedEntryId = objectId();
    const mediaA = objectId();
    const mediaB = objectId();
    const entries = [
      {
        _id: sharedEntryId,
        mediaId: mediaA,
        mediaType: 'photo',
      },
      {
        _id: sharedEntryId,
        mediaId: mediaB,
        mediaType: 'photo',
      },
    ];
    const models = makeModels({
      userUpdate: async (filter, update, options) => {
        assertObjectIdEqual(filter._id, userId);
        const entryFilter = options.arrayFilters[0];
        const match = entries.find(entry =>
          entry._id.equals(entryFilter['entry._id']) &&
          entry.mediaId.equals(entryFilter['entry.mediaId']) &&
          entry.mediaType === entryFilter['entry.mediaType'] &&
          !Object.hasOwn(entry, 'cloudinaryPublicId')
        );
        if (!match) return { modifiedCount: 0 };
        match.cloudinaryPublicId =
          update.$set['uploads.$[entry].cloudinaryPublicId'];
        return { modifiedCount: 1 };
      },
    });
    const repository = createMongoMediaIdentifierRepository(models);

    assert.equal(await repository.applyChange({
      kind: 'userHistoryPublicId',
      userId,
      recordId: sharedEntryId,
      mediaId: mediaA,
      value: 'camp-parks/a',
    }), 1);
    assert.equal(entries[0].cloudinaryPublicId, 'camp-parks/a');
    assert.equal(
      Object.hasOwn(entries[1], 'cloudinaryPublicId'),
      false,
    );

    assert.equal(await repository.applyChange({
      kind: 'userHistoryPublicId',
      userId,
      recordId: sharedEntryId,
      mediaId: mediaB,
      value: 'camp-parks/b',
    }), 1);
    assert.equal(entries[1].cloudinaryPublicId, 'camp-parks/b');
  });
});
