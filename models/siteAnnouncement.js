import mongoose from 'mongoose';

import {
  SITE_ANNOUNCEMENT_DEFAULTS,
  SITE_ANNOUNCEMENT_KEY,
  SITE_ANNOUNCEMENT_LIMITS,
  isValidInternalCtaUrl,
} from '../utils/siteAnnouncement.js';

const { Schema } = mongoose;

function relatedValue(context, field) {
  if (context instanceof mongoose.Document) return context[field];
  if (typeof context?.get === 'function') return context.get(field);
  return context?.[field];
}

const siteAnnouncementSchema = new Schema({
  key: {
    type: String,
    required: true,
    enum: [SITE_ANNOUNCEMENT_KEY],
    default: SITE_ANNOUNCEMENT_KEY,
    unique: true,
    immutable: true,
  },
  enabled: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    trim: true,
    maxlength: SITE_ANNOUNCEMENT_LIMITS.title,
    required() {
      return relatedValue(this, 'enabled') === true;
    },
  },
  message: {
    type: String,
    trim: true,
    maxlength: SITE_ANNOUNCEMENT_LIMITS.message,
    required() {
      return relatedValue(this, 'enabled') === true;
    },
  },
  autoOpen: {
    type: Boolean,
    default: true,
  },
  showNavLink: {
    type: Boolean,
    default: true,
  },
  navLinkText: {
    type: String,
    trim: true,
    maxlength: SITE_ANNOUNCEMENT_LIMITS.navLinkText,
    default: SITE_ANNOUNCEMENT_DEFAULTS.navLinkText,
    required() {
      return relatedValue(this, 'showNavLink') === true;
    },
  },
  ctaLabel: {
    type: String,
    trim: true,
    maxlength: SITE_ANNOUNCEMENT_LIMITS.ctaLabel,
    default: '',
    validate: {
      validator(value) {
        return Boolean(value) === Boolean(relatedValue(this, 'ctaUrl'));
      },
      message: 'CTA label and URL must be provided together.',
    },
  },
  ctaUrl: {
    type: String,
    trim: true,
    maxlength: SITE_ANNOUNCEMENT_LIMITS.ctaUrl,
    default: '',
    validate: [
      {
        validator(value) {
          return Boolean(value) === Boolean(relatedValue(this, 'ctaLabel'));
        },
        message: 'CTA label and URL must be provided together.',
      },
      {
        validator(value) {
          return !value || isValidInternalCtaUrl(value);
        },
        message: 'CTA URL must be an internal CampPics URL.',
      },
    ],
  },
  startsOn: {
    type: Date,
    default: null,
  },
  endsOn: {
    type: Date,
    default: null,
    validate: {
      validator(value) {
        const startsOn = relatedValue(this, 'startsOn');
        return !value || !startsOn || value.getTime() >= startsOn.getTime();
      },
      message: 'End date must not precede start date.',
    },
  },
  revision: {
    type: Number,
    default: 1,
    required: true,
    min: 1,
    validate: {
      validator: Number.isSafeInteger,
      message: 'Revision must be a positive integer.',
    },
  },
}, {
  timestamps: true,
  strict: 'throw',
});

siteAnnouncementSchema.path('enabled').validate(function enabledIsVisible(value) {
  return value !== true ||
    relatedValue(this, 'autoOpen') === true ||
    relatedValue(this, 'showNavLink') === true;
}, 'Enabled announcement requires a visibility method.');

export const SiteAnnouncement = mongoose.models.SiteAnnouncement ||
  mongoose.model('SiteAnnouncement', siteAnnouncementSchema);
