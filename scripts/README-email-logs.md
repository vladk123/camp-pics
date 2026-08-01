# Historical Email log audit and redaction

This maintenance command audits the existing Email collection without returning
stored Email content. It defaults to a read-only dry run:

```text
npm run email:audit-logs -- --batch-size 100 --sample-limit 20
```

`DB_URL` is required. `--batch-size` accepts integers from 1 through 1000;
`--sample-limit` accepts integers from 1 through 100. The defaults are 100 and
20. Unsupported arguments are rejected. Only the exact `--apply` flag enables
writes.

The audit reports exact legacy-field, metadata-shape, malformed-document, age,
future-retention-candidate, and remaining-sensitive counts. Age buckets use the
injected audit time and exact elapsed-time boundaries: future dates; 0 through
30 days; more than 30 through 90 days; more than 90 through 180 days; more than
180 through 365 days; and more than 365 days. The informational retention
counts use the same strict `older than` 30-, 90-, 180-, and 365-day boundaries.

Index definitions are read from the actual Email collection. Output is limited
to normalized `name`, `key`, `unique`, `sparse`, and `expireAfterSeconds`
properties. No index is created, changed, or dropped. `indexCount` and
`indexesTruncated` describe the bounded index summary.

Samples contain only a normalized Email ID and, for malformed records, fixed
issue codes. They never contain recipients, templates, subjects, HTML, message
IDs, dates, links, tokens, user IDs, unknown values, or content fragments.

## Summary contract

The stable top-level result contains:

```text
mode
scanned
planned
changed
skipped
malformed
failed
remainingSensitive
incomplete
legacyFields
metadataShape
ageBuckets
retentionCandidates
indexCount
indexesTruncated
indexes
samples
```

`scanned` is every document included in the audit. `planned` is every audited
document on which `html` or `subject` exists, regardless of value or metadata
quality. `changed` is the number actually modified and is always zero in dry
run. `skipped` includes audited non-candidates plus candidates that disappeared
or no longer matched the guarded write. `malformed` counts each affected
document once. `failed` counts every candidate ID in a failed write batch.
`remainingSensitive` is recounted after the audit or apply processing.
`incomplete` is true when an apply run has a failed batch or still has sensitive
documents.

Malformed issue codes are limited to:

```text
missing-or-invalid-recipient
missing-sent-at
invalid-sent-at
invalid-template-type
invalid-message-id-type
invalid-user-id
unknown-top-level-fields
```

Optional `template` and `messageId` fields are valid BSON strings when present;
`userId` is optional. A missing `userId` and an explicit BSON null are both
accepted, including null values in historical or current records. A present,
non-null `userId` must be a BSON ObjectId; only other present, non-null values
receive `invalid-user-id` and make the document malformed. This command does
not repair, unset, or normalize any `userId` value.

The metadata-shape counters preserve `userIdPresent` and `userIdAbsent` as
field-existence counts. `userIdPresent` includes null and non-null values;
`userIdAbsent` includes only documents where the field does not exist. Present
values are divided into `userIdNull`, `userIdPresentObjectId`, and
`userIdPresentInvalidType`, so these counts reconcile as:

```text
userIdPresent =
  userIdNull +
  userIdPresentObjectId +
  userIdPresentInvalidType
```

A recipient must be a non-empty BSON string. `sentAt` must be a real BSON date.
Missing `template` is expected for legacy records. Legacy content alone is not
malformed.

## Apply warning

Apply mode is invoked explicitly with:

```text
npm run email:redact-legacy-content -- --batch-size 100 --sample-limit 20
```

Before apply mode, the operator must:

1. Back up MongoDB.
2. Restore that backup to a temporary staging database.
3. Run and review the dry audit against the restored database.
4. Confirm the output contains no unexpected indexes or malformed categories.
5. Run apply against the restored database.
6. Rerun the dry audit and verify `planned` and `remainingSensitive` are zero.
7. Confirm authentication, account deletion, and new Email metadata writes still operate.

Production apply is not approved merely because this script exists. Review the
production-shaped audit and the restored-database rehearsal before seeking a
separate production approval.

Apply processing reads candidate `_id` values only, in sequential bounded
batches. Each batch performs one guarded operation equivalent to:

```js
collection.updateMany(
  {
    _id: { $in: exactCandidateIds },
    $or: [
      { html: { $exists: true } },
      { subject: { $exists: true } },
    ],
  },
  { $unset: { html: '', subject: '' } },
)
```

No other field is changed and no Email document is deleted. A candidate that
disappears or is concurrently redacted is skipped safely. Failed batches are
counted in full; processing continues with the next sequential batch. The CLI
prints a fixed incomplete warning and uses a nonzero exit status. Rerunning is
safe because the write-time existence guard and `$unset` make redaction
idempotent.

## Rollback

`$unset` permanently removes historical HTML and subject data. The script
cannot reconstruct removed content. Rollback requires restoring the verified
pre-apply backup.

## Deferred retention decision

This pass deletes no documents, selects no retention period, creates no expiry
field, and adds no TTL index. The age distributions and actual index audit will
support a later, separately reviewed retention decision after production-shaped
results have been reviewed.
