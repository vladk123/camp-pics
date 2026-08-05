import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';

import {
  ADMIN_SITE_ANNOUNCEMENT_PROJECTION,
  createAdminAnnouncementGetHandler,
  createAdminAnnouncementPostHandler,
} from '../controllers/siteAnnouncements.js';
import { SiteAnnouncement } from '../models/siteAnnouncement.js';
import { isAdmin } from '../middleware.js';
import adminRouter from '../routes/admin.js';
import {
  SITE_ANNOUNCEMENT_DEFAULTS,
  SITE_ANNOUNCEMENT_KEY,
  getSiteAnnouncementStatus,
  hasPublicSiteAnnouncementChanged,
  isSiteAnnouncementActive,
  isValidInternalCtaUrl,
  normalizeSiteAnnouncementForm,
  serializePublicSiteAnnouncement,
} from '../utils/siteAnnouncement.js';
import {
  PUBLIC_SITE_ANNOUNCEMENT_PROJECTION,
  createSiteAnnouncementMiddleware,
  shouldLoadSiteAnnouncement,
} from '../utils/siteAnnouncementMiddleware.js';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';

const root = process.cwd();
const read = relativePath => readFile(path.join(root, relativePath), 'utf8');
const NOW = new Date('2026-08-03T12:00:00.000Z');
const hostile = '</textarea><script id="announcement-xss">attack()</script> "quotes" & ' +
  `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`;

