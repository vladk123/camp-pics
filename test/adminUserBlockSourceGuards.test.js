import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { isAdmin } from '../middleware.js';
import adminRouter from '../routes/admin.js';
import { adminUserStatusLimiter } from '../utils/routeAbuseLimits.js';

function routeFor(path) {
  return adminRouter.stack.find(layer => layer.route?.path === path)?.route;
}

describe('administrator Block/Unblock route guards', () => {
  for (const [path, controllerName] of [
    ['/user/:id/block', 'blockUser'],
    ['/user/:id/unblock', 'unblockUser'],
  ]) {
    test(`${path} remains POST-only with the exact authorization and limiter order`, async () => {
      const route = routeFor(path);
      const source = await readFile('routes/admin.js', 'utf8');

      assert.ok(route);
      assert.deepEqual(Object.keys(route.methods), ['post']);
      assert.equal(route.stack.length, 3);
      assert.equal(route.stack[0].handle, isAdmin);
      assert.equal(route.stack[1].handle, adminUserStatusLimiter);
      assert.match(
        source,
        new RegExp(
          `router\\.route\\('${path.replaceAll('/', '\\/')}'\\)\\s*` +
          `\\.post\\(isAdmin, adminUserStatusLimiter, ` +
          `catchAsyncErrors\\(admin\\.${controllerName}\\)\\);`,
          'u',
        ),
      );
    });
  }

  test('Block and Unblock reference the exact same production limiter instance', () => {
    const blockRoute = routeFor('/user/:id/block');
    const unblockRoute = routeFor('/user/:id/unblock');

    assert.equal(blockRoute.stack[1].handle, adminUserStatusLimiter);
    assert.equal(unblockRoute.stack[1].handle, adminUserStatusLimiter);
    assert.equal(blockRoute.stack[1].handle, unblockRoute.stack[1].handle);
  });

  test('the shared administrator limiter protects only focused administrator writes', () => {
    const limiterRoutes = [];
    for (const layer of adminRouter.stack) {
      if (!layer.route) continue;
      for (const routeLayer of layer.route.stack) {
        if (routeLayer.handle === adminUserStatusLimiter) {
          limiterRoutes.push([layer.route.path, routeLayer.method]);
        }
      }
    }

    assert.deepEqual(limiterRoutes, [
      ['/announcements', 'post'],
      ['/monthly-draw/uploads/:uploadId/status', 'post'],
      ['/user/:id/block', 'post'],
      ['/user/:id/unblock', 'post'],
    ]);
    assert.equal(
      routeFor('/dashboard').stack.some(
        layer => layer.handle === adminUserStatusLimiter,
      ),
      false,
    );
  });

  test('global CSRF protection remains before the administrator router mount', async () => {
    const source = await readFile('app.js', 'utf8');
    const csrfIndex = source.indexOf('app.use(csrfSynchronisedProtection)');
    const adminMountIndex = source.indexOf("app.use('/a', adminRoutes)");

    assert.ok(csrfIndex >= 0);
    assert.ok(adminMountIndex > csrfIndex);
  });
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
