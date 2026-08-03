# CampPics Project Instructions

## Project identity

This repository contains the CampPics website.

Do not use assumptions, architecture, terminology, or implementation details from any other repository or Codex conversation.

## Authoritative project roadmap

`config/adminRoadmap.js` is the authoritative CampPics roadmap. `/a/roadmap`
is its read-only administrator view.

Every future Codex pass must read the roadmap before proposing or editing
work. Stable item IDs must never be renamed or reused. When a pass changes an
existing item's status, scope, dependency, or completion state, update the
roadmap in the same patch. Completed items remain in configuration.

Do not add tasks silently. A new task may be added only when:

* the user requests it; or
* a concrete blocker or defect is discovered and clearly reported.

Newly discovered work must be labeled as such in notes. Do not replace the
roadmap with MongoDB data or browser editing. Run
`npm run admin:roadmap:smoke` after roadmap changes.

## Existing production data

This project already has users, parks, embedded campsite media, Upload records, and user upload-history records.

Treat the database as existing production data, not a clean development database.

### Backward-compatibility rules

* Prefer additive schema changes.
* Do not rename, remove, reinterpret, or overwrite a legacy field in place.
* During migrations, support reading both legacy and new data shapes.
* Dual-write old and new fields temporarily when needed for compatibility.
* Do not assume every historical record contains every current schema field.
* Do not assume Upload records and User.uploads are complete or perfectly synchronized with Park media.
* The embedded Park media must also be inspected when reconciling historical uploads.
* Campsite slugs are not globally unique and may repeat in separate campgrounds.
* Do not add a unique database index without first providing an audit of existing data.

### Migration rules

Any data migration or backfill must:

* be a separate script;
* be idempotent;
* default to dry-run;
* require an explicit `--apply` argument before writing;
* process data in bounded batches where appropriate;
* provide scanned, changed, skipped, malformed, and failed counts;
* avoid deleting data automatically;
* be safe to rerun;
* document rollback and verification steps.

Do not execute migrations automatically during application startup.

Do not rely on Mongoose automatic index creation as a production migration strategy.

## Code quality

* Keep implementation reasonably DRY.
* Reuse small focused helpers and services for behavior used in multiple controllers.
* Do not introduce unnecessary abstraction, frameworks, or large dependency changes.
* Prefer one authoritative implementation for media-target resolution, Cloudinary identifier handling, token generation, validation, and media persistence.
* Duplication across browser and server runtime boundaries is acceptable when sharing code would create fragile coupling, but duplication within the same runtime should be avoided.
* Preserve existing user-facing behavior unless the requested correction requires changing it.
* Do not perform unrelated cleanup.

## Security

Treat all captions, usernames, URLs, request fields, database strings, and API response values as untrusted.

* Do not insert untrusted strings using innerHTML, outerHTML, insertAdjacentHTML, inline event-handler attributes, or string-built JavaScript.
* Prefer createElement, textContent, explicit property assignment, and addEventListener.
* Do not solve stored XSS by rewriting or destructively sanitizing existing captions. Render stored text safely.
* Authentication tokens must be cryptographically random, expiring, hashed at rest, and single-use.
* Never log full user documents, password-reset links, verification links, authentication hashes, session contents, or complete email HTML.

## Workflow

For each requested pass:

1. Confirm the current working directory and Git repository root.
2. Read this AGENTS.md.
3. Inspect all affected call sites before editing.
4. Keep the pass limited to its stated scope.
5. Add focused tests or verification scripts.
6. Run relevant tests and syntax checks.
7. Report all changed files and why each changed.
8. Report any remaining risks or incomplete work.
9. Do not create a Git commit unless explicitly instructed.

Do not claim success merely because syntax passes. Verify the behavior and important failure paths.
