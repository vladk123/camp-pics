import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const source = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

test('authentication-artifact maintenance is isolated from startup and live auth paths', async () => {
  const routeFiles = await readdir(new URL('../routes/', import.meta.url));
  const inspectedFiles = [
    'app.js',
    'models/token.js',
    'models/user.js',
    'utils/authTokens.js',
    'utils/authLifecycle.js',
    'utils/createNewUserVerify.js',
    'controllers/users.js',
    ...routeFiles
      .filter(file => file.endsWith('.js'))
      .map(file => `routes/${file}`),
  ];
  for (const file of inspectedFiles) {
    const contents = await source(file);
    assert.equal(contents.includes('reconcileAuthArtifacts'), false, file);
    assert.equal(contents.includes('authArtifactReconciliation'), false, file);
    assert.equal(contents.includes('reconcileAuthArtifacts.js'), false, file);
  }

  const cli = await source('scripts/reconcileAuthArtifacts.js');
  for (const forbiddenImport of [
    "../app.js",
    "../controllers/",
    "../routes/",
    'express',
    'passport',
    'session',
    'sendEmail',
    'mailgun',
    'cloudinary',
  ]) {
    assert.equal(cli.includes(forbiddenImport), false, forbiddenImport);
  }
});

test('Token and User schemas have no maintenance index, TTL, or field changes', async () => {
  const tokenModel = await source('models/token.js');
  const userModel = await source('models/user.js');
  for (const modelSource of [tokenModel, userModel]) {
    assert.doesNotMatch(modelSource, /expireAfterSeconds|\.index\s*\(/u);
    assert.doesNotMatch(modelSource, /authArtifact|reconcil/u);
  }
  assert.match(tokenModel, /email_verification_code/u);
  assert.match(tokenModel, /email_verification_expiry/u);
  assert.match(tokenModel, /user_id/u);
  assert.match(userModel, /reset_password_code/u);
  assert.match(userModel, /reset_password_expiry/u);
  assert.match(userModel, /reset_password_claim/u);
  assert.match(userModel, /reset_password_counter/u);
});

test('apply source contains only the exact narrow Token and User operations', async () => {
  const cli = await source('scripts/reconcileAuthArtifacts.js');
  const service = await source('utils/authArtifactReconciliation.js');
  assert.equal((cli.match(/\.deleteMany\s*\(/gu) || []).length, 1);
  assert.equal((cli.match(/\.updateMany\s*\(/gu) || []).length, 1);
  assert.equal(cli.includes('.deleteOne('), false);
  assert.equal(cli.includes('.findOneAndDelete('), false);
  assert.equal(cli.includes('UserModel.delete'), false);
  assert.match(cli, /_id:\s*\{\s*\$in:\s*candidateIds\s*\}/u);
  assert.match(
    cli,
    /function expiredDateFilter[\s\S]*\$type:\s*'date'[\s\S]*\$lte:\s*now/u,
  );
  assert.match(cli, /RESET_CODE_PATH\s*=\s*'other_login\.reset_password_code'/u);
  assert.match(cli, /RESET_EXPIRY_PATH\s*=\s*'other_login\.reset_password_expiry'/u);
  assert.match(cli, /RESET_CLAIM_PATH\s*=\s*'other_login\.reset_password_claim'/u);
  assert.match(cli, /RESET_COUNTER_PATH\s*=\s*'other_login\.reset_password_counter'/u);
  assert.match(cli, /\[RESET_CODE_PATH\]:\s*''/u);
  assert.match(cli, /\[RESET_EXPIRY_PATH\]:\s*''/u);
  assert.match(cli, /\[RESET_CLAIM_PATH\]:\s*''/u);
  assert.match(cli, /\[RESET_COUNTER_PATH\]:\s*0/u);
  for (const forbiddenField of [
    'auth_version',
    'token_counter',
    'email_verified',
    'previous_logins',
    'uploads',
    'hash',
    'salt',
    'attempts',
  ]) {
    assert.equal(cli.includes(forbiddenField), false, forbiddenField);
  }
  assert.equal(service.includes('deleteMany('), false);
  assert.equal(service.includes('updateMany('), false);
});

test('index access is audit-only and exposes no index mutation methods', async () => {
  const cli = await source('scripts/reconcileAuthArtifacts.js');
  assert.match(cli, /tokenCollection\.indexes\(\)/u);
  assert.match(cli, /userCollection\.indexes\(\)/u);
  for (const mutation of [
    'createIndex',
    'dropIndex',
    'syncIndexes',
    'diffIndexes',
    'ensureIndexes',
  ]) {
    assert.equal(cli.includes(mutation), false, mutation);
  }
});

test('package commands are explicit, dependencies are unchanged, and engines stay pinned', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  const packageLock = JSON.parse(await source('package-lock.json'));
  assert.equal(
    packageJson.scripts['auth:audit-artifacts'],
    'node scripts/reconcileAuthArtifacts.js',
  );
  assert.equal(
    packageJson.scripts['auth:cleanup-expired-artifacts'],
    'node scripts/reconcileAuthArtifacts.js --apply',
  );
  assert.deepEqual(packageJson.engines, {
    node: '24.x',
    npm: '11.x',
  });
  assert.deepEqual(packageLock.packages[''].engines, {
    node: '24.x',
    npm: '11.x',
  });
  assert.deepEqual(packageJson.dependencies, packageLock.packages[''].dependencies);
  assert.equal(packageJson.scripts.start, 'node app.js');
  assert.equal(packageJson.scripts.test, 'node --test');
});
