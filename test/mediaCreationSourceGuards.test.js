import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const controllerPath = new URL('../controllers/media.js', import.meta.url);
const persistencePath = new URL(
  '../utils/mediaPersistence.js',
  import.meta.url,
);
const transactionPath = new URL(
  '../utils/mongoTransaction.js',
  import.meta.url,
);

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, startMarker);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}

describe('media creation source safeguards', () => {
  test('creation controllers have no manual Mongo rollback or timestamp write', async () => {
    const source = await readFile(controllerPath, 'utf8');
    const photo = functionSource(
      source,
      'async function uploadPhotoHandler',
      'async function addVideoHandler',
    );
    const video = functionSource(
      source,
      'async function addVideoHandler',
      'async function deletePhotoHandler',
    );
    const creation = `${photo}\n${video}`;

    assert.doesNotMatch(creation, /UploadModel\.deleteMany/u);
    assert.doesNotMatch(creation, /UploadModel\.create/u);
    assert.doesNotMatch(creation, /findByIdAndUpdate/u);
    assert.doesNotMatch(creation, /ParkModel\.findByIdAndUpdate/u);
    assert.doesNotMatch(creation, /park\.save/u);
    assert.doesNotMatch(video, /\.find\([^)]*\.url/u);
    assert.match(photo, /mediaPersistence\.commitMediaCreation/u);
    assert.match(video, /mediaPersistence\.commitMediaCreation/u);
  });

  test('success responses occur after the awaited shared persistence call', async () => {
    const source = await readFile(controllerPath, 'utf8');
    const photo = functionSource(
      source,
      'async function uploadPhotoHandler',
      'async function addVideoHandler',
    );
    const video = functionSource(
      source,
      'async function addVideoHandler',
      'async function deletePhotoHandler',
    );

    for (const creationSource of [photo, video]) {
      const commit = creationSource.indexOf(
        'await mediaPersistence.commitMediaCreation',
      );
      const success = creationSource.indexOf('success: true');
      assert.ok(commit >= 0);
      assert.ok(success > commit);
    }
  });

  test('transaction callback contains Mongo work only and every write gets session', async () => {
    const source = await readFile(persistencePath, 'utf8');

    assert.doesNotMatch(
      source,
      /\.uploader\.|upload_stream\(|\.destroy\(/u,
    );
    assert.doesNotMatch(source, /\bres\./u);
    assert.doesNotMatch(source, /\breq\./u);
    assert.match(
      source,
      /ParkModel\.findOne\([\s\S]*?\{ session \}/u,
    );
    assert.match(source, /park\.save\(\{ session \}\)/u);
    assert.match(
      source,
      /UploadModel\.insertMany\([\s\S]*?session,[\s\S]*?ordered: true/u,
    );
    assert.match(
      source,
      /UserModel\.updateOne\([\s\S]*?session,[\s\S]*?runValidators: true/u,
    );
  });

  test('transaction runner has no nontransactional work fallback', async () => {
    const source = await readFile(transactionPath, 'utf8');
    const withTransactionIndex = source.indexOf(
      'session.withTransaction(async () =>',
    );
    const workIndex = source.indexOf('await work(session)');

    assert.ok(withTransactionIndex >= 0);
    assert.ok(workIndex > withTransactionIndex);
    assert.equal(
      source.match(/await work\(session\)/gu)?.length,
      1,
    );
  });
});
