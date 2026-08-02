# Authentication-artifact audit and cleanup

This maintenance command audits expired email-verification `Token` documents,
expired password-reset state embedded in `User` documents, and the actual Token
and User collection indexes. It never runs during application startup.

## Dry run

Dry-run is the default and performs no writes:

```sh
npm run auth:audit-artifacts -- --batch-size 100 --sample-limit 20
```

`--batch-size` accepts integers from 1 through 1000 and defaults to 100.
`--sample-limit` accepts integers from 1 through 100 and defaults to 20. Only
the explicit `--apply` option enables writes; unsupported options are rejected.
`DB_URL` must identify the database being intentionally audited.

## Summary semantics

The command prints one content-free JSON summary with `mode`, `complete`,
`verificationTokens`, `passwordResetUsers`, and allowlisted `indexes.tokens`
and `indexes.users` arrays. Each artifact section uses these counters:

- `scanned`: every document included in the audit.
- `planned`: documents eligible because their relevant expiry is a real BSON
  date less than or equal to the single captured audit time.
- `changed`: documents actually deleted or updated; always zero in dry-run.
- `skipped`: audited noncandidates plus apply candidates that disappeared,
  were already cleaned, or no longer satisfied the expiry guard at write time.
- `failed`: candidate IDs in the first failed write batch. Later writes stop.
- `malformed`: unique audited documents with one or more fixed malformed issue
  codes; a document is counted only once.
- `remainingExpired`: eligible records still present at the captured audit time
  after processing and recounting.

`complete` is `true` after a successful dry audit. In apply mode it is `false`
if a write batch failed or either collection still contains an expired
candidate at recount. An incomplete apply exits nonzero.

Samples are separately bounded for expired candidates and malformed records.
They contain only a BSON ObjectId rendered as `recordId` (or `unavailable`) and
fixed issue codes. They never contain token digests, reset codes or claims,
recipient/account data, dates, counters, or arbitrary stored values.

Verification tokens are cleanup candidates only when
`email_verification_expiry` is a real BSON date less than or equal to the audit
time. Missing, null, non-date, and future expiries remain audit-only. A token
can be both a cleanup candidate and malformed because malformed user/code/extra
fields do not make a genuinely expired link usable.

Password-reset state is a cleanup candidate only when
`other_login.reset_password_expiry` is a real BSON date less than or equal to
the audit time. The expiry field itself means reset state exists. Missing,
null, non-date, and future expiries remain audit-only. Expired states remain
eligible even when their code, claim, or counter is malformed.

The code, expiry, and claim fields are transient password-reset artifacts. The
`other_login.reset_password_counter` field is persistent metadata and may
legitimately exist by itself. A counter-only record whose counter is a valid
nonnegative integer is reported under `shape.counterOnlyState`; it is not
active reset state, malformed, or a cleanup candidate. An invalid counter-only
record remains malformed as `invalid-reset-counter` and is separately counted
under `shape.invalidCounterOnlyState`. `shape.transientResetArtifactsPresent`
counts records with at least one code, expiry, or claim field present, while
`shape.noResetFields` continues to mean all four audited paths are absent.

Fixed age buckets describe expired dates only: within the last 24 hours, 2–7
days, 8–30 days, 31–90 days, and more than 90 days. They are informational and
do not establish a retention period.

The index audit reads the live Token and User collection definitions and emits
only `name`, `key`, `unique`, `sparse`, and `expireAfterSeconds` when present.
It never creates, drops, rebuilds, synchronizes, or changes an index.

## Apply prerequisites

Before any apply:

1. Back up MongoDB.
2. Restore the backup to a temporary staging database.
3. Run the dry audit.
4. Review malformed and index categories.
5. Confirm active verification/reset records are not candidates.
6. Run apply against the restored database:
   `npm run auth:cleanup-expired-artifacts -- --batch-size 100 --sample-limit 20`.
7. Rerun the dry audit and verify both `remainingExpired` values are zero.
8. Run apply a second time and verify both `changed` values are zero.
9. Test registration, verification, resend, and password reset against staging.

Apply processes exact candidate IDs in sequential bounded batches. Token
deletion repeats the real-date and `<= audit time` guard at write time.
Password-reset cleanup repeats the same guard, unsets only code, expiry, and
claim, and intentionally leaves persistent counter metadata set to zero. That
valid counter-only result is not reported as malformed on later audits. If a
batch fails, no later writes run, the batch IDs count as failed, safe
remaining-expired recounts are attempted, and the command exits nonzero. These
guards make races and reruns safe and preserve newly active state.

## Production warning

Production apply is not approved merely because this script exists. Complete
the backup, restored-staging audit, review, apply, idempotency, and lifecycle
checks above before requesting a separate production approval.

## Rollback

Deleted expired Token documents and cleared password-reset fields cannot be
reconstructed by this script. Rollback requires restoring the verified
pre-apply backup.

## Deferred index decision

- No TTL/index is added by this pass.
- Audit results and live index state must be reviewed first.
- A future TTL decision requires a separate pass.
- User password-reset subfields cannot be treated as a substitute for
  token-lifecycle validation.
