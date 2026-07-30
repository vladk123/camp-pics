import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    PASSWORD_CONFIRMATION_MESSAGE,
    PASSWORD_POLICY_MESSAGE,
    isPasswordAllowed,
    validatePassword,
} from '../utils/passwordPolicy.js';

test('password policy accepts valid and ordinary symbol-containing passwords', () => {
    for (const password of [
        'CampPics1',
        'Ordinary-symbols_9!',
        'Spaces are Okay 7A',
        'Quotes"and\'symbols4Z',
    ]) {
        assert.equal(isPasswordAllowed(password), true, password);
        assert.deepEqual(validatePassword(password, password), {
            valid: true,
            message: null,
        });
    }
});

test('password policy rejects a missing uppercase letter', () => {
    assert.equal(isPasswordAllowed('camppics1'), false);
    assert.equal(validatePassword('camppics1').message, PASSWORD_POLICY_MESSAGE);
});

test('password policy rejects a missing lowercase letter', () => {
    assert.equal(isPasswordAllowed('CAMP-PICS1'), false);
});

test('password policy rejects a missing digit', () => {
    assert.equal(isPasswordAllowed('CampPictures'), false);
});

test('password policy rejects fewer than 8 characters', () => {
    assert.equal(isPasswordAllowed('Camp1Aa'), false);
});

test('password policy rejects more than 30 characters', () => {
    assert.equal(isPasswordAllowed(`Aa1${'x'.repeat(28)}`), false);
});

test('password confirmation mismatch has a stable result', () => {
    assert.deepEqual(validatePassword('CampPics1!', 'CampPics2!'), {
        valid: false,
        message: PASSWORD_CONFIRMATION_MESSAGE,
    });
});
