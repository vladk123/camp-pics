import express from "express";
const router = express.Router();
import * as users from '../controllers/users.js';
// const {noDoubleSubmission, isLoggedIn, isLoggedOut, usernameToLowerCaseAndTrim} = from '../middleware';
import {
  isAuthenticatedForVerification,
  isLoggedIn,
  isLoggedOut,
  usernameToLowerCaseAndTrim,
  catchAsyncErrors,
} from '../middleware.js'; //
import passport from 'passport';
import { redirectedFlash } from '../utils/redirectedFlash.js';
import { storeSessionAuthVersion } from '../utils/authLifecycle.js';

router.route('/register')
    .post(isLoggedOut, catchAsyncErrors(users.register));

router.route('/registered')
  .get(users.registered)

router.post(
  '/login',
  isLoggedOut,
  usernameToLowerCaseAndTrim,
  (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) return redirectedFlash(req, res, 'error', info?.message || 'Invalid credentials.', '/');

      // Check if blocked BEFORE establishing session
      if (user.blocked) {
        return redirectedFlash(req, res, 'error', 'An error has occurred.', '/');
      }

      // If ok, log them in manually
      return req.logIn(user, err => {
        if (err) return next(err);
        storeSessionAuthVersion(req, user);
        return users.login(req, res, next);
      });
    })(req, res, next);
  }
);

router.route('/logout')
  .post(users.logout)

// When user clicks on verification code in email
router.route('/verify')
  .get(catchAsyncErrors(users.verify))

router.route('/verify/:code')
  .get(catchAsyncErrors(users.verify))

router.route('/verified')
  .get(users.verified)

// When unverified user clicks 'resend' in account pg
router.route('/resend-verification')
  .get(isAuthenticatedForVerification, catchAsyncErrors(users.resendVerification))

// Clicked forgot password on website
router.route('/forgot-password')
  .get(catchAsyncErrors(users.renderForgotPasswordReset))
  .post(catchAsyncErrors(users.forgotPassword));

// Clicked forgot password reset link in email
router.route('/forgot-password/:userId/:code')
  .get(catchAsyncErrors(users.renderForgotPasswordReset))
  // When user submits form with new password
  .post(catchAsyncErrors(users.updateForgotPasswordReset));

router.route('/forgot-password/:userId')
  .get(catchAsyncErrors(users.renderForgotPasswordReset))
  .post(catchAsyncErrors(users.updateForgotPasswordReset));

// Filled out the "reset password" form on the accoutn page
router.route('/change-password')
  .post(isLoggedIn, catchAsyncErrors(users.changePassword));

// Account settings
router.route('/account')
  .get(isLoggedIn, users.getAccount)

// Delete account
router.route('/delete-account')
  .post(isLoggedIn, catchAsyncErrors(users.deleteAccount))

export default router
