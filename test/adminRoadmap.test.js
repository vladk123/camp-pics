import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';

import {
  VALID_ROADMAP_STATUSES,
  adminRoadmap,
  formatAdminRoadmapPlainText,
  getActiveRoadmapPhases,
  getCompletedRoadmapItems,
  getRoadmapSummary,
  isValidRoadmapStatus,
} from '../config/adminRoadmap.js';
import { roadmap as renderRoadmap } from '../controllers/admin.js';
import { isAdmin } from '../middleware.js';
import adminRouter from '../routes/admin.js';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';

const root = process.cwd();
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const STABLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ITEM_ARRAY_FIELDS = [
  'scope',
  'notIncluded',
  'dependencies',
  'doneWhen',
  'notes',
];
const REQUIRED_PHASE_IDS = [
  'operations-launch-readiness',
  'admin-product-experience',
  'monthly-draw-program',
  'conditional-maintenance',
  'completed-foundation',
];
const REQUIRED_ITEM_IDS = [
  'schedule-media-cleanup-worker',
  'restore-production-shaped-staging-database',
  'run-maintenance-dry-audits',
  'test-maintenance-apply-idempotence',
  'verify-mongodb-transaction-support',
  'validate-isolated-provider-flows',
  'deployment-smoke-proxy-sessions-rate-limits',
  'browser-csp-vendor-verification',
  'source-controlled-admin-roadmap',
  'redesign-admin-dashboard',
  'admin-user-detail',
  'upload-incentive-banner',
  'monthly-draw-rules-and-no-upload-entry',
  'monthly-draw-upload-qualification',
  'monthly-draw-selection-and-notification',
  'monthly-draw-scheduler-activation',
  'shared-rate-limit-store-before-multi-dyno',
  'review-token-ttl-and-retention',
  'targeted-dependency-maintenance',
  'final-dead-code-dry-sweep',
  'auth-session-hardening',
  'csrf-csp-safe-rendering',
  'bounded-media-upload-hardening',
  'transactional-media-account-deletion',
  'maintenance-audit-tooling',
  'route-abuse-controls',
  'runtime-dependency-cleanup',
];

function allItems(roadmap = adminRoadmap) {
  return roadmap.phases.flatMap(phase => phase.items);
}

function routeFor(routePath) {
  return adminRouter.stack.find(layer => layer.route?.path === routePath)?.route;
}

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function headSource(relativePath) {
  return execFileSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: root,
    encoding: 'utf8',
  });
}

function gitStatus(...paths) {
  return execFileSync('git', ['status', '--short', '--', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });
}

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeeplyFrozen(child);
}

