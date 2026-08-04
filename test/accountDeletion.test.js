import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  ACCOUNT_DELETE_CREDENTIAL_CHANGED,
  ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED,
  ACCOUNT_DELETE_NOT_ALLOWED,
  ACCOUNT_DELETE_NOT_FOUND,
  ACCOUNT_DELETE_PERSISTENCE_FAILED,
  ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE,
  createAccountDeletionService,
} from '../utils/accountDeletion.js';
import {
  MongoTransactionUnavailableError,
} from '../utils/mongoTransaction.js';

const PHOTO_URL =
  'https://res.cloudinary.com/demo/image/upload/v1/camp-pics/delete-me.jpg';
const OTHER_PHOTO_URL =
  'https://res.cloudinary.com/demo/image/upload/v1/camp-pics/other.jpg';

function objectId() {
  return new mongoose.Types.ObjectId();
}

function id(value) {
  return value?.toString?.() ?? String(value);
}

function idsEqual(left, right) {
  return left != null && right != null && id(left) === id(right);
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

function matchesIdCondition(value, condition) {
  if (condition?.$in) {
    return condition.$in.some(candidate => idsEqual(value, candidate));
  }
  return idsEqual(value, condition);
}

function matchesUpload(upload, filter) {
  const matchesCondition = condition =>
    Object.entries(condition).every(([field, expected]) =>
      matchesIdCondition(upload[field], expected)
    );
  if (Array.isArray(filter?.$or)) {
    return filter.$or.some(matchesCondition);
  }
  return matchesCondition(filter);
}

function valuesAtPath(value, pathParts) {
  if (Array.isArray(value)) {
    return value.flatMap(item => valuesAtPath(item, pathParts));
  }
  if (pathParts.length === 0) return [value];
  if (value == null || typeof value !== 'object') return [];
  const [field, ...remaining] = pathParts;
  return valuesAtPath(value[field], remaining);
}

function matchesPark(park, filter) {
  return filter.$or.some(condition => {
    const [path, expected] = Object.entries(condition)[0];
    return valuesAtPath(park, path.split('.')).some(value =>
      matchesIdCondition(value, expected)
    );
  });
}

function makePhoto(ids, overrides = {}) {
  return {
    _id: ids.photo,
    user: ids.user,
    likedBy: [],
    url: PHOTO_URL,
    cloudinaryPublicId: 'camp-pics/delete-me',
    ...overrides,
  };
}

function makeVideo(ids, overrides = {}) {
  return {
    _id: ids.video,
    user: ids.user,
    likedBy: [],
    url: 'https://youtu.be/AAAAAAAAAAA',
    ...overrides,
  };
}

function makePark(ids, overrides = {}) {
  return {
    _id: ids.park,
    photos: [makePhoto(ids)],
    videos: [],
    reviews: [],
    campsites: [],
    campgrounds: [],
    ...overrides,
  };
}

function makeHarness({
  fault = null,
  admin = false,
  missingUser = false,
  storedHash = 'authenticated-hash',
  requestHash = 'authenticated-hash',
  storedSalt = 'authenticated-salt',
  requestSalt = 'authenticated-salt',
  buildPark = ids => makePark(ids),
  buildParks,
  buildUploads,
  buildDeletingHistory,
  buildSurvivorHistory,
  retryTransaction = false,
  transactionUnavailable = false,
} = {}) {
  const ids = {
    user: objectId(),
    otherUser: objectId(),
    park: objectId(),
    otherPark: objectId(),
    photo: objectId(),
    video: objectId(),
    otherPhoto: objectId(),
    otherVideo: objectId(),
    orphanPhoto: objectId(),
    orphanVideo: objectId(),
    ownedUpload: objectId(),
    relatedUpload: objectId(),
    unrelatedUpload: objectId(),
    existingJob: objectId(),
    unrelatedJob: objectId(),
  };
  const defaultUploads = [{
    _id: objectId(),
    mediaType: 'photo',
    mediaId: ids.photo,
    parkId: ids.park,
    userId: ids.user,
    cloudinaryPublicId: 'camp-pics/delete-me',
  }];
  const deletingUser = {
    _id: ids.user,
    username: 'Camper@Example.Test ',
    isAdmin: admin,
    hash: storedHash,
    salt: storedSalt,
    uploads: clone(buildDeletingHistory?.(ids) ?? []),
  };
  const survivor = {
    _id: ids.otherUser,
    username: 'other@example.test',
    hash: 'other-hash',
    salt: 'other-salt',
    uploads: clone(buildSurvivorHistory?.(ids) ?? [
      { mediaType: 'photo', mediaId: ids.photo, status: 'active' },
      { mediaType: 'photo', mediaId: ids.photo, status: 'active' },
      { mediaType: 'video', mediaId: ids.video, status: 'active' },
    ]),
  };
  const state = {
    users: missingUser ? [survivor] : [deletingUser, survivor],
    parks: clone(buildParks?.(ids) ?? [buildPark(ids)]),
    uploads: clone(buildUploads?.(ids) ?? defaultUploads),
    tokens: [
      { _id: objectId(), user_id: ids.user },
      { _id: objectId(), user_id: ids.otherUser },
    ],
    emails: [
      { _id: objectId(), userId: ids.user, to: 'elsewhere@example.test' },
      { _id: objectId(), userId: ids.otherUser, to: 'camper@example.test' },
      { _id: objectId(), userId: ids.otherUser, to: 'other@example.test' },
    ],
    monthlyDrawNoUploadEntries: [
      { _id: 'entry-current', userId: ids.user, monthKey: '2026-08' },
      { _id: 'entry-past', userId: ids.user, monthKey: '2026-07' },
      { _id: 'entry-other', userId: ids.otherUser, monthKey: '2026-08' },
    ],
    jobs: [
      {
        _id: ids.existingJob,
        mediaId: objectId(),
        parkId: ids.park,
        ownerUserId: ids.user,
        requestedByUserId: ids.otherUser,
        status: 'pending',
      },
      {
        _id: ids.unrelatedJob,
        mediaId: objectId(),
        parkId: ids.park,
        ownerUserId: ids.otherUser,
        requestedByUserId: ids.user,
        status: 'pending',
      },
    ],
  };
  const initial = clone(state);
  const session = { name: 'account-delete-session' };
  const calls = {
    sessions: [],
    events: [],
    transactionAttempts: 0,
    committed: false,
    cleanupIdsGenerated: [],
    cloudinary: 0,
    historyMediaIds: [],
    parkQueries: [],
    parkSaveIds: [],
    uploadDeleteFilters: [],
    monthlyDrawDeleteFilters: [],
    monthlyDrawDeleteCounts: [],
    monthlyDrawDeleteSessions: [],
  };
  let working;

  const recordSession = options => {
    calls.sessions.push(options?.session);
  };

  function attachParkSave(park) {
    park.save = async options => {
      recordSession(options);
      calls.events.push('park-save');
      calls.parkSaveIds.push(park._id);
      if (fault === 'park-save') throw new Error('injected park save');
      return park;
    };
    return park;
  }

  const UserModel = {
    async findOne(filter, projection, options) {
      recordSession(options);
      if (fault === 'user-reload') throw new Error('injected user reload');
      return working.users.find(user => idsEqual(user._id, filter._id)) || null;
    },
    async updateMany(filter, update, options) {
      recordSession(options);
      calls.events.push('history-update');
      if (fault === 'history-update') throw new Error('injected history');
      const entryFilter = options.arrayFilters[0];
      const mediaType = entryFilter['entry.mediaType'];
      const mediaIds = entryFilter['entry.mediaId'].$in;
      calls.historyMediaIds.push({ mediaType, mediaIds: [...mediaIds] });
      let modifiedCount = 0;
      for (const user of working.users) {
        if (idsEqual(user._id, ids.user)) continue;
        for (const entry of user.uploads || []) {
          if (
            entry.mediaType === mediaType &&
            mediaIds.some(mediaId => idsEqual(entry.mediaId, mediaId))
          ) {
            if (entry.status !== 'removed') modifiedCount += 1;
            entry.status = 'removed';
          }
        }
      }
      return { matchedCount: modifiedCount ? 1 : 0, modifiedCount };
    },
    async deleteOne(filter, options) {
      recordSession(options);
      calls.events.push('user-delete');
      if (fault === 'user-delete') throw new Error('injected user delete');
      const index = working.users.findIndex(user =>
        idsEqual(user._id, filter._id) &&
        user.hash === filter.hash &&
        user.salt === filter.salt &&
        user.isAdmin !== true
      );
      if (index < 0) return { deletedCount: 0 };
      working.users.splice(index, 1);
      return { deletedCount: 1 };
    },
  };

  const ParkModel = {
    async find(filter, projection, options) {
      recordSession(options);
      if (fault === 'park-lookup') throw new Error('injected park lookup');
      calls.parkQueries.push(clone(filter));
      return working.parks.filter(park => matchesPark(park, filter))
        .map(attachParkSave);
    },
  };

  const UploadModel = {
    async find(filter, projection, options) {
      recordSession(options);
      if (fault === 'upload-lookup') throw new Error('injected upload lookup');
      return working.uploads.filter(upload => matchesUpload(upload, filter));
    },
    async deleteMany(filter, options) {
      recordSession(options);
      calls.events.push('upload-delete');
      calls.uploadDeleteFilters.push(clone(filter));
      if (fault === 'upload-delete') throw new Error('injected upload delete');
      const before = working.uploads.length;
      working.uploads = working.uploads.filter(
        upload => !matchesUpload(upload, filter),
      );
      return { deletedCount: before - working.uploads.length };
    },
  };

  const TokenModel = {
    async deleteMany(filter, options) {
      recordSession(options);
      calls.events.push('token-delete');
      if (fault === 'token-delete') throw new Error('injected token delete');
      const before = working.tokens.length;
      working.tokens = working.tokens.filter(
        token => !idsEqual(token.user_id, filter.user_id),
      );
      return { deletedCount: before - working.tokens.length };
    },
  };

  const EmailModel = {
    async deleteMany(filter, options) {
      recordSession(options);
      calls.events.push('email-delete');
      if (fault === 'email-delete') throw new Error('injected email delete');
      const before = working.emails.length;
      working.emails = working.emails.filter(email =>
        !filter.$or.some(condition =>
          (condition.userId && idsEqual(email.userId, condition.userId)) ||
          (condition.to && email.to === condition.to)
        )
      );
      return { deletedCount: before - working.emails.length };
    },
  };

  const MonthlyDrawNoUploadEntryModel = {
    async deleteMany(filter, options) {
      recordSession(options);
      calls.events.push('monthly-draw-entry-delete');
      calls.monthlyDrawDeleteFilters.push(clone(filter));
      calls.monthlyDrawDeleteSessions.push(options?.session);
      if (fault === 'monthly-draw-entry-delete') {
        throw new Error('injected monthly draw entry delete');
      }
      const before = working.monthlyDrawNoUploadEntries.length;
      working.monthlyDrawNoUploadEntries =
        working.monthlyDrawNoUploadEntries.filter(entry =>
          !idsEqual(entry.userId, filter.userId)
        );
      const deletedCount =
        before - working.monthlyDrawNoUploadEntries.length;
      calls.monthlyDrawDeleteCounts.push(deletedCount);
      return { deletedCount };
    },
  };

  const CleanupJobModel = {
    async insertMany(records, options) {
      recordSession(options);
      calls.events.push('cleanup-insert');
      if (fault === 'cleanup-insert') throw new Error('injected cleanup insert');
      working.jobs.push(...clone(records));
      return records;
    },
    async updateMany(filter, update, options) {
      recordSession(options);
      calls.events.push('cleanup-reference-update');
      if (fault === 'cleanup-reference-update') {
        throw new Error('injected cleanup reference update');
      }
      const [field, userId] = Object.entries(filter)[0];
      let modifiedCount = 0;
      for (const job of working.jobs) {
        if (idsEqual(job[field], userId)) {
          delete job[field];
          modifiedCount += 1;
        }
      }
      return { matchedCount: modifiedCount, modifiedCount };
    },
  };

  const runAttempt = async work => {
    working = clone(state);
    calls.transactionAttempts += 1;
    try {
      return await work(session);
    } finally {
      working = undefined;
    }
  };

  const commitAttempt = async work => {
    working = clone(state);
    calls.transactionAttempts += 1;
    try {
      const result = await work(session);
      if (fault === 'commit') throw new Error('injected commit');
      state.users = working.users;
      state.parks = working.parks.map(park => {
        const copy = clone(park);
        delete copy.save;
        return copy;
      });
      state.uploads = working.uploads;
      state.tokens = working.tokens;
      state.emails = working.emails;
      state.monthlyDrawNoUploadEntries =
        working.monthlyDrawNoUploadEntries;
      state.jobs = working.jobs;
      calls.committed = true;
      return result;
    } finally {
      working = undefined;
    }
  };

  const transactionRunner = async work => {
    if (transactionUnavailable) {
      throw new MongoTransactionUnavailableError(new Error('unavailable'));
    }
    if (retryTransaction) {
      await runAttempt(work);
    }
    return commitAttempt(work);
  };

  const service = createAccountDeletionService({
    UserModel,
    ParkModel,
    UploadModel,
    TokenModel,
    EmailModel,
    CleanupJobModel,
    MonthlyDrawNoUploadEntryModel,
    transactionRunner,
    cleanupJobIdFactory() {
      const generated = objectId();
      calls.cleanupIdsGenerated.push(generated);
      return generated;
    },
    now: () => new Date('2026-07-31T12:00:00.000Z'),
    ...(fault === 'identity-resolution'
      ? {
        photoIdentityResolver() {
          throw new Error('injected identity resolver');
        },
      }
      : {}),
  });

  const remove = () => service.deleteAccount({
    userId: ids.user,
    authenticatedHash: requestHash,
    authenticatedSalt: requestSalt,
  });

  return { calls, ids, initial, remove, session, state };
}

async function deletionError(harness) {
  try {
    await harness.remove();
  } catch (error) {
    return error;
  }
  assert.fail('Expected account deletion to fail');
}

describe('transactional account deletion', () => {
  test('commits every representation with the guarded User delete last', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        const park = makePark(ids);
        park.photos.push({
          _id: objectId(),
          user: ids.otherUser,
          likedBy: [ids.user, ids.otherUser],
          url: OTHER_PHOTO_URL,
          cloudinaryPublicId: 'camp-pics/other',
        });
        park.reviews.push({
          _id: objectId(),
          user: ids.user,
          likedBy: [],
        });
        park.campsites.push({
          photos: [],
          videos: [{
            _id: ids.video,
            user: ids.user,
            likedBy: [],
            url: 'https://youtu.be/AAAAAAAAAAA',
          }],
          reviews: [],
        });
        return park;
      },
      buildUploads(ids) {
        return [
          {
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: objectId(),
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.otherUser,
            cloudinaryId: PHOTO_URL,
          },
          {
            _id: objectId(),
            mediaType: 'video',
            mediaId: ids.video,
            parkId: ids.park,
            userId: ids.user,
          },
        ];
      },
    });

    const result = await harness.remove();

    assert.equal(harness.calls.committed, true);
    assert.equal(result.cleanupJobIds.length, 1);
    assert.equal(result.counts.usersDeleted, 1);
    assert.equal(result.counts.photosRemoved, 1);
    assert.equal(result.counts.videosRemoved, 1);
    assert.equal(result.counts.reviewsRemoved, 1);
    assert.equal(result.counts.likesRemoved, 1);
    assert.equal(result.counts.monthlyDrawNoUploadEntriesDeleted, 2);
    assert.equal(harness.state.users.length, 1);
    assert.ok(idsEqual(harness.state.users[0]._id, harness.ids.otherUser));
    assert.deepEqual(
      harness.state.users[0].uploads.map(entry => entry.status),
      ['removed', 'removed', 'removed'],
    );
    assert.equal(harness.state.parks[0].photos.length, 1);
    assert.deepEqual(
      harness.state.parks[0].photos[0].likedBy.map(id),
      [id(harness.ids.otherUser)],
    );
    assert.equal(harness.state.parks[0].reviews.length, 0);
    assert.equal(harness.state.parks[0].campsites[0].videos.length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.tokens.length, 1);
    assert.equal(harness.state.emails.length, 1);
    assert.equal(harness.state.emails[0].to, 'other@example.test');
    assert.deepEqual(harness.state.monthlyDrawNoUploadEntries, [{
      _id: 'entry-other',
      userId: harness.ids.otherUser,
      monthKey: '2026-08',
    }]);
    assert.deepEqual(harness.calls.monthlyDrawDeleteFilters, [{
      userId: harness.ids.user,
    }]);
    assert.deepEqual(harness.calls.monthlyDrawDeleteSessions, [harness.session]);
    assert.equal(harness.state.jobs.length, 3);
    const newJob = harness.state.jobs.find(job =>
      idsEqual(job._id, result.cleanupJobIds[0])
    );
    assert.equal(newJob.cloudinaryPublicId, 'camp-pics/delete-me');
    assert.equal(newJob.status, 'pending');
    assert.equal(newJob.attemptCount, 0);
    assert.equal('ownerUserId' in newJob, false);
    assert.equal('requestedByUserId' in newJob, false);
    assert.equal(
      'ownerUserId' in harness.state.jobs[0],
      false,
    );
    assert.ok(idsEqual(
      harness.state.jobs[0].requestedByUserId,
      harness.ids.otherUser,
    ));
    assert.equal(
      'requestedByUserId' in harness.state.jobs[1],
      false,
    );
    assert.ok(idsEqual(
      harness.state.jobs[1].ownerUserId,
      harness.ids.otherUser,
    ));
    assert.equal(harness.calls.events.at(-1), 'user-delete');
    assert.ok(
      harness.calls.events.indexOf('monthly-draw-entry-delete') <
      harness.calls.events.lastIndexOf('user-delete'),
    );
    assert.ok(
      harness.calls.sessions.length > 0 &&
      harness.calls.sessions.every(value => value === harness.session),
    );
    assert.equal(harness.calls.cloudinary, 0);
  });

  test('a retried transaction reloads state and creates attempt-local job IDs', async () => {
    const harness = makeHarness({ retryTransaction: true });

    const result = await harness.remove();

    assert.equal(harness.calls.transactionAttempts, 2);
    assert.deepEqual(harness.calls.monthlyDrawDeleteCounts, [2, 2]);
    assert.equal(result.counts.monthlyDrawNoUploadEntriesDeleted, 2);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 2);
    assert.notEqual(
      id(harness.calls.cleanupIdsGenerated[0]),
      id(harness.calls.cleanupIdsGenerated[1]),
    );
    assert.deepEqual(
      result.cleanupJobIds.map(id),
      [id(harness.calls.cleanupIdsGenerated[1])],
    );
    assert.equal(harness.state.jobs.length, 3);
    assert.deepEqual(
      harness.state.monthlyDrawNoUploadEntries.map(entry => entry._id),
      ['entry-other'],
    );
  });
});

