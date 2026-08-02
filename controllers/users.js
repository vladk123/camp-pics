import { User } from '../models/user.js';
import { Token } from '../models/token.js';
import { logger } from '../utils/logging.js'; //for logging errors
// import { getIP } from '../utils/getIP.js'
import { redirectedFlash } from '../utils/redirectedFlash.js';
import { createNewUserVerify } from '../utils/createNewUserVerify.js'
import { sendEmail } from "../utils/sendEmail.js";
import {
    consumeVerificationToken,
    effectiveAuthVersion,
    finalizePasswordResetRequest,
    findValidPasswordReset,
    MAX_VERIFICATION_RESENDS,
    reservePasswordResetRequest,
    reserveVerificationResend,
    resetPasswordWithClaim,
    rollbackPasswordResetRequest,
    rollbackVerificationResend,
    storeSessionAuthVersion,
} from '../utils/authLifecycle.js';
import {
    PASSWORD_CONFIRMATION_MESSAGE,
    validatePassword,
} from '../utils/passwordPolicy.js';
import {
    ACCOUNT_DELETE_CREDENTIAL_CHANGED,
    ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED,
    ACCOUNT_DELETE_NOT_ALLOWED,
    ACCOUNT_DELETE_NOT_FOUND,
    ACCOUNT_DELETE_PERSISTENCE_FAILED,
    ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE,
    AccountDeletionError,
    accountDeletion,
} from '../utils/accountDeletion.js';
import {
    processCommittedAccountCleanupJobs,
} from '../utils/accountDeletionPostCommit.js';
import {
    processJobById,
} from '../utils/mediaCleanupJobs.js';

const GENERIC_RESET_REQUEST_MESSAGE =
    'If you have an account with us, you will receive an email shortly to reset your password.';
const INVALID_RESET_LINK_MESSAGE =
    'Sorry, that password-reset link is invalid or has expired. Please request a new one.';

export const validateRegistrationPassword = (password, passwordRepeat) => {
    if (typeof passwordRepeat !== 'string') {
        return {
            valid: false,
            message: PASSWORD_CONFIRMATION_MESSAGE,
        };
    }

    return validatePassword(password, passwordRepeat);
};

export const createRegisterController = ({
    UserModel = User,
    TokenModel = Token,
    createVerification = createNewUserVerify,
    emailSender = sendEmail,
    log = logger,
    redirectWithFlash = redirectedFlash,
} = {}) => async(req, res, next) => {
    const {
        username,
        password,
        password_repeat,
        fname,
        website_user,
        hands_check,
    } = req.body

    // Honeypot check
    if (website_user) {
        console.warn('Bot registration attempt detected.');
        return res.status(400).send('No.');
    }

    // Other bot check
    const handsCheck = typeof hands_check === 'string'
        ? hands_check.trim().toLowerCase()
        : '';
    if (handsCheck != '5' && handsCheck !='five') {
        console.warn('Bot registration attempt detected.');
        return res.status(400).send('No.');
    }

    if(typeof username !== 'string' || username.length < 3 || username.length > 150){
        return redirectWithFlash(req, res, 'error', `Oops! An error has occurred.`, '/')
    }

    // Verify password
    const passwordValidation = validateRegistrationPassword(
        password,
        password_repeat,
    );
    if (!passwordValidation.valid) {
        return redirectWithFlash(req, res, 'error', passwordValidation.message, '/')
    }

    const user = new UserModel({ username:username.toLowerCase().trim(), fname});

    // Store the IP
    user.ip_address_registered = res.locals.ip

    // User creation and verification delivery are the registration rollback boundary.
    let newUser
    try {
        // Save new user
        newUser = await UserModel.register(user, password)
        
        // Generate and email them the verification code
        await createVerification({
            userId: newUser._id,
            username: newUser.username,
            send: emailSender,
        })
    } catch (err) {
        // Roll back both records created by this registration attempt.
        if(newUser){
            const rollbackResults = await Promise.allSettled([
                TokenModel.deleteMany({ user_id: newUser._id }),
                UserModel.findByIdAndDelete(newUser._id),
            ]);

            if (rollbackResults.some(result => result.status === 'rejected')) {
                await log(null, null, 'error', {
                    message: 'A failed registration could not be fully rolled back.',
                });
            }
        }
        
        if(err?.name === 'UserExistsError'){
            return redirectWithFlash(req, res, 'error', `User already exists.`, '/')
        } else {
            await log(null,null,'error', {message: `User wasn't able to be created.`});
            return redirectWithFlash(req, res, 'error', `Something went wrong when trying to register a new user...please contact us if this keeps happening.`, '/')
        }
        
    }

    // Delivery succeeded. Response/session/analytics failures must not roll it back.
    return redirectWithFlash(req, res, 'success', `Registered! Please check your inbox to verify your email (link expires soon!).`, '/user/registered',
        {GA4:{
            event: 'sign_up',
            user_id: newUser._id
        }}
    )
}