describe('authoritative administrator roadmap configuration', () => {
  test('has the exact baseline version, date, phases and stable item IDs', () => {
    assert.equal(adminRoadmap.version, 1);
    assert.equal(adminRoadmap.updatedOn, '2026-08-04');
    assert.deepEqual(adminRoadmap.phases.map(phase => phase.id), REQUIRED_PHASE_IDS);
    assert.deepEqual(allItems().map(item => item.id), REQUIRED_ITEM_IDS);
    assertDeeplyFrozen(adminRoadmap);
  });

  test('uses unique kebab-case IDs, allowed statuses and the complete item shape', () => {
    const phaseIds = new Set();
    const itemIds = new Set();
    const expectedItemKeys = [
      'id',
      'title',
      'status',
      'purpose',
      'scope',
      'notIncluded',
      'dependencies',
      'doneWhen',
      'notes',
      'completedOn',
    ];

    assert.deepEqual(
      VALID_ROADMAP_STATUSES,
      ['planned', 'in_progress', 'blocked', 'completed'],
    );
    for (const phase of adminRoadmap.phases) {
      assert.match(phase.id, STABLE_ID_PATTERN);
      assert.equal(phaseIds.has(phase.id), false);
      phaseIds.add(phase.id);
      assert.equal(typeof phase.title, 'string');
      assert.equal(typeof phase.description, 'string');
      assert.ok(Array.isArray(phase.items));

      for (const item of phase.items) {
        assert.deepEqual(Object.keys(item), expectedItemKeys);
        assert.match(item.id, STABLE_ID_PATTERN);
        assert.equal(itemIds.has(item.id), false);
        itemIds.add(item.id);
        assert.equal(typeof item.title, 'string');
        assert.equal(typeof item.purpose, 'string');
        assert.equal(isValidRoadmapStatus(item.status), true);
        for (const field of ITEM_ARRAY_FIELDS) {
          assert.ok(Array.isArray(item[field]));
          assert.equal(item[field].every(value => typeof value === 'string'), true);
        }
        assert.ok(
          item.completedOn === null || ISO_DATE_PATTERN.test(item.completedOn),
        );
        if (item.status !== 'completed') assert.equal(item.completedOn, null);
      }
    }
    assert.equal(itemIds.size, REQUIRED_ITEM_IDS.length);
    assert.equal(isValidRoadmapStatus('unknown'), false);
  });

  test('derives active groupings, completed history and exact summary counts', () => {
    const activePhases = getActiveRoadmapPhases();
    const completedItems = getCompletedRoadmapItems();
    const activeIds = activePhases.flatMap(phase => phase.items.map(item => item.id));
    const completedIds = completedItems.map(item => item.id);

    assert.deepEqual(
      activePhases.map(phase => phase.id),
      [REQUIRED_PHASE_IDS[0], REQUIRED_PHASE_IDS[2], REQUIRED_PHASE_IDS[3]],
    );
    assert.equal(activeIds.length, 12);
    assert.deepEqual(completedIds, [
      'restore-production-shaped-staging-database',
      'source-controlled-admin-roadmap',
      'redesign-admin-dashboard',
      'admin-user-detail',
      'upload-incentive-banner',
      'monthly-draw-rules-and-no-upload-entry',
      'monthly-draw-upload-qualification',
      'monthly-draw-selection-and-notification',
      'auth-session-hardening',
      'csrf-csp-safe-rendering',
      'bounded-media-upload-hardening',
      'transactional-media-account-deletion',
      'maintenance-audit-tooling',
      'route-abuse-controls',
      'runtime-dependency-cleanup',
    ]);
    assert.equal(
      completedItems.find(item => item.id === 'source-controlled-admin-roadmap')
        ?.phaseTitle,
      'Administrator and product experience',
    );
    assert.equal(activeIds.some(id => completedIds.includes(id)), false);
    assert.deepEqual(getRoadmapSummary(), {
      total: 27,
      active: 12,
      planned: 4,
      inProgress: 0,
      blocked: 8,
      completed: 15,
    });
  });

  test('tracks scheduled cleanup as deferred pending explicit future approval', () => {
    const item = allItems().find(
      candidate => candidate.id === 'schedule-media-cleanup-worker',
    );

    assert.equal(item.status, 'blocked');
    assert.equal(item.completedOn, null);
    assert.deepEqual(item.notes, [
      'Heroku Scheduler was selected for the current simple recurring workload.',
      'The intended command is `npm run media:scheduled-cleanup`.',
      'The intended frequency is every 10 minutes.',
      'The scheduled command and documentation are complete.',
      'Heroku Scheduler is intentionally not enabled.',
      'Enabling Heroku Scheduler requires explicit future user approval.',
      'This deferred activation is not a blocker for current product work or deployment.',
    ]);
  });

  test('records the completed direct staging copy without claiming a backup', () => {
    const item = allItems().find(
      candidate => candidate.id === 'restore-production-shaped-staging-database',
    );
    const itemText = JSON.stringify(item);

    assert.equal(item.status, 'completed');
    assert.equal(item.completedOn, '2026-08-03');
    assert.match(item.purpose, /direct, read-only copy from production/u);
    assert.match(itemText, /existing MongoDB Node driver/u);
    assert.match(itemText, /No local backup archive or disaster-recovery backup was created or verified/u);
    assert.match(itemText, /Production was read-only and remained unchanged/u);
    assert.match(itemText, /maintenance mode with `web=0`/u);
    assert.match(itemText, /Cloudinary and Mailgun credentials remained absent/u);
    assert.match(itemText, /production-derived data and must remain private and controlled/u);
    assert.doesNotMatch(itemText, /verified production-shaped backup|Restore it/u);
  });

  test('records deferred operational validation as non-blocking for the release', () => {
    const deferredIds = [
      'run-maintenance-dry-audits',
      'test-maintenance-apply-idempotence',
      'verify-mongodb-transaction-support',
      'validate-isolated-provider-flows',
      'deployment-smoke-proxy-sessions-rate-limits',
      'browser-csp-vendor-verification',
    ];

    for (const id of deferredIds) {
      const item = allItems().find(candidate => candidate.id === id);
      assert.equal(item.status === 'completed', false);
      assert.equal(
        item.notes.includes(
          'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
        ),
        true,
      );
    }
  });

  test('records the completed first administrator dashboard pass', () => {
    const item = allItems().find(
      candidate => candidate.id === 'redesign-admin-dashboard',
    );

    assert.equal(item.status, 'completed');
    assert.equal(item.completedOn, '2026-08-03');
    assert.deepEqual(item.notes, [
      'The completed first dashboard pass includes a responsive layout and summary cards.',
      'Uploads and users now have clearer sections with accessible status badges and controls.',
      'Loading, empty and error states are included for the existing pagination controls.',
      'Existing administrator APIs and Block/Unblock behavior remain unchanged.',
      'Recent-upload Park and Campground links now open the corresponding public location in a new tab.',
    ]);
  });

  test('records completed administrator user details and broadened announcements', () => {
    const userDetail = allItems().find(
      candidate => candidate.id === 'admin-user-detail',
    );
    const announcements = allItems().find(
      candidate => candidate.id === 'upload-incentive-banner',
    );

    assert.equal(userDetail.status, 'completed');
    assert.equal(userDetail.completedOn, '2026-08-03');
    assert.deepEqual(userDetail.dependencies, ['redesign-admin-dashboard.']);
    assert.equal(
      userDetail.notIncluded.includes('Session or token inspection.'),
      true,
    );
    assert.equal(announcements.status, 'completed');
    assert.equal(announcements.completedOn, '2026-08-03');
    assert.equal(announcements.title, 'Site-wide announcements and campaigns');
    for (const requirement of [
      'One active announcement at a time.',
      'Administrator enable/disable and editing.',
      'Optional automatic modal display.',
      'Revision-based browser dismissal.',
      'Optional administrator-selected navbar link text.',
      'Optional start and end dates.',
      'Safe plain-text content and an optional validated internal link.',
      'Monthly upload promotion and winner announcements as initial use cases.',
    ]) {
      assert.equal(announcements.scope.includes(requirement), true, requirement);
    }
    for (const excluded of [
      'Advanced targeting.',
      'Rich text.',
      'Images.',
      'Analytics dashboards.',
      'Account-level dismissal.',
    ]) {
      assert.equal(announcements.notIncluded.includes(excluded), true, excluded);
    }
    assert.deepEqual(announcements.notes, [
      'The completed first version includes one editable site-wide announcement.',
      'Administrators can enable or disable the announcement.',
      'The announcement supports an optional auto-open modal.',
      'Dismissal is revision-based and stored only in the visitor browser.',
      'The optional navbar link has administrator-selected text.',
      'Optional date scheduling and an optional validated internal CTA are supported.',
      'Monthly upload promotion and winner-announcement use cases are supported.',
      'Announcement content is plain text and rendered safely against XSS.',
    ]);
  });

  test('records the complete staged monthly draw roadmap', () => {
    const phase = adminRoadmap.phases.find(
      candidate => candidate.id === 'monthly-draw-program',
    );
    assert.equal(phase.title, 'Monthly upload draw');
    assert.equal(
      phase.description,
      'Implement and operate the CampPics monthly upload and no-purchase draw in clear, testable stages.',
    );
    assert.deepEqual(phase.items.map(item => [
      item.id,
      item.status,
      item.completedOn,
    ]), [
      ['monthly-draw-rules-and-no-upload-entry', 'completed', '2026-08-03'],
      ['monthly-draw-upload-qualification', 'completed', '2026-08-03'],
      ['monthly-draw-selection-and-notification', 'completed', '2026-08-04'],
      ['monthly-draw-scheduler-activation', 'blocked', null],
    ]);
    assert.deepEqual(
      phase.items[0].dependencies,
      ['site-wide announcements and campaigns.'],
    );
    assert.deepEqual(phase.items[0].notes, [
      'The completed implementation uses a deterministic built-in _id for atomic one-account-per-month enforcement.',
      'Transactional account deletion removes the account’s no-upload entries.',
    ]);
    assert.equal(
      phase.items[1].scope.includes(
        'Administrator/operator accounts are excluded from the qualification pool.',
      ),
      true,
    );
    assert.deepEqual(phase.items[1].notes, [
      'The completed implementation adds optional draw qualification metadata to Upload records.',
      'Pending, eligible and ineligible states use fixed ineligibility reasons with no free-text note.',
      'New uploads from eligible verified non-administrator, non-blocked accounts automatically become pending prospective entries.',
      'Legacy uploads are not entered retroactively.',
      'Administrator review includes safe month and status filters, selected-month counts and bounded pagination.',
      'Current account eligibility is enforced before an upload can be marked eligible.',
      'Draw qualification has no effect on public media approval or visibility.',
      'Eligible Upload records retain the month, rules version, uploader, timestamp, media and location references needed by future selection work.',
    ]);
    assert.equal(
      phase.items[2].scope.includes(
        'Administrator/operator accounts and other known ineligible accounts are excluded from the selection pool.',
      ),
      true,
    );
    assert.equal(
      phase.items[2].purpose,
      'Select one primary entrant and up to two distinct alternates for the previous month exactly once and email the stored result to the administrator.',
    );
    assert.equal(
      phase.items[2].scope.includes('Up to three distinct ranked people.'),
      true,
    );
    assert.equal(
      phase.items[2].scope.includes(
        'Primary, first alternate and second alternate when available.',
      ),
      true,
    );
    assert.equal(
      phase.items[2].doneWhen.includes(
        'The administrator receives the primary and any available ranked alternates.',
      ),
      true,
    );
    assert.equal(
      phase.items[2].scope.includes('Three distinct ranked people.'),
      false,
    );
    assert.equal(
      phase.items[2].scope.includes(
        'Primary, first alternate and second alternate.',
      ),
      false,
    );
    assert.equal(
      phase.items[2].doneWhen.includes(
        'The administrator receives the primary and two alternates.',
      ),
      false,
    );
    assert.equal(
      phase.items[2].doneWhen.includes('Known ineligible accounts cannot be selected.'),
      true,
    );
    for (const note of [
      'The completed implementation keeps permanent privacy-minimal stored selections.',
      'The pending-review gate prevents selection while uploads await review.',
      'Weighted selection stores one primary and any available ranked alternates.',
      'No-upload candidates use opaque source references.',
      'Notification rechecks current source and account state before exposing contact details.',
      'Unavailable stored candidates are labelled without redrawing or replacement.',
      'One administrator email includes current contact and safe location details.',
      'No-upload candidates are clearly labelled in the administrator notification.',
      'The administrator email includes response, eligibility, skill-question, prize and publication reminders.',
      'A hashed atomic notification lease and sent marker provide normal retry and concurrency idempotence.',
      'Definite provider failures release the matching lease for a safe later retry.',
      'A manual notification command supports safe dry-run and explicit apply modes.',
      'A Scheduler-ready combined command self-gates to the first Eastern calendar day.',
      'The implementation does not automatically contact entrants or deliver a prize.',
    ]) assert.equal(phase.items[2].notes.includes(note), true, note);
    assert.deepEqual(phase.items[3].notes, [
      'The repository command is ready.',
      'Production Heroku Scheduler jobs are not configured.',
      'Activation requires explicit user approval and deployment verification.',
      'The command is intended to be invoked daily and self-gates to the first Eastern calendar day.',
      'Repeated invocations reuse one selection and one sent notification.',
    ]);
  });

  test('produces deterministic plain text with active and completed work', () => {
    const first = formatAdminRoadmapPlainText();
    const second = formatAdminRoadmapPlainText();

    assert.equal(first, second);
    assert.match(first, /^CampPics administrator roadmap\nVersion: 1\nUpdated: 2026-08-04\n/u);
    assert.match(first, /\nActive work\n/u);
    assert.match(first, /Operations and launch readiness/u);
    assert.match(first, /Schedule the media cleanup worker \[blocked\] \(schedule-media-cleanup-worker\)/u);
    assert.match(first, /  Purpose:/u);
    assert.match(first, /  Dependencies:\n    -/u);
    assert.match(first, /  Done when:\n    -/u);
    assert.match(first, /\nCompleted work\n/u);
    assert.match(first, /Create a production-shaped staging database \[completed\]/u);
    assert.match(first, /Source-controlled administrator roadmap \[completed\]/u);
    assert.equal(first.endsWith('\n'), true);
    assert.doesNotMatch(first, /<[^>]+>/u);
  });
});

