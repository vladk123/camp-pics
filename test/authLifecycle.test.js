import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { enforceSessionAuthVersion } from '../middleware.js';
import {
    claimPasswordReset,
    consumeVerificationToken,
    effectiveAuthVersion,
    finalizePasswordResetRequest,
    findValidPasswordReset,
    reservePasswordResetRequest,
    reserveVerificationResend,
    resetPasswordWithClaim,
    rollbackPasswordResetRequest,
    sessionAuthVersionMatches,
    storeSessionAuthVersion,
} from '../utils/authLifecycle.js';
import { hashAuthenticationToken } from '../utils/authTokens.js';

const USER_ID = '64b7f2d4c9f1e8a123456789';
const NOW = new Date('2026-07-29T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 10 * 60 * 1000);
const PAST = new Date(NOW.getTime() - 1000);

const createVerificationModels = ({
    rawToken,
    rawTokens = [rawToken],
    expiry = FUTURE,
}) => {
    let tokens = rawTokens.map((value, index) => ({
        _id: `verification-id-${index + 1}`,
        user_id: USER_ID,
        email_verification_code: hashAuthenticationToken(value),
        email_verification_expiry: expiry,
    }));
    const user = {
        _id: USER_ID,
        email_verified: false,
    };

    return {
        TokenModel: {
            async findOneAndDelete(filter) {
                const index = tokens.findIndex(token =>
                    filter.email_verification_code ===
                        token.email_verification_code &&
                    token.email_verification_expiry >
                        filter.email_verification_expiry.$gt
                );
                if (index < 0) return null;
                const [consumed] = tokens.splice(index, 1);
                return consumed;
            },
            async deleteOne(filter) {
                tokens = tokens.filter(token =>
                    token.email_verification_code !==
                        filter.email_verification_code ||
                    token.email_verification_expiry >
                        filter.email_verification_expiry.$lte
                );
            },
            async deleteMany(filter) {
                tokens = tokens.filter(
                    token => token.user_id !== filter.user_id,
                );
            },
        },
        UserModel: {
            async findOneAndUpdate(filter, update) {
                if (
                    filter._id !== USER_ID ||
                    user.email_verified === true
                ) {
                    return null;
                }
                user.email_verified = update.$set.email_verified;
                return user;
            },
        },
        user,
        hasToken: () => tokens.length > 0,
        tokenCount: () => tokens.length,
    };
};

const createResetModel = ({
    rawToken,
    expiry = FUTURE,
    claim,
    setPasswordFails = false,
}) => {
    const state = {
        _id: USER_ID,
        username: 'camper@example.test',
        blocked: false,
        hash: 'old-hash',
        salt: 'old-salt',
        auth_version: 0,
        other_login: {
            reset_password_code: hashAuthenticationToken(rawToken),
            reset_password_expiry: expiry,
            reset_password_counter: 2,
        },
        async setPassword() {
            if (setPasswordFails) {
                throw new Error('simulated password save failure');
            }
            this.hash = 'new-hash';
            this.salt = 'new-salt';
        },
    };

    if (claim !== undefined) {
        state.other_login.reset_password_claim = claim;
    }

    let completionCalls = 0;
    let releaseCalls = 0;

    const UserModel = {
        async findOne(filter) {
            const reset = state.other_login;
            const valid =
                filter._id === state._id &&
                reset.reset_password_code ===
                    filter['other_login.reset_password_code'] &&
                reset.reset_password_expiry >
                    filter['other_login.reset_password_expiry'].$gt &&
                reset.reset_password_claim == null;
            return valid ? state : null;
        },
        async findOneAndUpdate(filter, update) {
            const reset = state.other_login;
            const codeMatches =
                reset.reset_password_code ===
                filter['other_login.reset_password_code'];
            const expiryCondition =
                filter['other_login.reset_password_expiry']?.$gt;
            const expiryMatches = expiryCondition
                ? reset.reset_password_expiry > expiryCondition
                : true;
            const claimFilter = filter['other_login.reset_password_claim'];
            const claimMatches = claimFilter === undefined
                ? reset.reset_password_claim == null
                : reset.reset_password_claim === claimFilter;

            if (!codeMatches || !expiryMatches || !claimMatches) {
                return null;
            }

            if (update.$inc?.auth_version) {
                completionCalls += 1;
                state.hash = update.$set.hash;
                state.salt = update.$set.salt;
                state.auth_version += update.$inc.auth_version;
                state.other_login.reset_password_counter =
                    update.$set['other_login.reset_password_counter'];
                delete state.other_login.reset_password_code;
                delete state.other_login.reset_password_expiry;
                delete state.other_login.reset_password_claim;
                return state;
            }

            state.other_login.reset_password_claim =
                update.$set['other_login.reset_password_claim'];
            return state;
        },
        async updateOne(filter) {
            if (
                state.other_login.reset_password_code ===
                    filter['other_login.reset_password_code'] &&
                state.other_login.reset_password_claim ===
                    filter['other_login.reset_password_claim']
            ) {
                releaseCalls += 1;
                delete state.other_login.reset_password_claim;
                return { matchedCount: 1, modifiedCount: 1 };
            }
            return { matchedCount: 0, modifiedCount: 0 };
        },
    };

    return {
        UserModel,
        state,
        completionCalls: () => completionCalls,
        releaseCalls: () => releaseCalls,
    };
};

const createResetRequestModel = ({
    code,
    expiry,
    counter,
}) => {
    const state = {
        _id: USER_ID,
        username: 'camper@example.test',
        blocked: false,
        hash: 'existing-hash',
        salt: 'existing-salt',
        other_login: {},
    };
    if (code !== undefined) state.other_login.reset_password_code = code;
    if (expiry !== undefined) state.other_login.reset_password_expiry = expiry;
    if (counter !== undefined) state.other_login.reset_password_counter = counter;

    const setPath = (path, value) => {
        const [, key] = path.split('.');
        state.other_login[key] = value;
    };
    const unsetPath = path => {
        const [, key] = path.split('.');
        delete state.other_login[key];
    };
    const snapshot = () => ({
        ...state,
        other_login: { ...state.other_login },
    });

    const UserModel = {
        async findOneAndUpdate(filter, update) {
            if (
                state.blocked ||
                state.other_login.reset_password_claim
            ) {
                return null;
            }

            const previous = snapshot();
            for (const [path, value] of Object.entries(update.$set || {})) {
                setPath(path, value);
            }
            return previous;
        },
        async findById() {
            return state;
        },
        async updateOne(filter, update) {
            if (
                state.other_login.reset_password_code !==
                    filter['other_login.reset_password_code'] ||
                state.other_login.reset_password_expiry !==
                    filter['other_login.reset_password_expiry'] ||
                state.other_login.reset_password_claim !==
                    filter['other_login.reset_password_claim']
            ) {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            for (const [path, value] of Object.entries(update.$set || {})) {
                setPath(path, value);
            }
            for (const path of Object.keys(update.$unset || {})) {
                unsetPath(path);
            }
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };

    return { state, UserModel };
};

describe('legacy token compatibility and one-use behavior', () => {
    test('a legacy SHA-256 verification record remains consumable', async () => {
        const rawToken = 'LegacyVerificationCode123';
        const models = createVerificationModels({ rawToken });

        const result = await consumeVerificationToken({
            ...models,
            rawToken,
            now: NOW,
        });

        assert.equal(result.status, 'verified');
        assert.equal(models.user.email_verified, true);
        assert.equal(models.hasToken(), false);
    });

    test('only one simultaneous verification consume succeeds', async () => {
        const rawToken = 'ConcurrentVerificationCode123';
        const models = createVerificationModels({ rawToken });

        const results = await Promise.all([
            consumeVerificationToken({
                ...models,
                rawToken,
                now: NOW,
            }),
            consumeVerificationToken({
                ...models,
                rawToken,
                now: NOW,
            }),
        ]);

        assert.deepEqual(
            results.map(result => result.status).sort(),
            ['invalid', 'verified'],
        );
    });

    test('either active link can verify and consumes every remaining token', async () => {
        const rawTokens = [
            'FirstActiveVerificationCode123',
            'SecondActiveVerificationCode123',
        ];

        for (const firstToken of rawTokens) {
            const models = createVerificationModels({ rawTokens });
            const otherToken = rawTokens.find(token => token !== firstToken);

            const firstResult = await consumeVerificationToken({
                ...models,
                rawToken: firstToken,
                now: NOW,
            });
            const otherResult = await consumeVerificationToken({
                ...models,
                rawToken: otherToken,
                now: NOW,
            });

            assert.equal(firstResult.status, 'verified');
            assert.equal(models.tokenCount(), 0);
            assert.equal(otherResult.status, 'invalid');
        }
    });

    test('only one simultaneous verification with different links succeeds', async () => {
        const rawTokens = [
            'ConcurrentVerificationCodeA123',
            'ConcurrentVerificationCodeB123',
        ];
        const models = createVerificationModels({ rawTokens });

        const results = await Promise.all(rawTokens.map(rawToken =>
            consumeVerificationToken({
                ...models,
                rawToken,
                now: NOW,
            })
        ));

        assert.deepEqual(
            results.map(result => result.status).sort(),
            ['invalid', 'verified'],
        );
        assert.equal(models.user.email_verified, true);
        assert.equal(models.tokenCount(), 0);
    });

    test('a legacy reset record with no claim remains claimable once', async () => {
        const rawToken = 'LegacyResetToken123';
        const reset = createResetModel({ rawToken });

        const [first, second] = await Promise.all([
            claimPasswordReset({
                UserModel: reset.UserModel,
                userId: USER_ID,
                rawToken,
                now: NOW,
            }),
            claimPasswordReset({
                UserModel: reset.UserModel,
                userId: USER_ID,
                rawToken,
                now: NOW,
            }),
        ]);

        assert.equal([first, second].filter(Boolean).length, 1);
    });

    test('expired and already claimed legacy reset records are rejected', async () => {
        const expired = createResetModel({
            rawToken: 'ExpiredResetToken123',
            expiry: PAST,
        });
        const claimed = createResetModel({
            rawToken: 'ClaimedResetToken123',
            claim: 'existing-claim-digest',
        });

        assert.equal(await findValidPasswordReset({
            UserModel: expired.UserModel,
            userId: USER_ID,
            rawToken: 'ExpiredResetToken123',
            now: NOW,
        }), null);
        assert.equal(await claimPasswordReset({
            UserModel: expired.UserModel,
            userId: USER_ID,
            rawToken: 'ExpiredResetToken123',
            now: NOW,
        }), null);
        assert.equal(await claimPasswordReset({
            UserModel: claimed.UserModel,
            userId: USER_ID,
            rawToken: 'ClaimedResetToken123',
            now: NOW,
        }), null);
    });

    test('a successful reset clears token state and advances auth version', async () => {
        const rawToken = 'SuccessfulResetToken123';
        const reset = createResetModel({ rawToken });

        const result = await resetPasswordWithClaim({
            UserModel: reset.UserModel,
            userId: USER_ID,
            rawToken,
            newPassword: 'Replacement9!',
            now: NOW,
        });

        assert.equal(result.status, 'success');
        assert.equal(reset.state.hash, 'new-hash');
        assert.equal(reset.state.salt, 'new-salt');
        assert.equal(reset.state.auth_version, 1);
        assert.equal(reset.state.other_login.reset_password_counter, 0);
        assert.equal('reset_password_code' in reset.state.other_login, false);
        assert.equal('reset_password_expiry' in reset.state.other_login, false);
        assert.equal('reset_password_claim' in reset.state.other_login, false);
        assert.equal(reset.completionCalls(), 1);
    });

    test('a failed password save releases its claim and never succeeds', async () => {
        const rawToken = 'FailingResetToken123';
        const reset = createResetModel({
            rawToken,
            setPasswordFails: true,
        });

        const result = await resetPasswordWithClaim({
            UserModel: reset.UserModel,
            userId: USER_ID,
            rawToken,
            newPassword: 'Replacement9!',
            now: NOW,
        });

        assert.equal(result.status, 'failed');
        assert.equal(reset.state.hash, 'old-hash');
        assert.equal(reset.state.auth_version, 0);
        assert.equal(reset.completionCalls(), 0);
        assert.equal(reset.releaseCalls(), 1);
        assert.equal('reset_password_claim' in reset.state.other_login, false);
    });
});

test('verification resend reservations cannot exceed the persisted limit', async () => {
    const state = {
        _id: USER_ID,
        email_verified: false,
        token_counter: 0,
    };
    const UserModel = {
        async findOneAndUpdate() {
            if (state.email_verified || state.token_counter >= 2) {
                return null;
            }
            state.token_counter += 1;
            return { ...state };
        },
    };

    const results = await Promise.all([
        reserveVerificationResend({ UserModel, userId: USER_ID }),
        reserveVerificationResend({ UserModel, userId: USER_ID }),
        reserveVerificationResend({ UserModel, userId: USER_ID }),
    ]);

    assert.equal(results.filter(Boolean).length, 2);
    assert.equal(state.token_counter, 2);
});

test('password reset requests allow three emails per active window', async () => {
    const reset = createResetRequestModel({});

    for (let expectedCounter = 1; expectedCounter <= 3; expectedCounter += 1) {
        const reservation = await reservePasswordResetRequest({
            UserModel: reset.UserModel,
            user: reset.state,
            now: NOW,
        });
        assert.ok(reservation);
        assert.equal(
            reset.state.other_login.reset_password_counter,
            expectedCounter,
        );
        assert.equal(await finalizePasswordResetRequest({
            UserModel: reset.UserModel,
            userId: USER_ID,
            tokenDigest: reservation.tokenDigest,
            requestClaimDigest: reservation.requestClaimDigest,
            expiresAt: reservation.expiresAt,
        }), true);
    }

    assert.equal(await reservePasswordResetRequest({
        UserModel: reset.UserModel,
        user: reset.state,
        now: NOW,
    }), null);
});

test('an expired reset request window starts again at one', async () => {
    const reset = createResetRequestModel({
        code: 'expired-digest',
        expiry: PAST,
        counter: 3,
    });

    const reservation = await reservePasswordResetRequest({
        UserModel: reset.UserModel,
        user: reset.state,
        now: NOW,
    });

    assert.ok(reservation);
    assert.equal(reset.state.other_login.reset_password_counter, 1);
});

test('a failed reset email can conditionally restore the previous state', async () => {
    const previousCode = 'still-valid-legacy-digest';
    const reset = createResetRequestModel({
        code: previousCode,
        expiry: FUTURE,
        counter: 1,
    });
    const reservation = await reservePasswordResetRequest({
        UserModel: reset.UserModel,
        user: reset.state,
        now: NOW,
    });

    assert.equal(await rollbackPasswordResetRequest({
        UserModel: reset.UserModel,
        userId: USER_ID,
        tokenDigest: reservation.tokenDigest,
        requestClaimDigest: reservation.requestClaimDigest,
        expiresAt: reservation.expiresAt,
        previousState: reservation.previousState,
    }), true);
    assert.equal(
        reset.state.other_login.reset_password_code,
        previousCode,
    );
    assert.equal(reset.state.other_login.reset_password_expiry, FUTURE);
    assert.equal(reset.state.other_login.reset_password_counter, 1);
    assert.equal(
        'reset_password_claim' in reset.state.other_login,
        false,
    );
});

describe('session authentication versions', () => {
    const runVersionMiddleware = ({ sessionVersion, userVersion }) => {
        let logoutCalls = 0;
        let nextCalls = 0;
        const req = {
            user: { auth_version: userVersion },
            session: {},
            isAuthenticated() {
                return Boolean(this.user);
            },
            logout(callback) {
                logoutCalls += 1;
                this.user = undefined;
                callback();
            },
        };
        if (sessionVersion !== undefined) {
            req.session.auth_version = sessionVersion;
        }

        enforceSessionAuthVersion(req, {}, error => {
            assert.equal(error, undefined);
            nextCalls += 1;
        });

        return { logoutCalls, nextCalls, req };
    };

    test('missing auth_version behaves as zero', () => {
        assert.equal(effectiveAuthVersion(undefined), 0);
        assert.equal(effectiveAuthVersion({}), 0);
    });

    test('legacy session with no version and user version zero remains valid', () => {
        const result = runVersionMiddleware({ userVersion: undefined });
        assert.equal(result.logoutCalls, 0);
        assert.equal(result.nextCalls, 1);
        assert.ok(result.req.user);
    });

    test('legacy session with no version and user version one is logged out', () => {
        const result = runVersionMiddleware({ userVersion: 1 });
        assert.equal(result.logoutCalls, 1);
        assert.equal(result.nextCalls, 1);
        assert.equal(result.req.user, undefined);
    });

    test('matching versions remain valid and mismatched versions log out', () => {
        assert.equal(sessionAuthVersionMatches(3, 3), true);
        assert.equal(sessionAuthVersionMatches(2, 3), false);

        const matching = runVersionMiddleware({
            sessionVersion: 3,
            userVersion: 3,
        });
        const mismatched = runVersionMiddleware({
            sessionVersion: 2,
            userVersion: 3,
        });

        assert.equal(matching.logoutCalls, 0);
        assert.equal(mismatched.logoutCalls, 1);
    });

    test('a password change can preserve only its current session version', () => {
        const currentRequest = { session: { auth_version: 4 } };
        storeSessionAuthVersion(currentRequest, { auth_version: 5 });

        assert.equal(currentRequest.session.auth_version, 5);
        assert.equal(sessionAuthVersionMatches(
            currentRequest.session.auth_version,
            5,
        ), true);
        assert.equal(sessionAuthVersionMatches(4, 5), false);
    });
});
