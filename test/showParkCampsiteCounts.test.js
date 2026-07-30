import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  prepareCampsiteMediaCounts,
  SHOW_PARK_PROJECTION,
} from '../controllers/camp.js';

const campControllerSource = await readFile(
  new URL('../controllers/camp.js', import.meta.url),
  'utf8',
);

test('showPark projection includes standalone and campground media IDs only for counts', () => {
  const requiredProjectionPaths = [
    'campgrounds.campsites.photos._id',
    'campgrounds.campsites.videos._id',
    'campsites.photos._id',
    'campsites.videos._id',
  ];

  for (const path of requiredProjectionPaths) {
    assert.match(SHOW_PARK_PROJECTION, new RegExp(path.replaceAll('.', '\\.')));
  }

  assert.doesNotMatch(SHOW_PARK_PROJECTION, /campsites\.photos\.url/);
  assert.doesNotMatch(SHOW_PARK_PROJECTION, /campsites\.videos\.url/);
});

test('standalone and campground counts cover photo-only, video-only, mixed, and zero media', () => {
  const park = {
    campgrounds: [{
      name: 'North',
      campsites: [{
        siteNumber: '10',
        photos: [{ _id: 'cg-photo' }],
        videos: [{ _id: 'cg-video' }],
      }],
    }],
    campsites: [
      {
        siteNumber: '10',
        photos: [{ _id: 'mixed-photo' }],
        videos: [{ _id: 'mixed-video' }],
      },
      {
        siteNumber: '2',
        photos: [],
        videos: [{ _id: 'video-only' }],
      },
      {
        siteNumber: '1',
        photos: [{ _id: 'photo-only' }],
        videos: [],
      },
      {
        siteNumber: '20',
        photos: [],
        videos: [],
      },
    ],
  };

  prepareCampsiteMediaCounts(park);

  assert.deepEqual(
    park.campsites.map(site => site.siteNumber),
    ['1', '2', '10', '20'],
  );
  const byNumber = Object.fromEntries(
    park.campsites.map(site => [site.siteNumber, site]),
  );
  assert.deepEqual(
    [byNumber['1'].photoCount, byNumber['1'].videoCount, byNumber['1'].mediaCount],
    [1, 0, 1],
  );
  assert.deepEqual(
    [byNumber['2'].photoCount, byNumber['2'].videoCount, byNumber['2'].mediaCount],
    [0, 1, 1],
  );
  assert.deepEqual(
    [byNumber['10'].photoCount, byNumber['10'].videoCount, byNumber['10'].mediaCount],
    [1, 1, 2],
  );
  assert.deepEqual(
    [byNumber['20'].photoCount, byNumber['20'].videoCount, byNumber['20'].mediaCount],
    [0, 0, 0],
  );
  assert.equal(byNumber['20'].hasMedia, false);
  assert.equal(byNumber['10'].hasMedia, true);
  assert.equal('photos' in byNumber['10'], false);
  assert.equal('videos' in byNumber['10'], false);

  const campgroundSite = park.campgrounds[0].campsites[0];
  assert.equal(campgroundSite.photoCount, 1);
  assert.equal(campgroundSite.videoCount, 1);
  assert.equal(campgroundSite.mediaCount, 2);
});

test('standalone sorting is performed once before its counting loop', () => {
  const helperMatch = campControllerSource.match(
    /function addCampsiteMediaCounts\(campsites\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(helperMatch);
  const helperBody = helperMatch[1];
  assert.ok(helperBody.indexOf('campsites.sort(') < helperBody.indexOf('for (const campsite of campsites)'));
  const loopBody = helperBody.slice(helperBody.indexOf('for (const campsite of campsites)'));
  assert.doesNotMatch(loopBody, /campsites\.sort\(/);
});
