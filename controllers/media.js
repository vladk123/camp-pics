import { Park } from '../models/park.js';
import { Upload } from '../models/upload.js';
import { User } from "../models/user.js"; // ensure correct path
// import cloudinary from '../config/cloudinary.js';
import { uploadMemory } from '../middleware.js'; //
import { v2 as cloudinary } from 'cloudinary';
import mongoose from 'mongoose';
import streamifier from 'streamifier';
import sharp from "sharp";
import { extractYouTubeVideoId } from '../utils/youtube.js';
import {
  normalizeCloudinaryPublicId,
  parseCloudinaryDeliveryUrl,
  resolveCloudinaryPhotoIdentity,
} from '../utils/cloudinaryPhotoIdentity.js';
import {
  resolveCampsiteTarget,
  sendCampsiteTargetError,
} from '../utils/campsiteTarget.js';
import {
  MEDIA_PERSISTENCE_FAILED,
  MEDIA_QUOTA_CHANGED,
  MEDIA_TARGET_CHANGED,
  MEDIA_TRANSACTION_UNAVAILABLE,
  MEDIA_UPLOADER_NOT_FOUND,
  createMediaPersistenceService,
} from '../utils/mediaPersistence.js';

export const PHOTO_UPLOAD_CLEANUP_INCOMPLETE =
  'PHOTO_UPLOAD_CLEANUP_INCOMPLETE';

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

function resolveMediaLocation(park, { campgroundSlug, campsiteSlug }) {
  if (campgroundSlug == null && campsiteSlug == null) return null;
  return resolveCampsiteTarget(park, { campgroundSlug, campsiteSlug });
}

function idsEqual(left, right) {
  if (left == null || right == null) return false;
  if (typeof left.equals === 'function') return left.equals(right);
  if (typeof right.equals === 'function') return right.equals(left);
  return left.toString() === right.toString();
}

function countUserMedia(items, userId) {
  if (!Array.isArray(items)) return 0;
  return items.reduce(
    (count, item) => count + (idsEqual(item?.user, userId) ? 1 : 0),
    0,
  );
}

function mediaPersistenceResponse(error) {
  const responses = {
    [MEDIA_QUOTA_CHANGED]: {
      status: 409,
      message: 'Upload capacity changed. Refresh and try again.',
    },
    [MEDIA_TARGET_CHANGED]: {
      status: 409,
      message: 'The upload location changed. Refresh and try again.',
    },
    [MEDIA_UPLOADER_NOT_FOUND]: {
      status: 409,
      message: 'Your account changed before the upload completed.',
    },
    [MEDIA_TRANSACTION_UNAVAILABLE]: {
      status: 503,
      message: 'Uploads are temporarily unavailable. Please try again later.',
    },
    [MEDIA_PERSISTENCE_FAILED]: {
      status: 500,
      message: 'Upload failed. Please try again.',
    },
  };
  const code = Object.hasOwn(responses, error?.code)
    ? error.code
    : MEDIA_PERSISTENCE_FAILED;
  return { code, ...responses[code] };
}

function sendMediaPersistenceError(res, error) {
  const response = mediaPersistenceResponse(error);
  return res.status(response.status).json({
    error: response.message,
    code: response.code,
  });
}

async function cleanupPhotoAssets(cloudinaryClient, uploadedAssets) {
  const failures = [];
  for (const asset of uploadedAssets) {
    try {
      const result = await cloudinaryClient.uploader.destroy(asset.publicId);
      if (result?.result !== 'ok' && result?.result !== 'not found') {
        failures.push(asset.mediaId);
      }
    } catch {
      failures.push(asset.mediaId);
    }
  }
  return failures;
}

