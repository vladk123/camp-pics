import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ejs from 'ejs';
import express from 'express';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const { addVerificationResendRoutes } = await import('../routes/users.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const readSource = relativePath =>
  readFile(path.join(root, relativePath), 'utf8');

const stripHtmlComments = source => source.replace(/<!--[\s\S]*?-->/g, '');

const listFiles = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
};

test('every active unsafe or JavaScript-upload form includes exactly one shared CSRF field', async () => {
  const viewFiles = (await listFiles(path.join(root, 'views')))
    .filter(file => file.endsWith('.ejs'));
  let protectedFormCount = 0;

  for (const file of viewFiles) {
    const source = stripHtmlComments(await readFile(file, 'utf8'));
    const forms = source.match(/<form\b[\s\S]*?<\/form>/gi) || [];

    for (const form of forms) {
      const method = form.match(/\bmethod\s*=\s*["']([^"']+)["']/i)?.[1]?.toUpperCase() || 'GET';
      const needsCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
        /\bupload-form\b/.test(form);
      if (!needsCsrf) continue;

      const sharedFieldIncludes = form.match(/include\([^)]*csrfField[^)]*\)/g) || [];
      assert.equal(
        sharedFieldIncludes.length,
        1,
        `${path.relative(root, file)} has an unsafe form without exactly one shared CSRF field`,
      );
      protectedFormCount += 1;
    }
  }

  assert.equal(protectedFormCount, 15);
});

test('the shared CSRF partial contains one escaped _csrf field', async () => {
  const partialPath = path.join(root, 'views', 'partials', 'csrfField.ejs');
  const source = await readFile(partialPath, 'utf8');
  const rendered = await ejs.renderFile(partialPath, {
    csrfToken: '<untrusted-token>',
  });

  assert.equal((source.match(/name="_csrf"/g) || []).length, 1);
  assert.equal((source.match(/<%=\s*csrfToken\s*%>/g) || []).length, 1);
  assert.doesNotMatch(source, /<%-\s*csrfToken/);
  assert.match(rendered, /value="&lt;untrusted-token&gt;"/);
});

