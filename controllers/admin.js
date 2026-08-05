import { User } from '../models/user.js';
import { Upload } from '../models/upload.js';
import { Park } from '../models/park.js';
import { extractYouTubeVideoId } from '../utils/youtube.js';
import { logger } from '../utils/logging.js';
import {
  parseStrictMongoObjectId,
  strictMongoObjectIdsEqual,
} from '../utils/mongoObjectId.js';
import {
  adminRoadmap,
  formatAdminRoadmapPlainText,
  getActiveRoadmapPhases,
  getCompletedRoadmapItems,
  getRoadmapSummary,
} from '../config/adminRoadmap.js';
import {
  MONTHLY_DRAW_UPLOAD_STATUSES,
  deriveEasternMonthKey,
  isMonthlyDrawUploadSelectableStatus,
} from '../utils/monthlyDraw.js';

import { redirectedFlash } from '../utils/redirectedFlash.js';

export const ADMIN_USER_PROJECTION = Object.freeze({
  _id: 1,
  fname: 1,
  username: 1,
  date_created: 1,
  email_verified: 1,
  blocked: 1,
});

export const ADMIN_USER_DETAIL_PROJECTION = Object.freeze({
  _id: 1,
  fname: 1,
  username: 1,
  date_created: 1,
  email_verified: 1,
  blocked: 1,
  'other_login.last_login': 1,
  'other_login.previous_logins.timestamp': 1,
});

export const ADMIN_UPLOAD_PROJECTION = Object.freeze({
  _id: 0,
  mediaType: 1,
  createdAt: 1,
  parkId: 1,
  parkName: 1,
  campgroundId: 1,
  campgroundName: 1,
  campsiteId: 1,
  campsiteName: 1,
  youtubeId: 1,
  cloudinaryUrl: 1,
  cloudinaryId: 1,
  userId: 1,
  'monthlyDraw.status': 1,
});

export const ADMIN_PARK_LOCATION_PROJECTION = Object.freeze({
  _id: 1,
  slug: 1,
  'campgrounds._id': 1,
  'campgrounds.slug': 1,
  'campgrounds.campsites._id': 1,
  'campgrounds.campsites.slug': 1,
  'campsites._id': 1,
  'campsites.slug': 1,
});

export const ADMIN_UPLOAD_USER_PROJECTION = Object.freeze({
  _id: 1,
  fname: 1,
  username: 1,
});

const ADMIN_USER_BLOCK_PROJECTION = Object.freeze({
  _id: 1,
  blocked: 1,
});

