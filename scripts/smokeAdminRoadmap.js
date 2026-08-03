import {
  VALID_ROADMAP_STATUSES,
  adminRoadmap,
  formatAdminRoadmapPlainText,
  getActiveRoadmapPhases,
  getCompletedRoadmapItems,
  getRoadmapSummary,
  isValidRoadmapStatus,
} from '../config/adminRoadmap.js';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const STABLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ITEM_ARRAY_FIELDS = [
  'scope',
  'notIncluded',
  'dependencies',
  'doneWhen',
  'notes',
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
  'upload-incentive-banner',
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

function assert(condition) {
  if (!condition) throw new Error('Invalid roadmap.');
}

function assertExactKeys(value, expected) {
  assert(Object.keys(value).join('|') === expected.join('|'));
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function assertPlainString(value) {
  assert(typeof value === 'string');
  assert(value.length > 0);
  assert(!/<[a-z!/][^>]*>/iu.test(value));
}

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeeplyFrozen(child);
}

function validateRoadmap() {
  assertExactKeys(adminRoadmap, ['version', 'updatedOn', 'phases']);
  assert(adminRoadmap.version === 1);
  assert(isIsoDate(adminRoadmap.updatedOn));
  assert(Array.isArray(adminRoadmap.phases));
  assert(adminRoadmap.phases.length > 0);
  assertDeeplyFrozen(adminRoadmap);
  assert(Object.isFrozen(VALID_ROADMAP_STATUSES));
  assert(
    VALID_ROADMAP_STATUSES.join('|') ===
      'planned|in_progress|blocked|completed',
  );

  const phaseIds = new Set();
  const itemIds = new Set();
  const itemsById = new Map();

  for (const phase of adminRoadmap.phases) {
    assertExactKeys(phase, ['id', 'title', 'description', 'items']);
    assert(STABLE_ID_PATTERN.test(phase.id));
    assert(!phaseIds.has(phase.id));
    phaseIds.add(phase.id);
    assertPlainString(phase.title);
    assertPlainString(phase.description);
    assert(Array.isArray(phase.items));

    for (const item of phase.items) {
      assertExactKeys(item, [
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
      ]);
      assert(STABLE_ID_PATTERN.test(item.id));
      assert(!itemIds.has(item.id));
      itemIds.add(item.id);
      itemsById.set(item.id, item);
      assertPlainString(item.title);
      assertPlainString(item.purpose);
      assert(isValidRoadmapStatus(item.status));

      for (const field of ITEM_ARRAY_FIELDS) {
        assert(Array.isArray(item[field]));
        for (const value of item[field]) assertPlainString(value);
      }

      assert(item.completedOn === null || isIsoDate(item.completedOn));
      if (item.status !== 'completed') assert(item.completedOn === null);
    }
  }

  for (const id of REQUIRED_ITEM_IDS) assert(itemsById.has(id));
  assert(itemsById.get('schedule-media-cleanup-worker').status === 'planned');
  assert(itemsById.get('source-controlled-admin-roadmap').status === 'completed');

  const activeIds = new Set(
    getActiveRoadmapPhases().flatMap(phase => phase.items.map(item => item.id)),
  );
  const completedIds = new Set(
    getCompletedRoadmapItems().map(item => item.id),
  );
  for (const item of itemsById.values()) {
    if (item.status === 'completed') {
      assert(completedIds.has(item.id));
      assert(!activeIds.has(item.id));
    } else {
      assert(activeIds.has(item.id));
      assert(!completedIds.has(item.id));
    }
  }

  const summary = getRoadmapSummary();
  assert(summary.total === itemIds.size);
  assert(summary.active + summary.completed === summary.total);
  assert(
    summary.planned + summary.inProgress + summary.blocked === summary.active,
  );

  const firstCopy = formatAdminRoadmapPlainText();
  const secondCopy = formatAdminRoadmapPlainText();
  assert(firstCopy === secondCopy);
  assert(firstCopy.startsWith('CampPics administrator roadmap\n'));
  assert(firstCopy.includes('\nActive work\n'));
  assert(firstCopy.includes('\nCompleted work\n'));
  assert(!firstCopy.includes('<'));
}

try {
  validateRoadmap();
  process.stdout.write('Admin roadmap smoke passed.\n');
} catch {
  process.stderr.write('Admin roadmap smoke failed.\n');
  process.exitCode = 1;
}