describe('administrator roadmap route and handler', () => {
  test('is a GET-only administrator route with no limiter or write method', () => {
    const route = routeFor('/roadmap');

    assert.ok(route);
    assert.deepEqual(Object.keys(route.methods), ['get']);
    assert.equal(route.stack.length, 2);
    assert.strictEqual(route.stack[0].handle, isAdmin);
    assert.equal(
      route.stack.some(layer => layer.handle === adminUserStatusLimiter),
      false,
    );
    for (const method of ['post', 'put', 'patch', 'delete']) {
      assert.equal(route.methods[method], undefined);
    }
  });

  test('renders the authoritative in-memory view model without request or model access', async () => {
    const request = new Proxy({}, {
      get() {
        throw new Error('The roadmap handler must not inspect the request.');
      },
    });
    const result = {};
    const response = {
      render(view, locals) {
        result.view = view;
        result.locals = locals;
        return result;
      },
    };

    assert.strictEqual(await renderRoadmap(request, response), result);
    assert.equal(result.view, 'admin/roadmap');
    assert.equal(result.locals.meta.title, 'Admin Roadmap');
    assert.equal(result.locals.currentPath, '/a/roadmap');
    assert.equal(result.locals.data.currentPath, '/a/roadmap');
    assert.strictEqual(result.locals.roadmap, adminRoadmap);
    assert.deepEqual(result.locals.activePhases, getActiveRoadmapPhases());
    assert.deepEqual(result.locals.completedItems, getCompletedRoadmapItems());
    assert.deepEqual(result.locals.summaryCounts, getRoadmapSummary());
    assert.equal(result.locals.copyText, formatAdminRoadmapPlainText());

    const handlerSource = renderRoadmap.toString();
    assert.doesNotMatch(
      handlerSource,
      /User|Upload|find|countDocuments|mongoose|database|logger|req\./u,
    );
  });

  async function invokeRegisteredRoadmapRoute(render) {
    const route = routeFor('/roadmap');
    const request = { user: { isAdmin: true } };
    const response = { render };
    const downstreamErrors = [];
    let authorizationNextCalls = 0;
    let invocationError = null;

    try {
      route.stack[0].handle(request, response, authorizationError => {
        authorizationNextCalls += 1;
        assert.equal(authorizationError, undefined);
        route.stack[1].handle(request, response, error => {
          downstreamErrors.push(error);
        });
      });
    } catch (error) {
      invocationError = error;
    }

    await Promise.resolve();
    await Promise.resolve();
    return {
      authorizationNextCalls,
      downstreamErrors,
      invocationError,
    };
  }

  test('the registered route executes after isAdmin and renders once without calling next', async () => {
    const route = routeFor('/roadmap');
    const renderCalls = [];

    assert.strictEqual(route.stack[0].handle, isAdmin);
    const outcomePromise = invokeRegisteredRoadmapRoute((view, locals) => {
      renderCalls.push({ view, locals });
      return { rendered: true };
    });
    await assert.doesNotReject(outcomePromise);
    const outcome = await outcomePromise;

    assert.equal(outcome.authorizationNextCalls, 1);
    assert.equal(outcome.invocationError, null);
    assert.deepEqual(outcome.downstreamErrors, []);
    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0].view, 'admin/roadmap');
    assert.equal(renderCalls[0].locals.currentPath, '/a/roadmap');
    assert.equal(renderCalls[0].locals.data.currentPath, '/a/roadmap');
  });

  test('a synchronous render throw rejects and reaches registered catchAsyncErrors next once', async () => {
    const renderError = new Error('Roadmap render failed.');
    const directPromise = renderRoadmap({}, {
      render() {
        throw renderError;
      },
    });

    assert.equal(typeof directPromise?.catch, 'function');
    await assert.rejects(directPromise, error => error === renderError);

    let renderCalls = 0;
    const outcome = await invokeRegisteredRoadmapRoute(() => {
      renderCalls += 1;
      throw renderError;
    });

    assert.equal(outcome.authorizationNextCalls, 1);
    assert.equal(outcome.invocationError, null);
    assert.equal(renderCalls, 1);
    assert.deepEqual(outcome.downstreamErrors, [renderError]);
    assert.equal(
      outcome.downstreamErrors.some(error =>
        error instanceof TypeError && /\.catch/u.test(error.message)
      ),
      false,
    );
  });

  test('has no public alias and is not mounted outside the administrator router', async () => {
    const [app, campRoutes, otherRoutes, userRoutes] = await Promise.all([
      source('app.js'),
      source('routes/camp.js'),
      source('routes/other.js'),
      source('routes/users.js'),
    ]);

    assert.match(app, /app\.use\('\/a', adminRoutes\)/u);
    assert.doesNotMatch(`${campRoutes}\n${otherRoutes}\n${userRoutes}`, /roadmap/iu);
    assert.equal(
      adminRouter.stack.filter(layer => layer.route?.path === '/roadmap').length,
      1,
    );
  });
});

