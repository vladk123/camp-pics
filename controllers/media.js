import { Park } from '../models/park.js';
import { Upload } from '../models/upload.js';
import { User } from "../models/user.js"; // ensure correct path
// import cloudinary from '../config/cloudinary.js';
import { uploadMemory } from '../middleware.js'; //
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import sharp from "sharp";

// Func to get Cloudinary url
function extractCloudinaryId(url) {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
  return match ? match[1] : null;
}

// Function to validate images being uploaded
export async function validateImageBuffer(buffer) {
  const metadata = await sharp(buffer).metadata();

  const w = metadata.width;
  const h = metadata.height;

  if (!w || !h) {
    return { valid: false, error: "Invalid or unreadable image for at least one image." };
  }

  // Rule #1: Minimum dimensions 700×700
  if (w < 700 || h < 700) {
    return { valid: false, error: "Images must be at least 700px in width and height - please only select better images. No images were uploaded." };
  }

  // Rule #2: Extreme aspect ratio rejection
  const ratio = w / h;
  if (ratio > 3 || ratio < 1/3) {
    return { valid: false, error: "Image aspect ratio is too extreme (panorama or ultra-vertical). Upload a normal photo. No images were uploaded." };
  }

  // Rule #3: File size check (extra safeguard — multer already enforces 10MB)
  if (buffer.length > 10 * 1024 * 1024) {
    return { valid: false, error: "Image file size exceeds 10MB." };
  }

  return { valid: true };
}

// Func to add uploaded media to user's history
async function addUserUploadEntry({
  userId,
  mediaType,
  mediaId,
  cloudinaryUrl,
  youtubeUrl,
  cloudinaryId,

  park,
  target,         // campsite or park
  campgroundSlug,
  campsiteSlug,

  caption,
  dateTaken
}) {
  const campground = campgroundSlug
    ? park.campgrounds.find(cg => cg.slug === campgroundSlug)
    : null;

  const campsite = campsiteSlug
    ? (campground 
        ? campground.campsites.find(cs => cs.slug === campsiteSlug)
        : (park.campsites?.find(cs => cs.slug === campsiteSlug)))
    : null;

  await User.findByIdAndUpdate(
    userId,
    {
      $push: {
        uploads: {
          mediaType,
          mediaId,

          cloudinaryUrl: cloudinaryUrl || null,
          youtubeUrl: youtubeUrl || null,
          cloudinaryId: cloudinaryId || null,

          parkId: park._id,
          parkSlug: park.slug,
          parkName: park.name,

          campgroundId: campground?._id || null,
          campgroundSlug: campground?.slug || null,
          campgroundName: campground?.name || null,

          campsiteId: campsite?._id || null,
          campsiteSlug: campsite?.slug || null,
          campsiteName: campsite?.siteNumber || null,

          caption,
          dateTaken
        }
      }
    }
  );
}

// Func to check if day is not from future
export function isValidNonFutureDate(dateStr) {
  if (!dateStr) return true; 
  
  const submitted = new Date(dateStr);
  if (isNaN(submitted)) return false; // invalid date format

  const now = Date.now();
  const oneHoursMs = 1 * 60 * 60 * 1000;

  // If submitted UTC timestamp > now + 24 hours → invalid
  if (submitted.getTime() > now + oneHoursMs) {
    return false;
  }

  return true;
}


