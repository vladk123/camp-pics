import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildExactCampsitePipeline,
  CAMPSITE_LOCATION_PROJECTION,
  loadCampsiteForClient,
} from '../controllers/camp.js';
import { CampsiteTargetError } from '../utils/campsiteTarget.js';

function locationCampsite(_id, slug) {
  return { _id, slug };
}

function exactCampsite(_id, slug, marker = slug) {
  return {
    _id,
    siteNumber: marker,
    slug,
    type: 'frontcountry',
    photos: [{
      _id: `${marker}-photo`,
      user: 'user',
      url: `https://example.test/${marker}.jpg`,
      caption: marker,
      username: 'camper',
      dateTaken: '2026-01-01',
      uploadedAt: '2026-01-02',
    }],
    videos: [],
  };
}

function exactRow(kind, campsite, campground = null) {
  return {
    matchCount: 1,
    location: {
      kind,
      campground,
      campsite,
    },
  };
}

function loaderModel(locationPark, exactRows) {
  const calls = {
    findQueries: [],
    findProjections: [],
    pipelines: [],
  };

  return {
    calls,
    model: {
      findOne(query, projection) {
        calls.findQueries.push(query);
        calls.findProjections.push(projection);
        return {
          lean: async () => locationPark,
        };
      },
      async aggregate(pipeline) {
        calls.pipelines.push(pipeline);
        return typeof exactRows === 'function'
          ? exactRows(pipeline)
          : exactRows;
      },
    },
  };
}

