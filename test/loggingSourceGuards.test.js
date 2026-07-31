import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const [
  loggingSource,
  appSource,
  adminSource,
  campSource,
  redirectedFlashSource,
  sendEmailSource,
] = await Promise.all([
  readFile('utils/logging.js', 'utf8'),
  readFile('app.js', 'utf8'),
  readFile('controllers/admin.js', 'utf8'),
  readFile('controllers/camp.js', 'utf8'),
  readFile('utils/redirectedFlash.js', 'utf8'),
  readFile('utils/sendEmail.js', 'utf8'),
]);

describe('central logger source guards', () => {
  test('does not attach or convert the authenticated User document', () => {
    assert.doesNotMatch(
      loggingSource,
      /otherDetails\s*\.\s*user\s*=\s*req\s*\.\s*user/,
    );
    assert.doesNotMatch(loggingSource, /req\.user\.toObject\s*\(/);
    assert.doesNotMatch(loggingSource, /\.\.\.\s*req\.user/);
  });

  test('does not print raw details or raw Error variables', () => {
    assert.doesNotMatch(
      loggingSource,
      /console\.(?:log|error)\s*\(\s*(?:type\s*,\s*)?otherDetails\b/,
    );
    assert.doesNotMatch(
      loggingSource,
      /console\.error\s*\(\s*otherDetails\.error\s*\)/,
    );
    assert.doesNotMatch(
      loggingSource,
      /console\.(?:log|error)\s*\(\s*(?:err|error)\s*\)/,
    );
    assert.doesNotMatch(
      loggingSource,
      /(?:Object\.assign\s*\([^,]+,\s*otherDetails|\.\.\.\s*otherDetails)/,
    );
  });
});

describe('application logging call-site guards', () => {
  test('app logger messages do not interpolate raw request or complete URLs', () => {
    assert.doesNotMatch(appSource, /\bfullUrl\b/);
    assert.doesNotMatch(
      appSource,
      /message\s*:\s*`[^`]*\$\{\s*(?:req\.(?:originalUrl|url)|fullUrl)\s*\}/,
    );
    assert.match(
      appSource,
      /logger\(req, res, 'error', \{ message: 'Non-existent route visited\.'/,
    );
    assert.match(appSource, /message: 'Unhandled request error\.'/);
  });

  test('process-level handlers never print their raw failures', () => {
    const start = appSource.indexOf('// UNHANDLED ERRORS');
    const end = appSource.indexOf('//PORT LISTENING');
    assert.ok(start >= 0 && end > start);
    const handlers = appSource.slice(start, end);

    assert.doesNotMatch(
      handlers,
      /console\.(?:log|error)\s*\(\s*(?:err|error|e)\s*\)/,
    );
    assert.doesNotMatch(
      handlers,
      /console\.(?:log|error)\s*\([^)]*,\s*(?:err|error|e)\s*\)/,
    );
    assert.match(
      handlers,
      /logger\(null,null,'error', \{message: 'unhandledRejection', error: err\}\)/,
    );
    assert.match(
      handlers,
      /logger\(null,null,'error', \{message: 'uncaughtException error - crashing now\.\.\.', error: err\}\)/,
    );
  });

  test('changed runtime files contain no direct raw-error console dumping', () => {
    const rawErrorConsolePatterns = [
      /console\.(?:error|log)\s*\(\s*(?:err|error|e)\s*\)/,
      /console\.(?:error|log)\s*\([^\n)]*,\s*(?:err|error|e)\s*\)/,
      /(?:err|error|e)\.message\s*\|\|\s*(?:err|error|e)/,
    ];
    const sources = {
      'app.js': appSource,
      'controllers/admin.js': adminSource,
      'controllers/camp.js': campSource,
      'utils/redirectedFlash.js': redirectedFlashSource,
      'utils/sendEmail.js': sendEmailSource,
    };

    for (const [file, source] of Object.entries(sources)) {
      for (const pattern of rawErrorConsolePatterns) {
        assert.doesNotMatch(source, pattern, `${file} retained raw error output`);
      }
    }
  });

  test('sendEmail logs safely and rethrows the original caught value', () => {
    const catchStart = sendEmailSource.lastIndexOf('} catch (err) {');
    assert.ok(catchStart >= 0);
    const catchBlock = sendEmailSource.slice(catchStart);

    assert.match(catchBlock, /await logger\(null, null, 'error'/);
    assert.match(catchBlock, /error: err/);
    assert.match(catchBlock, /throw err;/);
    assert.doesNotMatch(catchBlock, /throw new Error/);
    assert.doesNotMatch(catchBlock, /console\.error/);
  });

  test('existing generic user-facing error behavior remains present', () => {
    assert.ok(appSource.includes(
      "return redirectedFlash(req, res, 'error', `Oops! An error has occurred: ${err.name}`, '/')",
    ));
    assert.ok(adminSource.includes("'Failed to load dashboard.'"));
    assert.ok(adminSource.includes("'Failed to block user.'"));
    assert.ok(adminSource.includes("'Failed to unblock user.'"));
    assert.ok(campSource.includes("res.status(500).json({ message: 'Search failed' });"));
  });
});
