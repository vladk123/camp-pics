import { Upload } from '../models/upload.js';
import { User } from '../models/user.js';
import { Park } from '../models/park.js';
import {
  ADMIN_PARK_LOCATION_PROJECTION,
  buildAdminParkLocationMap,
  collectAdminUploadParkIds,
  getAdminUserDetailUrl,
  resolveAdminUploadLocationUrls,
  serializeAdminUpload,
} from './admin.js';
import { logger } from '../utils/logging.js';
import {
  MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS,
  MONTHLY_DRAW_INELIGIBILITY_REASONS,
  MONTHLY_DRAW_RULES_VERSION,
  MONTHLY_DRAW_UPLOAD_STATUSES,
  deriveEasternMonthKey,
  isMonthlyDrawEntrantAccountEligible,
  isValidMonthKey,
} from '../utils/monthlyDraw.js';
import {
  parseStrictMongoObjectId,
  strictMongoObjectIdsEqual,
} from '../utils/mongoObjectId.js';
import { redirectedFlash } from '../utils/redirectedFlash.js';
import { extractYouTubeVideoId } from '../utils/youtube.js';

export const ADMIN_MONTHLY_DRAW_PAGE_SIZE = 20;
export const ADMIN_MONTHLY_DRAW_UPLOAD_PROJECTION = Object.freeze({
  _id: 1,
  mediaType: 1,
  mediaId: 1,
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
  monthlyDraw: 1,
});
export const ADMIN_MONTHLY_DRAW_USER_PROJECTION = Object.freeze({
  _id: 1,
  fname: 1,
  email_verified: 1,
  isAdmin: 1,
  blocked: 1,
});
export const ADMIN_MONTHLY_DRAW_ELIGIBILITY_PROJECTION = Object.freeze({
  _id: 1,
  email_verified: 1,
  isAdmin: 1,
  blocked: 1,
});
export const ADMIN_MONTHLY_DRAW_PARK_PROJECTION = Object.freeze({
  ...ADMIN_PARK_LOCATION_PROJECTION,
  'photos._id': 1,
  'photos.caption': 1,
  'videos._id': 1,
  'videos.caption': 1,
  'campgrounds.campsites.photos._id': 1,
  'campgrounds.campsites.photos.caption': 1,
  'campgrounds.campsites.videos._id': 1,
  'campgrounds.campsites.videos.caption': 1,
  'campsites.photos._id': 1,
  'campsites.photos.caption': 1,
  'campsites.videos._id': 1,
  'campsites.videos.caption': 1,
});

export const ADMIN_MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE =
  'Admin monthly draw upload review operation failed.';
export const ADMIN_MONTHLY_DRAW_NOT_FOUND_MESSAGE =
  'This upload is not available for monthly draw review.';
export const ADMIN_MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE =
  'This account is not currently eligible for the monthly draw.';
export const ADMIN_MONTHLY_DRAW_INVALID_STATUS_MESSAGE =
  'The monthly draw review status was invalid.';

const STATUS_FILTERS = new Set([...MONTHLY_DRAW_UPLOAD_STATUSES, 'all']);
const STATUS_SET = new Set(MONTHLY_DRAW_UPLOAD_STATUSES);
const REASON_SET = new Set(MONTHLY_DRAW_INELIGIBILITY_REASONS);
const UPDATE_BODY_FIELDS = new Set([
  '_csrf',
  'status',
  'ineligibilityReason',
]);