async function sendPhotoFailureAfterCleanup({
  res,
  cloudinaryClient,
  uploadedAssets,
  persistenceError = null,
}) {
  const cleanupFailures = await cleanupPhotoAssets(
    cloudinaryClient,
    uploadedAssets,
  );
  if (cleanupFailures.length > 0) {
    console.error('Photo upload cleanup incomplete', {
      failureCount: cleanupFailures.length,
      mediaIds: cleanupFailures.map(id => id.toString()),
    });
    return res.status(500).json({
      error: 'Upload failed and photo cleanup is incomplete.',
      code: PHOTO_UPLOAD_CLEANUP_INCOMPLETE,
    });
  }

  if (persistenceError) {
    return sendMediaPersistenceError(res, persistenceError);
  }
  return res.status(500).json({
    error: 'UPLOAD_FAILED',
    message: 'Upload failed. Please try again.',
  });
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


async function uploadPhotoHandler(req, res, next, dependencies) {
  const {
    ParkModel,
    cloudinaryClient,
    uploadMiddleware,
    validateImage,
    mediaPersistence,
  } = dependencies;
  const uploadedCloudinary = [];
  let allowedFiles;
  let skippedCount;
  let limit;

  const { parkSlug, campgroundSlug, campsiteSlug } = req.params;
  const userId = req.user._id;

  if (!parkSlug || !userId) {
    return res.status(400).json({ error: 'Missing data.' });
  }
  if (campgroundSlug != null && campsiteSlug == null) {
    return res.status(400).json({
      error: 'Invalid campsite location.',
      code: 'CONTRADICTORY_LOCATION',
    });
  }

  // Phase A: request parsing, validation and initial quota preflight.
  try {
    if (!req.is("multipart/form-data")) {
      return res.status(400).json({ error: "Invalid form submission." });
    }
    await new Promise((resolve) => {
      uploadMiddleware.array('photos', 5)(req, res, (err) => {
        if (!err) return resolve();

        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: "Each file must be under 10MB.",
            message: "Each file must be under 10MB.",
          });
        } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
          res.status(400).json({
            error: "Too many files uploaded.",
            message: "Too many files uploaded.",
          });
        } else {
          res.status(400).json({
            error: "UPLOAD_ERROR",
            message: "The upload form could not be processed.",
          });
        }
        resolve();
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
    const park = await ParkModel.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    let target;
    if (campsiteSlug) {
      let location;
      try {
        location = resolveMediaLocation(park, { campgroundSlug, campsiteSlug });
      } catch (error) {
        if (sendCampsiteTargetError(res, error)) return;
        throw error;
      }
      target = location.target;
      limit = 5 // Max 5 pics per campsite
    } else {
      target = park;
      limit = 2; // Max 2 pics per park
    }

    // Check user’s remaining quota
    const userCount = countUserMedia(target.photos, userId);
    const remaining = limit - userCount;

    if (remaining <= 0) {
      return res.status(400).json({
        error: `You have already uploaded ${userCount} photos for this ${campsiteSlug ? 'campsite' : 'park'}.`,
        remaining: 0,
      });
    }

    // Validate all files BEFORE uploading anything
    for (const file of files) {
      const result = await validateImage(file.buffer);
      if (!result.valid) {
        return res.status(400).json({ error: result.error });
      }
    }

    allowedFiles = files.slice(0, remaining);
    skippedCount = files.length - allowedFiles.length;
  } catch {
    return res.status(500).json({
      error: "UPLOAD_FAILED",
      message: "Upload failed. Please try again.",
    });
  }

  // Phase B: Cloudinary preparation with exact captured identities.
  const preparedPhotos = [];
  const showUsername =
    req.body.showUsername === 'true' || req.body.showUsername === true;
  try {
    for (const file of allowedFiles) {
      const mediaId = new mongoose.Types.ObjectId();

      const watermarkText = 'CampPics.ca';
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinaryClient.uploader.upload_stream(
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

      const cloudinaryPublicId = normalizeCloudinaryPublicId(
        uploadResult?.public_id,
      );
      if (!cloudinaryPublicId) {
        throw new Error('Cloudinary upload returned an invalid public ID');
      }

      const uploadedAsset = {
        mediaId,
        publicId: cloudinaryPublicId,
      };
      uploadedCloudinary.push(uploadedAsset);

      const cloudinaryUrl = typeof uploadResult?.secure_url === 'string'
        ? uploadResult.secure_url.trim()
        : '';
      const parsedDeliveryUrl = parseCloudinaryDeliveryUrl(cloudinaryUrl);
      if (
        !cloudinaryUrl ||
        !parsedDeliveryUrl ||
        !cloudinaryUrl.toLowerCase().startsWith('https://') ||
        parsedDeliveryUrl.publicId !== cloudinaryPublicId
      ) {
        throw new Error('Cloudinary upload returned an invalid secure URL');
      }

      preparedPhotos.push(Object.freeze({
        mediaId,
        uploadId: new mongoose.Types.ObjectId(),
        cloudinaryUrl,
        cloudinaryPublicId,
        caption: req.body.caption || '',
        showUsername,
        username: showUsername ? req.user.fname : null,
        dateTaken: req.body.dateTaken || new Date(),
      }));
    }
  } catch {
    return sendPhotoFailureAfterCleanup({
      res,
      cloudinaryClient,
      uploadedAssets: uploadedCloudinary,
    });
  }

  // Phase C: commit every MongoDB representation in one transaction.
  let committed;
  try {
    committed = await mediaPersistence.commitMediaCreation({
      parkSlug,
      locationInput: {
        campgroundSlug,
        campsiteSlug,
      },
      userId,
      mediaType: 'photo',
      preparedMedia: Object.freeze(preparedPhotos),
    });
  } catch (error) {
    // Phase D: MongoDB aborted; remove only this request's captured assets.
    return sendPhotoFailureAfterCleanup({
      res,
      cloudinaryClient,
      uploadedAssets: uploadedCloudinary,
      persistenceError: error,
    });
  }

  // Phase E: the rollback boundary ended when the transaction committed.
  const pluralize = (n, word) => (n === 1 ? word : `${word}s`);
  const message =
    skippedCount > 0
      ? `Only ${preparedPhotos.length} ${pluralize(preparedPhotos.length, 'photo')} uploaded — limit reached.`
      : `${preparedPhotos.length} ${pluralize(preparedPhotos.length, 'photo')} uploaded successfully.`;

  try {
    return res.json({
      success: true,
      added: preparedPhotos.length,
      skipped: skippedCount,
      remaining: committed.remaining,
      message,
    });
  } catch (error) {
    return next(error);
  }
}


async function addVideoHandler(req, res, next, dependencies) {
  const {
    ParkModel,
    mediaPersistence,
  } = dependencies;
  const { parkSlug, campgroundSlug, campsiteSlug } = req.params;
  const rawUrl = req.body?.url?.trim();
  const caption = req.body?.caption || '';
  const showUsername =
    req.body?.showUsername === 'true' || req.body?.showUsername === true;
  const username = showUsername ? req.user.fname : null
  const dateTaken = req.body?.dateTaken
  const userId = req.user._id

  if (!parkSlug || !userId || !dateTaken || !rawUrl) {
    return res.status(400).json({ error: 'Missing data.' });
  }
  if (campgroundSlug != null && campsiteSlug == null) {
    return res.status(400).json({
      error: 'Invalid campsite location.',
      code: 'CONTRADICTORY_LOCATION',
    });
  }

  if (!extractYouTubeVideoId(rawUrl)) {
    return res.status(400).json({ error: 'Only valid YouTube links are allowed.' });
  }

  // If date is after today + 1 (future)
  if(!isValidNonFutureDate(dateTaken)){
    return res.status(400).json({ error: 'Date cannot be in the future.' });
  }

  // Preserve the current preflight before the fresh transactional recheck.
  try {
    const park = await ParkModel.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    let target;
    if (campsiteSlug) {
      let location;
      try {
        location = resolveMediaLocation(park, { campgroundSlug, campsiteSlug });
      } catch (error) {
        if (sendCampsiteTargetError(res, error)) return;
        throw error;
      }
      target = location.target;
    } else {
      target = park;
    }

    // Limit per user: 2 videos max
    const userVidCount = countUserMedia(target.videos, userId);
    if (userVidCount >= 2) {
      return res.status(400).json({ error: `Maximum of 2 YouTube videos allowed per user per ${campsiteSlug ? 'campsite' : 'park'}.` });
    }
  } catch (error) {
    return sendMediaPersistenceError(res, error);
  }

  const mediaId = new mongoose.Types.ObjectId();
  const preparedVideo = Object.freeze({
    mediaId,
    uploadId: new mongoose.Types.ObjectId(),
    youtubeUrl: rawUrl,
    caption,
    showUsername,
    username,
    dateTaken,
  });

  try {
    await mediaPersistence.commitMediaCreation({
      parkSlug,
      locationInput: {
        campgroundSlug,
        campsiteSlug,
      },
      userId,
      mediaType: 'video',
      preparedMedia: Object.freeze([preparedVideo]),
    });
  } catch (error) {
    return sendMediaPersistenceError(res, error);
  }

  const addedVideo = {
    _id: mediaId,
    user: userId,
    url: rawUrl,
    caption,
    showUsername,
    username,
    dateTaken,
  };
  try {
    return res.json({ success: true, addedVideo });
  } catch (error) {
    return next(error);
  }
}

async function deletePhotoHandler(req, res, next, dependencies) {
  const {
    ParkModel,
    UploadModel,
    UserModel,
    cloudinaryClient,
  } = dependencies;
  const { parkSlug, campgroundSlug, campsiteSlug, photoId } = req.params;

  if (campgroundSlug != null && campsiteSlug == null) {
    return res.status(400).json({
      error: 'Invalid campsite location.',
      code: 'CONTRADICTORY_LOCATION',
    });
  }

  try {
    const park = await ParkModel.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    let location = null;
    if (campsiteSlug) {
      try {
        location = resolveMediaLocation(park, { campgroundSlug, campsiteSlug });
      } catch (error) {
        if (sendCampsiteTargetError(res, error)) return;
        throw error;
      }
    }
    const target = location?.target || park;

    const photo = target.photos.find(p => p._id.toString() === photoId);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    // Permission check
    if (!photo.user.equals(req.user._id) && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Not authorized to delete this photo' });
    }

    const uploadRecord = await UploadModel.findOne({
      mediaType: 'photo',
      mediaId: photo._id,
    });
    const identity = resolveCloudinaryPhotoIdentity({
      photo,
      upload: uploadRecord,
    });

    if (identity.conflict) {
      return res.status(409).json({
        error: 'Photo identity conflict.',
        code: 'CLOUDINARY_IDENTITY_CONFLICT',
      });
    }
    if (!identity.publicId) {
      return res.status(409).json({
        error: 'Photo identity could not be resolved.',
        code: 'PHOTO_IDENTITY_UNRESOLVED',
      });
    }

    // Delete from Cloudinary first..
    let deletionResult;
    try {
      deletionResult = await cloudinaryClient.uploader.destroy(
        identity.publicId,
      );
    } catch (err) {
      console.error('Cloudinary deletion failed:', err);
      return res.status(500).json({ error: 'Failed to contact Cloudinary.' });
    }

    // Verify Cloudinary response
    if (deletionResult.result !== 'ok' && deletionResult.result !== 'not found') {
      // If Cloudinary explicitly says "error" or unknown result
      console.error('Unexpected Cloudinary photo deletion response');
      return res.status(500).json({ error: 'Cloudinary deletion unsuccessful.' });
    }

    // Delete from Mongo
    target.photos = target.photos.filter(p => p._id.toString() !== photoId);
    await park.save();

    // Remove from Upload collection
    await UploadModel.deleteOne({ mediaType: 'photo', mediaId: photo._id });

    const ownerId = photo.user;  // In case admin deletes it
    await UserModel.updateOne(
      { _id: ownerId, "uploads.mediaId": photo._id },
      { $set: { "uploads.$.status": "removed" } }
    );

    return res.json({ success: true, cloudinaryResult: deletionResult.result });
  } catch (err) {
    next(err);
  }
}



async function deleteVideoHandler(req, res, next, dependencies) {
  const {
    ParkModel,
    UploadModel,
    UserModel,
  } = dependencies;
  const { parkSlug, campgroundSlug, campsiteSlug, videoId } = req.params;

  if (campgroundSlug != null && campsiteSlug == null) {
    return res.status(400).json({
      error: 'Invalid campsite location.',
      code: 'CONTRADICTORY_LOCATION',
    });
  }

  try {
    const park = await ParkModel.findOne({ slug: parkSlug });
    if (!park) return res.status(404).json({ error: 'Park not found' });

    let location = null;
    if (campsiteSlug) {
      try {
        location = resolveMediaLocation(park, { campgroundSlug, campsiteSlug });
      } catch (error) {
        if (sendCampsiteTargetError(res, error)) return;
        throw error;
      }
    }
    const target = location?.target || park;

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
    await UploadModel.deleteOne({ mediaType: 'video', mediaId: video._id });

    const ownerId = video.user; // In case admin deletes it
    await UserModel.updateOne(
      { _id: ownerId, "uploads.mediaId": video._id },
      { $set: { "uploads.$.status": "removed" } }
    );



    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export function createMediaHandlers(overrides = {}) {
  const ParkModel = overrides.ParkModel || Park;
  const UploadModel = overrides.UploadModel || Upload;
  const UserModel = overrides.UserModel || User;
  const dependencies = {
    ParkModel,
    UploadModel,
    UserModel,
    cloudinaryClient: overrides.cloudinaryClient || cloudinary,
    uploadMiddleware: overrides.uploadMiddleware || uploadMemory,
    validateImage: overrides.validateImage || validateImageBuffer,
    mediaPersistence: overrides.mediaPersistence ||
      createMediaPersistenceService({
        ParkModel,
        UploadModel,
        UserModel,
        transactionRunner: overrides.transactionRunner,
      }),
  };

  return {
    uploadPhoto: (req, res, next) =>
      uploadPhotoHandler(req, res, next, dependencies),
    addVideo: (req, res, next) =>
      addVideoHandler(req, res, next, dependencies),
    deletePhoto: (req, res, next) =>
      deletePhotoHandler(req, res, next, dependencies),
    deleteVideo: (req, res, next) =>
      deleteVideoHandler(req, res, next, dependencies),
  };
}

const mediaHandlers = createMediaHandlers();

export const uploadPhoto = mediaHandlers.uploadPhoto;
export const addVideo = mediaHandlers.addVideo;
export const deletePhoto = mediaHandlers.deletePhoto;
export const deleteVideo = mediaHandlers.deleteVideo;

