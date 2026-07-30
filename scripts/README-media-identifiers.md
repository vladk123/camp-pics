# Media identifier audit and backfill

The audit is read-only by default:

```text
npm run media:audit-identifiers -- --batch-size 100
```

Back up MongoDB before apply mode. Apply mode only sets missing
`cloudinaryUrl` or `cloudinaryPublicId` fields when the identity planner finds
one unambiguous public ID:

```text
npm run media:backfill-identifiers -- --batch-size 100
```

The script never changes `Upload.cloudinaryId`, deletes records, creates
missing companion records, repairs location data, or calls Cloudinary. It
prints bounded samples containing only record IDs, media IDs, applicable
parent IDs, and fixed reason codes.

## Verification

1. Save the dry-run summary.
2. Create and verify a MongoDB backup.
3. Run apply mode and save its summary.
4. Run the dry-run command again. All safely backfillable and planned-change
   counts should be zero unless data changed concurrently.
5. Review conflicts, unresolved identities, duplicates, malformed values, and
   missing companion records before any manual repair.

## Rollback

No legacy field is overwritten, so application reads remain backward
compatible. If the additive backfill must be rolled back, restore the verified
pre-apply MongoDB backup. Do not unset fields broadly: concurrent uploads may
have legitimately created the same additive fields after the backup.