function decodeHtmlText(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#34;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

describe('administrator roadmap rendering', () => {
  test('escapes hostile content and renders safe details, navigation and copy text', async () => {
    const hostile = '<script id="roadmap-xss">attack()</script> "quotes" & apostrophe\' ' +
      String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    const fixture = structuredClone(adminRoadmap);
    fixture.phases[0].title = hostile;
    fixture.phases[0].description = hostile;
    fixture.phases[0].items[0].title = hostile;
    fixture.phases[0].items[0].purpose = hostile;
    fixture.phases[0].items[0].scope = [hostile];
    fixture.phases[0].items[0].notes = [hostile];
    const copyText = formatAdminRoadmapPlainText(fixture);
    const filename = path.join(root, 'views', 'admin', 'roadmap.ejs');
    const html = await ejs.renderFile(filename, {
      layout: () => {},
      currentPath: '/a/roadmap',
      roadmap: fixture,
      activePhases: getActiveRoadmapPhases(fixture),
      completedItems: getCompletedRoadmapItems(fixture),
      summaryCounts: getRoadmapSummary(fixture),
      copyText,
    });
    const activeHtml = html.replace(/<!--[\s\S]*?-->/gu, '');
    const scriptTags = [...activeHtml.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu,
    )];

    assert.equal(html.includes('<script id="roadmap-xss">'), false);
    assert.match(html, /&lt;script id=&#34;roadmap-xss&#34;&gt;attack\(\)&lt;\/script&gt;/u);
    assert.equal(scriptTags.length, 1);
    assert.match(scriptTags[0][1], /\bsrc="\/js\/adminRoadmap\.js"/u);
    assert.equal(scriptTags[0][2].trim(), '');
    assert.doesNotMatch(activeHtml, /<style\b|\sstyle\s*=/iu);
    assert.doesNotMatch(activeHtml, /\son[a-z]+\s*=/iu);
    assert.match(html, /href="\/css\/adminRoadmap\.css"/u);
    assert.match(html, /aria-label="Administrator pages"/u);
    assert.match(html, /href="\/a\/dashboard"/u);
    assert.match(html, /href="\/a\/roadmap"[\s\S]*?aria-current="page"/u);
    assert.match(html, /id="active-roadmap-heading">Active work/u);
    assert.match(html, /id="completed-roadmap-heading">Completed work/u);
    assert.match(html, /roadmap-status--planned/u);
    assert.match(html, /roadmap-status--blocked/u);
    assert.match(html, /roadmap-status--completed/u);
    assert.match(html, /<code>schedule-media-cleanup-worker<\/code>/u);
    assert.match(html, /Original phase: Administrator and product experience/u);
    assert.match(html, /roadmap-item__title--completed/u);
    assert.match(html, /data-roadmap-detail-id="schedule-media-cleanup-worker"/u);
    assert.doesNotMatch(html, /JSON\.stringify|type="application\/json"/u);

    const copyMarkup = html.match(
      /<pre id="roadmap-copy-source" hidden>([\s\S]*?)<\/pre>/u,
    )?.[1];
    assert.ok(copyMarkup);
    assert.equal(decodeHtmlText(copyMarkup), copyText);

    const dashboard = await source('views/admin/dashboard.ejs');
    assert.doesNotMatch(dashboard, /adminRoadmap\.(?:css|js)/u);
  });

  test('the global administrator link is clear and highlights administrator pages', async () => {
    const navbar = await source('views/partials/navbar.ejs');
    const html = ejs.render(navbar, {
      include: () => '',
      currentUser: { isAdmin: true },
      data: { currentPath: '/a/roadmap' },
    });

    assert.match(html, /href="\/a\/dashboard">Admin<\/a>/u);
    assert.match(html, /class="highlighted" href="\/a\/dashboard"/u);
    assert.doesNotMatch(html, />\.<\/a>/u);
  });
});

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  async dispatch(type, event = {}) {
    const actualEvent = { target: this, ...event };
    for (const listener of this.listeners.get(type) || []) {
      await listener(actualEvent);
    }
  }
}

