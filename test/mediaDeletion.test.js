import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  CLOUDINARY_IDENTITY_CONFLICT,
  MEDIA_DELETE_NOT_AUTHORIZED,
  MEDIA_DELETE_NOT_FOUND,
  MEDIA_DELETE_PERSISTENCE_FAILED,
  MEDIA_DELETE_TARGET_CHANGED,
  MEDIA_DELETE_TRANSACTION_UNAVAILABLE,
  PHOTO_IDENTITY_UNRESOLVED,
  createMediaDeletionService,
} from '../utils/mediaDeletion.js';
import {
  MongoTransactionUnavailableError,
} from '../utils/mongoTransaction.js';

const PHOTO_URL =
  'https://res.cloudinary.com/demo/image/upload/v1/camp-parks/delete-me.jpg';

function objectId() {
  return new mongoose.Types.ObjectId();
}

function idsEqual(left, right) {
  return left?.toString() === right?.toString();
}

function clone(value) {
  if (
    value == null ||
    typeof value !== 'object' ||
    value instanceof mongoose.Types.ObjectId
  ) {
    return value;
  }
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'save')
      .map(([key, item]) => [key, clone(item)]),
  );
}

function makeHarness({
  mediaType = 'photo',
  uploadRecords,
  userExists = true,
  historyEntries,
  embeddedOverrides = {},
  actorIsAdmin = false,
  actorUserId,
  fault = null,
  transactionUnavailable = false,
} = {}) {
  const ids = {
    park: objectId(),
    media: objectId(),
    owner: objectId(),
    actor: actorUserId || objectId(),
    job: objectId(),
  };
  if (!actorUserId && !actorIsAdmin) ids.actor = ids.owner;

  const embedded = {
    _id: ids.media,
    user: ids.owner,
    url: mediaType === 'photo'
      ? PHOTO_URL
      : 'https://youtu.be/AAAAAAAAAAA',
    ...(mediaType === 'photo'
      ? { cloudinaryPublicId: 'camp-parks/delete-me' }
      : {}),
    ...embeddedOverrides,
  };
  const defaultUploads = [{
    _id: objectId(),
    mediaType,
    mediaId: ids.media,
    ...(mediaType === 'photo'
      ? { cloudinaryPublicId: 'camp-parks/delete-me' }
      : {}),
  }];
  const defaultHistory = [
    {
      mediaType,
      mediaId: ids.media,
      status: 'active',
    },
    {
      mediaType,
      mediaId: ids.media,
      status: 'active',
    },
  ];
  const state = {
    park: {
      _id: ids.park,
      slug: 'delete-park',
      photos: mediaType === 'photo' ? [embedded] : [],
      videos: mediaType === 'video' ? [embedded] : [],
      campsites: [],
      campgrounds: [],
    },
    uploads: clone(uploadRecords ?? defaultUploads),
    users: userExists
      ? [{
        _id: ids.owner,
        uploads: clone(historyEntries ?? defaultHistory),
      }]
      : [],
    jobs: [],
  };
  const session = { id: 'delete-session' };
  const calls = {
    sessions: [],
    parkLookups: 0,
    parkSaves: 0,
    uploadFinds: 0,
    uploadDeletes: 0,
    userUpdates: 0,
    jobInserts: 0,
    committed: false,
  };
  let working = null;

  function attachSave(park) {
    park.save = async options => {
      calls.parkSaves += 1;
      calls.sessions.push(options?.session);
      if (fault === 'park-save') throw new Error('injected');
      return park;
    };
    return park;
  }

  const ParkModel = {
    async findOne(filter, projection, options) {
      calls.parkLookups += 1;
      calls.sessions.push(options?.session);
      if (fault === 'park-lookup') throw new Error('injected');
      return attachSave(working.park);
    },
  };
  const UploadModel = {
    async find(filter, projection, options) {
      calls.uploadFinds += 1;
      calls.sessions.push(options?.session);
      if (fault === 'identity-load') throw new Error('injected');
      return working.uploads.filter(record =>
        record.mediaType === filter.mediaType &&
        idsEqual(record.mediaId, filter.mediaId)
      );
    },
    async deleteMany(filter, options) {
      calls.uploadDeletes += 1;
      calls.sessions.push(options?.session);
      if (fault === 'upload-delete') throw new Error('injected');
      const before = working.uploads.length;
      working.uploads = working.uploads.filter(record =>
        record.mediaType !== filter.mediaType ||
        !idsEqual(record.mediaId, filter.mediaId)
      );
      return { deletedCount: before - working.uploads.length };
    },
  };
  const UserModel = {
    async updateOne(filter, update, options) {
      calls.userUpdates += 1;
      calls.sessions.push(options?.session);
      if (fault === 'user-update') throw new Error('injected');
      const user = working.users.find(item =>
        idsEqual(item._id, filter._id)
      );
      if (!user) return { matchedCount: 0, modifiedCount: 0 };
      let modifiedCount = 0;
      for (const entry of user.uploads) {
        if (
          idsEqual(entry.mediaId, ids.media) &&
          entry.mediaType === mediaType
        ) {
          if (entry.status !== 'removed') modifiedCount = 1;
          entry.status = 'removed';
        }
      }
      return { matchedCount: 1, modifiedCount };
    },
  };
  const CleanupJobModel = {
    async insertMany(records, options) {
      calls.jobInserts += 1;
      calls.sessions.push(options?.session);
      if (fault === 'job-insert') throw new Error('injected');
      working.jobs.push(...clone(records));
      return records;
    },
  };

  const transactionRunner = async work => {
    if (transactionUnavailable) {
      throw new MongoTransactionUnavailableError(new Error('unavailable'));
    }
    working = clone(state);
    try {
      const result = await work(session);
      if (fault === 'commit') throw new Error('injected');
      state.park = working.park;
      state.uploads = working.uploads;
      state.users = working.users;
      state.jobs = working.jobs;
      calls.committed = true;
      return result;
    } finally {
      working = null;
    }
  };

  const service = createMediaDeletionService({
    ParkModel,
    UploadModel,
    UserModel,
    CleanupJobModel,
    transactionRunner,
    cleanupJobIdFactory: () => ids.job,
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    photoIdentityResolver: fault === 'identity-resolve'
      ? () => {
        throw new Error('injected');
      }
      : undefined,
    campsiteResolver: fault === 'target-resolution'
      ? () => {
        throw new Error('injected');
      }
      : undefined,
  });

  async function remove(locationInput = {}) {
    return service.deleteMedia({
      parkSlug: 'delete-park',
      locationInput,
      mediaType,
      mediaId: ids.media.toString(),
      actorUserId: ids.actor,
      actorIsAdmin,
    });
  }

  return { calls, ids, remove, session, state };
}

