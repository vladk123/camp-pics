import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import { createMediaHandlers } from '../controllers/media.js';
import { Park } from '../models/park.js';
import { Upload } from '../models/upload.js';
import { User } from '../models/user.js';

const USER_ID = new mongoose.Types.ObjectId();
const OTHER_USER_ID = new mongoose.Types.ObjectId();
const DATE_TAKEN = '2026-01-01';

test('photo identity schema additions are optional and do not alter video shapes', () => {
  const photoSchema = Park.schema.path('photos').schema;
  const videoSchema = Park.schema.path('videos').schema;
  const userUploadSchema = User.schema.path('uploads').schema;

  assert.ok(photoSchema.path('cloudinaryPublicId'));
  assert.equal(photoSchema.path('cloudinaryPublicId').options.required, undefined);
  assert.equal(videoSchema.path('cloudinaryPublicId'), undefined);
  assert.ok(Upload.schema.path('cloudinaryId'));
  assert.ok(Upload.schema.path('cloudinaryUrl'));
  assert.ok(Upload.schema.path('cloudinaryPublicId'));
  assert.equal(
    Upload.schema.path('cloudinaryPublicId').options.required,
    undefined,
  );
  assert.ok(userUploadSchema.path('cloudinaryUrl'));
  assert.ok(userUploadSchema.path('cloudinaryPublicId'));
  assert.equal(videoSchema.path('cloudinaryPublicId'), undefined);
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

async function invoke(handler, req) {
  const res = responseRecorder();
  let nextError;
  await handler(req, res, error => {
    nextError = error;
  });
  assert.equal(nextError, undefined);
  return res;
}

function makePark(photo = null) {
  const park = new Park({
    name: 'Identity Park',
    slug: 'identity-park',
    province: 'Ontario',
    photos: photo ? [photo] : [],
    videos: [],
  });
  return park;
}

function makeUploadRequest(fileCount = 1) {
  return {
    params: { parkSlug: 'identity-park' },
    body: {
      caption: 'A campsite',
      dateTaken: DATE_TAKEN,
      showUsername: true,
    },
    files: Array.from({ length: fileCount }, (_, index) => ({
      buffer: Buffer.from(`image-${index}`),
    })),
    user: {
      _id: USER_ID,
      fname: 'Camper',
      isAdmin: false,
    },
    is: value => value === 'multipart/form-data',
  };
}

function makeHarness({
  park,
  uploadResults = [],
  uploadRecord = null,
  failUploadCreateAt = null,
  destroyResult = 'ok',
} = {}) {
  const session = { id: 'photo-identity-session' };
  const calls = {
    cloudinaryDeletes: [],
    uploadCreates: [],
    uploadDeletes: [],
    uploadFinds: [],
    uploadRollbackDeletes: [],
    cleanupJobs: [],
    userPushes: [],
    userUpdates: [],
    parkSaves: 0,
  };
  let uploadIndex = 0;

  park.save = async options => {
    calls.parkSaves += 1;
    if (options) assert.equal(options.session, session);
    return park;
  };

  const cloudinaryClient = {
    uploader: {
      upload_stream(options, callback) {
        const result = uploadResults[uploadIndex++];
        return new Writable({
          write(chunk, encoding, done) {
            done();
          },
          final(done) {
            queueMicrotask(() => callback(null, result));
            done();
          },
        });
      },
      async destroy(publicId) {
        calls.cloudinaryDeletes.push(publicId);
        return { result: destroyResult };
      },
    },
  };

  const handlers = createMediaHandlers({
    ParkModel: {
      findOne: async () => park,
      findByIdAndUpdate: async () => {},
    },
    UploadModel: {
      insertMany: async (data, options) => {
        assert.equal(options.session, session);
        calls.uploadCreates.push(...data);
        if (
          failUploadCreateAt != null &&
          calls.uploadCreates.length >= failUploadCreateAt
        ) {
          throw new Error('injected Upload create failure');
        }
        return data;
      },
      find: async query => {
        calls.uploadFinds.push(query);
        return uploadRecord ? [uploadRecord] : [];
      },
      deleteMany: async (query, options) => {
        if (options?.session) {
          assert.equal(options.session, session);
          calls.uploadDeletes.push(query);
        } else {
          calls.uploadRollbackDeletes.push(query);
        }
      },
    },
    UserModel: {
      updateOne: async (...args) => {
        if (args[1]?.$push?.uploads) {
          assert.equal(args[2]?.session, session);
          calls.userPushes.push(args);
        } else {
          calls.userUpdates.push(args);
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    CleanupJobModel: {
      insertMany: async (records, options) => {
        assert.equal(options.session, session);
        calls.cleanupJobs.push(...records);
        return records;
      },
    },
    cloudinaryClient,
    mediaCleanupJobs: {
      async processJobById(jobId) {
        const job = calls.cleanupJobs.find(item =>
          item._id.toString() === jobId.toString()
        );
        const result = await cloudinaryClient.uploader.destroy(
          job.cloudinaryPublicId,
        );
        return {
          completed:
            result.result === 'ok' ||
            result.result === 'not found',
          status: 'completed',
        };
      },
    },
    uploadMiddleware: {
      array() {
        return (req, res, callback) => callback();
      },
    },
    validateImage: async () => ({ valid: true }),
    transactionRunner: async work => {
      const photoSnapshot = park.photos.map(photo => photo.toObject());
      const cleanupSnapshot = [...calls.cleanupJobs];
      try {
        return await work(session);
      } catch (error) {
        park.photos.splice(0, park.photos.length, ...photoSnapshot);
        calls.cleanupJobs.splice(
          0,
          calls.cleanupJobs.length,
          ...cleanupSnapshot,
        );
        throw error;
      }
    },
  });

  return { calls, handlers };
}

describe('new photo identity persistence and failed-request cleanup', () => {
  test('keeps secure URLs and returned public IDs paired across every write', async () => {
    const park = makePark();
    const uploadResults = [
      {
        secure_url:
          'https://res.cloudinary.com/demo/image/upload/v100/camp-parks/first.jpg',
        public_id: 'camp-parks/first',
      },
      {
        secure_url:
          'https://res.cloudinary.com/demo/image/upload/v101/camp-parks/second.webp',
        public_id: 'camp-parks/second',
      },
    ];
    const { calls, handlers } = makeHarness({ park, uploadResults });

    const res = await invoke(handlers.uploadPhoto, makeUploadRequest(2));

    assert.equal(res.statusCode, 200);
    assert.equal(park.photos.length, 2);
    assert.deepEqual(
      park.photos.map(photo => [photo.url, photo.cloudinaryPublicId]),
      uploadResults.map(result => [result.secure_url, result.public_id]),
    );
    assert.deepEqual(
      calls.uploadCreates.map(upload => [
        upload.cloudinaryUrl,
        upload.cloudinaryPublicId,
        upload.cloudinaryId,
      ]),
      uploadResults.map(result => [
        result.secure_url,
        result.public_id,
        result.secure_url,
      ]),
    );
    assert.deepEqual(
      calls.userPushes[0][1].$push.uploads.$each.map(entry => [
        entry.cloudinaryUrl,
        entry.cloudinaryPublicId,
      ]),
      uploadResults.map(result => [result.secure_url, result.public_id]),
    );
    assert.equal(
      Object.hasOwn(
        calls.userPushes[0][1].$push.uploads.$each[0],
        'cloudinaryId',
      ),
      false,
    );
  });

  test('cleanup uses only exact validated public IDs returned in this request', async () => {
    const park = makePark();
    const uploadResults = [
      {
        secure_url:
          'https://res.cloudinary.com/demo/image/upload/v100/camp-parks/first.jpg',
        public_id: 'camp-parks/first',
      },
      {
        secure_url:
          'https://res.cloudinary.com/demo/image/upload/v101/camp-parks/second.jpg',
        public_id: 'camp-parks/second',
      },
    ];
    const { calls, handlers } = makeHarness({
      park,
      uploadResults,
      failUploadCreateAt: 1,
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    let res;
    try {
      res = await invoke(handlers.uploadPhoto, makeUploadRequest(2));
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(res.statusCode, 500);
    assert.deepEqual(calls.cloudinaryDeletes, [
      'camp-parks/first',
      'camp-parks/second',
    ]);
    assert.ok(calls.cloudinaryDeletes.every(value =>
      typeof value === 'string' &&
      value.length > 0 &&
      !value.startsWith('http'),
    ));
    assert.equal(park.photos.length, 0);
  });

  test('a missing returned public ID is never inferred from the delivery URL', async () => {
    const park = makePark();
    const { calls, handlers } = makeHarness({
      park,
      uploadResults: [{
        secure_url:
          'https://res.cloudinary.com/demo/image/upload/v100/camp-parks/infer-me.jpg',
        public_id: null,
      }],
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    let res;
    try {
      res = await invoke(handlers.uploadPhoto, makeUploadRequest());
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(res.statusCode, 500);
    assert.equal(park.photos.length, 0);
    assert.equal(calls.uploadCreates.length, 0);
    assert.equal(calls.userPushes.length, 0);
    assert.deepEqual(calls.cloudinaryDeletes, []);
  });
});

function makeDeletionRequest(photoId, user = USER_ID) {
  return {
    params: {
      parkSlug: 'identity-park',
      photoId,
    },
    user: {
      _id: user,
      isAdmin: false,
    },
  };
}

describe('ordinary photo deletion identity compatibility', () => {
  const versionedUrl =
    'https://res.cloudinary.com/demo/image/upload/v123/camp-parks/example.jpg';

  const cases = [
    {
      name: 'new embedded explicit public ID',
      photo: {
        url: versionedUrl,
        cloudinaryPublicId: 'camp-parks/example',
      },
      upload: null,
    },
    {
      name: 'legacy Park URL',
      photo: { url: versionedUrl },
      upload: null,
    },
    {
      name: 'new Upload public ID fallback',
      photo: { url: 'https://historical-cdn.example/photo.jpg' },
      upload: { cloudinaryPublicId: 'camp-parks/example' },
    },
    {
      name: 'new Upload URL fallback',
      photo: { url: 'https://historical-cdn.example/photo.jpg' },
      upload: { cloudinaryUrl: versionedUrl },
    },
    {
      name: 'legacy Upload URL fallback',
      photo: { url: 'https://historical-cdn.example/photo.jpg' },
      upload: { cloudinaryId: versionedUrl },
    },
    {
      name: 'legacy Upload public-ID fallback',
      photo: { url: 'https://historical-cdn.example/photo.jpg' },
      upload: { cloudinaryId: 'camp-parks/example' },
    },
    {
      name: 'agreeing mixed identity data',
      photo: {
        url: versionedUrl,
        cloudinaryPublicId: 'camp-parks/example',
      },
      upload: {
        cloudinaryUrl: versionedUrl,
        cloudinaryPublicId: 'camp-parks/example',
        cloudinaryId: versionedUrl,
      },
    },
  ];

  cases.forEach(({ name, photo: identity, upload }) => {
    test(name, async () => {
      const park = makePark({
        user: USER_ID,
        dateTaken: DATE_TAKEN,
        ...identity,
      });
      const photoId = park.photos[0]._id.toString();
      const { calls, handlers } = makeHarness({
        park,
        uploadRecord: upload,
      });

      const res = await invoke(
        handlers.deletePhoto,
        makeDeletionRequest(photoId),
      );

      assert.equal(res.statusCode, 200);
      assert.deepEqual(calls.cloudinaryDeletes, ['camp-parks/example']);
      assert.equal(park.photos.length, 0);
      assert.equal(calls.uploadDeletes.length, 1);
      assert.equal(calls.userUpdates.length, 1);
      assert.deepEqual(calls.uploadFinds[0], {
        mediaType: 'photo',
        mediaId: calls.uploadFinds[0].mediaId,
      });
      assert.equal(calls.uploadFinds[0].mediaId.toString(), photoId);
    });
  });

  test('Cloudinary not-found is accepted as an idempotent deletion result', async () => {
    const park = makePark({
      user: USER_ID,
      dateTaken: DATE_TAKEN,
      url: versionedUrl,
    });
    const { calls, handlers } = makeHarness({
      park,
      destroyResult: 'not found',
    });

    const res = await invoke(
      handlers.deletePhoto,
      makeDeletionRequest(park.photos[0]._id.toString()),
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cleanupPending, false);
    assert.equal(calls.uploadDeletes.length, 1);
    assert.equal(calls.userUpdates.length, 1);
    assert.equal(park.photos.length, 0);
  });

  test('conflicting evidence returns 409 before Cloudinary or Mongo mutation', async () => {
    const park = makePark({
      user: USER_ID,
      dateTaken: DATE_TAKEN,
      url: versionedUrl,
      cloudinaryPublicId: 'camp-parks/different',
    });
    const { calls, handlers } = makeHarness({ park });

    const res = await invoke(
      handlers.deletePhoto,
      makeDeletionRequest(park.photos[0]._id.toString()),
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'CLOUDINARY_IDENTITY_CONFLICT');
    assert.equal(calls.cloudinaryDeletes.length, 0);
    assert.equal(calls.uploadDeletes.length, 0);
    assert.equal(calls.userUpdates.length, 0);
    assert.equal(calls.parkSaves, 0);
    assert.equal(park.photos.length, 1);
  });

  test('unresolved evidence returns a stable safe response before mutation', async () => {
    const park = makePark({
      user: USER_ID,
      dateTaken: DATE_TAKEN,
      url: 'https://historical-cdn.example/photo.jpg',
    });
    const { calls, handlers } = makeHarness({
      park,
      uploadRecord: { cloudinaryId: 'https://example.test/not-cloudinary.jpg' },
    });

    const res = await invoke(
      handlers.deletePhoto,
      makeDeletionRequest(park.photos[0]._id.toString()),
    );

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
      error: 'Photo identity could not be resolved.',
      code: 'PHOTO_IDENTITY_UNRESOLVED',
    });
    assert.equal(calls.cloudinaryDeletes.length, 0);
    assert.equal(calls.uploadDeletes.length, 0);
    assert.equal(calls.userUpdates.length, 0);
    assert.equal(calls.parkSaves, 0);
    assert.equal(park.photos.length, 1);
  });

  test('permission checks run before identity lookup or deletion', async () => {
    const park = makePark({
      user: OTHER_USER_ID,
      dateTaken: DATE_TAKEN,
      url: versionedUrl,
    });
    const { calls, handlers } = makeHarness({ park });

    const res = await invoke(
      handlers.deletePhoto,
      makeDeletionRequest(park.photos[0]._id.toString()),
    );

    assert.equal(res.statusCode, 403);
    assert.equal(calls.uploadFinds.length, 0);
    assert.equal(calls.cloudinaryDeletes.length, 0);
    assert.equal(calls.uploadDeletes.length, 0);
    assert.equal(calls.userUpdates.length, 0);
    assert.equal(calls.parkSaves, 0);
  });
});
