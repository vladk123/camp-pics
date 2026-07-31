import {
  CampsiteTargetError,
  resolveCampsiteTarget,
} from './campsiteTarget.js';
import {
  MONGO_TRANSACTION_UNAVAILABLE,
  MongoTransactionUnavailableError,
  runMongoTransaction,
} from './mongoTransaction.js';

export const MEDIA_QUOTA_CHANGED = 'MEDIA_QUOTA_CHANGED';
export const MEDIA_TRANSACTION_UNAVAILABLE =
  'MEDIA_TRANSACTION_UNAVAILABLE';
export const MEDIA_PERSISTENCE_FAILED = 'MEDIA_PERSISTENCE_FAILED';
export const MEDIA_UPLOADER_NOT_FOUND = 'MEDIA_UPLOADER_NOT_FOUND';
export const MEDIA_TARGET_CHANGED = 'MEDIA_TARGET_CHANGED';

const MEDIA_LIMITS = Object.freeze({
  photo: Object.freeze({
    park: 2,
    campsite: 5,
    arrayField: 'photos',
  }),
  video: Object.freeze({
    park: 2,
    campsite: 2,
    arrayField: 'videos',
  }),
});

export class MediaPersistenceError extends Error {
  constructor(code, { cause } = {}) {
    super(code, { cause });
    this.name = 'MediaPersistenceError';
    this.code = code;
  }
}

function idString(value) {
  if (value == null) return null;
  return typeof value.toString === 'function'
    ? value.toString()
    : String(value);
}

function idsEqual(left, right) {
  if (left == null || right == null) return false;
  if (typeof left.equals === 'function') return left.equals(right);
  if (typeof right.equals === 'function') return right.equals(left);
  return idString(left) === idString(right);
}

function mediaArray(target, field) {
  const value = target?.[field];
  if (!Array.isArray(value)) {
    throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
  }
  return value;
}

function snapshotPreparedMedia(mediaType, preparedMedia) {
  if (!Array.isArray(preparedMedia) || preparedMedia.length === 0) {
    throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
  }

  return Object.freeze(preparedMedia.map(item => {
    if (!item?.mediaId || !item?.uploadId || !item?.dateTaken) {
      throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
    }

    const shared = {
      mediaId: item.mediaId,
      uploadId: item.uploadId,
      caption: item.caption || '',
      showUsername: item.showUsername === true,
      username: item.username ?? null,
      dateTaken: item.dateTaken,
    };

    if (mediaType === 'photo') {
      if (
        typeof item.cloudinaryUrl !== 'string' ||
        !item.cloudinaryUrl ||
        typeof item.cloudinaryPublicId !== 'string' ||
        !item.cloudinaryPublicId
      ) {
        throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
      }
      return Object.freeze({
        ...shared,
        cloudinaryUrl: item.cloudinaryUrl,
        cloudinaryPublicId: item.cloudinaryPublicId,
      });
    }

    if (mediaType === 'video') {
      if (typeof item.youtubeUrl !== 'string' || !item.youtubeUrl) {
        throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
      }
      return Object.freeze({
        ...shared,
        youtubeUrl: item.youtubeUrl,
      });
    }

    throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
  }));
}

export function buildMediaLocationMetadata(park, location) {
  return Object.freeze({
    parkId: park._id,
    parkSlug: park.slug,
    parkName: park.name,

    campgroundId: location?.campground?._id ?? null,
    campgroundSlug: location?.campgroundSlug ?? null,
    campgroundName: location?.campground?.name ?? null,

    campsiteId: location?.campsite?._id ?? null,
    campsiteSlug: location?.campsiteSlug ?? null,
    campsiteName: location?.campsite?.siteNumber ?? null,
  });
}

function buildEmbeddedMedia(mediaType, item, userId) {
  const shared = {
    _id: item.mediaId,
    user: userId,
    caption: item.caption,
    showUsername: item.showUsername,
    username: item.username,
    dateTaken: item.dateTaken,
  };

  if (mediaType === 'photo') {
    return {
      ...shared,
      url: item.cloudinaryUrl,
      cloudinaryPublicId: item.cloudinaryPublicId,
    };
  }

  return {
    ...shared,
    url: item.youtubeUrl,
  };
}

function buildUploadRecord(mediaType, item, userId, metadata) {
  const location = {
    parkId: metadata.parkId,
    parkName: metadata.parkName,
    campgroundId: metadata.campgroundId,
    campgroundName: metadata.campgroundName,
    campsiteId: metadata.campsiteId,
    campsiteName: metadata.campsiteName,
  };

  if (mediaType === 'photo') {
    return {
      _id: item.uploadId,
      mediaType,
      mediaId: item.mediaId,
      cloudinaryUrl: item.cloudinaryUrl,
      cloudinaryPublicId: item.cloudinaryPublicId,
      cloudinaryId: item.cloudinaryUrl,
      ...location,
      userId,
    };
  }

  return {
    _id: item.uploadId,
    mediaType,
    mediaId: item.mediaId,
    youtubeId: item.youtubeUrl,
    ...location,
    userId,
  };
}