export const uploadPhoto = async (req, res, next) => {
  const uploadedCloudinary = [];
  const createdUploads = [];
  let park, target;

  const { parkSlug, campgroundSlug, campsiteSlug } = req.params;
  const userId = req.user._id;

  if (!parkSlug || !userId) {
    return res.status(400).json({ error: 'Missing data.' });
  }

  try {
    if (!req.is("multipart/form-data")) {
      return res.status(400).json({ error: "Invalid form submission." });
    }
    // // Parse multipart form before anything else
    // await new Promise((resolve, reject) => {
    //   uploadMemory.array('photos', 5)(req, res, (err) => {
    //     if (err) reject(err);
    //     else resolve();
    //   });
    // });
    await new Promise((resolve) => {
      uploadMemory.array('photos', 5)(req, res, (err) => {
        if (!err) return resolve();

        // HANDLE MULTER ERRORS HERE
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: "Each file must be under 10MB.",
            message: "Each file must be under 10MB.",
          });
          return;
        }

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          res.status(400).json({
            error: "Too many files uploaded.",
            message: "Too many files uploaded.",
          });
          return;
        }

        // Any other Multer error
        res.status(400).json({
          error: "UPLOAD_ERROR",
          message: err.message,
        });
      });
    });

    // STOP EXECUTION IF RESPONSE WAS SENT
    if (res.headersSent) return;


    // Fields and files are now accessible
    if (!req.body.dateTaken) {
      return res.status(400).json({ error: 'Please note when the photo(s) were taken.' });
    }

    // If date is after today + 1 (future)
    if(!isValidNonFutureDate(req.body.dateTaken)){
      return res.status(400).json({ error: 'Date cannot be in the future.' });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    // Find park and determine target
    park = await Park.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    let limit = 0
    if (campsiteSlug) {
      target = findCampsite(park, campsiteSlug);
      if (!target) return res.status(404).json({ error: 'Campsite not found' });
      limit = 5 // Max 5 pics per campsite
    } else {
      target = park;
      limit = 2; // Max 2 pics per park
    }

    // Check user’s remaining quota
    const userCount = target.photos.filter(p => p.user.equals(userId)).length;
    const remaining = limit - userCount;

    if (remaining <= 0) {
      return res.status(400).json({
        error: `You have already uploaded ${userCount} photos for this ${campsiteSlug ? 'campsite' : 'park'}.`,
        remaining: 0,
      });
    }

    // Validate all files BEFORE uploading anything
    for (const file of files) {
      const result = await validateImageBuffer(file.buffer);
      if (!result.valid) {
        return res.status(400).json({ error: result.error });
      }
    }

    // Now safe to enforce user limits
    const allowedFiles = files.slice(0, remaining);

    const skippedCount = files.length - allowedFiles.length;
    const uploadedPhotos = [];

    // Upload each allowed file to Cloudinary
    for (const file of allowedFiles) {

      const watermarkText = 'CampPics.ca';
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: 'camp-parks',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            transformation: [
              { width: 1500, height: 1500, crop: 'limit' },
              //////// Bottom-right corner
              // {
              //   overlay: {
              //     font_family: 'Arial',
              //     font_size: 32,
              //     font_weight: 'bold',
              //     text: watermarkText,
              //     stroke: '2px_black'
              //   },
              //   flags: 'relative',
              //   gravity: 'south_east',
              //   width: 0.4,
              //   x: 0.01,
              //   y: 0.01,
              //   color: '#FFFFFF',
              //   opacity: 90,
              // },
              /////// Centered
              {
                overlay: {
                  font_family: "Arial",
                  font_size: 80,
                  font_weight: "bold",
                  text: watermarkText
                },
                gravity: "center",          // centered on the image
                opacity: 60,                
                color: "#FFFFFF",           // white text
                flags: "relative",
              },
              
            ],
          },
          (error, result) => error ? reject(error) : resolve(result)
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });

      uploadedCloudinary.push(extractCloudinaryId(uploadResult.secure_url)); // used to be: 

      uploadedPhotos.push({
        user: userId,
        url: uploadResult.secure_url,
        caption: req.body.caption || '',
        showUsername: req.body.showUsername === 'true' || req.body.showUsername === true,
        username: req.body.showUsername ? req.user.fname : null,
        dateTaken: req.body.dateTaken || new Date(),
      });
    }

    // Save to Mongo
    target.photos.push(...uploadedPhotos);
    await park.save();

    // Update park's Updated Time
    await Park.findByIdAndUpdate(park._id, { updatedAt: new Date() });

    // Find the just-saved photo subdocs by matching URLs
    const justAdded = target.photos.filter(p =>
      uploadedPhotos.some(up => up.url === p.url)
    );

    // Add Upload records
    for (const photo of justAdded) {
      const campsiteId = campsiteSlug ? target._id : null;
      const campgroundId = campgroundSlug
        ? park.campgrounds.find(cg => cg.slug === campgroundSlug)?._id
        : null;

      await Upload.create({
        mediaType: 'photo',
        mediaId: photo._id, // now guaranteed to exist
        cloudinaryId: photo.url,
        parkId: park._id,
        parkName: park?.name,
        campgroundId,
        campgroundName: park.campgrounds.find(cg => cg._id.equals(campgroundId))?.name || null,
        campsiteId,
        campsiteName: target?.siteNumber || null,
        userId,
      });
    }

    // Add upload record to the User document
    for (const photo of justAdded) {
      await addUserUploadEntry({
        userId,
        mediaType: "photo",
        mediaId: photo._id,
        cloudinaryUrl: photo.url,
        cloudinaryId: extractCloudinaryId(photo.url),

        park,
        target,
        campgroundSlug,
        campsiteSlug,

        caption: photo.caption,
        dateTaken: photo.dateTaken
      });
    }


    const pluralize = (n, word) => (n === 1 ? word : `${word}s`);
    const message =
      skippedCount > 0
        ? `Only ${uploadedPhotos.length} ${pluralize(uploadedPhotos.length, 'photo')} uploaded — limit reached.`
        : `${uploadedPhotos.length} ${pluralize(uploadedPhotos.length, 'photo')} uploaded successfully.`;

    return res.json({
      success: true,
      added: uploadedPhotos.length,
      skipped: skippedCount,
      remaining: Math.max(0, limit - (userCount + uploadedPhotos.length)),
      message,
    });
  } catch (err) {
  console.error(err);

  // Cleanup (safe)
  if (createdUploads.length) {
    await Upload.deleteMany({ _id: { $in: createdUploads } });
  }

  await Promise.all(
    uploadedCloudinary.map(id =>
      cloudinary.uploader.destroy(id).catch(() => null)
    )
  );

  if (park && target) {
    const toRemove = uploadedCloudinary.map(id => `/${id}`);
    target.photos = target.photos.filter(
      p => !toRemove.some(r => p.url.includes(r))
    );
    await park.save().catch(() => null);
  }

  // ALWAYS RESPOND JSON
  return res.status(500).json({
    error: "UPLOAD_FAILED",
    message: "Upload failed. Please try again.",
  });
}

};


