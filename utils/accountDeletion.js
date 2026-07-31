import mongoose from 'mongoose';

import { Email } from '../models/email.js';
import {
  CLOUDINARY_PHOTO_DELETE_JOB,
  MediaCleanupJob,
} from '../models/mediaCleanupJob.js';
import { Park } from '../models/park.js';
import { Token } from '../models/token.js';
import { Upload } from '../models/upload.js';
import { User } from '../models/user.js';
import {
  normalizeCloudinaryPublicId,
  resolveCloudinaryPhotoIdentity,
} from './cloudinaryPhotoIdentity.js';
import {
  ACCOUNT_DELETION_MEDIA_ID_PATHS,
  ACCOUNT_DELETION_USER_REFERENCE_PATHS,
  accountDeletionIdString,
  accountDeletionIdsEqual,
  forEachParkAccountContent,
  parkHasUserContentOrLikes,
  removeUserParkContentAndLikes,
} from './accountDeletionParkTraversal.js';
import {
  MONGO_TRANSACTION_UNAVAILABLE,
  MongoTransactionUnavailableError,
  runMongoTransaction,
} from './mongoTransaction.js';

export const ACCOUNT_DELETE_NOT_FOUND = 'ACCOUNT_DELETE_NOT_FOUND';
export const ACCOUNT_DELETE_NOT_ALLOWED = 'ACCOUNT_DELETE_NOT_ALLOWED';
export const ACCOUNT_DELETE_CREDENTIAL_CHANGED =
  'ACCOUNT_DELETE_CREDENTIAL_CHANGED';
export const ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED =
  'ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED';
export const ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE =
  'ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE';
export const ACCOUNT_DELETE_PERSISTENCE_FAILED =
  'ACCOUNT_DELETE_PERSISTENCE_FAILED';

export class AccountDeletionError extends Error {
  constructor(code, { cause } = {}) {
    super(code, { cause });
    this.name = 'AccountDeletionError';
    this.code = code;
  }
}

function resultCount(result, currentName, legacyName) {
  const value = result?.[currentName] ?? result?.[legacyName];
  return Number.isInteger(value) ? value : 0;
}

function isUsableObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function mediaReviewRequired() {
  throw new AccountDeletionError(
    ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED,
  );
}

function addIdToMap(map, value) {
  const key = accountDeletionIdString(value);
  if (!key || !isUsableObjectId(value)) return false;
  if (!map.has(key)) map.set(key, value);
  return true;
}

function hasStoredString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function classifyUploadMedia(upload) {
  if (upload?.mediaType === 'photo') return 'photo';
  if (upload?.mediaType === 'video') return 'video';
  if (
    hasStoredString(upload?.cloudinaryPublicId) ||
    hasStoredString(upload?.cloudinaryUrl) ||
    hasStoredString(upload?.cloudinaryId)
  ) {
    return 'photo';
  }
  if (hasStoredString(upload?.youtubeId)) return 'video';
  return 'ambiguous';
}

function buildSeedParkQuery(userId, uploadMediaIds) {
  const conditions = ACCOUNT_DELETION_USER_REFERENCE_PATHS.map(path => ({
    [path]: userId,
  }));

  for (const mediaType of ['photo', 'video']) {
    const ids = [...uploadMediaIds[mediaType].values()];
    if (ids.length === 0) continue;
    for (const path of ACCOUNT_DELETION_MEDIA_ID_PATHS[mediaType]) {
      conditions.push({ [path]: { $in: ids } });
    }
  }

  return { $or: conditions };
}

function buildRelatedParkQuery(candidateMediaIds) {
  const mediaIds = [...candidateMediaIds.values()];
  const conditions = [];

  for (const mediaType of ['photo', 'video']) {
    for (const path of ACCOUNT_DELETION_MEDIA_ID_PATHS[mediaType]) {
      conditions.push({ [path]: { $in: mediaIds } });
    }
  }

  return { $or: conditions };
}

