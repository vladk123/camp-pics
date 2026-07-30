import 'dotenv/config';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Park } from '../models/park.js';
import { Upload } from '../models/upload.js';
import { User } from '../models/user.js';
import {
  reconcileMediaIdentifiers,
} from '../utils/mediaIdentifierReconciliation.js';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;
export const RECONCILIATION_INVALID_SELECTOR =
  'RECONCILIATION_INVALID_SELECTOR';

export function parseReconciliationArguments(args) {
  let apply = false;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--batch-size') {
      index += 1;
      batchSize = Number(args[index]);
    } else if (argument.startsWith('--batch-size=')) {
      batchSize = Number(argument.slice('--batch-size='.length));
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE
  ) {
    throw new Error(
      `--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}`,
    );
  }

  return { apply, batchSize };
}

async function* batchesFromCursor(cursor, batchSize, mapper = value => value) {
  let batch = [];
  for await (const value of cursor) {
    batch.push(mapper(value));
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

function photoProjection(prefix) {
  return {
    _id: `${prefix}._id`,
    url: `${prefix}.url`,
    cloudinaryPublicId: `${prefix}.cloudinaryPublicId`,
  };
}

function embeddedPhotoPipeline(collectionName, mediaIds = null) {
  const rootPhotos = [
    { $match: { 'photos.0': { $exists: true } } },
    { $unwind: '$photos' },
    {
      $project: {
        _id: 0,
        recordId: '$photos._id',
        mediaId: '$photos._id',
        parkId: '$_id',
        locator: { level: { $literal: 'park' } },
        photo: photoProjection('$photos'),
      },
    },
  ];
  const standalonePhotos = [
    { $match: { 'campsites.photos.0': { $exists: true } } },
    { $unwind: '$campsites' },
    { $match: { 'campsites.photos.0': { $exists: true } } },
    { $unwind: '$campsites.photos' },
    {
      $project: {
        _id: 0,
        recordId: '$campsites.photos._id',
        mediaId: '$campsites.photos._id',
        parkId: '$_id',
        locator: {
          level: { $literal: 'standaloneCampsite' },
          campsiteId: '$campsites._id',
        },
        photo: photoProjection('$campsites.photos'),
      },
    },
  ];
  const campgroundPhotos = [
    {
      $match: {
        'campgrounds.campsites.photos.0': { $exists: true },
      },
    },
    { $unwind: '$campgrounds' },
    { $unwind: '$campgrounds.campsites' },
    {
      $match: {
        'campgrounds.campsites.photos.0': { $exists: true },
      },
    },
    { $unwind: '$campgrounds.campsites.photos' },
    {
      $project: {
        _id: 0,
        recordId: '$campgrounds.campsites.photos._id',
        mediaId: '$campgrounds.campsites.photos._id',
        parkId: '$_id',
        locator: {
          level: { $literal: 'campgroundCampsite' },
          campgroundId: '$campgrounds._id',
          campsiteId: '$campgrounds.campsites._id',
        },
        photo: photoProjection('$campgrounds.campsites.photos'),
      },
    },
  ];

  const pipeline = [
    ...rootPhotos,
    {
      $unionWith: {
        coll: collectionName,
        pipeline: standalonePhotos,
      },
    },
    {
      $unionWith: {
        coll: collectionName,
        pipeline: campgroundPhotos,
      },
    },
  ];
  if (mediaIds) pipeline.push({ $match: { mediaId: { $in: mediaIds } } });
  return pipeline;
}

function toObjectIds(values) {
  return values
    .filter(value => mongoose.isObjectIdOrHexString(value))
    .map(value => new mongoose.Types.ObjectId(String(value)));
}

function requireMongoObjectId(value, selectorName) {
  if (!mongoose.isObjectIdOrHexString(value)) {
    const error = new Error(
      `${RECONCILIATION_INVALID_SELECTOR}: ${selectorName}`,
    );
    error.code = RECONCILIATION_INVALID_SELECTOR;
    throw error;
  }
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);
}

function modifiedCount(result) {
  return Number(result?.modifiedCount || 0);
}

export function createMongoMediaIdentifierRepository({
  ParkModel = Park,
  UploadModel = Upload,
  UserModel = User,
} = {}) {
  const collectionName = ParkModel.collection.name;

  async function duplicateIds(pipeline) {
    const records = await pipeline;
    return records.map(record => record._id);
  }

  return {
    async getDuplicateEmbeddedMediaIds() {
      return duplicateIds(
        ParkModel.aggregate([
          ...embeddedPhotoPipeline(collectionName),
          { $match: { mediaId: { $ne: null } } },
          { $group: { _id: '$mediaId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $project: { _id: 1 } },
        ]).allowDiskUse(true),
      );
    },

    async getDuplicateUploadMediaIds() {
      return duplicateIds(
        UploadModel.aggregate([
          { $match: { mediaType: 'photo', mediaId: { $ne: null } } },
          { $group: { _id: '$mediaId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $project: { _id: 1 } },
        ]).allowDiskUse(true),
      );
    },

    async getDuplicateUserHistoryMediaIds() {
      return duplicateIds(
        UserModel.aggregate([
          { $unwind: '$uploads' },
          {
            $match: {
              'uploads.mediaType': 'photo',
              'uploads.mediaId': { $ne: null },
            },
          },
          {
            $group: {
              _id: '$uploads.mediaId',
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $project: { _id: 1 } },
        ]).allowDiskUse(true),
      );
    },

    iterateEmbeddedPhotoBatches(batchSize) {
      const cursor = ParkModel.aggregate(
        embeddedPhotoPipeline(collectionName),
      )
        .allowDiskUse(true)
        .cursor({ batchSize });
      return batchesFromCursor(cursor, batchSize);
    },

    iterateUploadPhotoBatches(batchSize) {
      const cursor = UploadModel.find({ mediaType: 'photo' })
        .select({
          _id: 1,
          mediaId: 1,
          cloudinaryId: 1,
          cloudinaryUrl: 1,
          cloudinaryPublicId: 1,
        })
        .lean()
        .cursor({ batchSize });
      return batchesFromCursor(cursor, batchSize, upload => ({
        ...upload,
        recordId: upload._id,
      }));
    },

    iterateUserPhotoHistoryBatches(batchSize) {
      const cursor = UserModel.aggregate([
        { $unwind: '$uploads' },
        { $match: { 'uploads.mediaType': 'photo' } },
        {
          $project: {
            _id: 0,
            recordId: '$uploads._id',
            mediaId: '$uploads.mediaId',
            userId: '$_id',
            upload: {
              _id: '$uploads._id',
              mediaId: '$uploads.mediaId',
              cloudinaryUrl: '$uploads.cloudinaryUrl',
              cloudinaryPublicId: '$uploads.cloudinaryPublicId',
            },
          },
        },
      ]).cursor({ batchSize });
      return batchesFromCursor(cursor, batchSize);
    },

    async findUploadsByMediaIds(mediaIds) {
      const objectIds = toObjectIds(mediaIds);
      if (!objectIds.length) return [];
      const uploads = await UploadModel.find({
        mediaType: 'photo',
        mediaId: { $in: objectIds },
      })
        .select({
          _id: 1,
          mediaId: 1,
          cloudinaryId: 1,
          cloudinaryUrl: 1,
          cloudinaryPublicId: 1,
        })
        .lean();
      return uploads.map(upload => ({
        ...upload,
        recordId: upload._id,
      }));
    },

    async findUserHistoryByMediaIds(mediaIds) {
      const objectIds = toObjectIds(mediaIds);
      if (!objectIds.length) return [];
      return UserModel.aggregate([
        { $unwind: '$uploads' },
        {
          $match: {
            'uploads.mediaType': 'photo',
            'uploads.mediaId': { $in: objectIds },
          },
        },
        {
          $project: {
            _id: 0,
            recordId: '$uploads._id',
            mediaId: '$uploads.mediaId',
            userId: '$_id',
            upload: {
              _id: '$uploads._id',
              mediaId: '$uploads.mediaId',
              cloudinaryUrl: '$uploads.cloudinaryUrl',
              cloudinaryPublicId: '$uploads.cloudinaryPublicId',
            },
          },
        },
      ]);
    },

    async findExistingEmbeddedMediaIds(mediaIds) {
      const objectIds = toObjectIds(mediaIds);
      if (!objectIds.length) return [];
      const records = await ParkModel.aggregate([
        ...embeddedPhotoPipeline(collectionName, objectIds),
        { $group: { _id: '$mediaId' } },
      ]).allowDiskUse(true);
      return records.map(record => record._id);
    },

    async applyChange(change) {
      if (change.kind === 'uploadPublicId' || change.kind === 'uploadUrl') {
        const uploadId = requireMongoObjectId(
          change.recordId,
          'upload.recordId',
        );
        const mediaId = requireMongoObjectId(
          change.mediaId,
          'upload.mediaId',
        );
        const field = change.kind === 'uploadPublicId'
          ? 'cloudinaryPublicId'
          : 'cloudinaryUrl';
        const result = await UploadModel.updateOne(
          {
            _id: uploadId,
            mediaType: 'photo',
            mediaId,
            [field]: { $exists: false },
          },
          { $set: { [field]: change.value } },
        );
        return modifiedCount(result);
      }

      if (change.kind === 'userHistoryPublicId') {
        const userId = requireMongoObjectId(
          change.userId,
          'userHistory.userId',
        );
        const entryId = requireMongoObjectId(
          change.recordId,
          'userHistory.recordId',
        );
        const mediaId = requireMongoObjectId(
          change.mediaId,
          'userHistory.mediaId',
        );
        const result = await UserModel.updateOne(
          {
            _id: userId,
            uploads: {
              $elemMatch: {
                _id: entryId,
                mediaId,
                mediaType: 'photo',
                cloudinaryPublicId: { $exists: false },
              },
            },
          },
          {
            $set: {
              'uploads.$[entry].cloudinaryPublicId': change.value,
            },
          },
          {
            arrayFilters: [
              {
                'entry._id': entryId,
                'entry.mediaId': mediaId,
                'entry.mediaType': 'photo',
                'entry.cloudinaryPublicId': { $exists: false },
              },
            ],
          },
        );
        return modifiedCount(result);
      }

      if (change.kind !== 'parkPhotoPublicId') {
        throw new Error(`Unsupported change kind: ${change.kind}`);
      }

      const parkId = requireMongoObjectId(
        change.parkId,
        'embeddedPhoto.parkId',
      );
      const mediaId = requireMongoObjectId(
        change.mediaId,
        'embeddedPhoto.mediaId',
      );
      const locator = change.locator;
      if (!locator || typeof locator !== 'object') {
        const error = new Error(
          `${RECONCILIATION_INVALID_SELECTOR}: embeddedPhoto.locator`,
        );
        error.code = RECONCILIATION_INVALID_SELECTOR;
        throw error;
      }
      let field;
      const arrayFilters = [];
      if (locator.level === 'park') {
        field = 'photos.$[photo].cloudinaryPublicId';
      } else if (locator.level === 'standaloneCampsite') {
        const campsiteId = requireMongoObjectId(
          locator.campsiteId,
          'embeddedPhoto.campsiteId',
        );
        field = 'campsites.$[site].photos.$[photo].cloudinaryPublicId';
        arrayFilters.push({ 'site._id': campsiteId });
      } else if (locator.level === 'campgroundCampsite') {
        const campgroundId = requireMongoObjectId(
          locator.campgroundId,
          'embeddedPhoto.campgroundId',
        );
        const campsiteId = requireMongoObjectId(
          locator.campsiteId,
          'embeddedPhoto.campsiteId',
        );
        field =
          'campgrounds.$[campground].campsites.$[site].photos.$[photo].cloudinaryPublicId';
        arrayFilters.push(
          { 'campground._id': campgroundId },
          { 'site._id': campsiteId },
        );
      } else {
        const error = new Error(
          `${RECONCILIATION_INVALID_SELECTOR}: embeddedPhoto.locator.level`,
        );
        error.code = RECONCILIATION_INVALID_SELECTOR;
        throw error;
      }
      arrayFilters.push({
        'photo._id': mediaId,
        'photo.cloudinaryPublicId': { $exists: false },
      });

      const result = await ParkModel.updateOne(
        { _id: parkId },
        { $set: { [field]: change.value } },
        { arrayFilters },
      );
      return modifiedCount(result);
    },
  };
}

export async function runReconciliationCli(args = process.argv.slice(2)) {
  const { apply, batchSize } = parseReconciliationArguments(args);
  const mode = apply ? 'APPLY MODE' : 'DRY RUN';
  console.log(`${mode}: media identifier reconciliation starting`);
  console.log(`Bounded batch size: ${batchSize}`);
  if (apply) {
    console.log(
      'Back up MongoDB before using --apply. Existing fields are never overwritten.',
    );
  }

  if (!process.env.DB_URL) {
    throw new Error('DB_URL is required');
  }

  await mongoose.connect(process.env.DB_URL, { autoIndex: false });
  try {
    const summary = await reconcileMediaIdentifiers({
      repository: createMongoMediaIdentifierRepository(),
      apply,
      batchSize,
    });
    console.log(JSON.stringify(summary, null, 2));
    console.log(`${mode}: media identifier reconciliation complete`);
    return summary;
  } finally {
    await mongoose.disconnect();
  }
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runReconciliationCli().catch(error => {
    console.error(`Media identifier reconciliation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
