import crypto from 'node:crypto';

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

const AUTHENTICATION_TOKEN_BYTES = 32;
const MAX_AUTHENTICATION_TOKEN_LENGTH = 512;
const URL_SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export const generateAuthenticationToken = () =>
    crypto.randomBytes(AUTHENTICATION_TOKEN_BYTES).toString('base64url');

export const isWellFormedAuthenticationToken = value =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AUTHENTICATION_TOKEN_LENGTH &&
    URL_SAFE_TOKEN_PATTERN.test(value);

export const hashAuthenticationToken = value => {
    if (!isWellFormedAuthenticationToken(value)) {
        return null;
    }

    return crypto.createHash('sha256').update(value).digest('hex');
};
