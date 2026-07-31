import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const [
  appSource,
  modelSource,
  senderSource,
  usersControllerSource,
  otherControllerSource,
  accountDeletionSource,
  serviceSource,
  scriptSource,
  packageSource,
] = await Promise.all([
  readFile('app.js', 'utf8'),
  readFile('models/email.js', 'utf8'),
  readFile('utils/sendEmail.js', 'utf8'),
  readFile('controllers/users.js', 'utf8'),
  readFile('controllers/other.js', 'utf8'),
  readFile('utils/accountDeletion.js', 'utf8'),
  readFile('utils/emailLogReconciliation.js', 'utf8'),
  readFile('scripts/reconcileEmailLogs.js', 'utf8'),
  readFile('package.json', 'utf8'),
]);

describe('Email log reconciliation integration guards', () => {
  test('application startup, models, sender, and controllers do not run the maintenance tool', () => {
    for (const [name, source] of Object.entries({
      'app.js': appSource,
      'models/email.js': modelSource,
      'utils/sendEmail.js': senderSource,
      'controllers/users.js': usersControllerSource,
      'controllers/other.js': otherControllerSource,
      'utils/accountDeletion.js': accountDeletionSource,
    })) {
      assert.doesNotMatch(
        source,
        /reconcileEmailLogs|emailLogReconciliation/u,
        `${name} imports or invokes Email log reconciliation`,
      );
    }
    assert.doesNotMatch(
      `${serviceSource}\n${scriptSource}`,
      /from ['"][^'"]*(?:app|sendEmail|controllers\/)/u,
    );
  });

  test('Email schema still has no hooks, TTL, or declared indexes', () => {
    assert.doesNotMatch(modelSource, /\.index\s*\(|\.pre\s*\(|\.post\s*\(/u);
    assert.doesNotMatch(
      modelSource,
      /expireAfterSeconds|\bexpires\s*:|autoIndex/iu,
    );
  });

  test('maintenance implementation has no deletion or index mutation operation', () => {
    const maintenanceSource = `${serviceSource}\n${scriptSource}`;
    assert.doesNotMatch(
      maintenanceSource,
      /deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|bulkWrite/u,
    );
    assert.doesNotMatch(
      maintenanceSource,
      /createIndex|createIndexes|dropIndex|dropIndexes|syncIndexes/u,
    );
    assert.doesNotMatch(
      maintenanceSource,
      /DOMParser|cheerio|parseFromString|token extraction/iu,
    );
  });

  test('package commands preserve dry-run and explicit apply separation', () => {
    const packageJson = JSON.parse(packageSource);
    assert.equal(
      packageJson.scripts['email:audit-logs'],
      'node scripts/reconcileEmailLogs.js',
    );
    assert.equal(
      packageJson.scripts['email:redact-legacy-content'],
      'node scripts/reconcileEmailLogs.js --apply',
    );
    assert.doesNotMatch(packageJson.scripts['email:audit-logs'], /--apply/u);
    assert.match(
      packageJson.scripts['email:redact-legacy-content'],
      /--apply/u,
    );
    assert.doesNotMatch(packageJson.scripts.start, /reconcileEmailLogs/u);
    assert.doesNotMatch(packageJson.scripts.test, /reconcileEmailLogs/u);
  });
});
