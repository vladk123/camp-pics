import express from "express";
const router = express.Router();
import * as camp from '../controllers/camp.js';
import * as media from '../controllers/media.js';
import { isLoggedIn, catchAsyncErrors, uploadMemory } from '../middleware.js'; //
import { loadCache } from '../controllers/camp.js'

router.route('/search-api')
    .get(camp.searchApi)

router.route('/search')
    .get(camp.searchResults)

router.route('/all-parks')
    .get(camp.showAllParks)

router.route('/park/:parkSlug')
    .get(camp.showPark)

// API Routes
// Get a park
router.route('/park/:parkSlug/media')
    .get(camp.getPark)
// If it's a park with no campgrounds
router.route('/park/:parkSlug/campsite/:campsiteSlug')
    .get(camp.getCampsite)
// If it's a park with campgrounds
router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug')
    .get(camp.getCampgroundCampsite)


// Upload Routes
// Park-level
router.route('/park/:parkSlug/photo')
    .post(isLoggedIn, catchAsyncErrors(media.uploadPhoto));
router.route('/park/:parkSlug/video')
    .post(isLoggedIn, catchAsyncErrors(media.addVideo));
// router.route('/park/:parkSlug/review')
//     .post(isLoggedIn, media.addReview);

// Campsite level
router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo')
    .post(isLoggedIn, catchAsyncErrors(media.uploadPhoto));
router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video')
    .post(isLoggedIn, catchAsyncErrors(media.addVideo));
// router.route('/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/review')
//     .post(isLoggedIn, media.addReview);


// DELETE ROUTES
// Delete - Park-level
router.route('/park/:parkSlug/photo/:photoId')
  .delete(isLoggedIn, media.deletePhoto);

router.route('/park/:parkSlug/video/:videoId')
  .delete(isLoggedIn, media.deleteVideo);

// Delete - Campsite-level
router.route('/park/:parkSlug/campsite/:campsiteSlug/photo/:photoId')
  .delete(isLoggedIn, media.deletePhoto);

router.route('/park/:parkSlug/campsite/:campsiteSlug/video/:videoId')
  .delete(isLoggedIn, media.deleteVideo);



export default router