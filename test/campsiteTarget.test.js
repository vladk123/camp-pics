import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CampsiteTargetError,
  resolveCampsiteTarget,
} from '../utils/campsiteTarget.js';

function campsite(slug, siteNumber = slug) {
  return { _id: `${slug}-${siteNumber}`, slug, siteNumber, photos: [], videos: [] };
}

function campground(slug, campsites) {
  return { _id: `cg-${slug}`, slug, name: slug.toUpperCase(), campsites };
}

function assertTargetError(fn, code, status) {
  assert.throws(fn, error => {
    assert.ok(error instanceof CampsiteTargetError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

describe('resolveCampsiteTarget', () => {
  test('standalone campsite resolves only from park.campsites', () => {
    const standalone = campsite('12', 'standalone');
    const nested = campsite('12', 'nested');
    const park = {
      campsites: [standalone],
      campgrounds: [campground('north', [nested])],
    };

    const result = resolveCampsiteTarget(park, { campsiteSlug: '12' });

    assert.equal(result.kind, 'standalone-campsite');
    assert.equal(result.target, standalone);
    assert.equal(result.campground, null);
    assert.equal(result.campgroundSlug, null);
  });

  test('campground campsite resolves only within the supplied campground', () => {
    const north = campsite('12', 'north');
    const south = campsite('12', 'south');
    const park = {
      campsites: [],
      campgrounds: [
        campground('north', [north]),
        campground('south', [south]),
      ],
    };

    assert.equal(
      resolveCampsiteTarget(park, {
        campgroundSlug: 'north',
        campsiteSlug: '12',
      }).target,
      north,
    );
    assert.equal(
      resolveCampsiteTarget(park, {
        campgroundSlug: 'south',
        campsiteSlug: '12',
      }).target,
      south,
    );
  });

  test('a campground campsite does not shadow a standalone campsite with the same slug', () => {
    const standalone = campsite('12', 'standalone');
    const nested = campsite('12', 'nested');
    const park = {
      campsites: [standalone],
      campgrounds: [campground('north', [nested])],
    };

    assert.equal(
      resolveCampsiteTarget(park, { campsiteSlug: '12' }).target,
      standalone,
    );
    assert.equal(
      resolveCampsiteTarget(park, {
        campgroundSlug: 'north',
        campsiteSlug: '12',
      }).target,
      nested,
    );
  });

  test('standalone resolution never falls back to a campground', () => {
    const park = {
      campsites: [],
      campgrounds: [campground('north', [campsite('12')])],
    };

    assertTargetError(
      () => resolveCampsiteTarget(park, { campsiteSlug: '12' }),
      'CAMPSITE_NOT_FOUND',
      404,
    );
  });

  test('campground resolution never falls back to standalone or another campground', () => {
    const park = {
      campsites: [campsite('12', 'standalone')],
      campgrounds: [
        campground('north', []),
        campground('south', [campsite('12', 'south')]),
      ],
    };

    assertTargetError(
      () => resolveCampsiteTarget(park, {
        campgroundSlug: 'north',
        campsiteSlug: '12',
      }),
      'CAMPSITE_NOT_FOUND',
      404,
    );
  });

  test('missing campground and missing campsite are distinct not-found results', () => {
    const park = {
      campsites: [campsite('1')],
      campgrounds: [campground('north', [campsite('2')])],
    };

    assertTargetError(
      () => resolveCampsiteTarget(park, {
        campgroundSlug: 'missing',
        campsiteSlug: '2',
      }),
      'CAMPGROUND_NOT_FOUND',
      404,
    );
    assertTargetError(
      () => resolveCampsiteTarget(park, {
        campgroundSlug: 'north',
        campsiteSlug: 'missing',
      }),
      'CAMPSITE_NOT_FOUND',
      404,
    );
  });

  test('duplicate campground slugs are ambiguous', () => {
    const park = {
      campgrounds: [
        campground('duplicate', [campsite('1')]),
        campground('duplicate', [campsite('1')]),
      ],
    };

    assertTargetError(
      () => resolveCampsiteTarget(park, {
        campgroundSlug: 'duplicate',
        campsiteSlug: '1',
      }),
      'DUPLICATE_CAMPGROUND_SLUG',
      409,
    );
  });

  test('duplicate campsite slugs within either requested scope are ambiguous', () => {
    const park = {
      campsites: [campsite('12', 'first'), campsite('12', 'second')],
      campgrounds: [
        campground('north', [
          campsite('13', 'first'),
          campsite('13', 'second'),
        ]),
      ],
    };

    assertTargetError(
      () => resolveCampsiteTarget(park, { campsiteSlug: '12' }),
      'DUPLICATE_CAMPSITE_SLUG',
      409,
    );
    assertTargetError(
      () => resolveCampsiteTarget(park, {
        campgroundSlug: 'north',
        campsiteSlug: '13',
      }),
      'DUPLICATE_CAMPSITE_SLUG',
      409,
    );
  });

  test('plain arrays, hydrated-like subdocuments, and array-like collections work', () => {
    class HydratedLike {
      constructor(data) {
        Object.assign(this, data);
      }
    }

    const standalone = new HydratedLike(campsite('7'));
    const campsites = { 0: standalone, length: 1 };
    const park = new HydratedLike({ campsites, campgrounds: [] });

    assert.equal(
      resolveCampsiteTarget(park, { campsiteSlug: '7' }).target,
      standalone,
    );
  });

  test('malformed and contradictory location input is rejected', () => {
    const park = { campsites: [], campgrounds: [] };
    const cases = [
      null,
      {},
      { campsiteSlug: 12 },
      { campsiteSlug: '   ' },
      { campgroundSlug: 'north' },
      { campgroundSlug: '', campsiteSlug: '12' },
    ];

    for (const location of cases) {
      assert.throws(
        () => resolveCampsiteTarget(park, location),
        error =>
          error instanceof CampsiteTargetError &&
          error.status === 400,
      );
    }

    assertTargetError(
      () => resolveCampsiteTarget(park, { campgroundSlug: 'north' }),
      'CONTRADICTORY_LOCATION',
      400,
    );
  });
});
