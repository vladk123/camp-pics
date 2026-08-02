import { randomBytes as cryptoRandomBytes } from 'node:crypto';

export const CSP_NONCE_BYTE_LENGTH = 16;

export function createCspNonceMiddleware({
  randomBytes = cryptoRandomBytes,
} = {}) {
  return (_req, res, next) => {
    try {
      const bytes = randomBytes(CSP_NONCE_BYTE_LENGTH);
      if (!Buffer.isBuffer(bytes) || bytes.length < CSP_NONCE_BYTE_LENGTH) {
        throw new TypeError('Secure nonce generation returned insufficient bytes.');
      }

      res.locals.cspNonce = bytes.toString('base64');
    } catch (error) {
      return next(error);
    }

    return next();
  };
}

export function cspNonceSource(_req, res) {
  if (!res.locals.cspNonce) {
    throw new Error('CSP nonce was not initialized.');
  }

  return `'nonce-${res.locals.cspNonce}'`;
}