export const register = createRegisterController();

export const registered = async(req, res, next) => {
    return res.render(
        'user/registered', 
        {
            meta: {
				title: 'Registered', 
			}, 
            data: { }
        }

    ); // data obj to avoid crashes
}

export const login = async(req, res, next) => {
    try{
        // To store the IP
        // const realIp = await getIP(req)

        // If they're blocked, don't allow login
        if(req.user.blocked){
            return req.logout(err => {
                if (err) return next(err);
                delete req.session.auth_version;
                return redirectedFlash(req, res, 'error', 'An error occurred.', '/');
            });
        }
        
        // Update date last logged in (for tracking old inactive accounts during cleanup process) w/ IP to ensure not a bot that's changing IPs, and reset loginNoticeSent
        await User.findByIdAndUpdate(
            req.user._id,
            {
                $push: {
                    'other_login.previous_logins': {
                        $each: [{ timestamp: new Date(), ip_address: res.locals.ip }],
                        $sort: { timestamp: -1 }, // Keep the newest first
                        $slice: 20 // Allow only the last 20 entries
                    }
                },
                $set: {
                    loginNoticeSent: false,
                    'other_login.last_login': new Date()
                }
                
            }
        );

        //Checking if their user is verified
        let redirectUrl
        if(!req.user.email_verified) {
            redirectUrl = '/user/account';
        // Return where they originally were as long as it's not any login/register page
        } else if (!req.originalUrl.includes('login') && !req.originalUrl.includes('register')) {
            redirectUrl = req.originalUrl || '/';
        } else {
            redirectUrl = '/'
        }

        return redirectedFlash(req, res, 'success', 'Logged In!', redirectUrl,
            {GA4:{
                event: 'login',
                user_id: req.user._id
            }}
        );
    } catch (err) {
        next(err)
    }

}

export const createLogoutController = ({
    redirectWithFlash = redirectedFlash,
    runCallback = runCallbackOperation,
} = {}) => {
    const logoutUnavailableError = new Error('Logout is unavailable.');
    const sessionRegenerationUnavailableError =
        new Error('Session regeneration is unavailable.');

    return async(req, res, next) => {
        let isAuthenticated = false;
        try {
            if (typeof req.isAuthenticated === 'function') {
                isAuthenticated = req.isAuthenticated();
            }
        } catch (error) {
            return next(error);
        }

        if (!isAuthenticated) {
            return res.redirect('/');
        }

        if (typeof req.logout !== 'function') {
            return next(logoutUnavailableError);
        }

        const logoutError = await runCallback(
            callback => req.logout(callback),
        );
        if (logoutError) {
            return next(logoutError);
        }

        const session = req.session;
        if (typeof session?.regenerate !== 'function') {
            return next(sessionRegenerationUnavailableError);
        }

        const regenerationError = await runCallback(
            callback => session.regenerate(callback),
        );
        if (regenerationError) {
            return next(regenerationError);
        }

        return redirectWithFlash(
            req,
            res,
            'success',
            'Logged Out!',
            '/',
            {
                GA4: {
                    event: 'logout',
                    user_id: null,
                },
            },
        );
    };
};

