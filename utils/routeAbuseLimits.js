import rateLimit from 'express-rate-limit';

export const ROUTE_ABUSE_LIMIT_MESSAGE =
  'Too many attempts. Please try again later.';

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
});

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
  const createLimiter = policy => rateLimitFactory({
    windowMs: policy.windowMs,
    limit: policy.limit,
    statusCode: 429,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    handler: fixedRateLimitHandler,
  });

  return Object.freeze({
    loginLimiter: createLimiter(ROUTE_ABUSE_POLICIES.login),
    registrationLimiter: createLimiter(ROUTE_ABUSE_POLICIES.registration),
    forgotPasswordLimiter: createLimiter(ROUTE_ABUSE_POLICIES.forgotPassword),
    verificationResendLimiter: createLimiter(
      ROUTE_ABUSE_POLICIES.verificationResend,
    ),
    contactLimiter: createLimiter(ROUTE_ABUSE_POLICIES.contact),
  });
}

export const {
  loginLimiter,
  registrationLimiter,
  forgotPasswordLimiter,
  verificationResendLimiter,
  contactLimiter,
} = createRouteAbuseLimiters();
