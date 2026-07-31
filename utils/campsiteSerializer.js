import { serializePublicMediaCollection } from './publicMediaSerializer.js';

export function serializeCampsiteForClient(location, viewer = null) {
  const campsite = location.campsite;
  const campground = location.campground;

  return {
    _id: campsite?._id ?? null,
    siteNumber: campsite?.siteNumber ?? null,
    slug: campsite?.slug ?? null,
    type: campsite?.type ?? null,
    campgroundSlug: campground?.slug ?? null,
    campgroundName: campground?.name ?? null,
    locationKind: location.kind,
    photos: serializePublicMediaCollection(campsite?.photos, viewer),
    videos: serializePublicMediaCollection(campsite?.videos, viewer),
  };
}