const ADMIN_LOCATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ADMIN_PARK_URL_PATTERN =
  /^\/camp\/park\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ADMIN_CAMPGROUND_URL_PATTERN =
  /^\/camp\/park\/[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ADMIN_CAMPSITE_URL_PATTERN =
  /^\/camp\/park\/[a-z0-9]+(?:-[a-z0-9]+)*\?(?:campsite=[a-z0-9]+(?:-[a-z0-9]+)*|campground=[a-z0-9]+(?:-[a-z0-9]+)*&campsite=[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const ADMIN_USER_DETAIL_PAGE_SIZE = 20;
const ADMIN_LOGIN_ACTIVITY_LIMIT = 20;
const MONTHLY_DRAW_UPLOAD_STATUS_SET = new Set(MONTHLY_DRAW_UPLOAD_STATUSES);
const ADMIN_UPLOAD_DRAW_LABELS = Object.freeze({
  pending: 'Eligible (legacy)',
  eligible: 'Eligible',
  ineligible: 'Ineligible',
});
const MONTHLY_DRAW_SELECTABLE_UPLOAD_STATUSES = Object.freeze(
  MONTHLY_DRAW_UPLOAD_STATUSES.filter(isMonthlyDrawUploadSelectableStatus),
);

function isValidAdminLocationSlug(value) {
  return typeof value === 'string' &&
    ADMIN_LOCATION_SLUG_PATTERN.test(value);
}

export function getAdminParkUrl(parkSlug) {
  if (!isValidAdminLocationSlug(parkSlug)) return null;
  return `/camp/park/${encodeURIComponent(parkSlug)}`;
}

export function getAdminCampgroundUrl(parkSlug, campgroundSlug) {
  const parkUrl = getAdminParkUrl(parkSlug);
  if (!parkUrl || !isValidAdminLocationSlug(campgroundSlug)) return null;
  return `${parkUrl}#${encodeURIComponent(campgroundSlug)}`;
}

export function getAdminCampsiteUrl(
  parkSlug,
  campsiteSlug,
  campgroundSlug = null,
) {
  const parkUrl = getAdminParkUrl(parkSlug);
  if (!parkUrl || !isValidAdminLocationSlug(campsiteSlug)) return null;
  if (campgroundSlug == null) {
    return `${parkUrl}?campsite=${encodeURIComponent(campsiteSlug)}`;
  }
  if (!isValidAdminLocationSlug(campgroundSlug)) return null;
  return `${parkUrl}?campground=${encodeURIComponent(
    campgroundSlug,
  )}&campsite=${encodeURIComponent(campsiteSlug)}`;
}

export function getAdminUserDetailUrl(value) {
  const userId = parseAdminLocationObjectId(value);
  return userId.valid ? `/a/users/${userId.stringValue}` : null;
}

function getValidatedAdminLocationUrl(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function parseAdminLocationObjectId(value) {
  if (typeof value === 'string') return parseStrictMongoObjectId(value);
  if (!value || typeof value !== 'object') {
    return parseStrictMongoObjectId(null);
  }

  try {
    return parseStrictMongoObjectId(value.toHexString?.());
  } catch {
    return parseStrictMongoObjectId(null);
  }
}

export function collectAdminUploadParkIds(uploadRecords) {
  const parkIdsByString = new Map();
  for (const upload of uploadRecords) {
    const parkId = parseAdminLocationObjectId(upload?.parkId);
    if (parkId.valid && !parkIdsByString.has(parkId.stringValue)) {
      parkIdsByString.set(parkId.stringValue, parkId.objectId);
    }
  }
  return [...parkIdsByString.values()];
}

export function buildAdminParkLocationMap(parkRecords) {
  const parksById = new Map();
  for (const park of parkRecords) {
    const parkId = parseAdminLocationObjectId(park?._id);
    if (parkId.valid) parksById.set(parkId.stringValue, park);
  }
  return parksById;
}

export function resolveAdminUploadLocationUrls(upload, parksById) {
  const uploadParkId = parseAdminLocationObjectId(upload?.parkId);
  if (!uploadParkId.valid) {
    return { parkUrl: null, campgroundUrl: null, campsiteUrl: null };
  }

  const park = parksById.get(uploadParkId.stringValue);
  const parkUrl = getAdminParkUrl(park?.slug);
  if (!parkUrl) {
    return { parkUrl: null, campgroundUrl: null, campsiteUrl: null };
  }

  const uploadCampgroundId = parseAdminLocationObjectId(upload?.campgroundId);
  const campground = uploadCampgroundId.valid && Array.isArray(park.campgrounds)
    ? park.campgrounds.find(candidate => strictMongoObjectIdsEqual(
      uploadCampgroundId.objectId,
      candidate?._id,
    ))
    : null;
  const campgroundUrl = getAdminCampgroundUrl(
    park.slug,
    campground?.slug,
  );

  const uploadCampsiteId = parseAdminLocationObjectId(upload?.campsiteId);
  let campsiteUrl = null;
  if (uploadCampsiteId.valid) {
    const campsiteCollection = uploadCampgroundId.valid
      ? campground?.campsites
      : park.campsites;
    const campsite = Array.isArray(campsiteCollection)
      ? campsiteCollection.find(candidate => strictMongoObjectIdsEqual(
        uploadCampsiteId.objectId,
        candidate?._id,
      ))
      : null;
    campsiteUrl = getAdminCampsiteUrl(
      park.slug,
      campsite?.slug,
      uploadCampgroundId.valid ? campground?.slug : null,
    );
  }

  return {
    parkUrl,
    campgroundUrl,
    campsiteUrl,
  };
}

export function getSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function getAdminPhotoUrl(upload) {
  return getSafeHttpUrl(upload?.cloudinaryUrl) ||
    getSafeHttpUrl(upload?.cloudinaryId);
}

export function serializeAdminUser(user) {
  return {
    _id: user?._id ?? null,
    fname: user?.fname ?? null,
    username: user?.username ?? null,
    date_created: user?.date_created ?? null,
    email_verified: user?.email_verified ?? null,
    blocked: user?.blocked ?? null,
    userDetailUrl: getAdminUserDetailUrl(user?._id),
  };
}

export function normalizeAdminLoginActivity(user) {
  const timestamps = [user?.other_login?.last_login];
  if (Array.isArray(user?.other_login?.previous_logins)) {
    for (const login of user.other_login.previous_logins) {
      timestamps.push(login?.timestamp);
    }
  }

  const uniqueByIsoString = new Map();
  for (const value of timestamps) {
    if (!(value instanceof Date) && typeof value !== 'string') continue;
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) continue;
    uniqueByIsoString.set(timestamp.toISOString(), timestamp);
  }

  return [...uniqueByIsoString.values()]
    .sort((left, right) => right.getTime() - left.getTime())
    .slice(0, ADMIN_LOGIN_ACTIVITY_LIMIT);
}

export function serializeAdminUserDetail(user, currentAdministratorId) {
  const userId = parseAdminLocationObjectId(user?._id);
  return Object.freeze({
    _id: userId.valid ? userId.stringValue : null,
    fname: user?.fname ?? null,
    username: user?.username ?? null,
    date_created: user?.date_created ?? null,
    email_verified: user?.email_verified === true,
    blocked: user?.blocked === true,
    canChangeBlockedStatus: userId.valid && !strictMongoObjectIdsEqual(
      userId.objectId,
      currentAdministratorId,
    ),
  });
}

export function serializeAdminUpload(upload, locationUrls = {}) {
  const parkUrl = getValidatedAdminLocationUrl(
    locationUrls.parkUrl,
    ADMIN_PARK_URL_PATTERN,
  );
  const campgroundUrl = getValidatedAdminLocationUrl(
    locationUrls.campgroundUrl,
    ADMIN_CAMPGROUND_URL_PATTERN,
  );
  const campsiteUrl = getValidatedAdminLocationUrl(
    locationUrls.campsiteUrl,
    ADMIN_CAMPSITE_URL_PATTERN,
  );
  const monthlyDrawStatus = MONTHLY_DRAW_UPLOAD_STATUS_SET.has(
    upload?.monthlyDraw?.status,
  )
    ? upload.monthlyDraw.status
    : null;

  return {
    mediaType: upload?.mediaType ?? null,
    createdAt: upload?.createdAt ?? null,
    parkName: upload?.parkName ?? null,
    campgroundName: upload?.campgroundName ?? null,
    campsiteName: upload?.campsiteName ?? null,
    parkUrl,
    campgroundUrl: parkUrl && campgroundUrl &&
      campgroundUrl.startsWith(`${parkUrl}#`)
      ? campgroundUrl
      : null,
    campsiteUrl: parkUrl && campsiteUrl &&
      campsiteUrl.startsWith(`${parkUrl}?`)
      ? campsiteUrl
      : null,
    youtubeId: upload?.youtubeId ?? null,
    adminPhotoUrl: upload?.mediaType === 'photo'
      ? getAdminPhotoUrl(upload)
      : null,
    uploader: {
      fname: upload?.userId?.fname ?? null,
      username: upload?.userId?.username ?? null,
      userDetailUrl: getAdminUserDetailUrl(upload?.userId?._id),
    },
    monthlyDrawStatus,
    monthlyDrawLabel: monthlyDrawStatus
      ? ADMIN_UPLOAD_DRAW_LABELS[monthlyDrawStatus]
      : 'Not entered',
  };
}

function requireNumericDashboardCount(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid administrator dashboard count: ${name}.`);
  }
  return value;
}

export function createAdminDashboardHandler({
  UserModel = User,
  UploadModel = Upload,
  ParkModel = Park,
  log = logger,
  redirectWithFlash = redirectedFlash,
  currentTime = () => new Date(),
} = {}) {
  return async (req, res, next) => {
    try {
      // Pagination parameters
      const uploadPage = parseInt(req.query.uploadPage) || 1;
      const userPage = parseInt(req.query.userPage) || 1;
      const limitUploads = 10;
      const limitUsers = 50;

      const skipUploads = (uploadPage - 1) * limitUploads;
      const skipUsers = (userPage - 1) * limitUsers;

      // Get most recent uploads (10 per page)
      const uploadRecords = await UploadModel.find({})
        .select(ADMIN_UPLOAD_PROJECTION)
        .sort({ createdAt: -1 })
        .skip(skipUploads)
        .limit(limitUploads)
        .populate({
          path: 'userId',
          select: ADMIN_UPLOAD_USER_PROJECTION,
        }) // show uploader info
        // .populate('parkId', 'name slug')
        // .populate('campgroundId', 'name slug') // only filled if campground exists
        // .populate('campsiteId', 'siteNumber slug') // only filled if campsite exists
        .lean();
      const uploadParkIds = collectAdminUploadParkIds(uploadRecords);
      let parkRecords = [];
      if (uploadParkIds.length > 0) {
        parkRecords = await ParkModel.find({ _id: { $in: uploadParkIds } })
          .select(ADMIN_PARK_LOCATION_PROJECTION)
          .lean();
      }
      const parksById = buildAdminParkLocationMap(parkRecords);
      const uploads = uploadRecords.map(upload => serializeAdminUpload(
        upload,
        resolveAdminUploadLocationUrls(upload, parksById),
      ));

      const totalUploads = await UploadModel.countDocuments();
      const hasMoreUploads = totalUploads > uploadPage * limitUploads;

      // Get most recent users (50 per page)
      const userRecords = await UserModel.find({_id: { $ne: req.user._id }})
        .select(ADMIN_USER_PROJECTION)
        .sort({ date_created: -1 })
        .skip(skipUsers)
        .limit(limitUsers)
        .lean();
      const users = userRecords.map(serializeAdminUser);

      const totalUsers = await UserModel.countDocuments({
        _id: { $ne: req.user._id },
      });
      const hasMoreUsers = totalUsers > userPage * limitUsers;

      // Respond differently depending on request type
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.json({
          uploads,
          users,
          hasMoreUploads,
          hasMoreUsers,
        });
      }

      // Regular render (first load)
      const monthlyDrawMonthKey = deriveEasternMonthKey(currentTime());
      const [
        dashboardTotalUploads,
        dashboardTotalUsers,
        verifiedUsers,
        blockedUsers,
        currentMonthlyDrawUploads,
      ] = await Promise.all([
        UploadModel.countDocuments({}),
        UserModel.countDocuments({}),
        UserModel.countDocuments({ email_verified: true }),
        UserModel.countDocuments({ blocked: true }),
        UploadModel.countDocuments({
          monthlyDraw: { $exists: true },
          'monthlyDraw.monthKey': monthlyDrawMonthKey,
          'monthlyDraw.status': {
            $in: [...MONTHLY_DRAW_SELECTABLE_UPLOAD_STATUSES],
          },
        }),
      ]);
      const dashboardStats = Object.freeze({
        totalUploads: requireNumericDashboardCount(
          dashboardTotalUploads,
          'totalUploads',
        ),
        totalUsers: requireNumericDashboardCount(
          dashboardTotalUsers,
          'totalUsers',
        ),
        verifiedUsers: requireNumericDashboardCount(
          verifiedUsers,
          'verifiedUsers',
        ),
        blockedUsers: requireNumericDashboardCount(
          blockedUsers,
          'blockedUsers',
        ),
        currentMonthlyDrawUploads: requireNumericDashboardCount(
          currentMonthlyDrawUploads,
          'currentMonthlyDrawUploads',
        ),
      });

      return res.render('admin/dashboard', {
			meta: {
				title: 'Admin dashboard',
			},
        dashboardStats,
        monthlyDrawMonthKey,
        uploads,
        users,
        uploadPage,
        userPage,
        hasMoreUploads,
        hasMoreUsers,
        extractYouTubeVideoId,
        data: { currentPath: '/a/dashboard' },
      });
    } catch (err) {
      await log(req, res, 'error', {
        message: 'Admin dashboard failed to load.',
        error: err,
      });
      return redirectWithFlash(req, res, 'error', 'Failed to load dashboard.', '/');
    }
  };
}

export const dashboard = createAdminDashboardHandler();

function parseAdminUserDetailPage(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

export function createAdminUserDetailHandler({
  UserModel = User,
  UploadModel = Upload,
  ParkModel = Park,
  log = logger,
  redirectWithFlash = redirectedFlash,
} = {}) {
  return async (req, res, next) => {
    const targetId = parseStrictMongoObjectId(req.params?.userId);
    if (!targetId.valid) {
      return redirectWithFlash(
        req,
        res,
        'error',
        'Invalid user target.',
        '/a/dashboard',
      );
    }

    try {
      const userRecord = await UserModel.findOne({ _id: targetId.objectId })
        .select(ADMIN_USER_DETAIL_PROJECTION)
        .lean();
      if (!userRecord) {
        return redirectWithFlash(
          req,
          res,
          'error',
          'User was not found.',
          '/a/dashboard',
        );
      }

      const ownershipFilter = { userId: targetId.objectId };
      const totalUploadCount = await UploadModel.countDocuments(ownershipFilter);
      const totalPages = Math.max(
        1,
        Math.ceil(totalUploadCount / ADMIN_USER_DETAIL_PAGE_SIZE),
      );
      const requestedPage = parseAdminUserDetailPage(req.query?.page);
      const currentPage = Math.min(requestedPage, totalPages);
      const uploadRecords = await UploadModel.find(ownershipFilter)
        .select(ADMIN_UPLOAD_PROJECTION)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * ADMIN_USER_DETAIL_PAGE_SIZE)
        .limit(ADMIN_USER_DETAIL_PAGE_SIZE)
        .lean();

      const uploadParkIds = collectAdminUploadParkIds(uploadRecords);
      let parkRecords = [];
      if (uploadParkIds.length > 0) {
        parkRecords = await ParkModel.find({ _id: { $in: uploadParkIds } })
          .select(ADMIN_PARK_LOCATION_PROJECTION)
          .lean();
      }
      const parksById = buildAdminParkLocationMap(parkRecords);
      const uploads = uploadRecords.map(upload => serializeAdminUpload(
        upload,
        resolveAdminUploadLocationUrls(upload, parksById),
      ));
      const user = serializeAdminUserDetail(userRecord, req.user?._id);
      const currentPath = `/a/users/${targetId.stringValue}`;

      return res.render('admin/userDetail', {
        meta: {
          title: `${user.fname || user.username || 'User'} - Admin`,
        },
        user,
        loginActivity: normalizeAdminLoginActivity(userRecord),
        uploads,
        currentPage,
        totalPages,
        totalUploadCount,
        hasPreviousPage: currentPage > 1,
        hasNextPage: currentPage < totalPages,
        currentPath,
        extractYouTubeVideoId,
        csrfToken: res.locals?.csrfToken ?? null,
        data: { currentPath },
      });
    } catch {
      await log(req, res, 'error', {
        message: 'Admin user details failed to load.',
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        'Failed to load user details.',
        '/a/dashboard',
      );
    }
  };
}

export const userDetail = createAdminUserDetailHandler();

export async function roadmap(req, res) {
  const currentPath = '/a/roadmap';
  return res.render('admin/roadmap', {
    meta: {
      title: 'Admin Roadmap',
    },
    currentPath,
    roadmap: adminRoadmap,
    activePhases: getActiveRoadmapPhases(),
    completedItems: getCompletedRoadmapItems(),
    summaryCounts: getRoadmapSummary(),
    copyText: formatAdminRoadmapPlainText(),
    data: { currentPath },
  });
}

export function createUserBlockHandler({
  blocked,
  UserModel = User,
  log = logger,
  redirectWithFlash = redirectedFlash,
} = {}) {
  const action = blocked ? 'block' : 'unblock';
  const successMessage = blocked
    ? 'User has been blocked.'
    : 'User has been unblocked.';
  const failureMessage = blocked
    ? 'Failed to block user.'
    : 'Failed to unblock user.';

  return async (req, res, next) => {
    const targetId = parseStrictMongoObjectId(req.params?.id);
    if (!targetId.valid) {
      return redirectWithFlash(
        req,
        res,
        'error',
        'Invalid user target.',
        '/a/dashboard',
      );
    }

    if (strictMongoObjectIdsEqual(targetId.objectId, req.user?._id)) {
      return redirectWithFlash(
        req,
        res,
        'error',
        'You cannot change your own blocked status.',
        '/a/dashboard',
      );
    }

    try {
      const updatedUser = await UserModel.findOneAndUpdate(
        { _id: targetId.objectId },
        { $set: { blocked } },
        {
          new: true,
          runValidators: true,
          projection: ADMIN_USER_BLOCK_PROJECTION,
          upsert: false,
        },
      );
      if (!updatedUser) {
        return redirectWithFlash(
          req,
          res,
          'error',
          'User was not found.',
          '/a/dashboard',
        );
      }

      return redirectWithFlash(
        req,
        res,
        'success',
        successMessage,
        '/a/dashboard',
      );
    } catch {
      await log(req, res, 'error', {
        message: `Admin user ${action} operation failed.`,
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        failureMessage,
        '/a/dashboard',
      );
    }
  };
}

export const blockUser = createUserBlockHandler({ blocked: true });
export const unblockUser = createUserBlockHandler({ blocked: false });
