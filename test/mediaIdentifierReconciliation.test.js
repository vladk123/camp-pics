import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  getMediaIdentifierRecordAddressability,
  MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS,
  planMediaIdentifierGroup,
  reconcileMediaIdentifiers,
} from '../utils/mediaIdentifierReconciliation.js';
import {
  parseReconciliationArguments,
} from '../scripts/reconcileMediaIdentifiers.js';

const url = name =>
  `https://res.cloudinary.com/demo/image/upload/v123/camp-parks/${name}.jpg`;

function chunks(records, batchSize, observedBatchSizes) {
  return (async function* generate() {
    for (let index = 0; index < records.length; index += batchSize) {
      const batch = records.slice(index, index + batchSize);
      observedBatchSizes.push(batch.length);
      yield batch;
    }
  })();
}

function makeState() {
  return {
    embedded: [
      {
        recordId: 'photo-1',
        mediaId: 'media-1',
        parkId: 'park-1',
        locator: { level: 'park' },
        photo: { _id: 'photo-1', url: url('one') },
      },
      {
        recordId: 'photo-2',
        mediaId: 'media-2',
        parkId: 'park-1',
        locator: { level: 'park' },
        photo: {
          _id: 'photo-2',
          url: url('two'),
          cloudinaryPublicId: 'camp-parks/conflict',
        },
      },
      {
        recordId: 'photo-3',
        mediaId: 'media-3',
        parkId: 'park-2',
        locator: { level: 'standaloneCampsite', campsiteId: 'site-1' },
        photo: {
          _id: 'photo-3',
          url: 'https://historical-cdn.example/malformed.jpg',
        },
      },
      {
        recordId: 'photo-4',
        mediaId: 'media-4',
        parkId: 'park-2',
        locator: {
          level: 'campgroundCampsite',
          campgroundId: 'campground-1',
          campsiteId: 'site-2',
        },
        photo: { _id: 'photo-4', url: url('four') },
      },
    ],
    uploads: [
      {
        _id: 'upload-1',
        recordId: 'upload-1',
        mediaId: 'media-1',
        cloudinaryId: url('one'),
      },
      {
        _id: 'upload-5',
        recordId: 'upload-5',
        mediaId: 'media-5',
        cloudinaryId: url('five'),
      },
      {
        _id: 'upload-7',
        recordId: 'upload-7',
        mediaId: 'media-7',
        cloudinaryId: 'https://example.test/not-cloudinary.jpg',
      },
    ],
    users: [
      {
        recordId: 'history-1',
        mediaId: 'media-1',
        userId: 'user-1',
        upload: {
          _id: 'history-1',
          mediaId: 'media-1',
          cloudinaryUrl: url('one'),
        },
      },
      {
        recordId: 'history-6',
        mediaId: 'media-6',
        userId: 'user-2',
        upload: {
          _id: 'history-6',
          mediaId: 'media-6',
          cloudinaryUrl: url('six'),
        },
      },
    ],
  };
}

function duplicateIds(records) {
  const counts = new Map();
  records.forEach(record => {
    if (record.mediaId == null) return;
    counts.set(record.mediaId, (counts.get(record.mediaId) || 0) + 1);
  });
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([mediaId]) => mediaId);
}

