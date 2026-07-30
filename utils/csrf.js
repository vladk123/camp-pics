import { csrfSync } from 'csrf-sync';

export const INVALID_CSRF_TOKEN_CODE = 'INVALID_CSRF_TOKEN';
export const INVALID_CSRF_TOKEN_MESSAGE =
    'Your security token is invalid or expired. Refresh the page and try again.';

export const getSubmittedCsrfToken = req => {
    const headerToken = req.headers?.['x-csrf-token'];
    if (headerToken !== undefined) {
        return typeof headerToken === 'string' ? headerToken : undefined;
    }

    const bodyToken = req.body?._csrf;
    return typeof bodyToken === 'string' ? bodyToken : undefined;
};

const {
    csrfSynchronisedProtection,
    generateToken,
    invalidCsrfTokenError,
} = csrfSync({
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    getTokenFromRequest: getSubmittedCsrfToken,
    errorConfig: {
        statusCode: 403,
        message: 'invalid csrf token',
        code: INVALID_CSRF_TOKEN_CODE,
    },
});

export { csrfSynchronisedProtection, generateToken };

export const exposeCsrfToken = (req, res, next) => {
    let requestToken;
    let tokenResolved = false;

    Object.defineProperty(res.locals, 'csrfToken', {
        configurable: true,
        enumerable: true,
        get() {
            if (!tokenResolved) {
                requestToken = generateToken(req);
                tokenResolved = true;
            }
            return requestToken;
        },
    });

    next();
};

export const isInvalidCsrfTokenError = err => err === invalidCsrfTokenError;

export const explicitlyAcceptsJson = req => {
    const accept = req.get('accept');
    if (typeof accept !== 'string') return false;

    return accept
        .split(',')
        .map(value => value.trim().split(';', 1)[0].toLowerCase())
        .some(value => value === 'application/json' || value.endsWith('+json'));
};

export const csrfErrorHandler = (err, req, res, next) => {
    if (!isInvalidCsrfTokenError(err)) return next(err);

    if (explicitlyAcceptsJson(req)) {
        return res.status(403).json({
            error: INVALID_CSRF_TOKEN_MESSAGE,
            code: INVALID_CSRF_TOKEN_CODE,
        });
    }

    return res.status(403).render('csrfError', {
        meta: {
            title: 'Security Check Failed',
            description: 'The request could not be completed because its security token was invalid.',
        },
        csrfMessage: INVALID_CSRF_TOKEN_MESSAGE,
    });
};