function collectParkInventory(parks, userId) {
  const owned = {
    photo: new Map(),
    video: new Map(),
  };
  const active = {
    photo: new Map(),
    video: new Map(),
  };
  let invalidOwnedPhotoCount = 0;

  const record = (map, key, value) => {
    const current = map.get(key) || [];
    current.push(value);
    map.set(key, current);
  };

  for (const park of parks) {
    forEachParkAccountContent(park, ({ mediaType, items }) => {
      if (mediaType !== 'photo' && mediaType !== 'video') return;
      for (const media of items) {
        const mediaKey = accountDeletionIdString(media?._id);
        const isOwned = accountDeletionIdsEqual(media?.user, userId);
        if (!mediaKey || !isUsableObjectId(media?._id)) {
          if (mediaType === 'photo' && isOwned) {
            invalidOwnedPhotoCount += 1;
          }
          continue;
        }
        const entry = { media, parkId: park?._id };
        record(active[mediaType], mediaKey, entry);
        if (isOwned) {
          record(owned[mediaType], mediaKey, entry);
        }
      }
    });
  }

  return { active, invalidOwnedPhotoCount, owned };
}

function collectCandidateMediaIds(ownedUploads, seedInventory) {
  const candidateMediaIds = new Map();

  for (const upload of ownedUploads) {
    addIdToMap(candidateMediaIds, upload?.mediaId);
  }
  for (const mediaType of ['photo', 'video']) {
    for (const entries of seedInventory.owned[mediaType].values()) {
      for (const entry of entries) {
        addIdToMap(candidateMediaIds, entry?.media?._id);
      }
    }
  }

  return candidateMediaIds;
}

function mergeParksById(seedParks, relatedParks) {
  const parksById = new Map();

  for (const park of [...seedParks, ...relatedParks]) {
    if (!isUsableObjectId(park?._id)) {
      throw new AccountDeletionError(
        ACCOUNT_DELETE_PERSISTENCE_FAILED,
      );
    }
    const parkKey = accountDeletionIdString(park._id);
    if (!parksById.has(parkKey)) parksById.set(parkKey, park);
  }

  return [...parksById.values()];
}

function uploadsByMediaId(uploads, mediaType, mediaId) {
  return uploads.filter(upload =>
    classifyUploadMedia(upload) === mediaType &&
    accountDeletionIdsEqual(upload?.mediaId, mediaId)
  );
}

function requireOneParkId(entries) {
  const parkIds = new Map();
  for (const entry of entries) {
    if (entry?.parkId == null || entry.parkId === '') continue;
    if (!isUsableObjectId(entry.parkId)) mediaReviewRequired();
    parkIds.set(accountDeletionIdString(entry.parkId), entry.parkId);
  }
  if (parkIds.size !== 1) mediaReviewRequired();
  return [...parkIds.values()][0];
}

function requireResolvedIdentity({
  photos = [],
  uploads,
  photoIdentityResolver,
}) {
  const resolved = new Set();
  const identityInputs = photos.length > 0 ? photos : [null];

  for (const photo of identityInputs) {
    const identity = photoIdentityResolver({ photo, uploads });
    const normalized = normalizeCloudinaryPublicId(identity?.publicId);
    if (
      identity?.conflict ||
      !normalized ||
      normalized !== identity.publicId
    ) {
      mediaReviewRequired();
    }
    resolved.add(normalized);
  }

  if (resolved.size !== 1) mediaReviewRequired();
  return [...resolved][0];
}

function buildPhotoCleanupPlan({
  inventory,
  ownedUploads,
  relatedUploads,
  userId,
  photoIdentityResolver,
}) {
  if (inventory.invalidOwnedPhotoCount > 0) mediaReviewRequired();
  const cleanup = [];
  const plannedMediaIds = new Set();

  for (const [mediaKey, entries] of inventory.owned.photo) {
    if (!entries.every(entry => isUsableObjectId(entry.media?._id))) {
      mediaReviewRequired();
    }
    const activeEntries = inventory.active.photo.get(mediaKey) || [];
    if (activeEntries.some(entry =>
      !accountDeletionIdsEqual(entry.media?.user, userId)
    )) {
      mediaReviewRequired();
    }

    const parkId = requireOneParkId(entries);
    const mediaId = entries[0].media._id;
    const uploads = uploadsByMediaId(
      relatedUploads,
      'photo',
      mediaId,
    );
    const publicId = requireResolvedIdentity({
      photos: entries.map(entry => entry.media),
      uploads,
      photoIdentityResolver,
    });
    cleanup.push({ mediaId, parkId, publicId });
    plannedMediaIds.add(mediaKey);
  }

  const orphanGroups = new Map();
  for (const upload of ownedUploads) {
    const mediaType = classifyUploadMedia(upload);
    if (mediaType === 'video') continue;
    if (!isUsableObjectId(upload?.mediaId)) mediaReviewRequired();
    const mediaKey = accountDeletionIdString(upload.mediaId);
    if (plannedMediaIds.has(mediaKey)) continue;
    if (mediaType === 'ambiguous') mediaReviewRequired();
    const current = orphanGroups.get(mediaKey) || [];
    current.push(upload);
    orphanGroups.set(mediaKey, current);
  }

  for (const [mediaKey, ownedGroup] of orphanGroups) {
    const mediaId = ownedGroup[0].mediaId;
    const activeEntries = inventory.active.photo.get(mediaKey) || [];
    if (activeEntries.length > 0) mediaReviewRequired();

    const uploads = uploadsByMediaId(
      relatedUploads,
      'photo',
      mediaId,
    );
    const parkId = requireOneParkId(uploads);
    const publicId = requireResolvedIdentity({
      uploads,
      photoIdentityResolver,
    });
    cleanup.push({ mediaId, parkId, publicId });
    plannedMediaIds.add(mediaKey);
  }

  return cleanup;
}

