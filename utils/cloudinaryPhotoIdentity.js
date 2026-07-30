const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const CLOUDINARY_HOST = 'res.cloudinary.com';
const VERSION_SEGMENT = /^v\d+$/u;
const TRANSFORMATION_COMPONENT =
  /(?:^|,)(?:a|ac|af|ar|b|bo|br|c|co|cs|d|dl|dn|dpr|du|e|eo|f|fl|fn|fps|g|h|if|ki|l|o|p|pg|q|r|so|sp|t|u|vc|vs|w|x|y|z)_[^,]+/u;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isUrlLike(value) {
  return URL_SCHEME.test(value) || value.startsWith('//');
}

export function normalizeCloudinaryPublicId(value) {
  const normalized = normalizeString(value);
  if (
    !normalized ||
    CONTROL_CHARACTERS.test(normalized) ||
    isUrlLike(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function isValidCloudinaryPublicId(value) {
  return normalizeCloudinaryPublicId(value) !== null;
}

function decodePathSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (
      !decoded ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      CONTROL_CHARACTERS.test(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function looksLikeTransformationSegment(value) {
  return TRANSFORMATION_COMPONENT.test(value);
}

export function parseCloudinaryDeliveryUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  let url;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.toLowerCase() !== CLOUDINARY_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }

  const rawSegments = url.pathname.split('/').slice(1);
  if (rawSegments.some(segment => !segment)) return null;

  const segments = rawSegments.map(decodePathSegment);
  if (segments.some(segment => segment === null)) return null;
  if (
    segments.length < 4 ||
    segments[1] !== 'image' ||
    segments[2] !== 'upload'
  ) {
    return null;
  }

  const deliverySegments = segments.slice(3);
  const versionIndex = deliverySegments.findIndex(segment =>
    VERSION_SEGMENT.test(segment)
  );

  let publicIdSegments;
  if (versionIndex >= 0) {
    publicIdSegments = deliverySegments.slice(versionIndex + 1);
  } else {
    if (
      deliverySegments.length > 1 &&
      deliverySegments
        .slice(0, -1)
        .some(looksLikeTransformationSegment)
    ) {
      return null;
    }
    publicIdSegments = deliverySegments;
  }

  if (!publicIdSegments.length) return null;

  const filename = publicIdSegments.at(-1);
  const extensionIndex = filename.lastIndexOf('.');
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) {
    return null;
  }

  const publicId = normalizeCloudinaryPublicId([
    ...publicIdSegments.slice(0, -1),
    filename.slice(0, extensionIndex),
  ].join('/'));
  if (!publicId) return null;

  url.search = '';
  url.hash = '';

  return {
    publicId,
    deliveryUrl: url.href,
  };
}

export function classifyLegacyCloudinaryId(value) {
  const normalized = normalizeString(value);
  if (!normalized) return { kind: 'missing' };

  const parsedUrl = parseCloudinaryDeliveryUrl(normalized);
  if (parsedUrl) {
    return {
      kind: 'deliveryUrl',
      ...parsedUrl,
    };
  }

  const publicId = normalizeCloudinaryPublicId(normalized);
  if (publicId) {
    return {
      kind: 'publicId',
      publicId,
    };
  }

  return { kind: 'malformed' };
}

function asArray(singleValue, multipleValues) {
  if (Array.isArray(multipleValues)) return multipleValues;
  return singleValue ? [singleValue] : [];
}

export function resolveCloudinaryPhotoIdentity({
  photo = null,
  upload = null,
  uploads,
  userUpload = null,
  userUploads,
} = {}) {
  const uploadRecords = asArray(upload, uploads);
  const userUploadRecords = asArray(userUpload, userUploads);
  const publicIdCandidates = [];
  const deliveryUrlCandidates = [];
  const malformedSources = [];

  const addExplicitPublicId = (value, source) => {
    if (value == null || value === '') return;
    const publicId = normalizeCloudinaryPublicId(value);
    if (!publicId) {
      malformedSources.push(source);
      return;
    }
    publicIdCandidates.push({ publicId, source });
  };

  const addDeliveryUrl = (value, source) => {
    if (value == null || value === '') return;
    const parsed = parseCloudinaryDeliveryUrl(value);
    if (!parsed) {
      malformedSources.push(source);
      return;
    }
    publicIdCandidates.push({
      publicId: parsed.publicId,
      source: `${source}:derived`,
    });
    deliveryUrlCandidates.push({
      deliveryUrl: parsed.deliveryUrl,
      source,
    });
  };

  addExplicitPublicId(
    photo?.cloudinaryPublicId,
    'photo.cloudinaryPublicId',
  );
  uploadRecords.forEach((record, index) => {
    addExplicitPublicId(
      record?.cloudinaryPublicId,
      `upload[${index}].cloudinaryPublicId`,
    );
  });
  userUploadRecords.forEach((record, index) => {
    addExplicitPublicId(
      record?.cloudinaryPublicId,
      `userUpload[${index}].cloudinaryPublicId`,
    );
  });

  addDeliveryUrl(photo?.url, 'photo.url');
  uploadRecords.forEach((record, index) => {
    addDeliveryUrl(record?.cloudinaryUrl, `upload[${index}].cloudinaryUrl`);
  });
  userUploadRecords.forEach((record, index) => {
    addDeliveryUrl(
      record?.cloudinaryUrl,
      `userUpload[${index}].cloudinaryUrl`,
    );
  });

  uploadRecords.forEach((record, index) => {
    const legacy = classifyLegacyCloudinaryId(record?.cloudinaryId);
    const source = `upload[${index}].cloudinaryId`;
    if (legacy.kind === 'deliveryUrl') {
      publicIdCandidates.push({
        publicId: legacy.publicId,
        source: `${source}:derived`,
      });
      deliveryUrlCandidates.push({
        deliveryUrl: legacy.deliveryUrl,
        source,
      });
    } else if (legacy.kind === 'publicId') {
      publicIdCandidates.push({
        publicId: legacy.publicId,
        source,
      });
    } else if (legacy.kind === 'malformed') {
      malformedSources.push(source);
    }
  });

  const uniquePublicIds = new Set(
    publicIdCandidates.map(candidate => candidate.publicId),
  );
  const conflict = uniquePublicIds.size > 1;
  const selectedPublicId = conflict ? null : publicIdCandidates[0] || null;
  const selectedDeliveryUrl = conflict ? null : deliveryUrlCandidates[0] || null;

  return {
    publicId: selectedPublicId?.publicId ?? null,
    deliveryUrl: selectedDeliveryUrl?.deliveryUrl ?? null,
    publicIdSource: selectedPublicId?.source ?? null,
    deliveryUrlSource: selectedDeliveryUrl?.source ?? null,
    conflict,
    malformedSources,
    unresolved: !conflict && !selectedPublicId,
  };
}
