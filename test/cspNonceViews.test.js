import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';

import { consumeGa4Event } from '../utils/ga4EventBootstrap.js';
import { serializeForInlineScript } from '../utils/serializeForInlineScript.js';

const KNOWN_NONCE = 'known-csp-nonce';
const HOSTILE_SCRIPT_VALUE =
  '</script><script id="server-xss">window.__cspXss = true</script>';
const GA4_FIXTURE = {
  event: `${HOSTILE_SCRIPT_VALUE}; quotes " ' &`,
  user_id: `camper${String.fromCharCode(0x2028)}line${String.fromCharCode(0x2029)}end`,
};

const root = process.cwd();
const viewRoot = path.join(root, 'views');
const stripHtmlComments = source => source.replace(/<!--[\s\S]*?-->/gu, '');

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return files.flat();
}

function scriptTags(source) {
  return [...source.matchAll(
    /<script\b((?:(?:<%[\s\S]*?%>)|[^>])*)>([\s\S]*?)<\/script\s*>/giu,
  )]
    .map(match => ({ attributes: match[1], body: match[2], source: match[0] }));
}

async function readView(relativePath) {
  return readFile(path.join(viewRoot, relativePath), 'utf8');
}

function renderSource(source, locals, filename) {
  return ejs.render(source, {
    include: () => '',
    layout: () => {},
    ...locals,
  }, { filename });
}

async function renderView(relativePath, locals) {
  const filename = path.join(viewRoot, relativePath);
  const source = await readFile(filename, 'utf8');
  assert.doesNotThrow(() => ejs.compile(source, { filename }));
  return renderSource(source, locals, filename);
}

function countRenderedInlineScripts(html) {
  return scriptTags(stripHtmlComments(html))
    .filter(script => !/\bsrc\s*=/iu.test(script.attributes))
    .length;
}