function mediaOwnerIsDeletingUser(ownerUserId, deletingUserId) {
  return (
    isUsableObjectId(ownerUserId) &&
    isUsableObjectId(deletingUserId) &&
    accountDeletionIdsEqual(ownerUserId, deletingUserId)
  );
}

export function buildVideoDeletionPlan({
  activeVideos,
  ownedVideos,
  ownedUploads,
  userId,
}) {
  if (
    !(activeVideos instanceof Map) ||
    !(ownedVideos instanceof Map) ||
    !Array.isArray(ownedUploads)
  ) {
    throw new TypeError('Video deletion inventory is required.');
  }

  const deletedVideoIds = new Map();
  const embeddedVideoIds = new Map();

  for (const [mediaKey, ownedEntries] of ownedVideos) {
    const activeEntries = activeVideos.get(mediaKey) || [];
    if (ownedEntries.length === 0 || activeEntries.length === 0) {
      mediaReviewRequired();
    }

    for (const entry of activeEntries) {
      if (!mediaOwnerIsDeletingUser(entry?.media?.user, userId)) {
        mediaReviewRequired();
      }
    }

    const mediaId = ownedEntries[0]?.media?._id;
    if (!isUsableObjectId(mediaId)) mediaReviewRequired();
    deletedVideoIds.set(mediaKey, mediaId);
    embeddedVideoIds.set(mediaKey, mediaId);
  }

  for (const upload of ownedUploads) {
    if (classifyUploadMedia(upload) !== 'video') continue;
    if (!isUsableObjectId(upload?.mediaId)) continue;

    const mediaKey = accountDeletionIdString(upload.mediaId);
    if (embeddedVideoIds.has(mediaKey)) continue;

    const activeEntries = activeVideos.get(mediaKey) || [];
    if (activeEntries.length > 0) mediaReviewRequired();
    deletedVideoIds.set(mediaKey, upload.mediaId);
  }

  return Object.freeze({
    deletedVideoIds,
    embeddedVideoIds,
  });
}

export function validateActiveMediaCollisions({
  inventory,
  photoMediaIds,
  videoMediaIds,
  userId,
}) {
  if (
    !inventory?.active?.photo ||
    !inventory?.active?.video ||
    !(photoMediaIds instanceof Map) ||
    !(videoMediaIds instanceof Map)
  ) {
    throw new TypeError('Active media collision inventory is required.');
  }

  const validateType = (mediaType, mediaIds) => {
    const oppositeType = mediaType === 'photo' ? 'video' : 'photo';
    for (const mediaKey of mediaIds.keys()) {
      const activeEntries = inventory.active[mediaType].get(mediaKey) || [];
      for (const entry of activeEntries) {
        if (!mediaOwnerIsDeletingUser(entry?.media?.user, userId)) {
          mediaReviewRequired();
        }
      }
      if ((inventory.active[oppositeType].get(mediaKey) || []).length > 0) {
        mediaReviewRequired();
      }
    }
  };

  validateType('photo', photoMediaIds);
  validateType('video', videoMediaIds);
}