describe('account-deletion photo identity planning', () => {
  test('an embedded photo with no Upload resolves from embedded identity', async () => {
    const harness = makeHarness({ buildUploads: () => [] });
    const result = await harness.remove();

    assert.equal(result.cleanupJobIds.length, 1);
    assert.equal(harness.state.jobs.at(-1).cloudinaryPublicId, 'camp-pics/delete-me');
  });

  test('agreeing duplicate Upload records create one cleanup job', async () => {
    const harness = makeHarness({
      buildUploads(ids) {
        return [
          {
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryId: PHOTO_URL,
          },
        ];
      },
    });

    const result = await harness.remove();
    assert.equal(result.cleanupJobIds.length, 1);
    assert.equal(result.counts.uploadsDeleted, 2);
  });

  test('conflicting duplicate evidence blocks all deletion', async () => {
    const harness = makeHarness({
      buildUploads(ids) {
        return [
          {
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/conflict',
          },
        ];
      },
    });

    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('unresolved embedded identity blocks all deletion', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [makePhoto(ids, {
            url: 'https://legacy.example/photo.jpg',
            cloudinaryPublicId: undefined,
          })],
        });
      },
      buildUploads: () => [],
    });

    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('an embedded owned photo without a usable media ID blocks deletion', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [makePhoto(ids, { _id: undefined })],
        });
      },
      buildUploads: () => [],
    });

    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('a valid orphan photo Upload creates a durable cleanup job', async () => {
    const harness = makeHarness({
      buildPark: ids => makePark(ids, { photos: [] }),
      buildUploads(ids) {
        return [{
          mediaType: 'photo',
          mediaId: ids.orphanPhoto,
          parkId: ids.park,
          userId: ids.user,
          cloudinaryPublicId: 'camp-pics/orphan',
        }];
      },
    });

    const result = await harness.remove();
    assert.equal(result.cleanupJobIds.length, 1);
    assert.ok(idsEqual(
      harness.state.jobs.at(-1).mediaId,
      harness.ids.orphanPhoto,
    ));
    assert.equal(harness.state.jobs.at(-1).cloudinaryPublicId, 'camp-pics/orphan');
  });

  test('a legacy orphan with Cloudinary identity but no mediaType is treated as a photo', async () => {
    const harness = makeHarness({
      buildPark: ids => makePark(ids, { photos: [] }),
      buildUploads(ids) {
        return [{
          mediaId: ids.orphanPhoto,
          parkId: ids.park,
          userId: ids.user,
          cloudinaryId: 'camp-pics/legacy-orphan',
        }];
      },
    });

    const result = await harness.remove();
    assert.equal(result.cleanupJobIds.length, 1);
    assert.equal(
      harness.state.jobs.at(-1).cloudinaryPublicId,
      'camp-pics/legacy-orphan',
    );
  });

  test('an ambiguous orphan Upload blocks deletion for review', async () => {
    const harness = makeHarness({
      buildPark: ids => makePark(ids, { photos: [] }),
      buildUploads(ids) {
        return [{
          mediaId: ids.orphanPhoto,
          parkId: ids.park,
          userId: ids.user,
        }];
      },
    });

    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
  });

  for (const missing of ['mediaId', 'parkId']) {
    test(`an orphan photo missing ${missing} blocks deletion`, async () => {
      const harness = makeHarness({
        buildPark: ids => makePark(ids, { photos: [] }),
        buildUploads(ids) {
          return [{
            mediaType: 'photo',
            mediaId: missing === 'mediaId' ? undefined : ids.orphanPhoto,
            parkId: missing === 'parkId' ? undefined : ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/orphan',
          }];
        },
      });

      const error = await deletionError(harness);
      assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
      assert.deepEqual(harness.state, harness.initial);
    });
  }

  test('duplicate orphan records create one job per media ID', async () => {
    const harness = makeHarness({
      buildPark: ids => makePark(ids, { photos: [] }),
      buildUploads(ids) {
        return [
          {
            mediaType: 'photo',
            mediaId: ids.orphanPhoto,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/orphan',
          },
          {
            mediaType: 'photo',
            mediaId: ids.orphanPhoto,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryId: 'camp-pics/orphan',
          },
        ];
      },
    });

    const result = await harness.remove();
    assert.equal(result.cleanupJobIds.length, 1);
    assert.equal(result.counts.uploadsDeleted, 2);
  });

  test('an orphan Upload pointing at another user active photo blocks cleanup', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [makePhoto(ids, {
            _id: ids.orphanPhoto,
            user: ids.otherUser,
            cloudinaryPublicId: 'camp-pics/surviving',
          })],
        });
      },
      buildUploads(ids) {
        return [{
          mediaType: 'photo',
          mediaId: ids.orphanPhoto,
          parkId: ids.park,
          userId: ids.user,
          cloudinaryPublicId: 'camp-pics/surviving',
        }];
      },
    });

    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
  });
});

