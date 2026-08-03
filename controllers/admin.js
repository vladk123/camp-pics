import { User } from '../models/user.js';
import { Upload } from '../models/upload.js';
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

// import { getIP } from '../utils/getIP.js'
import { redirectedFlash } from '../utils/redirectedFlash.js';

export const ADMIN_USER_PROJECTION = Object.freeze({
  _id: 1,
  fname: 1,
  username: 1,
  date_created: 1,
  email_verified: 1,
  blocked: 1,
});

export const ADMIN_UPLOAD_PROJECTION = Object.freeze({
  _id: 0,
  mediaType: 1,
  createdAt: 1,
  parkName: 1,
  campgroundName: 1,
  campsiteName: 1,
  youtubeId: 1,
  cloudinaryUrl: 1,
  cloudinaryId: 1,
  userId: 1,
});

export const ADMIN_UPLOAD_USER_PROJECTION = Object.freeze({
  _id: 0,
  fname: 1,
  username: 1,
});

const ADMIN_USER_BLOCK_PROJECTION = Object.freeze({
  _id: 1,
  blocked: 1,
});

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
  };
}

export function serializeAdminUpload(upload) {
  return {
    mediaType: upload?.mediaType ?? null,
    createdAt: upload?.createdAt ?? null,
    parkName: upload?.parkName ?? null,
    campgroundName: upload?.campgroundName ?? null,
    campsiteName: upload?.campsiteName ?? null,
    youtubeId: upload?.youtubeId ?? null,
    adminPhotoUrl: upload?.mediaType === 'photo'
      ? getAdminPhotoUrl(upload)
      : null,
    uploader: {
      fname: upload?.userId?.fname ?? null,
      username: upload?.userId?.username ?? null,
    },
  };
}

export function createAdminDashboardHandler({
  UserModel = User,
  UploadModel = Upload,
  log = logger,
  redirectWithFlash = redirectedFlash,
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
      const uploads = uploadRecords.map(serializeAdminUpload);

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
      return res.render('admin/dashboard', {
			meta: {
				title: 'Admin',
			},
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
