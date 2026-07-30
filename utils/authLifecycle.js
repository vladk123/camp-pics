import {
    generateAuthenticationToken,
    hashAuthenticationToken,
    PASSWORD_RESET_TOKEN_TTL_MS,
} from './authTokens.js';

export const MAX_VERIFICATION_RESENDS = 2;
export const MAX_PASSWORD_RESET_EMAILS = 3;

const RESET_CODE_PATH = 'other_login.reset_password_code';
const RESET_EXPIRY_PATH = 'other_login.reset_password_expiry';
const RESET_COUNTER_PATH = 'other_login.reset_password_counter';
const RESET_CLAIM_PATH = 'other_login.reset_password_claim';

const isStrictObjectIdString = value =>
    typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);

const valueAtPath = (document, path) => {
    if (typeof document?.get === 'function') {
        return document.get(path);
    }

    return path.split('.').reduce(
        (value, key) => value?.[key],
        document,
    );
};

const hasPersistedPath = (document, path) => {
    if (typeof document?.$isDefault === 'function' && document.$isDefault(path)) {
        return false;
    }

    return valueAtPath(document, path) !== undefined;
};

const asTime = value => {
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
};

const resetStateFromUser = user => ({
    code: valueAtPath(user, RESET_CODE_PATH),
    expiry: valueAtPath(user, RESET_EXPIRY_PATH),
    counter: valueAtPath(user, RESET_COUNTER_PATH),
    claim: valueAtPath(user, RESET_CLAIM_PATH),
    hasCode: hasPersistedPath(user, RESET_CODE_PATH),
    hasExpiry: hasPersistedPath(user, RESET_EXPIRY_PATH),
    hasCounter: hasPersistedPath(user, RESET_COUNTER_PATH),
    hasClaim: hasPersistedPath(user, RESET_CLAIM_PATH),
});

const normalizedResetCounter = value =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;

const isActiveResetState = (state, now) =>
    typeof state.code === 'string' &&
    state.code.length > 0 &&
    state.hasExpiry &&
    asTime(state.expiry) > now.getTime();

const unclaimedResetFilter = {
    $or: [
        { [RESET_CLAIM_PATH]: { $exists: false } },
        { [RESET_CLAIM_PATH]: null },
    ],
};

const updateMatched = result =>
    Boolean(result && (
        result.matchedCount > 0 ||
        result.modifiedCount > 0 ||
        result.n > 0
    ));

export const effectiveAuthVersion = value => {
    const version = typeof value === 'object' && value !== null
        ? value.auth_version
        : value;

    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
};

export const sessionAuthVersionMatches = (sessionVersion, userVersion) => {
    const normalizedSessionVersion = sessionVersion === undefined
        ? 0
        : (
            Number.isSafeInteger(sessionVersion) && sessionVersion >= 0
                ? sessionVersion
                : null
        );

    return normalizedSessionVersion !== null &&
        normalizedSessionVersion === effectiveAuthVersion(userVersion);
};

export const storeSessionAuthVersion = (req, user) => {
    if (req?.session) {
        req.session.auth_version = effectiveAuthVersion(user);
    }
};

export const isPasswordResetEligibleUser = user =>
    Boolean(
        user &&
        user.blocked !== true &&
        typeof valueAtPath(user, 'username') === 'string' &&
        typeof valueAtPath(user, 'hash') === 'string' &&
        typeof valueAtPath(user, 'salt') === 'string',
    );

export const consumeVerificationToken = async ({
    TokenModel,
    UserModel,
    rawToken,
    now = new Date(),
}) => {
    const digest = hashAuthenticationToken(rawToken);
    if (!digest) {
        return { status: 'invalid' };
    }

    const token = await TokenModel.findOneAndDelete({
        email_verification_code: digest,
        email_verification_expiry: { $gt: now },
    });

    if (!token) {
        await TokenModel.deleteOne({
            email_verification_code: digest,
            email_verification_expiry: { $lte: now },
        });
        return { status: 'invalid' };
    }

    const user = await UserModel.findOneAndUpdate(
        {
            _id: token.user_id,
            email_verified: { $ne: true },
        },
        { $set: { email_verified: true } },
        { new: true },
    );

    if (!user) {
        await TokenModel.deleteMany({ user_id: token.user_id });
        return { status: 'invalid' };
    }

    await TokenModel.deleteMany({ user_id: token.user_id });
    return { status: 'verified', user };
};

