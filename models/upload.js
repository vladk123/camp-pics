// Keep track of all uploads

import mongoose from 'mongoose';
const Schema = mongoose.Schema;
await import('dotenv/config');

const uploadSchema = new Schema({
  mediaType: {
    type: String,
    enum: ['photo', 'video'],
    // required: true
  },
  mediaId: { type: Schema.Types.ObjectId }, // the _id of the photo/video inside Park
  cloudinaryId: String, // optional, for photos only
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
}, { timestamps: true });

export const Upload = mongoose.model('Upload', uploadSchema);