export const logout = createLogoutController();

export const verify =  async(req, res, next) => {
    const expiredLinkRedirect = () => redirectedFlash(req, res, 'error', 'Sorry, that link is invalid or has expired...please try re-verifying by logging in and going to your Account settings.', '/')
    try {
        const result = await consumeVerificationToken({
            TokenModel: Token,
            UserModel: User,
            rawToken: req.params.code,
        });

        if (result.status !== 'verified') {
            return expiredLinkRedirect();
        }

        return redirectedFlash(req, res, 'success', 'Your account is verified and you can now sign in and upload photos and videos!', '/user/verified',
            {GA4:{
                event: 'user_verified',
                method: 'email_verification_code',
            }}
        )
    } catch(e) {
        await logger(null, null, 'error', {
            message: 'An email-verification link could not be processed.',
        });
        return expiredLinkRedirect();
    }

}

export const verified = async(req, res, next) => {
    return res.render(
        'user/verified', 
        {
            meta: {
				title: 'Verified', 
			}, 
            data: { }
        }

    ); // data obj to avoid crashes
}


export const createResendVerificationController = ({
    UserModel = User,
    createVerification = createNewUserVerify,
    emailSender = sendEmail,
    reserveResend = reserveVerificationResend,
    rollbackResend = rollbackVerificationResend,
    log = logger,
    redirectWithFlash = redirectedFlash,
    maxVerificationResends = MAX_VERIFICATION_RESENDS,
} = {}) => async(req, res, next) => {
    if (req.user.email_verified) {
        return res.redirect('/user/account');
    }

    const reservedUser = await reserveResend({
        UserModel,
        userId: req.user._id,
    });

    if (!reservedUser) {
        const currentUser = await UserModel.findById(req.user._id);
        if (currentUser?.email_verified) {
            return res.redirect('/user/account');
        }

        return redirectWithFlash(req, res, 'error', 'You have used all available verification resends. Please contact us if you still need help.', '/user/account');
    }

    try {
        await createVerification({
            userId: reservedUser._id,
            username: reservedUser.username,
            send: emailSender,
        });
    } catch {
        await rollbackResend({
            UserModel,
            userId: reservedUser._id,
        }).catch(() => {});
        await log(null, null, 'error', {
            message: 'A verification resend could not be completed.',
        });
        return redirectWithFlash(req, res, 'error', 'The verification email could not be sent. Please try again.', '/user/account');
    }

    if (reservedUser.token_counter >= maxVerificationResends) {
        return redirectWithFlash(req, res, 'info', 'That was the last verification email resend available. Contact us if you still did not receive it.', '/user/account',
            {GA4:{
                event: 'new_verification_request',
                user_id: reservedUser._id,
            }}
        )
    }

    return redirectWithFlash(req, res, 'info', 'You were just sent the verification email again - check your spam! Click the link in the email to verify.', '/user/account',
        {GA4:{
            event: 'new_verification_request',
            user_id: reservedUser._id,
        }}
    )
}

export const resendVerification = createResendVerificationController();