export const addVideo = async (req, res, next) => {
  const { parkSlug, campgroundSlug, campsiteSlug } = req.params;
  const rawUrl = req.body.url?.trim();
  const caption = req.body.caption || '';
  const showUsername = req.body.showUsername
  const username = showUsername ? req.user.fname : null
  const dateTaken = req.body.dateTaken
  const userId = req.user._id
  const createdUploads = []; // in case of error catching
  let park, target;

  if(!parkSlug, !campsiteSlug, !userId, !dateTaken ){
    return res.status(400).json({ error: 'Missing data.' });
  }

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/|shorts\/)?[A-Za-z0-9_-]{11}/;
  if (!ytRegex.test(rawUrl)) {
    return res.status(400).json({ error: 'Only valid YouTube links are allowed.' });
  }

  const video = { user: req.user._id, url: rawUrl, caption, showUsername, username, dateTaken };

  // If date is after today + 1 (future)
  if(!isValidNonFutureDate(req.body.dateTaken)){
    return res.status(400).json({ error: 'Date cannot be in the future.' });
  }

  try {
    park = await Park.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    target;
    if (campsiteSlug) {
      target = findCampsite(park, campsiteSlug);
      if (!target) return res.status(404).json({ error: 'Campsite not found' });
    } else {
      target = park;
    }

    // Limit per user: 2 videos max
    const userVidCount = target.videos.filter(v => v.user.equals(req.user._id)).length;
    if (userVidCount >= 2) {
      return res.status(400).json({ error: `Maximum of 2 YouTube videos allowed per user per ${campsiteSlug ? 'campsite' : 'park'}.` });
    }

    target.videos.push(video);
    await park.save();

    // UPDATE PARK UPDATED TIME
    await Park.findByIdAndUpdate(park._id, { updatedAt: new Date() });

    const addedVideo = target.videos.find(v => v.url === rawUrl && v.user.equals(userId));

    await addUserUploadEntry({
      userId,
      mediaType: "video",
      mediaId: addedVideo._id,

      youtubeUrl: rawUrl,
      cloudinaryUrl: null,
      cloudinaryId: null,

      park,
      target,
      campgroundSlug,
      campsiteSlug,

      caption: caption,
      dateTaken: dateTaken
    });


    // Add photos to Mongo Upload modal
    const campsiteId = campsiteSlug ? target._id : null;
    const campgroundId = campgroundSlug ? park.campgrounds.find(cg => cg.slug === campgroundSlug)?._id : null;
    // Find the newly added video
    try {
      const uploadDoc = await Upload.create({
        mediaType: 'video',
        mediaId: addedVideo._id,
        youtubeId: video.url,
        parkId: park._id,
        parkName: park?.name,
        campgroundId,
        campgroundName: park.campgrounds.find(cg => cg._id.equals(campgroundId))?.name || null,
        campsiteId,
        campsiteName: target?.siteNumber,
        userId,
      });
      
      createdUploads.push(uploadDoc._id); // in case of error
    } catch (err) {
      // rollback newly pushed video if Upload doc creation fails
      target.videos = target.videos.filter(v => !v._id.equals(addedVideo._id));
      await park.save().catch(() => null);
      throw err;
    }
    

    return res.json({ success: true, addedVideo });
  } catch (err) {
    if (createdUploads.length) {
      await Upload.deleteMany({ _id: { $in: createdUploads } });
    }
    next(err);
  }
};



