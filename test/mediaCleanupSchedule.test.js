import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  handleScheduledMediaCleanupFailure,
  runScheduledMediaCleanup,
} from '../scripts/runScheduledMediaCleanup.js';

const root = process.cwd();
const SAFE_FAILURE_MESSAGE =
  'Scheduled media cleanup failed and requires attention.';

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function headSource(relativePath) {
  return execFileSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function rejectionFrom(callback) {
  let rejection;
  try {
    await callback();
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof Error);
  return rejection;
}

describe('scheduled media-cleanup wrapper', () => {
  test('always invokes the existing CLI with only the fixed apply batch', async () => {
    const calls = [];
    const dependencies = Object.freeze({ marker: 'injected dependencies' });
    const expectedSummary = Object.freeze({
      scanned: 0,
      claimed: 0,
      completed: 0,
      stillPending: 0,
      blocked: 0,
      skipped: 0,
      failed: 0,
    });

    const result = await runScheduledMediaCleanup({
      dependencies,
      async runCleanup(args, receivedDependencies) {
        calls.push({ args: [...args], receivedDependencies });
        return expectedSummary;
      },
      args: ['--job-id', 'raw-user-value', '--limit', '500'],
    });

    assert.strictEqual(result, expectedSummary);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['--apply', '--limit', '50']);
    assert.strictEqual(calls[0].receivedDependencies, dependencies);
    assert.doesNotMatch(
      calls[0].args.join(' '),
      /job-id|dry-run|raw-user-value|500/u,
    );
  });

  for (const successCase of [
    {
      name: 'no eligible jobs',
      summary: {
        scanned: 0,
        claimed: 0,
        completed: 0,
        stillPending: 0,
        blocked: 0,
        skipped: 0,
        failed: 0,
      },
    },
    {
      name: 'completed jobs',
      summary: {
        scanned: 2,
        claimed: 2,
        completed: 2,
        stillPending: 0,
        blocked: 0,
        skipped: 0,
        failed: 0,
      },
    },
    {
      name: 'overlap skips',
      summary: {
        scanned: 1,
        claimed: 0,
        completed: 0,
        stillPending: 0,
        blocked: 0,
        skipped: 1,
        failed: 0,
      },
    },
    {
      name: 'provider retry jobs still pending',
      summary: {
        scanned: 1,
        claimed: 1,
        completed: 0,
        stillPending: 1,
        blocked: 0,
        skipped: 0,
        failed: 0,
      },
    },
  ]) {
    test(`resolves successfully for ${successCase.name}`, async () => {
      let calls = 0;
      const result = await runScheduledMediaCleanup({
        async runCleanup() {
          calls += 1;
          return successCase.summary;
        },
      });

      assert.strictEqual(result, successCase.summary);
      assert.equal(calls, 1);
    });
  }

  test('uses one fixed content-free rejection for failed, blocked, and fatal runs', async () => {
    const rawSecret =
      'mongodb://user:fixture-secret@example.test/raw-provider-response';
    const outputLines = [];
    const dependencies = {
      output: {
        log(value) {
          outputLines.push(value);
        },
      },
    };
    const cases = [
      async () => ({
        scanned: 1,
        claimed: 0,
        completed: 0,
        stillPending: 0,
        blocked: 0,
        skipped: 0,
        failed: 1,
        rawSecret,
      }),
      async () => ({
        scanned: 1,
        claimed: 1,
        completed: 0,
        stillPending: 0,
        blocked: 1,
        skipped: 0,
        failed: 0,
        providerResponse: rawSecret,
      }),
      async () => {
        throw new Error(rawSecret);
      },
    ];
    const rejections = [];

    for (const runCleanup of cases) {
      let calls = 0;
      rejections.push(await rejectionFrom(() => runScheduledMediaCleanup({
        dependencies,
        async runCleanup(...args) {
          calls += 1;
          return runCleanup(...args);
        },
      })));
      assert.equal(calls, 1);
    }

    for (const rejection of rejections) {
      assert.equal(rejection.message, SAFE_FAILURE_MESSAGE);
      assert.doesNotMatch(rejection.message, /fixture-secret|mongodb|provider/u);
    }
    assert.strictEqual(rejections[0], rejections[1]);
    assert.strictEqual(rejections[1], rejections[2]);
    assert.deepEqual(outputLines, []);
  });

  test('direct failure boundary emits one safe message and sets a nonzero exit', () => {
    const errorCalls = [];
    const processObject = { exitCode: 0 };

    handleScheduledMediaCleanupFailure({
      output: {
        error(...values) {
          errorCalls.push(values);
        },
      },
      processObject,
    });

    assert.deepEqual(errorCalls, [[SAFE_FAILURE_MESSAGE]]);
    assert.equal(processObject.exitCode, 1);
    assert.doesNotMatch(
      errorCalls.flat().join(' '),
      /fixture-secret|mongodb|cloudinary|https?:|Error:/iu,
    );
  });
});

describe('scheduled command package and startup guards', () => {
  test('keeps package commands fixed, dependencies unchanged, and engines pinned', async () => {
    const packageJson = JSON.parse(await source('package.json'));
    const headPackage = JSON.parse(headSource('package.json'));

    assert.equal(
      packageJson.scripts['media:scheduled-cleanup'],
      'node scripts/runScheduledMediaCleanup.js',
    );
    assert.equal(
      packageJson.scripts['media:audit-cleanup'],
      'node scripts/processMediaCleanupJobs.js',
    );
    assert.equal(
      packageJson.scripts['media:process-cleanup'],
      'node scripts/processMediaCleanupJobs.js --apply',
    );
    assert.deepEqual(packageJson.dependencies, headPackage.dependencies);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
  });

  test('keeps package-lock byte-identical to HEAD', async () => {
    const currentLockHash = execFileSync(
      'git',
      ['hash-object', 'package-lock.json'],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    const headLockHash = execFileSync(
      'git',
      ['rev-parse', 'HEAD:package-lock.json'],
      { cwd: root, encoding: 'utf8' },
    ).trim();

    assert.equal(currentLockHash, headLockHash);
  });

  test('is absent from application startup and exposes no scheduled overrides', async () => {
    const [app, startup, wrapper] = await Promise.all([
      source('app.js'),
      source('config/runtimeStartup.js'),
      source('scripts/runScheduledMediaCleanup.js'),
    ]);

    for (const startupSource of [app, startup]) {
      assert.doesNotMatch(
        startupSource,
        /runScheduledMediaCleanup|media:scheduled-cleanup/u,
      );
    }
    assert.match(
      wrapper,
      /runMediaCleanupCli[\s\S]*'--apply'[\s\S]*'--limit'[\s\S]*'50'/u,
    );
    assert.doesNotMatch(
      wrapper,
      /--job-id|--dry-run|DB_URL|process\.argv\.slice|cloudinaryPublicId|databaseUrl/u,
    );
  });
});
