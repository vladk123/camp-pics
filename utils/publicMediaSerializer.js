export const PUBLIC_MEDIA_KEYS = Object.freeze([
  '_id',
  'url',
  'caption',
  'username',
  'dateTaken',
  'uploadedAt',
  'canDelete',
  'isAdminDelete',
]);

function normalizedId(value) {
  const candidate = value && typeof value === 'object' && '_id' in value
    ? value._id
    : value;

  if (candidate == null) return null;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    return /^[a-f\d]{24}$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }

  try {
    if (typeof candidate.toHexString === 'function') {
      const hex = candidate.toHexString();
      if (typeof hex === 'string' && hex) return hex.toLowerCase();
    }

    if (typeof candidate.toString === 'function') {
      const rendered = candidate.toString();
      if (
        typeof rendered === 'string' &&
        rendered &&
        rendered !== '[object Object]'
      ) {
        return /^[a-f\d]{24}$/i.test(rendered)
          ? rendered.toLowerCase()
          : rendered;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function mediaOwnerMatchesViewer(ownerId, viewerId) {
  const owner = normalizedId(ownerId);
  const viewer = normalizedId(viewerId);
  return owner !== null && viewer !== null && owner === viewer;
}

export function serializePublicMedia(item, viewer = null) {
  const isOwner = mediaOwnerMatchesViewer(item?.user, viewer?._id);
  const isAdministrator = viewer?.isAdmin === true;
  const isAdminDelete = isAdministrator && !isOwner;

  return {
    _id: item?._id ?? null,
    url: item?.url ?? null,
    caption: item?.caption ?? null,
    username: item?.username ?? null,
    dateTaken: item?.dateTaken ?? null,
    uploadedAt: item?.uploadedAt ?? null,
    canDelete: isOwner || isAdministrator,
    isAdminDelete,
  };
}

export function serializePublicMediaCollection(value, viewer = null) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(item => serializePublicMedia(item, viewer));
  }
  if (typeof value[Symbol.iterator] === 'function') {
    return Array.from(value, item => serializePublicMedia(item, viewer));
  }
  if (Number.isInteger(value.length) && value.length >= 0) {
    return Array.from(value, item => serializePublicMedia(item, viewer));
  }
  return [];
}
