import rateLimit from 'express-rate-limit';

export const ROUTE_ABUSE_LIMIT_MESSAGE =
  'Too many attempts. Please try again later.';

const AUTHENTICATED_USER_KEY_PREFIX = 'user:';
const INVALID_AUTHENTICATED_USER_KEY =
  `${AUTHENTICATED_USER_KEY_PREFIX}invalid-authenticated-id`;
const OBJECT_ID_HEX_PATTERN = /^[a-f0-9]{24}$/i;

export const ROUTE_ABUSE_POLICIES = Object.freeze({
  login: Object.freeze({
    windowMs: 15 * 60 * 1000,
    limit: 20,
  }),
  registration: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
  forgotPassword: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 10,
  }),
  verificationResend: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
  contact: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
  photoUpload: Object.freeze({
    windowMs: 10 * 60 * 1000,
    limit: 5,
  }),
  videoUpload: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 20,
  }),
  mediaDeletion: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 60,
  }),
  passwordResetSubmission: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 10,
  }),
  passwordChange: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 10,
  }),
  accountDeletion: Object.freeze({
    windowMs: 60 * 60 * 1000,
    limit: 5,
  }),
});

export function authenticatedUserKeyGenerator(req) {
  try {
    const id = req?.user?._id;
    const candidate = typeof id === 'string'
      ? id
      : id?.toHexString?.();

    if (
      typeof candidate === 'string' &&
      OBJECT_ID_HEX_PATTERN.test(candidate)
    ) {
      return `${AUTHENTICATED_USER_KEY_PREFIX}${candidate.toLowerCase()}`;
    }
  } catch {
    // A broken authenticated request shares one fail-closed limiter key.
  }

  return INVALID_AUTHENTICATED_USER_KEY;
}

export function fixedRateLimitHandler(req, res) {
  return res
    .status(429)
    .type('text/plain')
    .set('Cache-Control', 'no-store')
    .send(ROUTE_ABUSE_LIMIT_MESSAGE);
}

export function createRouteAbuseLimiters({
  rateLimitFactory = rateLimit,
} = {}) {
  const createLimiter = (policy, keyGenerator) => rateLimitFactory({
    windowMs: policy.windowMs,
    limit: policy.limit,
    statusCode: 429,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    handler: fixedRateLimitHandler,
    ...(keyGenerator ? { keyGenerator } : {}),
  });

  return Object.freeze({
    loginLimiter: createLimiter(ROUTE_ABUSE_POLICIES.login),
    registrationLimiter: createLimiter(ROUTE_ABUSE_POLICIES.registration),
    forgotPasswordLimiter: createLimiter(ROUTE_ABUSE_POLICIES.forgotPassword),
    verificationResendLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.verificationResend,
    ),
    contactLimiter: createLimiter(ROUTE_ABUSE_POLICIES.contact),
    photoUploadLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.photoUpload,
      authenticatedUserKeyGenerator,
    ),
    videoUploadLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.videoUpload,
      authenticatedUserKeyGenerator,
    ),
    mediaDeletionLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.mediaDeletion,
      authenticatedUserKeyGenerator,
    ),
    passwordResetSubmissionLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.passwordResetSubmission,
    ),
    passwordChangeLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.passwordChange,
      authenticatedUserKeyGenerator,
    ),
    accountDeletionLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.accountDeletion,
      authenticatedUserKeyGenerator,
    ),
  });
}

export const {
  loginLimiter,
  registrationLimiter,
  forgotPasswordLimiter,
  verificationResendLimiter,
  contactLimiter,
  photoUploadLimiter,
  videoUploadLimiter,
  mediaDeletionLimiter,
  passwordResetSubmissionLimiter,
  passwordChangeLimiter,
  accountDeletionLimiter,
} = createRouteAbuseLimiters();