function parsePositivePage(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

export function normalizeMonthlyDrawReviewQuery(query, now = new Date()) {
  const currentMonth = deriveEasternMonthKey(now);
  const month = typeof query?.month === 'string' &&
    isValidMonthKey(query.month)
    ? query.month
    : currentMonth;
  const status = typeof query?.status === 'string' &&
    STATUS_FILTERS.has(query.status)
    ? query.status
    : 'pending';

  return Object.freeze({
    month,
    status,
    page: parsePositivePage(query?.page),
  });
}

export function buildMonthlyDrawReviewUrl(filters) {
  const params = new URLSearchParams({
    month: filters.month,
    status: filters.status,
    page: String(filters.page),
  });
  return `/a/monthly-draw/uploads?${params.toString()}`;
}

function parseStoredObjectId(value) {
  if (typeof value === 'string') return parseStrictMongoObjectId(value);
  try {
    return parseStrictMongoObjectId(value?.toHexString?.());
  } catch {
    return parseStrictMongoObjectId(null);
  }
}

function findReviewMediaTarget(upload, park) {
  const campsiteId = parseStoredObjectId(upload?.campsiteId);
  if (!campsiteId.valid) return park;

  const campgroundId = parseStoredObjectId(upload?.campgroundId);
  if (campgroundId.valid) {
    const campground = Array.isArray(park?.campgrounds)
      ? park.campgrounds.find(candidate => strictMongoObjectIdsEqual(
        campgroundId.objectId,
        candidate?._id,
      ))
      : null;
    return Array.isArray(campground?.campsites)
      ? campground.campsites.find(candidate => strictMongoObjectIdsEqual(
        campsiteId.objectId,
        candidate?._id,
      ))
      : null;
  }

  return Array.isArray(park?.campsites)
    ? park.campsites.find(candidate => strictMongoObjectIdsEqual(
      campsiteId.objectId,
      candidate?._id,
    ))
    : null;
}

function getReviewCaption(upload, park) {
  const mediaId = parseStoredObjectId(upload?.mediaId);
  if (!mediaId.valid || !['photo', 'video'].includes(upload?.mediaType)) {
    return null;
  }
  const target = findReviewMediaTarget(upload, park);
  const collection = target?.[upload.mediaType === 'photo' ? 'photos' : 'videos'];
  if (!Array.isArray(collection)) return null;
  const media = collection.find(candidate => strictMongoObjectIdsEqual(
    mediaId.objectId,
    candidate?._id,
  ));
  return typeof media?.caption === 'string' ? media.caption : null;
}

export function serializeMonthlyDrawReviewUpload(
  upload,
  locationUrls = {},
  park = null,
) {
  const uploadId = parseStoredObjectId(upload?._id);
  const account = upload?.userId && typeof upload.userId === 'object'
    ? upload.userId
    : null;
  const status = STATUS_SET.has(upload?.monthlyDraw?.status)
    ? upload.monthlyDraw.status
    : null;
  const reason = REASON_SET.has(upload?.monthlyDraw?.ineligibilityReason)
    ? upload.monthlyDraw.ineligibilityReason
    : null;
  const safeUpload = serializeAdminUpload(upload, locationUrls);

  return Object.freeze({
    _id: uploadId.valid ? uploadId.stringValue : null,
    mediaType: upload?.mediaType === 'photo' || upload?.mediaType === 'video'
      ? upload.mediaType
      : null,
    createdAt: upload?.createdAt ?? null,
    parkName: upload?.parkName ?? null,
    campgroundName: upload?.campgroundName ?? null,
    campsiteName: upload?.campsiteName ?? null,
    parkUrl: safeUpload.parkUrl,
    campgroundUrl: safeUpload.campgroundUrl,
    campsiteUrl: safeUpload.campsiteUrl,
    youtubeId: safeUpload.youtubeId,
    adminPhotoUrl: safeUpload.adminPhotoUrl,
    caption: getReviewCaption(upload, park),
    monthKey: isValidMonthKey(upload?.monthlyDraw?.monthKey)
      ? upload.monthlyDraw.monthKey
      : null,
    rulesVersion: upload?.monthlyDraw?.rulesVersion ===
      MONTHLY_DRAW_RULES_VERSION
      ? upload.monthlyDraw.rulesVersion
      : null,
    status,
    reviewedAt: upload?.monthlyDraw?.reviewedAt ?? null,
    ineligibilityReason: reason,
    ineligibilityReasonLabel: reason
      ? MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS[reason]
      : null,
    uploader: Object.freeze({
      fname: account?.fname ?? null,
      userDetailUrl: getAdminUserDetailUrl(account?._id),
    }),
    accountEligible: isMonthlyDrawEntrantAccountEligible(account),
  });
}

function requireCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid monthly draw review count.');
  }
  return value;
}