class FakeNode extends FakeEventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.dataset = {};
    this.textContent = '';
    this.className = '';
    this.attributes = new Map();
    this.focusCount = 0;
    this.cloneCount = 0;
    this.removed = false;
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.childNodes = children;
    for (const child of children) child.parentNode = this;
  }

  cloneNode(deep) {
    this.cloneCount += 1;
    const clone = new FakeNode(this.tagName);
    clone.textContent = this.textContent;
    clone.dataset = { ...this.dataset };
    if (deep) {
      for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
    }
    return clone;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  focus() {
    this.focusCount += 1;
  }

  select() {
    this.selected = true;
  }

  remove() {
    this.removed = true;
    if (this.parentNode) {
      this.parentNode.childNodes = this.parentNode.childNodes
        .filter(child => child !== this);
    }
  }
}

function createBrowserHarness({
  clipboardWrite = async () => {},
  execCommandResult = true,
  includeElements = true,
} = {}) {
  const document = new FakeEventTarget();
  document.readyState = 'loading';
  document.body = new FakeNode('body');
  document.createdElements = [];
  document.execCommandCalls = 0;
  document.execCommand = command => {
    document.execCommandCalls += 1;
    assert.equal(command, 'copy');
    return execCommandResult;
  };
  document.createElement = tagName => {
    const element = new FakeNode(tagName);
    document.createdElements.push(element);
    return element;
  };

  const byId = new Map();
  const triggers = [];
  const detailSources = [];
  if (includeElements) {
    const dialog = new FakeNode('dialog');
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => {
      dialog.open = false;
      void dialog.dispatch('close');
    };
    const dialogContent = new FakeNode('div');
    const closeButton = new FakeNode('button');
    const copyButton = new FakeNode('button');
    const copySource = new FakeNode('pre');
    const copyStatus = new FakeNode('p');
    copySource.textContent = 'safe plain-text roadmap\n';
    byId.set('roadmap-detail-dialog', dialog);
    byId.set('roadmap-dialog-content', dialogContent);
    byId.set('roadmap-dialog-close', closeButton);
    byId.set('roadmap-copy-button', copyButton);
    byId.set('roadmap-copy-source', copySource);
    byId.set('roadmap-copy-status', copyStatus);

    const trigger = new FakeNode('button');
    trigger.dataset.roadmapItemId = 'matching-roadmap-item';
    triggers.push(trigger);
    const sourceNode = new FakeNode('article');
    sourceNode.dataset.roadmapDetailId = 'matching-roadmap-item';
    const detailChild = new FakeNode('h2');
    detailChild.textContent = 'Safe detail title';
    sourceNode.appendChild(detailChild);
    detailSources.push(sourceNode);
  }

  document.getElementById = id => byId.get(id) || null;
  document.querySelectorAll = selector => {
    if (selector === '[data-roadmap-item-id]') return triggers;
    if (selector === '[data-roadmap-detail-id]') return detailSources;
    return [];
  };

  const clipboardCalls = [];
  const context = vm.createContext({
    document,
    navigator: {
      clipboard: {
        async writeText(value) {
          clipboardCalls.push(value);
          return clipboardWrite(value);
        },
      },
    },
    window: { existingMarker: true },
  });

  return {
    byId,
    clipboardCalls,
    context,
    detailSources,
    document,
    triggers,
  };
}

