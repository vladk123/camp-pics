import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

const controllerSource = await read('controllers/users.js');
const serviceSource = await read('utils/accountDeletion.js');
const traversalSource = await read('utils/accountDeletionParkTraversal.js');
const postCommitSource = await read('utils/accountDeletionPostCommit.js');
const accountViewSource = await read('views/user/account.ejs');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, start);
  assert.ok(endIndex > startIndex, end);
  return source.slice(startIndex, endIndex);
}

test('deleteAccount controller delegates all database mutation and has no Cloudinary call', () => {
  const controller = sourceBetween(
    controllerSource,
    'export const createDeleteAccountController',
    'export const deleteAccount',
  );

  assert.match(controller, /deletionService\.deleteAccount/u);
  assert.match(controller, /cleanupProcessor\.processJobById/u);
  assert.doesNotMatch(
    controller,
    /cloudinary|uploader\.destroy|Park\.find|ParkModel|UploadModel|Upload\.deleteMany|findByIdAndDelete/u,
  );
  assert.doesNotMatch(
    controllerSource,
    /cloudinary\.uploader\.destroy\([^)]*cloudinaryId/u,
  );
});

test('account transaction contains every write and no external or HTTP work', () => {
  assert.match(serviceSource, /transactionRunner\(async session =>/u);
  assert.match(serviceSource, /CleanupJobModel\.insertMany\([\s\S]*session/u);
  assert.match(serviceSource, /park\.save\(\{ session \}\)/u);
  assert.match(serviceSource, /UploadModel\.deleteMany\([\s\S]*\{ session \}/u);
  assert.match(serviceSource, /UserModel\.updateMany\(/u);
  assert.match(serviceSource, /arrayFilters:\s*\[\{/u);
  assert.match(serviceSource, /TokenModel\.deleteMany\([\s\S]*\{ session \}/u);
  assert.match(serviceSource, /EmailModel\.deleteMany\([\s\S]*\{ session \}/u);
  assert.match(serviceSource, /CleanupJobModel\.updateMany\([\s\S]*\{ session \}/u);
  assert.match(
    serviceSource,
    /MonthlyDrawNoUploadEntryModel\.deleteMany\([\s\S]*\{ session \}/u,
  );
  assert.match(serviceSource, /UserModel\.deleteOne\([\s\S]*\{ session \}/u);
  assert.doesNotMatch(
    serviceSource,
    /uploader\.destroy|config\/cloudinary|\breq\.|\bres\.|processMediaCleanupJobs/u,
  );
  assert.doesNotMatch(serviceSource, /fallback|nontransaction/iu);
  assert.doesNotMatch(serviceSource, /Promise\.all/u);
});

test('final User deletion is credential guarded and occurs after auxiliary writes', () => {
  const userDelete = serviceSource.indexOf('const userDelete = await UserModel.deleteOne');
  const tokenDelete = serviceSource.indexOf('const tokenDelete = await TokenModel.deleteMany');
  const emailDelete = serviceSource.indexOf('const emailDelete = await EmailModel.deleteMany');
  const cleanupReference = serviceSource.lastIndexOf('CleanupJobModel.updateMany', userDelete);
  const monthlyDrawEntryDelete = serviceSource.indexOf(
    'MonthlyDrawNoUploadEntryModel.deleteMany',
  );

  assert.ok(tokenDelete >= 0 && tokenDelete < userDelete);
  assert.ok(emailDelete >= 0 && emailDelete < userDelete);
  assert.ok(cleanupReference >= 0 && cleanupReference < userDelete);
  assert.ok(monthlyDrawEntryDelete >= 0 && monthlyDrawEntryDelete < userDelete);
  const deleteBlock = serviceSource.slice(userDelete, serviceSource.indexOf(
    'return Object.freeze',
    userDelete,
  ));
  assert.match(deleteBlock, /_id:\s*request\.userId/u);
  assert.match(deleteBlock, /hash:\s*request\.authenticatedHash/u);
  assert.match(deleteBlock, /salt:\s*request\.authenticatedSalt/u);
  assert.match(deleteBlock, /isAdmin:\s*\{\s*\$ne:\s*true\s*\}/u);
  assert.match(deleteBlock, /deletedCount[\s\S]*!==\s*1/u);
});

test('monthly draw entries are injected and removed only inside the account transaction', () => {
  assert.match(
    serviceSource,
    /import \{ MonthlyDrawNoUploadEntry \} from '\.\.\/models\/monthlyDrawNoUploadEntry\.js'/u,
  );
  assert.match(
    serviceSource,
    /MonthlyDrawNoUploadEntryModel = MonthlyDrawNoUploadEntry/u,
  );
  assert.match(serviceSource, /!MonthlyDrawNoUploadEntryModel/u);

  const transactionStart = serviceSource.indexOf(
    'transactionRunner(async session =>',
  );
  const entryDelete = serviceSource.indexOf(
    'MonthlyDrawNoUploadEntryModel.deleteMany',
    transactionStart,
  );
  const userDelete = serviceSource.indexOf(
    'const userDelete = await UserModel.deleteOne',
    entryDelete,
  );
  assert.ok(transactionStart >= 0 && entryDelete > transactionStart);
  assert.ok(userDelete > entryDelete);
  assert.match(
    serviceSource.slice(entryDelete, userDelete),
    /\{ userId: request\.userId \}[\s\S]*\{ session \}/u,
  );
  assert.doesNotMatch(
    `${controllerSource}\n${postCommitSource}`,
    /MonthlyDrawNoUploadEntry|monthlyDrawNoUploadEntr(?:y|ies).*delete/iu,
  );
});

test('validated video plan is authoritative before any transactional mutation', () => {
  const planDefinition = serviceSource.indexOf(
    'export function buildVideoDeletionPlan',
  );
  const planInvocation = serviceSource.indexOf(
    'const videoDeletionPlan = buildVideoDeletionPlan',
  );
  const cleanupInsert = serviceSource.indexOf(
    'CleanupJobModel.insertMany',
    planInvocation,
  );
  const parkMutation = serviceSource.indexOf(
    'removeUserParkContentAndLikes',
    planInvocation,
  );

  assert.ok(planDefinition >= 0);
  assert.ok(planInvocation > planDefinition);
  assert.ok(planInvocation < cleanupInsert);
  assert.ok(planInvocation < parkMutation);
  assert.match(
    serviceSource,
    /for \(const entry of activeEntries\)[\s\S]*mediaOwnerIsDeletingUser\(entry\?\.media\?\.user, userId\)[\s\S]*mediaReviewRequired\(\)/u,
  );
  assert.match(
    serviceSource,
    /activeEntries\.length > 0\) mediaReviewRequired\(\)/u,
  );
  assert.match(
    serviceSource,
    /videoDeletionPlan\.embeddedVideoIds/u,
  );
  assert.match(
    serviceSource,
    /\['video', videoDeletionPlan\.deletedVideoIds\]/u,
  );
  assert.equal(
    [...serviceSource.matchAll(/const deletedVideoIds = new Map\(\)/gu)].length,
    1,
  );
});

test('authoritative Park inventory is recomputed after a cross-type related query', () => {
  const seedQuery = serviceSource.indexOf(
    'buildSeedParkQuery(request.userId, uploadMediaIds)',
  );
  const seedInventory = serviceSource.indexOf(
    'const seedInventory = collectParkInventory',
    seedQuery,
  );
  const relatedQuery = serviceSource.indexOf(
    'buildRelatedParkQuery(candidateMediaIds)',
    seedInventory,
  );
  const merge = serviceSource.indexOf(
    'const parks = mergeParksById(seedParks, relatedParks)',
    relatedQuery,
  );
  const authoritativeInventory = serviceSource.indexOf(
    'const inventory = collectParkInventory(parks, request.userId)',
    merge,
  );
  const photoPlan = serviceSource.indexOf(
    'const cleanupPlan = buildPhotoCleanupPlan',
    authoritativeInventory,
  );
  const videoPlan = serviceSource.indexOf(
    'const videoDeletionPlan = buildVideoDeletionPlan',
    authoritativeInventory,
  );

  assert.ok(seedQuery >= 0);
  assert.ok(seedInventory > seedQuery);
  assert.ok(relatedQuery > seedInventory);
  assert.ok(merge > relatedQuery);
  assert.ok(authoritativeInventory > merge);
  assert.ok(photoPlan > authoritativeInventory);
  assert.ok(videoPlan > authoritativeInventory);

  const relatedQueryDefinition = sourceBetween(
    serviceSource,
    'function buildRelatedParkQuery',
    'function collectParkInventory',
  );
  assert.match(relatedQueryDefinition, /\['photo', 'video'\]/u);
  assert.match(
    relatedQueryDefinition,
    /ACCOUNT_DELETION_MEDIA_ID_PATHS\[mediaType\]/u,
  );
  for (const path of [
    'photos._id',
    'videos._id',
    'campgrounds.photos._id',
    'campsites.photos._id',
    'campsites.videos._id',
    'campgrounds.campsites.photos._id',
    'campgrounds.campsites.videos._id',
  ]) {
    assert.ok(traversalSource.includes(`'${path}'`), path);
  }
});

test('active-media validation blocks same-type owner and cross-type collisions', () => {
  const validator = sourceBetween(
    serviceSource,
    'export function validateActiveMediaCollisions',
    'export function buildUploadDeletionPlan',
  );
  const invocation = serviceSource.indexOf(
    'validateActiveMediaCollisions({',
    serviceSource.indexOf('transactionRunner(async session =>'),
  );
  const cleanupInsert = serviceSource.indexOf(
    'CleanupJobModel.insertMany',
    invocation,
  );

  assert.match(validator, /inventory\.active\[mediaType\]/u);
  assert.match(validator, /mediaOwnerIsDeletingUser/u);
  assert.match(validator, /inventory\.active\[oppositeType\]/u);
  assert.match(validator, /mediaReviewRequired\(\)/u);
  assert.ok(invocation >= 0 && invocation < cleanupInsert);
});

test('Upload companions are planned and removed only by exact document _id', () => {
  const planner = sourceBetween(
    serviceSource,
    'export function buildUploadDeletionPlan',
    'function verifyCleanupJobInsert',
  );
  const deleteFilter = sourceBetween(
    serviceSource,
    'const relatedCompanionUploadIds = [',
    'const uploadDelete = await UploadModel.deleteMany',
  );

  assert.match(planner, /ownedUploadIds/u);
  assert.match(planner, /relatedCompanionUploadIds/u);
  assert.match(planner, /classifyUploadMedia\(upload\)/u);
  assert.match(planner, /isUsableObjectId\(upload\?\._id\)/u);
  assert.match(deleteFilter, /\{ _id: \{ \$in: relatedCompanionUploadIds \} \}/u);
  assert.match(deleteFilter, /\{ userId: request\.userId \}/u);
  assert.doesNotMatch(deleteFilter, /mediaId/u);
});

test('Park merging is by exact _id before one authoritative save loop', () => {
  const mergeHelper = sourceBetween(
    serviceSource,
    'function mergeParksById',
    'function uploadsByMediaId',
  );
  const mergeInvocation = serviceSource.indexOf(
    'const parks = mergeParksById(seedParks, relatedParks)',
  );
  const parkLoop = serviceSource.indexOf(
    'for (const park of parks)',
    mergeInvocation,
  );

  assert.match(mergeHelper, /park\?\._id/u);
  assert.match(mergeHelper, /parksById\.has\(parkKey\)/u);
  assert.ok(mergeInvocation >= 0 && parkLoop > mergeInvocation);
  assert.equal(
    [...serviceSource.matchAll(/for \(const park of parks\)/gu)].length,
    2,
  );
});

test('traversal includes standalone, campground and nested media, reviews and likes', () => {
  for (const path of [
    'photos.user',
    'videos.user',
    'reviews.user',
    'photos.likedBy',
    'videos.likedBy',
    'reviews.likedBy',
    'campgrounds.photos.user',
    'campgrounds.reviews.user',
    'campgrounds.photos.likedBy',
    'campgrounds.reviews.likedBy',
    'campsites.photos.user',
    'campsites.videos.user',
    'campsites.reviews.user',
    'campsites.photos.likedBy',
    'campsites.videos.likedBy',
    'campsites.reviews.likedBy',
    'campgrounds.campsites.photos.user',
    'campgrounds.campsites.videos.user',
    'campgrounds.campsites.reviews.user',
    'campgrounds.campsites.photos.likedBy',
    'campgrounds.campsites.videos.likedBy',
    'campgrounds.campsites.reviews.likedBy',
  ]) {
    assert.ok(traversalSource.includes(`'${path}'`), path);
  }
  assert.match(traversalSource, /'standalone-campsite'/u);
  assert.match(traversalSource, /'campground-campsite'/u);
});

test('cleanup jobs survive deletion with user references unset and new jobs omit user refs', () => {
  assert.doesNotMatch(
    serviceSource,
    /CleanupJobModel\.(?:deleteOne|deleteMany|findByIdAndDelete)/u,
  );
  assert.match(serviceSource, /\$unset:\s*\{\s*ownerUserId:\s*1\s*\}/u);
  assert.match(serviceSource, /\$unset:\s*\{\s*requestedByUserId:\s*1\s*\}/u);

  const newJobBlock = sourceBetween(
    serviceSource,
    'const cleanupJobs = cleanupPlan.map',
    'if (cleanupJobs.length > 0)',
  );
  assert.doesNotMatch(newJobBlock, /ownerUserId|requestedByUserId/u);
  assert.doesNotMatch(newJobBlock, /url|caption|username|email/iu);
  assert.match(newJobBlock, /status:\s*'pending'/u);
  assert.match(newJobBlock, /attemptCount:\s*0/u);
});

test('post-commit cleanup is bounded and does not import the cleanup CLI', () => {
  assert.match(postCommitSource, /CLEANUP_LIMIT\s*=\s*30/u);
  assert.match(postCommitSource, /CLEANUP_CONCURRENCY\s*=\s*3/u);
  assert.doesNotMatch(
    `${controllerSource}\n${postCommitSource}`,
    /scripts\/processMediaCleanupJobs|processMediaCleanupJobs/u,
  );
});

test('final account form requires current_password without exposing it to JavaScript', () => {
  const form = sourceBetween(
    accountViewSource,
    '<form action="/user/delete-account"',
    '</form>',
  );
  assert.match(form, /include\('\.\.\/partials\/csrfField'\)/u);
  assert.match(form, /<label for="delete-account-current-password">/u);
  assert.match(form, /type="password"/u);
  assert.match(form, /name="current_password"/u);
  assert.match(form, /autocomplete="current-password"/u);
  assert.match(form, /\brequired\b/u);

  const authController = sourceBetween(
    controllerSource,
    'export const createDeleteAccountController',
    'export const deleteAccount',
  );
  assert.match(authController, /select\('\+hash \+salt'\)/u);
  assert.match(authController, /\.authenticate\(/u);
  assert.doesNotMatch(
    authController,
    /logAccountDeletionOperation\([^)]*currentPassword|console\.[a-z]+\([^)]*currentPassword/iu,
  );
});
