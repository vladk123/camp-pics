import express from "express";
const router = express.Router();
import * as admin from '../controllers/admin.js';
import * as siteAnnouncements from '../controllers/siteAnnouncements.js';
import * as monthlyDrawAdmin from '../controllers/monthlyDrawAdmin.js';
import { isAdmin, usernameToLowerCaseAndTrim, catchAsyncErrors } from '../middleware.js'; //
import passport from 'passport';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';

router.route('/dashboard')
    .get(isAdmin, catchAsyncErrors(admin.dashboard));

router.route('/roadmap')
  .get(isAdmin, catchAsyncErrors(admin.roadmap));

router.route('/announcements')
  .get(isAdmin, catchAsyncErrors(siteAnnouncements.announcements))
  .post(
    isAdmin,
    adminUserStatusLimiter,
    catchAsyncErrors(siteAnnouncements.saveAnnouncement),
  );

router.route('/monthly-draw/uploads')
  .get(isAdmin, catchAsyncErrors(monthlyDrawAdmin.monthlyDrawUploadReview));

router.route('/monthly-draw/uploads/:uploadId/status')
  .post(
    isAdmin,
    adminUserStatusLimiter,
    catchAsyncErrors(monthlyDrawAdmin.updateMonthlyDrawUploadStatus),
  );

router.route('/users/:userId')
  .get(isAdmin, catchAsyncErrors(admin.userDetail));

router.route('/user/:id/block')
  .post(isAdmin, adminUserStatusLimiter, catchAsyncErrors(admin.blockUser));

router.route('/user/:id/unblock')
  .post(isAdmin, adminUserStatusLimiter, catchAsyncErrors(admin.unblockUser));



export default router