export function buildUploadDeletionPlan({
  ownedUploads,
  relatedUploads,
  embeddedPhotoIds,
  embeddedVideoIds,
  userId,
}) {
  if (
    !Array.isArray(ownedUploads) ||
    !Array.isArray(relatedUploads) ||
    !(embeddedPhotoIds instanceof Map) ||
    !(embeddedVideoIds instanceof Map)
  ) {
    throw new TypeError('Upload deletion inventory is required.');
  }

  const ownedUploadIds = new Map();
  const relatedCompanionUploadIds = new Map();

  for (const upload of ownedUploads) {
    addIdToMap(ownedUploadIds, upload?._id);
  }

  for (const upload of relatedUploads) {
    if (accountDeletionIdsEqual(upload?.userId, userId)) continue;
    if (!isUsableObjectId(upload?.mediaId)) continue;

    const mediaKey = accountDeletionIdString(upload.mediaId);
    const matchesPhoto = embeddedPhotoIds.has(mediaKey);
    const matchesVideo = embeddedVideoIds.has(mediaKey);
    if (!matchesPhoto && !matchesVideo) continue;
    if (matchesPhoto && matchesVideo) mediaReviewRequired();

    const mediaType = classifyUploadMedia(upload);
    if (mediaType === 'ambiguous') mediaReviewRequired();
    const expectedType = matchesPhoto ? 'photo' : 'video';
    if (mediaType !== expectedType) continue;
    if (!isUsableObjectId(upload?._id)) mediaReviewRequired();
    addIdToMap(relatedCompanionUploadIds, upload._id);
  }

  const exactPlannedUploadIds = new Map([
    ...ownedUploadIds,
    ...relatedCompanionUploadIds,
  ]);

  return Object.freeze({
    exactPlannedUploadIds,
    ownedUploadIds,
    relatedCompanionUploadIds,
  });
}

function verifyCleanupJobInsert(inserted, expected) {
  if (!Array.isArray(inserted) || inserted.length !== expected.length) {
    throw new AccountDeletionError(
      ACCOUNT_DELETE_PERSISTENCE_FAILED,
    );
  }

  for (let index = 0; index < expected.length; index += 1) {
    const actual = inserted[index];
    const planned = expected[index];
    if (
      !accountDeletionIdsEqual(actual?._id, planned._id) ||
      !accountDeletionIdsEqual(actual?.mediaId, planned.mediaId) ||
      !accountDeletionIdsEqual(actual?.parkId, planned.parkId) ||
      actual?.cloudinaryPublicId !== planned.cloudinaryPublicId ||
      actual?.kind !== planned.kind ||
      actual?.status !== 'pending' ||
      actual?.attemptCount !== 0 ||
      !(actual?.nextAttemptAt instanceof Date) ||
      actual.nextAttemptAt.getTime() !== planned.nextAttemptAt.getTime() ||
      actual?.ownerUserId != null ||
      actual?.requestedByUserId != null
    ) {
      throw new AccountDeletionError(
        ACCOUNT_DELETE_PERSISTENCE_FAILED,
      );
    }
  }
}

