import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PASSWORD_CONFIRMATION_MESSAGE } from '../utils/passwordPolicy.js';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const {
    createRegisterController,
    createResendVerificationController,
} = await import('../controllers/users.js');

const validRegistrationBody = overrides => ({
    username: 'camper@example.test',
    password: 'CampPics9!',
    password_repeat: 'CampPics9!',
    fname: 'Camper',
    website_user: '',
    hands_check: '5',
    ...overrides,
});

const createResponse = () => ({
    locals: { ip: '192.0.2.1' },
    redirect() {},
});

const createRedirectRecorder = () => {
    const calls = [];
    return {
        calls,
        redirectWithFlash(req, res, type, message, path, data) {
            const result = { type, message, path, data };
            calls.push(result);
            return result;
        },
    };
};

const createRegistrationHarness = ({
    createVerification,
    registerError,
    successRedirectError,
} = {}) => {
    const state = {
        registerCalls: 0,
        registeredPasswords: [],
        verificationCalls: 0,
        verificationTokens: [],
        tokenRollbacks: [],
        userRollbacks: [],
        logCalls: [],
    };

    class UserModel {
        constructor(data) {
            Object.assign(this, data);
        }

        static async register(user, password) {
            state.registerCalls += 1;
            state.registeredPasswords.push(password);
            if (registerError) {
                throw registerError;
            }
            user._id = 'new-user-id';
            return user;
        }

        static async findByIdAndDelete(userId) {
            state.userRollbacks.push(userId);
        }
    }

    const TokenModel = {
        async deleteMany(filter) {
            state.tokenRollbacks.push(filter);
            state.verificationTokens = [];
        },
    };
    const redirects = createRedirectRecorder();
    const verificationHandler = createVerification ?? (async () => {
        state.verificationTokens.push('delivered-verification-token');
        return {
            delivered: true,
            expiredTokenCleanupSucceeded: true,
        };
    });
    const controller = createRegisterController({
        UserModel,
        TokenModel,
        async createVerification(...args) {
            state.verificationCalls += 1;
            return verificationHandler(...args);
        },
        emailSender: async () => {},
        async log(...args) {
            state.logCalls.push(args);
        },
        redirectWithFlash(...args) {
            if (args[2] === 'success' && successRedirectError) {
                throw successRedirectError;
            }
            return redirects.redirectWithFlash(...args);
        },
    });

    return { controller, redirects, state };
};

test('registration accepts matching valid passwords', async () => {
    const harness = createRegistrationHarness();

    await harness.controller(
        { body: validRegistrationBody() },
        createResponse(),
        () => {},
    );

    assert.equal(harness.state.registerCalls, 1);
    assert.deepEqual(harness.state.registeredPasswords, ['CampPics9!']);
    assert.equal(harness.redirects.calls.at(-1).type, 'success');
    assert.equal(harness.redirects.calls.at(-1).path, '/user/registered');
});

test('user creation failure does not attempt verification-token delivery', async () => {
    const harness = createRegistrationHarness({
        registerError: new Error('simulated user creation failure'),
    });

    await harness.controller(
        { body: validRegistrationBody() },
        createResponse(),
        () => {},
    );

    assert.equal(harness.state.registerCalls, 1);
    assert.equal(harness.state.verificationCalls, 0);
    assert.deepEqual(harness.state.tokenRollbacks, []);
    assert.deepEqual(harness.state.userRollbacks, []);
    assert.equal(harness.redirects.calls.at(-1).type, 'error');
});

test('registration preserves the UserExistsError response', async () => {
    const userExistsError = new Error('existing user');
    userExistsError.name = 'UserExistsError';
    const harness = createRegistrationHarness({
        registerError: userExistsError,
    });

    await harness.controller(
        { body: validRegistrationBody() },
        createResponse(),
        () => {},
    );

    assert.equal(harness.state.verificationCalls, 0);
    assert.equal(
        harness.redirects.calls.at(-1).message,
        'User already exists.',
    );
});

test('registration rejects mismatched passwords before User.register', async () => {
    const harness = createRegistrationHarness();

    await harness.controller(
        {
            body: validRegistrationBody({
                password_repeat: 'Different9!',
            }),
        },
        createResponse(),
        () => {},
    );

    assert.equal(harness.state.registerCalls, 0);
    assert.equal(
        harness.redirects.calls.at(-1).message,
        PASSWORD_CONFIRMATION_MESSAGE,
    );
});

test('registration rejects a missing confirmation before User.register', async () => {
    const harness = createRegistrationHarness();
    const body = validRegistrationBody();
    delete body.password_repeat;

    await harness.controller(
        { body },
        createResponse(),
        () => {},
    );

    assert.equal(harness.state.registerCalls, 0);
    assert.equal(
        harness.redirects.calls.at(-1).message,
        PASSWORD_CONFIRMATION_MESSAGE,
    );
});