function findCssRule(css, selector) {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split(',')
      .map(value => value.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

function selectorSpecificity(selector) {
  let remaining = selector;
  const specificity = [0, 0, 0];
  for (const match of selector.matchAll(/:not\(([^)]*)\)/gu)) {
    const argumentSpecificities = match[1]
      .split(',')
      .map(argument => selectorSpecificity(argument.trim()))
      .sort((left, right) => {
        for (let index = 0; index < left.length; index += 1) {
          if (left[index] !== right[index]) return right[index] - left[index];
        }
        return 0;
      });
    argumentSpecificities[0].forEach((value, index) => {
      specificity[index] += value;
    });
  }
  remaining = remaining.replace(/:not\([^)]*\)/gu, '');
  specificity[0] += (remaining.match(/#[a-z0-9_-]+/giu) || []).length;
  specificity[1] += (remaining.match(/\.[a-z0-9_-]+/giu) || []).length;
  specificity[1] += (remaining.match(/\[[^\]]+\]/gu) || []).length;
  specificity[1] += (remaining.match(/:(?!:)[a-z0-9_-]+/giu) || []).length;
  specificity[2] += (
    remaining.match(/(?:^|[\s>+~])(?:[a-z][a-z0-9-]*)/giu) || []
  ).length;
  return specificity;
}

function validForm(overrides = {}) {
  return {
    _csrf: 'test-token',
    enabled: 'true',
    title: 'CampPics update',
    message: 'First line\nSecond line',
    autoOpen: 'true',
    showNavLink: 'true',
    navLinkText: 'Announcement',
    ctaLabel: '',
    ctaUrl: '',
    startsOn: '',
    endsOn: '',
    ...overrides,
  };
}

function activeRecord(overrides = {}) {
  return {
    _id: 'database-id-must-not-leak',
    key: SITE_ANNOUNCEMENT_KEY,
    enabled: true,
    title: 'CampPics update',
    message: 'First line\nSecond line',
    autoOpen: true,
    showNavLink: true,
    navLinkText: 'Announcement',
    ctaLabel: 'View parks',
    ctaUrl: '/camp/all-parks?from=announcement#parks',
    startsOn: null,
    endsOn: null,
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function renderPublicAnnouncementPage({ announcement, data }) {
  const filename = path.join(root, 'views/layouts/boilerplate.ejs');
  return ejs.render(await read('views/layouts/boilerplate.ejs'), {
    body: '',
    canonicalUrl: null,
    cspNonce: 'test-csp-nonce',
    csrfToken: 'test-csrf-token',
    currentUser: null,
    data,
    error: [],
    ga4EventJson: 'null',
    info: [],
    meta: { title: 'Announcement rendering' },
    siteAnnouncement: announcement,
    success: [],
    warning: [],
  }, { filename });
}

function renderedAnnouncementAutoOpen(html) {
  const value = html.match(
    /data-announcement-auto-open="(true|false)"/u,
  )?.[1];
  assert.ok(value, 'rendered announcement auto-open value is required');
  return value === 'true';
}

function queryReturning(value, calls = []) {
  return {
    select(projection) {
      calls.push({ projection });
      return this;
    },
    async lean() {
      return value;
    },
  };
}

function routeFor(routePath) {
  return adminRouter.stack.find(layer => layer.route?.path === routePath)?.route;
}

describe('site announcement model and shared validation', () => {
  test('defines the fixed singleton key and safe defaults with only one index', () => {
    const document = new SiteAnnouncement();
    assert.equal(document.key, SITE_ANNOUNCEMENT_KEY);
    assert.equal(document.enabled, false);
    assert.equal(document.autoOpen, true);
    assert.equal(document.showNavLink, true);
    assert.equal(document.navLinkText, 'Announcement');
    assert.equal(document.revision, 1);
    assert.equal(document.validateSync(), undefined);

    const keyOptions = SiteAnnouncement.schema.path('key').options;
    assert.equal(keyOptions.required, true);
    assert.equal(keyOptions.unique, true);
    assert.equal(keyOptions.immutable, true);
    assert.deepEqual(keyOptions.enum, [SITE_ANNOUNCEMENT_KEY]);
    assert.deepEqual(
      SiteAnnouncement.schema.indexes().map(([index]) => index),
      [{ key: 1 }],
    );
    assert.equal(SiteAnnouncement.schema.options.timestamps, true);
  });

  test('enforces enabled fields, visibility, paired CTA, dates and revision', () => {
    const cases = [
      { enabled: true },
      { enabled: true, title: 'Title', message: 'Message', autoOpen: false, showNavLink: false },
      { enabled: true, title: 'Title', message: 'Message', showNavLink: true, navLinkText: '' },
      { ctaLabel: 'Go', ctaUrl: '' },
      { ctaLabel: 'Go', ctaUrl: 'https://example.test' },
      { startsOn: new Date('2026-08-04'), endsOn: new Date('2026-08-03') },
      { revision: 0 },
      { revision: 1.5 },
    ];
    for (const data of cases) {
      assert.ok(new SiteAnnouncement(data).validateSync(), JSON.stringify(data));
    }
  });

  test('enforces every requested text limit', () => {
    for (const [field, maximum] of [
      ['title', 80],
      ['message', 1200],
      ['navLinkText', 30],
      ['ctaLabel', 40],
      ['ctaUrl', 300],
    ]) {
      const data = { [field]: 'x'.repeat(maximum + 1) };
      if (field === 'ctaLabel') data.ctaUrl = '/internal';
      if (field === 'ctaUrl') data.ctaLabel = 'Go';
      assert.ok(new SiteAnnouncement(data).validateSync(), field);
    }
  });

  test('accepts safe internal CTA URLs and rejects external or malformed forms', () => {
    for (const value of [
      '/',
      '/camp/all-parks',
      '/camp/search?q=lake#results',
      '/path/%E2%9C%93',
    ]) assert.equal(isValidInternalCtaUrl(value), true, value);

    for (const value of [
      'https://camppics.ca/camp',
      'http://example.test',
      '//example.test/path',
      '/\\example.test',
      '/path\\next',
      '/path%5cnext',
      '/bad%zz',
      '/line\nfeed',
      '/line%0afeed',
      'relative/path',
      ' /camp',
    ]) assert.equal(isValidInternalCtaUrl(value), false, value);
  });

  test('normalizes explicit booleans and UTC date-only boundaries', () => {
    const result = normalizeSiteAnnouncementForm(validForm({
      startsOn: '2026-08-03',
      endsOn: '2026-08-05',
    }));
    assert.equal(result.valid, true);
    assert.equal(result.announcement.startsOn.toISOString(), '2026-08-03T00:00:00.000Z');
    assert.equal(result.announcement.endsOn.toISOString(), '2026-08-05T23:59:59.999Z');
    assert.equal(result.showAgain, false);

    const disabled = normalizeSiteAnnouncementForm({
      title: '', message: '', navLinkText: '', ctaLabel: '', ctaUrl: '',
      startsOn: '', endsOn: '',
    });
    assert.equal(disabled.valid, true);
    assert.equal(disabled.announcement.enabled, false);
    assert.equal(disabled.announcement.autoOpen, false);
    assert.equal(disabled.announcement.showNavLink, false);
  });

  test('rejects unknown, array, malformed boolean, pairing and date inputs', () => {
    for (const body of [
      validForm({ revision: '99' }),
      validForm({ title: ['array'] }),
      validForm({ enabled: 'false' }),
      validForm({ ctaLabel: 'Go', ctaUrl: '' }),
      validForm({ ctaLabel: 'Go', ctaUrl: '//example.test' }),
      validForm({ startsOn: '2026-02-30' }),
      validForm({ startsOn: '2026-08-04', endsOn: '2026-08-03' }),
      validForm({ autoOpen: undefined, showNavLink: undefined }),
    ]) assert.equal(normalizeSiteAnnouncementForm(body).valid, false);
  });

  test('derives active state/status and compares every revision-driving field', () => {
    assert.equal(isSiteAnnouncementActive(activeRecord(), NOW), true);
    assert.equal(isSiteAnnouncementActive(activeRecord({ enabled: false }), NOW), false);
    assert.equal(isSiteAnnouncementActive(activeRecord({ startsOn: new Date('2026-08-04') }), NOW), false);
    assert.equal(isSiteAnnouncementActive(activeRecord({ endsOn: new Date('2026-08-02T23:59:59.999Z') }), NOW), false);
    assert.equal(getSiteAnnouncementStatus(activeRecord({ enabled: false }), NOW), 'Disabled');
    assert.equal(getSiteAnnouncementStatus(activeRecord({ startsOn: new Date('2026-08-04') }), NOW), 'Scheduled');
    assert.equal(getSiteAnnouncementStatus(activeRecord(), NOW), 'Active');
    assert.equal(getSiteAnnouncementStatus(activeRecord({ endsOn: new Date('2026-08-02') }), NOW), 'Expired');

    const next = { ...activeRecord() };
    assert.equal(hasPublicSiteAnnouncementChanged(activeRecord(), next), false);
    for (const field of [
      'enabled', 'title', 'message', 'autoOpen', 'showNavLink', 'navLinkText',
      'ctaLabel', 'ctaUrl', 'startsOn', 'endsOn',
    ]) {
      const changed = { ...next, [field]: field.endsWith('On') ? NOW : `changed-${field}` };
      assert.equal(hasPublicSiteAnnouncementChanged(activeRecord(), changed), true, field);
    }
  });

  test('public serialization exposes exactly the safe visitor contract', () => {
    const serialized = serializePublicSiteAnnouncement(activeRecord());
    assert.deepEqual(Object.keys(serialized), [
      'key', 'title', 'message', 'autoOpen', 'showNavLink', 'navLinkText',
      'ctaLabel', 'ctaUrl', 'revision',
    ]);
    assert.equal('_id' in serialized, false);
    assert.equal('enabled' in serialized, false);
    assert.equal('startsOn' in serialized, false);
    assert.equal('updatedAt' in serialized, false);
    assert.equal(serializePublicSiteAnnouncement(activeRecord({ revision: 0 })), null);
    assert.equal(serializePublicSiteAnnouncement(activeRecord({ ctaUrl: '//evil.test' })), null);
  });
});

describe('administrator route and controller contract', () => {
  test('registers GET and POST with authorization first and the existing limiter on POST', () => {
    const route = routeFor('/announcements');
    assert.ok(route);
    assert.deepEqual(Object.keys(route.methods), ['get', 'post']);
    const getHandlers = route.stack.filter(layer => layer.method === 'get');
    const postHandlers = route.stack.filter(layer => layer.method === 'post');
    assert.strictEqual(getHandlers[0].handle, isAdmin);
    assert.equal(getHandlers.length, 2);
    assert.strictEqual(postHandlers[0].handle, isAdmin);
    assert.strictEqual(postHandlers[1].handle, adminUserStatusLimiter);
    assert.equal(postHandlers.length, 3);
  });

  test('has no public write alias and remains behind global CSRF protection', async () => {
    const [app, campRoutes, otherRoutes, userRoutes] = await Promise.all([
      read('app.js'),
      read('routes/camp.js'),
      read('routes/other.js'),
      read('routes/users.js'),
    ]);
    assert.doesNotMatch(`${campRoutes}\n${otherRoutes}\n${userRoutes}`, /announcements/iu);
    assert.ok(
      app.indexOf('app.use(csrfSynchronisedProtection)') <
        app.indexOf("app.use('/a', adminRoutes)"),
    );
  });

  test('GET queries only the singleton and renders safe defaults or derived status', async () => {
    const calls = [];
    const handler = createAdminAnnouncementGetHandler({
      AnnouncementModel: {
        findOne(filter) {
          calls.push({ filter });
          return queryReturning(null, calls);
        },
      },
      now: () => NOW,
    });
    const rendered = [];
    await handler({}, { render(view, locals) { rendered.push({ view, locals }); } });
    assert.deepEqual(calls[0], { filter: { key: SITE_ANNOUNCEMENT_KEY } });
    assert.strictEqual(calls[1].projection, ADMIN_SITE_ANNOUNCEMENT_PROJECTION);
    assert.equal(rendered[0].view, 'admin/announcements');
    assert.deepEqual(rendered[0].locals.announcement, {
      ...SITE_ANNOUNCEMENT_DEFAULTS,
      startsOn: '',
      endsOn: '',
    });
    assert.equal(rendered[0].locals.announcementStatus, 'Disabled');
    assert.equal(rendered[0].locals.currentPath, '/a/announcements');
  });

  function createPostHarness(current) {
    const calls = { find: [], updates: [], redirects: [], logs: [] };
    const model = {
      findOne(filter) {
        calls.find.push(filter);
        return queryReturning(current);
      },
      async findOneAndUpdate(...args) {
        calls.updates.push(args);
        return args[1].$set;
      },
    };
    const handler = createAdminAnnouncementPostHandler({
      AnnouncementModel: model,
      log: async (...args) => calls.logs.push(args),
      redirectWithFlash: async (...args) => {
        calls.redirects.push(args);
        return calls;
      },
    });
    return { calls, handler };
  }

  test('upserts only the fixed singleton with Mongoose 8 validation options', async () => {
    const { calls, handler } = createPostHarness(null);
    await handler({ body: validForm() }, {});
    assert.deepEqual(calls.find, [{ key: SITE_ANNOUNCEMENT_KEY }]);
    assert.equal(calls.updates.length, 1);
    const [filter, update, options] = calls.updates[0];
    assert.deepEqual(filter, { key: SITE_ANNOUNCEMENT_KEY });
    assert.deepEqual(update.$setOnInsert, { key: SITE_ANNOUNCEMENT_KEY });
    assert.equal(update.$set.revision, 1);
    assert.equal('key' in update.$set, false);
    assert.equal(options.new, true);
    assert.equal(options.upsert, true);
    assert.equal(options.runValidators, true);
    assert.equal(options.setDefaultsOnInsert, true);
    assert.strictEqual(options.projection, ADMIN_SITE_ANNOUNCEMENT_PROJECTION);
    assert.equal(calls.redirects[0][2], 'success');
    assert.equal(calls.redirects[0][4], '/a/announcements');
  });

  test('preserves revision for a no-op and increments for edits, state, schedule, or Show again', async () => {
    const current = activeRecord({
      ctaLabel: '',
      ctaUrl: '',
      revision: 8,
    });
    const cases = [
      [validForm(), 8],
      [validForm({ title: 'Edited' }), 9],
      [validForm(), 9],
      [validForm({ startsOn: '2026-08-04' }), 9],
      [validForm({ showAgain: 'true' }), 9],
    ];
    delete cases[2][0].enabled;
    for (const [body, revision] of cases) {
      const { calls, handler } = createPostHarness(current);
      await handler({ body }, {});
      assert.equal(calls.updates[0][1].$set.revision, revision);
    }
  });

  test('validation rejects unexpected content before reads or writes', async () => {
    const { calls, handler } = createPostHarness(activeRecord());
    await handler({ body: validForm({ revision: '100', unknown: hostile }) }, {});
    assert.equal(calls.find.length, 0);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.logs.length, 0);
    assert.equal(calls.redirects[0][2], 'error');
    assert.equal(calls.redirects[0][3], 'Announcement settings were invalid.');
  });

  test('database failure logging contains one fixed message and no raw content', async () => {
    const calls = [];
    const handler = createAdminAnnouncementPostHandler({
      AnnouncementModel: {
        findOne() {
          return queryReturning(activeRecord());
        },
        async findOneAndUpdate() {
          throw new Error(hostile);
        },
      },
      log: async (...args) => calls.push(args),
      redirectWithFlash: async () => {},
    });
    await handler({ body: validForm({ message: hostile }) }, {});
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [null, null, 'error', {
      message: 'Admin announcement save failed.',
    }]);
    assert.equal(JSON.stringify(calls).includes(hostile), false);
  });
});

describe('public announcement middleware', () => {
  function invoke(record, request = {}) {
    const calls = { finds: [], logs: [], next: 0, projections: [] };
    const middleware = createSiteAnnouncementMiddleware({
      AnnouncementModel: {
        findOne(filter) {
          calls.finds.push(filter);
          return queryReturning(record, calls.projections);
        },
      },
      log: async (...args) => calls.logs.push(args),
      now: () => NOW,
    });
    const req = {
      method: 'GET',
      path: '/',
      headers: { accept: 'text/html' },
      ...request,
    };
    const res = { locals: {} };
    return middleware(req, res, () => { calls.next += 1; }).then(() => ({ calls, res }));
  }

  test('loads and serializes an active singleton without raw document metadata', async () => {
    const { calls, res } = await invoke(activeRecord());
    assert.deepEqual(calls.finds, [{ key: SITE_ANNOUNCEMENT_KEY }]);
    assert.strictEqual(calls.projections[0].projection, PUBLIC_SITE_ANNOUNCEMENT_PROJECTION);
    assert.deepEqual(res.locals.siteAnnouncement, serializePublicSiteAnnouncement(activeRecord()));
    assert.equal('_id' in res.locals.siteAnnouncement, false);
    assert.equal(calls.next, 1);
  });

  test('is installed once after request security and before rendered routes', async () => {
    const app = await read('app.js');
    const staticIndex = app.indexOf('app.use(express.static');
    const botBlockerIndex = app.indexOf('app.use(createBotUrlBlocker({');
    const csrfLocalsIndex = app.indexOf('app.use(exposeCsrfToken)');
    const announcementIndex = app.indexOf('app.use(loadSiteAnnouncement)');
    const firstRouteIndex = app.indexOf("app.use('/user', userRoutes)");
    assert.equal((app.match(/app\.use\(loadSiteAnnouncement\);/gu) || []).length, 1);
    assert.ok(staticIndex >= 0);
    assert.ok(botBlockerIndex >= 0);
    assert.ok(csrfLocalsIndex >= 0);
    assert.ok(announcementIndex > staticIndex);
    assert.ok(announcementIndex > botBlockerIndex);
    assert.ok(announcementIndex > csrfLocalsIndex);
    assert.ok(firstRouteIndex > announcementIndex);
  });

  test('hides disabled, future and expired announcements', async () => {
    for (const record of [
      activeRecord({ enabled: false }),
      activeRecord({ startsOn: new Date('2026-08-04') }),
      activeRecord({ endsOn: new Date('2026-08-02T23:59:59.999Z') }),
    ]) {
      assert.equal((await invoke(record)).res.locals.siteAnnouncement, null);
    }
  });

  test('skips JSON APIs, static paths and non-GET requests without querying', async () => {
    const requests = [
      { path: '/css/general.css' },
      { path: '/images/logo.png' },
      { path: '/camp/search-api' },
      { path: '/camp/park/park/media' },
      { path: '/camp/park/park/campsite/1' },
      { path: '/sitemap.xml' },
      { headers: { accept: 'application/json' } },
      { method: 'POST' },
      { xhr: true },
    ];
    for (const request of requests) {
      const { calls, res } = await invoke(activeRecord(), request);
      assert.equal(calls.finds.length, 0, JSON.stringify(request));
      assert.equal(res.locals.siteAnnouncement, null);
    }
    assert.equal(shouldLoadSiteAnnouncement({
      method: 'GET', path: '/other/faq', headers: { accept: 'text/html' },
    }), true);
  });

  test('fails open with null and exactly one fixed safe operational log', async () => {
    const logs = [];
    const middleware = createSiteAnnouncementMiddleware({
      AnnouncementModel: {
        findOne() {
          return {
            select() { return this; },
            async lean() { throw new Error(hostile); },
          };
        },
      },
      log: async (...args) => logs.push(args),
    });
    const res = { locals: {} };
    let nextCalls = 0;
    await middleware(
      { method: 'GET', path: '/', headers: { accept: 'text/html' } },
      res,
      () => { nextCalls += 1; },
    );
    assert.equal(nextCalls, 1);
    assert.equal(res.locals.siteAnnouncement, null);
    assert.deepEqual(logs, [[null, null, 'error', {
      message: 'Site announcement lookup failed.',
    }]]);
    assert.equal(JSON.stringify(logs).includes(hostile), false);
  });
});

describe('announcement rendering', () => {
  test('public and preview CTAs keep explicit readable colours in every link state', async () => {
    const [generalCss, publicCss, adminCss] = await Promise.all([
      read('public/css/general.css'),
      read('public/css/siteAnnouncement.css'),
      read('public/css/adminAnnouncements.css'),
    ]);
    const genericSelector = generalCss.match(
      /a:not\(\.btn-primary, \.btn-secondary\)/u,
    )?.[0];
    assert.ok(genericSelector);

    const publicNormalSelector =
      '.site-announcement-dialog a.site-announcement-dialog__cta';
    const publicVisitedSelector = `${publicNormalSelector}:visited`;
    const publicHoverSelector = `${publicNormalSelector}:hover`;
    const publicFocusSelector = `${publicNormalSelector}:focus-visible`;
    const publicActiveSelector = `${publicNormalSelector}:active`;
    const publicNormalRule = findCssRule(publicCss, publicNormalSelector);
    const publicVisitedRule = findCssRule(publicCss, publicVisitedSelector);
    const publicHoverRule = findCssRule(publicCss, publicHoverSelector);
    const publicFocusRule = findCssRule(publicCss, publicFocusSelector);
    const publicActiveRule = findCssRule(publicCss, publicActiveSelector);
    for (const rule of [publicNormalRule, publicVisitedRule]) {
      assert.match(rule, /background:\s*var\(--orange\)\s*;/u);
      assert.match(rule, /color:\s*#fff\s*;/u);
    }
    for (const rule of [publicHoverRule, publicFocusRule, publicActiveRule]) {
      assert.match(rule, /background:\s*var\(--darker-orange\)\s*;/u);
      assert.match(rule, /color:\s*#fff\s*;/u);
    }
    assert.deepEqual(selectorSpecificity(genericSelector), [0, 1, 1]);
    assert.deepEqual(selectorSpecificity(publicNormalSelector), [0, 2, 1]);
    assert.ok(
      selectorSpecificity(publicNormalSelector)[1] >
        selectorSpecificity(genericSelector)[1],
    );
    assert.match(
      publicCss,
      /\.site-announcement-dialog__cta:focus-visible,[\s\S]*?outline:\s*3px solid var\(--yellow\)/u,
    );

    const previewNormalSelector =
      '.admin-announcement-preview a.admin-announcement-preview__cta';
    const previewRules = {
      normal: findCssRule(adminCss, previewNormalSelector),
      visited: findCssRule(adminCss, `${previewNormalSelector}:visited`),
      hover: findCssRule(adminCss, `${previewNormalSelector}:hover`),
      focus: findCssRule(adminCss, `${previewNormalSelector}:focus-visible`),
      active: findCssRule(adminCss, `${previewNormalSelector}:active`),
    };
    for (const rule of [previewRules.normal, previewRules.visited]) {
      assert.match(rule, /background:\s*var\(--orange\)\s*;/u);
      assert.match(rule, /color:\s*#fff\s*;/u);
    }
    for (const rule of [
      previewRules.hover,
      previewRules.focus,
      previewRules.active,
    ]) {
      assert.match(rule, /background:\s*var\(--darker-orange\)\s*;/u);
      assert.match(rule, /color:\s*#fff\s*;/u);
    }
    assert.deepEqual(selectorSpecificity(previewNormalSelector), [0, 2, 1]);
    assert.doesNotMatch(`${publicCss}\n${adminCss}`, /!important/iu);
  });

  test('admin content is escaped and contains one CSRF form with external assets', async () => {
    const filename = path.join(root, 'views/admin/announcements.ejs');
    const source = await read('views/admin/announcements.ejs');
    const html = ejs.render(source, {
      layout() {},
      announcement: {
        ...SITE_ANNOUNCEMENT_DEFAULTS,
        title: hostile,
        message: hostile,
        navLinkText: hostile.slice(0, 30),
        ctaLabel: hostile.slice(0, 40),
        ctaUrl: '/safe?value=%22quoted%22&next=1',
        startsOn: '',
        endsOn: '',
      },
      announcementStatus: 'Active',
      csrfToken: 'csrf-token',
      currentPath: '/a/announcements',
    }, { filename });
    assert.match(html, /<h1>Site-wide announcement<\/h1>/u);
    assert.match(html, /name="_csrf" value="csrf-token"/u);
    assert.equal(html.includes('<script id="announcement-xss">'), false);
    assert.match(html, /&lt;script id=&#34;announcement-xss&#34;&gt;/u);
    assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)|\sstyle=|\son[a-z]+=/iu);
    assert.match(source, /src="\/js\/adminAnnouncements\.js"/u);
    assert.match(source, /Enabling this announcement publishes it across CampPics when its schedule is active\./u);
  });

  test('public partial escapes hostile plain text and keeps the CTA internal', async () => {
    const filename = path.join(root, 'views/partials/siteAnnouncement.ejs');
    const html = ejs.render(await read('views/partials/siteAnnouncement.ejs'), {
      siteAnnouncement: {
        ...serializePublicSiteAnnouncement(activeRecord()),
        title: hostile,
        message: hostile,
      },
    }, { filename });
    assert.equal(html.includes('<script id="announcement-xss">'), false);
    assert.match(html, /&lt;script id=&#34;announcement-xss&#34;&gt;/u);
    assert.equal((html.match(/<h2\b/gu) || []).length, 1);
    assert.match(html, /aria-labelledby="site-announcement-title"/u);
    assert.match(html, /href="\/camp\/all-parks\?from=announcement#parks"/u);
    assert.doesNotMatch(html, /target=|\sstyle=|\son[a-z]+=/iu);
  });

  test('navbar link appears only when configured and the layout conditionally owns assets', async () => {
    const filename = path.join(root, 'views/partials/navbar.ejs');
    const source = await read('views/partials/navbar.ejs');
    const render = siteAnnouncement => ejs.render(source, {
      activeSiteAnnouncement: siteAnnouncement,
      currentUser: null,
      data: {},
    }, { filename });
    assert.match(render(serializePublicSiteAnnouncement(activeRecord())), /id="site-announcement-trigger"/u);
    assert.doesNotMatch(render(serializePublicSiteAnnouncement(activeRecord({ showNavLink: false }))), /site-announcement-trigger/u);
    assert.doesNotMatch(render(null), /site-announcement-trigger/u);

    const layout = await read('views/layouts/boilerplate.ejs');
    assert.match(layout, /if \(activeSiteAnnouncement\)[\s\S]*?siteAnnouncement\.css/u);
    assert.match(layout, /if \(activeSiteAnnouncement\)[\s\S]*?partials\/siteAnnouncement/u);
    assert.match(layout, /if \(activeSiteAnnouncement\)[\s\S]*?siteAnnouncement\.js/u);
    assert.doesNotMatch(`${layout}\n${source}`, /JSON\.stringify|<%-\s*siteAnnouncement/u);
  });

  test('the real homepage local suppresses only the rendered auto-open value', async () => {
    const announcement = serializePublicSiteAnnouncement(activeRecord());
    const app = await read('app.js');
    const homeRoute = app.slice(
      app.indexOf('//HOME PAGE'),
      app.indexOf('// CATCH ALL NON-EXISTING ROUTES'),
    );
    assert.match(homeRoute, /data:\s*\{\s*isHomepage:\s*true\s*\}/u);

    const homepage = await renderPublicAnnouncementPage({
      announcement,
      data: { isHomepage: true },
    });
    const normalPage = await renderPublicAnnouncementPage({
      announcement,
      data: { currentPath: '/other/faq' },
    });
    const missingPageData = await renderPublicAnnouncementPage({
      announcement,
      data: undefined,
    });
    const malformedPageData = await renderPublicAnnouncementPage({
      announcement,
      data: null,
    });

    assert.equal(renderedAnnouncementAutoOpen(homepage), false);
    assert.equal(renderedAnnouncementAutoOpen(normalPage), true);
    assert.equal(renderedAnnouncementAutoOpen(missingPageData), true);
    assert.equal(renderedAnnouncementAutoOpen(malformedPageData), true);
    assert.match(homepage, /id="site-announcement-trigger"/u);
    assert.match(homepage, /data-announcement-key="site-wide"/u);
    assert.match(homepage, /data-announcement-revision="4"/u);
    assert.match(homepage, /<h2[^>]*>CampPics update<\/h2>/u);
    assert.match(homepage, /First line\s*Second line/u);
    assert.match(
      homepage,
      /href="\/camp\/all-parks\?from=announcement#parks"/u,
    );

    const storedAutoOpenFalse = serializePublicSiteAnnouncement(activeRecord({
      autoOpen: false,
    }));
    for (const data of [{ isHomepage: true }, { currentPath: '/other/faq' }]) {
      const html = await renderPublicAnnouncementPage({
        announcement: storedAutoOpenFalse,
        data,
      });
      assert.equal(renderedAnnouncementAutoOpen(html), false);
    }

    const noNavbarLink = await renderPublicAnnouncementPage({
      announcement: serializePublicSiteAnnouncement(activeRecord({
        showNavLink: false,
      })),
      data: { isHomepage: true },
    });
    assert.doesNotMatch(noNavbarLink, /id="site-announcement-trigger"/u);
  });
});

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.dataset = {};
    this.listeners = new Map();
    this.focusCount = 0;
    this.open = false;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type, overrides = {}) {
    const event = {
      target: this,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  focus() { this.focusCount += 1; }
  setAttribute(name) { if (name === 'open') this.open = true; }
  removeAttribute(name) { if (name === 'open') this.open = false; }
  showModal() { this.open = true; this.showCount = (this.showCount || 0) + 1; }
  close() { this.open = false; this.dispatch('close'); }
}

async function runAdminPreview() {
  const source = await read('public/js/adminAnnouncements.js');
  const ids = [
    'admin-announcement-form', 'announcement-enabled', 'announcement-title',
    'announcement-message', 'announcement-auto-open', 'announcement-show-nav',
    'announcement-nav-text', 'announcement-nav-text-field',
    'announcement-cta-label', 'announcement-cta-url',
    'announcement-preview-heading', 'announcement-message-preview',
    'announcement-nav-preview', 'announcement-nav-preview-text',
    'announcement-cta-preview',
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  elements.get('admin-announcement-form').dataset = {};
  elements.get('announcement-show-nav').checked = true;
  const document = {
    readyState: 'complete',
    getElementById: id => elements.get(id) || null,
    addEventListener() {},
  };
  const window = {};
  vm.runInContext(source, vm.createContext({ document, window }));
  return { elements, window };
}

function publicHarness({ revision = 1, autoOpen = true, storage, storageThrows = false } = {}) {
  const dialog = new FakeElement('site-announcement-dialog');
  dialog.dataset = {
    announcementKey: SITE_ANNOUNCEMENT_KEY,
    announcementRevision: String(revision),
    announcementAutoOpen: autoOpen ? 'true' : 'false',
  };
  const trigger = new FakeElement('site-announcement-trigger');
  const close = new FakeElement('site-announcement-close');
  const cta = new FakeElement('site-announcement-cta');
  const elements = new Map([
    [dialog.id, dialog], [trigger.id, trigger], [close.id, close], [cta.id, cta],
  ]);
  const backing = storage || new Map();
  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error('denied');
      return backing.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageThrows) throw new Error('denied');
      backing.set(key, value);
    },
  };
  return {
    backing,
    close,
    cta,
    dialog,
    trigger,
    context: vm.createContext({
      document: {
        readyState: 'complete',
        getElementById: id => elements.get(id) || null,
        addEventListener() {},
      },
      window: { localStorage },
    }),
  };
}

describe('administrator preview browser behavior', () => {
  test('updates hostile typed values only through textContent and never navigates', async () => {
    const harness = await runAdminPreview();
    const get = id => harness.elements.get(id);
    get('announcement-title').value = hostile;
    get('announcement-message').value = hostile;
    get('announcement-nav-text').value = hostile;
    get('announcement-cta-label').value = hostile;
    get('announcement-cta-url').value = '/internal';
    get('announcement-title').dispatch('input');
    assert.equal(get('announcement-preview-heading').textContent, hostile.trim());
    assert.equal(get('announcement-message-preview').textContent, hostile);
    assert.equal(get('announcement-nav-preview-text').textContent, hostile.trim());
    assert.equal(get('announcement-cta-preview').textContent, hostile.trim());
    assert.equal(get('announcement-cta-preview').hidden, false);
    assert.equal(get('announcement-cta-preview').dispatch('click').defaultPrevented, true);

    get('announcement-show-nav').checked = false;
    get('announcement-show-nav').dispatch('change');
    assert.equal(get('announcement-nav-text-field').hidden, true);
    assert.equal(get('announcement-nav-preview').hidden, true);
  });

  test('is private, initializes once and has no HTML or style sink', async () => {
    const source = await read('public/js/adminAnnouncements.js');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|\.style\b|window\.[A-Za-z_$][\w$]*\s*=/u);
    const harness = await runAdminPreview();
    assert.deepEqual(Object.keys(harness.window), []);
    assert.equal(
      harness.elements.get('announcement-title').listeners.get('input').length,
      1,
    );
    assert.doesNotThrow(() => vm.runInContext(source, vm.createContext({
      document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
      window: {},
    })));
  });
});

describe('public dismissal browser behavior', () => {
  test('auto-opens first revision, stores dismissal, stays closed, then opens a new revision', async () => {
    const source = await read('public/js/siteAnnouncement.js');
    const storage = new Map();
    const normalPage = await renderPublicAnnouncementPage({
      announcement: serializePublicSiteAnnouncement(activeRecord({ revision: 7 })),
      data: { currentPath: '/other/faq' },
    });
    const first = publicHarness({
      revision: 7,
      autoOpen: renderedAnnouncementAutoOpen(normalPage),
      storage,
    });
    vm.runInContext(source, first.context);
    assert.equal(first.dialog.showCount, 1);
    first.close.dispatch('click');
    assert.equal(storage.get('campPicsAnnouncementDismissed:site-wide:7'), 'true');

    const same = publicHarness({ revision: 7, storage });
    vm.runInContext(source, same.context);
    assert.equal(same.dialog.showCount || 0, 0);
    const next = publicHarness({ revision: 8, storage });
    vm.runInContext(source, next.context);
    assert.equal(next.dialog.showCount, 1);
  });

  test('homepage load stays closed and undismissed until a manual navbar open is closed', async () => {
    const source = await read('public/js/siteAnnouncement.js');
    const announcement = serializePublicSiteAnnouncement(activeRecord({ revision: 9 }));
    const homepage = await renderPublicAnnouncementPage({
      announcement,
      data: { isHomepage: true },
    });
    assert.match(homepage, /id="site-announcement-trigger"/u);

    const storage = new Map();
    const harness = publicHarness({
      revision: announcement.revision,
      autoOpen: renderedAnnouncementAutoOpen(homepage),
      storage,
    });
    vm.runInContext(source, harness.context);
    assert.equal(harness.dialog.showCount || 0, 0);
    assert.equal(storage.size, 0);

    assert.equal(harness.trigger.dispatch('click').defaultPrevented, true);
    assert.equal(harness.dialog.open, true);
    assert.equal(storage.size, 0);
    harness.close.dispatch('click');
    assert.equal(
      storage.get('campPicsAnnouncementDismissed:site-wide:9'),
      'true',
    );
    assert.equal(harness.trigger.focusCount, 1);
  });

  test('manual navbar open ignores dismissal and restores trigger focus on close', async () => {
    const source = await read('public/js/siteAnnouncement.js');
    const storage = new Map([['campPicsAnnouncementDismissed:site-wide:2', 'true']]);
    const harness = publicHarness({ revision: 2, storage });
    vm.runInContext(source, harness.context);
    assert.equal(harness.dialog.open, false);
    assert.equal(harness.trigger.dispatch('click').defaultPrevented, true);
    assert.equal(harness.dialog.open, true);
    harness.close.dispatch('click');
    assert.equal(harness.trigger.focusCount, 1);
  });

  test('autoOpen false stays closed while CTA, cancel and backdrop record dismissal', async () => {
    const source = await read('public/js/siteAnnouncement.js');
    const storage = new Map();
    const harness = publicHarness({ revision: 3, autoOpen: false, storage });
    vm.runInContext(source, harness.context);
    assert.equal(harness.dialog.showCount || 0, 0);
    harness.trigger.dispatch('click');
    harness.cta.dispatch('click');
    assert.equal(storage.get('campPicsAnnouncementDismissed:site-wide:3'), 'true');
    storage.delete('campPicsAnnouncementDismissed:site-wide:3');
    harness.dialog.dispatch('cancel');
    assert.equal(storage.get('campPicsAnnouncementDismissed:site-wide:3'), 'true');
    storage.delete('campPicsAnnouncementDismissed:site-wide:3');
    harness.dialog.dispatch('click', { target: harness.dialog });
    assert.equal(storage.get('campPicsAnnouncementDismissed:site-wide:3'), 'true');
  });

  test('localStorage denial never throws and the modal remains usable', async () => {
    const source = await read('public/js/siteAnnouncement.js');
    const harness = publicHarness({ storageThrows: true });
    assert.doesNotThrow(() => vm.runInContext(source, harness.context));
    assert.equal(harness.dialog.open, true);
    assert.doesNotThrow(() => harness.close.dispatch('click'));
    assert.doesNotThrow(() => harness.trigger.dispatch('click'));
  });

  test('initializes once with no public global or unsafe sink', async () => {
    const source = await read('public/js/siteAnnouncement.js');
    const harness = publicHarness();
    const initialWindowKeys = Object.keys(harness.context.window);
    vm.runInContext(source, harness.context);
    assert.deepEqual(Object.keys(harness.context.window), initialWindowKeys);
    assert.equal(harness.trigger.listeners.get('click').length, 1);
    assert.doesNotMatch(
      source,
      /innerHTML|outerHTML|insertAdjacentHTML|\.style\b|document\.cookie|console\.|window\.[A-Za-z_$][\w$]*\s*=/u,
    );
  });
});
