import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';

const root = process.cwd();
const accountFilename = path.join(root, 'views/user/account.ejs');
const read = relativePath => readFile(path.join(root, relativePath), 'utf8');
const stripHtmlComments = source => source.replace(/<!--[\s\S]*?-->/gu, '');

async function renderAccount(currentUser, data = {}) {
  return ejs.render(await read('views/user/account.ejs'), {
    csrfToken: 'account-csrf-token',
    currentUser,
    data: {
      currentPath: '/user/account',
      verificationResendsRemaining: 3,
      ...data,
    },
    layout: () => {},
  }, { filename: accountFilename });
}

describe('account page deletion presentation', () => {
  test('normal users retain the complete two-step deletion workflow', async () => {
    const html = stripHtmlComments(await renderAccount({
      email_verified: true,
      fname: 'Camper',
      isAdmin: false,
      username: 'camper@example.test',
    }));

    assert.match(
      html,
      /Deleting your account will permanently delete all of your uploaded media\. This action cannot be undone\./u,
    );
    assert.doesNotMatch(html, /Deleting the your account/u);
    assert.match(html, /id="delete-account-btn"[^>]*>Delete Account<\/button>/u);
    assert.equal((html.match(/id="delete-account-modal"/gu) || []).length, 1);
    assert.equal((html.match(/id="delete-account-modal-2"/gu) || []).length, 1);
    assert.match(html, /id="delete-account-modal-backdrop-insert"/u);

    const deletionForm = html.match(
      /<form action="\/user\/delete-account" method="post">[\s\S]*?<\/form>/u,
    )?.[0];
    assert.ok(deletionForm);
    assert.match(
      deletionForm,
      /<input type="hidden" name="_csrf" value="account-csrf-token">/u,
    );
    assert.match(deletionForm, /id="delete-account-current-password"/u);
    assert.match(deletionForm, /name="current_password"/u);
    assert.match(deletionForm, /autocomplete="current-password"/u);
    assert.match(deletionForm, /\brequired\b/u);
    assert.match(html, /id="change-password-form"/u);
    assert.match(html, /<script type="text\/javascript" src="\/js\/account\.js"><\/script>/u);
    assert.doesNotMatch(
      html,
      /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/iu,
    );
  });

  test('administrators receive only the compact deletion notice', async () => {
    const html = stripHtmlComments(await renderAccount({
      email_verified: true,
      fname: 'Administrator',
      isAdmin: true,
      username: 'administrator@example.test',
    }));

    assert.match(html, /<h2>Account deletion<\/h2>/u);
    assert.match(
      html,
      /Administrator accounts cannot be deleted from this page\./u,
    );
    assert.doesNotMatch(html, /id="delete-account-btn"/u);
    assert.doesNotMatch(html, /id="delete-account-modal(?:-2)?"/u);
    assert.doesNotMatch(html, /id="delete-account-modal-backdrop-insert"/u);
    assert.doesNotMatch(html, /action="\/user\/delete-account"/u);
    assert.doesNotMatch(html, /id="delete-account-current-password"/u);
    assert.doesNotMatch(html, /name="current_password"/u);
    assert.match(html, /id="change-password-form"/u);
    assert.match(html, /<script type="text\/javascript" src="\/js\/account\.js"><\/script>/u);
  });

  test('email-verification presentation remains unchanged for unverified users', async () => {
    const html = stripHtmlComments(await renderAccount({
      email_verified: false,
      fname: 'Camper',
      isAdmin: false,
      username: 'camper@example.test',
    }, { verificationResendsRemaining: 2 }));

    assert.match(html, /<h2>Verify Your Account Email<\/h2>/u);
    assert.match(html, /You have 2 verification resend\(s\) remaining\./u);
    assert.match(
      html,
      /<form action="\/user\/resend-verification" method="post">/u,
    );
    assert.doesNotMatch(html, /id="change-password-form"/u);
    assert.match(html, /id="delete-account-btn"/u);
  });
});

describe('administrator account browser initialization', () => {
  test('account.js safely no-ops when all deletion markup is absent', async () => {
    const source = await read('public/js/account.js');
    const passwordBindings = [];
    const document = {
      getElementById() { return null; },
      querySelectorAll() { return []; },
    };
    const window = {
      CampPicsPasswordPolicy: {
        bindPasswordForm(options) {
          passwordBindings.push(options);
          return null;
        },
      },
    };
    const initialWindowKeys = Object.keys(window).sort();

    assert.doesNotThrow(() => vm.runInNewContext(source, { document, window }));
    assert.equal(passwordBindings.length, 1);
    assert.deepEqual(
      Object.values(passwordBindings[0]),
      [null, null, null],
    );
    assert.deepEqual(Object.keys(window).sort(), initialWindowKeys);
  });
});
