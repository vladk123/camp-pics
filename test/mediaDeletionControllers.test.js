import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  PHOTO_CLEANUP_PENDING,
  createMediaHandlers,
} from '../controllers/media.js';
import {
  MEDIA_DELETE_TRANSACTION_UNAVAILABLE,
  MediaDeletionError,
} from '../utils/mediaDeletion.js';

function responseRecorder({ throwOnJson = false } = {}) {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      if (throwOnJson) throw new Error('response disconnected');
      this.body = body;
      return this;
    },
  };
}

function request(mediaType = 'photo') {
  return {
    params: {
      parkSlug: 'controller-park',
      [mediaType === 'photo' ? 'photoId' : 'videoId']:
        new mongoose.Types.ObjectId().toString(),
    },
    user: {
      _id: new mongoose.Types.ObjectId(),
      isAdmin: false,
    },
  };
}

async function invoke(handler, req, responseOptions) {
  const res = responseRecorder(responseOptions);
  let nextError;
  await handler(req, res, error => {
    nextError = error;
  });
  return { nextError, res };
}

function makeHandlers({
  cleanupResult = { completed: true, status: 'completed' },
  cleanupThrows = false,
  deletionThrows = null,
  events = [],
} = {}) {
  const mediaId = new mongoose.Types.ObjectId();
  const cleanupJobId = new mongoose.Types.ObjectId();
  const mediaDeletion = {
    async deleteMedia(input) {
      if (deletionThrows) throw deletionThrows;
      events.push(`transaction-committed:${input.mediaType}`);
      return {
        mediaType: input.mediaType,
        mediaId,
        cleanupJobId:
          input.mediaType === 'photo' ? cleanupJobId : null,
      };
    },
  };
  const mediaCleanupJobs = {
    async processJobById(jobId) {
      assert.equal(jobId, cleanupJobId);
      events.push('cloudinary-cleanup');
      if (cleanupThrows) throw new Error('raw processor failure');
      return cleanupResult;
    },
  };
  return createMediaHandlers({
    mediaDeletion,
    mediaCleanupJobs,
  });
}

describe('photo deletion controller post-commit behavior', () => {
  test('confirmed cleanup returns 200 after the transaction commits', async () => {
    const events = [];
    const handlers = makeHandlers({ events });
    const { nextError, res } = await invoke(
      handlers.deletePhoto,
      request('photo'),
    );

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      success: true,
      cleanupPending: false,
      message: 'Photo deleted successfully.',
    });
    assert.deepEqual(events, [
      'transaction-committed:photo',
      'cloudinary-cleanup',
    ]);
  });

  test('temporary cleanup failure returns successful 202 pending', async () => {
    const handlers = makeHandlers({
      cleanupResult: {
        completed: false,
        status: 'pending',
      },
    });
    const { res } = await invoke(handlers.deletePhoto, request('photo'));

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, {
      success: true,
      cleanupPending: true,
      code: PHOTO_CLEANUP_PENDING,
      message: 'Photo deleted from CampPics. Storage cleanup is pending.',
    });
  });

  test('unexpected processor failure logs only fixed IDs and returns 202', async () => {
    const logs = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logs.push(args);
    try {
      const handlers = makeHandlers({ cleanupThrows: true });
      const { res } = await invoke(
        handlers.deletePhoto,
        request('photo'),
      );
      assert.equal(res.statusCode, 202);
      assert.equal(res.body.code, PHOTO_CLEANUP_PENDING);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(logs.length, 1);
    assert.equal(
      logs[0][0],
      'Post-commit photo cleanup processor failed',
    );
    assert.deepEqual(Object.keys(logs[0][1]).sort(), [
      'jobId',
      'mediaId',
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /raw processor/u);
  });

  test('response failure after commit is delegated and never invokes deletion again', async () => {
    const events = [];
    const handlers = makeHandlers({ events });
    const { nextError } = await invoke(
      handlers.deletePhoto,
      request('photo'),
      { throwOnJson: true },
    );

    assert.equal(nextError?.message, 'response disconnected');
    assert.deepEqual(events, [
      'transaction-committed:photo',
      'cloudinary-cleanup',
    ]);
  });

  test('transaction-unavailable maps to a safe 503 without cleanup', async () => {
    const events = [];
    const handlers = makeHandlers({
      events,
      deletionThrows: new MediaDeletionError(
        MEDIA_DELETE_TRANSACTION_UNAVAILABLE,
      ),
    });
    const { res } = await invoke(
      handlers.deletePhoto,
      request('photo'),
    );

    assert.equal(res.statusCode, 503);
    assert.equal(
      res.body.code,
      MEDIA_DELETE_TRANSACTION_UNAVAILABLE,
    );
    assert.deepEqual(events, []);
  });
});

test('video deletion returns success after commit and never calls cleanup', async () => {
  const events = [];
  const handlers = makeHandlers({ events });
  const { nextError, res } = await invoke(
    handlers.deleteVideo,
    request('video'),
  );

  assert.equal(nextError, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(events, ['transaction-committed:video']);
});
