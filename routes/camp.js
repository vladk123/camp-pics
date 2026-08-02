import express from "express";
const router = express.Router();
import * as camp from '../controllers/camp.js';
import * as media from '../controllers/media.js';
import { isLoggedIn, catchAsyncErrors, uploadMemory } from '../middleware.js'; //
import {
  campsiteApiLimiter,
  mediaDeletionLimiter,
  parkMediaApiLimiter,
  parkSearchApiLimiter,
  photoUploadLimiter,
  videoUploadLimiter,
} from '../utils/routeAbuseLimits.js';
import { loadCache } from '../controllers/camp.js'

router.route('/search-api')
    .get(parkSearchApiLimiter, camp.searchApi)

router.route('/search')
    .get(camp.searchResults)

router.route('/all-parks')
    .get(camp.showAllParks)

router.route('/park/:parkSlug')
    .get(camp.showPark)

// API Routes
// Get a park
router.route('/park/:parkSlug/media')
    .get(parkMediaApiLimiter, camp.getPark)
// If it's a park with no campgrounds
router.route('/park/:parkSlug/campsite/:campsiteSlug')
    .get(campsiteApiLimiter, camp.getCampsite)
// If it's a park with campgrounds
router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug')
    .get(campsiteApiLimiter, camp.getCampgroundCampsite)


// Upload Routes
// Park-level
router.route('/park/:parkSlug/photo')
    .post(isLoggedIn, photoUploadLimiter, catchAsyncErrors(media.uploadPhoto));
router.route('/park/:parkSlug/video')
    .post(isLoggedIn, videoUploadLimiter, catchAsyncErrors(media.addVideo));
// router.route('/park/:parkSlug/review')
//     .post(isLoggedIn, media.addReview);

// Campsite level
router.route('/park/:parkSlug/campsite/:campsiteSlug/photo')
    .post(isLoggedIn, photoUploadLimiter, catchAsyncErrors(media.uploadPhoto));
router.route('/park/:parkSlug/campsite/:campsiteSlug/video')
    .post(isLoggedIn, videoUploadLimiter, catchAsyncErrors(media.addVideo));
router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo')
    .post(isLoggedIn, photoUploadLimiter, catchAsyncErrors(media.uploadPhoto));
router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video')
    .post(isLoggedIn, videoUploadLimiter, catchAsyncErrors(media.addVideo));
// router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/review')
//     .post(isLoggedIn, media.addReview);


// DELETE ROUTES
// Delete - Park-level
router.route('/park/:parkSlug/photo/:photoId')
  .delete(isLoggedIn, mediaDeletionLimiter, media.deletePhoto);

router.route('/park/:parkSlug/video/:videoId')
  .delete(isLoggedIn, mediaDeletionLimiter, media.deleteVideo);

// Delete - Campsite-level
router.route('/park/:parkSlug/campsite/:campsiteSlug/photo/:photoId')
  .delete(isLoggedIn, mediaDeletionLimiter, media.deletePhoto);

router.route('/park/:parkSlug/campsite/:campsiteSlug/video/:videoId')
  .delete(isLoggedIn, mediaDeletionLimiter, media.deleteVideo);

router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo/:photoId')
  .delete(isLoggedIn, mediaDeletionLimiter, media.deletePhoto);

router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video/:videoId')
  .delete(isLoggedIn, mediaDeletionLimiter, media.deleteVideo);



export default router
