import { SiteAnnouncement } from '../models/siteAnnouncement.js';
import { logger } from './logging.js';
import {
  SITE_ANNOUNCEMENT_KEY,
  isSiteAnnouncementActive,
  serializePublicSiteAnnouncement,
} from './siteAnnouncement.js';

export const PUBLIC_SITE_ANNOUNCEMENT_PROJECTION = Object.freeze({
  _id: 0,
  key: 1,
  enabled: 1,
  title: 1,
  message: 1,
  autoOpen: 1,
  showNavLink: 1,
  navLinkText: 1,
  ctaLabel: 1,
  ctaUrl: 1,
  startsOn: 1,
  endsOn: 1,
  revision: 1,
});

const STATIC_PATH_PATTERN = /^\/(?:css|js|images|font)(?:\/|$)/u;
const STATIC_FILE_PATTERN = /^\/(?:favicon(?:\.ico|\.svg)?|apple-touch-icon\.png|favicon-\d+x\d+\.png|site\.webmanifest)$/u;
const JSON_ROUTE_PATTERNS = Object.freeze([
  /^\/camp\/search-api$/u,
  /^\/camp\/park\/[^/]+\/media$/u,
  /^\/camp\/park\/[^/]+\/campsite\/[^/]+$/u,
  /^\/camp\/park\/[^/]+\/campground\/[^/]+\/campsite\/[^/]+$/u,
  /^\/sitemap\.xml$/u,
]);

export function shouldLoadSiteAnnouncement(req) {
  if (req?.method !== 'GET') return false;
  const requestPath = typeof req.path === 'string' ? req.path : '';
  if (
    !requestPath ||
    STATIC_PATH_PATTERN.test(requestPath) ||
    STATIC_FILE_PATTERN.test(requestPath) ||
    JSON_ROUTE_PATTERNS.some(pattern => pattern.test(requestPath))
  ) {
    return false;
  }

  if (req.xhr === true) return false;
  const accept = typeof req.headers?.accept === 'string'
    ? req.headers.accept.toLowerCase()
    : '';
  return !accept.includes('application/json') || accept.includes('text/html');
}

export function createSiteAnnouncementMiddleware({
  AnnouncementModel = SiteAnnouncement,
  log = logger,
  now = () => new Date(),
} = {}) {
  return async (req, res, next) => {
    res.locals ??= {};
    res.locals.siteAnnouncement = null;
    if (!shouldLoadSiteAnnouncement(req)) return next();

    try {
      const announcement = await AnnouncementModel
        .findOne({ key: SITE_ANNOUNCEMENT_KEY })
        .select(PUBLIC_SITE_ANNOUNCEMENT_PROJECTION)
        .lean();
      if (isSiteAnnouncementActive(announcement, now())) {
        res.locals.siteAnnouncement = serializePublicSiteAnnouncement(
          announcement,
        );
      }
    } catch {
      res.locals.siteAnnouncement = null;
      try {
        await log(null, null, 'error', {
          message: 'Site announcement lookup failed.',
        });
      } catch {
        // Announcements and their operational logging are non-critical.
      }
    }

    return next();
  };
}

export const loadSiteAnnouncement = createSiteAnnouncementMiddleware();
