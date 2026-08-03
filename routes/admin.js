import express from "express";
const router = express.Router();
import * as admin from '../controllers/admin.js';
// const {noDoubleSubmission, isLoggedIn, isLoggedOut, usernameToLowerCaseAndTrim} = from '../middleware';
import { isAdmin, usernameToLowerCaseAndTrim, catchAsyncErrors } from '../middleware.js'; //
import passport from 'passport';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';

router.route('/dashboard')
    .get(isAdmin, catchAsyncErrors(admin.dashboard));

router.route('/roadmap')
  .get(isAdmin, catchAsyncErrors(admin.roadmap));

router.route('/user/:id/block')
  .post(isAdmin, adminUserStatusLimiter, catchAsyncErrors(admin.blockUser));

router.route('/user/:id/unblock')
  .post(isAdmin, adminUserStatusLimiter, catchAsyncErrors(admin.unblockUser));



export default router
