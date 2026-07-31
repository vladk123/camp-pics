import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createParkMediaHandler,
  PARK_MEDIA_PROJECTION,
} from '../controllers/camp.js';
import { PUBLIC_MEDIA_KEYS } from '../utils/publicMediaSerializer.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function parkModelReturning(park) {
  const calls = [];
  return {
    calls,
    model: {
      findOne(query, projection) {
        calls.push({ query, projection });
        return { lean: async () => park };
      },
    },
  };
}

function media(type, user) {
  return {
    _id: `${type}-id`,
    user,
    url: `https://example.test/${type}`,
    caption: `${type} caption`,
    username: 'Camper',
    dateTaken: '2026-01-02T00:00:00.000Z',
    uploadedAt: '2026-01-03T00:00:00.000Z',
    likedBy: ['private-user-id'],
    approved: false,
    cloudinaryPublicId: 'private-cloudinary-id',
    futureField: 'future-value',
  };
}

async function invoke(handler, user = null) {
  const res = responseRecorder();
  await handler(
    { params: { parkSlug: 'test-park' }, user },
    res,
    error => {
      throw error;
    },
  );
  return res;
}

describe('park media API', () => {
  test('requests only media inputs and returns only allowlisted media arrays', async () => {
    const ownerId = 'owner-id';
    const { model, calls } = parkModelReturning({
      _id: 'park-id',
      name: 'Private Park Name',
      reviews: [{ text: 'private review' }],
      campgrounds: [{ campsites: [{ secret: true }] }],
      campsites: [{ secret: true }],
      createdAt: 'private timestamp',
      __v: 17,
      photos: [media('photo', ownerId)],
      videos: [media('video', 'another-user')],
    });
    const handler = createParkMediaHandler({ ParkModel: model });
    const res = await invoke(handler, { _id: ownerId, isAdmin: false });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body), ['photos', 'videos']);
    assert.deepEqual(Object.keys(res.body.photos[0]), [...PUBLIC_MEDIA_KEYS]);
    assert.deepEqual(Object.keys(res.body.videos[0]), [...PUBLIC_MEDIA_KEYS]);
    assert.equal(res.body.photos[0].canDelete, true);
    assert.equal(res.body.photos[0].isAdminDelete, false);
    assert.equal('user' in res.body.photos[0], false);
    assert.equal('name' in res.body, false);
    assert.equal('campgrounds' in res.body, false);
    assert.deepEqual(calls, [{
      query: { slug: 'test-park' },
      projection: PARK_MEDIA_PROJECTION,
    }]);
    assert.deepEqual(Object.keys(PARK_MEDIA_PROJECTION).sort(), [
      '_id',
      'photos._id',
      'photos.caption',
      'photos.dateTaken',
      'photos.uploadedAt',
      'photos.url',
      'photos.user',
      'photos.username',
      'videos._id',
      'videos.caption',
      'videos.dateTaken',
      'videos.uploadedAt',
      'videos.url',
      'videos.user',
      'videos.username',
    ]);
  });

  test('missing parks retain the safe 404 response', async () => {
    const { model } = parkModelReturning(null);
    const res = await invoke(createParkMediaHandler({ ParkModel: model }));

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
  });
});
