import {
  classifyLegacyCloudinaryId,
  normalizeCloudinaryPublicId,
  parseCloudinaryDeliveryUrl,
  resolveCloudinaryPhotoIdentity,
} from './cloudinaryPhotoIdentity.js';

const SAMPLE_LIMIT = 10;

export const MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS = Object.freeze({
  MISSING_MEDIA_ID: 'MISSING_MEDIA_ID',
  EMBEDDED_PHOTO_MISSING_PARK_ID: 'EMBEDDED_PHOTO_MISSING_PARK_ID',
  EMBEDDED_PHOTO_INVALID_LOCATOR_LEVEL:
    'EMBEDDED_PHOTO_INVALID_LOCATOR_LEVEL',
  STANDALONE_PHOTO_MISSING_CAMPSITE_ID:
    'STANDALONE_PHOTO_MISSING_CAMPSITE_ID',
  CAMPGROUND_PHOTO_MISSING_CAMPGROUND_ID:
    'CAMPGROUND_PHOTO_MISSING_CAMPGROUND_ID',
  CAMPGROUND_PHOTO_MISSING_CAMPSITE_ID:
    'CAMPGROUND_PHOTO_MISSING_CAMPSITE_ID',
  UPLOAD_RECORD_MISSING_RECORD_ID: 'UPLOAD_RECORD_MISSING_RECORD_ID',
  USER_HISTORY_MISSING_USER_ID: 'USER_HISTORY_MISSING_USER_ID',
  USER_HISTORY_MISSING_RECORD_ID: 'USER_HISTORY_MISSING_RECORD_ID',
});

export function createMediaIdentifierSummary({ apply = false } = {}) {
  return {
    mode: apply ? 'APPLY MODE' : 'DRY RUN',
    embeddedParkPhotosScanned: 0,
    uploadPhotoRecordsScanned: 0,
    userPhotoHistoryEntriesScanned: 0,
    recordsAlreadyContainingCorrectExplicitPublicId: 0,
    safelyBackfillableParkPhotoFields: 0,
    safelyBackfillableUploadUrlFields: 0,
    safelyBackfillableUploadPublicIdFields: 0,
    safelyBackfillableUserHistoryPublicIdFields: 0,
    malformedUrls: 0,
    malformedRecords: 0,
    unresolvedIdentities: 0,
    conflictingIdentities: 0,
    duplicateUploadRecordsForMediaId: 0,
    duplicateEmbeddedPhotosForMediaId: 0,
    duplicateUserHistoryEntriesForMediaId: 0,
    uploadRecordsWithoutEmbeddedParkPhoto: 0,
    userHistoryEntriesWithoutEmbeddedParkPhoto: 0,
    embeddedParkPhotosMissingUploadRecord: 0,
    embeddedParkPhotosMissingUserHistoryEntry: 0,
    recordsMissingMediaId: 0,
    unaddressableRecords: 0,
    embeddedPhotosMissingParkId: 0,
    embeddedPhotosInvalidLocatorLevel: 0,
    standalonePhotosMissingCampsiteLocator: 0,
    campgroundPhotosMissingCampgroundLocator: 0,
    campgroundPhotosMissingCampsiteLocator: 0,
    uploadRecordsMissingRecordId: 0,
    userHistoryEntriesMissingUserId: 0,
    userHistoryEntriesMissingRecordId: 0,
    plannedChanges: 0,
    modifiedFields: 0,
    skippedRecords: 0,
    failedReadsOrWrites: 0,
    samples: {},
  };
}

function idString(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized && normalized !== '[object Object]' ? normalized : null;
}

function addSample(
  summary,
  category,
  record,
  { reasonCode = null, parentRecordId = null } = {},
) {
  const samples = summary.samples[category] || [];
  if (samples.length >= SAMPLE_LIMIT) return;
  const sample = {};
  const recordId = idString(record?.recordId ?? record?._id);
  const mediaId = idString(record?.mediaId);
  const parentId = idString(parentRecordId);
  if (recordId) sample.recordId = recordId;
  if (mediaId) sample.mediaId = mediaId;
  if (parentId) sample.parentRecordId = parentId;
  if (reasonCode) sample.reasonCode = reasonCode;
  samples.push(sample);
  summary.samples[category] = samples;
}

