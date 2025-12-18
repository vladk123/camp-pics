// models/ParkSearch.js
import mongoose from 'mongoose';

const parkSearchSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    index: true
  },
  province: {
    type: String,
    index: true
  },
  type: { 
    type: String,
    enum: ['park', 'campground'],
    required: true,
    index: true
  },
  parkType: {
    type: String, // 'national' or 'provincial' or 'territorial'
    index: true
  },
  parentPark: {
    type: String, // only used for campgrounds (it'll have a park that it's inside of)
    index: true
  },
  keywords: Array,
  image: String, // For thumbnails
  coordinates: {
      lat: Number,
      lng: Number
  },

  slug: String, // optional, for frontend linking like '/park/banff'
});

parkSearchSchema.index({ slug: 1 }, { unique: true });


export default mongoose.model('ParkSearch', parkSearchSchema);