function makeRepository(state) {
  const calls = {
    writes: [],
    batchSizes: [],
    created: 0,
    deleted: 0,
  };
  const byIds = (records, ids) => {
    const wanted = new Set(ids);
    return records.filter(record => wanted.has(record.mediaId));
  };

  const repository = {
    getDuplicateEmbeddedMediaIds: async () =>
      duplicateIds(state.embedded),
    getDuplicateUploadMediaIds: async () =>
      duplicateIds(state.uploads),
    getDuplicateUserHistoryMediaIds: async () =>
      duplicateIds(state.users),
    iterateEmbeddedPhotoBatches: batchSize =>
      chunks(state.embedded, batchSize, calls.batchSizes),
    iterateUploadPhotoBatches: batchSize =>
      chunks(state.uploads, batchSize, calls.batchSizes),
    iterateUserPhotoHistoryBatches: batchSize =>
      chunks(state.users, batchSize, calls.batchSizes),
    findUploadsByMediaIds: async ids => byIds(state.uploads, ids),
    findUserHistoryByMediaIds: async ids => byIds(state.users, ids),
    findExistingEmbeddedMediaIds: async ids => {
      const wanted = new Set(ids);
      return [...new Set(
        state.embedded
          .filter(record => wanted.has(record.mediaId))
          .map(record => record.mediaId),
      )];
    },
    async applyChange(change) {
      calls.writes.push({ ...change });
      if (change.kind === 'parkPhotoPublicId') {
        const record = state.embedded.find(item =>
          item.parkId === change.parkId &&
          item.mediaId === change.mediaId
        );
        if (!record) return 0;
        if (Object.hasOwn(record.photo, 'cloudinaryPublicId')) return 0;
        record.photo.cloudinaryPublicId = change.value;
        return 1;
      }
      if (change.kind === 'uploadPublicId') {
        const record = state.uploads.find(item =>
          item.recordId === change.recordId &&
          item.mediaId === change.mediaId
        );
        if (!record) return 0;
        if (Object.hasOwn(record, 'cloudinaryPublicId')) return 0;
        record.cloudinaryPublicId = change.value;
        return 1;
      }
      if (change.kind === 'uploadUrl') {
        const record = state.uploads.find(item =>
          item.recordId === change.recordId &&
          item.mediaId === change.mediaId
        );
        if (!record) return 0;
        if (Object.hasOwn(record, 'cloudinaryUrl')) return 0;
        record.cloudinaryUrl = change.value;
        return 1;
      }
      if (change.kind === 'userHistoryPublicId') {
        const record = state.users.find(item =>
          item.userId === change.userId &&
          item.recordId === change.recordId &&
          item.mediaId === change.mediaId
        );
        if (!record) return 0;
        if (Object.hasOwn(record.upload, 'cloudinaryPublicId')) return 0;
        record.upload.cloudinaryPublicId = change.value;
        return 1;
      }
      throw new Error(`Unexpected change kind: ${change.kind}`);
    },
  };

  return { calls, repository };
}