describe('active EJS script inventory', () => {
  test('every active inline script uses the escaped response nonce', async () => {
    const files = (await listFiles(viewRoot)).filter(file => file.endsWith('.ejs'));
    const locations = [];
    let externalScriptCount = 0;

    for (const file of files) {
      const relativePath = path.relative(viewRoot, file).replaceAll('\\', '/');
      const activeSource = stripHtmlComments(await readFile(file, 'utf8'));

      for (const script of scriptTags(activeSource)) {
        if (/\bsrc\s*=/iu.test(script.attributes)) {
          externalScriptCount += 1;
          assert.match(
            script.attributes,
            /\bsrc\s*=\s*["'][^"']+["']/iu,
            `${relativePath} has an invalid external script source`,
          );
          assert.equal(
            script.body.trim(),
            '',
            `${relativePath} mixes external and inline script content`,
          );
          continue;
        }

        if (!script.body.trim()) continue;
        assert.match(
          script.attributes,
          /\bnonce\s*=\s*["']<%=\s*cspNonce\s*%>["']/u,
          `${relativePath} has an active inline script without cspNonce`,
        );
        locations.push(relativePath);
      }
    }

    assert.deepEqual(
      Object.fromEntries(
        [...new Set(locations)].sort().map(file => [
          file,
          locations.filter(location => location === file).length,
        ]),
      ),
      {
        'layouts/boilerplate.ejs': 2,
        'parks/allParks.ejs': 1,
        'parks/showPark.ejs': 1,
      },
    );
    assert.equal(locations.length, 4);
    assert.ok(externalScriptCount > 0);
  });

  test('HTML comments are ignored and active markup has no inline event handlers', async () => {
    const files = (await listFiles(viewRoot)).filter(file => file.endsWith('.ejs'));
    const accountSource = await readView('user/account.ejs');
    assert.match(accountSource, /<!--\s*<script>[\s\S]*?delete-account-form/u);
    assert.equal(
      scriptTags(stripHtmlComments(accountSource))
        .some(script => script.body.includes('delete-account-form')),
      false,
    );

    for (const file of files) {
      const relativePath = path.relative(root, file);
      const activeSource = stripHtmlComments(await readFile(file, 'utf8'))
        .replace(
          /<script\b(?:(?:<%[\s\S]*?%>)|[^>])*?>[\s\S]*?<\/script\s*>/giu,
          '',
        );
      assert.doesNotMatch(
        activeSource,
        /\bon[a-z]+\s*=/iu,
        `${relativePath} contains an active inline event-handler attribute`,
      );
    }
  });
});

describe('GA4 inline bootstrap serialization', () => {
  test('hostile event data round-trips safely and is consumed once', async () => {
    let deleteCount = 0;
    const session = new Proxy({ __GA4_EVENT__: GA4_FIXTURE, marker: 'preserved' }, {
      deleteProperty(target, property) {
        if (property === '__GA4_EVENT__') deleteCount += 1;
        return Reflect.deleteProperty(target, property);
      },
    });

    const serialized = consumeGa4Event(session);

    assert.equal(serialized.includes('</script>'), false);
    assert.equal(serialized.includes('<script'), false);
    assert.equal(serialized.includes('&'), false);
    assert.equal(serialized.includes(String.fromCharCode(0x2028)), false);
    assert.equal(serialized.includes(String.fromCharCode(0x2029)), false);
    assert.deepEqual(JSON.parse(serialized), GA4_FIXTURE);
    assert.equal('__GA4_EVENT__' in session, false);
    assert.equal(session.marker, 'preserved');
    assert.equal(deleteCount, 1);

    const boilerplate = await renderView('layouts/boilerplate.ejs', {
      body: 'representative body',
      canonicalUrl: null,
      cspNonce: KNOWN_NONCE,
      csrfToken: 'csrf-token',
      currentUser: null,
      data: {},
      error: [],
      ga4EventJson: serialized,
      info: [],
      meta: { title: 'GA4 test' },
      success: [],
      warning: [],
    });
    const assignment = boilerplate.match(/window\.__GA4_EVENT__ = (.*);/u)?.[1];
    assert.ok(assignment);
    const context = { window: {} };
    vm.runInNewContext(`window.__GA4_EVENT__ = ${assignment};`, context);
    assert.deepEqual(
      JSON.parse(JSON.stringify(context.window.__GA4_EVENT__)),
      GA4_FIXTURE,
    );
  });

  test('the boilerplate uses the authoritative serialized local without raw JSON.stringify', async () => {
    const boilerplate = await readView('layouts/boilerplate.ejs');
    const app = await readFile(path.join(root, 'app.js'), 'utf8');

    assert.match(boilerplate, /window\.__GA4_EVENT__ = <%[-]\s*ga4EventJson\s*%>/u);
    assert.doesNotMatch(boilerplate, /JSON\.stringify\s*\(\s*GA4_EVENT/u);
    assert.doesNotMatch(app, /res\.locals\.GA4_EVENT/u);
    assert.match(app, /res\.locals\.ga4EventJson = consumeGa4Event\(req\.session\)/u);
  });
});

describe('representative nonce-bearing template behavior', () => {
  test('changed templates compile, render their active scripts with the nonce, and keep ordering', async () => {
    const serializedPark = serializeForInlineScript({
      slug: HOSTILE_SCRIPT_VALUE,
      name: HOSTILE_SCRIPT_VALUE,
    });
    const serializedParks = serializeForInlineScript([{
      name: HOSTILE_SCRIPT_VALUE,
      slug: '/park-safe',
    }]);
    const common = { cspNonce: KNOWN_NONCE };

    const search = await renderView('partials/search.ejs', {
      ...common,
      data: {},
    });
    const forgotPassword = await renderView('user/forgotPassword.ejs', {
      ...common,
      encodedCode: 'code&amp;value',
      encodedUserId: 'user-id',
    });
    const showPark = await renderView('parks/showPark.ejs', {
      ...common,
      currentUser: null,
      data: {},
      park: {
        campgrounds: [],
        campsites: [],
        description: HOSTILE_SCRIPT_VALUE,
        name: HOSTILE_SCRIPT_VALUE,
        province: 'Ontario',
        type: 'provincial',
      },
      parkPageJson: serializedPark,
    });
    const allParks = await renderView('parks/allParks.ejs', {
      ...common,
      data: {},
      parks: [{ name: HOSTILE_SCRIPT_VALUE, slug: '/park-safe' }],
      parksJson: serializedParks,
    });
    const dashboard = await renderView('admin/dashboard.ejs', {
      ...common,
      dashboardStats: {
        totalUploads: 1,
        totalUsers: 2,
        verifiedUsers: 1,
        blockedUsers: 0,
      },
      extractYouTubeVideoId: () => null,
      hasMoreUploads: true,
      hasMoreUsers: true,
      uploadPage: 1,
      uploads: [{
        adminPhotoUrl: null,
        campgroundName: HOSTILE_SCRIPT_VALUE,
        campsiteName: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        mediaType: 'photo',
        parkName: HOSTILE_SCRIPT_VALUE,
        uploader: { fname: HOSTILE_SCRIPT_VALUE, username: 'camper@example.test' },
      }],
      userPage: 1,
      users: [{
        _id: 'user-id',
        blocked: false,
        date_created: '2026-08-01T00:00:00.000Z',
        email_verified: false,
        fname: HOSTILE_SCRIPT_VALUE,
        username: 'camper@example.test',
      }],
    });
    const boilerplate = await renderView('layouts/boilerplate.ejs', {
      ...common,
      body: forgotPassword,
      canonicalUrl: null,
      csrfToken: 'csrf-token',
      currentUser: null,
      data: {},
      error: [HOSTILE_SCRIPT_VALUE],
      ga4EventJson: serializeForInlineScript(GA4_FIXTURE),
      info: ['Information'],
      meta: { title: HOSTILE_SCRIPT_VALUE },
      success: ['Success'],
      warning: ['Warning'],
    });

    for (const [name, html] of Object.entries({
      allParks,
      boilerplate,
      showPark,
    })) {
      const inlineScripts = scriptTags(stripHtmlComments(html))
        .filter(script => !/\bsrc\s*=/iu.test(script.attributes));
      assert.ok(inlineScripts.length > 0, `${name} should render an inline script`);
      assert.ok(
        inlineScripts.every(script =>
          new RegExp(`\\bnonce=["']${KNOWN_NONCE}["']`, 'u')
            .test(script.attributes)),
        `${name} should nonce every rendered inline script`,
      );
    }

    for (const [name, html] of Object.entries({
      dashboard,
      forgotPassword,
      search,
    })) {
      assert.equal(
        countRenderedInlineScripts(html),
        0,
        `${name} should contain no active inline scripts`,
      );
    }

    assert.equal(countRenderedInlineScripts(boilerplate), 2);
    assert.equal(boilerplate.includes('<script id="server-xss">'), false);
    assert.equal(showPark.includes('<script id="server-xss">'), false);
    assert.equal(allParks.includes('<script id="server-xss">'), false);
    assert.equal(dashboard.includes('<script id="server-xss">'), false);

    assert.match(boilerplate, /GTM-TBCRW55F/u);
    const gtmPosition = boilerplate.indexOf("'GTM-TBCRW55F'");
    const ga4Position = boilerplate.indexOf('window.__GA4_EVENT__');
    const themePosition = boilerplate.indexOf('/js/theme.js');
    const cssPosition = boilerplate.indexOf('/css/login.css');
    assert.ok(gtmPosition >= 0);
    assert.ok(ga4Position > gtmPosition);
    assert.ok(themePosition > ga4Position);
    assert.ok(cssPosition > themePosition);
    assert.match(boilerplate, /<script src="\/js\/theme\.js"><\/script>/u);
    assert.doesNotMatch(
      boilerplate.match(/<script[^>]+src="\/js\/theme\.js"[^>]*>/u)?.[0] || '',
      /\b(?:async|defer|type\s*=\s*["']module["'])\b/iu,
    );
    assert.ok(
      ga4Position <
        boilerplate.indexOf('/js/general.js'),
    );
    assert.ok(
      boilerplate.indexOf('/js/passwordPolicy.js') <
        boilerplate.indexOf('/js/forgotPassword.js'),
    );
    assert.ok(
      boilerplate.indexOf('/js/flash-messages.js') <
        boilerplate.indexOf('/js/general.js'),
    );
    assert.ok(
      boilerplate.indexOf('/js/general.js') < boilerplate.indexOf('/js/login.js'),
    );
    assert.ok(showPark.indexOf('window.PARK') < showPark.indexOf('/js/showPark.js'));
    assert.ok(allParks.indexOf('window.ALL_PARKS') < allParks.indexOf('/js/allParks.js'));
    assert.ok(
      dashboard.indexOf('/js/mediaRendering.js') <
        dashboard.indexOf('/js/adminUserStatus.js') &&
        dashboard.indexOf('/js/adminUserStatus.js') <
        dashboard.indexOf('/js/adminDashboard.js'),
    );
    assert.ok(
      dashboard.indexOf('admin-dashboard-state') <
        dashboard.indexOf('/js/adminDashboard.js'),
    );
    assert.match(forgotPassword, /<script src="\/js\/forgotPassword\.js"><\/script>/u);
    assert.doesNotMatch(search, /<script\b/iu);
  });
});

describe('CSP production source guards', () => {
  test('nonce middleware precedes Helmet and the Phase 1 directives remain exact', async () => {
    const app = await readFile(path.join(root, 'app.js'), 'utf8');
    const noncePosition = app.indexOf('app.use(createCspNonceMiddleware());');
    const helmetPosition = app.indexOf('helmet({', noncePosition);
    assert.ok(noncePosition >= 0);
    assert.ok(helmetPosition > noncePosition);

    const scriptDirective = app.match(/scriptSrc:\s*\[([^\]]+)\]/u)?.[1];
    const styleDirective = app.match(/styleSrc:\s*\[([^\]]+)\]/u)?.[1];
    assert.ok(scriptDirective);
    assert.ok(styleDirective);
    assert.match(scriptDirective, /"'self'"/u);
    assert.match(scriptDirective, /cspNonceSource/u);
    assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval|strict-dynamic|data:|blob:|\*/u);
    assert.match(styleDirective, /"'unsafe-inline'"/u);
    assert.match(app, /scriptSrcAttr:\s*\["'none'"\]/u);

    const scriptHosts = app
      .slice(app.indexOf('const scriptSrcUrls'), app.indexOf('const styleSrcUrls'))
      .match(/https:\/\/[^']+/gu) || [];
    assert.deepEqual(scriptHosts, [
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com',
    ]);
    assert.match(app, /https:\/\/res\.cloudinary\.com\/\$\{runtimeConfig\.cloudinary\.cloudName\}\//u);
    assert.match(app, /'https:\/\/img\.youtube\.com'/u);
    assert.match(app, /frameSrc:\s*\["'self'", 'https:\/\/www\.youtube\.com'\]/u);
  });

  test('the nonce is not persisted or logged and controllers do not own CSP nonce behavior', async () => {
    const nonceSource = await readFile(path.join(root, 'utils/cspNonce.js'), 'utf8');
    const app = await readFile(path.join(root, 'app.js'), 'utf8');
    const controllerFiles = (await listFiles(path.join(root, 'controllers')))
      .filter(file => file.endsWith('.js'));

    assert.doesNotMatch(nonceSource, /session|cookies?|database|logger|console|flash|Math\.random|Date\.now/iu);
    assert.doesNotMatch(nonceSource, /\b_req\s*\./u);
    assert.doesNotMatch(
      app,
      /(?:session|cookies?|logger|console|flash)[^\n]*cspNonce|cspNonce[^\n]*(?:session|cookies?|logger|console|flash)/iu,
    );
    for (const file of controllerFiles) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /cspNonce|ga4EventJson/u);
    }
  });

  test('package dependencies and the Node/npm engine policy remain fixed', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const expectedDependencies = {
      bcryptjs: '^3.0.2',
      cloudinary: '1.41.3',
      compression: '^1.8.1',
      'connect-flash': '^0.1.1',
      'connect-mongo': '^5.1.0',
      'csrf-sync': '^4.2.1',
      dotenv: '^17.2.3',
      ejs: '3.1.10',
      'ejs-mate': '^4.0.0',
      express: '^5.1.0',
      'express-rate-limit': '^8.6.1',
      'express-session': '^1.18.2',
      'express-slow-down': '^3.0.0',
      'form-data': '^4.0.6',
      helmet: '^8.3.0',
      'mailgun.js': '^12.9.0',
      'method-override': '^3.0.0',
      mongoose: '^8.24.2',
      multer: '^2.2.0',
      passport: '^0.7.0',
      'passport-local': '^1.0.0',
      'passport-local-mongoose': '^8.0.0',
      sharp: '^0.34.5',
      streamifier: '^0.1.1',
    };

    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
    assert.deepEqual(packageJson.dependencies, expectedDependencies);
    assert.deepEqual(packageLock.packages[''].dependencies, expectedDependencies);
  });
});