describe('validated video-deletion planning', () => {
  test('shared active video ID across two owners blocks every mutation', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [],
          videos: [
            makeVideo(ids),
            makeVideo(ids, { user: ids.otherUser }),
          ],
        });
      },
      buildUploads(ids) {
        return [
          {
            _id: objectId(),
            mediaType: 'video',
            mediaId: ids.video,
            parkId: ids.park,
            userId: ids.user,
          },
          {
            _id: objectId(),
            mediaType: 'video',
            mediaId: ids.video,
            parkId: ids.park,
            userId: ids.otherUser,
          },
        ];
      },
      buildDeletingHistory(ids) {
        return [{ mediaType: 'video', mediaId: ids.video, status: 'active' }];
      },
      buildSurvivorHistory(ids) {
        return [{ mediaType: 'video', mediaId: ids.video, status: 'active' }];
      },
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 0);
    assert.deepEqual(harness.calls.historyMediaIds, []);
    assert.equal(harness.calls.cloudinary, 0);
  });

  test('shared active video ID with a missing owner blocks every mutation', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [],
          videos: [
            makeVideo(ids),
            makeVideo(ids, { user: undefined }),
          ],
        });
      },
      buildUploads(ids) {
        return [{
          mediaType: 'video',
          mediaId: ids.video,
          parkId: ids.park,
          userId: ids.user,
        }];
      },
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
  });

  test('owned Upload pointing to another user active video blocks deletion', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [],
          videos: [makeVideo(ids, { user: ids.otherUser })],
        });
      },
      buildUploads(ids) {
        return [{
          mediaType: 'video',
          mediaId: ids.video,
          parkId: ids.park,
          userId: ids.user,
        }];
      },
      buildSurvivorHistory(ids) {
        return [{ mediaType: 'video', mediaId: ids.video, status: 'active' }];
      },
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
  });

  test('duplicate active videos all owned by deleting user are safely removed', async () => {
    const harness = makeHarness({
      buildPark(ids) {
        return makePark(ids, {
          photos: [],
          videos: [makeVideo(ids), makeVideo(ids)],
        });
      },
      buildUploads(ids) {
        return [
          {
            _id: objectId(),
            mediaType: 'video',
            mediaId: ids.video,
            parkId: ids.park,
            userId: ids.user,
          },
          {
            _id: objectId(),
            mediaType: 'video',
            mediaId: ids.video,
            parkId: ids.park,
            userId: ids.otherUser,
          },
        ];
      },
      buildSurvivorHistory(ids) {
        return [
          { mediaType: 'video', mediaId: ids.video, status: 'active' },
          { mediaType: 'video', mediaId: ids.video, status: 'active' },
        ];
      },
    });

    const result = await harness.remove();

    assert.equal(result.counts.videosRemoved, 2);
    assert.equal(result.counts.uploadsDeleted, 2);
    assert.equal(result.counts.videoHistoriesUpdated, 2);
    assert.equal(result.cleanupJobIds.length, 0);
    assert.equal(harness.state.parks[0].videos.length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.deepEqual(
      harness.state.users[0].uploads.map(entry => entry.status),
      ['removed', 'removed'],
    );
    assert.deepEqual(harness.calls.historyMediaIds, [{
      mediaType: 'video',
      mediaIds: [harness.ids.video],
    }]);
  });

  test('valid orphan video ID is safe for exact surviving-history tombstones', async () => {
    const harness = makeHarness({
      buildPark: ids => makePark(ids, { photos: [], videos: [] }),
      buildUploads(ids) {
        return [{
          mediaType: 'video',
          mediaId: ids.orphanVideo,
          parkId: ids.park,
          userId: ids.user,
        }];
      },
      buildSurvivorHistory(ids) {
        return [{
          mediaType: 'video',
          mediaId: ids.orphanVideo,
          status: 'active',
        }];
      },
    });

    const result = await harness.remove();

    assert.equal(result.counts.uploadsDeleted, 1);
    assert.equal(result.counts.videoHistoriesUpdated, 1);
    assert.equal(result.cleanupJobIds.length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.users[0].uploads[0].status, 'removed');
    assert.deepEqual(harness.calls.historyMediaIds, [{
      mediaType: 'video',
      mediaIds: [harness.ids.orphanVideo],
    }]);
  });

  test('missing-ID orphan video is removed only by userId', async () => {
    const harness = makeHarness({
      buildPark: ids => makePark(ids, { photos: [], videos: [] }),
      buildUploads(ids) {
        return [{
          mediaType: 'video',
          mediaId: undefined,
          parkId: ids.park,
          userId: ids.user,
        }];
      },
      buildSurvivorHistory(ids) {
        return [{ mediaType: 'video', mediaId: ids.video, status: 'active' }];
      },
    });

    const result = await harness.remove();

    assert.equal(result.counts.uploadsDeleted, 1);
    assert.equal(result.counts.videoHistoriesUpdated, 0);
    assert.equal(result.cleanupJobIds.length, 0);
    assert.equal(harness.state.uploads.length, 0);
    assert.equal(harness.state.users[0].uploads[0].status, 'active');
    assert.deepEqual(harness.calls.historyMediaIds, []);
  });
});

