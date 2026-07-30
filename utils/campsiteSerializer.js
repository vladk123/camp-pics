const MEDIA_FIELDS = [
  '_id',
  'user',
  'url',
  'caption',
  'username',
  'dateTaken',
  'uploadedAt',
];

function collectionItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
  if (Number.isInteger(value.length) && value.length >= 0) return Array.from(value);
  return [];
}

function serializeMediaItem(item) {
  return Object.fromEntries(MEDIA_FIELDS.map(field => [field, item?.[field] ?? null]));
}

export function serializeCampsiteForClient(location) {
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
    photos: collectionItems(campsite?.photos).map(serializeMediaItem),
    videos: collectionItems(campsite?.videos).map(serializeMediaItem),
  };
}
