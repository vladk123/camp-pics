import mongoose from 'mongoose';

import {
  CLOUDINARY_PHOTO_DELETE_JOB,
} from '../models/mediaCleanupJob.js';
import {
  resolveCloudinaryPhotoIdentity,
} from './cloudinaryPhotoIdentity.js';
import {
  CampsiteTargetError,
  resolveCampsiteTarget,
} from './campsiteTarget.js';
import {
  MONGO_TRANSACTION_UNAVAILABLE,
  MongoTransactionUnavailableError,
  runMongoTransaction,
} from './mongoTransaction.js';

export const MEDIA_DELETE_NOT_FOUND = 'MEDIA_DELETE_NOT_FOUND';
export const MEDIA_DELETE_NOT_AUTHORIZED =
  'MEDIA_DELETE_NOT_AUTHORIZED';
export const MEDIA_DELETE_TARGET_CHANGED =
  'MEDIA_DELETE_TARGET_CHANGED';
export const MEDIA_DELETE_TRANSACTION_UNAVAILABLE =
  'MEDIA_DELETE_TRANSACTION_UNAVAILABLE';
export const MEDIA_DELETE_PERSISTENCE_FAILED =
  'MEDIA_DELETE_PERSISTENCE_FAILED';
export const CLOUDINARY_IDENTITY_CONFLICT =
  'CLOUDINARY_IDENTITY_CONFLICT';
export const PHOTO_IDENTITY_UNRESOLVED =
  'PHOTO_IDENTITY_UNRESOLVED';

const MEDIA_FIELDS = Object.freeze({
  photo: 'photos',
  video: 'videos',
});

