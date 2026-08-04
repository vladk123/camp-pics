import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import ejs from 'ejs';
import mongoose from 'mongoose';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

import {
  MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE,
  MONTHLY_DRAW_ENTRY_DUPLICATE_MESSAGE,
  MONTHLY_DRAW_ENTRY_FAILURE_MESSAGE,
  MONTHLY_DRAW_ENTRY_SUCCESS_MESSAGE,
  MONTHLY_DRAW_ENTRY_VALIDATION_MESSAGE,
  MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE,
  createMonthlyDrawHandlers,
} from '../controllers/monthlyDraw.js';
import { MonthlyDrawNoUploadEntry } from '../models/monthlyDrawNoUploadEntry.js';
import otherRouter from '../routes/other.js';
import { isLoggedIn } from '../middleware.js';
import {
  MONTHLY_DRAW_RULES_VERSION,
  MONTHLY_DRAW_TIME_ZONE,
  buildMonthlyDrawNoUploadEntryId,
  deriveEasternMonthKey,
  formatMonthlyDrawPeriod,
  isNoUploadEntrantAccountEligible,
  isValidMonthKey,
  maySubmitNoUploadEntry,
  validateNoUploadEntryBody,
} from '../utils/monthlyDraw.js';
import {
  ROUTE_ABUSE_POLICIES,
  monthlyDrawEntryKeyGenerator,
  monthlyDrawNoUploadEntryLimiter,
} from '../utils/routeAbuseLimits.js';

const root = process.cwd();
const NOW = new Date('2026-08-03T16:00:00.000Z');
const USER_ID = new mongoose.Types.ObjectId('0123456789abcdef01234567');
const ENTRY_ID =
  'monthly-draw-no-upload:2026-08:0123456789abcdef01234567';
const hostile = '</p><script id="monthly-draw-xss">attack()</script>';

const read = relativePath => readFile(path.join(root, relativePath), 'utf8');

function routeFor(routePath) {
  return otherRouter.stack.find(layer => layer.route?.path === routePath)?.route;
}

function methodHandlers(route, method) {
  return route.stack
    .filter(layer => layer.method === method)
    .map(layer => layer.handle);
}

function validBody(overrides = {}) {
  return {
    _csrf: 'test-csrf-token',
    ageOfMajorityConfirmed: 'true',
    rulesAccepted: 'true',
    website: '',
    ...overrides,
  };
}

function responseRecorder() {
  const result = {};
  return {
    result,
    response: {
      render(view, locals) {
        result.view = view;
        result.locals = locals;
        return result;
      },
    },
  };
}

function flashRecorder() {
  const calls = [];
  return {
    calls,
    redirectWithFlash(...args) {
      calls.push(args.slice(2));
      return calls.length;
    },
  };
}

async function renderMonthlyDraw(locals) {
  return ejs.renderFile(path.join(root, 'views', 'other', 'monthlyDraw.ejs'), {
    layout() {},
    csrfToken: '<csrf-token>',
    currentPeriod: 'August 1–31, 2026 (Eastern Time)',
    rulesVersion: MONTHLY_DRAW_RULES_VERSION,
    entryStatusAvailable: true,
    emailVerified: false,
    accountEligible: false,
    alreadyEntered: false,
    maySubmitEntry: false,
    currentUser: null,
    ...locals,
  });
}