export const reserveVerificationResend = ({
    UserModel,
    userId,
}) => UserModel.findOneAndUpdate(
    {
        _id: userId,
        email_verified: { $ne: true },
        $or: [
            { token_counter: { $exists: false } },
            { token_counter: { $lt: MAX_VERIFICATION_RESENDS } },
        ],
    },
    { $inc: { token_counter: 1 } },
    { new: true },
);

export const rollbackVerificationResend = ({
    UserModel,
    userId,
}) => UserModel.updateOne(
    {
        _id: userId,
        email_verified: { $ne: true },
        token_counter: { $gt: 0 },
    },
    { $inc: { token_counter: -1 } },
);

const resetReservationFilter = ({ userId, state, active, now }) => {
    const conditions = [
        { _id: userId },
        { blocked: { $ne: true } },
    ];

    if (state.hasCode) {
        conditions.push({ [RESET_CODE_PATH]: state.code });
    } else {
        conditions.push({
            $or: [
                { [RESET_CODE_PATH]: { $exists: false } },
                { [RESET_CODE_PATH]: null },
                { [RESET_CODE_PATH]: '' },
            ],
        });
    }

    if (state.hasExpiry) {
        conditions.push({ [RESET_EXPIRY_PATH]: state.expiry });
    } else {
        conditions.push({ [RESET_EXPIRY_PATH]: { $exists: false } });
    }

    if (active) {
        conditions.push(unclaimedResetFilter);
        if (state.hasCounter) {
            conditions.push({ [RESET_COUNTER_PATH]: state.counter });
        } else {
            conditions.push({ [RESET_COUNTER_PATH]: { $exists: false } });
        }
        conditions.push({ [RESET_EXPIRY_PATH]: { $gt: now } });
    }

    return conditions.length === 1 ? conditions[0] : { $and: conditions };
};

export const reservePasswordResetRequest = async ({
    UserModel,
    user,
    now = new Date(),
}) => {
    if (!isPasswordResetEligibleUser(user)) {
        return null;
    }

    const rawToken = generateAuthenticationToken();
    const tokenDigest = hashAuthenticationToken(rawToken);
    const requestClaimDigest = hashAuthenticationToken(generateAuthenticationToken());
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);
    let candidate = user;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!isPasswordResetEligibleUser(candidate)) {
            return null;
        }

        const previousState = resetStateFromUser(candidate);
        const active = isActiveResetState(previousState, now);
        const previousCounter = normalizedResetCounter(previousState.counter);

        if (
            active &&
            (
                previousCounter >= MAX_PASSWORD_RESET_EMAILS ||
                (previousState.hasClaim && previousState.claim)
            )
        ) {
            return null;
        }

        const previousUser = await UserModel.findOneAndUpdate(
            resetReservationFilter({
                userId: candidate._id,
                state: previousState,
                active,
                now,
            }),
            {
                $set: {
                    [RESET_CODE_PATH]: tokenDigest,
                    [RESET_EXPIRY_PATH]: expiresAt,
                    [RESET_COUNTER_PATH]: active ? previousCounter + 1 : 1,
                    [RESET_CLAIM_PATH]: requestClaimDigest,
                },
            },
            { new: false },
        );

        if (previousUser) {
            return {
                user: previousUser,
                rawToken,
                tokenDigest,
                requestClaimDigest,
                expiresAt,
                previousState: resetStateFromUser(previousUser),
            };
        }

        candidate = await UserModel.findById(candidate._id);
    }

    return null;
};

export const finalizePasswordResetRequest = async ({
    UserModel,
    userId,
    tokenDigest,
    requestClaimDigest,
    expiresAt,
}) => {
    const result = await UserModel.updateOne(
        {
            _id: userId,
            [RESET_CODE_PATH]: tokenDigest,
            [RESET_EXPIRY_PATH]: expiresAt,
            [RESET_CLAIM_PATH]: requestClaimDigest,
        },
        { $unset: { [RESET_CLAIM_PATH]: 1 } },
    );

    return updateMatched(result);
};

