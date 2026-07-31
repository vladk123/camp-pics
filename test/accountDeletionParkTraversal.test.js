import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCOUNT_DELETION_USER_REFERENCE_PATHS,
  parkHasUserContentOrLikes,
  removeUserParkContentAndLikes,
} from '../utils/accountDeletionParkTraversal.js';

const DELETING_USER = 'deleting-user';
const OTHER_USER = 'other-user';

function content(user, likedBy = []) {
  return { user, likedBy };
}

function target({ videos = true } = {}) {
  return {
    photos: [
      content(DELETING_USER, [OTHER_USER]),
      content(OTHER_USER, [DELETING_USER, OTHER_USER]),
    ],
    ...(videos
      ? {
        videos: [
          content(DELETING_USER, [OTHER_USER]),
          content(OTHER_USER, [DELETING_USER, OTHER_USER]),
        ],
      }
      : {}),
    reviews: [
      content(DELETING_USER, [OTHER_USER]),
      content(OTHER_USER, [DELETING_USER, OTHER_USER]),
    ],
  };
}

function parkFixture() {
  return {
    ...target(),
    campsites: [target()],
    campgrounds: [{
      ...target({ videos: false }),
      campsites: [target()],
    }],
  };
}

function assertOnlyUnrelatedContentRemains(targetValue, fields) {
  for (const field of fields) {
    assert.equal(targetValue[field].length, 1);
    assert.equal(targetValue[field][0].user, OTHER_USER);
    assert.deepEqual(targetValue[field][0].likedBy, [OTHER_USER]);
  }
}

describe('complete account-deletion Park traversal', () => {
  test('removes owned content and likes at every supported nesting level', () => {
    const park = parkFixture();

    assert.equal(parkHasUserContentOrLikes(park, DELETING_USER), true);
    const result = removeUserParkContentAndLikes(park, DELETING_USER);

    assert.equal(result.changed, true);
    assert.equal(result.photosRemoved, 4);
    assert.equal(result.videosRemoved, 3);
    assert.equal(result.reviewsRemoved, 4);
    assert.equal(result.likesRemoved, 11);
    assertOnlyUnrelatedContentRemains(
      park,
      ['photos', 'videos', 'reviews'],
    );
    assertOnlyUnrelatedContentRemains(
      park.campsites[0],
      ['photos', 'videos', 'reviews'],
    );
    assertOnlyUnrelatedContentRemains(
      park.campgrounds[0],
      ['photos', 'reviews'],
    );
    assertOnlyUnrelatedContentRemains(
      park.campgrounds[0].campsites[0],
      ['photos', 'videos', 'reviews'],
    );
    assert.equal(parkHasUserContentOrLikes(park, DELETING_USER), false);
  });

  test('an unrelated Park remains unchanged', () => {
    const park = {
      photos: [content(OTHER_USER, [OTHER_USER])],
      videos: [],
      reviews: [],
      campsites: [],
      campgrounds: [],
    };
    const before = structuredClone(park);

    const result = removeUserParkContentAndLikes(park, DELETING_USER);

    assert.equal(result.changed, false);
    assert.deepEqual(park, before);
  });

  test('the Park query path inventory includes ownership and likes everywhere', () => {
    const requiredPaths = [
      'photos.user',
      'videos.user',
      'reviews.user',
      'photos.likedBy',
      'videos.likedBy',
      'reviews.likedBy',
      'campgrounds.photos.user',
      'campgrounds.reviews.user',
      'campgrounds.photos.likedBy',
      'campgrounds.reviews.likedBy',
      'campsites.photos.user',
      'campsites.videos.user',
      'campsites.reviews.user',
      'campsites.photos.likedBy',
      'campsites.videos.likedBy',
      'campsites.reviews.likedBy',
      'campgrounds.campsites.photos.user',
      'campgrounds.campsites.videos.user',
      'campgrounds.campsites.reviews.user',
      'campgrounds.campsites.photos.likedBy',
      'campgrounds.campsites.videos.likedBy',
      'campgrounds.campsites.reviews.likedBy',
    ];

    assert.deepEqual(
      [...ACCOUNT_DELETION_USER_REFERENCE_PATHS].sort(),
      requiredPaths.sort(),
    );
  });
});