function activeMedia(state, mediaType) {
  return state.park[mediaType === 'photo' ? 'photos' : 'videos'];
}

async function deletionError(harness, locationInput) {
  try {
    await harness.remove(locationInput);
  } catch (error) {
    return error;
  }
  assert.fail('Expected media deletion to fail');
}

describe('transactional photo deletion', () => {
  test('agrees across duplicate Upload records and changes every Mongo representation', async () => {
    const mediaId = objectId();
    const harness = makeHarness();
    harness.state.uploads.push({
      _id: objectId(),
      mediaType: 'photo',
      mediaId: harness.ids.media,
      cloudinaryId: PHOTO_URL,
    });

    const result = await harness.remove();

    assert.equal(result.cleanupJobId.toString(), harness.ids.job.toString());
    assert.equal(activeMedia(harness.state, 'photo').length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.deepEqual(
      harness.state.users[0].uploads.map(entry => entry.status),
      ['removed', 'removed'],
    );
    assert.equal(harness.state.jobs.length, 1);
    assert.equal(
      harness.state.jobs[0].cloudinaryPublicId,
      'camp-parks/delete-me',
    );
    assert.equal(harness.calls.uploadDeletes, 1);
    assert.equal(harness.calls.userUpdates, 1);
    assert.ok(
      harness.calls.sessions.every(value => value === harness.session),
    );
    assert.notEqual(mediaId.toString(), harness.ids.media.toString());
  });

  test('no Upload record is accepted when the embedded photo resolves safely', async () => {
    const harness = makeHarness({ uploadRecords: [] });
    await harness.remove();

    assert.equal(activeMedia(harness.state, 'photo').length, 0);
    assert.equal(harness.state.jobs.length, 1);
    assert.equal(harness.calls.uploadDeletes, 1);
  });

  test('conflicting duplicate evidence returns 409-equivalent before mutation', async () => {
    const harness = makeHarness({
      uploadRecords: [],
    });
    harness.state.uploads.push(
      {
        mediaType: 'photo',
        mediaId: harness.ids.media,
        cloudinaryPublicId: 'camp-parks/delete-me',
      },
      {
        mediaType: 'photo',
        mediaId: harness.ids.media,
        cloudinaryPublicId: 'camp-parks/other',
      },
    );

    const error = await deletionError(harness);
    assert.equal(error.code, CLOUDINARY_IDENTITY_CONFLICT);
    assert.equal(activeMedia(harness.state, 'photo').length, 1);
    assert.equal(harness.state.jobs.length, 0);
    assert.equal(harness.calls.parkSaves, 0);
    assert.equal(harness.calls.uploadDeletes, 0);
  });

  test('unresolved identity returns 409-equivalent before mutation', async () => {
    const harness = makeHarness({
      uploadRecords: [],
      embeddedOverrides: {
        url: 'https://historical.example/photo.jpg',
        cloudinaryPublicId: undefined,
      },
    });
    const error = await deletionError(harness);

    assert.equal(error.code, PHOTO_IDENTITY_UNRESOLVED);
    assert.equal(activeMedia(harness.state, 'photo').length, 1);
    assert.equal(harness.state.jobs.length, 0);
  });

  test('fresh authorization rejects a non-owner before companion lookup', async () => {
    const harness = makeHarness({ actorUserId: objectId() });
    const error = await deletionError(harness);

    assert.equal(error.code, MEDIA_DELETE_NOT_AUTHORIZED);
    assert.equal(harness.calls.uploadFinds, 0);
    assert.equal(harness.state.jobs.length, 0);
  });

  test('an administrator can delete media whose owner document is missing', async () => {
    const harness = makeHarness({
      actorIsAdmin: true,
      userExists: false,
    });
    await harness.remove();

    assert.equal(activeMedia(harness.state, 'photo').length, 0);
    assert.equal(harness.state.jobs.length, 1);
    assert.equal(harness.calls.userUpdates, 1);
  });

  test('a missing owner history entry does not block deletion or create one', async () => {
    const harness = makeHarness({ historyEntries: [] });
    await harness.remove();

    assert.equal(activeMedia(harness.state, 'photo').length, 0);
    assert.deepEqual(harness.state.users[0].uploads, []);
    assert.equal(harness.state.jobs.length, 1);
  });

  test('a missing embedded photo is authoritative and creates no job', async () => {
    const harness = makeHarness();
    harness.state.park.photos = [];
    const error = await deletionError(harness);

    assert.equal(error.code, MEDIA_DELETE_NOT_FOUND);
    assert.equal(harness.state.jobs.length, 0);
    assert.equal(harness.calls.uploadFinds, 0);
  });

  test('a changed campsite target is a stable conflict', async () => {
    const harness = makeHarness();
    const error = await deletionError(harness, {
      campsiteSlug: 'missing',
    });

    assert.equal(error.code, MEDIA_DELETE_TARGET_CHANGED);
    assert.equal(harness.state.jobs.length, 0);
    assert.equal(activeMedia(harness.state, 'photo').length, 1);
  });

  for (const fault of [
    'park-lookup',
    'target-resolution',
    'identity-load',
    'identity-resolve',
    'park-save',
    'job-insert',
    'upload-delete',
    'user-update',
    'commit',
  ]) {
    test(`${fault} aborts every representation`, async () => {
      const harness = makeHarness({ fault });
      const locationInput = fault === 'target-resolution'
        ? { campsiteSlug: 'site' }
        : undefined;
      const error = await deletionError(harness, locationInput);

      assert.equal(error.code, MEDIA_DELETE_PERSISTENCE_FAILED);
      assert.equal(activeMedia(harness.state, 'photo').length, 1);
      assert.equal(harness.state.uploads.length, 1);
      assert.deepEqual(
        harness.state.users[0].uploads.map(entry => entry.status),
        ['active', 'active'],
      );
      assert.equal(harness.state.jobs.length, 0);
      assert.equal(harness.calls.committed, false);
    });
  }

  test('unavailable transactions return the stable 503-equivalent code', async () => {
    const harness = makeHarness({ transactionUnavailable: true });
    const error = await deletionError(harness);

    assert.equal(error.code, MEDIA_DELETE_TRANSACTION_UNAVAILABLE);
    assert.equal(activeMedia(harness.state, 'photo').length, 1);
    assert.equal(harness.state.jobs.length, 0);
  });
});

describe('transactional video deletion', () => {
  test('Park, duplicate Uploads, and duplicate history entries commit together without a cleanup job', async () => {
    const harness = makeHarness({ mediaType: 'video' });
    harness.state.uploads.push({
      _id: objectId(),
      mediaType: 'video',
      mediaId: harness.ids.media,
      youtubeId: 'https://youtu.be/AAAAAAAAAAA',
    });

    const result = await harness.remove();

    assert.equal(result.cleanupJobId, null);
    assert.equal(activeMedia(harness.state, 'video').length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.deepEqual(
      harness.state.users[0].uploads.map(entry => entry.status),
      ['removed', 'removed'],
    );
    assert.equal(harness.state.jobs.length, 0);
    assert.equal(harness.calls.jobInserts, 0);
  });

  test('a missing owner User does not block an administrator', async () => {
    const harness = makeHarness({
      mediaType: 'video',
      actorIsAdmin: true,
      userExists: false,
    });
    await harness.remove();

    assert.equal(activeMedia(harness.state, 'video').length, 0);
    assert.equal(harness.state.jobs.length, 0);
  });

  for (const fault of [
    'park-save',
    'upload-delete',
    'user-update',
    'commit',
  ]) {
    test(`${fault} commits none of the video deletion`, async () => {
      const harness = makeHarness({ mediaType: 'video', fault });
      const error = await deletionError(harness);

      assert.equal(error.code, MEDIA_DELETE_PERSISTENCE_FAILED);
      assert.equal(activeMedia(harness.state, 'video').length, 1);
      assert.equal(harness.state.uploads.length, 1);
      assert.deepEqual(
        harness.state.users[0].uploads.map(entry => entry.status),
        ['active', 'active'],
      );
      assert.equal(harness.state.jobs.length, 0);
    });
  }
});
