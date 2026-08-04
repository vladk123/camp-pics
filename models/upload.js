// Keep track of all uploads

import mongoose from 'mongoose';
import {
  MONTHLY_DRAW_INELIGIBILITY_REASONS,
  MONTHLY_DRAW_RULES_VERSION,
  MONTHLY_DRAW_UPLOAD_STATUSES,
  isValidMonthKey,
} from '../utils/monthlyDraw.js';
const Schema = mongoose.Schema;
await import('dotenv/config');

const monthlyDrawReasonSet = new Set(MONTHLY_DRAW_INELIGIBILITY_REASONS);

function hasReviewDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isValidMonthlyDrawState(value) {
  if (!value || typeof value !== 'object') return false;

  const reviewedAtIsEmpty = value.reviewedAt == null;
  const reviewedByIsEmpty = value.reviewedBy == null;
  const reasonIsEmpty = value.ineligibilityReason == null;

  if (value.status === 'pending') {
    return reviewedAtIsEmpty && reviewedByIsEmpty && reasonIsEmpty;
  }
  if (value.status === 'eligible') {
    return hasReviewDate(value.reviewedAt) &&
      !reviewedByIsEmpty &&
      reasonIsEmpty;
  }
  if (value.status === 'ineligible') {
    return hasReviewDate(value.reviewedAt) &&
      !reviewedByIsEmpty &&
      monthlyDrawReasonSet.has(value.ineligibilityReason);
  }
  return false;
}

const monthlyDrawSchema = new Schema({
  status: {
    type: String,
    enum: MONTHLY_DRAW_UPLOAD_STATUSES,
    required: true,
  },
  monthKey: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isValidMonthKey,
      message: 'Monthly draw month must use YYYY-MM format.',
    },
  },
  rulesVersion: {
    type: String,
    enum: [MONTHLY_DRAW_RULES_VERSION],
    required: true,
    immutable: true,
  },
  reviewedAt: {
    type: Date,
    default: null,
  },
  reviewedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  ineligibilityReason: {
    type: String,
    enum: MONTHLY_DRAW_INELIGIBILITY_REASONS,
    default: null,
  },
}, { _id: false });

const uploadSchema = new Schema({
  mediaType: {
    type: String,
    enum: ['photo', 'video'],
    // required: true
  },
  mediaId: { type: Schema.Types.ObjectId }, // the _id of the photo/video inside Park
  // Legacy compatibility: this may contain a delivery URL or an older public ID.
  cloudinaryId: String,
  cloudinaryUrl: String,
  cloudinaryPublicId: String,
  youtubeId: String,
  parkId: { type: Schema.Types.ObjectId, ref: 'Park', required: true },
  parkName: String ,
  campgroundId: {  type: Schema.Types.ObjectId, ref: 'Campground' },
  campgroundName: String ,
  campsiteId: { type: Schema.Types.ObjectId, ref: 'Campsite' },
  campsiteName: String ,
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  approved: {
    type: Boolean,
    default: false
  },
  monthlyDraw: {
    type: monthlyDrawSchema,
    default: undefined,
    validate: {
      validator: isValidMonthlyDrawState,
      message: 'Invalid monthly draw qualification state.',
    },
  },
}, { timestamps: true });

export const Upload = mongoose.model('Upload', uploadSchema);
