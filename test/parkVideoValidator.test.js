import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';

import { Park } from '../models/park.js';

const userId = new mongoose.Types.ObjectId();
const dateTaken = new Date('2025-01-01T00:00:00.000Z');
const legacyInvalidUrl =
  'https://evil.youtube.com/watch?v=dQw4w9WgXcQ';
const replacementInvalidUrl =
  'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ';
const validUrl = 'https://m.youtube.com/watch?v=dQw4w9WgXcQ';
const validSiblingUrl = 'https://youtu.be/abcdefghijk';

function videoData(url) {
  return {
    user: userId,
    url,
    dateTaken,
  };
}

function parkData(videoUrl) {
  return {
    name: 'Validator Test Park',
    slug: 'validator-test-park',
    province: 'Ontario',
    videos: [videoData(videoUrl)],
  };
}

const legacyCases = [
  {
    name: 'park videos',
    data: () => parkData(legacyInvalidUrl),
    videos: park => park.videos,
    changeUnrelatedParent: park => {
      park.description = 'An unrelated park update';
    },
    errorPath: 'videos.0.url',
  },
  {
    name: 'standalone campsite videos',
    data: () => ({
      ...parkData(undefined),
      videos: [],
      campsites: [{
        siteNumber: '1',
        slug: '1',
        videos: [videoData(legacyInvalidUrl)],
      }],
    }),
    videos: park => park.campsites[0].videos,
    changeUnrelatedParent: park => {
      park.campsites[0].siteNumber = '1A';
    },
    errorPath: 'campsites.0.videos.0.url',
  },
  {
    name: 'campground campsite videos',
    data: () => ({
      ...parkData(undefined),
      videos: [],
      campgrounds: [{
        name: 'Test Campground',
        slug: 'test-campground',
        campsites: [{
          siteNumber: '2',
          slug: '2',
          videos: [videoData(legacyInvalidUrl)],
        }],
      }],
    }),
    videos: park => park.campgrounds[0].campsites[0].videos,
    changeUnrelatedParent: park => {
      park.campgrounds[0].name = 'Updated Test Campground';
    },
    errorPath: 'campgrounds.0.campsites.0.videos.0.url',
  },
];

test('Park validates new YouTube URLs with the shared parser', () => {
  const validPark = new Park(
    parkData('https://m.youtube.com/watch?v=dQw4w9WgXcQ')
  );
  const invalidPark = new Park(
    parkData('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')
  );

  assert.equal(validPark.validateSync(), undefined);
  assert.match(
    invalidPark.validateSync().errors['videos.0.url'].message,
    /Invalid YouTube URL format/
  );
});

for (const scenario of legacyCases) {
  test(`${scenario.name} preserve unchanged invalid historical URLs`, () => {
    const historicalPark = Park.hydrate({
      _id: new mongoose.Types.ObjectId(),
      ...scenario.data(),
    });
    const videos = scenario.videos(historicalPark);

    scenario.changeUnrelatedParent(historicalPark);
    assert.equal(historicalPark.validateSync(), undefined);
    assert.equal(videos[0].url, legacyInvalidUrl);

    videos.push(videoData(validSiblingUrl));
    assert.equal(historicalPark.validateSync(), undefined);
    assert.equal(videos.length, 2);
    assert.equal(videos[0].url, legacyInvalidUrl);
    assert.equal(videos[1].url, validSiblingUrl);

    videos[0].url = replacementInvalidUrl;
    const invalidError = historicalPark.validateSync();
    assert.match(
      invalidError.errors[scenario.errorPath].message,
      /Invalid YouTube URL format/
    );

    videos[0].url = validUrl;
    assert.equal(historicalPark.validateSync(), undefined);
    assert.equal(videos[0].url, validUrl);
    assert.equal(videos[1].url, validSiblingUrl);
  });
}
