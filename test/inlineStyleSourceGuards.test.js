import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import ejs from 'ejs';

const root = process.cwd();
const viewRoot = path.join(root, 'views');
const publicJsRoot = path.join(root, 'public', 'js');
const EXCLUDED_THIRD_PARTY_BROWSER_SCRIPTS = new Set([
  'external-scripts/leaflet.js',
  'swiper-bundle.min.js',
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/gu, '');
}

function browserStyleMarkup(source) {
  const activeSource = stripHtmlComments(source);
  return {
    attributes: [...activeSource.matchAll(/\sstyle\s*=/giu)],
    blocks: [...activeSource.matchAll(/<style\b/giu)],
  };
}

function analyzeJavaScript(source) {
  const code = new Uint8Array(source.length);
  code.fill(1);
  const strings = [];

  const mask = (start, end) => code.fill(0, start, end);

  function consumeQuoted(start, quote) {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
      } else if (source[index] === quote) {
        index += 1;
        break;
      } else {
        index += 1;
      }
    }
    strings.push(source.slice(start + 1, Math.max(start + 1, index - 1)));
    mask(start, index);
    return index;
  }

  function consumeTemplate(start) {
    let index = start;
    let raw = '';
    code[index] = 0;
    index += 1;

    while (index < source.length) {
      if (source[index] === '\\') {
        raw += source.slice(index, index + 2);
        mask(index, index + 2);
        index += 2;
        continue;
      }
      if (source[index] === '`') {
        code[index] = 0;
        strings.push(raw);
        return index + 1;
      }
      if (source[index] === '$' && source[index + 1] === '{') {
        strings.push(raw);
        raw = '';
        mask(index, index + 2);
        index = scanCode(index + 2, true);
        continue;
      }
      raw += source[index];
      code[index] = 0;
      index += 1;
    }

    strings.push(raw);
    return index;
  }

  function scanCode(start, stopAtClosingBrace = false) {
    let braceDepth = 0;
    let index = start;

    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1];

      if (current === '/' && next === '/') {
        const end = source.indexOf('\n', index + 2);
        const commentEnd = end === -1 ? source.length : end;
        mask(index, commentEnd);
        index = commentEnd;
        continue;
      }
      if (current === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        const commentEnd = end === -1 ? source.length : end + 2;
        mask(index, commentEnd);
        index = commentEnd;
        continue;
      }
      if (current === "'" || current === '"') {
        index = consumeQuoted(index, current);
        continue;
      }
      if (current === '`') {
        index = consumeTemplate(index);
        continue;
      }
      if (current === '{') {
        braceDepth += 1;
      } else if (current === '}') {
        if (stopAtClosingBrace && braceDepth === 0) {
          code[index] = 0;
          return index + 1;
        }
        braceDepth = Math.max(0, braceDepth - 1);
      }
      index += 1;
    }
    return index;
  }

  scanCode(0);

  const issues = [];
  const recordCodeMatches = (pattern, label) => {
    for (const match of source.matchAll(pattern)) {
      if (code[match.index]) issues.push(`${label} at offset ${match.index}`);
    }
  };

  recordCodeMatches(/\.\s*style\b/gu, 'direct style property access');
  recordCodeMatches(/\bcssText\b/gu, 'cssText access');
  recordCodeMatches(
    /\bsetAttribute\s*\(\s*(['"])style\1\s*,/gu,
    'style attribute assignment',
  );
  recordCodeMatches(
    /\bstyle\s*=\s*['"`]/gu,
    'literal style-string assignment',
  );

  for (const value of strings) {
    if (/<[^>]*\sstyle\s*=/iu.test(value)) {
      issues.push('literal HTML style attribute');
    }
  }

  return issues;
}

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function render(source, locals = {}, filename = 'representative.ejs') {
  return ejs.render(source, {
    include: () => '',
    layout: () => {},
    ...locals,
  }, { filename });
}

function assertNoRenderedStyles(name, html) {
  const styles = browserStyleMarkup(html);
  assert.equal(styles.attributes.length, 0, `${name} rendered a style attribute`);
  assert.equal(styles.blocks.length, 0, `${name} rendered a style block`);
}

describe('browser EJS inline-style contract', () => {
  test('comment-aware scan covers every non-email EJS template', async () => {
    const files = (await listFiles(viewRoot))
      .filter(file => file.endsWith('.ejs'));
    const browserFiles = files.filter(file =>
      !path.relative(viewRoot, file).replaceAll('\\', '/').startsWith('emails/'));

    assert.ok(browserFiles.length > 0);
    for (const file of browserFiles) {
      const source = await readFile(file, 'utf8');
      const relativePath = path.relative(root, file);
      const styles = browserStyleMarkup(source);
      assert.equal(styles.attributes.length, 0, `${relativePath} has an active style attribute`);
      assert.equal(styles.blocks.length, 0, `${relativePath} has an active style block`);
      assert.doesNotThrow(() => ejs.compile(source, { filename: file }));
    }
  });

  test('commented examples are ignored without hiding active markup', () => {
    const fixture = [
      '<!-- <div style="display:none"></div><style>.old {}</style> -->',
      '<div class="safe"></div>',
    ].join('\n');
    assert.deepEqual(browserStyleMarkup(fixture), { attributes: [], blocks: [] });

    const active = browserStyleMarkup('<div style="display:none"></div><style></style>');
    assert.equal(active.attributes.length, 1);
    assert.equal(active.blocks.length, 1);
  });

  test('email inline styles remain scoped to email templates', async () => {
    const emailFiles = [
      'views/emails/email-contact-form-submission.ejs',
      'views/emails/reset-password.ejs',
      'views/emails/verify-account.ejs',
    ];
    for (const file of emailFiles) {
      assert.match(await read(file), /<body style="font-family: Arial, sans-serif;">/u);
    }
    assert.match(
      await read('views/emails/monthly-draw-admin-notification.ejs'),
      /<body style="font-family: Arial, sans-serif; color: #202020; line-height: 1.5;">/u,
    );

    const status = execFileSync(
      'git',
      ['status', '--short', '--', 'views/emails'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.deepEqual(
      status
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(line => line.slice(3).replaceAll('\\', '/')),
      [],
    );
  });
});

describe('first-party browser JavaScript inline-style contract', () => {
  test('comment-aware scan excludes only the documented vendor scripts', async () => {
    const scripts = (await listFiles(publicJsRoot))
      .filter(file => file.endsWith('.js'));
    const scanned = [];

    for (const file of scripts) {
      const relativePath = path.relative(publicJsRoot, file).replaceAll('\\', '/');
      if (EXCLUDED_THIRD_PARTY_BROWSER_SCRIPTS.has(relativePath)) continue;
      scanned.push(relativePath);
      const issues = analyzeJavaScript(await readFile(file, 'utf8'));
      assert.deepEqual(issues, [], `${relativePath}: ${issues.join(', ')}`);
    }

    assert.equal(scanned.includes('general.js'), true);
    assert.equal(scanned.includes('mediaRendering.js'), true);
    assert.deepEqual(
      [...EXCLUDED_THIRD_PARTY_BROWSER_SCRIPTS].sort(),
      ['external-scripts/leaflet.js', 'swiper-bundle.min.js'],
    );

    for (const file of EXCLUDED_THIRD_PARTY_BROWSER_SCRIPTS) {
      assert.match(await read(`public/js/${file}`), /\.style(?:\.|\[)/u);
    }
  });

  test('comments and ordinary string fixtures do not cause false failures', () => {
    const safeFixture = [
      "// example.style.color = 'red';",
      "/* node.setAttribute('style', 'display:none'); */",
      "const example = \"element.style.color = 'red'\";",
      "const cssExample = 'style.cssText';",
    ].join('\n');
    assert.deepEqual(analyzeJavaScript(safeFixture), []);

    assert.notDeepEqual(analyzeJavaScript("node.style.color = 'red';"), []);
    assert.notDeepEqual(
      analyzeJavaScript("node.setAttribute('style', 'display:none');"),
      [],
    );
    assert.notDeepEqual(
      analyzeJavaScript('const markup = `<div style="display:none"></div>`;'),
      [],
    );
  });
});

describe('representative static template rendering', () => {
  test('semantic classes render without inline styles and hostile values stay escaped', async () => {
    const hostile = '</div><script id="style-xss">attack()</script>';
    const sources = Object.fromEntries(await Promise.all([
      'views/layouts/boilerplate.ejs',
      'views/partials/navbar.ejs',
      'views/partials/modals/login.ejs',
      'views/home.ejs',
      'views/404.ejs',
      'views/error.ejs',
      'views/other/contact.ejs',
      'views/other/privacy-and-terms.ejs',
      'views/parks/results.ejs',
      'views/parks/showPark.ejs',
      'views/partials/modals/campsiteModalContent.ejs',
    ].map(async file => [file, await read(file)])));

    const rendered = {
      boilerplate: render(sources['views/layouts/boilerplate.ejs'], {
        body: hostile,
        canonicalUrl: null,
        cspNonce: 'known-nonce',
        csrfToken: 'csrf-token',
        currentUser: null,
        data: {},
        error: [],
        ga4EventJson: 'null',
        info: [],
        meta: { title: hostile },
        success: [],
        warning: [],
      }),
      navbar: render(sources['views/partials/navbar.ejs'], {
        csrfToken: 'csrf-token',
        currentUser: { isAdmin: false },
        data: {},
      }),
      login: render(sources['views/partials/modals/login.ejs']),
      home: render(sources['views/home.ejs']),
      notFound: render(sources['views/404.ejs']),
      error: render(sources['views/error.ejs']),
      contact: render(sources['views/other/contact.ejs'], {
        currentUser: { fname: hostile, username: hostile },
        prefill: { email_body: hostile, email_subject: hostile },
      }),
      legal: render(sources['views/other/privacy-and-terms.ejs']),
      results: render(sources['views/parks/results.ejs'], {
        data: {
          query: hostile,
          results: [{
            destination: '/camp/park/safe',
            image: hostile,
            nameSegments: [{ highlighted: false, text: hostile }],
            parentParkSegments: [{ highlighted: false, text: hostile }],
            provinceSegments: [{ highlighted: false, text: hostile }],
            type: 'campground',
          }],
        },
      }),
      showPark: render(sources['views/parks/showPark.ejs'], {
        cspNonce: 'known-nonce',
        currentUser: null,
        data: {},
        park: {
          campgrounds: [],
          campsites: [],
          description: hostile,
          name: hostile,
          province: hostile,
          type: 'provincial',
        },
        parkPageJson: '{}',
      }),
      campsite: render(sources['views/partials/modals/campsiteModalContent.ejs'], {
        currentUser: null,
      }),
    };

    for (const [name, html] of Object.entries(rendered)) {
      assertNoRenderedStyles(name, html);
    }

    assert.match(rendered.boilerplate, /class="gtm-noscript-frame"/u);
    assert.match(rendered.navbar, /class="logout-form"/u);
    assert.match(rendered.login, /class="registration-honeypot"/u);
    assert.match(rendered.home, /class="home-hero-spacer"/u);
    assert.match(rendered.notFound, /class="not-found-guidance"/u);
    assert.match(rendered.error, /class="error-page-spacer"/u);
    assert.match(rendered.contact, /class="contact-submit-row"/u);
    assert.match(rendered.legal, /href="\/css\/legal\.css"/u);
    assert.match(rendered.results, /class="park-result-province"/u);
    assert.match(rendered.showPark, /class="park-media-instructions"/u);
    assert.match(rendered.campsite, /class="campsite-upload-login-prompt"/u);
    assert.equal(rendered.contact.includes('<script id="style-xss">'), false);
    assert.equal(rendered.results.includes('<script id="style-xss">'), false);
    assert.equal(rendered.showPark.includes('<script id="style-xss">'), false);

    const generalCss = await read('public/css/general.css');
    assert.match(generalCss, /\.logout-form[\s\S]*?display:\s*none/u);
    assert.match(generalCss, /\.registration-honeypot[\s\S]*?display:\s*none/u);
  });
});

describe('administrator stylesheet extraction', () => {
  test('dashboard rendering preserves status and Block/Unblock contracts', async () => {
    const source = await read('views/admin/dashboard.ejs');
    const html = render(source, {
      dashboardStats: {
        totalUploads: 0,
        totalUsers: 2,
        verifiedUsers: 1,
        blockedUsers: 1,
      },
      extractYouTubeVideoId: () => null,
      hasMoreUploads: false,
      hasMoreUsers: false,
      uploadPage: 1,
      uploads: [],
      userPage: 1,
      users: [
        {
          _id: 'verified-user',
          blocked: false,
          date_created: '2026-01-01T00:00:00.000Z',
          email_verified: true,
          fname: 'Verified',
          username: 'verified@example.test',
        },
        {
          _id: 'unverified-user',
          blocked: true,
          date_created: '2026-01-02T00:00:00.000Z',
          email_verified: false,
          fname: 'Unverified',
          username: 'unverified@example.test',
        },
      ],
    });

    assert.match(html, /href="\/css\/adminDashboard\.css"/u);
    assert.doesNotMatch(stripHtmlComments(html), /<style\b|\sstyle\s*=/iu);
    assert.equal((html.match(/class="admin-email-status"/gu) || []).length, 1);
    assert.equal(
      (html.match(/class="admin-email-status admin-email-status--unverified"/gu) || []).length,
      1,
    );
    assert.match(html, /action="\/a\/user\/verified-user\/block"/u);
    assert.match(html, /class="block-btn">Block<\/button>/u);
    assert.match(html, /action="\/a\/user\/unverified-user\/unblock"/u);
    assert.match(html, /class="unblock-btn">Unblock<\/button>/u);

    const css = await read('public/css/adminDashboard.css');
    for (const declaration of [
      'grid-template-columns: repeat(4, minmax(0, 1fr))',
      'grid-template-columns: repeat(2, minmax(0, 1fr))',
      'grid-template-columns: minmax(0, 1fr)',
      'max-width: 240px',
      'overflow-wrap: anywhere',
      'display: inline',
      'content: attr(data-label)',
      ':focus-visible',
    ]) {
      assert.equal(css.includes(declaration), true, declaration);
    }
  });
});

describe('CSP, vendor, and scope guards', () => {
  test('approved script nonce policy and temporary style allowance remain exact', async () => {
    const app = await read('app.js');
    const scriptDirective = app.match(/scriptSrc:\s*\[([^\]]+)\]/u)?.[1];
    const styleDirective = app.match(/styleSrc:\s*\[([^\]]+)\]/u)?.[1];
    assert.ok(scriptDirective);
    assert.ok(styleDirective);
    assert.doesNotMatch(scriptDirective, /unsafe-inline/u);
    assert.match(scriptDirective, /cspNonceSource/u);
    assert.match(styleDirective, /"'unsafe-inline'"/u);
    assert.match(app, /scriptSrcAttr:\s*\["'none'"\]/u);

    const retainedViews = [
      await read('views/layouts/boilerplate.ejs'),
      await read('views/parks/showPark.ejs'),
      await read('views/parks/allParks.ejs'),
    ].join('\n');
    assert.equal(
      (retainedViews.match(/<script nonce="<%= cspNonce %>">/gu) || []).length,
      4,
    );
  });

  test('restricted files outside ordinary logout remain unchanged', async () => {
    const status = execFileSync('git', [
      'status',
      '--short',
      '--',
      'app.js',
      'config',
      'controllers',
      'middleware.js',
      'models',
      'package.json',
      'package-lock.json',
      'routes',
      'views/emails',
      'public/js/external-scripts/leaflet.js',
      'public/js/swiper-bundle.min.js',
    ], { cwd: root, encoding: 'utf8' });
    const allowedRestrictedFiles = new Set([
      'app.js',
      'config/adminRoadmap.js',
      'controllers/admin.js',
      'controllers/media.js',
      'controllers/monthlyDraw.js',
      'controllers/monthlyDrawAdmin.js',
      'controllers/siteAnnouncements.js',
      'controllers/users.js',
      'middleware.js',
      'models/siteAnnouncement.js',
      'models/monthlyDrawNoUploadEntry.js',
      'models/monthlyDrawResult.js',
      'models/upload.js',
      'routes/admin.js',
      'routes/other.js',
      'routes/users.js',
      'package.json',
      'package-lock.json',
      'views/emails/monthly-draw-admin-notification.ejs',
    ]);
    const unexpectedChanges = status
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter(line => !allowedRestrictedFiles.has(
        line.slice(3).replaceAll('\\', '/'),
      ));
    assert.deepEqual(unexpectedChanges, []);

    const packageJson = JSON.parse(await read('package.json'));
    const packageLock = JSON.parse(await read('package-lock.json'));
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
    assert.equal(
      packageJson.scripts['auth:audit-artifacts'],
      'node scripts/reconcileAuthArtifacts.js',
    );
    assert.equal(
      packageJson.scripts['auth:cleanup-expired-artifacts'],
      'node scripts/reconcileAuthArtifacts.js --apply',
    );
  });
});