function mapTransactionError(error) {
  if (error instanceof AccountDeletionError) return error;
  if (
    error instanceof MongoTransactionUnavailableError ||
    error?.code === MONGO_TRANSACTION_UNAVAILABLE
  ) {
    return new AccountDeletionError(
      ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE,
      { cause: error },
    );
  }
  return new AccountDeletionError(
    ACCOUNT_DELETE_PERSISTENCE_FAILED,
    { cause: error },
  );
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function historyUpdateFilter(userId, mediaType, mediaIds) {
  return {
    _id: { $ne: userId },
    uploads: {
      $elemMatch: {
        mediaType,
        mediaId: { $in: mediaIds },
      },
    },
  };
}

function historyUpdate(mediaType, mediaIds) {
  return {
    update: {
      $set: {
        'uploads.$[entry].status': 'removed',
      },
    },
    options: {
      runValidators: true,
      arrayFilters: [{
        'entry.mediaType': mediaType,
        'entry.mediaId': { $in: mediaIds },
      }],
    },
  };
}

export function createAccountDeletionService({
  UserModel = User,
  ParkModel = Park,
  UploadModel = Upload,
  TokenModel = Token,
  EmailModel = Email,
  CleanupJobModel = MediaCleanupJob,
  transactionRunner = runMongoTransaction,
  photoIdentityResolver = resolveCloudinaryPhotoIdentity,
  cleanupJobIdFactory = () => new mongoose.Types.ObjectId(),
  now = () => new Date(),
} = {}) {
  if (
    !UserModel ||
    !ParkModel ||
    !UploadModel ||
    !TokenModel ||
    !EmailModel ||
    !CleanupJobModel
  ) {
    throw new TypeError('Account deletion models are required.');
  }

  async function deleteAccount({
    userId,
    authenticatedHash,
    authenticatedSalt,
  }) {
    if (
      !userId ||
      typeof authenticatedHash !== 'string' ||
      !authenticatedHash ||
      typeof authenticatedSalt !== 'string' ||
      !authenticatedSalt
    ) {
      throw new AccountDeletionError(
        ACCOUNT_DELETE_CREDENTIAL_CHANGED,
      );
    }

    const request = Object.freeze({
      userId,
      authenticatedHash,
      authenticatedSalt,
    });

    try {
      return await transactionRunner(async session => {
        const user = await UserModel.findOne(
          { _id: request.userId },
          '+hash +salt',
          { session },
        );
        if (!user) {
          throw new AccountDeletionError(ACCOUNT_DELETE_NOT_FOUND);
        }
        if (user.isAdmin === true) {
          throw new AccountDeletionError(ACCOUNT_DELETE_NOT_ALLOWED);
        }
        if (
          user.hash !== request.authenticatedHash ||
          user.salt !== request.authenticatedSalt
        ) {
          throw new AccountDeletionError(
            ACCOUNT_DELETE_CREDENTIAL_CHANGED,
          );
        }

        const ownedUploads = await UploadModel.find(
          { userId: request.userId },
          null,
          { session },
        );
        const uploadMediaIds = {
          photo: new Map(),
          video: new Map(),
        };
        for (const upload of ownedUploads) {
          const mediaType = classifyUploadMedia(upload);
          if (mediaType === 'photo') {
            addIdToMap(uploadMediaIds.photo, upload.mediaId);
          } else if (mediaType === 'video') {
            addIdToMap(uploadMediaIds.video, upload.mediaId);
          }
        }

        const seedParks = await ParkModel.find(
          buildSeedParkQuery(request.userId, uploadMediaIds),
          null,
          { session },
        );
        const seedInventory = collectParkInventory(
          seedParks,
          request.userId,
        );
        const candidateMediaIds = collectCandidateMediaIds(
          ownedUploads,
          seedInventory,
        );
        const relatedParks = candidateMediaIds.size > 0
          ? await ParkModel.find(
            buildRelatedParkQuery(candidateMediaIds),
            null,
            { session },
          )
          : [];
        const parks = mergeParksById(seedParks, relatedParks);
        const inventory = collectParkInventory(parks, request.userId);

        const relatedFilter = candidateMediaIds.size > 0
          ? {
            $or: [
              { userId: request.userId },
              { mediaId: { $in: [...candidateMediaIds.values()] } },
            ],
          }
          : { userId: request.userId };
        const relatedUploads = await UploadModel.find(
          relatedFilter,
          null,
          { session },
        );

        const cleanupPlan = buildPhotoCleanupPlan({
          inventory,
          ownedUploads,
          relatedUploads,
          userId: request.userId,
          photoIdentityResolver,
        });
        const videoDeletionPlan = buildVideoDeletionPlan({
          activeVideos: inventory.active.video,
          ownedVideos: inventory.owned.video,
          ownedUploads,
          userId: request.userId,
        });
        const deletedPhotoIds = new Map(
          cleanupPlan.map(plan => [
            accountDeletionIdString(plan.mediaId),
            plan.mediaId,
          ]),
        );
        validateActiveMediaCollisions({
          inventory,
          photoMediaIds: deletedPhotoIds,
          videoMediaIds: videoDeletionPlan.deletedVideoIds,
          userId: request.userId,
        });
        const embeddedPhotoIds = new Map();
        for (const [key, entries] of inventory.owned.photo) {
          embeddedPhotoIds.set(key, entries[0].media._id);
        }
        const uploadDeletionPlan = buildUploadDeletionPlan({
          ownedUploads,
          relatedUploads,
          embeddedPhotoIds,
          embeddedVideoIds: videoDeletionPlan.embeddedVideoIds,
          userId: request.userId,
        });

        const cleanupTime = now();
        if (
          !(cleanupTime instanceof Date) ||
          Number.isNaN(cleanupTime.getTime())
        ) {
          throw new AccountDeletionError(
            ACCOUNT_DELETE_PERSISTENCE_FAILED,
          );
        }
        const cleanupJobs = cleanupPlan.map(plan => ({
          _id: cleanupJobIdFactory(),
          kind: CLOUDINARY_PHOTO_DELETE_JOB,
          mediaId: plan.mediaId,
          parkId: plan.parkId,
          cloudinaryPublicId: plan.publicId,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: cleanupTime,
        }));

        if (cleanupJobs.length > 0) {
          const inserted = await CleanupJobModel.insertMany(
            cleanupJobs,
            { session, ordered: true },
          );
          verifyCleanupJobInsert(inserted, cleanupJobs);
        }

        const parkCounts = {
          parksScanned: parks.length,
          parksChanged: 0,
          photosRemoved: 0,
          videosRemoved: 0,
          reviewsRemoved: 0,
          likesRemoved: 0,
        };
        for (const park of parks) {
          const changes = removeUserParkContentAndLikes(
            park,
            request.userId,
          );
          if (!changes.changed) continue;
          const savedPark = await park.save({ session });
          if (
            !savedPark ||
            parkHasUserContentOrLikes(savedPark, request.userId)
          ) {
            throw new AccountDeletionError(
              ACCOUNT_DELETE_PERSISTENCE_FAILED,
            );
          }
          parkCounts.parksChanged += 1;
          parkCounts.photosRemoved += changes.photosRemoved;
          parkCounts.videosRemoved += changes.videosRemoved;
          parkCounts.reviewsRemoved += changes.reviewsRemoved;
          parkCounts.likesRemoved += changes.likesRemoved;
        }

        const relatedCompanionUploadIds = [
          ...uploadDeletionPlan.relatedCompanionUploadIds.values(),
        ];
        const uploadDeleteFilter = relatedCompanionUploadIds.length > 0
          ? {
            $or: [
              { userId: request.userId },
              { _id: { $in: relatedCompanionUploadIds } },
            ],
          }
          : { userId: request.userId };
        const uploadDelete = await UploadModel.deleteMany(
          uploadDeleteFilter,
          { session },
        );

        const historyCounts = { photo: 0, video: 0 };
        for (const [mediaType, mediaMap] of [
          ['photo', deletedPhotoIds],
          ['video', videoDeletionPlan.deletedVideoIds],
        ]) {
          const mediaIds = [...mediaMap.values()];
          if (mediaIds.length === 0) continue;
          const history = historyUpdate(mediaType, mediaIds);
          const updated = await UserModel.updateMany(
            historyUpdateFilter(
              request.userId,
              mediaType,
              mediaIds,
            ),
            history.update,
            { session, ...history.options },
          );
          historyCounts[mediaType] = resultCount(
            updated,
            'modifiedCount',
            'nModified',
          );
        }

        const tokenDelete = await TokenModel.deleteMany(
          { user_id: request.userId },
          { session },
        );

        const normalizedUsername = normalizeEmail(user.username);
        const emailFilter = normalizedUsername
          ? {
            $or: [
              { userId: request.userId },
              { to: normalizedUsername },
            ],
          }
          : { userId: request.userId };
        const emailDelete = await EmailModel.deleteMany(
          emailFilter,
          { session },
        );

        const cleanupOwnerUpdate = await CleanupJobModel.updateMany(
          { ownerUserId: request.userId },
          { $unset: { ownerUserId: 1 } },
          { session },
        );
        const cleanupRequesterUpdate = await CleanupJobModel.updateMany(
          { requestedByUserId: request.userId },
          { $unset: { requestedByUserId: 1 } },
          { session },
        );

        const userDelete = await UserModel.deleteOne(
          {
            _id: request.userId,
            hash: request.authenticatedHash,
            salt: request.authenticatedSalt,
            isAdmin: { $ne: true },
          },
          { session },
        );
        if (resultCount(userDelete, 'deletedCount', 'n') !== 1) {
          throw new AccountDeletionError(
            ACCOUNT_DELETE_PERSISTENCE_FAILED,
          );
        }

        return Object.freeze({
          cleanupJobIds: Object.freeze(
            cleanupJobs.map(job => job._id),
          ),
          counts: Object.freeze({
            ...parkCounts,
            cleanupJobsCreated: cleanupJobs.length,
            uploadsDeleted: resultCount(
              uploadDelete,
              'deletedCount',
              'n',
            ),
            photoHistoriesUpdated: historyCounts.photo,
            videoHistoriesUpdated: historyCounts.video,
            tokensDeleted: resultCount(
              tokenDelete,
              'deletedCount',
              'n',
            ),
            emailsDeleted: resultCount(
              emailDelete,
              'deletedCount',
              'n',
            ),
            cleanupJobReferencesUnset:
              resultCount(
                cleanupOwnerUpdate,
                'modifiedCount',
                'nModified',
              ) +
              resultCount(
                cleanupRequesterUpdate,
                'modifiedCount',
                'nModified',
              ),
            usersDeleted: 1,
          }),
        });
      });
    } catch (error) {
      throw mapTransactionError(error);
    }
  }

  return Object.freeze({ deleteAccount });
}

export const accountDeletion = createAccountDeletionService();