test('registration rejects non-string confirmation values before User.register', async t => {
    for (const passwordRepeat of [null, 9, {}, []]) {
        await t.test(JSON.stringify(passwordRepeat), async () => {
            const harness = createRegistrationHarness();

            await harness.controller(
                {
                    body: validRegistrationBody({
                        password_repeat: passwordRepeat,
                    }),
                },
                createResponse(),
                () => {},
            );

            assert.equal(harness.state.registerCalls, 0);
            assert.equal(
                harness.redirects.calls.at(-1).message,
                PASSWORD_CONFIRMATION_MESSAGE,
            );
        });
    }
});

test('registration rolls back after verification creation or delivery failure', async t => {
    for (const failure of ['token creation', 'email delivery']) {
        await t.test(failure, async () => {
            const harness = createRegistrationHarness({
                async createVerification() {
                    throw new Error(`simulated ${failure} failure`);
                },
            });

            await harness.controller(
                { body: validRegistrationBody() },
                createResponse(),
                () => {},
            );

            assert.equal(harness.state.registerCalls, 1);
            assert.equal(harness.state.verificationCalls, 1);
            assert.deepEqual(harness.state.tokenRollbacks, [{
                user_id: 'new-user-id',
            }]);
            assert.deepEqual(harness.state.userRollbacks, ['new-user-id']);
            assert.equal(harness.redirects.calls.at(-1).type, 'error');
        });
    }
});

test('registration does not roll back after delivery succeeds and cleanup fails', async () => {
    const harness = createRegistrationHarness({
        async createVerification() {
            return {
                delivered: true,
                expiredTokenCleanupSucceeded: false,
            };
        },
    });

    await harness.controller(
        { body: validRegistrationBody() },
        createResponse(),
        () => {},
    );

    assert.equal(harness.state.registerCalls, 1);
    assert.deepEqual(harness.state.tokenRollbacks, []);
    assert.deepEqual(harness.state.userRollbacks, []);
    assert.equal(harness.redirects.calls.at(-1).type, 'success');
});

test('a throwing success redirect propagates without rolling back delivered registration', async () => {
    const responseError = new Error('simulated success redirect failure');
    const harness = createRegistrationHarness({
        successRedirectError: responseError,
    });

    await assert.rejects(
        harness.controller(
            { body: validRegistrationBody() },
            createResponse(),
            () => {},
        ),
        error => error === responseError,
    );

    assert.equal(harness.state.verificationCalls, 1);
    assert.deepEqual(
        harness.state.verificationTokens,
        ['delivered-verification-token'],
    );
    assert.deepEqual(harness.state.tokenRollbacks, []);
    assert.deepEqual(harness.state.userRollbacks, []);
});

const createResendHarness = ({ createVerification }) => {
    const state = {
        resendCounter: 0,
        rollbackCalls: 0,
        logCalls: [],
    };
    const redirects = createRedirectRecorder();
    const UserModel = {
        async findById() {
            return null;
        },
    };
    const controller = createResendVerificationController({
        UserModel,
        async reserveResend() {
            state.resendCounter += 1;
            return {
                _id: 'existing-user-id',
                username: 'camper@example.test',
                token_counter: state.resendCounter,
            };
        },
        async rollbackResend() {
            state.rollbackCalls += 1;
            state.resendCounter -= 1;
        },
        createVerification,
        emailSender: async () => {},
        async log(...args) {
            state.logCalls.push(args);
        },
        redirectWithFlash: redirects.redirectWithFlash,
        maxVerificationResends: 2,
    });

    return { controller, redirects, state };
};

const resendRequest = {
    user: {
        _id: 'existing-user-id',
        username: 'camper@example.test',
        email_verified: false,
    },
};

test('resend rolls back its allowance after verification delivery failure', async () => {
    const harness = createResendHarness({
        async createVerification() {
            throw new Error('simulated verification delivery failure');
        },
    });

    await harness.controller(resendRequest, createResponse(), () => {});

    assert.equal(harness.state.rollbackCalls, 1);
    assert.equal(harness.state.resendCounter, 0);
    assert.equal(harness.redirects.calls.at(-1).type, 'error');
});

test('resend remains sent and consumed after delivery succeeds and cleanup fails', async () => {
    const harness = createResendHarness({
        async createVerification() {
            return {
                delivered: true,
                expiredTokenCleanupSucceeded: false,
            };
        },
    });

    await harness.controller(resendRequest, createResponse(), () => {});

    assert.equal(harness.state.rollbackCalls, 0);
    assert.equal(harness.state.resendCounter, 1);
    assert.equal(harness.redirects.calls.at(-1).type, 'info');
});
