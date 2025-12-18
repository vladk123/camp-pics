import express from "express";
const router = express.Router();
import * as users from '../controllers/users.js';
// const {noDoubleSubmission, isLoggedIn, isLoggedOut, usernameToLowerCaseAndTrim} = from '../middleware';
import { isLoggedIn, isLoggedOut, usernameToLowerCaseAndTrim, catchAsyncErrors } from '../middleware.js'; //
import passport from 'passport';
import { redirectedFlash } from '../utils/redirectedFlash.js';

router.route('/register')
    .post(isLoggedOut, catchAsyncErrors(users.register));

router.post(
  '/login',
  isLoggedOut,
  usernameToLowerCaseAndTrim,
  (req, res, next) => {
    passport.authenticate('local', async (err, user, info) => {
      if (err) return next(err);
      if (!user) return redirectedFlash(req, res, 'error', info?.message || 'Invalid credentials.', '/');

      // Check if blocked BEFORE establishing session
      if (user.blocked) {
        return redirectedFlash(req, res, 'error', 'An error has occurred.', '/');
      }

      // If ok, log them in manually
      req.logIn(user, async (err) => {
        if (err) return next(err);
        return users.login(req, res, next);
      });
    })(req, res, next);
  }
);

router.route('/logout')
  .post(users.logout)

// When user clicks on verification code in email
router.route('/verify/:code')
  .get(catchAsyncErrors(users.verify))

// When unverified user clicks 'resend' in account pg
router.route('/resend-verification')
  .get(catchAsyncErrors(users.resendVerification))  

// Clicked forgot password on website
router.route('/forgot-password')
  .post(catchAsyncErrors(users.forgotPassword));

// Clicked forgot password reset link in email
router.route('/forgot-password/:userId/:code')
  .get(catchAsyncErrors(users.renderForgotPasswordReset))
  // When user submits form with new password
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