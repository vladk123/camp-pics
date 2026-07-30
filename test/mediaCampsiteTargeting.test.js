import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import { createMediaHandlers } from '../controllers/media.js';
import { Park } from '../models/park.js';

const USER_ID = new mongoose.Types.ObjectId();
const DATE_TAKEN = '2026-01-01';

function campsiteData(siteNumber) {
  return {
    siteNumber,
    slug: '12',
    photos: [],
    videos: [],
  };
}

function makePark() {
  return new Park({
    name: 'Target Park',
    slug: 'target-park',
    province: 'Ontario',
    campsites: [campsiteData('Standalone 12')],
    campgrounds: [
      {
        name: 'Campground A',
        slug: 'camp-a',
        campsites: [campsiteData('A-12')],
      },
      {
        name: 'Campground B',
        slug: 'camp-b',
        campsites: [campsiteData('B-12')],
      },
    ],
    photos: [],
    videos: [],
  });
}

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

function controllerHarness(park) {
  const calls = {
    parkUpdates: [],
    uploadCreates: [],
    uploadDeletes: [],
    userPushes: [],
    userUpdates: [],
    cloudinaryUploads: 0,
    cloudinaryDeletes: 0,
    parkSaves: 0,
  };

  park.save = async () => {
    calls.parkSaves += 1;
    return park;
  };

  const handlers = createMediaHandlers({
    ParkModel: {
      findOne: async () => park,
      findByIdAndUpdate: async (...args) => {
        calls.parkUpdates.push(args);
      },
    },
    UploadModel: {
      create: async data => {
        calls.uploadCreates.push(data);
        return { _id: new mongoose.Types.ObjectId() };
      },
      deleteOne: async data => {
        calls.uploadDeletes.push(data);
      },
      deleteMany: async () => {},
    },
    UserModel: {
      findByIdAndUpdate: async (...args) => {
        calls.userPushes.push(args);
      },
      updateOne: async (...args) => {
        calls.userUpdates.push(args);
      },
    },
    cloudinaryClient: {
      uploader: {
        upload_stream() {
          calls.cloudinaryUploads += 1;
          throw new Error('Cloudinary must be stubbed by the specific test');
        },
        async destroy() {
          calls.cloudinaryDeletes += 1;
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

  return { calls, handlers };
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

function videoRequest(params, url = 'https://youtu.be/AAAAAAAAAAA') {
  return {
    params: {
      parkSlug: 'target-park',
      ...params,
    },
    body: {
      url,
      caption: 'Quiet site',
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

describe('media controller campsite targeting', () => {
  test('uploading to campground A/site 12 does not modify campground B/site 12', async () => {
    const park = makePark();
    const { handlers } = controllerHarness(park);

    const res = await invoke(
      handlers.addVideo,
      videoRequest({ campgroundSlug: 'camp-a', campsiteSlug: '12' }),
    );

    assert.equal(res.statusCode, 200);
    assert.equal(park.campgrounds[0].campsites[0].videos.length, 1);
    assert.equal(park.campgrounds[1].campsites[0].videos.length, 0);
    assert.equal(park.campsites[0].videos.length, 0);
  });

  test('uploading to standalone site 12 does not modify either campground site 12', async () => {
    const park = makePark();
    const { handlers } = controllerHarness(park);

    const res = await invoke(
      handlers.addVideo,
      videoRequest({ campsiteSlug: '12' }),
    );

    assert.equal(res.statusCode, 200);
    assert.equal(park.campsites[0].videos.length, 1);
    assert.equal(park.campgrounds[0].campsites[0].videos.length, 0);
    assert.equal(park.campgrounds[1].campsites[0].videos.length, 0);
  });

  test('deleting from campground B/site 12 removes only its media', async () => {
    const park = makePark();
    park.campgrounds[0].campsites[0].videos.push({
      user: USER_ID,
      url: 'https://youtu.be/AAAAAAAAAAA',
      dateTaken: DATE_TAKEN,
    });
    park.campgrounds[1].campsites[0].videos.push({
      user: USER_ID,
      url: 'https://youtu.be/BBBBBBBBBBB',
      dateTaken: DATE_TAKEN,
    });
    const videoId = park.campgrounds[1].campsites[0].videos[0]._id.toString();
    const { calls, handlers } = controllerHarness(park);

    const res = await invoke(handlers.deleteVideo, {
      params: {
        parkSlug: 'target-park',
        campgroundSlug: 'camp-b',
        campsiteSlug: '12',
        videoId,
      },
      user: {
        _id: USER_ID,
        isAdmin: false,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(park.campgrounds[0].campsites[0].videos.length, 1);
    assert.equal(park.campgrounds[1].campsites[0].videos.length, 0);
    assert.equal(calls.uploadDeletes.length, 1);
    assert.equal(calls.userUpdates.length, 1);
  });

  test('Upload and User metadata comes from each resolved duplicate-slug location', async () => {
    const park = makePark();
    const { calls, handlers } = controllerHarness(park);

    await invoke(
      handlers.addVideo,
      videoRequest(
        { campgroundSlug: 'camp-a', campsiteSlug: '12' },
        'https://youtu.be/AAAAAAAAAAA',
      ),
    );
    await invoke(
      handlers.addVideo,
      videoRequest(
        { campgroundSlug: 'camp-b', campsiteSlug: '12' },
        'https://youtu.be/BBBBBBBBBBB',
      ),
    );

    assert.equal(calls.uploadCreates.length, 2);
    assert.equal(calls.userPushes.length, 2);

    const uploadA = calls.uploadCreates[0];
    const uploadB = calls.uploadCreates[1];
    assert.equal(uploadA.campgroundName, 'Campground A');
    assert.equal(uploadB.campgroundName, 'Campground B');
    assert.notEqual(
      uploadA.campgroundId.toString(),
      uploadB.campgroundId.toString(),
    );
    assert.notEqual(
      uploadA.campsiteId.toString(),
      uploadB.campsiteId.toString(),
    );

    const userA = calls.userPushes[0][1].$push.uploads;
    const userB = calls.userPushes[1][1].$push.uploads;
    assert.equal(userA.campgroundSlug, 'camp-a');
    assert.equal(userB.campgroundSlug, 'camp-b');
    assert.equal(userA.campsiteSlug, '12');
    assert.equal(userB.campsiteSlug, '12');
    assert.equal(userA.campsiteName, 'A-12');
    assert.equal(userB.campsiteName, 'B-12');
  });

  test('ambiguity blocks photo mutation before Cloudinary or Mongo persistence', async () => {
    const park = makePark();
    park.campgrounds.push({
      name: 'Duplicate A',
      slug: 'camp-a',
      campsites: [campsiteData('Duplicate A-12')],
    });
    const { calls, handlers } = controllerHarness(park);

    const res = await invoke(handlers.uploadPhoto, {
      params: {
        parkSlug: 'target-park',
        campgroundSlug: 'camp-a',
        campsiteSlug: '12',
      },
      body: {
        dateTaken: DATE_TAKEN,
      },
      files: [{ buffer: Buffer.from('not-used') }],
      user: {
        _id: USER_ID,
        fname: 'Camper',
      },
      is: value => value === 'multipart/form-data',
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'DUPLICATE_CAMPGROUND_SLUG');
    assert.equal(calls.cloudinaryUploads, 0);
    assert.equal(calls.uploadCreates.length, 0);
    assert.equal(calls.userPushes.length, 0);
    assert.equal(calls.parkUpdates.length, 0);
    assert.equal(calls.parkSaves, 0);
  });

  test('park-level video upload does not require a campsite slug', async () => {
    const park = makePark();
    const { calls, handlers } = controllerHarness(park);

    const res = await invoke(handlers.addVideo, videoRequest({}));

    assert.equal(res.statusCode, 200);
    assert.equal(park.videos.length, 1);
    assert.equal(calls.uploadCreates[0].campgroundId, null);
    assert.equal(calls.uploadCreates[0].campsiteId, null);
    const userEntry = calls.userPushes[0][1].$push.uploads;
    assert.equal(userEntry.campgroundSlug, null);
    assert.equal(userEntry.campsiteSlug, null);
  });

  test('video input validation rejects only fields required for the requested target', async () => {
    const park = makePark();
    const { calls, handlers } = controllerHarness(park);

    const missingUrl = videoRequest({});
    missingUrl.body = { dateTaken: DATE_TAKEN };
    const missingUrlResponse = await invoke(handlers.addVideo, missingUrl);
    assert.equal(missingUrlResponse.statusCode, 400);
    assert.equal(missingUrlResponse.body.error, 'Missing data.');

    const contradictoryResponse = await invoke(
      handlers.addVideo,
      videoRequest({ campgroundSlug: 'camp-a' }),
    );
    assert.equal(contradictoryResponse.statusCode, 400);
    assert.equal(
      contradictoryResponse.body.code,
      'CONTRADICTORY_LOCATION',
    );
    assert.equal(calls.parkSaves, 0);
    assert.equal(calls.uploadCreates.length, 0);
    assert.equal(calls.userPushes.length, 0);
  });
});