export function getMediaIdentifierRecordAddressability(recordType, record) {
  const reasons = [];
  const addMissingMediaId = () => {
    if (!idString(record?.mediaId)) {
      reasons.push(
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS.MISSING_MEDIA_ID,
      );
    }
  };

  addMissingMediaId();

  if (recordType === 'embeddedPhoto') {
    if (!idString(record?.parkId)) {
      reasons.push(
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .EMBEDDED_PHOTO_MISSING_PARK_ID,
      );
    }

    const level = record?.locator?.level;
    if (level === 'standaloneCampsite') {
      if (!idString(record?.locator?.campsiteId)) {
        reasons.push(
          MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
            .STANDALONE_PHOTO_MISSING_CAMPSITE_ID,
        );
      }
    } else if (level === 'campgroundCampsite') {
      if (!idString(record?.locator?.campgroundId)) {
        reasons.push(
          MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
            .CAMPGROUND_PHOTO_MISSING_CAMPGROUND_ID,
        );
      }
      if (!idString(record?.locator?.campsiteId)) {
        reasons.push(
          MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
            .CAMPGROUND_PHOTO_MISSING_CAMPSITE_ID,
        );
      }
    } else if (level !== 'park') {
      reasons.push(
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .EMBEDDED_PHOTO_INVALID_LOCATOR_LEVEL,
      );
    }
  } else if (recordType === 'upload') {
    if (!idString(record?.recordId ?? record?._id)) {
      reasons.push(
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .UPLOAD_RECORD_MISSING_RECORD_ID,
      );
    }
  } else if (recordType === 'userHistory') {
    if (!idString(record?.userId)) {
      reasons.push(
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .USER_HISTORY_MISSING_USER_ID,
      );
    }
    if (!idString(record?.recordId ?? record?._id)) {
      reasons.push(
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .USER_HISTORY_MISSING_RECORD_ID,
      );
    }
  } else {
    throw new Error(`Unsupported reconciliation record type: ${recordType}`);
  }

  return {
    addressable: reasons.length === 0,
    reasons,
  };
}