export function createMonthlyDrawUploadReviewHandler({
  UploadModel = Upload,
  ParkModel = Park,
  currentTime = () => new Date(),
  log = logger,
  redirectWithFlash = redirectedFlash,
} = {}) {
  return async (req, res) => {
    try {
      const filters = normalizeMonthlyDrawReviewQuery(
        req.query,
        currentTime(),
      );
      const monthFilter = {
        monthlyDraw: { $exists: true },
        'monthlyDraw.monthKey': filters.month,
      };
      const [pending, eligible, ineligible, total] = await Promise.all([
        UploadModel.countDocuments({
          ...monthFilter,
          'monthlyDraw.status': 'pending',
        }),
        UploadModel.countDocuments({
          ...monthFilter,
          'monthlyDraw.status': 'eligible',
        }),
        UploadModel.countDocuments({
          ...monthFilter,
          'monthlyDraw.status': 'ineligible',
        }),
        UploadModel.countDocuments(monthFilter),
      ]);
      const counts = Object.freeze({
        pending: requireCount(pending),
        eligible: requireCount(eligible),
        ineligible: requireCount(ineligible),
        total: requireCount(total),
      });
      const filteredCount = filters.status === 'all'
        ? counts.total
        : counts[filters.status];
      const totalPages = Math.max(
        1,
        Math.ceil(filteredCount / ADMIN_MONTHLY_DRAW_PAGE_SIZE),
      );
      const currentPage = Math.min(filters.page, totalPages);
      const reviewFilter = filters.status === 'all'
        ? monthFilter
        : {
          ...monthFilter,
          'monthlyDraw.status': filters.status,
        };
      const uploadRecords = await UploadModel.find(reviewFilter)
        .select(ADMIN_MONTHLY_DRAW_UPLOAD_PROJECTION)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * ADMIN_MONTHLY_DRAW_PAGE_SIZE)
        .limit(ADMIN_MONTHLY_DRAW_PAGE_SIZE)
        .populate({
          path: 'userId',
          select: ADMIN_MONTHLY_DRAW_USER_PROJECTION,
        })
        .lean();

      const parkIds = collectAdminUploadParkIds(uploadRecords);
      const parkRecords = parkIds.length > 0
        ? await ParkModel.find({ _id: { $in: parkIds } })
          .select(ADMIN_MONTHLY_DRAW_PARK_PROJECTION)
          .lean()
        : [];
      const parksById = buildAdminParkLocationMap(parkRecords);
      const uploads = uploadRecords.map(upload => {
        const parkId = parseStoredObjectId(upload?.parkId);
        const park = parkId.valid ? parksById.get(parkId.stringValue) : null;
        return serializeMonthlyDrawReviewUpload(
          upload,
          resolveAdminUploadLocationUrls(upload, parksById),
          park,
        );
      });
      const sanitizedFilters = Object.freeze({
        ...filters,
        page: currentPage,
      });
      const currentPath = '/a/monthly-draw/uploads';

      return res.render('admin/monthlyDrawUploads', {
        meta: { title: 'Monthly Draw Upload Review - Admin' },
        currentPath,
        data: { currentPath },
        uploads,
        counts,
        filters: sanitizedFilters,
        totalPages,
        hasPreviousPage: currentPage > 1,
        hasNextPage: currentPage < totalPages,
        reasonLabels: MONTHLY_DRAW_INELIGIBILITY_REASON_LABELS,
        reasonValues: MONTHLY_DRAW_INELIGIBILITY_REASONS,
        extractYouTubeVideoId,
        csrfToken: res.locals?.csrfToken ?? null,
      });
    } catch {
      await log(null, null, 'error', {
        message: ADMIN_MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        'Failed to load monthly draw upload review.',
        '/a/dashboard',
      );
    }
  };
}

function normalizeStatusUpdateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (
    Object.getOwnPropertySymbols(body).length > 0 ||
    fields.some(field => !UPDATE_BODY_FIELDS.has(field)) ||
    typeof body.status !== 'string' ||
    !STATUS_SET.has(body.status) ||
    (body._csrf !== undefined && typeof body._csrf !== 'string') ||
    (
      body.ineligibilityReason !== undefined &&
      typeof body.ineligibilityReason !== 'string'
    )
  ) {
    return null;
  }

  const reason = body.ineligibilityReason || null;
  if (body.status === 'ineligible' && !REASON_SET.has(reason)) return null;
  if (reason !== null && !REASON_SET.has(reason)) return null;
  return Object.freeze({ status: body.status, reason });
}