// Clicked forgot password
export const createForgotPasswordController = ({
    UserModel = User,
    emailSender = sendEmail,
    reserveResetRequest = reservePasswordResetRequest,
    finalizeResetRequest = finalizePasswordResetRequest,
    rollbackResetRequest = rollbackPasswordResetRequest,
    log = logger,
    redirectWithFlash = redirectedFlash,
} = {}) => async(req, res, next) => {
    const username = typeof req.body.forgot_username === 'string'
        ? req.body.forgot_username.toLowerCase().trim()
        : '';
    let emailDelivered = false;

    try {
        const user = username
            ? await UserModel.findOne({ username }).select('+hash +salt')
            : null;
        const reservation = user
            ? await reserveResetRequest({
                UserModel,
                user,
            })
            : null;

        if (reservation) {
            const userId = reservation.user._id;
            try {
                await emailSender({
                    to: reservation.user.username,
                    subject: 'Your Password Reset Link - CampPics',
                    template: 'reset-password',
                    templateData: {
                        code: reservation.rawToken,
                        userId,
                    },
                    userId,
                });

                emailDelivered = await finalizeResetRequest({
                    UserModel,
                    userId,
                    tokenDigest: reservation.tokenDigest,
                    requestClaimDigest: reservation.requestClaimDigest,
                    expiresAt: reservation.expiresAt,
                });
            } catch {
                emailDelivered = false;
            }

            if (!emailDelivered) {
                await rollbackResetRequest({
                    UserModel,
                    userId,
                    tokenDigest: reservation.tokenDigest,
                    requestClaimDigest: reservation.requestClaimDigest,
                    expiresAt: reservation.expiresAt,
                    previousState: reservation.previousState,
                }).catch(() => {});
                await log(null, null, 'error', {
                    message: 'A password-reset email request could not be completed.',
                });
            }
        }
    } catch {
        await log(null, null, 'error', {
            message: 'A password-reset request could not be processed.',
        });
    }

    return redirectWithFlash(
        req,
        res,
        'success',
        GENERIC_RESET_REQUEST_MESSAGE,
        '/',
        emailDelivered
            ? { GA4: { event: 'reset_password_request' } }
            : {},
    );
}

export const forgotPassword = createForgotPasswordController();

// Clicked the reset link in email after clicking Forgot Password on website
export const renderForgotPasswordReset = async(req, res, next) => {
    const invalidLinkRedirect = () =>
        redirectedFlash(req, res, 'error', INVALID_RESET_LINK_MESSAGE, '/');

    try {
        const {userId, code} = req.params;
        const user = await findValidPasswordReset({
            UserModel: User,
            userId,
            rawToken: code,
        });

        if (!user) {
            return invalidLinkRedirect();
        }

        return res.render(
            'user/forgotPassword',
            {
                meta: {
                    title: 'Reset Password',
                },
                encodedUserId: encodeURIComponent(userId),
                encodedCode: encodeURIComponent(code),
                data:{}
            }
        )
    } catch {
        await logger(null, null, 'error', {
            message: 'A password-reset link could not be validated.',
        });
        return invalidLinkRedirect();
    }
}

// User submitted to reset forgotten password
export const updateForgotPasswordReset = async(req, res, next) => {
    const invalidLinkRedirect = () =>
        redirectedFlash(req, res, 'error', INVALID_RESET_LINK_MESSAGE, '/');

    try {
        const {userId, code} = req.params;
        const { new_password, new_password_repeat } = req.body;
        if (
            typeof userId !== 'string' ||
            typeof code !== 'string' ||
            typeof new_password !== 'string' ||
            typeof new_password_repeat !== 'string'
        ) {
            return invalidLinkRedirect();
        }

        const validReset = await findValidPasswordReset({
            UserModel: User,
            userId,
            rawToken: code,
        });
        if (!validReset) {
            return invalidLinkRedirect();
        }

        const passwordValidation = validatePassword(
            new_password,
            new_password_repeat,
        );
        if (!passwordValidation.valid) {
            const resetUrl = `/user/forgot-password/${encodeURIComponent(userId)}/${encodeURIComponent(code)}`;
            return redirectedFlash(
                req,
                res,
                'error',
                passwordValidation.message,
                resetUrl,
            );
        }

        const result = await resetPasswordWithClaim({
            UserModel: User,
            userId,
            rawToken: code,
            newPassword: new_password,
        });

        if (result.status === 'invalid') {
            return invalidLinkRedirect();
        }

        if (result.status !== 'success') {
            await logger(null, null, 'error', {
                message: 'A claimed password reset could not be saved.',
            });
            const resetUrl = `/user/forgot-password/${encodeURIComponent(userId)}/${encodeURIComponent(code)}`;
            return redirectedFlash(
                req,
                res,
                'error',
                'The password could not be updated. Please try again.',
                resetUrl,
            );
        }

        return redirectedFlash(req, res, 'success', 'Password Updated! You can log in with your new password.', '/')
    } catch {
        await logger(null, null, 'error', {
            message: 'A password-reset submission could not be processed.',
        });
        return invalidLinkRedirect();
    }
}