async function runBrowserHarness(options) {
  const harness = createBrowserHarness(options);
  const browserSource = await source('public/js/adminRoadmap.js');
  vm.runInContext(browserSource, harness.context);
  await harness.document.dispatch('DOMContentLoaded');
  return { ...harness, browserSource };
}

describe('administrator roadmap browser behavior', () => {
  test('opens cloned detail DOM and restores focus after close', async () => {
    const harness = await runBrowserHarness();
    const trigger = harness.triggers[0];
    const sourceNode = harness.detailSources[0];
    const dialog = harness.byId.get('roadmap-detail-dialog');
    const content = harness.byId.get('roadmap-dialog-content');

    await trigger.dispatch('click');
    assert.equal(dialog.open, true);
    assert.equal(sourceNode.childNodes[0].cloneCount, 1);
    assert.equal(content.childNodes.length, 1);
    assert.notStrictEqual(content.childNodes[0], sourceNode.childNodes[0]);
    assert.equal(content.childNodes[0].textContent, 'Safe detail title');

    await harness.byId.get('roadmap-dialog-close').dispatch('click');
    await Promise.resolve();
    assert.equal(dialog.open, false);
    assert.equal(trigger.focusCount, 1);
  });

  test('copies the server-rendered text with the Clipboard API and updates aria-live text', async () => {
    const harness = await runBrowserHarness();
    const copyButton = harness.byId.get('roadmap-copy-button');

    await copyButton.dispatch('click');
    assert.deepEqual(harness.clipboardCalls, ['safe plain-text roadmap\n']);
    assert.equal(harness.document.createdElements.length, 0);
    assert.equal(
      harness.byId.get('roadmap-copy-status').textContent,
      'Roadmap copied.',
    );
  });

  test('uses and removes the textarea fallback after Clipboard rejection', async () => {
    const harness = await runBrowserHarness({
      clipboardWrite: async () => { throw new Error('clipboard unavailable'); },
      execCommandResult: true,
    });

    await harness.byId.get('roadmap-copy-button').dispatch('click');
    assert.equal(harness.document.execCommandCalls, 1);
    assert.equal(harness.document.createdElements.length, 1);
    const textarea = harness.document.createdElements[0];
    assert.equal(textarea.tagName, 'TEXTAREA');
    assert.equal(textarea.value, 'safe plain-text roadmap\n');
    assert.equal(textarea.className, 'roadmap-copy-fallback');
    assert.equal(textarea.attributes.get('readonly'), '');
    assert.equal(textarea.selected, true);
    assert.equal(textarea.removed, true);
    assert.equal(harness.document.body.childNodes.length, 0);
    assert.equal(
      harness.byId.get('roadmap-copy-status').textContent,
      'Roadmap copied.',
    );
  });

  test('reports copy failure safely, initializes once and tolerates missing elements', async () => {
    const harness = await runBrowserHarness({
      clipboardWrite: async () => { throw new Error('clipboard unavailable'); },
      execCommandResult: false,
    });
    await harness.document.dispatch('DOMContentLoaded');
    assert.equal(harness.triggers[0].listeners.get('click').length, 1);
    await harness.byId.get('roadmap-copy-button').dispatch('click');
    assert.equal(
      harness.byId.get('roadmap-copy-status').textContent,
      'Unable to copy roadmap.',
    );

    const missing = await runBrowserHarness({ includeElements: false });
    await missing.document.dispatch('DOMContentLoaded');
    assert.deepEqual(Object.keys(missing.context.window), ['existingMarker']);
  });

  test('uses safe DOM APIs in private scope without HTML sinks or inline handlers', async () => {
    const browserSource = await source('public/js/adminRoadmap.js');

    assert.match(browserSource, /cloneNode\(true\)/u);
    assert.match(browserSource, /replaceChildren\(\.\.\.clonedDetails\)/u);
    assert.match(browserSource, /textContent/u);
    assert.match(browserSource, /addEventListener/u);
    assert.match(browserSource, /navigator\.clipboard\.writeText\(text\)/u);
    assert.doesNotMatch(
      browserSource,
      /innerHTML|outerHTML|insertAdjacentHTML|\bon[a-z]+\s*=|console\.|window\.[A-Za-z_$]/u,
    );
  });
});

