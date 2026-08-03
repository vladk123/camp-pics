import { SiteAnnouncement } from '../models/siteAnnouncement.js';
import { logger } from '../utils/logging.js';
import { redirectedFlash } from '../utils/redirectedFlash.js';
import {
  SITE_ANNOUNCEMENT_KEY,
  getSiteAnnouncementStatus,
  hasPublicSiteAnnouncementChanged,
  normalizeSiteAnnouncementForm,
  serializeAdminSiteAnnouncement,
} from '../utils/siteAnnouncement.js';

export const ADMIN_SITE_ANNOUNCEMENT_PROJECTION = Object.freeze({
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

export function createAdminAnnouncementGetHandler({
  AnnouncementModel = SiteAnnouncement,
  log = logger,
  redirectWithFlash = redirectedFlash,
  now = () => new Date(),
} = {}) {
  return async (req, res) => {
    try {
      const record = await AnnouncementModel
        .findOne({ key: SITE_ANNOUNCEMENT_KEY })
        .select(ADMIN_SITE_ANNOUNCEMENT_PROJECTION)
        .lean();
      const currentPath = '/a/announcements';
      return res.render('admin/announcements', {
        meta: { title: 'Site-wide Announcement - Admin' },
        announcement: serializeAdminSiteAnnouncement(record),
        announcementStatus: getSiteAnnouncementStatus(record, now()),
        currentPath,
        data: { currentPath },
      });
    } catch {
      await log(null, null, 'error', {
        message: 'Admin announcement failed to load.',
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        'Failed to load announcement settings.',
        '/a/dashboard',
      );
    }
  };
}

export function createAdminAnnouncementPostHandler({
  AnnouncementModel = SiteAnnouncement,
  log = logger,
  redirectWithFlash = redirectedFlash,
} = {}) {
  return async (req, res) => {
    const normalized = normalizeSiteAnnouncementForm(req.body);
    if (!normalized.valid) {
      return redirectWithFlash(
        req,
        res,
        'error',
        'Announcement settings were invalid.',
        '/a/announcements',
      );
    }

    try {
      const current = await AnnouncementModel
        .findOne({ key: SITE_ANNOUNCEMENT_KEY })
        .select(ADMIN_SITE_ANNOUNCEMENT_PROJECTION)
        .lean();
      const currentRevision = Number.isSafeInteger(current?.revision) &&
        current.revision > 0
        ? current.revision
        : 1;
      const incrementRevision = normalized.showAgain || (
        current !== null &&
        hasPublicSiteAnnouncementChanged(current, normalized.announcement)
      );
      const revision = currentRevision + (incrementRevision ? 1 : 0);

      await AnnouncementModel.findOneAndUpdate(
        { key: SITE_ANNOUNCEMENT_KEY },
        {
          $set: {
            ...normalized.announcement,
            revision,
          },
          $setOnInsert: { key: SITE_ANNOUNCEMENT_KEY },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
          projection: ADMIN_SITE_ANNOUNCEMENT_PROJECTION,
        },
      );

      return redirectWithFlash(
        req,
        res,
        'success',
        'Announcement settings saved.',
        '/a/announcements',
      );
    } catch {
      await log(null, null, 'error', {
        message: 'Admin announcement save failed.',
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        'Announcement settings were invalid.',
        '/a/announcements',
      );
    }
  };
}

export const announcements = createAdminAnnouncementGetHandler();
export const saveAnnouncement = createAdminAnnouncementPostHandler();
