export const VALID_ROADMAP_STATUSES = Object.freeze([
  'planned',
  'in_progress',
  'blocked',
  'completed',
]);

const ACTIVE_STATUS_SET = new Set(
  VALID_ROADMAP_STATUSES.filter(status => status !== 'completed'),
);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const roadmapDefinition = {
  version: 1,
  updatedOn: '2026-08-03',
  phases: [
    {
      id: 'operations-launch-readiness',
      title: 'Operations and launch readiness',
      description: 'Operational verification and deployment work required for a safe launch.',
      items: [
        {
          id: 'schedule-media-cleanup-worker',
          title: 'Schedule the media cleanup worker',
          status: 'blocked',
          purpose: 'Reliably process durable MediaCleanupJob records created when post-commit Cloudinary cleanup cannot finish immediately.',
          scope: [
            'Choose the appropriate Heroku scheduling mechanism.',
            'Run the existing cleanup processor explicitly in apply mode.',
            'Prevent unsafe overlapping runs.',
            'Preserve bounded batches, retries and safe logging.',
            'Document monitoring, failure and rerun behavior.',
            'Validate in staging before production scheduling.',
          ],
          notIncluded: [
            'Replacing the cleanup outbox.',
            'Changing media deletion transactions.',
            'Changing Cloudinary identifier behavior.',
          ],
          dependencies: [
            'Existing media-cleanup CLI and durable job collection.',
            'Staging verification.',
          ],
          doneWhen: [
            'Scheduled execution is documented and configured.',
            'Overlapping invocation behavior is safe.',
            'Staging retries are verified.',
            'Production enablement has a clear rollback/disable procedure.',
          ],
          notes: [
            'Heroku Scheduler was selected for the current simple recurring workload.',
            'The intended command is `npm run media:scheduled-cleanup`.',
            'The intended frequency is every 10 minutes.',
            'The scheduled command and documentation are complete.',
            'Heroku Scheduler is intentionally not enabled.',
            'Enabling Heroku Scheduler requires explicit future user approval.',
            'This deferred activation is not a blocker for current product work or deployment.',
          ],
          completedOn: null,
        },
        {
          id: 'restore-production-shaped-staging-database',
          title: 'Create a production-shaped staging database',
          status: 'completed',
          purpose: 'Create an isolated staging database through a direct, read-only copy from production.',
          scope: [
            'Create an isolated `camppics_staging` database in the existing Atlas cluster.',
            'Restrict a staging-only database user to `camppics_staging`.',
            'Copy production-shaped data directly with the existing MongoDB Node driver.',
            'Verify collection sets, current document counts and standard indexes.',
            'Keep production read-only and unchanged throughout the copy.',
            'Keep production credentials out of scripts and logs.',
          ],
          notIncluded: [
            'Creating a local backup archive or disaster-recovery backup.',
            'Modifying production data.',
            'Automatic startup migrations.',
          ],
          dependencies: [
            'Authorized read-only production database access.',
            'Isolated staging database access in the existing Atlas cluster.',
          ],
          doneWhen: [
            'Production-shaped data is directly copied into the isolated `camppics_staging` database.',
            'Collection sets, current document counts and standard indexes match after copying.',
            'Production remains read-only and unchanged.',
            'Staging access and operational safeguards are documented.',
          ],
          notes: [
            'The isolated `camppics_staging` database was created in the existing Atlas cluster.',
            'A staging-only database user was restricted to `camppics_staging`.',
            'Production-shaped data was copied directly using the existing MongoDB Node driver.',
            'No local backup archive or disaster-recovery backup was created or verified.',
            'Production was read-only and remained unchanged.',
            'Collection sets, current counts and standard indexes matched after copying.',
            'Staging remained in maintenance mode with `web=0`.',
            'Staging Cloudinary and Mailgun credentials remained absent.',
            'Staging contains production-derived data and must remain private and controlled.',
          ],
          completedOn: '2026-08-03',
        },
        {
          id: 'run-maintenance-dry-audits',
          title: 'Run maintenance dry audits',
          status: 'blocked',
          purpose: 'Run all maintenance tools in read-only mode against production-shaped staging data.',
          scope: [
            'Media identifier audit.',
            'Email-log audit.',
            'Expired authentication-artifact audit.',
            'Media-cleanup-job audit.',
            'Review malformed, conflict, skipped and index categories.',
          ],
          notIncluded: [
            'Applying writes.',
            'Production execution.',
          ],
          dependencies: [
            'restore-production-shaped-staging-database.',
          ],
          doneWhen: [
            'Every audit completes.',
            'Summaries are retained outside source control when sensitive.',
            'Malformed/conflict categories are reviewed.',
          ],
          notes: [
            'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
          ],
          completedOn: null,
        },
        {
          id: 'test-maintenance-apply-idempotence',
          title: 'Test maintenance apply idempotence',
          status: 'blocked',
          purpose: 'Verify every maintenance write path safely against production-shaped staging data.',
          scope: [
            'Create a fresh or resettable staging copy.',
            'Run each required apply command.',
            'Rerun dry audit.',
            'Run apply a second time.',
            'Verify the second apply changes zero records.',
            'Verify affected application flows afterward.',
          ],
          notIncluded: [
            'Production apply approval.',
          ],
          dependencies: [
            'run-maintenance-dry-audits.',
            'Reviewed audit results.',
          ],
          doneWhen: [
            'Apply behavior is verified.',
            'Remaining candidate counts are expected.',
            'Second runs are idempotent.',
            'Rollback steps are proven.',
          ],
          notes: [
            'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
          ],
          completedOn: null,
        },
        {
          id: 'verify-mongodb-transaction-support',
          title: 'Verify MongoDB transaction support',
          status: 'blocked',
          purpose: 'Confirm the actual deployment supports MongoDB transactions and sessions used by media creation, deletion and account deletion.',
          scope: [
            'Verify replica-set or transaction-capable deployment.',
            'Test commit and abort behavior in staging.',
            'Verify post-commit cleanup behavior.',
            'Verify session lifecycle.',
          ],
          notIncluded: [
            'Changing transaction architecture unless a real incompatibility is found.',
          ],
          dependencies: [
            'Production-shaped staging environment.',
          ],
          doneWhen: [
            'Required transaction flows pass against real staging MongoDB.',
            'Failure and rollback behavior are documented.',
          ],
          notes: [
            'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
          ],
          completedOn: null,
        },
        {
          id: 'validate-isolated-provider-flows',
          title: 'Validate isolated provider flows',
          status: 'blocked',
          purpose: 'Verify external-provider behavior without using production customer data.',
          scope: [
            'Isolated Cloudinary upload and deletion.',
            'Cleanup-job retry after provider failure.',
            'Test Mailgun delivery.',
            'Metadata-only Email logging.',
            'Provider failure containment.',
          ],
          notIncluded: [
            'Sending production campaigns.',
            'Destructive production media testing.',
          ],
          dependencies: [
            'Isolated provider credentials.',
            'Staging environment.',
          ],
          doneWhen: [
            'Upload/delete and email flows pass.',
            'No secret or private content enters logs.',
            'Retry behavior is verified.',
          ],
          notes: [
            'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
          ],
          completedOn: null,
        },
        {
          id: 'deployment-smoke-proxy-sessions-rate-limits',
          title: 'Smoke-test proxy, sessions and rate limits',
          status: 'planned',
          purpose: 'Verify deployment-specific behavior that unit tests cannot prove.',
          scope: [
            'Heroku trust-proxy topology.',
            'Client IP resolution.',
            'Session persistence.',
            'Authentication lifecycle.',
            'Route-specific rate limits.',
            'Health endpoint.',
            'Representative public and administrator routes.',
          ],
          notIncluded: [
            'Multi-dyno shared rate-limit storage unless scaling is planned.',
          ],
          dependencies: [
            'Staging or controlled deployment.',
          ],
          doneWhen: [
            'Smoke checklist passes.',
            'Expected proxy/session behavior is documented.',
            'No deployment-only failure remains.',
          ],
          notes: [
            'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
          ],
          completedOn: null,
        },
        {
          id: 'browser-csp-vendor-verification',
          title: 'Verify browser CSP and vendor behavior',
          status: 'planned',
          purpose: 'Verify browser behavior before making any further style CSP change.',
          scope: [
            'Leaflet maps.',
            'Swiper galleries.',
            'Fullscreen media.',
            'GTM.',
            'GA4.',
            'Browser console CSP violations.',
            'Runtime inline styles created by vendor libraries.',
          ],
          notIncluded: [
            'Removing style-src unsafe-inline before verification.',
          ],
          dependencies: [
            'Controlled deployed browser environment.',
          ],
          doneWhen: [
            'Important pages work without unexpected CSP violations.',
            'A documented decision is made on the remaining style allowance.',
          ],
          notes: [
            'Deferred operational validation; it is not a blocker for the current dashboard/product release.',
          ],
          completedOn: null,
        },
      ],
    },
    {
      id: 'admin-product-experience',
      title: 'Administrator and product experience',
      description: 'Administrator visibility and product improvements planned for CampPics.',
      items: [
        {
          id: 'source-controlled-admin-roadmap',
          title: 'Source-controlled administrator roadmap',
          status: 'completed',
          purpose: 'Keep CampPics priorities visible to the administrator and authoritative for future Codex work.',
          scope: [
            'Source-controlled roadmap configuration.',
            'Admin-only read-only page.',
            'Stable IDs and statuses.',
            'Completed history.',
            'Detail modal.',
            'Copy action.',
            'Smoke command.',
            'AGENTS.md workflow rules.',
          ],
          notIncluded: [
            'Database editing.',
            'Browser editing.',
            'Project-management integrations.',
          ],
          dependencies: [
            'None.',
          ],
          doneWhen: [
            '`/a/roadmap` is available only to administrators.',
            'The smoke command passes.',
            'Future passes are required to consult the roadmap.',
          ],
          notes: [],
          completedOn: '2026-08-02',
        },
        {
          id: 'redesign-admin-dashboard',
          title: 'Redesign the administrator dashboard',
          status: 'completed',
          purpose: 'Replace the current dense administrator page with a clear responsive operational dashboard.',
          scope: [
            'Responsive layout.',
            'Useful summary cards.',
            'Clearer recent-upload and recent-user sections.',
            'Accessible controls.',
            'Preserve current safe API and Block/Unblock contracts.',
            'Integrate a clear link to the roadmap.',
          ],
          notIncluded: [
            'Changing administrator serialization.',
            'Adding broad new backend features in the first UI pass.',
          ],
          dependencies: [
            'source-controlled-admin-roadmap.',
            'Priority after launch-readiness operational work is under control.',
          ],
          doneWhen: [
            'Dashboard is usable on desktop and mobile.',
            'Existing administrator functions remain intact.',
            'Focused browser and rendering tests pass.',
          ],
          notes: [
            'The completed first dashboard pass includes a responsive layout and summary cards.',
            'Uploads and users now have clearer sections with accessible status badges and controls.',
            'Loading, empty and error states are included for the existing pagination controls.',
            'Existing administrator APIs and Block/Unblock behavior remain unchanged.',
            'Recent-upload Park and Campground links now open the corresponding public location in a new tab.',
          ],
          completedOn: '2026-08-03',
        },
        {
          id: 'admin-user-detail',
          title: 'Administrator user details',
          status: 'completed',
          purpose: 'Allow administrators to review a user’s safe account status, stored login timestamps and uploads.',
          scope: [
            'Admin-only user detail page.',
            'Dashboard user links.',
            'Safe account summary.',
            'Timestamp-only login activity.',
            'Paginated user uploads.',
            'Existing Block/Unblock controls.',
            'Existing Park/Campground links.',
          ],
          notIncluded: [
            'IP or user-agent display.',
            'Session or token inspection.',
            'Impersonation.',
            'Email or password actions.',
            'Account deletion.',
            'Editing user data.',
          ],
          dependencies: [
            'redesign-admin-dashboard.',
          ],
          doneWhen: [
            'The admin-only route is protected.',
            'Safe account and login timestamps render.',
            'Every user upload is accessible through pagination.',
            'Sensitive authentication data is excluded.',
            'Focused and complete tests pass.',
          ],
          notes: [],
          completedOn: '2026-08-03',
        },
        {
          id: 'upload-incentive-banner',
          title: 'Site-wide announcements and campaigns',
          status: 'planned',
          purpose: 'Provide one safe administrator-managed site-wide announcement or campaign at a time.',
          scope: [
            'One active announcement at a time.',
            'Administrator enable/disable and editing.',
            'Optional automatic modal display.',
            'Revision-based browser dismissal.',
            'Optional administrator-selected navbar link text.',
            'Optional start and end dates.',
            'Safe plain-text content and an optional validated internal link.',
            'Monthly upload promotion and winner announcements as initial use cases.',
          ],
          notIncluded: [
            'Advanced targeting.',
            'Rich text.',
            'Images.',
            'Analytics dashboards.',
            'Account-level dismissal.',
          ],
          dependencies: [
            'redesign-admin-dashboard.',
            'Approved announcement content and placement.',
          ],
          doneWhen: [
            'Administrators can safely manage one active announcement.',
            'Optional scheduling, modal display and navbar link behavior are tested.',
            'Revision dismissal works without account-level tracking.',
          ],
          notes: [
            'This wording broadens the planned upload incentive into a reusable announcement system; implementation is not part of the administrator user-detail pass.',
          ],
          completedOn: null,
        },
      ],
    },
    {
      id: 'conditional-maintenance',
      title: 'Conditional and deferred maintenance',
      description: 'Work that becomes actionable only when its stated evidence or dependency exists.',
      items: [
        {
          id: 'shared-rate-limit-store-before-multi-dyno',
          title: 'Add a shared rate-limit store before multi-dyno scaling',
          status: 'blocked',
          purpose: 'Use shared rate-limit state before running multiple web dynos.',
          scope: [
            'Select shared storage.',
            'Use unique limiter prefixes.',
            'Verify failure behavior.',
            'Deploy before horizontal web scaling.',
          ],
          notIncluded: [
            'Adding infrastructure while CampPics remains on one web dyno.',
          ],
          dependencies: [
            'Actual decision to use multiple web dynos.',
          ],
          doneWhen: [
            'Every limiter shares coordinated storage.',
            'Multi-dyno behavior is tested.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'review-token-ttl-and-retention',
          title: 'Review token TTL and retention',
          status: 'blocked',
          purpose: 'Decide whether TTL or retention changes are justified by real audit results.',
          scope: [
            'Review Token collection indexes.',
            'Review expired-auth-artifact staging audit.',
            'Review Email retention needs.',
            'Make separate index or retention proposals.',
          ],
          notIncluded: [
            'Adding an index before auditing production-shaped data.',
          ],
          dependencies: [
            'run-maintenance-dry-audits.',
          ],
          doneWhen: [
            'Explicit keep/change decisions are documented.',
            'Any schema/index pass is separately reviewed.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'targeted-dependency-maintenance',
          title: 'Perform targeted dependency maintenance',
          status: 'planned',
          purpose: 'Perform dependency upgrades only when evidence justifies them.',
          scope: [
            'Cloudinary major upgrade only with focused provider compatibility tests.',
            'Sharp upgrade only with image-processing and native-runtime tests.',
            'Express maintenance only when advisory or compatibility evidence warrants it.',
            'Normal periodic npm audit review.',
          ],
          notIncluded: [
            'Chasing a zero audit count.',
            'Upgrading every package merely because a newer version exists.',
          ],
          dependencies: [
            'Concrete advisory, support requirement or functional need.',
          ],
          doneWhen: [
            'Actionable supported upgrades are completed without unrelated churn.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'final-dead-code-dry-sweep',
          title: 'Perform a final dead-code dry sweep',
          status: 'planned',
          purpose: 'Perform one final narrow cleanup after operational and administrator work.',
          scope: [
            'Dead imports.',
            'Dead helpers.',
            'Stale comments.',
            'Clear same-runtime duplication.',
            'Documentation alignment.',
          ],
          notIncluded: [
            'Architectural rewrites.',
            'Abstraction for its own sake.',
          ],
          dependencies: [
            'Operational tasks and dashboard redesign substantially complete.',
          ],
          doneWhen: [
            'Focused source review finds no meaningful safe cleanup remaining.',
          ],
          notes: [],
          completedOn: null,
        },
      ],
    },
    {
      id: 'completed-foundation',
      title: 'Completed foundation work',
      description: 'Retained history of the security, reliability and maintenance foundation already delivered.',
      items: [
        {
          id: 'auth-session-hardening',
          title: 'Authentication and session hardening',
          status: 'completed',
          purpose: 'Protect authentication state and invalidate stale authenticated sessions safely.',
          scope: [
            'Secure verification and reset tokens with expiry and single-use behavior.',
            'Password policy enforcement.',
            'Authentication-version invalidation.',
            'Callback-safe logout.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'Verification, reset, password and logout lifecycle protections are enforced by focused tests.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'csrf-csp-safe-rendering',
          title: 'CSRF, CSP and safe rendering',
          status: 'completed',
          purpose: 'Protect browser requests and render untrusted stored or request data without executable markup.',
          scope: [
            'Synchronizer CSRF protection.',
            'Per-response CSP nonces.',
            'Externalized application scripts.',
            'Removal of CampPics-authored inline styles.',
            'Safe DOM rendering and stored-XSS protections.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'CSRF, nonce, external-script, inline-style and hostile-rendering tests pass.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'bounded-media-upload-hardening',
          title: 'Bounded media upload hardening',
          status: 'completed',
          purpose: 'Keep media uploads bounded, validated and attached to the exact intended campsite.',
          scope: [
            'Exact campsite targeting.',
            'Bounded Multer parsing.',
            'Image validation.',
            'Media quotas.',
            'Cloudinary identity compatibility.',
            'Upload race protection.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'Targeting, parsing, validation, quota, identity and race protections pass focused tests.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'transactional-media-account-deletion',
          title: 'Transactional media and account deletion',
          status: 'completed',
          purpose: 'Keep media and account mutations consistent while making provider cleanup durable after commit.',
          scope: [
            'Transactional media creation.',
            'Transactional media deletion.',
            'Transactional account deletion.',
            'Durable post-commit cleanup jobs.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'Commit, abort, deletion and durable cleanup-job paths pass focused tests.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'maintenance-audit-tooling',
          title: 'Maintenance audit tooling',
          status: 'completed',
          purpose: 'Provide bounded, auditable maintenance commands for existing production-shaped data.',
          scope: [
            'Media identifier reconciliation.',
            'Email-log reconciliation.',
            'Expired authentication-artifact reconciliation.',
            'Media-cleanup processing.',
            'Dry-run defaults and explicit apply conventions.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'Each maintenance path defaults to dry-run, requires explicit apply and reports bounded safe summaries.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'route-abuse-controls',
          title: 'Route abuse controls',
          status: 'completed',
          purpose: 'Bound repeated sensitive and resource-intensive requests with route-specific policies.',
          scope: [
            'Authentication and contact limits.',
            'Media mutation limits.',
            'Password and account limits.',
            'Public JSON limits.',
            'Administrator action limits.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'The scoped routes enforce the documented limiter order, keys and safe fixed responses.',
          ],
          notes: [],
          completedOn: null,
        },
        {
          id: 'runtime-dependency-cleanup',
          title: 'Runtime and dependency cleanup',
          status: 'completed',
          purpose: 'Keep startup configuration explicit and the committed dependency surface supported and intentional.',
          scope: [
            'Typed startup configuration.',
            'Direct dependency corrections.',
            'Removal of unused dependencies.',
            'Focused supported security updates through the current committed state.',
          ],
          notIncluded: [],
          dependencies: ['None.'],
          doneWhen: [
            'Startup validation and dependency source guards pass against the current committed runtime policy.',
          ],
          notes: [],
          completedOn: null,
        },
      ],
    },
  ],
};

export const adminRoadmap = deepFreeze(roadmapDefinition);

export function isValidRoadmapStatus(status) {
  return VALID_ROADMAP_STATUSES.includes(status);
}

export function getActiveRoadmapPhases(roadmap = adminRoadmap) {
  return roadmap.phases
    .map(phase => Object.freeze({
      id: phase.id,
      title: phase.title,
      description: phase.description,
      items: Object.freeze(
        phase.items.filter(item => ACTIVE_STATUS_SET.has(item.status)),
      ),
    }))
    .filter(phase => phase.items.length > 0);
}

export function getCompletedRoadmapItems(roadmap = adminRoadmap) {
  return roadmap.phases.flatMap(phase => phase.items
    .filter(item => item.status === 'completed')
    .map(item => Object.freeze({
      ...item,
      phaseId: phase.id,
      phaseTitle: phase.title,
    })));
}

export function getRoadmapSummary(roadmap = adminRoadmap) {
  const counts = {
    total: 0,
    active: 0,
    planned: 0,
    inProgress: 0,
    blocked: 0,
    completed: 0,
  };

  for (const phase of roadmap.phases) {
    for (const item of phase.items) {
      counts.total += 1;
      if (item.status === 'completed') {
        counts.completed += 1;
      } else {
        counts.active += 1;
      }
      if (item.status === 'planned') counts.planned += 1;
      if (item.status === 'in_progress') counts.inProgress += 1;
      if (item.status === 'blocked') counts.blocked += 1;
    }
  }

  return Object.freeze(counts);
}

function appendList(lines, label, values) {
  lines.push(`  ${label}:`);
  if (values.length === 0) {
    lines.push('    - None.');
    return;
  }
  for (const value of values) lines.push(`    - ${value}`);
}

function appendPlainTextItem(lines, item) {
  lines.push(`- ${item.title} [${item.status}] (${item.id})`);
  lines.push(`  Purpose: ${item.purpose}`);
  appendList(lines, 'Dependencies', item.dependencies);
  appendList(lines, 'Done when', item.doneWhen);
}

export function formatAdminRoadmapPlainText(roadmap = adminRoadmap) {
  const lines = [
    'CampPics administrator roadmap',
    `Version: ${roadmap.version}`,
    `Updated: ${roadmap.updatedOn}`,
    '',
    'Active work',
  ];

  for (const phase of getActiveRoadmapPhases(roadmap)) {
    lines.push('', phase.title);
    for (const item of phase.items) appendPlainTextItem(lines, item);
  }

  lines.push('', 'Completed work');
  const completedByPhase = new Map();
  for (const item of getCompletedRoadmapItems(roadmap)) {
    if (!completedByPhase.has(item.phaseTitle)) {
      completedByPhase.set(item.phaseTitle, []);
    }
    completedByPhase.get(item.phaseTitle).push(item);
  }
  for (const [phaseTitle, items] of completedByPhase) {
    lines.push('', phaseTitle);
    for (const item of items) appendPlainTextItem(lines, item);
  }

  return `${lines.join('\n')}\n`;
}
