import mongoose from 'mongoose';

import {
  MONTHLY_DRAW_RULES_VERSION,
  buildMonthlyDrawNoUploadEntryId,
  isValidMonthKey,
} from '../utils/monthlyDraw.js';

const { Schema } = mongoose;

const monthlyDrawNoUploadEntrySchema = new Schema({
  _id: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator(value) {
        try {
          return value === buildMonthlyDrawNoUploadEntryId(
            this.userId,
            this.monthKey,
          );
        } catch {
          return false;
        }
      },
      message: 'Entry ID must match the account and month.',
    },
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  },
  monthKey: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isValidMonthKey,
      message: 'Month key must use YYYY-MM.',
    },
  },
  rulesVersion: {
    type: String,
    required: true,
    enum: [MONTHLY_DRAW_RULES_VERSION],
    immutable: true,
  },
  ageOfMajorityConfirmed: {
    type: Boolean,
    required: true,
    immutable: true,
    validate: {
      validator: value => value === true,
      message: 'Age-of-majority confirmation is required.',
    },
  },
  rulesAccepted: {
    type: Boolean,
    required: true,
    immutable: true,
    validate: {
      validator: value => value === true,
      message: 'Official Rules acceptance is required.',
    },
  },
  submittedAt: {
    type: Date,
    default: Date.now,
    immutable: true,
  },
}, {
  timestamps: true,
  strict: 'throw',
});

export const MonthlyDrawNoUploadEntry =
  mongoose.models.MonthlyDrawNoUploadEntry ||
  mongoose.model('MonthlyDrawNoUploadEntry', monthlyDrawNoUploadEntrySchema);
