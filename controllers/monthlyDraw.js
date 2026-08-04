import { MonthlyDrawNoUploadEntry } from '../models/monthlyDrawNoUploadEntry.js';
import { logger } from '../utils/logging.js';
import {
  MONTHLY_DRAW_RULES_VERSION,
  buildMonthlyDrawNoUploadEntryId,
  deriveEasternMonthKey,
  formatMonthlyDrawPeriod,
  isNoUploadEntrantAccountEligible,
  maySubmitNoUploadEntry,
  validateNoUploadEntryBody,
} from '../utils/monthlyDraw.js';
import { redirectedFlash } from '../utils/redirectedFlash.js';

export const MONTHLY_DRAW_ENTRY_SUCCESS_MESSAGE =
  'Your no-upload entry for this month has been received.';
export const MONTHLY_DRAW_ENTRY_DUPLICATE_MESSAGE =
  'You already have a no-upload entry for this month.';
export const MONTHLY_DRAW_ENTRY_VALIDATION_MESSAGE =
  'Please confirm your eligibility and agreement to the Official Rules, then try again.';
export const MONTHLY_DRAW_ENTRY_FAILURE_MESSAGE =
  'Your entry could not be submitted right now. Please try again later.';
export const MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE =
  'This account is not eligible to enter the monthly draw.';
export const MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE =
  'Monthly draw entry database operation failed.';

function isDuplicateKeyError(error) {
  try {
    return error?.code === 11000;
  } catch {
    return false;
  }
}

export function createMonthlyDrawHandlers({
  EntryModel = MonthlyDrawNoUploadEntry,
  currentTime = () => new Date(),
  log = logger,
  redirectWithFlash = redirectedFlash,
} = {}) {
  const renderMonthlyDraw = async (req, res) => {
    const monthKey = deriveEasternMonthKey(currentTime());
    const currentPeriod = formatMonthlyDrawPeriod(monthKey);
    const emailVerified = req.user?.email_verified === true;
    const accountEligible = isNoUploadEntrantAccountEligible(req.user);
    let alreadyEntered = false;
    let entryStatusAvailable = true;

    if (accountEligible) {
      try {
        const entryId = buildMonthlyDrawNoUploadEntryId(
          req.user._id,
          monthKey,
        );
        alreadyEntered = Boolean(await EntryModel.exists({
          _id: entryId,
        }));
      } catch {
        entryStatusAvailable = false;
        await log(null, null, 'error', {
          message: MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
        });
      }
    }

    return res.render('other/monthlyDraw', {
      meta: {
        title: 'CampPics Monthly Upload Draw',
        description: 'Official Rules and free no-upload entry for the CampPics Monthly Upload Draw.',
        url: 'https://camppics.ca/other/monthly-draw',
      },
      data: { currentPath: req.originalUrl },
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
      currentPeriod,
      emailVerified,
      accountEligible,
      alreadyEntered,
      entryStatusAvailable,
      maySubmitEntry: maySubmitNoUploadEntry({
        user: req.user,
        alreadyEntered,
        entryStatusAvailable,
      }),
    });
  };

  const submitNoUploadEntry = async (req, res) => {
    if (!isNoUploadEntrantAccountEligible(req.user)) {
      return redirectWithFlash(
        req,
        res,
        'error',
        MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE,
        '/other/monthly-draw',
      );
    }

    const validation = validateNoUploadEntryBody(req.body);
    if (!validation.valid) {
      return redirectWithFlash(
        req,
        res,
        'error',
        MONTHLY_DRAW_ENTRY_VALIDATION_MESSAGE,
        '/other/monthly-draw',
      );
    }

    const monthKey = deriveEasternMonthKey(currentTime());
    const entryId = buildMonthlyDrawNoUploadEntryId(
      req.user._id,
      monthKey,
    );
    try {
      await EntryModel.create({
        _id: entryId,
        userId: req.user._id,
        monthKey,
        rulesVersion: MONTHLY_DRAW_RULES_VERSION,
        ...validation.confirmations,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return redirectWithFlash(
          req,
          res,
          'info',
          MONTHLY_DRAW_ENTRY_DUPLICATE_MESSAGE,
          '/other/monthly-draw',
        );
      }

      await log(null, null, 'error', {
        message: MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
      });
      return redirectWithFlash(
        req,
        res,
        'error',
        MONTHLY_DRAW_ENTRY_FAILURE_MESSAGE,
        '/other/monthly-draw',
      );
    }

    return redirectWithFlash(
      req,
      res,
      'success',
      MONTHLY_DRAW_ENTRY_SUCCESS_MESSAGE,
      '/other/monthly-draw',
    );
  };

  return Object.freeze({ renderMonthlyDraw, submitNoUploadEntry });
}

export const {
  renderMonthlyDraw,
  submitNoUploadEntry,
} = createMonthlyDrawHandlers();
