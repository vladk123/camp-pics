# Media cleanup operations

Individual photo-deletion requests attempt their durable Cloudinary cleanup
job immediately after the MongoDB deletion transaction commits. Scheduled
processing handles durable jobs that remain after temporary provider, network,
or process failures.

Use `npm run media:audit-cleanup` for the default read-only audit. The existing
manual apply command remains `npm run media:process-cleanup -- --limit 50`, and
it can select a single job with `--job-id <id>`. Apply mode calls Cloudinary and
updates cleanup jobs. Neither the manual processor nor the scheduled wrapper is
imported or run by application startup.

## Selected mechanism

CampPics selects Heroku Scheduler for the current simple recurring workload.
Configure it to run every 10 minutes with this command:

```text
npm run media:scheduled-cleanup
```

The command always invokes the existing processor in apply mode with a bounded
limit of 50. It is intended for short bounded batches, not a permanent clock
dyno or general worker queue. Scheduler starts a one-off dyno for each run, and
that one-off dyno usage counts toward Heroku usage.

Heroku Scheduler is not an exactly-once system. An execution can rarely be
skipped, duplicated, or briefly overlap another execution. Jobs remain durable
in MongoDB if a scheduled dyno stops, so a later run can retry eligible work.

## Why overlap is safe

The existing per-job claim and lease implementation is the authoritative
overlap protection:

- `findOneAndUpdate` atomically claims only a currently eligible pending job or
  an expired processing lease.
- Every successful claim receives a unique lease token and lease expiry.
- Provider completion and failure updates require the same job ID and lease
  token.
- A stale worker cannot finalize or release a lease that a newer worker owns.
- The Cloudinary delete result is terminally successful for both `ok` and
  `not found`, preserving safe retries after an uncertain prior completion.

A second global scheduler lock, lock collection, or singleton record is
unnecessary. Per-job leases prevent duplicate provider work during ordinary
overlap while allowing expired work to be reclaimed after interruption.

## Staging checklist

Do not configure production scheduling until all of these steps have been
completed outside this code pass:

1. Deploy the current release to staging.
2. Use a restored production-shaped staging database.
3. Use isolated Cloudinary credentials and an isolated folder.
4. Run `heroku run npm run media:audit-cleanup -a <staging-app>`.
5. Run `heroku run npm run media:scheduled-cleanup -a <staging-app>` manually.
6. Create retryable provider-failure fixtures using test or staging data only.
7. Verify pending jobs receive the expected retry/backoff state.
8. Verify an expired lease can be reclaimed.
9. Run two scheduled commands concurrently and confirm only one provider action
   occurs for a shared eligible job.
10. Rerun the dry audit.
11. Confirm blocked jobs are reviewed manually.
12. Confirm no secret or provider response appears in logs.

These steps were not performed during the code pass that added this runbook.

## Heroku configuration

Provision Heroku Scheduler with the CLI:

```text
heroku addons:create scheduler:standard -a <app>
```

Open its dashboard:

```text
heroku addons:open scheduler -a <app>
```

In the dashboard, add `npm run media:scheduled-cleanup`, choose every 10
minutes, and select the appropriate available one-off dyno size. Do not put
config-var values or secrets directly in the command. Heroku configuration is
manual operational work and is not automated in repository code.

## Monitoring

Scheduled processes appear as `scheduler.X`. Inspect the first scheduled
process with:

```text
heroku logs --ps scheduler.1 -a <app>
```

Inspect current processes with:

```text
heroku ps -a <app>
```

The existing CLI emits a bounded, content-safe JSON summary. Inspect these
fields: `scanned`, `claimed`, `completed`, `stillPending`, `blocked`, `skipped`,
and `failed`.

A nonzero scheduled exit means internal failed work, newly blocked work, or a
fatal startup/setup failure requires attention. `stillPending` with `failed: 0`
and `blocked: 0` is a successful scheduled outcome: the durable job was safely
returned to retry/backoff, not lost. Run `npm run media:audit-cleanup` to inspect
all currently blocked jobs.

## Rerun behavior

Rerunning the scheduled command is safe, including duplicated Scheduler
executions. Active leases prevent another run from claiming the same job,
expired leases are reclaimable, and provider `not found` is accepted after a
prior successful deletion. Manual single-job apply remains available through
`npm run media:process-cleanup -- --job-id <id>`. Blocked jobs are never
automatically deleted.

## Disable and rollback

1. Disable or delete the Scheduler job first.
2. Do not delete durable cleanup records.
3. Run the dry audit.
4. Investigate blocked and pending jobs.
5. Retain existing data and provider identifiers.
6. Redeploy the prior release only if a code rollback is required.
7. Re-enable scheduling only after the issue is understood.

Disabling scheduling stops retries but does not restore Cloudinary assets that
were already deleted.

## Production warning

Production scheduling remains unapproved until staging verification is
completed. Creating this script does not authorize production apply, and
Heroku Scheduler is not an exactly-once system.
