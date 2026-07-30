import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
    EMAIL_VERIFICATION_TOKEN_TTL_MS,
    generateAuthenticationToken,
    hashAuthenticationToken,
    isWellFormedAuthenticationToken,
} from '../utils/authTokens.js';
import { createNewUserVerify } from '../utils/createNewUserVerify.js';
import { Token } from '../models/token.js';

test('authentication tokens are nonempty, URL-safe, and independently generated', () => {
    const first = generateAuthenticationToken();
    const second = generateAuthenticationToken();

    assert.match(first, /^[A-Za-z0-9_-]+$/);
    assert.ok(first.length > 0);
    assert.match(second, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(first, second);
});

test('authentication token hashing is deterministic and token-specific', () => {
    const first = 'legacyToken_123';
    const second = 'legacyToken_456';

    assert.equal(
        hashAuthenticationToken(first),
        hashAuthenticationToken(first),
    );
    assert.notEqual(
        hashAuthenticationToken(first),
        hashAuthenticationToken(second),
    );
});

test('malformed authentication tokens are rejected safely', () => {
    for (const value of [
        undefined,
        null,
        '',
        'contains spaces',
        'contains/slash',
        'contains?query',
        'x'.repeat(513),
    ]) {
        assert.equal(isWellFormedAuthenticationToken(value), false);
        assert.equal(hashAuthenticationToken(value), null);
    }
});

test('Token.date uses a per-document default function', () => {
    assert.equal(Token.schema.path('date').defaultValue, Date.now);
});

test('authentication helpers and callers do not use Math.random', async () => {
    const authenticationFiles = [
        'utils/authTokens.js',
        'utils/authLifecycle.js',
        'utils/createNewUserVerify.js',
        'controllers/users.js',
    ];

    for (const file of authenticationFiles) {
        const source = await readFile(
            new URL(`../${file}`, import.meta.url),
            'utf8',
        );
        assert.equal(source.includes('Math.random'), false, file);
    }
});

const createTokenModel = ({
    saveFails = false,
    cleanupFails = false,
    initialDocuments = [{
        _id: 1,
        user_id: 'user-id',
        email_verification_code: 'previous-digest',
        email_verification_expiry: new Date('2026-07-29T13:00:00.000Z'),
    }],
} = {}) => {
    let nextId = initialDocuments.reduce(
        (highest, document) => Math.max(highest, document._id),
        0,
    ) + 1;

    class FakeToken {
        static documents = initialDocuments.map(document => ({ ...document }));

        constructor(data) {
            Object.assign(this, data);
            this._id = nextId;
            nextId += 1;
        }

        async save() {
            if (saveFails) {
                throw new Error('simulated token-save failure');
            }
            FakeToken.documents.push(this);
            return this;
        }

        static async deleteMany(filter) {
            FakeToken.deleteManyCalls.push(filter);
            if (cleanupFails) {
                throw new Error('simulated expired-token cleanup failure');
            }

            FakeToken.documents = FakeToken.documents.filter(document => {
                const isSameUser = document.user_id === filter.user_id;
                const isNewToken = document._id === filter._id?.$ne;
                const expiry = document.email_verification_expiry;
                const isExpired =
                    expiry instanceof Date &&
                    expiry <= filter.email_verification_expiry?.$lte;

                return !isSameUser || isNewToken || !isExpired;
            });
        }

        static async deleteOne(filter) {
            FakeToken.deleteOneCalls.push(filter);
            FakeToken.documents = FakeToken.documents.filter(
                document => document._id !== filter._id,
            );
        }
    }

    FakeToken.deleteManyCalls = [];
    FakeToken.deleteOneCalls = [];
    return FakeToken;
};

const CREATE_NOW = new Date('2026-07-29T12:00:00.000Z');
const CLEANUP_NOW = new Date('2026-07-29T12:05:00.000Z');

test('verification token-save failure sends no email', async () => {
    const TokenModel = createTokenModel({ saveFails: true });
    let sendCalls = 0;

    await assert.rejects(
        createNewUserVerify({
            userId: 'user-id',
            username: 'camper@example.test',
            TokenModel,
            async send() {
                sendCalls += 1;
            },
        }),
        /simulated token-save failure/,
    );

    assert.equal(sendCalls, 0);
    assert.deepEqual(
        TokenModel.documents.map(document => document._id),
        [1],
    );
    assert.equal(TokenModel.deleteOneCalls.length, 0);
});

test('verification creation stores only a digest and preserves an active older token', async () => {
    const TokenModel = createTokenModel();
    let emailedToken;

    const result = await createNewUserVerify({
        userId: 'user-id',
        username: 'camper@example.test',
        TokenModel,
        now: CREATE_NOW,
        cleanupNow: CLEANUP_NOW,
        async send({ templateData }) {
            emailedToken = templateData.verificationToken;
            assert.equal(TokenModel.documents.length, 2);
            assert.equal(
                TokenModel.documents.some(
                    document => document.email_verification_code ===
                        'previous-digest',
                ),
                true,
            );
        },
    });

    assert.deepEqual(result, {
        delivered: true,
        expiredTokenCleanupSucceeded: true,
    });
    assert.equal(TokenModel.documents.length, 2);
    const storedToken = TokenModel.documents.find(
        document => document._id === 2,
    );
    assert.notEqual(storedToken.email_verification_code, emailedToken);
    assert.equal(
        storedToken.email_verification_code,
        hashAuthenticationToken(emailedToken),
    );
    assert.equal(
        storedToken.email_verification_expiry.getTime(),
        CREATE_NOW.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS,
    );
    assert.equal(
        TokenModel.documents.some(document => document._id === 1),
        true,
    );
    assert.deepEqual(TokenModel.deleteManyCalls, [{
        user_id: 'user-id',
        _id: { $ne: 2 },
        email_verification_expiry: { $lte: CLEANUP_NOW },
    }]);
});

test('failed verification delivery removes only the new token', async () => {
    const TokenModel = createTokenModel();

    await assert.rejects(
        createNewUserVerify({
            userId: 'user-id',
            username: 'camper@example.test',
            TokenModel,
            async send() {
                throw new Error('simulated delivery failure');
            },
        }),
    );

    assert.deepEqual(
        TokenModel.documents.map(document => document._id),
        [1],
    );
    assert.deepEqual(TokenModel.deleteOneCalls, [{ _id: 2 }]);
    assert.equal(TokenModel.deleteManyCalls.length, 0);
});

test('successful delivery removes expired tokens but preserves active and new tokens', async () => {
    const TokenModel = createTokenModel({
        initialDocuments: [
            {
                _id: 1,
                user_id: 'user-id',
                email_verification_code: 'expired-digest',
                email_verification_expiry: CLEANUP_NOW,
            },
            {
                _id: 2,
                user_id: 'user-id',
                email_verification_code: 'active-older-digest',
                email_verification_expiry:
                    new Date('2026-07-29T13:00:00.000Z'),
            },
        ],
    });

    const result = await createNewUserVerify({
        userId: 'user-id',
        username: 'camper@example.test',
        TokenModel,
        now: CREATE_NOW,
        cleanupNow: CLEANUP_NOW,
        async send() {},
    });

    assert.deepEqual(result, {
        delivered: true,
        expiredTokenCleanupSucceeded: true,
    });
    assert.deepEqual(
        TokenModel.documents.map(document => document._id),
        [2, 3],
    );
    assert.equal(TokenModel.deleteOneCalls.length, 0);
});

test('successful verification delivery remains successful when expired-token cleanup fails', async () => {
    const TokenModel = createTokenModel({ cleanupFails: true });
    const operationalLogArguments = [];
    let emailedToken;

    const result = await createNewUserVerify({
        userId: 'user-id',
        username: 'camper@example.test',
        TokenModel,
        cleanupNow: CLEANUP_NOW,
        async send({ templateData }) {
            emailedToken = templateData.verificationToken;
        },
        async onExpiredTokenCleanupError(...args) {
            operationalLogArguments.push(args);
        },
    });

    assert.deepEqual(result, {
        delivered: true,
        expiredTokenCleanupSucceeded: false,
    });
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.deepEqual(
        TokenModel.documents.map(document => document._id),
        [1, 2],
    );
    assert.equal(TokenModel.deleteOneCalls.length, 0);
    assert.deepEqual(operationalLogArguments, [[]]);
    assert.equal(
        JSON.stringify(operationalLogArguments).includes(emailedToken),
        false,
    );
    assert.equal(
        JSON.stringify(operationalLogArguments).includes(
            TokenModel.documents[1].email_verification_code,
        ),
        false,
    );
});

const createDeferred = () => {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const runOverlappingDeliveries = async firstToFinish => {
    const TokenModel = createTokenModel({ initialDocuments: [] });
    const enteredDelivery = {
        A: createDeferred(),
        B: createDeferred(),
    };
    const releaseDelivery = {
        A: createDeferred(),
        B: createDeferred(),
    };
    const rawTokens = {};

    const startOperation = label => createNewUserVerify({
        userId: 'user-id',
        username: 'camper@example.test',
        TokenModel,
        now: CREATE_NOW,
        cleanupNow: CLEANUP_NOW,
        async send({ templateData }) {
            rawTokens[label] = templateData.verificationToken;
            enteredDelivery[label].resolve();
            await releaseDelivery[label].promise;
        },
    });

    const operationA = startOperation('A');
    await enteredDelivery.A.promise;
    const operationB = startOperation('B');
    await enteredDelivery.B.promise;

    releaseDelivery[firstToFinish].resolve();
    const firstResult = await (
        firstToFinish === 'A' ? operationA : operationB
    );

    assert.deepEqual(firstResult, {
        delivered: true,
        expiredTokenCleanupSucceeded: true,
    });
    assert.deepEqual(
        TokenModel.documents.map(document => document._id),
        [1, 2],
    );

    const lastToFinish = firstToFinish === 'A' ? 'B' : 'A';
    releaseDelivery[lastToFinish].resolve();
    const lastResult = await (
        lastToFinish === 'A' ? operationA : operationB
    );

    assert.deepEqual(lastResult, {
        delivered: true,
        expiredTokenCleanupSucceeded: true,
    });
    assert.deepEqual(
        TokenModel.documents.map(document => document._id),
        [1, 2],
    );
    assert.deepEqual(
        TokenModel.documents
            .map(document => document.email_verification_code)
            .sort(),
        [
            hashAuthenticationToken(rawTokens.A),
            hashAuthenticationToken(rawTokens.B),
        ].sort(),
    );

    return { TokenModel, rawTokens };
};

test('overlapping sends preserve both tokens when B delivers before A', async () => {
    await runOverlappingDeliveries('B');
});

test('overlapping sends preserve both tokens when A delivers before B', async () => {
    await runOverlappingDeliveries('A');
});
