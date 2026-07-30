import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCampsiteApiHandlers } from '../controllers/camp.js';

const REQUIRED_MEDIA_FIELDS = [
  '_id',
  'user',
  'url',
  'caption',
  'username',
  'dateTaken',
  'uploadedAt',
];

function mediaItem(type) {
  return {
    _id: `${type}-id`,
    user: 'user-id',
    url: `https://example.test/${type}`,
    caption: `${type} caption`,
    username: 'camper',
    dateTaken: '2026-01-02T00:00:00.000Z',
    uploadedAt: '2026-01-03T00:00:00.000Z',
    likedBy: ['internal-user'],
    approved: false,
    socialMediaApproved: true,
    moderationFlag: 'internal',
  };
}

function campsite(slug = '12') {
  return {
    _id: `site-${slug}`,
    siteNumber: slug,
    slug,
    type: 'frontcountry',
    photos: [mediaItem('photo')],
    videos: [mediaItem('video')],
    reviews: [{ text: 'internal review' }],
    toObject() {
      throw new Error('lean campsite must not call toObject');
    },
  };
}

function modelReturning(value) {
  const park = {
    _id: 'park-id',
    ...value,
  };

  return {
    findOne() {
      return {
        lean: async () => park,
      };
    },
    async aggregate(pipeline) {
      const pipelineText = JSON.stringify(pipeline);
      const matches = [];

      for (const selected of park.campsites) {
        if (pipelineText.includes(`"${selected._id}"`)) {
          matches.push({
            kind: 'standalone-campsite',
            campground: null,
            campsite: selected,
          });
        }
      }

      for (const campground of park.campgrounds) {
        for (const selected of campground.campsites) {
          if (pipelineText.includes(`"${selected._id}"`)) {
            matches.push({
              kind: 'campground-campsite',
              campground,
              campsite: selected,
            });
          }
        }
      }

      return [{
        matchCount: matches.length,
        location: matches.length === 1 ? matches[0] : null,
      }];
    },
  };
}

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

async function callHandler(handler, params) {
  const res = responseRecorder();
  let nextError;
  await handler(
    { params },
    res,
    error => {
      nextError = error;
    },
  );
  assert.equal(nextError, undefined);
  return res;
}

describe('campsite API controllers and serializer', () => {
  test('a standalone lean object returns without calling toObject', async () => {
    const standalone = campsite();
    const handlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({
        campsites: [standalone],
        campgrounds: [],
      }),
    });

    const res = await callHandler(handlers.getCampsite, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.slug, '12');
    assert.equal(res.body.locationKind, 'standalone-campsite');
    assert.equal(res.body.campgroundSlug, null);
    assert.equal(res.body.campgroundName, null);
  });

  test('standalone and campground APIs use the same flat field shape', async () => {
    const standaloneHandlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({
        campsites: [campsite()],
        campgrounds: [],
      }),
    });
    const campgroundHandlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({
        campsites: [],
        campgrounds: [{
          _id: 'cg-id',
          slug: 'north',
          name: 'North Campground',
          campsites: [campsite()],
        }],
      }),
    });

    const standalone = await callHandler(standaloneHandlers.getCampsite, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });
    const nested = await callHandler(
      campgroundHandlers.getCampgroundCampsite,
      {
        parkSlug: 'park',
        campgroundSlug: 'north',
        campsiteSlug: '12',
      },
    );

    assert.deepEqual(Object.keys(standalone.body), Object.keys(nested.body));
    assert.equal(nested.body.campgroundSlug, 'north');
    assert.equal(nested.body.campgroundName, 'North Campground');
    assert.equal(nested.body.locationKind, 'campground-campsite');
  });

  test('media retains browser fields and excludes internal fields', async () => {
    const handlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({
        campsites: [campsite()],
        campgrounds: [],
      }),
    });

    const res = await callHandler(handlers.getCampsite, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.deepEqual(Object.keys(res.body.photos[0]), REQUIRED_MEDIA_FIELDS);
    assert.deepEqual(Object.keys(res.body.videos[0]), REQUIRED_MEDIA_FIELDS);
    assert.equal(res.body.photos[0].uploadedAt, '2026-01-03T00:00:00.000Z');
    assert.equal('likedBy' in res.body.photos[0], false);
    assert.equal('approved' in res.body.photos[0], false);
    assert.equal('reviews' in res.body, false);
    assert.equal('toObject' in res.body, false);
  });

  test('missing and ambiguous targets return safe 404 and 409 responses', async () => {
    const missingHandlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({ campsites: [], campgrounds: [] }),
    });
    const ambiguousHandlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({
        campsites: [campsite(), campsite()],
        campgrounds: [],
      }),
    });

    const missing = await callHandler(missingHandlers.getCampsite, {
      parkSlug: 'park',
      campsiteSlug: 'missing',
    });
    const ambiguous = await callHandler(ambiguousHandlers.getCampsite, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.code, 'CAMPSITE_NOT_FOUND');
    assert.equal(ambiguous.statusCode, 409);
    assert.equal(ambiguous.body.code, 'DUPLICATE_CAMPSITE_SLUG');
    assert.equal('stack' in missing.body, false);
    assert.equal('stack' in ambiguous.body, false);
  });

  test('duplicate exact embedded-ID locations return a safe 409 response', async () => {
    const standalone = campsite();
    const duplicateNested = {
      ...campsite('different-current-slug'),
      _id: standalone._id,
    };
    const handlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({
        campsites: [standalone],
        campgrounds: [{
          _id: 'cg-id',
          slug: 'north',
          name: 'North Campground',
          campsites: [duplicateNested],
        }],
      }),
    });

    const res = await callHandler(handlers.getCampsite, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'DUPLICATE_EXACT_CAMPSITE_ID');
    assert.equal(res.body.error, 'Campsite location is ambiguous.');
    assert.equal('stack' in res.body, false);
  });

  test('malformed or contradictory target input returns 400', async () => {
    const handlers = createCampsiteApiHandlers({
      ParkModel: modelReturning({ campsites: [], campgrounds: [] }),
    });

    const malformed = await callHandler(handlers.getCampsite, {
      parkSlug: 'park',
    });
    const contradictory = await callHandler(
      handlers.getCampgroundCampsite,
      {
        parkSlug: 'park',
        campgroundSlug: 'north',
      },
    );

    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.code, 'MALFORMED_LOCATION');
    assert.equal(contradictory.statusCode, 400);
    assert.equal(contradictory.body.code, 'CONTRADICTORY_LOCATION');
  });
});