test('verification resend GET only redirects while POST invokes the resend controller once', async () => {
  let resendCalls = 0;
  const resendController = async (req, res) => {
    resendCalls += 1;
    res.status(204).end();
  };
  const router = express.Router();
  addVerificationResendRoutes(router, resendController);

  const app = express();
  app.use((req, res, next) => {
    req.user = {
      _id: 'test-user',
      blocked: false,
      email_verified: false,
    };
    req.isAuthenticated = () => true;
    next();
  });
  app.use('/user', router);

  const server = await new Promise(resolve => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const getResponse = await fetch(`${baseUrl}/user/resend-verification`, {
      redirect: 'manual',
    });
    assert.equal(getResponse.status, 302);
    assert.equal(getResponse.headers.get('location'), '/user/account');
    assert.equal(resendCalls, 0);

    const postResponse = await fetch(`${baseUrl}/user/resend-verification`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(postResponse.status, 204);
    assert.equal(resendCalls, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
});

test('resend is POST, logout remains POST, and no resend GET can call the controller', async () => {
  const routes = await readSource('routes/users.js');
  const account = stripHtmlComments(await readSource('views/user/account.ejs'));
  const navbar = stripHtmlComments(await readSource('views/partials/navbar.ejs'));

  assert.match(
    routes,
    /\.get\(\(req, res\) => res\.redirect\('\/user\/account'\)\)/,
  );
  assert.match(
    routes,
    /\.post\(isAuthenticatedForVerification, catchAsyncErrors\(resendController\)\)/,
  );
  assert.doesNotMatch(routes, /\.get\([^)]*resendVerification/);
  assert.match(
    account,
    /action="\/user\/resend-verification"\s+method="post"/i,
  );
  assert.match(navbar, /action="\/user\/logout"\s+method="POST"/);
});

test('application middleware order protects all mounted mutation routes after prerequisites', async () => {
  const app = await readSource('app.js');
  const positions = {
    urlencoded: app.indexOf('app.use(express.urlencoded'),
    json: app.indexOf('app.use(express.json'),
    static: app.indexOf('app.use(express.static'),
    session: app.indexOf('app.use(session(sessionConfig))'),
    methodOverride: app.indexOf("app.use(methodOverride('_method'))"),
    passportInitialize: app.indexOf('app.use(passport.initialize())'),
    passportSession: app.indexOf('app.use(passport.session())'),
    sessionVersion: app.indexOf('app.use(enforceSessionAuthVersion)'),
    generalLocals: app.indexOf('app.use(async(req, res, next)'),
    csrfProtection: app.indexOf('app.use(csrfSynchronisedProtection)'),
    csrfLocals: app.indexOf('app.use(exposeCsrfToken)'),
    userRoutes: app.indexOf("app.use('/user', userRoutes)"),
    csrfErrors: app.indexOf('app.use(csrfErrorHandler)'),
    genericErrors: app.indexOf('//GENERIC ERROR HANDLER MIDDLEWARE'),
  };

  Object.entries(positions).forEach(([name, position]) => {
    assert.notEqual(position, -1, `missing middleware marker: ${name}`);
  });
  assert.ok(positions.urlencoded < positions.session);
  assert.ok(positions.json < positions.session);
  assert.ok(positions.static < positions.session);
  assert.ok(positions.session < positions.methodOverride);
  assert.ok(positions.methodOverride < positions.passportInitialize);
  assert.ok(positions.passportInitialize < positions.passportSession);
  assert.ok(positions.passportSession < positions.sessionVersion);
  assert.ok(positions.sessionVersion < positions.generalLocals);
  assert.ok(positions.generalLocals < positions.csrfProtection);
  assert.ok(positions.csrfProtection < positions.csrfLocals);
  assert.ok(positions.csrfLocals < positions.userRoutes);
  assert.ok(positions.csrfErrors < positions.genericErrors);
});

test('CSRF token generation stays lazy and centralized outside controllers and routes', async () => {
  const csrfSource = await readSource('utils/csrf.js');
  assert.match(csrfSource, /Object\.defineProperty\(\s*res\.locals/);
  assert.doesNotMatch(
    csrfSource,
    /res\.locals\.csrfToken\s*=\s*generateToken\s*\(/,
  );

  const requestHandlerFiles = [
    ...(await listFiles(path.join(root, 'controllers'))),
    ...(await listFiles(path.join(root, 'routes'))),
  ].filter(file => file.endsWith('.js'));

  for (const file of requestHandlerFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /\b(?:generateToken|csrfToken)\s*\(/,
      `manual CSRF token generation found in ${path.relative(root, file)}`,
    );
  }
});

const mutationInventory = [
  ['POST', '/user/register', 'form'],
  ['POST', '/user/login', 'form'],
  ['POST', '/user/logout', 'form'],
  ['POST', '/user/resend-verification', 'form'],
  ['POST', '/user/forgot-password', 'form'],
  ['POST', '/user/forgot-password/:userId/:code', 'form'],
  ['POST', '/user/forgot-password/:userId', 'global-middleware'],
  ['POST', '/user/change-password', 'form'],
  ['POST', '/user/delete-account', 'form'],
  ['POST', '/a/user/:id/block', 'form'],
  ['POST', '/a/user/:id/unblock', 'form'],
  ['POST', '/other/contact', 'form'],
  ['POST', '/camp/park/:parkSlug/photo', 'fetch-helper'],
  ['POST', '/camp/park/:parkSlug/video', 'fetch-helper'],
  ['POST', '/camp/park/:parkSlug/campsite/:campsiteSlug/photo', 'fetch-helper'],
  ['POST', '/camp/park/:parkSlug/campsite/:campsiteSlug/video', 'fetch-helper'],
  ['POST', '/camp/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo', 'fetch-helper'],
  ['POST', '/camp/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video', 'fetch-helper'],
  ['DELETE', '/camp/park/:parkSlug/photo/:photoId', 'fetch-helper'],
  ['DELETE', '/camp/park/:parkSlug/video/:videoId', 'fetch-helper'],
  ['DELETE', '/camp/park/:parkSlug/campsite/:campsiteSlug/photo/:photoId', 'fetch-helper'],
  ['DELETE', '/camp/park/:parkSlug/campsite/:campsiteSlug/video/:videoId', 'fetch-helper'],
  ['DELETE', '/camp/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/photo/:photoId', 'fetch-helper'],
  ['DELETE', '/camp/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug/video/:videoId', 'fetch-helper'],
];

test('the current mutation inventory is complete and each browser mutation has a protection path', async () => {
  assert.equal(mutationInventory.length, 24);
  assert.ok(mutationInventory.every(([, , protection]) =>
    ['form', 'fetch-helper', 'global-middleware'].includes(protection)));

  const userRoutes = await readSource('routes/users.js');
  const adminRoutes = await readSource('routes/admin.js');
  const otherRoutes = await readSource('routes/other.js');
  const campRoutes = await readSource('routes/camp.js');
  const combinedRoutes = [userRoutes, adminRoutes, otherRoutes, campRoutes].join('\n');

  for (const [, route] of mutationInventory) {
    const routeFragment = route
      .replace(/^\/(?:user|a|other|camp)/, '')
      .replace(/:[A-Za-z]+/g, ':');
    const normalizedSource = combinedRoutes.replace(/:[A-Za-z]+/g, ':');
    assert.ok(
      normalizedSource.includes(`'${routeFragment}'`) ||
        normalizedSource.includes(`\"${routeFragment}\"`),
      `route inventory entry is missing from route sources: ${route}`,
    );
  }
});

test('all unsafe first-party browser requests use the shared helper without manual token logic', async () => {
  const publicJsFiles = (await listFiles(path.join(root, 'public', 'js')))
    .filter(file => file.endsWith('.js') && !file.endsWith('.min.js'));
  const unsafeMethodFiles = [];

  for (const file of publicJsFiles) {
    const source = await readFile(file, 'utf8');
    if (/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(source)) {
      unsafeMethodFiles.push(path.basename(file));
    }
    if (path.basename(file) !== 'csrf.js') {
      assert.doesNotMatch(source, /X-CSRF-Token/i);
    }
  }

  assert.deepEqual(unsafeMethodFiles.sort(), ['parkMediaSlider.js', 'showPark.js']);

  const showPark = await readSource('public/js/showPark.js');
  const parkSlider = await readSource('public/js/parkMediaSlider.js');
  assert.match(showPark, /CampPicsCsrf\.fetch\(endpoint, fetchOpts\)/);
  assert.match(showPark, /CampPicsCsrf\.fetch\(url, \{\s*method: 'DELETE'/);
  assert.match(parkSlider, /CampPicsCsrf\.fetch\(url, \{\s*method: 'DELETE'/);
  assert.doesNotMatch(showPark, /(?<!\.)\bfetch\(endpoint, fetchOpts\)/);
  assert.doesNotMatch(parkSlider, /(?<!\.)\bfetch\(url, \{\s*method: 'DELETE'/);
});

test('CSRF state is not added to database models and production URLs do not contain tokens', async () => {
  const modelFiles = (await listFiles(path.join(root, 'models')))
    .filter(file => file.endsWith('.js'));
  for (const file of modelFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:csrfToken|_csrf)\b/);
  }

  const productionFiles = [
    ...(await listFiles(path.join(root, 'controllers'))),
    ...(await listFiles(path.join(root, 'routes'))),
    ...(await listFiles(path.join(root, 'public', 'js'))),
    ...(await listFiles(path.join(root, 'views'))),
  ].filter(file => file.endsWith('.js') || file.endsWith('.ejs'));

  for (const file of productionFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:\?|&)_csrf=/,
      `CSRF token appears in a URL in ${path.relative(root, file)}`,
    );
  }
});
