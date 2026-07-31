import mongoose from 'mongoose';

import {
  normalizeCloudinaryPublicId,
} from '../utils/cloudinaryPhotoIdentity.js';

const { Schema } = mongoose;

export const CLOUDINARY_PHOTO_DELETE_JOB =
  'cloudinary-photo-delete';

export const MEDIA_CLEANUP_JOB_STATUSES = Object.freeze([
  'pending',
  'processing',
  'blocked',
]);

export const INVALID_CLOUDINARY_PUBLIC_ID =
  'INVALID_CLOUDINARY_PUBLIC_ID';
export const CLOUDINARY_PROVIDER_UNAVAILABLE =
  'CLOUDINARY_PROVIDER_UNAVAILABLE';
export const CLOUDINARY_PROVIDER_RESULT_UNEXPECTED =
  'CLOUDINARY_PROVIDER_RESULT_UNEXPECTED';

export const MEDIA_CLEANUP_FAILURE_CODES = Object.freeze([
  INVALID_CLOUDINARY_PUBLIC_ID,
  CLOUDINARY_PROVIDER_UNAVAILABLE,
  CLOUDINARY_PROVIDER_RESULT_UNEXPECTED,
]);

const mediaCleanupJobSchema = new Schema({
  kind: {
    type: String,
    enum: [CLOUDINARY_PHOTO_DELETE_JOB],
    default: CLOUDINARY_PHOTO_DELETE_JOB,
    required: true,
  },
  mediaId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  parkId: {
    type: Schema.Types.ObjectId,
    ref: 'Park',
    required: true,
  },
  ownerUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  requestedByUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  cloudinaryPublicId: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator(value) {
        return normalizeCloudinaryPublicId(value) === value;
      },
      message: 'Invalid Cloudinary public ID.',
    },
  },
  status: {
    type: String,
    enum: MEDIA_CLEANUP_JOB_STATUSES,
    default: 'pending',
    required: true,
  },
  attemptCount: {
    type: Number,
    default: 0,
    min: 0,
    required: true,
  },
  nextAttemptAt: {
    type: Date,
    default: Date.now,
    required: true,
  },
  lastAttemptAt: Date,
  leaseToken: String,
  leaseExpiresAt: Date,
  lastFailureCode: {
    type: String,
    enum: MEDIA_CLEANUP_FAILURE_CODES,
  },
}, {
  timestamps: true,
});

export const MediaCleanupJob = mongoose.models.MediaCleanupJob ||
  mongoose.model('MediaCleanupJob', mediaCleanupJobSchema);