function isReviewableMonthlyDraw(value) {
  return Boolean(
    value &&
    STATUS_SET.has(value.status) &&
    isValidMonthKey(value.monthKey) &&
    value.rulesVersion === MONTHLY_DRAW_RULES_VERSION,
  );
}

export function createMonthlyDrawUploadStatusHandler({
  UploadModel = Upload,
  UserModel = User,
  currentTime = () => new Date(),
  log = logger,
  redirectWithFlash = redirectedFlash,
} = {}) {
  return async (req, res) => {
    const targetId = parseStrictMongoObjectId(req.params?.uploadId);
    const redirectFilters = normalizeMonthlyDrawReviewQuery(
      req.query,
      currentTime(),
    );
    const redirectUrl = buildMonthlyDrawReviewUrl(redirectFilters);
    if (!targetId.valid) {
      return redirectWithFlash(
        req,
        res,
        'error',
        ADMIN_MONTHLY_DRAW_NOT_FOUND_MESSAGE,
        redirectUrl,
      );
    }

    const requested = normalizeStatusUpdateBody(req.body);
    if (!requested) {
      return redirectWithFlash(
        req,
        res,
        'error',
        ADMIN_MONTHLY_DRAW_INVALID_STATUS_MESSAGE,
        redirectUrl,
      );
    }

    try {
      const upload = await UploadModel.findOne({ _id: targetId.objectId })
        .select({ _id: 1, userId: 1, monthlyDraw: 1 })
        .lean();
      if (!upload || !isReviewableMonthlyDraw(upload.monthlyDraw)) {
        return redirectWithFlash(
          req,
          res,
          'error',
          ADMIN_MONTHLY_DRAW_NOT_FOUND_MESSAGE,
          redirectUrl,
        );
      }

      if (requested.status === 'eligible') {
        const account = await UserModel.findOne({ _id: upload.userId })
          .select(ADMIN_MONTHLY_DRAW_ELIGIBILITY_PROJECTION)
          .lean();
        if (!isMonthlyDrawEntrantAccountEligible(account)) {
          return redirectWithFlash(
            req,
            res,
            'error',
            ADMIN_MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE,
            redirectUrl,
          );
        }
      }

      const reviewedAt = requested.status === 'pending' ? null : currentTime();
      if (
        reviewedAt !== null &&
        (!(reviewedAt instanceof Date) || Number.isNaN(reviewedAt.getTime()))
      ) {
        throw new TypeError('Invalid review time.');
      }
      const monthlyDraw = {
        status: requested.status,
        monthKey: upload.monthlyDraw.monthKey,
        rulesVersion: upload.monthlyDraw.rulesVersion,
        reviewedAt,
        reviewedBy: requested.status === 'pending' ? null : req.user?._id,
        ineligibilityReason: requested.status === 'ineligible'
          ? requested.reason
          : null,
      };
      const updated = await UploadModel.findOneAndUpdate(
        {
          _id: targetId.objectId,
          monthlyDraw: { $exists: true },
        },
        { $set: { monthlyDraw } },
        {
          new: true,
          upsert: false,
          runValidators: true,
          projection: { _id: 1 },
        },
      );
      if (!updated) {
        return redirectWithFlash(
          req,
          res,
          'error',
          ADMIN_MONTHLY_DRAW_NOT_FOUND_MESSAGE,
          redirectUrl,
        );
      }

      return redirectWithFlash(
        req,
        res,
        'success',
        'Monthly draw upload status updated.',
        redirectUrl,
      );
    } catch {
      await log(null, null, 'error', {
        message: ADMIN_MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        'Monthly draw upload status could not be updated.',
        redirectUrl,
      );
    }
  };
}

export const monthlyDrawUploadReview = createMonthlyDrawUploadReviewHandler();
export const updateMonthlyDrawUploadStatus =
  createMonthlyDrawUploadStatusHandler();