export class MediaDeletionError extends Error {
  constructor(code, { cause } = {}) {
    super(code, { cause });
    this.name = 'MediaDeletionError';
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

function exactMediaMatches(target, field, mediaId) {
  const items = target?.[field];
  if (!Array.isArray(items)) {
    throw new MediaDeletionError(MEDIA_DELETE_PERSISTENCE_FAILED);
  }
  return items.filter(item => idsEqual(item?._id, mediaId));
}

function mapTransactionError(error) {
  if (error instanceof MediaDeletionError) return error;
  if (
    error instanceof MongoTransactionUnavailableError ||
    error?.code === MONGO_TRANSACTION_UNAVAILABLE
  ) {
    return new MediaDeletionError(
      MEDIA_DELETE_TRANSACTION_UNAVAILABLE,
      { cause: error },
    );
  }
  return new MediaDeletionError(MEDIA_DELETE_PERSISTENCE_FAILED, {
    cause: error,
  });
}

function resolveTarget({
  park,
  locationInput,
  hasCampsite,
  campsiteResolver,
}) {
  if (!hasCampsite) return park;

  try {
    return campsiteResolver(park, locationInput).target;
  } catch (error) {
    if (error instanceof CampsiteTargetError) {
      throw new MediaDeletionError(MEDIA_DELETE_TARGET_CHANGED, {
        cause: error,
      });
    }
    throw error;
  }
}

function verifyCleanupJobInsert(inserted, cleanupJobId, mediaId) {
  if (
    !Array.isArray(inserted) ||
    inserted.length !== 1 ||
    !idsEqual(inserted[0]?._id, cleanupJobId) ||
    !idsEqual(inserted[0]?.mediaId, mediaId)
  ) {
    throw new MediaDeletionError(MEDIA_DELETE_PERSISTENCE_FAILED);
  }
}

function removeMediaById(target, field, mediaId) {
  for (let index = target[field].length - 1; index >= 0; index -= 1) {
    if (idsEqual(target[field][index]?._id, mediaId)) {
      target[field].splice(index, 1);
    }
  }
}

export function createMediaDeletionService({
  ParkModel,
  UploadModel,
  UserModel,
  CleanupJobModel,
  transactionRunner = runMongoTransaction,
  campsiteResolver = resolveCampsiteTarget,
  photoIdentityResolver = resolveCloudinaryPhotoIdentity,
  cleanupJobIdFactory = () => new mongoose.Types.ObjectId(),
  now = () => new Date(),
}) {
  if (!ParkModel || !UploadModel || !UserModel || !CleanupJobModel) {
    throw new TypeError('Media deletion models are required.');
  }

  async function deleteMedia({
    parkSlug,
    locationInput = {},
    mediaType,
    mediaId,
    actorUserId,
    actorIsAdmin = false,
  }) {
    const field = MEDIA_FIELDS[mediaType];
    if (!parkSlug || !field || !mediaId || !actorUserId) {
      throw new MediaDeletionError(MEDIA_DELETE_PERSISTENCE_FAILED);
    }

    const request = Object.freeze({
      parkSlug,
      locationInput: Object.freeze({
        campgroundSlug: locationInput.campgroundSlug,
        campsiteSlug: locationInput.campsiteSlug,
      }),
      mediaType,
      mediaId,
      actorUserId,
      actorIsAdmin: actorIsAdmin === true,
    });
    const hasCampsite = request.locationInput.campsiteSlug != null;

    try {
      return await transactionRunner(async session => {
        const park = await ParkModel.findOne(
          { slug: request.parkSlug },
          null,
          { session },
        );
        if (!park) {
          throw new MediaDeletionError(MEDIA_DELETE_NOT_FOUND);
        }

        const target = resolveTarget({
          park,
          locationInput: request.locationInput,
          hasCampsite,
          campsiteResolver,
        });
        const matches = exactMediaMatches(
          target,
          field,
          request.mediaId,
        );
        if (matches.length === 0) {
          throw new MediaDeletionError(MEDIA_DELETE_NOT_FOUND);
        }
        if (matches.length !== 1) {
          throw new MediaDeletionError(MEDIA_DELETE_TARGET_CHANGED);
        }

        const embeddedMedia = matches[0];
        const ownerUserId = embeddedMedia.user ?? null;
        const actorOwnsMedia = idsEqual(
          ownerUserId,
          request.actorUserId,
        );
        if (!actorOwnsMedia && !request.actorIsAdmin) {
          throw new MediaDeletionError(
            MEDIA_DELETE_NOT_AUTHORIZED,
          );
        }

        let cleanupJobId = null;
        if (request.mediaType === 'photo') {
          const uploadRecords = await UploadModel.find(
            {
              mediaType: 'photo',
              mediaId: embeddedMedia._id,
            },
            null,
            { session },
          );
          const identity = photoIdentityResolver({
            photo: embeddedMedia,
            uploads: uploadRecords,
          });
          if (identity.conflict) {
            throw new MediaDeletionError(
              CLOUDINARY_IDENTITY_CONFLICT,
            );
          }
          if (!identity.publicId) {
            throw new MediaDeletionError(
              PHOTO_IDENTITY_UNRESOLVED,
            );
          }

          cleanupJobId = cleanupJobIdFactory();
          const cleanupJobs = await CleanupJobModel.insertMany(
            [{
              _id: cleanupJobId,
              kind: CLOUDINARY_PHOTO_DELETE_JOB,
              mediaId: embeddedMedia._id,
              parkId: park._id,
              ...(ownerUserId ? { ownerUserId } : {}),
              requestedByUserId: request.actorUserId,
              cloudinaryPublicId: identity.publicId,
              status: 'pending',
              attemptCount: 0,
              nextAttemptAt: now(),
            }],
            {
              session,
              ordered: true,
            },
          );
          verifyCleanupJobInsert(
            cleanupJobs,
            cleanupJobId,
            embeddedMedia._id,
          );
        }

        removeMediaById(target, field, embeddedMedia._id);
        const savedPark = await park.save({ session });
        if (!savedPark) {
          throw new MediaDeletionError(
            MEDIA_DELETE_PERSISTENCE_FAILED,
          );
        }

        await UploadModel.deleteMany(
          {
            mediaType: request.mediaType,
            mediaId: embeddedMedia._id,
          },
          { session },
        );

        if (ownerUserId) {
          await UserModel.updateOne(
            {
              _id: ownerUserId,
              uploads: {
                $elemMatch: {
                  mediaId: embeddedMedia._id,
                  mediaType: request.mediaType,
                },
              },
            },
            {
              $set: {
                'uploads.$[entry].status': 'removed',
              },
            },
            {
              session,
              runValidators: true,
              arrayFilters: [{
                'entry.mediaId': embeddedMedia._id,
                'entry.mediaType': request.mediaType,
              }],
            },
          );
        }

        const savedTarget = resolveTarget({
          park: savedPark,
          locationInput: request.locationInput,
          hasCampsite,
          campsiteResolver,
        });
        if (
          exactMediaMatches(
            savedTarget,
            field,
            embeddedMedia._id,
          ).length !== 0
        ) {
          throw new MediaDeletionError(
            MEDIA_DELETE_PERSISTENCE_FAILED,
          );
        }

        return Object.freeze({
          mediaType: request.mediaType,
          mediaId: embeddedMedia._id,
          parkId: park._id,
          ownerUserId,
          cleanupJobId,
        });
      });
    } catch (error) {
      throw mapTransactionError(error);
    }
  }

  return Object.freeze({ deleteMedia });
}