// Filled out the "reset password" form on the account page
export const changePassword = async(req, res, next) => {
    const {original_password, new_password, new_password_repeat} = req.body;

    if (
        typeof original_password !== 'string' ||
        typeof new_password !== 'string' ||
        typeof new_password_repeat !== 'string'
    ) {
        return redirectedFlash(req, res, 'error', 'Please fill out all password fields.', '/user/account')
    }

    const passwordValidation = validatePassword(
        new_password,
        new_password_repeat,
    );
    if (!passwordValidation.valid) {
        return redirectedFlash(req, res, 'error', passwordValidation.message, '/user/account')
    }

    try {
        const user = await User.findById(req.user.id).select('+hash +salt');
        if (!user) {
            return redirectedFlash(req, res, 'error', 'The password could not be updated.', '/user/account');
        }

        let authentication;
        try {
            authentication = await user.authenticate(original_password);
        } catch {
            await logger(null, null, 'error', {
                message: 'A logged-in password change could not authenticate the current credential.',
            });
            return redirectedFlash(req, res, 'error', 'The password could not be updated.', '/user/account');
        }

        if (!authentication.user) {
            return redirectedFlash(req, res, 'error', 'The current password is incorrect.', '/user/account');
        }

        const credentialUser = authentication.user;
        const previousHash = credentialUser.hash;
        const previousSalt = credentialUser.salt;
        await credentialUser.setPassword(new_password);

        const updatedUser = await User.findOneAndUpdate(
            {
                _id: credentialUser._id,
                hash: previousHash,
                salt: previousSalt,
            },
            {
                $set: {
                    hash: credentialUser.hash,
                    salt: credentialUser.salt,
                    attempts: 0,
                    'other_login.reset_password_counter': 0,
                },
                $unset: {
                    'other_login.reset_password_code': 1,
                    'other_login.reset_password_expiry': 1,
                    'other_login.reset_password_claim': 1,
                },
                $inc: { auth_version: 1 },
            },
            { new: true },
        );

        if (!updatedUser) {
            return redirectedFlash(req, res, 'error', 'The password could not be updated. Please try again.', '/user/account');
        }

        storeSessionAuthVersion(req, updatedUser);
        req.user.auth_version = effectiveAuthVersion(updatedUser);
        return redirectedFlash(req, res, 'success', 'Password updated successfully!', '/user/account');
    } catch {
        await logger(null, null, 'error', {
            message: 'A logged-in password change could not be saved.',
        });
        return redirectedFlash(req, res, 'error', 'The password could not be updated. Please try again.', '/user/account');
    }
}


export const getAccount = (req, res, next) => {
    const resendCount = Number.isSafeInteger(req.user?.token_counter)
        ? req.user.token_counter
        : 0;

    return res.render(
        'user/account', 
        {
            meta: {
				title: 'Account', 
			}, 
            data: {
                currentPath: req.originalUrl,
                verificationResendsRemaining: Math.max(
                    0,
                    MAX_VERIFICATION_RESENDS - resendCount,
                ),
            }
        }
    ); // data obj to avoid crashes
}



const ACCOUNT_DELETE_AUTHENTICATION_MESSAGE =
    'The current password is incorrect or could not be verified.';

