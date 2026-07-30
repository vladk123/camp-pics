(function attachCampsiteRequestCoordinator(global) {
  function createCoordinator({
    fetchImpl = (...args) => global.fetch(...args),
    locationHelper = global.CampPicsCampsiteLocation,
  } = {}) {
    let latestOpenRequestId = 0;
    let activeOpenController = null;

    function cancelOpen() {
      latestOpenRequestId += 1;
      activeOpenController?.abort();
      activeOpenController = null;
    }

    async function openLatest(location, {
      onSuccess,
      onError,
    } = {}) {
      const normalized =
        locationHelper.normalizeLocationForComparison(location);
      if (!normalized) {
        throw new TypeError('Complete campsite location is required');
      }

      const requestId = ++latestOpenRequestId;
      activeOpenController?.abort();
      const controller =
        typeof global.AbortController === 'function'
          ? new global.AbortController()
          : null;
      activeOpenController = controller;

      try {
        const response = await fetchImpl(
          locationHelper.apiUrl(normalized),
          controller ? { signal: controller.signal } : undefined,
        );
        if (requestId !== latestOpenRequestId) {
          return { status: 'stale' };
        }
        if (!response.ok) {
          throw new Error('Campsite request failed');
        }

        const data = await response.json();
        if (requestId !== latestOpenRequestId) {
          return { status: 'stale' };
        }

        await onSuccess?.(data, normalized);
        return { status: 'displayed', data };
      } catch (error) {
        const stale = requestId !== latestOpenRequestId;
        const aborted =
          error?.name === 'AbortError' ||
          controller?.signal.aborted === true;

        if (stale || aborted) {
          return { status: aborted ? 'aborted' : 'stale' };
        }

        await onError?.(error, normalized);
        return { status: 'error', error };
      } finally {
        if (
          requestId === latestOpenRequestId &&
          activeOpenController === controller
        ) {
          activeOpenController = null;
        }
      }
    }

    async function refreshTarget(location, {
      getCurrentLocation,
      onBadge,
      onRender,
      onError,
    } = {}) {
      const captured =
        locationHelper.normalizeLocationForComparison(location);
      if (!captured) {
        throw new TypeError('Complete campsite location is required');
      }

      try {
        const response = await fetchImpl(locationHelper.apiUrl(captured));
        if (!response.ok) {
          throw new Error('Campsite refresh failed');
        }

        const data = await response.json();
        const canonical = locationHelper.canonicalLocationFromResponse(
          data,
          captured.parkSlug,
        );
        await onBadge?.(canonical, data);

        let current = null;
        try {
          current = getCurrentLocation?.() || null;
        } catch {
          current = null;
        }

        if (locationHelper.sameLocation(current, captured)) {
          await onRender?.(data, canonical);
          return {
            status: 'rendered',
            data,
            canonicalLocation: canonical,
          };
        }

        return {
          status: 'badge-only',
          data,
          canonicalLocation: canonical,
        };
      } catch (error) {
        let current = null;
        try {
          current = getCurrentLocation?.() || null;
        } catch {
          current = null;
        }

        if (locationHelper.sameLocation(current, captured)) {
          await onError?.(error, captured);
        }
        return { status: 'error', error };
      }
    }

    return Object.freeze({
      cancelOpen,
      openLatest,
      refreshTarget,
    });
  }

  global.CampPicsCampsiteRequests = Object.freeze({
    createCoordinator,
  });
})(window);
