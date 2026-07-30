const ERROR_DEFINITIONS = {
  MALFORMED_LOCATION: {
    status: 400,
    message: 'Invalid campsite location.',
  },
  CONTRADICTORY_LOCATION: {
    status: 400,
    message: 'Invalid campsite location.',
  },
  CAMPGROUND_NOT_FOUND: {
    status: 404,
    message: 'Campground not found.',
  },
  CAMPSITE_NOT_FOUND: {
    status: 404,
    message: 'Campsite not found.',
  },
  EXACT_TARGET_NOT_FOUND: {
    status: 404,
    message: 'Campsite not found.',
  },
  DUPLICATE_CAMPGROUND_SLUG: {
    status: 409,
    message: 'Campground location is ambiguous.',
  },
  DUPLICATE_CAMPSITE_SLUG: {
    status: 409,
    message: 'Campsite location is ambiguous.',
  },
  DUPLICATE_EXACT_CAMPSITE_ID: {
    status: 409,
    message: 'Campsite location is ambiguous.',
  },
};

export class CampsiteTargetError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.MALFORMED_LOCATION;
    super(definition.message);
    this.name = 'CampsiteTargetError';
    this.code = code;
    this.status = definition.status;
    this.publicMessage = definition.message;
  }
}

function collectionItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
  if (Number.isInteger(value.length) && value.length >= 0) return Array.from(value);
  return [];
}

function normalizeRequiredSlug(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CampsiteTargetError('MALFORMED_LOCATION');
  }
  return value;
}

export function resolveCampsiteTarget(park, location) {
  if (!park || typeof park !== 'object' || !location || typeof location !== 'object' || Array.isArray(location)) {
    throw new CampsiteTargetError('MALFORMED_LOCATION');
  }

  const campsiteSlugMissing =
    location.campsiteSlug === undefined ||
    location.campsiteSlug === null ||
    location.campsiteSlug === '';
  const campgroundSlugSupplied =
    location.campgroundSlug !== undefined &&
    location.campgroundSlug !== null;

  if (campgroundSlugSupplied && campsiteSlugMissing) {
    throw new CampsiteTargetError('CONTRADICTORY_LOCATION');
  }

  const campsiteSlug = normalizeRequiredSlug(location.campsiteSlug);

  if (campgroundSlugSupplied) {
    const campgroundSlug = normalizeRequiredSlug(location.campgroundSlug);
    const matchingCampgrounds = collectionItems(park.campgrounds)
      .filter(campground => campground?.slug === campgroundSlug);

    if (matchingCampgrounds.length === 0) {
      throw new CampsiteTargetError('CAMPGROUND_NOT_FOUND');
    }
    if (matchingCampgrounds.length > 1) {
      throw new CampsiteTargetError('DUPLICATE_CAMPGROUND_SLUG');
    }

    const campground = matchingCampgrounds[0];
    const matchingCampsites = collectionItems(campground.campsites)
      .filter(campsite => campsite?.slug === campsiteSlug);

    if (matchingCampsites.length === 0) {
      throw new CampsiteTargetError('CAMPSITE_NOT_FOUND');
    }
    if (matchingCampsites.length > 1) {
      throw new CampsiteTargetError('DUPLICATE_CAMPSITE_SLUG');
    }

    const campsite = matchingCampsites[0];
    return {
      kind: 'campground-campsite',
      target: campsite,
      campsite,
      campground,
      campsiteSlug,
      campgroundSlug,
    };
  }

  const matchingCampsites = collectionItems(park.campsites)
    .filter(campsite => campsite?.slug === campsiteSlug);

  if (matchingCampsites.length === 0) {
    throw new CampsiteTargetError('CAMPSITE_NOT_FOUND');
  }
  if (matchingCampsites.length > 1) {
    throw new CampsiteTargetError('DUPLICATE_CAMPSITE_SLUG');
  }

  const campsite = matchingCampsites[0];
  return {
    kind: 'standalone-campsite',
    target: campsite,
    campsite,
    campground: null,
    campsiteSlug,
    campgroundSlug: null,
  };
}

export function sendCampsiteTargetError(res, error) {
  if (!(error instanceof CampsiteTargetError)) return false;

  res.status(error.status).json({
    error: error.publicMessage,
    code: error.code,
  });
  return true;
}