export const rollbackPasswordResetRequest = async ({
    UserModel,
    userId,
    tokenDigest,
    requestClaimDigest,
    expiresAt,
    previousState,
}) => {
    const $set = {};
    const $unset = {};

    for (const [path, value, present] of [
        [RESET_CODE_PATH, previousState.code, previousState.hasCode],
        [RESET_EXPIRY_PATH, previousState.expiry, previousState.hasExpiry],
        [RESET_COUNTER_PATH, previousState.counter, previousState.hasCounter],
        [RESET_CLAIM_PATH, previousState.claim, previousState.hasClaim],
    ]) {
        if (present) {
            $set[path] = value;
        } else {
            $unset[path] = 1;
        }
    }

    const update = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    const result = await UserModel.updateOne(
        {
            _id: userId,
            [RESET_CODE_PATH]: tokenDigest,
            [RESET_EXPIRY_PATH]: expiresAt,
            [RESET_CLAIM_PATH]: requestClaimDigest,
        },
        update,
    );

    return updateMatched(result);
};

export const findValidPasswordReset = async ({
    UserModel,
    userId,
    rawToken,
    now = new Date(),
}) => {
    if (!isStrictObjectIdString(userId)) {
        return null;
    }

    const tokenDigest = hashAuthenticationToken(rawToken);
    if (!tokenDigest) {
        return null;
    }

    return UserModel.findOne({
        _id: userId,
        blocked: { $ne: true },
        [RESET_CODE_PATH]: tokenDigest,
        [RESET_EXPIRY_PATH]: { $gt: now },
        ...unclaimedResetFilter,
    });
};

export const claimPasswordReset = async ({
    UserModel,
    userId,
    rawToken,
    now = new Date(),
}) => {
    if (!isStrictObjectIdString(userId)) {
        return null;
    }

    const tokenDigest = hashAuthenticationToken(rawToken);
    if (!tokenDigest) {
        return null;
    }

    const claimDigest = hashAuthenticationToken(generateAuthenticationToken());
    const user = await UserModel.findOneAndUpdate(
        {
            _id: userId,
            blocked: { $ne: true },
            [RESET_CODE_PATH]: tokenDigest,
            [RESET_EXPIRY_PATH]: { $gt: now },
            ...unclaimedResetFilter,
        },
        { $set: { [RESET_CLAIM_PATH]: claimDigest } },
        { new: true },
    );

    return user ? { user, tokenDigest, claimDigest } : null;
};

export const releasePasswordResetClaim = ({
    UserModel,
    userId,
    tokenDigest,
    claimDigest,
}) => UserModel.updateOne(
    {
        _id: userId,
        [RESET_CODE_PATH]: tokenDigest,
        [RESET_CLAIM_PATH]: claimDigest,
    },
    { $unset: { [RESET_CLAIM_PATH]: 1 } },
);

export const completePasswordReset = ({
    UserModel,
    claimed,
    now = new Date(),
}) => UserModel.findOneAndUpdate(
    {
        _id: claimed.user._id,
        [RESET_CODE_PATH]: claimed.tokenDigest,
        [RESET_EXPIRY_PATH]: { $gt: now },
        [RESET_CLAIM_PATH]: claimed.claimDigest,
    },
    {
        $set: {
            hash: valueAtPath(claimed.user, 'hash'),
            salt: valueAtPath(claimed.user, 'salt'),
            attempts: 0,
            [RESET_COUNTER_PATH]: 0,
        },
        $unset: {
            [RESET_CODE_PATH]: 1,
            [RESET_EXPIRY_PATH]: 1,
            [RESET_CLAIM_PATH]: 1,
        },
        $inc: { auth_version: 1 },
    },
    { new: true },
);

export const resetPasswordWithClaim = async ({
    UserModel,
    userId,
    rawToken,
    newPassword,
    now = new Date(),
}) => {
    const claimed = await claimPasswordReset({
        UserModel,
        userId,
        rawToken,
        now,
    });

    if (!claimed) {
        return { status: 'invalid' };
    }

    try {
        await claimed.user.setPassword(newPassword);
        const updatedUser = await completePasswordReset({
            UserModel,
            claimed,
            now,
        });

        if (!updatedUser) {
            await releasePasswordResetClaim({
                UserModel,
                userId,
                tokenDigest: claimed.tokenDigest,
                claimDigest: claimed.claimDigest,
            });
            return { status: 'failed' };
        }

        return { status: 'success', user: updatedUser };
    } catch {
        try {
            await releasePasswordResetClaim({
                UserModel,
                userId,
                tokenDigest: claimed.tokenDigest,
                claimDigest: claimed.claimDigest,
            });
        } catch {
            // The original reset failure remains authoritative.
        }
        return { status: 'failed' };
    }
};
