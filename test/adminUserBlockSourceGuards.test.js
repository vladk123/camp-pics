import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { isAdmin } from '../middleware.js';
import adminRouter from '../routes/admin.js';

function routeFor(path) {
  return adminRouter.stack.find(layer => layer.route?.path === path)?.route;
}

describe('administrator Block/Unblock route guards', () => {
  for (const path of ['/user/:id/block', '/user/:id/unblock']) {
    test(`${path} remains POST-only with isAdmin first`, () => {
      const route = routeFor(path);

      assert.ok(route);
      assert.deepEqual(Object.keys(route.methods), ['post']);
      assert.equal(route.stack[0].handle, isAdmin);
    });
  }
});

describe('administrator target source guards', () => {
  test('the controller has no legacy raw-ID update or upsert', async () => {
    const source = await readFile('controllers/admin.js', 'utf8');

    assert.doesNotMatch(source, /findByIdAndUpdate/u);
    assert.doesNotMatch(source, /upsert\s*:\s*true/u);
    assert.match(source, /parseStrictMongoObjectId\(req\.params\?\.id\)/u);
    assert.match(source, /if \(!updatedUser\)/u);
  });

  test('database failure logging contains only the fixed event', async () => {
    const source = await readFile('controllers/admin.js', 'utf8');
    const handlerStart = source.indexOf(
      'export function createUserBlockHandler',
    );
    const handlerEnd = source.indexOf(
      'export const blockUser',
      handlerStart,
    );
    const handlerSource = source.slice(handlerStart, handlerEnd);
    const failureStart = handlerSource.lastIndexOf('} catch');
    const failureSource = handlerSource.slice(failureStart);

    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    assert.ok(failureStart >= 0);
    assert.match(
      failureSource,
      /await log\(req, res, 'error', \{\s*message: `Admin user \$\{action\} operation failed\.`,\s*\}\);/u,
    );
    assert.doesNotMatch(failureSource, /\berror\s*:/u);
    assert.doesNotMatch(failureSource, /\bcause\s*:/u);
  });

  test('the approved Node and npm engine policy remains exact', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

    assert.deepEqual(packageJson.engines, {
      node: '24.x',
      npm: '11.x',
    });
  });
});