function groupByMediaId(records, recordType) {
  const groups = new Map();
  records.forEach((record, index) => {
    const mediaId = idString(record.mediaId);
    const key = mediaId || `missing:${recordType}:${idString(
      record.recordId ?? record._id,
    ) || index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return groups;
}

function hasOwn(record, field) {
  return record != null &&
    Object.prototype.hasOwnProperty.call(record, field);
}

function malformedForPrefix(malformedSources, prefix) {
  return malformedSources.some(source => source.startsWith(prefix));
}

function planChange(changes, kind, record, value) {
  changes.push({
    kind,
    recordId: record.recordId ?? record._id,
    mediaId: record.mediaId,
    locator: record.locator,
    parkId: record.parkId,
    userId: record.userId,
    value,
  });
}

export function planMediaIdentifierGroup({
  embeddedRecords = [],
  uploadRecords = [],
  userHistoryEntries = [],
  duplicateEmbedded = false,
  duplicateUploads = false,
  duplicateUserHistory = false,
} = {}) {
  const recordCount =
    embeddedRecords.length + uploadRecords.length + userHistoryEntries.length;
  const changes = [];
  const addressabilityResults = [
    ...embeddedRecords.map(record => ({
      recordType: 'embeddedPhoto',
      record,
      ...getMediaIdentifierRecordAddressability('embeddedPhoto', record),
    })),
    ...uploadRecords.map(record => ({
      recordType: 'upload',
      record,
      ...getMediaIdentifierRecordAddressability('upload', record),
    })),
    ...userHistoryEntries.map(record => ({
      recordType: 'userHistory',
      record,
      ...getMediaIdentifierRecordAddressability('userHistory', record),
    })),
  ];
  const addressabilityByRecord = new Map(
    addressabilityResults.map(result => [result.record, result]),
  );
  const unaddressableRecords = addressabilityResults.filter(
    result => !result.addressable,
  );

  if (duplicateEmbedded || duplicateUploads || duplicateUserHistory) {
    return {
      changes,
      skippedRecords: recordCount,
      malformedUrls: 0,
      malformedRecords: 0,
      unresolved: false,
      conflict: false,
      alreadyCorrect: 0,
      duplicate:
        duplicateEmbedded || duplicateUploads || duplicateUserHistory,
      unaddressableRecords,
    };
  }

  const embedded = embeddedRecords[0] || null;
  const photo = embedded?.photo || null;
  const uploads = uploadRecords.map(record => record.upload || record);
  const userUploads = userHistoryEntries.map(record =>
    record.upload || record
  );
  const identity = resolveCloudinaryPhotoIdentity({
    photo,
    uploads,
    userUploads,
  });

  const malformedRecords = [
    photo && malformedForPrefix(identity.malformedSources, 'photo.')
      ? embedded
      : null,
    ...uploadRecords.filter((record, index) =>
      malformedForPrefix(identity.malformedSources, `upload[${index}].`)
    ),
    ...userHistoryEntries.filter((record, index) =>
      malformedForPrefix(identity.malformedSources, `userUpload[${index}].`)
    ),
  ].filter(Boolean);

  if (identity.conflict) {
    return {
      changes,
      skippedRecords: recordCount,
      malformedUrls: identity.malformedSources.length,
      malformedRecords: malformedRecords.length,
      unresolved: false,
      conflict: true,
      alreadyCorrect: 0,
      duplicate: false,
      unaddressableRecords,
    };
  }
  if (!identity.publicId) {
    return {
      changes,
      skippedRecords: recordCount,
      malformedUrls: identity.malformedSources.length,
      malformedRecords: malformedRecords.length,
      unresolved: true,
      conflict: false,
      alreadyCorrect: 0,
      duplicate: false,
      unaddressableRecords,
    };
  }

  let alreadyCorrect = 0;
  let recordsWithoutChange = 0;

  if (embedded) {
    const addressable = addressabilityByRecord.get(embedded).addressable;
    const existing = normalizeCloudinaryPublicId(
      photo?.cloudinaryPublicId,
    );
    if (existing === identity.publicId) {
      alreadyCorrect += 1;
    } else if (
      !hasOwn(photo, 'cloudinaryPublicId') &&
      !malformedForPrefix(identity.malformedSources, 'photo.')
    ) {
      const parsedPhotoUrl = parseCloudinaryDeliveryUrl(photo?.url);
      if (
        addressable &&
        parsedPhotoUrl?.publicId === identity.publicId
      ) {
        planChange(
          changes,
          'parkPhotoPublicId',
          embedded,
          identity.publicId,
        );
      } else if (addressable) {
        recordsWithoutChange += 1;
      }
    } else if (addressable) {
      recordsWithoutChange += 1;
    }
  }

  uploadRecords.forEach((record, index) => {
    const upload = record.upload || record;
    const addressable = addressabilityByRecord.get(record).addressable;
    const malformed = malformedForPrefix(
      identity.malformedSources,
      `upload[${index}].`,
    );
    let changed = false;

    const existingPublicId = normalizeCloudinaryPublicId(
      upload.cloudinaryPublicId,
    );
    if (existingPublicId === identity.publicId) {
      alreadyCorrect += 1;
    } else if (
      addressable &&
      !hasOwn(upload, 'cloudinaryPublicId') &&
      !malformed
    ) {
      planChange(
        changes,
        'uploadPublicId',
        record,
        identity.publicId,
      );
      changed = true;
    }

    if (
      addressable &&
      !hasOwn(upload, 'cloudinaryUrl') &&
      !malformed
    ) {
      const legacy = classifyLegacyCloudinaryId(upload.cloudinaryId);
      if (
        legacy.kind === 'deliveryUrl' &&
        legacy.publicId === identity.publicId
      ) {
        planChange(
          changes,
          'uploadUrl',
          record,
          legacy.deliveryUrl,
        );
        changed = true;
      }
    }

    if (
      addressable &&
      !changed &&
      existingPublicId !== identity.publicId
    ) {
      recordsWithoutChange += 1;
    }
  });

  userHistoryEntries.forEach((record, index) => {
    const userUpload = record.upload || record;
    const addressable = addressabilityByRecord.get(record).addressable;
    const existingPublicId = normalizeCloudinaryPublicId(
      userUpload.cloudinaryPublicId,
    );
    if (existingPublicId === identity.publicId) {
      alreadyCorrect += 1;
    } else if (
      addressable &&
      !hasOwn(userUpload, 'cloudinaryPublicId') &&
      !malformedForPrefix(
        identity.malformedSources,
        `userUpload[${index}].`,
      )
    ) {
      planChange(
        changes,
        'userHistoryPublicId',
        record,
        identity.publicId,
      );
    } else if (addressable) {
      recordsWithoutChange += 1;
    }
  });

  return {
    changes,
    skippedRecords: recordsWithoutChange + unaddressableRecords.length,
    malformedUrls: identity.malformedSources.length,
    malformedRecords: malformedRecords.length,
    unresolved: false,
    conflict: false,
    alreadyCorrect,
    duplicate: false,
    unaddressableRecords,
  };
}

function recordPlannedChanges(summary, plan) {
  summary.plannedChanges += plan.changes.length;
  summary.skippedRecords += plan.skippedRecords;
  summary.malformedUrls += plan.malformedUrls;
  summary.malformedRecords += plan.malformedRecords;
  summary.recordsAlreadyContainingCorrectExplicitPublicId +=
    plan.alreadyCorrect;
  if (plan.unresolved) summary.unresolvedIdentities += 1;
  if (plan.conflict) summary.conflictingIdentities += 1;

  (plan.unaddressableRecords || []).forEach(result => {
    summary.unaddressableRecords += 1;
    const parentRecordId = result.recordType === 'embeddedPhoto'
      ? result.record?.parkId
      : result.recordType === 'userHistory'
        ? result.record?.userId
        : null;

    result.reasons.forEach(reasonCode => {
      if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS.MISSING_MEDIA_ID
      ) {
        summary.recordsMissingMediaId += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .EMBEDDED_PHOTO_MISSING_PARK_ID
      ) {
        summary.embeddedPhotosMissingParkId += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .EMBEDDED_PHOTO_INVALID_LOCATOR_LEVEL
      ) {
        summary.embeddedPhotosInvalidLocatorLevel += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .STANDALONE_PHOTO_MISSING_CAMPSITE_ID
      ) {
        summary.standalonePhotosMissingCampsiteLocator += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .CAMPGROUND_PHOTO_MISSING_CAMPGROUND_ID
      ) {
        summary.campgroundPhotosMissingCampgroundLocator += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .CAMPGROUND_PHOTO_MISSING_CAMPSITE_ID
      ) {
        summary.campgroundPhotosMissingCampsiteLocator += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .UPLOAD_RECORD_MISSING_RECORD_ID
      ) {
        summary.uploadRecordsMissingRecordId += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .USER_HISTORY_MISSING_USER_ID
      ) {
        summary.userHistoryEntriesMissingUserId += 1;
      } else if (
        reasonCode ===
        MEDIA_IDENTIFIER_ADDRESSABILITY_REASONS
          .USER_HISTORY_MISSING_RECORD_ID
      ) {
        summary.userHistoryEntriesMissingRecordId += 1;
      }

      addSample(summary, 'unaddressableRecords', result.record, {
        reasonCode,
        parentRecordId,
      });
    });
  });

  plan.changes.forEach(change => {
    if (change.kind === 'parkPhotoPublicId') {
      summary.safelyBackfillableParkPhotoFields += 1;
    } else if (change.kind === 'uploadUrl') {
      summary.safelyBackfillableUploadUrlFields += 1;
    } else if (change.kind === 'uploadPublicId') {
      summary.safelyBackfillableUploadPublicIdFields += 1;
    } else if (change.kind === 'userHistoryPublicId') {
      summary.safelyBackfillableUserHistoryPublicIdFields += 1;
    }
  });
}

async function applyPlan({ repository, apply, summary, plan }) {
  recordPlannedChanges(summary, plan);
  if (!apply) return;

  for (const change of plan.changes) {
    try {
      const modified = await repository.applyChange(change);
      if (modified) {
        summary.modifiedFields += 1;
      } else {
        summary.skippedRecords += 1;
        addSample(summary, 'writeNotApplied', change);
      }
    } catch {
      summary.failedReadsOrWrites += 1;
      addSample(summary, 'failedWrite', change);
    }
  }
}

async function safeCompanionRead({
  read,
  summary,
  sampleCategory,
  sampleRecord,
}) {
  try {
    return await read();
  } catch {
    summary.failedReadsOrWrites += 1;
    addSample(summary, sampleCategory, sampleRecord);
    return null;
  }
}

export async function reconcileMediaIdentifiers({
  repository,
  apply = false,
  batchSize = 100,
} = {}) {
  if (!repository) throw new Error('A reconciliation repository is required');
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }

  const summary = createMediaIdentifierSummary({ apply });
  const duplicateEmbeddedIds = new Set(
    (await repository.getDuplicateEmbeddedMediaIds()).map(idString),
  );
  const duplicateUploadIds = new Set(
    (await repository.getDuplicateUploadMediaIds()).map(idString),
  );
  const duplicateUserHistoryIds = new Set(
    (await repository.getDuplicateUserHistoryMediaIds()).map(idString),
  );
  summary.duplicateEmbeddedPhotosForMediaId = duplicateEmbeddedIds.size;
  summary.duplicateUploadRecordsForMediaId = duplicateUploadIds.size;
  summary.duplicateUserHistoryEntriesForMediaId =
    duplicateUserHistoryIds.size;

  for await (const embeddedBatch of repository.iterateEmbeddedPhotoBatches(
    batchSize,
  )) {
    summary.embeddedParkPhotosScanned += embeddedBatch.length;
    const embeddedGroups = groupByMediaId(embeddedBatch, 'embedded');
    const mediaIds = [...embeddedGroups.keys()].filter(key =>
      !key.startsWith('missing:')
    );

    const uploadRecords = await safeCompanionRead({
      read: () => repository.findUploadsByMediaIds(mediaIds),
      summary,
      sampleCategory: 'failedUploadCompanionRead',
      sampleRecord: embeddedBatch[0],
    });
    const userHistoryEntries = await safeCompanionRead({
      read: () => repository.findUserHistoryByMediaIds(mediaIds),
      summary,
      sampleCategory: 'failedUserCompanionRead',
      sampleRecord: embeddedBatch[0],
    });
    if (!uploadRecords || !userHistoryEntries) {
      summary.skippedRecords += embeddedBatch.length;
      continue;
    }

    const uploadGroups = groupByMediaId(uploadRecords, 'upload');
    const userGroups = groupByMediaId(userHistoryEntries, 'user');

    for (const [key, embeddedRecords] of embeddedGroups) {
      const uploads = uploadGroups.get(key) || [];
      const users = userGroups.get(key) || [];
      if (!uploads.length) {
        summary.embeddedParkPhotosMissingUploadRecord +=
          embeddedRecords.length;
        embeddedRecords.forEach(record =>
          addSample(summary, 'embeddedMissingUpload', record)
        );
      }
      if (!users.length) {
        summary.embeddedParkPhotosMissingUserHistoryEntry +=
          embeddedRecords.length;
        embeddedRecords.forEach(record =>
          addSample(summary, 'embeddedMissingUserHistory', record)
        );
      }

      const mediaId = key.startsWith('missing:') ? null : key;
      const plan = planMediaIdentifierGroup({
        embeddedRecords,
        uploadRecords: uploads,
        userHistoryEntries: users,
        duplicateEmbedded:
          embeddedRecords.length > 1 ||
          (mediaId && duplicateEmbeddedIds.has(mediaId)),
        duplicateUploads:
          uploads.length > 1 ||
          (mediaId && duplicateUploadIds.has(mediaId)),
        duplicateUserHistory:
          users.length > 1 ||
          (mediaId && duplicateUserHistoryIds.has(mediaId)),
      });
      if (plan.duplicate) {
        embeddedRecords.forEach(record =>
          addSample(summary, 'duplicateMediaId', record)
        );
      } else if (plan.conflict) {
        embeddedRecords.forEach(record =>
          addSample(summary, 'identityConflict', record)
        );
      } else if (plan.unresolved) {
        embeddedRecords.forEach(record =>
          addSample(summary, 'unresolvedIdentity', record)
        );
      }
      await applyPlan({ repository, apply, summary, plan });
    }
  }

  for await (const uploadBatch of repository.iterateUploadPhotoBatches(
    batchSize,
  )) {
    summary.uploadPhotoRecordsScanned += uploadBatch.length;
    const groups = groupByMediaId(uploadBatch, 'upload');
    const mediaIds = [...groups.keys()].filter(key =>
      !key.startsWith('missing:')
    );
    const embeddedIds = await safeCompanionRead({
      read: () => repository.findExistingEmbeddedMediaIds(mediaIds),
      summary,
      sampleCategory: 'failedEmbeddedExistenceRead',
      sampleRecord: uploadBatch[0],
    });
    if (!embeddedIds) {
      summary.skippedRecords += uploadBatch.length;
      continue;
    }
    const embeddedSet = new Set(embeddedIds.map(idString));
    const orphanIds = mediaIds.filter(mediaId => !embeddedSet.has(mediaId));
    const orphanUsers = await safeCompanionRead({
      read: () => repository.findUserHistoryByMediaIds(orphanIds),
      summary,
      sampleCategory: 'failedOrphanUserRead',
      sampleRecord: uploadBatch[0],
    });
    if (!orphanUsers) {
      summary.skippedRecords += uploadBatch.length;
      continue;
    }
    const orphanUserGroups = groupByMediaId(orphanUsers, 'user');

    for (const [key, uploads] of groups) {
      const mediaId = key.startsWith('missing:') ? null : key;
      if (mediaId && embeddedSet.has(mediaId)) continue;

      summary.uploadRecordsWithoutEmbeddedParkPhoto += uploads.length;
      uploads.forEach(record => {
        addSample(summary, 'orphanUpload', record);
      });

      const users = mediaId ? orphanUserGroups.get(key) || [] : [];
      const plan = planMediaIdentifierGroup({
        uploadRecords: uploads,
        userHistoryEntries: users,
        duplicateUploads:
          uploads.length > 1 ||
          (mediaId && duplicateUploadIds.has(mediaId)),
        duplicateUserHistory:
          users.length > 1 ||
          (mediaId && duplicateUserHistoryIds.has(mediaId)),
      });
      await applyPlan({ repository, apply, summary, plan });
    }
  }

  for await (const userBatch of repository.iterateUserPhotoHistoryBatches(
    batchSize,
  )) {
    summary.userPhotoHistoryEntriesScanned += userBatch.length;
    const groups = groupByMediaId(userBatch, 'user');
    const mediaIds = [...groups.keys()].filter(key =>
      !key.startsWith('missing:')
    );
    const [embeddedIds, uploadRecords] = await Promise.all([
      safeCompanionRead({
        read: () => repository.findExistingEmbeddedMediaIds(mediaIds),
        summary,
        sampleCategory: 'failedUserEmbeddedExistenceRead',
        sampleRecord: userBatch[0],
      }),
      safeCompanionRead({
        read: () => repository.findUploadsByMediaIds(mediaIds),
        summary,
        sampleCategory: 'failedUserUploadCompanionRead',
        sampleRecord: userBatch[0],
      }),
    ]);
    if (!embeddedIds || !uploadRecords) {
      summary.skippedRecords += userBatch.length;
      continue;
    }
    const embeddedSet = new Set(embeddedIds.map(idString));
    const uploadGroups = groupByMediaId(uploadRecords, 'upload');

    for (const [key, users] of groups) {
      const mediaId = key.startsWith('missing:') ? null : key;
      if (mediaId && embeddedSet.has(mediaId)) continue;

      summary.userHistoryEntriesWithoutEmbeddedParkPhoto += users.length;
      users.forEach(record => {
        addSample(summary, 'orphanUserHistory', record);
      });

      // Orphan Upload groups were reconciled during the Upload scan.
      if (mediaId && uploadGroups.has(key)) continue;

      const plan = planMediaIdentifierGroup({
        userHistoryEntries: users,
        duplicateUserHistory:
          users.length > 1 ||
          (mediaId && duplicateUserHistoryIds.has(mediaId)),
      });
      await applyPlan({ repository, apply, summary, plan });
    }
  }

  return summary;
}
