import express from "express";
const router = express.Router();
import * as admin from '../controllers/admin.js';
// const {noDoubleSubmission, isLoggedIn, isLoggedOut, usernameToLowerCaseAndTrim} = from '../middleware';
import { isAdmin, usernameToLowerCaseAndTrim, catchAsyncErrors } from '../middleware.js'; //
import passport from 'passport';

router.route('/dashboard')
    .get(isAdmin, catchAsyncErrors(admin.dashboard));

router.route('/user/:id/block')
  .post(isAdmin, catchAsyncErrors(admin.blockUser));

router.route('/user/:id/unblock')
  .post(isAdmin, catchAsyncErrors(admin.unblockUser));



export default router