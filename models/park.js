import mongoose from 'mongoose';
const Schema = mongoose.Schema;
await import('dotenv/config');

import { toSlug } from '../utils/general.js'

// Subdocument Schemas
const photoSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  likedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  url: { type: String, required: true },
  caption: {
    type: String,
    maxlength: 50,
  },  
  uploadedAt: { type: Date, default: Date.now },
  approved: { type: Boolean, default: true }, //  for admin moderation
  socialMediaApproved: { type: Boolean, default: false}, // for appearing in those "share" cards ("og:image")
  dateTaken: { 
    type: Date,
    required: true
  }, // date photo was taken
  showUsername: Boolean, // If user allows showing their username
  username: String // If user allow showing their name
});

const videoSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  likedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  url: { 
    type: String, 
    required: true, 
    validate: {
      validator: (v) =>
        /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/|shorts\/)?[A-Za-z0-9_-]{11}/.test(v),
      message: 'Invalid YouTube URL format',
    },  
  },
  caption: {
    type: String,
    maxlength: 50,
  },
  uploadedAt: { type: Date, default: Date.now },
  approved: { type: Boolean, default: true }, // optional: for admin moderation
  dateTaken: { 
    type: Date,
    required: true
  }, // date video was taken
  showUsername: Boolean, // If user allows showing their username
  username: String // If user allow showing their name
});

const reviewSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  likedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  rating: { type: Number, min: 1, max: 5, required: true },
  text: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now }
});

const campsiteSchema = new Schema({
    siteNumber: String,
    slug: { type: String, index: true },
    type: {
      type: String,
      enum: ['frontcountry', 'backcountry', 'walk-in', 'cabin', 'group', 'day-use'],
      default: 'frontcountry'
    },
    photos: [photoSchema],
    videos: [videoSchema],
    reviews: [reviewSchema],
    isActive: { type: Boolean, default: true },
    dateCreated: { type: Date, default: Date.now }
});
// Generate slug from siteNumber
campsiteSchema.pre("save", function (next) {
  if (!this.slug) {
    this.slug = toSlug(this.siteNumber.toString());
  }
  next();
});


const campgroundSchema = new Schema({
    name: { type: String, required: true },
    slug: { type: String },
    campsiteCount: Number,
    sitesRanges: String,
    photos: [photoSchema],
    reviews: [reviewSchema],
    campsites: [campsiteSchema],
    dateCreated: { type: Date, default: Date.now }
});
// Generate slug from name (lowercase, hyphenated) - slugs help with quicker queries without _id
campgroundSchema.pre("save", function (next) {
  if (!this.slug) {
    this.slug = toSlug(this.name);
  }
  next();
});



// Base Document Schemas
const options = { 
    discriminatorKey: 'type', // Adds hidden field (eg. 'national' type of park), if you add a park using one of the discriminators below 
    timestamps: true // Adds createdAt and updatedAt
};

const ParkSchema = new Schema({
    name: { type: String, required: true },
    slug: { type: String },
    province: { type: String, required: true },
    region: String,
    coordinates: {
        lat: Number,
        lng: Number
    },
    campsiteCount: Number,
    sitesRanges: String,
    description: String,
    trails: [{
        name: String,
        lengthKm: Number,
        difficulty: String
    }],
    campgrounds: [ campgroundSchema ],
    campsites: [campsiteSchema], // In case no campgrounds
    photos: [photoSchema], // store URLs or filenames
    videos: [videoSchema],
    reviews: [reviewSchema],
    dateCreated: { type: Date, default: Date.now }
}, options)

// Generate slug from name (lowercase, hyphenated) - slugs help with quicker queries without _id
ParkSchema.pre("save", function (next) {
  if (!this.slug) {
    this.slug = toSlug(this.name);
  }
  next();
});

// -------- Indexes --------
// Fast lookup of park by slug and province
// ParkSchema.index({ slug: 1, province: 1 }, { unique: true });
ParkSchema.index({ slug: 1 }, { unique: true });
// Optional: quick lookup by name too (useful for case-insensitive regex searches)
ParkSchema.index({ name: 1 });
// Allow efficient searching inside embedded arrays
ParkSchema.index({ 'campgrounds.slug': 1 });
// If ever need to quickly get all national/provincial parks
ParkSchema.index({ type: 1 });

export const Park = mongoose.model('Park', ParkSchema);

// Extend for national parks
const nationalSchema = new mongoose.Schema({
  managingAgency: String,
  protectedStatus: String
});
export const NationalPark = Park.discriminator('national', nationalSchema); // When adding a park using this discriminator, it'll add 'type':'national' automatically

// Extend for provincial parks
const provincialSchema = new mongoose.Schema({});
export const ProvincialPark = Park.discriminator('provincial', provincialSchema);

// Extend for territorial parks
const territorialSchema = new mongoose.Schema({});
export const TerritorialPark = Park.discriminator('territorial', territorialSchema);