// export const addReview = async (req, res, next) => {
//   const { parkSlug, campsiteSlug } = req.params;
//   const review = {
//     user: req.user._id,
//     rating: req.body.rating,
//     text: req.body.text.trim()
//   };

//   try {
//     const park = await Park.findOne({ slug: parkSlug });
//     if (!park) return res.status(404).json({ error: 'Park not found' });

//     let target;
//     if (campsiteSlug) {
//       target = findCampsite(park, campsiteSlug);
//       if (!target) return res.status(404).json({ error: 'Campsite not found' });
//     } else {
//       target = park;
//     }

//     target.reviews.push(review);
//     await park.save();

//     res.json({ success: true, review });
//   } catch (err) {
//     next(err);
//   }
// };


// Func to find campsite
function findCampsite(park, campsiteSlug) {
  // Check within campgrounds
  for (const cg of park.campgrounds || []) {
    const found = cg.campsites.find(cs => cs.slug === campsiteSlug);
    if (found) return found;
  }

  // Check park-level campsites (standalone)
  return (park.campsites || []).find(cs => cs.slug === campsiteSlug);
}



export const deletePhoto = async (req, res, next) => {
  const { parkSlug, campsiteSlug, photoId } = req.params;
  try {
    const park = await Park.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    const target = campsiteSlug ? findCampsite(park, campsiteSlug) : park;
    if (!target) return res.status(404).json({ error: 'Target not found' });

    const photo = target.photos.find(p => p._id.toString() === photoId);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    // Permission check
    if (!photo.user.equals(req.user._id) && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Not authorized to delete this photo' });
    }

    // Delete from Cloudinary first..
    let deletionResult;
    try {
      // Extract Cloudinary public_id from full URL
      const match = photo.url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
      if (!match || !match[1]) {
        return res.status(400).json({ error: 'Invalid Cloudinary URL format.' });
      }
      const publicId = match[1]; // everything after "upload/" and before ".ext"

      // Request deletion
      deletionResult = await cloudinary.uploader.destroy(publicId);
    } catch (err) {
      console.error('Cloudinary deletion failed:', err);
      return res.status(500).json({ error: 'Failed to contact Cloudinary.' });
    }

    // Verify Cloudinary response
    if (deletionResult.result !== 'ok' && deletionResult.result !== 'not found') {
      // If Cloudinary explicitly says "error" or unknown result
      console.error('Unexpected Cloudinary response:', deletionResult);
      return res.status(500).json({ error: 'Cloudinary deletion unsuccessful.' });
    }

    // Delete from Mongo
    target.photos = target.photos.filter(p => p._id.toString() !== photoId);
    await park.save();

    // Remove from Upload collection
    await Upload.deleteOne({ mediaType: 'photo', mediaId: photo._id });

    const ownerId = photo.user;  // In case admin deletes it
    await User.updateOne(
      { _id: ownerId, "uploads.mediaId": photo._id },
      { $set: { "uploads.$.status": "removed" } }
    );

    return res.json({ success: true, cloudinaryResult: deletionResult.result });
  } catch (err) {
    next(err);
  }
};



export const deleteVideo = async (req, res, next) => {
  const { parkSlug, campsiteSlug, videoId } = req.params;
  try {
    const park = await Park.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    const target = campsiteSlug ? findCampsite(park, campsiteSlug) : park;
    if (!target) return res.status(404).json({ error: 'Target not found' });

    const video = target.videos.find(v => v._id.toString() === videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Permission check
    if (!video.user.equals(req.user._id) && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Not authorized to delete this video' });
    }

    // Remove the video manually
    target.videos = target.videos.filter(v => v._id.toString() !== videoId);

    await park.save();

    // Remove from Upload model
    await Upload.deleteOne({ mediaType: 'video', mediaId: video._id });

    const ownerId = video.user; // In case admin deletes it
    await User.updateOne(
      { _id: ownerId, "uploads.mediaId": video._id },
      { $set: { "uploads.$.status": "removed" } }
    );



    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

