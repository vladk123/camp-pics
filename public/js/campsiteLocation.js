(function attachCampsiteLocationHelper(global) {
  function normalizeLocationForComparison(location) {
    if (!location || typeof location !== 'object') return null;

    const { parkSlug, campsiteSlug } = location;
    if (
      typeof parkSlug !== 'string' ||
      parkSlug.trim() === '' ||
      typeof campsiteSlug !== 'string' ||
      campsiteSlug.trim() === ''
    ) {
      return null;
    }

    let campgroundSlug = location.campgroundSlug;
    if (campgroundSlug == null || campgroundSlug === '') {
      campgroundSlug = null;
    } else if (
      typeof campgroundSlug !== 'string' ||
      campgroundSlug.trim() === ''
    ) {
      return null;
    }

    return {
      parkSlug,
      campsiteSlug,
      campgroundSlug,
    };
  }

  function locationKey(location) {
    const normalized = normalizeLocationForComparison(location);
    if (!normalized) return null;

    return JSON.stringify([
      normalized.parkSlug,
      normalized.campgroundSlug,
      normalized.campsiteSlug,
    ]);
  }

  function sameLocation(first, second) {
    const firstKey = locationKey(first);
    const secondKey = locationKey(second);
    return firstKey !== null && secondKey !== null && firstKey === secondKey;
  }

  function requiredSegment(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`${name} is required`);
    }
    return encodeURIComponent(value);
  }

  function normalizedLocation({ parkSlug, campsiteSlug, campgroundSlug }) {
    const normalized = normalizeLocationForComparison({
      parkSlug,
      campsiteSlug,
      campgroundSlug,
    });
    if (!normalized) {
      throw new TypeError('Complete campsite location is required');
    }

    return {
      parkSlug: requiredSegment(normalized.parkSlug, 'parkSlug'),
      campsiteSlug: requiredSegment(normalized.campsiteSlug, 'campsiteSlug'),
      campgroundSlug:
        normalized.campgroundSlug == null
          ? null
          : requiredSegment(normalized.campgroundSlug, 'campgroundSlug'),
    };
  }

  function targetBase(location) {
    const normalized = normalizedLocation(location);
    const parkBase = `/camp/park/${normalized.parkSlug}`;

    if (normalized.campgroundSlug) {
      return `${parkBase}/campground/${normalized.campgroundSlug}/campsite/${normalized.campsiteSlug}`;
    }
    return `${parkBase}/campsite/${normalized.campsiteSlug}`;
  }

  function apiUrl(location) {
    return targetBase(location);
  }

  function photoUploadUrl(location) {
    return `${targetBase(location)}/photo`;
  }

  function videoUploadUrl(location) {
    return `${targetBase(location)}/video`;
  }

  function photoDeleteUrl(location, photoId) {
    return `${targetBase(location)}/photo/${requiredSegment(photoId, 'photoId')}`;
  }

  function videoDeleteUrl(location, videoId) {
    return `${targetBase(location)}/video/${requiredSegment(videoId, 'videoId')}`;
  }

  function clearCanonicalLocation(element) {
    element.dataset.campsiteSlug = '';
    element.dataset.campgroundSlug = '';
    element.dataset.locationKind = '';
  }

  function canonicalLocationFromResponse(response, parkSlug) {
    const campsiteSlug = response?.slug;
    const locationKind = response?.locationKind;

    if (
      typeof campsiteSlug !== 'string' ||
      !['standalone-campsite', 'campground-campsite'].includes(locationKind)
    ) {
      throw new TypeError('Invalid canonical campsite location');
    }

    const campgroundSlug =
      locationKind === 'campground-campsite'
        ? response.campgroundSlug
        : null;

    if (
      locationKind === 'campground-campsite' &&
      (typeof campgroundSlug !== 'string' || campgroundSlug.trim() === '')
    ) {
      throw new TypeError('Invalid canonical campground location');
    }

    const normalized = normalizeLocationForComparison({
      parkSlug,
      campsiteSlug,
      campgroundSlug,
    });
    if (!normalized) {
      throw new TypeError('Invalid canonical campsite location');
    }

    return {
      ...normalized,
      locationKind,
    };
  }

  function applyCanonicalLocation(element, response) {
    const canonical = canonicalLocationFromResponse(
      response,
      element.dataset.parkSlug,
    );

    element.dataset.campsiteSlug = canonical.campsiteSlug;
    element.dataset.campgroundSlug = canonical.campgroundSlug || '';
    element.dataset.locationKind = canonical.locationKind;
    return canonical;
  }

  function readCanonicalLocation(element, parkSlug) {
    const locationKind = element.dataset.locationKind;
    if (
      !['standalone-campsite', 'campground-campsite'].includes(locationKind)
    ) {
      throw new TypeError('Invalid canonical campsite location');
    }

    const campgroundSlug =
      locationKind === 'campground-campsite'
        ? element.dataset.campgroundSlug
        : null;

    if (
      locationKind === 'standalone-campsite' &&
      element.dataset.campgroundSlug
    ) {
      throw new TypeError('Invalid canonical campsite location');
    }

    const normalized = normalizeLocationForComparison({
      parkSlug,
      campsiteSlug: element.dataset.campsiteSlug,
      campgroundSlug,
    });
    if (!normalized) {
      throw new TypeError('Invalid canonical campsite location');
    }
    return normalized;
  }

  function escapeSelectorValue(value) {
    if (global.CSS && typeof global.CSS.escape === 'function') {
      return global.CSS.escape(String(value));
    }
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\0/g, '\uFFFD');
  }

  function updateBadge(location, count, root = global.document) {
    const campsiteSelector =
      `.campsite[data-cs-slug="${escapeSelectorValue(location.campsiteSlug)}"]`;
    let campsiteElement = null;

    if (location.campgroundSlug) {
      const campgroundSelector =
        `.campground[data-cg-slug="${escapeSelectorValue(location.campgroundSlug)}"]`;
      const campgroundElement = root.querySelector(campgroundSelector);
      campsiteElement = campgroundElement?.querySelector(campsiteSelector) || null;
    } else {
      const standaloneList = root.querySelector('.standalone-campsites');
      campsiteElement = standaloneList?.querySelector(campsiteSelector) || null;
    }

    if (!campsiteElement) return false;

    let badge = campsiteElement.querySelector('.media-badge');
    if (count > 0) {
      if (!badge) {
        badge = root.createElement('span');
        badge.className = 'media-badge';
        campsiteElement.appendChild(badge);
      }
      badge.textContent = String(count);
      campsiteElement.classList.add('has-media');
      campsiteElement.classList.remove('no-media');
    } else {
      badge?.remove();
      campsiteElement.classList.add('no-media');
      campsiteElement.classList.remove('has-media');
    }

    return true;
  }

  global.CampPicsCampsiteLocation = Object.freeze({
    normalizeLocationForComparison,
    locationKey,
    sameLocation,
    apiUrl,
    photoUploadUrl,
    videoUploadUrl,
    photoDeleteUrl,
    videoDeleteUrl,
    clearCanonicalLocation,
    canonicalLocationFromResponse,
    applyCanonicalLocation,
    readCanonicalLocation,
    updateBadge,
  });
})(window);