describe('two-phase campsite API loader', () => {
  test('Phase A projection contains only lightweight location fields', () => {
    assert.deepEqual(
      Object.keys(CAMPSITE_LOCATION_PROJECTION).sort(),
      [
        '_id',
        'campgrounds._id',
        'campgrounds.campsites._id',
        'campgrounds.campsites.slug',
        'campgrounds.name',
        'campgrounds.slug',
        'campsites._id',
        'campsites.slug',
      ].sort(),
    );

    const projectionText = JSON.stringify(CAMPSITE_LOCATION_PROJECTION);
    assert.doesNotMatch(projectionText, /photos|videos|reviews|approved|likedBy/);
  });

  test('standalone exact read returns only the resolved embedded campsite', async () => {
    const selectedId = 'standalone-selected-id';
    const unrelatedId = 'standalone-unrelated-id';
    const locationPark = {
      _id: 'park-id',
      campsites: [
        locationCampsite(selectedId, '12'),
        locationCampsite(unrelatedId, '99'),
      ],
      campgrounds: [],
    };
    const selected = exactCampsite(selectedId, '12', 'selected');
    const { model, calls } = loaderModel(locationPark, pipeline => {
      const pipelineText = JSON.stringify(pipeline);
      assert.match(pipelineText, new RegExp(selectedId));
      assert.doesNotMatch(pipelineText, new RegExp(unrelatedId));
      return [exactRow('standalone-campsite', selected)];
    });

    const location = await loadCampsiteForClient(model, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.equal(location.kind, 'standalone-campsite');
    assert.equal(location.campsite, selected);
    assert.equal(location.campground, null);
    assert.equal(calls.pipelines.length, 1);
  });

  test('campground exact read returns its current parent and changed slug', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [],
      campgrounds: [
        {
          _id: 'camp-a-id',
          name: 'Camp A Old',
          slug: 'camp-a',
          campsites: [locationCampsite('site-a-id', '12')],
        },
        {
          _id: 'camp-b-id',
          name: 'Camp B',
          slug: 'camp-b',
          campsites: [locationCampsite('site-b-id', '12')],
        },
      ],
    };
    const currentCampground = {
      _id: 'camp-a-id',
      name: 'Camp A Current',
      slug: 'camp-a-current',
    };
    const currentCampsite = exactCampsite(
      'site-a-id',
      '12-current',
      'current-a',
    );
    const { model, calls } = loaderModel(locationPark, pipeline => {
      const pipelineText = JSON.stringify(pipeline);
      assert.match(pipelineText, /site-a-id/);
      assert.doesNotMatch(
        pipelineText,
        /camp-a-id|camp-b-id|site-b-id/,
      );
      assert.doesNotMatch(
        pipelineText,
        /"campgrounds\.slug"|"campgrounds\.campsites\.slug"/,
      );
      return [exactRow(
        'campground-campsite',
        currentCampsite,
        currentCampground,
      )];
    });

    const location = await loadCampsiteForClient(model, {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    });

    assert.equal(location.kind, 'campground-campsite');
    assert.equal(location.campsite, currentCampsite);
    assert.equal(location.campground, currentCampground);
    assert.equal(location.campsiteSlug, '12-current');
    assert.equal(location.campgroundSlug, 'camp-a-current');
    assert.equal(calls.pipelines.length, 1);
  });

  test('campground campsite moved from A to B returns B as canonical parent', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [],
      campgrounds: [
        {
          _id: 'camp-a-id',
          name: 'Camp A',
          slug: 'camp-a',
          campsites: [locationCampsite('moving-site-id', '12')],
        },
        {
          _id: 'camp-b-id',
          name: 'Camp B',
          slug: 'camp-b',
          campsites: [locationCampsite('same-slug-alternative-id', '12')],
        },
      ],
    };
    const currentCampground = {
      _id: 'camp-b-id',
      name: 'Camp B Current',
      slug: 'camp-b-current',
    };
    const movedCampsite = exactCampsite(
      'moving-site-id',
      '12-current',
      'moved-to-b',
    );
    const { model, calls } = loaderModel(locationPark, pipeline => {
      const pipelineText = JSON.stringify(pipeline);
      assert.match(pipelineText, /moving-site-id/);
      assert.doesNotMatch(
        pipelineText,
        /camp-a-id|camp-b-id|same-slug-alternative-id/,
      );
      return [exactRow(
        'campground-campsite',
        movedCampsite,
        currentCampground,
      )];
    });

    const location = await loadCampsiteForClient(model, {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    });

    assert.equal(location.kind, 'campground-campsite');
    assert.equal(location.campsite, movedCampsite);
    assert.equal(location.campsiteSlug, '12-current');
    assert.equal(location.campground, currentCampground);
    assert.equal(location.campgroundSlug, 'camp-b-current');
    assert.equal(calls.pipelines.length, 1);
  });

  test('campground campsite moved to standalone returns standalone location', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [],
      campgrounds: [{
        _id: 'camp-a-id',
        name: 'Camp A',
        slug: 'camp-a',
        campsites: [locationCampsite('moving-site-id', '12')],
      }],
    };
    const movedCampsite = exactCampsite(
      'moving-site-id',
      'standalone-current',
      'moved-standalone',
    );
    const { model } = loaderModel(locationPark, [
      exactRow('standalone-campsite', movedCampsite),
    ]);

    const location = await loadCampsiteForClient(model, {
      parkSlug: 'park',
      campgroundSlug: 'camp-a',
      campsiteSlug: '12',
    });

    assert.equal(location.kind, 'standalone-campsite');
    assert.equal(location.campsite, movedCampsite);
    assert.equal(location.campsiteSlug, 'standalone-current');
    assert.equal(location.campground, null);
    assert.equal(location.campgroundSlug, null);
  });

  test('standalone campsite moved into a campground returns current parent', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [locationCampsite('moving-site-id', '12')],
      campgrounds: [],
    };
    const currentCampground = {
      _id: 'camp-current-id',
      name: 'Current Camp',
      slug: 'current-camp',
    };
    const movedCampsite = exactCampsite(
      'moving-site-id',
      'nested-current',
      'moved-nested',
    );
    const { model } = loaderModel(locationPark, [
      exactRow(
        'campground-campsite',
        movedCampsite,
        currentCampground,
      ),
    ]);

    const location = await loadCampsiteForClient(model, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.equal(location.kind, 'campground-campsite');
    assert.equal(location.campsite, movedCampsite);
    assert.equal(location.campsiteSlug, 'nested-current');
    assert.equal(location.campground, currentCampground);
    assert.equal(location.campgroundSlug, 'current-camp');
  });

  test('unrelated large media arrays are absent from both Phase A and exact output', async () => {
    const largeMediaMarker = 'UNRELATED-LARGE-MEDIA';
    const locationPark = {
      _id: 'park-id',
      campsites: [
        locationCampsite('selected-id', '12'),
        locationCampsite('unrelated-id', '99'),
      ],
      campgrounds: [],
    };
    const selected = exactCampsite('selected-id', '12', 'selected');
    const { model, calls } = loaderModel(locationPark, [
      exactRow('standalone-campsite', selected),
    ]);

    const location = await loadCampsiteForClient(model, {
      parkSlug: 'park',
      campsiteSlug: '12',
    });

    assert.doesNotMatch(
      JSON.stringify(calls.findProjections[0]),
      /photos|videos/,
    );
    assert.doesNotMatch(JSON.stringify(location), new RegExp(largeMediaMarker));
    assert.equal(location.campsite.photos.length, 1);
  });

  test('duplicate ambiguity is detected before an exact media aggregation', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [
        locationCampsite('first-id', '12'),
        locationCampsite('second-id', '12'),
      ],
      campgrounds: [],
    };
    const { model, calls } = loaderModel(locationPark, []);

    await assert.rejects(
      loadCampsiteForClient(model, {
        parkSlug: 'park',
        campsiteSlug: '12',
      }),
      error =>
        error instanceof CampsiteTargetError &&
        error.code === 'DUPLICATE_CAMPSITE_SLUG',
    );
    assert.equal(calls.pipelines.length, 0);
  });

  test('exact media aggregation matches embedded IDs and projects only client fields', () => {
    const pipeline = buildExactCampsitePipeline('park-id', {
      kind: 'campground-campsite',
      campground: { _id: 'camp-id', slug: 'duplicate' },
      campsite: { _id: 'site-id', slug: '12' },
    });
    const pipelineText = JSON.stringify(pipeline);

    assert.match(
      pipelineText,
      /"\$eq":\["\$\$campsite\._id","site-id"\]/,
    );
    assert.match(pipelineText, /"\$campsites"/);
    assert.match(pipelineText, /"\$campgrounds"/);
    assert.match(pipelineText, /"matchCount"/);
    assert.doesNotMatch(pipelineText, /camp-id|duplicate/);
    assert.doesNotMatch(
      pipelineText,
      /"campgrounds\.slug"|"campgrounds\.campsites\.slug"/,
    );
    assert.doesNotMatch(
      pipelineText,
      /likedBy|approved|socialMediaApproved|reviews|moderation/,
    );
  });

  test('disappearance between phases returns 404 without same-slug fallback', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [],
      campgrounds: [
        {
          _id: 'camp-a-id',
          name: 'Camp A',
          slug: 'camp-a',
          campsites: [locationCampsite('site-a-id', '12')],
        },
        {
          _id: 'camp-b-id',
          name: 'Camp B',
          slug: 'camp-b',
          campsites: [locationCampsite('site-b-id', '12')],
        },
      ],
    };
    const { model, calls } = loaderModel(locationPark, [{
      matchCount: 0,
      location: null,
    }]);

    await assert.rejects(
      loadCampsiteForClient(model, {
        parkSlug: 'park',
        campgroundSlug: 'camp-a',
        campsiteSlug: '12',
      }),
      error =>
        error instanceof CampsiteTargetError &&
        error.code === 'EXACT_TARGET_NOT_FOUND' &&
        error.status === 404,
    );

    assert.equal(calls.pipelines.length, 1);
    const pipelineText = JSON.stringify(calls.pipelines[0]);
    assert.match(pipelineText, /site-a-id/);
    assert.doesNotMatch(pipelineText, /camp-a-id|camp-b-id|site-b-id/);
  });

  test('duplicate current locations for one embedded ID return safe 409', async () => {
    const locationPark = {
      _id: 'park-id',
      campsites: [locationCampsite('duplicate-id', '12')],
      campgrounds: [],
    };
    const { model, calls } = loaderModel(locationPark, [{
      matchCount: 2,
      location: null,
    }]);

    await assert.rejects(
      loadCampsiteForClient(model, {
        parkSlug: 'park',
        campsiteSlug: '12',
      }),
      error =>
        error instanceof CampsiteTargetError &&
        error.code === 'DUPLICATE_EXACT_CAMPSITE_ID' &&
        error.status === 409,
    );

    assert.equal(calls.pipelines.length, 1);
    assert.match(JSON.stringify(calls.pipelines[0]), /duplicate-id/);
  });
});