describe('monthly draw no-upload-entry model', () => {
  test('has exactly the privacy-minimal fields, defaults and immutable contract', () => {
    assert.deepEqual(Object.keys(MonthlyDrawNoUploadEntry.schema.paths), [
      '_id',
      'userId',
      'monthKey',
      'rulesVersion',
      'ageOfMajorityConfirmed',
      'rulesAccepted',
      'submittedAt',
      'createdAt',
      'updatedAt',
      '__v',
    ]);

    for (const field of [
      '_id',
      'userId',
      'monthKey',
      'rulesVersion',
      'ageOfMajorityConfirmed',
      'rulesAccepted',
      'submittedAt',
    ]) {
      assert.equal(MonthlyDrawNoUploadEntry.schema.path(field).options.immutable, true);
    }

    const entry = new MonthlyDrawNoUploadEntry({
      _id: ENTRY_ID,
      userId: USER_ID,
      monthKey: '2026-08',
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
      ageOfMajorityConfirmed: true,
      rulesAccepted: true,
    });
    assert.ok(entry.submittedAt instanceof Date);
    assert.equal(entry.validateSync(), undefined);
    assert.equal(MonthlyDrawNoUploadEntry.schema.options.timestamps, true);
    assert.equal(MonthlyDrawNoUploadEntry.schema.options.strict, 'throw');
  });

  test('requires the current rules version, valid month and both true confirmations', () => {
    const base = {
      _id: ENTRY_ID,
      userId: USER_ID,
      monthKey: '2026-08',
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
      ageOfMajorityConfirmed: true,
      rulesAccepted: true,
    };

    for (const invalid of [
      { monthKey: '2026-8' },
      { monthKey: '2026-13' },
      { rulesVersion: 'old-rules' },
      { ageOfMajorityConfirmed: false },
      { rulesAccepted: false },
    ]) {
      const error = new MonthlyDrawNoUploadEntry({ ...base, ...invalid })
        .validateSync();
      assert.ok(error);
    }
  });

  test('requires an exact deterministic string _id', () => {
    const base = {
      userId: USER_ID,
      monthKey: '2026-08',
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
      ageOfMajorityConfirmed: true,
      rulesAccepted: true,
    };
    const missingId = new MonthlyDrawNoUploadEntry(base).validateSync();
    const mismatchedId = new MonthlyDrawNoUploadEntry({
      ...base,
      _id: 'monthly-draw-no-upload:2026-07:0123456789abcdef01234567',
    }).validateSync();

    assert.equal(MonthlyDrawNoUploadEntry.schema.path('_id').instance, 'String');
    assert.ok(missingId?.errors?._id);
    assert.ok(mismatchedId?.errors?._id);
  });

  test('declares no custom indexes or automatic index behavior', async () => {
    assert.deepEqual(MonthlyDrawNoUploadEntry.schema.indexes(), []);
    const source = await read('models/monthlyDrawNoUploadEntry.js');
    assert.doesNotMatch(
      source,
      /\.index\s*\(|autoIndex|syncIndexes|ensureIndexes|createIndex/iu,
    );
  });

  test('does not store unnecessary entrant or device information', () => {
    const prohibited = [
      'phone', 'ip', 'userAgent', 'device', 'address', 'dateOfBirth',
      'province', 'giftCard', 'skillQuestion', 'email', 'username',
      'isAdmin',
    ];
    const storedFields = Object.keys(MonthlyDrawNoUploadEntry.schema.paths)
      .join(' ')
      .toLowerCase();
    for (const field of prohibited) {
      assert.equal(storedFields.includes(field.toLowerCase()), false, field);
    }
    assert.equal(MonthlyDrawNoUploadEntry.schema.options.expireAfterSeconds, undefined);
  });
});

describe('monthly draw time and form helpers', () => {
  test('uses the exact rules version and official Eastern time zone', () => {
    assert.equal(MONTHLY_DRAW_RULES_VERSION, '2026-08-03-v1');
    assert.equal(MONTHLY_DRAW_TIME_ZONE, 'America/Toronto');
  });

  test('derives month keys at Eastern midnight in standard and daylight time', () => {
    assert.equal(deriveEasternMonthKey(new Date('2026-03-01T04:59:59.999Z')), '2026-02');
    assert.equal(deriveEasternMonthKey(new Date('2026-03-01T05:00:00.000Z')), '2026-03');
    assert.equal(deriveEasternMonthKey(new Date('2026-07-01T03:59:59.999Z')), '2026-06');
    assert.equal(deriveEasternMonthKey(new Date('2026-07-01T04:00:00.000Z')), '2026-07');
    assert.equal(deriveEasternMonthKey(new Date('2026-11-01T03:59:59.999Z')), '2026-10');
    assert.equal(deriveEasternMonthKey(new Date('2026-11-01T04:00:00.000Z')), '2026-11');
  });

  test('rejects malformed month keys and formats deterministic monthly periods', () => {
    for (const value of [
      null, '', '2026-8', '26-08', '2026-00', '2026-13', '0000-01',
      '2026-08-extra', ' 2026-08',
    ]) assert.equal(isValidMonthKey(value), false, String(value));
    assert.equal(isValidMonthKey('2026-08'), true);
    assert.equal(formatMonthlyDrawPeriod('2026-02'), 'February 1–28, 2026 (Eastern Time)');
    assert.equal(formatMonthlyDrawPeriod('2028-02'), 'February 1–29, 2028 (Eastern Time)');
    assert.throws(() => formatMonthlyDrawPeriod('2026-2'), TypeError);
    assert.throws(() => deriveEasternMonthKey(new Date('invalid')), TypeError);
  });

  test('builds one stable deterministic entry ID from valid user and month input', () => {
    const lowercase = USER_ID.toHexString();
    const uppercase = lowercase.toUpperCase();

    assert.equal(buildMonthlyDrawNoUploadEntryId(USER_ID, '2026-08'), ENTRY_ID);
    assert.equal(buildMonthlyDrawNoUploadEntryId(lowercase, '2026-08'), ENTRY_ID);
    assert.equal(buildMonthlyDrawNoUploadEntryId(uppercase, '2026-08'), ENTRY_ID);
    assert.equal(
      buildMonthlyDrawNoUploadEntryId(USER_ID, '2026-08'),
      buildMonthlyDrawNoUploadEntryId(USER_ID, '2026-08'),
    );
    assert.notEqual(
      buildMonthlyDrawNoUploadEntryId(
        'fedcba987654321001234567',
        '2026-08',
      ),
      ENTRY_ID,
    );
    assert.notEqual(
      buildMonthlyDrawNoUploadEntryId(USER_ID, '2026-09'),
      ENTRY_ID,
    );
  });

  test('rejects malformed entry-ID user and month inputs', () => {
    for (const userId of [
      undefined,
      null,
      '',
      '0123456789abcdef0123456',
      '0123456789abcdef0123456g',
      {},
      { _bsontype: 'ObjectId', toHexString: () => 'invalid' },
    ]) {
      assert.throws(
        () => buildMonthlyDrawNoUploadEntryId(userId, '2026-08'),
        TypeError,
      );
    }
    for (const monthKey of [undefined, null, '', '2026-8', '2026-13']) {
      assert.throws(
        () => buildMonthlyDrawNoUploadEntryId(USER_ID, monthKey),
        TypeError,
      );
    }
  });

  test('allows only eligible verified non-administrator accounts to submit', () => {
    const user = { _id: USER_ID, email_verified: true, isAdmin: false };
    assert.equal(isNoUploadEntrantAccountEligible(user), true);
    assert.equal(isNoUploadEntrantAccountEligible({ ...user, isAdmin: true }), false);
    assert.equal(isNoUploadEntrantAccountEligible({ ...user, blocked: true }), false);
    assert.equal(isNoUploadEntrantAccountEligible({ ...user, email_verified: false }), false);
    assert.equal(isNoUploadEntrantAccountEligible({ email_verified: true }), false);
    assert.equal(maySubmitNoUploadEntry({ user }), true);
    assert.equal(maySubmitNoUploadEntry({ user: { ...user, isAdmin: true } }), false);
    assert.equal(maySubmitNoUploadEntry({ user, alreadyEntered: true }), false);
    assert.equal(maySubmitNoUploadEntry({ user, entryStatusAvailable: false }), false);
    assert.equal(maySubmitNoUploadEntry(), false);
  });

  test('accepts only the expected checkbox, CSRF and empty honeypot fields', () => {
    const accepted = validateNoUploadEntryBody(validBody());
    assert.equal(accepted.valid, true);
    assert.deepEqual(accepted.confirmations, {
      ageOfMajorityConfirmed: true,
      rulesAccepted: true,
    });
    for (const body of [
      null,
      [],
      { ageOfMajorityConfirmed: 'true', rulesAccepted: 'true' },
      validBody({ ageOfMajorityConfirmed: 'false' }),
      validBody({ rulesAccepted: ['true'] }),
      validBody({ website: 'bot' }),
      validBody({ _id: ENTRY_ID }),
      validBody({ userId: USER_ID.toString() }),
      validBody({ monthKey: '2026-08' }),
      validBody({ rulesVersion: MONTHLY_DRAW_RULES_VERSION }),
      validBody({ email: 'entrant@example.test' }),
      validBody({ revision: '1' }),
      validBody({ entryCount: '5' }),
    ]) assert.equal(validateNoUploadEntryBody(body).valid, false);
  });
});

describe('monthly draw routes and handlers', () => {
  test('registers one public GET and one authenticated, limited POST', async () => {
    const getRoute = routeFor('/monthly-draw');
    const postRoute = routeFor('/monthly-draw/no-upload-entry');
    assert.ok(getRoute);
    assert.ok(postRoute);
    assert.deepEqual(Object.keys(getRoute.methods), ['get']);
    assert.deepEqual(Object.keys(postRoute.methods), ['post']);
    assert.equal(methodHandlers(getRoute, 'get').length, 1);
    assert.deepEqual(methodHandlers(postRoute, 'post').slice(0, 2), [
      isLoggedIn,
      monthlyDrawNoUploadEntryLimiter,
    ]);
    assert.equal(methodHandlers(postRoute, 'post').length, 3);

    const appSource = await read('app.js');
    assert.ok(
      appSource.indexOf('app.use(csrfSynchronisedProtection)') <
      appSource.indexOf("app.use('/other', otherRoutes)"),
    );
  });

  test('the focused limiter uses five attempts per hour and safe account/IP keys', () => {
    assert.deepEqual(ROUTE_ABUSE_POLICIES.monthlyDrawNoUploadEntry, {
      windowMs: 60 * 60 * 1000,
      limit: 5,
    });
    assert.equal(
      monthlyDrawEntryKeyGenerator({ user: { _id: USER_ID }, ip: hostile }),
      `user:${USER_ID.toHexString()}`,
    );
    assert.equal(
      monthlyDrawEntryKeyGenerator({ user: null, ip: '203.0.113.7' }),
      'ip:203.0.113.7',
    );
    assert.equal(
      monthlyDrawEntryKeyGenerator({ user: null, ip: hostile }),
      'ip:invalid-client-ip',
    );
  });

  test('anonymous and unverified GETs never query entry records', async () => {
    const EntryModel = {
      exists() {
        throw new Error('Entry lookup must not run.');
      },
    };
    const handlers = createMonthlyDrawHandlers({
      EntryModel,
      currentTime: () => NOW,
    });

    for (const user of [undefined, { _id: USER_ID, email_verified: false }]) {
      const { result, response } = responseRecorder();
      await handlers.renderMonthlyDraw({ originalUrl: '/other/monthly-draw', user }, response);
      assert.equal(result.view, 'other/monthlyDraw');
      assert.equal(result.locals.currentPeriod, 'August 1–31, 2026 (Eastern Time)');
      assert.equal(result.locals.accountEligible, false);
      assert.equal(result.locals.alreadyEntered, false);
      assert.equal(result.locals.maySubmitEntry, false);
    }
  });

  test('administrator GET neither queries entries nor renders the entry form', async () => {
    let queries = 0;
    const handlers = createMonthlyDrawHandlers({
      EntryModel: {
        async exists() {
          queries += 1;
          return true;
        },
      },
      currentTime: () => NOW,
    });
    const administrator = {
      _id: USER_ID,
      email_verified: true,
      isAdmin: true,
    };
    const { result, response } = responseRecorder();
    await handlers.renderMonthlyDraw({
      originalUrl: '/other/monthly-draw',
      user: administrator,
    }, response);

    assert.equal(queries, 0);
    assert.equal(result.locals.accountEligible, false);
    assert.equal(result.locals.alreadyEntered, false);
    assert.equal(result.locals.maySubmitEntry, false);

    const html = await renderMonthlyDraw({
      ...result.locals,
      currentUser: administrator,
    });
    assert.match(
      html,
      /Administrator accounts are not eligible to enter the monthly draw\./u,
    );
    assert.doesNotMatch(html, /action="\/other\/monthly-draw\/no-upload-entry"/u);
  });

  test('verified GET queries only the current account/month and exposes a boolean', async () => {
    const queries = [];
    const rawEntry = { _id: hostile, secret: hostile };
    const handlers = createMonthlyDrawHandlers({
      EntryModel: {
        async exists(filter) {
          queries.push(filter);
          return rawEntry;
        },
      },
      currentTime: () => NOW,
    });
    const { result, response } = responseRecorder();
    await handlers.renderMonthlyDraw({
      originalUrl: '/other/monthly-draw',
      user: { _id: USER_ID, email_verified: true },
    }, response);

    assert.deepEqual(queries, [{ _id: ENTRY_ID }]);
    assert.equal(result.locals.accountEligible, true);
    assert.equal(result.locals.alreadyEntered, true);
    assert.equal(result.locals.maySubmitEntry, false);
    assert.equal(Object.values(result.locals).includes(rawEntry), false);
    assert.equal(JSON.stringify(result.locals).includes(hostile), false);
  });

  test('creates a server-authored entry and ignores no browser identity or period data', async () => {
    const created = [];
    const flash = flashRecorder();
    const handlers = createMonthlyDrawHandlers({
      EntryModel: { async create(value) { created.push(value); } },
      currentTime: () => NOW,
      redirectWithFlash: flash.redirectWithFlash,
    });
    const result = await handlers.submitNoUploadEntry({
      body: validBody(),
      user: { _id: USER_ID, email_verified: true },
    }, {});

    assert.equal(result, 1);
    assert.deepEqual(created, [{
      _id: ENTRY_ID,
      userId: USER_ID,
      monthKey: '2026-08',
      rulesVersion: MONTHLY_DRAW_RULES_VERSION,
      ageOfMajorityConfirmed: true,
      rulesAccepted: true,
    }]);
    assert.deepEqual(flash.calls[0], [
      'success',
      MONTHLY_DRAW_ENTRY_SUCCESS_MESSAGE,
      '/other/monthly-draw',
    ]);
  });

  test('forged administrator POST is rejected without any entry operation', async () => {
    let lookups = 0;
    let writes = 0;
    const logs = [];
    const flash = flashRecorder();
    const handlers = createMonthlyDrawHandlers({
      EntryModel: {
        async exists() { lookups += 1; },
        async create() { writes += 1; },
      },
      currentTime: () => NOW,
      log: async (...args) => logs.push(args),
      redirectWithFlash: flash.redirectWithFlash,
    });
    await handlers.submitNoUploadEntry({
      body: validBody(),
      user: { _id: USER_ID, email_verified: true, isAdmin: true },
    }, {});

    assert.equal(lookups, 0);
    assert.equal(writes, 0);
    assert.deepEqual(logs, []);
    assert.deepEqual(flash.calls, [[
      'error',
      MONTHLY_DRAW_ACCOUNT_INELIGIBLE_MESSAGE,
      '/other/monthly-draw',
    ]]);
  });

  test('rejects unexpected browser content without writing or logging it', async () => {
    let writes = 0;
    const logs = [];
    const flash = flashRecorder();
    const handlers = createMonthlyDrawHandlers({
      EntryModel: { async create() { writes += 1; } },
      currentTime: () => NOW,
      log: async (...args) => logs.push(args),
      redirectWithFlash: flash.redirectWithFlash,
    });
    await handlers.submitNoUploadEntry({
      body: validBody({ userId: hostile }),
      user: { _id: USER_ID, email_verified: true },
    }, {});

    assert.equal(writes, 0);
    assert.deepEqual(logs, []);
    assert.deepEqual(flash.calls[0], [
      'error',
      MONTHLY_DRAW_ENTRY_VALIDATION_MESSAGE,
      '/other/monthly-draw',
    ]);
    assert.equal(JSON.stringify(flash.calls).includes(hostile), false);
  });

  test('handles duplicate and operational database failures with fixed safe output', async () => {
    for (const fixture of [
      {
        thrown: Object.assign(new Error(hostile), { code: 11000, entry: hostile }),
        expectedFlash: ['info', MONTHLY_DRAW_ENTRY_DUPLICATE_MESSAGE, '/other/monthly-draw'],
        expectedLogs: 0,
      },
      {
        thrown: Object.assign(new Error(hostile), { code: 'DATABASE_DOWN', entry: hostile }),
        expectedFlash: ['error', MONTHLY_DRAW_ENTRY_FAILURE_MESSAGE, '/other/monthly-draw'],
        expectedLogs: 1,
      },
    ]) {
      const logs = [];
      const flash = flashRecorder();
      const handlers = createMonthlyDrawHandlers({
        EntryModel: { async create() { throw fixture.thrown; } },
        currentTime: () => NOW,
        log: async (...args) => logs.push(args),
        redirectWithFlash: flash.redirectWithFlash,
      });
      await handlers.submitNoUploadEntry({
        body: validBody(),
        user: { _id: USER_ID, email_verified: true },
      }, {});

      assert.deepEqual(flash.calls[0], fixture.expectedFlash);
      assert.equal(logs.length, fixture.expectedLogs);
      if (logs.length) {
        assert.deepEqual(logs[0], [
          null,
          null,
          'error',
          { message: MONTHLY_DRAW_OPERATIONAL_LOG_MESSAGE },
        ]);
      }
      const observable = JSON.stringify({ logs, flashes: flash.calls });
      assert.equal(observable.includes(hostile), false);
      assert.equal(observable.includes('DATABASE_DOWN'), false);
    }
  });
});

describe('monthly draw rendering and upload notices', () => {
  test('renders anonymous, unverified, eligible and already-entered states safely', async () => {
    const anonymous = await renderMonthlyDraw({});
    const unverified = await renderMonthlyDraw({
      currentUser: { _id: USER_ID, email_verified: false },
    });
    const eligible = await renderMonthlyDraw({
      currentUser: { _id: USER_ID, email_verified: true, isAdmin: false },
      emailVerified: true,
      accountEligible: true,
      maySubmitEntry: true,
    });
    const entered = await renderMonthlyDraw({
      currentUser: { _id: USER_ID, email_verified: true, isAdmin: false },
      emailVerified: true,
      accountEligible: true,
      alreadyEntered: true,
    });

    assert.match(anonymous, />Log in<\/a>/u);
    assert.match(anonymous, /verified email/u);
    assert.match(unverified, /Go to email verification/u);
    assert.match(eligible, /action="\/other\/monthly-draw\/no-upload-entry"/u);
    assert.match(eligible, /name="_csrf" value="&lt;csrf-token&gt;"/u);
    assert.match(eligible, /name="ageOfMajorityConfirmed"/u);
    assert.match(eligible, /name="rulesAccepted"/u);
    assert.match(eligible, /name="website" value=""/u);
    assert.match(entered, /Your no-upload entry for this month has been received\./u);
    assert.match(entered, /August 1–31, 2026 \(Eastern Time\)/u);
    assert.doesNotMatch(entered, /name="ageOfMajorityConfirmed"/u);
  });

  test('contains every required substantive rules disclosure', async () => {
    const html = await renderMonthlyDraw({});
    for (const heading of [
      'Sponsor', 'Eligibility', 'Entry period', 'Upload entry method',
      'No-upload entry method', 'Prize', 'Odds', 'Selection',
      'Contact and response', 'Skill-testing question', 'Winner announcement',
      'Disqualification', 'Privacy', 'General',
    ]) assert.match(html, new RegExp(`>${heading}<`, 'u'), heading);
    for (const disclosure of [
      'NO PURCHASE NECESSARY.',
      'legal residents of Canada, including Quebec',
      '12:00:00 a.m. Eastern Time',
      '11:59:59 p.m. Eastern Time',
      'one entry. There is no limit on the number of qualifying upload entries',
      'Uploads from eligible CampPics accounts are entered automatically',
      'CampPics may mark an upload ineligible',
      'approximate retail value of CAD $10',
      'digital Amazon.ca or Bass Pro Shops gift card',
      'The odds of being selected depend on the number of eligible entries received for that monthly draw.',
      'one primary selected entrant and up to two distinct ranked alternates',
      'when enough distinct eligible entrants exist',
      'seven calendar days',
      'mathematical skill-testing question',
      'No nickname or identifying information is published without consent',
      'No phone number is required',
      'void where prohibited',
      'Rules version 2026-08-03-v1',
    ]) assert.match(html, new RegExp(disclosure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'), disclosure);
  });

  test('has one h1, page-only CSS, no inline executable/style content and escaped values', async () => {
    const template = await read('views/other/monthlyDraw.ejs');
    const css = await read('public/css/monthlyDraw.css');
    const html = await renderMonthlyDraw({
      currentPeriod: hostile,
      rulesVersion: hostile,
    });
    assert.equal((template.match(/<h1\b/gu) || []).length, 1);
    assert.match(template, /href="\/css\/monthlyDraw\.css"/u);
    assert.doesNotMatch(template, /<script\b|<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu);
    assert.doesNotMatch(html, /<script id="monthly-draw-xss">/u);
    assert.match(html, /&lt;script id=&#34;monthly-draw-xss&#34;&gt;/u);
    assert.doesNotMatch(template, /type="(?:tel|date)"|name="(?:phone|dateOfBirth|province)"/iu);
    assert.match(css, /\[data-theme="dark"\]/u);
    assert.match(css, /:focus-visible/u);
    assert.match(css, /@media \(max-width: 576px\)/u);
    assert.match(css, /overflow-wrap: anywhere/u);

    const otherViews = (await readdir(path.join(root, 'views', 'other')))
      .filter(name => name.endsWith('.ejs') && name !== 'monthlyDraw.ejs');
    for (const view of otherViews) {
      assert.equal((await read(path.join('views', 'other', view))).includes('/css/monthlyDraw.css'), false);
    }
  });

  test('includes the shared notice exactly once in every upload form without behavior changes', async () => {
    const files = [
      'views/partials/modals/campsiteModalContent.ejs',
      'views/partials/modals/parkMediaUpload.ejs',
    ];
    let uploadFormCount = 0;
    for (const file of files) {
      const current = await read(file);
      const forms = current.match(/<form\b[^>]*\bupload-form\b[^>]*>[\s\S]*?<\/form>/gu) || [];
      for (const form of forms) {
        assert.equal(
          (form.match(/include\('\.\.\/monthlyDrawUploadNotice'\)/gu) || []).length,
          1,
          file,
        );
        uploadFormCount += 1;
      }
    }
    assert.equal(uploadFormCount, 4);

    const notice = await read('views/partials/monthlyDrawUploadNotice.ejs');
    assert.match(notice, /Qualifying photos and videos/u);
    assert.match(notice, /may earn one entry each/u);
    assert.match(notice, /href="\/other\/monthly-draw"/u);
    assert.doesNotMatch(notice, /every upload (?:earns|qualifies)|will earn/iu);
    assert.doesNotMatch(notice, /<script\b|<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu);
  });
});

describe('monthly draw source and scope guards', () => {
  test('keeps the endpoint HTML-only and new runtime files free of deferred features/services', async () => {
    const routeSource = await read('routes/other.js');
    const controllerSource = await read('controllers/monthlyDraw.js');
    const runtimeSource = [
      controllerSource,
      await read('models/monthlyDrawNoUploadEntry.js'),
      await read('utils/monthlyDraw.js'),
    ].join('\n');
    assert.doesNotMatch(`${routeSource}\n${controllerSource}`, /res\.json|\.json\s*\(/u);
    assert.doesNotMatch(runtimeSource, /cloudinary|mailgun|fetch\s*\(|axios|scheduler|cron|randomBytes|winnerEmail|skillQuestionAnswer/iu);
    assert.doesNotMatch(controllerSource, /req\.body\.(?:userId|monthKey|rulesVersion|email|revision|entryCount)/u);
    assert.doesNotMatch(controllerSource, /console\.|error\s*:/u);
  });

  test('leaves dependencies, engines and protected schemas unchanged', async () => {
    const packageJson = JSON.parse(await read('package.json'));
    const packageLock = JSON.parse(await read('package-lock.json'));
    const headPackage = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], {
      cwd: root,
      encoding: 'utf8',
    }));
    const headLock = JSON.parse(execFileSync('git', ['show', 'HEAD:package-lock.json'], {
      cwd: root,
      encoding: 'utf8',
    }));
    assert.deepEqual(packageJson.dependencies, headPackage.dependencies);
    assert.deepEqual(packageLock.packages, headLock.packages);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);

    const protectedSchemas = [
      'models/user.js',
      'models/park.js',
    ];
    const schemaStatus = execFileSync(
      'git',
      ['status', '--short', '--', ...protectedSchemas],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(schemaStatus.trim(), '');
  });
});
