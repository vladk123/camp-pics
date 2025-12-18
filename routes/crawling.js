import express from "express";
const router = express.Router();
import * as crawling from '../controllers/crawling.js';

router.route('/')
    .get(crawling.sitemapXml)

export default router