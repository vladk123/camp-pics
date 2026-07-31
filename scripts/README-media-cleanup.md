# Media cleanup operations

Individual photo-deletion requests attempt their durable Cloudinary cleanup
job immediately after the MongoDB deletion transaction commits. That handles
the common case, but `media:process-cleanup` must eventually be scheduled so
temporary provider and network failures are retried.

Use `npm run media:audit-cleanup` for the default read-only audit. Apply mode
requires `npm run media:process-cleanup -- --limit 50`; a single job can be
selected with `--job-id <id>`. Apply mode calls Cloudinary and updates cleanup
jobs. It is not imported or run by application startup.

Add production scheduling only after staging verification. Do not use apply
mode against production until it has been tested with a restored production
database and a test Cloudinary account or folder. Jobs are idempotent and are
retained until Cloudinary reports either `ok` or `not found`; blocked jobs
require manual investigation and are never deleted automatically.
