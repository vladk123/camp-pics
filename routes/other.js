import express from "express";
const router = express.Router();
import * as other from '../controllers/other.js';
import { isLoggedIn, catchAsyncErrors, uploadMemory } from '../middleware.js'; //
import { loadCache } from '../controllers/camp.js'

router.route('/faq')
    .get(other.renderFaq)

router.route('/contact')
    .get(other.renderContact)
    .post(other.submitContactForm)

router.route('/privacy-and-terms')
    .get(other.renderPrivacyAndTerms)

export default router