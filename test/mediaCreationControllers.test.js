import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  PHOTO_UPLOAD_CLEANUP_INCOMPLETE,
  createMediaHandlers,
} from '../controllers/media.js';
import { Park } from '../models/park.js';
import {
  MEDIA_PERSISTENCE_FAILED,
  MEDIA_QUOTA_CHANGED,
  MEDIA_TARGET_CHANGED,
  MEDIA_TRANSACTION_UNAVAILABLE,
  MEDIA_UPLOADER_NOT_FOUND,
  MediaPersistenceError,
} from '../utils/mediaPersistence.js';

const USER_ID = new mongoose.Types.ObjectId();
const DATE_TAKEN = '2026-01-01';

function makePark() {
  return new Park({
    name: 'Controller Park',
    slug: 'controller-park',
    province: 'Ontario',
    photos: [],
    videos: [],
    campsites: [{
      siteNumber: '12',
      slug: '12',
      photos: [],
      videos: [],
    }],
  });
}

function responseRecorder(events, { throwOnSuccess = false } = {}) {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      events.push(body?.success ? 'success-response' : 'error-response');
      if (throwOnSuccess && body?.success) {
        throw new Error('injected response serialization failure');
      }
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function photoRequest(fileCount = 1, params = {}) {
  return {
    params: {
      parkSlug: 'controller-park',
      ...params,
    },
    body: {
      caption: 'Prepared photo',
      dateTaken: DATE_TAKEN,
      showUsername: true,
    },
    files: Array.from({ length: fileCount }, (_, index) => ({
      buffer: Buffer.from(`photo-${index}`),
    })),
    user: {
      _id: USER_ID,
      fname: 'Camper',
      isAdmin: false,
    },
    is: value => value === 'multipart/form-data',
  };
}

function videoRequest(params = {}) {
  return {
    params: {
      parkSlug: 'controller-park',
      ...params,
    },
    body: {
      url: 'https://youtu.be/AAAAAAAAAAA',
      caption: 'Prepared video',
      dateTaken: DATE_TAKEN,
      showUsername: false,
    },
    user: {
      _id: USER_ID,
      fname: 'Camper',
      isAdmin: false,
    },
  };
}

function uploadResult(index) {
  return {
    secure_url:
      `https://res.cloudinary.com/demo/image/upload/v1/camp-parks/${index}.jpg`,
    public_id: `camp-parks/${index}`,
  };
}

function createHarness({
  park = makePark(),
  uploadResults = [uploadResult(1)],
  persistenceError = null,
  cleanupFailureAt = null,
  throwOnSuccess = false,
} = {}) {
  const events = [];
  const calls = {
    destroyed: [],
    persistence: [],
    uploads: 0,
  };
  let uploadIndex = 0;

  const mediaPersistence = {
    async commitMediaCreation(payload) {
      events.push('transaction-start');
      calls.persistence.push(payload);
      if (persistenceError) throw persistenceError;
      events.push('transaction-commit');
      return {
        mediaType: payload.mediaType,
        mediaIds: payload.preparedMedia.map(item => item.mediaId),
        remaining: payload.mediaType === 'photo'
          ? 2 - payload.preparedMedia.length
          : 1,
      };
    },
  };
  const handlers = createMediaHandlers({
    ParkModel: {
      async findOne() {
        events.push('preflight');
        return park;
      },
    },
    UploadModel: {},
    UserModel: {},
    mediaPersistence,
    cloudinaryClient: {
      uploader: {
        upload_stream(options, callback) {
          const current = uploadIndex;
          const result = uploadResults[uploadIndex++];
          calls.uploads += 1;
          events.push(`cloudinary-${current + 1}`);
          return new Writable({
            write(chunk, encoding, done) {
              done();
            },
            final(done) {
              queueMicrotask(() => {
                if (result instanceof Error) callback(result);
                else callback(null, result);
              });
              done();
            },
          });
        },
        async destroy(publicId) {
          calls.destroyed.push(publicId);
          const index = calls.destroyed.length;
          if (cleanupFailureAt === index) {
            throw new Error('injected cleanup failure');
          }
          return { result: 'ok' };
        },
      },
    },
    uploadMiddleware: {
      array() {
        return (req, res, callback) => callback();
      },
    },
    validateImage: async () => ({ valid: true }),
  });

  async function invoke(handler, req) {
    const res = responseRecorder(events, { throwOnSuccess });
    let nextError;
    await handler(req, res, error => {
      nextError = error;
    });
    return { nextError, res };
  }

  return { calls, events, handlers, invoke };
}

describe('transactional photo creation controller', () => {
  test('prepares an exact multi-photo batch and responds only after commit', async () => {
    const results = [uploadResult(1), uploadResult(2)];
    const harness = createHarness({ uploadResults: results });

    const { nextError, res } = await harness.invoke(
      harness.handlers.uploadPhoto,
      photoRequest(2),
    );

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.added, 2);
    assert.deepEqual(harness.events, [
      'preflight',
      'cloudinary-1',
      'cloudinary-2',
      'transaction-start',
      'transaction-commit',
      'success-response',
    ]);
    assert.equal(harness.calls.persistence.length, 1);
    const prepared = harness.calls.persistence[0].preparedMedia;
    assert.ok(Object.isFrozen(prepared));
    assert.equal(prepared.length, 2);
    assert.ok(prepared.every(item => Object.isFrozen(item)));
    assert.ok(prepared.every(item => item.mediaId && item.uploadId));
    assert.deepEqual(
      prepared.map(item => [
        item.cloudinaryUrl,
        item.cloudinaryPublicId,
      ]),
      results.map(item => [item.secure_url, item.public_id]),
    );
    assert.equal(harness.calls.destroyed.length, 0);
  });

  test('a Cloudinary preparation failure cleans prior exact IDs and skips Mongo', async () => {
    const harness = createHarness({
      uploadResults: [
        uploadResult(1),
        new Error('injected Cloudinary upload failure'),
      ],
    });

    const { res } = await harness.invoke(
      harness.handlers.uploadPhoto,
      photoRequest(2),
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'UPLOAD_FAILED');
    assert.deepEqual(harness.calls.destroyed, ['camp-parks/1']);
    assert.equal(harness.calls.persistence.length, 0);
  });

  for (const code of [
    MEDIA_PERSISTENCE_FAILED,
    MEDIA_TARGET_CHANGED,
    MEDIA_UPLOADER_NOT_FOUND,
    MEDIA_TRANSACTION_UNAVAILABLE,
  ]) {
    test(`${code} cleans every prepared asset and never succeeds`, async () => {
      const harness = createHarness({
        uploadResults: [uploadResult(1), uploadResult(2)],
        persistenceError: new MediaPersistenceError(code),
      });

      const { res } = await harness.invoke(
        harness.handlers.uploadPhoto,
        photoRequest(2),
      );

      assert.notEqual(res.statusCode, 200);
      assert.equal(res.body.code, code);
      assert.equal(res.body.success, undefined);
      assert.deepEqual(harness.calls.destroyed, [
        'camp-parks/1',
        'camp-parks/2',
      ]);
      assert.ok(harness.calls.destroyed.every(value =>
        typeof value === 'string' &&
        value.length > 0 &&
        !value.startsWith('http')
      ));
    });
  }

  test('fresh quota rejection aborts the whole batch, cleans all assets and returns 409', async () => {
    const harness = createHarness({
      uploadResults: [uploadResult(1), uploadResult(2)],
      persistenceError: new MediaPersistenceError(MEDIA_QUOTA_CHANGED),
    });

    const { res } = await harness.invoke(
      harness.handlers.uploadPhoto,
      photoRequest(2),
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, MEDIA_QUOTA_CHANGED);
    assert.deepEqual(harness.calls.destroyed, [
      'camp-parks/1',
      'camp-parks/2',
    ]);
  });

  test('cleanup failure returns the distinct bounded error', async () => {
    const harness = createHarness({
      persistenceError: new MediaPersistenceError(
        MEDIA_PERSISTENCE_FAILED,
      ),
      cleanupFailureAt: 1,
    });
    const originalConsoleError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args);
    let result;
    try {
      result = await harness.invoke(
        harness.handlers.uploadPhoto,
        photoRequest(),
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(result.res.statusCode, 500);
    assert.equal(
      result.res.body.code,
      PHOTO_UPLOAD_CLEANUP_INCOMPLETE,
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].failureCount, 1);
    assert.equal(logs[0][1].mediaIds.length, 1);
    assert.equal(
      Object.hasOwn(logs[0][1], 'cloudinaryPublicId'),
      false,
    );
  });

  test('response failure after commit does not clean or roll back', async () => {
    const harness = createHarness({ throwOnSuccess: true });

    const { nextError } = await harness.invoke(
      harness.handlers.uploadPhoto,
      photoRequest(),
    );

    assert.match(nextError.message, /serialization failure/);
    assert.equal(harness.calls.persistence.length, 1);
    assert.equal(harness.calls.destroyed.length, 0);
    assert.deepEqual(harness.events.slice(-2), [
      'transaction-commit',
      'success-response',
    ]);
  });
});