const ACCOUNT_DELETE_ERROR_RESPONSES = Object.freeze({
    [ACCOUNT_DELETE_NOT_FOUND]: {
        type: 'error',
        message: 'Account deletion could not be completed. Please sign in again.',
    },
    [ACCOUNT_DELETE_NOT_ALLOWED]: {
        type: 'error',
        message: 'Administrator accounts cannot be deleted through self-service.',
    },
    [ACCOUNT_DELETE_CREDENTIAL_CHANGED]: {
        type: 'error',
        message: 'Your account credentials changed. Please sign in again and retry.',
    },
    [ACCOUNT_DELETE_MEDIA_REVIEW_REQUIRED]: {
        type: 'error',
        message: 'Account deletion could not be completed automatically. Support must review old media records.',
    },
    [ACCOUNT_DELETE_TRANSACTION_UNAVAILABLE]: {
        type: 'error',
        message: 'Account deletion is temporarily unavailable. Please try again later.',
    },
    [ACCOUNT_DELETE_PERSISTENCE_FAILED]: {
        type: 'error',
        message: 'Account deletion could not be completed. Please try again.',
    },
});

async function logAccountDeletionOperation(log, message) {
    try {
        await log(null, null, 'error', { message });
    } catch {
        // Operational logging must not change the account-deletion result.
    }
}

function runCallbackOperation(start) {
    return new Promise(resolve => {
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            resolve(error || null);
        };
        try {
            start(finish);
        } catch (error) {
            finish(error);
        }
    });
}

async function endDeletedAccountSession({
    req,
    res,
    sessionCookieName,
    log,
}) {
    const session = req.session;
    const logoutError = typeof req.logout === 'function'
        ? await runCallbackOperation(callback => req.logout(callback))
        : new Error('Logout is unavailable.');
    if (logoutError) {
        await logAccountDeletionOperation(
            log,
            'Post-commit account deletion logout failed.',
        );
    }

    const destroyError = typeof session?.destroy === 'function'
        ? await runCallbackOperation(callback => session.destroy(callback))
        : new Error('Session destruction is unavailable.');
    if (destroyError) {
        await logAccountDeletionOperation(
            log,
            'Post-commit account deletion session destruction failed.',
        );
    }

    if (sessionCookieName && typeof res.clearCookie === 'function') {
        try {
            res.clearCookie(sessionCookieName, { path: '/' });
        } catch {
            await logAccountDeletionOperation(
                log,
                'Post-commit account deletion cookie clearing failed.',
            );
        }
    }

    return { destroyedSession: session, destroyError };
}

async function ensureAnonymousResponseSession(req, destroyedSession) {
    if (req.session) return true;
    if (typeof destroyedSession?.regenerate !== 'function') return false;
    const regenerateError = await runCallbackOperation(
        callback => destroyedSession.regenerate(callback),
    );
    return !regenerateError && Boolean(req.session);
}

async function sendCommittedDeletionSuccess({
    req,
    res,
    destroyedSession,
    redirectWithFlash,
    log,
}) {
    try {
        const hasSession = await ensureAnonymousResponseSession(
            req,
            destroyedSession,
        );
        if (hasSession) {
            return await redirectWithFlash(
                req,
                res,
                'success',
                'Account deleted. Storage cleanup may continue after you leave.',
                '/',
                {
                    GA4: {
                        event: 'delete_account',
                        user_id: null,
                    },
                },
            );
        }
        return res.redirect('/');
    } catch {
        await logAccountDeletionOperation(
            log,
            'Post-commit account deletion response handling failed.',
        );
        if (!res.headersSent) {
            try {
                return res.redirect('/');
            } catch {
                await logAccountDeletionOperation(
                    log,
                    'Post-commit account deletion fallback redirect failed.',
                );
            }
        }
        return undefined;
    }
}