describe('media identifier reconciliation planning and execution', () => {
  test('pure addressability rejects null, empty, and object-like identifiers', () => {
    const reasons = MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS;
    assert.deepEqual(
      getMediaIdentifierRecordAddressability('userHistory', {
        userId: {},
        recordId: ' ',
        mediaId: null,
      }),
      {
        addressable: false,
        reasons: [
          reasons.MISSING_MEDIA_ID,
          reasons.USER_HISTORY_MISSING_USER_ID,
          reasons.USER_HISTORY_MISSING_RECORD_ID,
        ],
      },
    );
  });

  test('planner skips only unsafe targets in a mixed identity group', () => {
    const mediaId = 'mixed-media';
    const sharedUrl = url('mixed');
    const embedded = {
      mediaId,
      parkId: 'park-mixed',
      locator: { level: 'park' },
      photo: { url: sharedUrl },
    };
    const upload = {
      recordId: 'upload-mixed',
      mediaId,
      cloudinaryId: sharedUrl,
    };
    const userHistory = {
      userId: 'user-mixed',
      mediaId,
      upload: {
        mediaId,
        cloudinaryUrl: sharedUrl,
      },
    };

    const plan = planMediaIdentifierGroup({
      embeddedRecords: [embedded],
      uploadRecords: [upload],
      userHistoryEntries: [userHistory],
    });

    assert.equal(plan.conflict, false);
    assert.deepEqual(
      plan.changes.map(change => change.kind).sort(),
      ['parkPhotoPublicId', 'uploadPublicId', 'uploadUrl'].sort(),
    );
    assert.equal(
      plan.changes.some(change => change.kind === 'userHistoryPublicId'),
      false,
    );
    assert.deepEqual(plan.unaddressableRecords[0].reasons, [
      MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
        .USER_HISTORY_MISSING_RECORD_ID,
    ]);
  });

  test('planner applies every record-type addressability rule independently', () => {
    const reasons = MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS;
    const cases = [
      {
        recordType: 'userHistory',
        record: {
          recordId: 'history',
          mediaId: 'media',
          upload: { mediaId: 'media', cloudinaryUrl: url('user-no-parent') },
        },
        expected: reasons.USER_HISTORY_MISSING_USER_ID,
        kind: 'userHistoryPublicId',
      },
      {
        recordType: 'upload',
        record: {
          mediaId: 'media',
          cloudinaryId: url('upload-no-id'),
        },
        expected: reasons.UPLOAD_RECORD_MISSING_RECORD_ID,
        kind: 'uploadPublicId',
      },
      {
        recordType: 'embeddedPhoto',
        record: {
          mediaId: 'media',
          locator: { level: 'park' },
          photo: { url: url('root-no-park') },
        },
        expected: reasons.EMBEDDED_PHOTO_MISSING_PARK_ID,
        kind: 'parkPhotoPublicId',
      },
      {
        recordType: 'embeddedPhoto',
        record: {
          mediaId: 'media',
          parkId: 'park',
          locator: { level: 'standaloneCampsite' },
          photo: { url: url('standalone-no-site') },
        },
        expected: reasons.STANDALONE_PHOTO_MISSING_CAMPSITE_ID,
        kind: 'parkPhotoPublicId',
      },
      {
        recordType: 'embeddedPhoto',
        record: {
          mediaId: 'media',
          parkId: 'park',
          locator: {
            level: 'campgroundCampsite',
            campsiteId: 'site',
          },
          photo: { url: url('campground-no-campground') },
        },
        expected: reasons.CAMPGROUND_PHOTO_MISSING_CAMPGROUND_ID,
        kind: 'parkPhotoPublicId',
      },
      {
        recordType: 'embeddedPhoto',
        record: {
          mediaId: 'media',
          parkId: 'park',
          locator: {
            level: 'campgroundCampsite',
            campgroundId: 'campground',
          },
          photo: { url: url('campground-no-site') },
        },
        expected: reasons.CAMPGROUND_PHOTO_MISSING_CAMPSITE_ID,
        kind: 'parkPhotoPublicId',
      },
    ];

    cases.forEach(({ recordType, record, expected, kind }) => {
      const options = recordType === 'embeddedPhoto'
        ? { embeddedRecords: [record] }
        : recordType === 'upload'
          ? { uploadRecords: [record] }
          : { userHistoryEntries: [record] };
      const plan = planMediaIdentifierGroup(options);

      assert.equal(
        plan.changes.some(change => change.kind === kind),
        false,
        expected,
      );
      assert.ok(
        plan.unaddressableRecords[0].reasons.includes(expected),
        expected,
      );
    });
  });

  test('conflicting evidence from an unsafe companion skips the whole group', () => {
    const plan = planMediaIdentifierGroup({
      embeddedRecords: [{
        mediaId: 'conflict-media',
        parkId: 'conflict-park',
        locator: { level: 'park' },
        photo: { url: url('conflict-safe') },
      }],
      userHistoryEntries: [{
        mediaId: 'conflict-media',
        userId: 'conflict-user',
        upload: {
          mediaId: 'conflict-media',
          cloudinaryPublicId: 'camp-parks/conflicting-id',
        },
      }],
    });

    assert.equal(plan.conflict, true);
    assert.equal(plan.changes.length, 0);
    assert.deepEqual(plan.unaddressableRecords[0].reasons, [
      MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
        .USER_HISTORY_MISSING_RECORD_ID,
    ]);
  });

  test('argument parsing defaults to a bounded dry run', () => {
    assert.deepEqual(parseReconciliationArguments([]), {
      apply: false,
      batchSize: 100,
    });
    assert.deepEqual(
      parseReconciliationArguments(['--apply', '--batch-size', '25']),
      { apply: true, batchSize: 25 },
    );
    assert.throws(
      () => parseReconciliationArguments(['--batch-size=0']),
      /batch-size/,
    );
  });

  test('dry-run plans safe fields while performing zero writes', async () => {
    const state = makeState();
    const legacyValue = state.uploads[0].cloudinaryId;
    const { calls, repository } = makeRepository(state);

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: false,
      batchSize: 2,
    });

    assert.equal(summary.mode, 'DRY RUN');
    assert.equal(calls.writes.length, 0);
    assert.equal(summary.embeddedParkPhotosScanned, 4);
    assert.equal(summary.uploadPhotoRecordsScanned, 3);
    assert.equal(summary.userPhotoHistoryEntriesScanned, 2);
    assert.equal(summary.safelyBackfillableParkPhotoFields, 2);
    assert.equal(summary.safelyBackfillableUploadUrlFields, 2);
    assert.equal(summary.safelyBackfillableUploadPublicIdFields, 2);
    assert.equal(summary.safelyBackfillableUserHistoryPublicIdFields, 2);
    assert.equal(summary.plannedChanges, 8);
    assert.equal(summary.modifiedFields, 0);
    assert.equal(summary.conflictingIdentities, 1);
    assert.ok(summary.malformedUrls >= 2);
    assert.ok(summary.unresolvedIdentities >= 2);
    assert.equal(summary.embeddedParkPhotosMissingUploadRecord, 3);
    assert.equal(summary.embeddedParkPhotosMissingUserHistoryEntry, 3);
    assert.equal(summary.uploadRecordsWithoutEmbeddedParkPhoto, 2);
    assert.equal(summary.userHistoryEntriesWithoutEmbeddedParkPhoto, 1);
    assert.equal(state.uploads[0].cloudinaryId, legacyValue);
    assert.ok(calls.batchSizes.every(size => size <= 2));
  });

  test('apply writes only additive plans and a second apply is idempotent', async () => {
    const state = makeState();
    const legacyValues = state.uploads.map(upload => upload.cloudinaryId);
    const { calls, repository } = makeRepository(state);

    const first = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 2,
    });

    assert.equal(first.mode, 'APPLY MODE');
    assert.equal(first.modifiedFields, first.plannedChanges);
    assert.equal(first.modifiedFields, 8);
    assert.equal(state.embedded[0].photo.cloudinaryPublicId, 'camp-parks/one');
    assert.equal(state.embedded[3].photo.cloudinaryPublicId, 'camp-parks/four');
    assert.equal(state.uploads[0].cloudinaryUrl, url('one'));
    assert.equal(state.uploads[0].cloudinaryPublicId, 'camp-parks/one');
    assert.equal(state.uploads[1].cloudinaryUrl, url('five'));
    assert.equal(state.uploads[1].cloudinaryPublicId, 'camp-parks/five');
    assert.equal(
      state.users[0].upload.cloudinaryPublicId,
      'camp-parks/one',
    );
    assert.equal(
      state.users[1].upload.cloudinaryPublicId,
      'camp-parks/six',
    );
    assert.deepEqual(
      state.uploads.map(upload => upload.cloudinaryId),
      legacyValues,
    );

    assert.equal(
      state.embedded[1].photo.cloudinaryPublicId,
      'camp-parks/conflict',
    );
    assert.equal(
      Object.hasOwn(state.embedded[2].photo, 'cloudinaryPublicId'),
      false,
    );
    assert.equal(
      Object.hasOwn(state.uploads[2], 'cloudinaryPublicId'),
      false,
    );
    assert.equal(calls.created, 0);
    assert.equal(calls.deleted, 0);

    const writesAfterFirstApply = calls.writes.length;
    const second = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 2,
    });
    assert.equal(second.plannedChanges, 0);
    assert.equal(second.modifiedFields, 0);
    assert.equal(calls.writes.length, writesAfterFirstApply);
    assert.ok(
      second.recordsAlreadyContainingCorrectExplicitPublicId >= 6,
    );
  });

  test('duplicate media mappings are reported and remain unchanged', async () => {
    const state = makeState();
    state.uploads.push({
      _id: 'upload-duplicate',
      recordId: 'upload-duplicate',
      mediaId: 'media-1',
      cloudinaryId: url('one'),
    });
    const { calls, repository } = makeRepository(state);

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 1,
    });

    assert.equal(summary.duplicateUploadRecordsForMediaId, 1);
    assert.equal(
      calls.writes.some(change => change.mediaId === 'media-1'),
      false,
    );
    assert.equal(
      Object.hasOwn(state.embedded[0].photo, 'cloudinaryPublicId'),
      false,
    );
    assert.equal(
      Object.hasOwn(state.uploads[0], 'cloudinaryPublicId'),
      false,
    );
    assert.equal(
      Object.hasOwn(state.users[0].upload, 'cloudinaryPublicId'),
      false,
    );
  });

  test('records without mediaId are reported and never written', async () => {
    const state = makeState();
    state.uploads.push({
      _id: 'upload-without-media-id',
      recordId: 'upload-without-media-id',
      cloudinaryId: url('missing-media-id'),
    });
    const { calls, repository } = makeRepository(state);

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 2,
    });

    assert.equal(summary.recordsMissingMediaId, 1);
    assert.equal(summary.unaddressableRecords, 1);
    assert.equal(
      summary.samples.unaddressableRecords[0].reasonCode,
      MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS.MISSING_MEDIA_ID,
    );
    assert.equal(
      calls.writes.some(change =>
        change.recordId === 'upload-without-media-id'
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        state.uploads.at(-1),
        'cloudinaryPublicId',
      ),
      false,
    );
  });

  test('summary distinguishes every unaddressable selector reason', async () => {
    const state = {
      embedded: [
        {
          recordId: 'root-no-park',
          mediaId: 'root-no-park-media',
          locator: { level: 'park' },
          photo: { url: url('root-no-park') },
        },
        {
          recordId: 'standalone-no-site',
          mediaId: 'standalone-no-site-media',
          parkId: 'park',
          locator: { level: 'standaloneCampsite' },
          photo: { url: url('standalone-no-site') },
        },
        {
          recordId: 'campground-no-campground',
          mediaId: 'campground-no-campground-media',
          parkId: 'park',
          locator: {
            level: 'campgroundCampsite',
            campsiteId: 'site',
          },
          photo: { url: url('campground-no-campground') },
        },
        {
          recordId: 'campground-no-site',
          mediaId: 'campground-no-site-media',
          parkId: 'park',
          locator: {
            level: 'campgroundCampsite',
            campgroundId: 'campground',
          },
          photo: { url: url('campground-no-site') },
        },
      ],
      uploads: [{
        mediaId: 'upload-no-id-media',
        cloudinaryId: url('upload-no-id'),
      }],
      users: [
        {
          recordId: 'history-no-user',
          mediaId: 'history-no-user-media',
          upload: {
            _id: 'history-no-user',
            mediaId: 'history-no-user-media',
            cloudinaryUrl: url('history-no-user'),
          },
        },
        {
          userId: 'user',
          mediaId: 'history-no-id-media',
          upload: {
            mediaId: 'history-no-id-media',
            cloudinaryUrl: url('history-no-id'),
          },
        },
      ],
    };
    const { calls, repository } = makeRepository(state);

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 2,
    });

    assert.equal(calls.writes.length, 0);
    assert.equal(summary.unaddressableRecords, 7);
    assert.equal(summary.embeddedPhotosMissingParkId, 1);
    assert.equal(summary.standalonePhotosMissingCampsiteLocator, 1);
    assert.equal(summary.campgroundPhotosMissingCampgroundLocator, 1);
    assert.equal(summary.campgroundPhotosMissingCampsiteLocator, 1);
    assert.equal(summary.uploadRecordsMissingRecordId, 1);
    assert.equal(summary.userHistoryEntriesMissingUserId, 1);
    assert.equal(summary.userHistoryEntriesMissingRecordId, 1);
    assert.equal(summary.recordsMissingMediaId, 0);
    assert.ok(summary.samples.unaddressableRecords.every(sample => {
      const allowedKeys = new Set([
        'recordId',
        'mediaId',
        'parentRecordId',
        'reasonCode',
      ]);
      return Object.keys(sample).every(key => allowedKeys.has(key)) &&
        typeof sample.reasonCode === 'string';
    }));
  });

  test('zero-modification guarded writes are skipped, not counted as modified', async () => {
    const state = {
      embedded: [{
        recordId: 'photo-zero',
        mediaId: 'media-zero',
        parkId: 'park-zero',
        locator: { level: 'park' },
        photo: { _id: 'photo-zero', url: url('zero') },
      }],
      uploads: [],
      users: [],
    };
    const { calls, repository } = makeRepository(state);
    repository.applyChange = async change => {
      calls.writes.push(change);
      return 0;
    };

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 1,
    });

    assert.equal(summary.plannedChanges, 1);
    assert.equal(summary.modifiedFields, 0);
    assert.equal(summary.skippedRecords, 1);
    assert.equal(summary.samples.writeNotApplied.length, 1);
    assert.equal(
      Object.hasOwn(state.embedded[0].photo, 'cloudinaryPublicId'),
      false,
    );
  });

  test('two legacy history entries without subdocument IDs receive no writes', async () => {
    const state = {
      embedded: [],
      uploads: [],
      users: [
        {
          mediaId: 'legacy-media-a',
          userId: 'legacy-user',
          upload: {
            mediaId: 'legacy-media-a',
            cloudinaryUrl: url('legacy-a'),
          },
        },
        {
          mediaId: 'legacy-media-b',
          userId: 'legacy-user',
          upload: {
            mediaId: 'legacy-media-b',
            cloudinaryUrl: url('legacy-b'),
          },
        },
      ],
    };
    const { calls, repository } = makeRepository(state);

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 1,
    });

    assert.equal(calls.writes.length, 0);
    assert.equal(summary.unaddressableRecords, 2);
    assert.equal(summary.userHistoryEntriesMissingRecordId, 2);
    assert.ok(state.users.every(entry =>
      !Object.hasOwn(entry.upload, 'cloudinaryPublicId')
    ));
  });

  test('duplicate corrupt history IDs remain separated by mediaId', async () => {
    const state = {
      embedded: [],
      uploads: [],
      users: [
        {
          recordId: 'shared-corrupt-entry-id',
          mediaId: 'legacy-media-a',
          userId: 'legacy-user',
          upload: {
            _id: 'shared-corrupt-entry-id',
            mediaId: 'legacy-media-a',
            cloudinaryUrl: url('legacy-a'),
          },
        },
        {
          recordId: 'shared-corrupt-entry-id',
          mediaId: 'legacy-media-b',
          userId: 'legacy-user',
          upload: {
            _id: 'shared-corrupt-entry-id',
            mediaId: 'legacy-media-b',
            cloudinaryUrl: url('legacy-b'),
          },
        },
      ],
    };
    const { repository } = makeRepository(state);

    const summary = await reconcileMediaIdentifiers({
      repository,
      apply: true,
      batchSize: 1,
    });

    assert.equal(summary.modifiedFields, 2);
    assert.equal(
      state.users[0].upload.cloudinaryPublicId,
      'camp-parks/legacy-a',
    );
    assert.equal(
      state.users[1].upload.cloudinaryPublicId,
      'camp-parks/legacy-b',
    );
  });
});