function buildUserHistoryEntry(mediaType, item, metadata) {
  const shared = {
    mediaType,
    mediaId: item.mediaId,
    ...metadata,
    caption: item.caption,
    dateTaken: item.dateTaken,
  };

  if (mediaType === 'photo') {
    return {
      ...shared,
      cloudinaryUrl: item.cloudinaryUrl,
      cloudinaryPublicId: item.cloudinaryPublicId,
    };
  }

  return {
    ...shared,
    youtubeUrl: item.youtubeUrl,
  };
}

function countUserMedia(items, userId) {
  return items.reduce(
    (count, item) => count + (idsEqual(item?.user, userId) ? 1 : 0),
    0,
  );
}

function resultCount(result, currentName, legacyName) {
  const value = result?.[currentName] ?? result?.[legacyName];
  return Number.isInteger(value) ? value : null;
}

function verifyInsertedUploads(inserted, preparedMedia) {
  if (!Array.isArray(inserted) || inserted.length !== preparedMedia.length) {
    throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
  }

  const insertedById = new Map(
    inserted.map(record => [idString(record?._id), record]),
  );
  const allPresent = preparedMedia.every(item => {
    const record = insertedById.get(idString(item.uploadId));
    return record && idsEqual(record.mediaId, item.mediaId);
  });
  if (!allPresent) {
    throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
  }
}

function mapTransactionError(error) {
  if (error instanceof MediaPersistenceError) return error;
  if (
    error instanceof MongoTransactionUnavailableError ||
    error?.code === MONGO_TRANSACTION_UNAVAILABLE
  ) {
    return new MediaPersistenceError(MEDIA_TRANSACTION_UNAVAILABLE, {
      cause: error,
    });
  }
  return new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED, {
    cause: error,
  });
}

export function createMediaPersistenceService({
  ParkModel,
  UploadModel,
  UserModel,
  transactionRunner = runMongoTransaction,
  campsiteResolver = resolveCampsiteTarget,
}) {
  if (!ParkModel || !UploadModel || !UserModel) {
    throw new TypeError('Media persistence models are required.');
  }

  async function commitMediaCreation({
    parkSlug,
    locationInput = {},
    userId,
    mediaType,
    preparedMedia,
  }) {
    const mediaConfig = MEDIA_LIMITS[mediaType];
    if (!mediaConfig || !parkSlug || !userId) {
      throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
    }
    const prepared = snapshotPreparedMedia(mediaType, preparedMedia);
    const hasCampsite = locationInput.campsiteSlug != null;
    const limit = hasCampsite
      ? mediaConfig.campsite
      : mediaConfig.park;

    try {
      return await transactionRunner(async session => {
        const park = await ParkModel.findOne(
          { slug: parkSlug },
          null,
          { session },
        );
        if (!park) {
          throw new MediaPersistenceError(MEDIA_TARGET_CHANGED);
        }

        let location = null;
        if (hasCampsite) {
          try {
            location = campsiteResolver(park, locationInput);
          } catch (error) {
            if (error instanceof CampsiteTargetError) {
              throw new MediaPersistenceError(MEDIA_TARGET_CHANGED, {
                cause: error,
              });
            }
            throw error;
          }
        }

        const target = location?.target || park;
        const items = mediaArray(target, mediaConfig.arrayField);
        const currentCount = countUserMedia(items, userId);
        const remainingBefore = limit - currentCount;

        if (prepared.length > remainingBefore) {
          throw new MediaPersistenceError(MEDIA_QUOTA_CHANGED);
        }
        if (prepared.some(item =>
          items.some(existing => idsEqual(existing?._id, item.mediaId))
        )) {
          throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
        }

        const metadata = buildMediaLocationMetadata(park, location);
        const embeddedMedia = prepared.map(item =>
          buildEmbeddedMedia(mediaType, item, userId)
        );
        const uploadRecords = prepared.map(item =>
          buildUploadRecord(mediaType, item, userId, metadata)
        );
        const userHistory = prepared.map(item =>
          buildUserHistoryEntry(mediaType, item, metadata)
        );

        items.push(...embeddedMedia);
        const savedPark = await park.save({ session });
        if (
          !savedPark ||
          !prepared.every(item =>
            items.some(saved => idsEqual(saved?._id, item.mediaId))
          )
        ) {
          throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
        }

        const inserted = await UploadModel.insertMany(uploadRecords, {
          session,
          ordered: true,
        });
        verifyInsertedUploads(inserted, prepared);

        const userResult = await UserModel.updateOne(
          { _id: userId },
          {
            $push: {
              uploads: {
                $each: userHistory,
              },
            },
          },
          {
            session,
            runValidators: true,
          },
        );
        const matchedCount = resultCount(
          userResult,
          'matchedCount',
          'n',
        );
        const modifiedCount = resultCount(
          userResult,
          'modifiedCount',
          'nModified',
        );
        if (matchedCount === 0) {
          throw new MediaPersistenceError(MEDIA_UPLOADER_NOT_FOUND);
        }
        if (matchedCount !== 1 || modifiedCount !== 1) {
          throw new MediaPersistenceError(MEDIA_PERSISTENCE_FAILED);
        }

        return Object.freeze({
          mediaType,
          mediaIds: Object.freeze(prepared.map(item => item.mediaId)),
          remaining: limit - currentCount - prepared.length,
        });
      });
    } catch (error) {
      throw mapTransactionError(error);
    }
  }

  return Object.freeze({ commitMediaCreation });
}
