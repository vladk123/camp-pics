import { Token } from '../models/token.js';
import {
    EMAIL_VERIFICATION_TOKEN_TTL_MS,
    generateAuthenticationToken,
    hashAuthenticationToken,
} from './authTokens.js';
import { logger } from './logging.js';

const reportExpiredTokenCleanupFailure = () => logger(null, null, 'error', {
    message: 'Expired email-verification tokens could not be removed after successful delivery.',
});

export const createNewUserVerify = async ({
    userId,
    username,
    TokenModel = Token,
    send,
    now = new Date(),
    cleanupNow,
    onExpiredTokenCleanupError = reportExpiredTokenCleanupFailure,
}) => {
    if (typeof send !== 'function') {
        throw new TypeError('A verification email sender is required.');
    }

    const rawToken = generateAuthenticationToken();
    const emailVerificationCode = hashAuthenticationToken(rawToken);
    const token = new TokenModel({
        email_verification_code: emailVerificationCode,
        email_verification_expiry: new Date(
            now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS,
        ),
        user_id: userId,
    });

    await token.save();

    try {
        await send({
            to: username,
            subject: 'Verify your account - CampPics',
            template: 'verify-account',
            templateData: { verificationToken: rawToken },
            userId,
        });
    } catch (error) {
        if (token._id != null) {
            await TokenModel.deleteOne({ _id: token._id }).catch(() => {});
        }
        throw error;
    }

    const expiredTokenCleanupTime = cleanupNow ?? new Date();

    try {
        await TokenModel.deleteMany({
            user_id: userId,
            _id: { $ne: token._id },
            email_verification_expiry: { $lte: expiredTokenCleanupTime },
        });
    } catch {
        if (typeof onExpiredTokenCleanupError === 'function') {
            try {
                await onExpiredTokenCleanupError();
            } catch {
                // Delivery succeeded, so operational logging must not invalidate it.
            }
        }

        return {
            delivered: true,
            expiredTokenCleanupSucceeded: false,
        };
    }

    return {
        delivered: true,
        expiredTokenCleanupSucceeded: true,
    };
};