describe('complete active-media inventory and exact Upload deletion', () => {
  test('a video collision in a separate Park is loaded and blocks deletion', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [
          makePark(ids, {
            photos: [],
            videos: [makeVideo(ids)],
          }),
          makePark(ids, {
            _id: ids.otherPark,
            photos: [],
            videos: [makeVideo(ids, { user: ids.otherUser })],
          }),
        ];
      },
      buildUploads: () => [],
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.equal(harness.calls.parkQueries.length, 2);
    assert.ok(harness.calls.parkQueries[1].$or.some(condition =>
      condition['videos._id']?.$in?.some(mediaId =>
        idsEqual(mediaId, harness.ids.video)
      )
    ));
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 0);
    assert.equal(harness.calls.cloudinary, 0);
  });

  test('a photo collision in a separate Park is loaded and blocks deletion', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [
          makePark(ids),
          makePark(ids, {
            _id: ids.otherPark,
            photos: [makePhoto(ids, { user: ids.otherUser })],
          }),
        ];
      },
      buildUploads: () => [],
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.equal(harness.calls.parkQueries.length, 2);
    assert.ok(harness.calls.parkQueries[1].$or.some(condition =>
      condition['photos._id']?.$in?.some(mediaId =>
        idsEqual(mediaId, harness.ids.photo)
      )
    ));
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 0);
  });

  test('an owned photo ID colliding with an active video blocks deletion', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [
          makePark(ids),
          makePark(ids, {
            _id: ids.otherPark,
            photos: [],
            videos: [makeVideo(ids, {
              _id: ids.photo,
              user: ids.otherUser,
            })],
          }),
        ];
      },
      buildUploads: () => [],
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 0);
  });

  test('an owned video ID colliding with an active photo blocks deletion', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [
          makePark(ids, {
            photos: [],
            videos: [makeVideo(ids)],
          }),
          makePark(ids, {
            _id: ids.otherPark,
            photos: [makePhoto(ids, {
              _id: ids.video,
              user: ids.otherUser,
            })],
          }),
        ];
      },
      buildUploads: () => [],
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 0);
  });

  test('an owned orphan photo Upload colliding with an active video blocks deletion', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [makePark(ids, {
          _id: ids.otherPark,
          photos: [],
          videos: [makeVideo(ids, {
            _id: ids.orphanPhoto,
            user: ids.otherUser,
          })],
        })];
      },
      buildUploads(ids) {
        return [{
          _id: ids.ownedUpload,
          mediaType: 'photo',
          mediaId: ids.orphanPhoto,
          parkId: ids.otherPark,
          userId: ids.user,
          cloudinaryPublicId: 'camp-pics/orphan',
        }];
      },
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.equal(harness.calls.parkQueries.length, 2);
    const relatedPaths = harness.calls.parkQueries[1].$or.map(
      condition => Object.keys(condition)[0],
    );
    assert.ok(relatedPaths.includes('photos._id'));
    assert.ok(relatedPaths.includes('videos._id'));
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
    assert.deepEqual(harness.calls.historyMediaIds, []);
    assert.equal(harness.calls.cleanupIdsGenerated.length, 0);
  });

  test('an unrelated Park and its companions remain untouched and unsaved', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [
          makePark(ids),
          makePark(ids, {
            _id: ids.otherPark,
            photos: [makePhoto(ids, {
              _id: ids.otherPhoto,
              user: ids.otherUser,
              url: OTHER_PHOTO_URL,
              cloudinaryPublicId: 'camp-pics/other',
            })],
          }),
        ];
      },
      buildUploads(ids) {
        return [
          {
            _id: ids.ownedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: ids.unrelatedUpload,
            mediaType: 'photo',
            mediaId: ids.otherPhoto,
            parkId: ids.otherPark,
            userId: ids.otherUser,
            cloudinaryPublicId: 'camp-pics/other',
          },
        ];
      },
      buildSurvivorHistory(ids) {
        return [{
          mediaType: 'photo',
          mediaId: ids.otherPhoto,
          status: 'active',
        }];
      },
    });

    await harness.remove();

    const unrelatedPark = harness.state.parks.find(park =>
      idsEqual(park._id, harness.ids.otherPark)
    );
    assert.deepEqual(unrelatedPark, harness.initial.parks[1]);
    assert.deepEqual(harness.calls.parkSaveIds.map(id), [id(harness.ids.park)]);
    assert.equal(harness.state.uploads.length, 1);
    assert.ok(idsEqual(
      harness.state.uploads[0]._id,
      harness.ids.unrelatedUpload,
    ));
    assert.equal(harness.state.users[0].uploads[0].status, 'active');
  });

  test('related companions are deleted by exact _id while a cross-type Upload remains', async () => {
    const harness = makeHarness({
      buildUploads(ids) {
        return [
          {
            _id: ids.ownedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: ids.relatedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.otherUser,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: ids.unrelatedUpload,
            mediaType: 'video',
            mediaId: ids.photo,
            parkId: ids.otherPark,
            userId: ids.otherUser,
            youtubeId: 'BBBBBBBBBBB',
          },
        ];
      },
    });

    const result = await harness.remove();

    assert.equal(result.counts.uploadsDeleted, 2);
    assert.equal(harness.state.uploads.length, 1);
    assert.ok(idsEqual(
      harness.state.uploads[0]._id,
      harness.ids.unrelatedUpload,
    ));
    assert.deepEqual(harness.calls.uploadDeleteFilters, [{
      $or: [
        { userId: harness.ids.user },
        { _id: { $in: [harness.ids.relatedUpload] } },
      ],
    }]);
    assert.equal(
      JSON.stringify(harness.calls.uploadDeleteFilters).includes('mediaId'),
      false,
    );
  });

  test('a related companion Upload missing _id blocks deletion', async () => {
    const harness = makeHarness({
      buildUploads(ids) {
        return [
          {
            _id: ids.ownedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.otherUser,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
        ];
      },
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('an ambiguous related companion Upload blocks deletion', async () => {
    const harness = makeHarness({
      buildUploads(ids) {
        return [
          {
            _id: ids.ownedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: ids.relatedUpload,
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.otherUser,
          },
        ];
      },
    });

    const error = await deletionError(harness);

    assert.equal(error.code, ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED);
    assert.deepEqual(harness.calls.events, []);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('a complete collision-free plan saves each changed Park once', async () => {
    const harness = makeHarness({
      buildParks(ids) {
        return [
          makePark(ids, { videos: [makeVideo(ids)] }),
          makePark(ids, {
            _id: ids.otherPark,
            photos: [makePhoto(ids, {
              _id: ids.otherPhoto,
              user: ids.otherUser,
              url: OTHER_PHOTO_URL,
              cloudinaryPublicId: 'camp-pics/other',
            })],
          }),
        ];
      },
      buildUploads(ids) {
        return [
          {
            _id: ids.ownedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: ids.relatedUpload,
            mediaType: 'photo',
            mediaId: ids.photo,
            parkId: ids.park,
            userId: ids.user,
            cloudinaryPublicId: 'camp-pics/delete-me',
          },
          {
            _id: objectId(),
            mediaType: 'video',
            mediaId: ids.video,
            parkId: ids.park,
            userId: ids.user,
          },
          {
            _id: ids.unrelatedUpload,
            mediaType: 'photo',
            mediaId: ids.otherPhoto,
            parkId: ids.otherPark,
            userId: ids.otherUser,
            cloudinaryPublicId: 'camp-pics/other',
          },
        ];
      },
    });

    const result = await harness.remove();

    assert.equal(result.cleanupJobIds.length, 1);
    assert.equal(result.counts.photosRemoved, 1);
    assert.equal(result.counts.videosRemoved, 1);
    assert.equal(result.counts.uploadsDeleted, 3);
    assert.deepEqual(harness.calls.parkSaveIds.map(id), [id(harness.ids.park)]);
    assert.equal(new Set(harness.calls.parkSaveIds.map(id)).size, 1);
    assert.equal(harness.state.uploads.length, 1);
    assert.ok(idsEqual(
      harness.state.uploads[0]._id,
      harness.ids.unrelatedUpload,
    ));
  });
});

describe('account-deletion credential and transaction failures', () => {
  test('a missing User returns the stable not-found error', async () => {
    const harness = makeHarness({ missingUser: true });
    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_NOT_FOUND);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('an administrator is rejected before mutation', async () => {
    const harness = makeHarness({ admin: true });
    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_NOT_ALLOWED);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('a changed hash aborts the transaction without mutation', async () => {
    const harness = makeHarness({ storedHash: 'changed-hash' });
    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_CREDENTIAL_CHANGED);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('a changed salt aborts the transaction without mutation', async () => {
    const harness = makeHarness({ storedSalt: 'changed-salt' });
    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_CREDENTIAL_CHANGED);
    assert.deepEqual(harness.state, harness.initial);
  });

  for (const fault of [
    'user-reload',
    'park-lookup',
    'upload-lookup',
    'identity-resolution',
    'cleanup-insert',
    'park-save',
    'upload-delete',
    'history-update',
    'token-delete',
    'email-delete',
    'cleanup-reference-update',
    'monthly-draw-entry-delete',
    'user-delete',
    'commit',
  ]) {
    test(`${fault} commits no transactional change`, async () => {
      const harness = makeHarness({ fault });
      const error = await deletionError(harness);

      assert.equal(error.code, ACCOUNT_DELETE_PERSISTENCE_FAILED);
      assert.deepEqual(harness.state, harness.initial);
      assert.equal(harness.calls.committed, false);
      assert.equal(harness.calls.cloudinary, 0);
      assert.ok(harness.state.users.some(user =>
        idsEqual(user._id, harness.ids.user)
      ));
    });
  }

  test('transaction unavailability has a distinct safe error', async () => {
    const harness = makeHarness({ transactionUnavailable: true });
    const error = await deletionError(harness);
    assert.equal(error.code, ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE);
    assert.deepEqual(harness.state, harness.initial);
  });

  test('requires an injected monthly draw no-upload-entry model', () => {
    assert.throws(
      () => createAccountDeletionService({
        MonthlyDrawNoUploadEntryModel: null,
      }),
      TypeError,
    );
  });
});