describe('transactional video creation controller', () => {
  test('preassigns one media ID and responds only after the transaction commit', async () => {
    const harness = createHarness();

    const { nextError, res } = await harness.invoke(
      harness.handlers.addVideo,
      videoRequest(),
    );

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const prepared = harness.calls.persistence[0].preparedMedia[0];
    assert.equal(
      prepared.mediaId.toString(),
      res.body.addedVideo._id.toString(),
    );
    assert.equal(prepared.youtubeUrl, res.body.addedVideo.url);
    assert.deepEqual(harness.events, [
      'preflight',
      'transaction-start',
      'transaction-commit',
      'success-response',
    ]);
  });

  for (const [code, status] of [
    [MEDIA_QUOTA_CHANGED, 409],
    [MEDIA_TARGET_CHANGED, 409],
    [MEDIA_UPLOADER_NOT_FOUND, 409],
    [MEDIA_TRANSACTION_UNAVAILABLE, 503],
    [MEDIA_PERSISTENCE_FAILED, 500],
  ]) {
    test(`${code} returns a stable safe video failure`, async () => {
      const harness = createHarness({
        persistenceError: new MediaPersistenceError(code),
      });

      const { nextError, res } = await harness.invoke(
        harness.handlers.addVideo,
        videoRequest(),
      );

      assert.equal(nextError, undefined);
      assert.equal(res.statusCode, status);
      assert.equal(res.body.code, code);
      assert.equal(res.body.success, undefined);
      assert.equal(harness.calls.destroyed.length, 0);
    });
  }

  test('video response failure after commit does not invoke persistence again', async () => {
    const harness = createHarness({ throwOnSuccess: true });

    const { nextError } = await harness.invoke(
      harness.handlers.addVideo,
      videoRequest(),
    );

    assert.match(nextError.message, /serialization failure/);
    assert.equal(harness.calls.persistence.length, 1);
    assert.equal(harness.calls.destroyed.length, 0);
  });
});
