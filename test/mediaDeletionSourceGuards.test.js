import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const controllerSource = await readFile(
  new URL('../controllers/media.js', import.meta.url),
  'utf8',
);
const deletionSource = await readFile(
  new URL('../utils/mediaDeletion.js', import.meta.url),
  'utf8',
);
const cleanupSource = await readFile(
  new URL('../utils/mediaCleanupJobs.js', import.meta.url),
  'utf8',
);
const appSource = await readFile(
  new URL('../app.js', import.meta.url),
  'utf8',
);
const usersSource = await readFile(
  new URL('../controllers/users.js', import.meta.url),
  'utf8',
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, start);
  assert.ok(endIndex > startIndex, end);
  return source.slice(startIndex, endIndex);
}

test('deletion handlers delegate MongoDB work and photo cleanup occurs only after commit', () => {
  const photoHandler = sourceBetween(
    controllerSource,
    'async function deletePhotoHandler',
    'async function deleteVideoHandler',
  );
  const videoHandler = sourceBetween(
    controllerSource,
    'async function deleteVideoHandler',
    'export function createMediaHandlers',
  );

  for (const handler of [photoHandler, videoHandler]) {
    assert.doesNotMatch(
      handler,
      /ParkModel|UploadModel|UserModel|\.save\(|deleteOne|deleteMany|updateOne/u,
    );
    assert.match(handler, /mediaDeletion\.deleteMedia/u);
  }
  assert.doesNotMatch(photoHandler, /\.destroy\s*\(/u);
  assert.match(
    photoHandler,
    /mediaDeletion\.deleteMedia[\s\S]*mediaCleanupJobs\.processJobById/u,
  );
  assert.match(
    controllerSource,
    /status\(202\)[\s\S]*cleanupPending:\s*true/u,
  );
  assert.doesNotMatch(videoHandler, /mediaCleanupJobs|cloudinary/u);
});

test('transaction callback contains every deletion write, no Cloudinary call, and no HTTP response', () => {
  assert.match(deletionSource, /transactionRunner\(async session =>/u);
  assert.match(deletionSource, /park\.save\(\{ session \}\)/u);
  assert.match(
    deletionSource,
    /UploadModel\.deleteMany\([\s\S]*\{ session \}/u,
  );
  assert.match(
    deletionSource,
    /UserModel\.updateOne\([\s\S]*session,[\s\S]*arrayFilters/u,
  );
  assert.match(
    deletionSource,
    /CleanupJobModel\.insertMany\([\s\S]*session/u,
  );
  assert.doesNotMatch(
    deletionSource,
    /\.destroy\s*\(|\bres\.|\breq\./u,
  );
  assert.doesNotMatch(deletionSource, /fallback|nontransaction/iu);
});

test('Cloudinary deletion is isolated from individual deletion transaction logic', () => {
  const destroyCalls = [
    ...cleanupSource.matchAll(/\.destroy\s*\(/gu),
  ];
  assert.equal(destroyCalls.length, 1);

  const creationCleanup = sourceBetween(
    controllerSource,
    'async function cleanupPhotoAssets',
    'async function sendPhotoFailureAfterCleanup',
  );
  assert.equal(
    [...creationCleanup.matchAll(/\.destroy\s*\(/gu)].length,
    1,
  );
});

test('cleanup CLI is not imported by startup or account deletion', () => {
  assert.doesNotMatch(appSource, /processMediaCleanupJobs|mediaCleanupJobs/u);
  assert.doesNotMatch(
    usersSource,
    /processMediaCleanupJobs|scripts\/processMediaCleanupJobs/u,
  );
  assert.match(usersSource, /processCommittedAccountCleanupJobs/u);
  assert.match(usersSource, /export const deleteAccount/u);
});