export const createDeleteAccountController = ({
    UserModel = User,
    deletionService = accountDeletion,
    cleanupProcessor = { processJobById },
    cleanupRunner = processCommittedAccountCleanupJobs,
    log = logger,
    redirectWithFlash = redirectedFlash,
    sessionCookieName = process.env.COOKIE_NAME || 'connect.sid',
} = {}) => async(req, res, next) => {
    const currentPassword = req.body?.current_password;
    if (
        typeof currentPassword !== 'string' ||
        currentPassword.trim().length === 0
    ) {
        return redirectWithFlash(
            req,
            res,
            'error',
            'Enter your current password to delete your account.',
            '/user/account',
        );
    }

    let authenticatedUser;
    try {
        const userQuery = UserModel.findById(req.user?._id);
        const freshUser = await userQuery.select('+hash +salt');
        if (!freshUser) {
            const response = ACCOUNT_DELETE_ERROR_RESPONSES[
                ACCOUNT_DELETE_NOT_FOUND
            ];
            return redirectWithFlash(
                req,
                res,
                response.type,
                response.message,
                '/user/account',
            );
        }
        if (freshUser.isAdmin === true) {
            const response = ACCOUNT_DELETE_ERROR_RESPONSES[
                ACCOUNT_DELETE_NOT_ALLOWED
            ];
            return redirectWithFlash(
                req,
                res,
                response.type,
                response.message,
                '/user/account',
            );
        }

        const authentication = await freshUser.authenticate(
            currentPassword,
        );
        if (!authentication?.user) {
            return redirectWithFlash(
                req,
                res,
                'error',
                ACCOUNT_DELETE_AUTHENTICATION_MESSAGE,
                '/user/account',
            );
        }
        authenticatedUser = authentication.user;
        if (
            typeof authenticatedUser.hash !== 'string' ||
            !authenticatedUser.hash ||
            typeof authenticatedUser.salt !== 'string' ||
            !authenticatedUser.salt
        ) {
            throw new Error('Authenticated credential fingerprint is unavailable.');
        }
    } catch {
        await logAccountDeletionOperation(
            log,
            'Self-service account deletion password authentication failed.',
        );
        return redirectWithFlash(
            req,
            res,
            'error',
            ACCOUNT_DELETE_AUTHENTICATION_MESSAGE,
            '/user/account',
        );
    }

    let committed;
    try {
        committed = await deletionService.deleteAccount({
            userId: authenticatedUser._id,
            authenticatedHash: authenticatedUser.hash,
            authenticatedSalt: authenticatedUser.salt,
        });
    } catch (error) {
        const response = ACCOUNT_DELETE_ERROR_RESPONSES[error?.code] ||
            ACCOUNT_DELETE_ERROR_RESPONSES[
                ACCOUNT_DELETE_PERSISTENCE_FAILED
            ];
        if (!(error instanceof AccountDeletionError)) {
            await logAccountDeletionOperation(
                log,
                'Self-service account deletion transaction failed.',
            );
        }
        return redirectWithFlash(
            req,
            res,
            response.type,
            response.message,
            '/user/account',
        );
    }

    const { destroyedSession } = await endDeletedAccountSession({
        req,
        res,
        sessionCookieName,
        log,
    });

    try {
        const cleanup = await cleanupRunner({
            cleanupJobIds: committed.cleanupJobIds,
            processJobById: cleanupProcessor.processJobById.bind(
                cleanupProcessor,
            ),
        });
        if (cleanup.failed > 0) {
            await logAccountDeletionOperation(
                log,
                'Post-commit account deletion cleanup processing failed.',
            );
        }
    } catch {
        await logAccountDeletionOperation(
            log,
            'Post-commit account deletion cleanup processing failed.',
        );
    }

    return sendCommittedDeletionSuccess({
        req,
        res,
        destroyedSession,
        redirectWithFlash,
        log,
    });
};

export const deleteAccount = createDeleteAccountController();