describe('administrator roadmap smoke and source guards', () => {
  test('the package smoke command succeeds without application or provider imports', async () => {
    const packageJson = JSON.parse(await source('package.json'));
    const smokeSource = await source('scripts/smokeAdminRoadmap.js');
    const smokeCommand = process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', [
        '/d',
        '/s',
        '/c',
        'npm run admin:roadmap:smoke',
      ]]
      : ['npm', ['run', 'admin:roadmap:smoke']];

    assert.equal(
      packageJson.scripts['admin:roadmap:smoke'],
      'node scripts/smokeAdminRoadmap.js',
    );
    assert.doesNotMatch(
      smokeSource,
      /app\.js|models\/|mongoose|cloudinary|mailgun|DB_URL|connect\s*\(/iu,
    );
    const output = execFileSync(smokeCommand[0], smokeCommand[1], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.match(output, /Admin roadmap smoke passed\./u);
    for (const id of REQUIRED_ITEM_IDS) assert.equal(output.includes(id), false);
  });

  test('AGENTS makes the roadmap authoritative and prevents silent task drift', async () => {
    const agents = await source('AGENTS.md');

    assert.match(agents, /^## Authoritative project roadmap$/mu);
    assert.match(agents, /`config\/adminRoadmap\.js` is the authoritative CampPics roadmap/u);
    assert.match(agents, /`\/a\/roadmap`\s+is its read-only administrator view/u);
    assert.match(agents, /Every future Codex pass must read the roadmap/u);
    assert.match(agents, /Stable item IDs must never be renamed or reused/u);
    assert.match(agents, /update the\s+roadmap in the same patch/u);
    assert.match(agents, /Completed items remain in configuration/u);
    assert.match(agents, /Do not add tasks silently/u);
    assert.match(agents, /concrete blocker or defect is discovered and clearly reported/u);
    assert.match(agents, /Newly discovered work must be labeled as such in notes/u);
    assert.match(agents, /Do not replace the\s+roadmap with MongoDB data or browser editing/u);
    assert.match(agents, /`npm run admin:roadmap:smoke`/u);
  });

  test('startup, models, dependencies, lock metadata and engines remain protected', async () => {
    const [app, packageSource, lockSource] = await Promise.all([
      source('app.js'),
      source('package.json'),
      source('package-lock.json'),
    ]);
    const packageJson = JSON.parse(packageSource);
    const packageLock = JSON.parse(lockSource);
    const headPackage = JSON.parse(headSource('package.json'));
    const headLock = JSON.parse(headSource('package-lock.json'));

    assert.doesNotMatch(app, /adminRoadmap|smokeAdminRoadmap/u);
    assert.equal(gitStatus(
      'models/email.js',
      'models/mediaCleanupJob.js',
      'models/park.js',
      'models/parkSearch.js',
      'models/token.js',
      'models/user.js',
    ).trim(), '');
    assert.equal(gitStatus('models/upload.js').trim(), '');
    assert.equal(gitStatus('package-lock.json').trim(), '');
    assert.deepEqual(packageJson.dependencies, headPackage.dependencies);
    assert.deepEqual(packageLock.packages, headLock.packages);
    assert.deepEqual(packageLock.dependencies, headLock.dependencies);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
    const configSource = await source('config/adminRoadmap.js');
    assert.doesNotMatch(configSource, /mongoose|Schema|\.index\s*\(/u);
  });

  test('administrator pagination, JSON envelope and Block/Unblock implementation remain unchanged', async () => {
    const current = await source('controllers/admin.js');
    const baseline = headSource('controllers/admin.js');
    const paginationSetup = value => value.slice(
      value.indexOf('      // Pagination parameters'),
      value.indexOf('      // Get most recent uploads (10 per page)'),
    );
    const queryThroughLean = (value, startMarker) => {
      const start = value.indexOf(startMarker);
      const end = value.indexOf('.lean();', start) + '.lean();'.length;
      return value.slice(start, end);
    };
    const blockImplementation = value => value.slice(
      value.indexOf('export function createUserBlockHandler'),
    );

    const normalizeLines = value => value.replaceAll('\r\n', '\n');
    assert.equal(
      normalizeLines(paginationSetup(current)),
      normalizeLines(paginationSetup(baseline)),
    );
    assert.equal(
      normalizeLines(queryThroughLean(current, 'const uploadRecords =')),
      normalizeLines(queryThroughLean(baseline, 'const uploadRecords =')),
    );
    assert.equal(
      normalizeLines(queryThroughLean(current, 'const userRecords =')),
      normalizeLines(queryThroughLean(baseline, 'const userRecords =')),
    );
    assert.equal(
      normalizeLines(blockImplementation(current)),
      normalizeLines(blockImplementation(baseline)),
    );
    assert.match(
      current,
      /return res\.json\(\{\s*uploads,\s*users,\s*hasMoreUploads,\s*hasMoreUsers,\s*\}\);/u,
    );
    assert.equal(gitStatus(
      'models/email.js',
      'models/mediaCleanupJob.js',
      'models/park.js',
      'models/parkSearch.js',
      'models/token.js',
      'models/user.js',
      'middleware.js',
    ).trim(), '');

    const blockRoute = routeFor('/user/:id/block');
    const unblockRoute = routeFor('/user/:id/unblock');
    for (const route of [blockRoute, unblockRoute]) {
      assert.deepEqual(Object.keys(route.methods), ['post']);
      assert.strictEqual(route.stack[0].handle, isAdmin);
      assert.strictEqual(route.stack[1].handle, adminUserStatusLimiter);
    }
  });

  test('cleanup processor and operational provider behavior remain outside the patch', () => {
    assert.equal(gitStatus(
      'scripts/processMediaCleanupJobs.js',
      'scripts/reconcileMediaIdentifiers.js',
      'scripts/reconcileEmailLogs.js',
      'scripts/reconcileAuthArtifacts.js',
      'scripts/README-media-identifiers.md',
      'scripts/README-email-logs.md',
      'scripts/README-auth-artifacts.md',
    ).trim(), '');
    assert.equal(gitStatus(
      'config/cloudinary.js',
      'config/runtimeConfig.js',
      'config/runtimeStartup.js',
    ).trim(), '');
  });
});
