import express from "express";
const router = express.Router();
import * as other from '../controllers/other.js';
import * as monthlyDraw from '../controllers/monthlyDraw.js';
import { isLoggedIn, catchAsyncErrors, uploadMemory } from '../middleware.js'; //
import { loadCache } from '../controllers/camp.js'
import {
    contactLimiter,
    monthlyDrawNoUploadEntryLimiter,
} from '../utils/routeAbuseLimits.js';

router.route('/faq')
    .get(other.renderFaq)

router.route('/contact')
    .get(other.renderContact)
    .post(contactLimiter, other.submitContactForm)

router.route('/privacy-and-terms')
    .get(other.renderPrivacyAndTerms)

router.route('/monthly-draw')
    .get(catchAsyncErrors(monthlyDraw.renderMonthlyDraw))

router.route('/monthly-draw/no-upload-entry')
    .post(
        isLoggedIn,
        monthlyDrawNoUploadEntryLimiter,
        catchAsyncErrors(monthlyDraw.submitNoUploadEntry),
    )

export default router
