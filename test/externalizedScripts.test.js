import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

import ejs from 'ejs';

const root = process.cwd();
const read = relativePath => readFile(path.join(root, relativePath), 'utf8');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.listeners = new Map();
    this.removed = false;
    this.style = {};
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      contains: value => classes.has(value),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      values: classes,
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  closest(selector) {
    if (!selector.startsWith('.')) return null;
    return this.className.split(/\s+/u).includes(selector.slice(1))
      ? this
      : null;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  remove() {
    this.removed = true;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function findAll(rootElement, predicate) {
  const matches = predicate(rootElement) ? [rootElement] : [];
  for (const child of rootElement.children) {
    matches.push(...findAll(child, predicate));
  }
  return matches;
}

function combinedText(element) {
  return element.textContent + element.children.map(combinedText).join('');
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&#34;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attributeValue(html, name) {
  const value = html.match(new RegExp(`${name}="([^"]*)"`, 'u'))?.[1];
  return value === undefined ? undefined : decodeHtmlAttribute(value);
}

function externalScriptBodies(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/gu, '');
  return [...withoutComments.matchAll(
    /<script\b((?:(?:<%[\s\S]*?%>)|[^>])*)>([\s\S]*?)<\/script\s*>/giu,
  )]
    .filter(match => !/\bsrc\s*=/iu.test(match[1]))
    .map(match => match[2]);
}

describe('early external theme selection', () => {
  test('selects stored and system themes with conservative failure fallbacks', async () => {
    const source = await read('public/js/theme.js');
    const fixtures = [
      {
        name: 'stored light',
        stored: 'light',
        systemDark: true,
        expected: 'light',
      },
      {
        name: 'stored dark',
        stored: 'dark',
        systemDark: false,
        expected: 'dark',
      },
      {
        name: 'no stored value with dark preference',
        stored: null,
        systemDark: true,
        expected: 'dark',
      },
      {
        name: 'no stored value with light preference',
        stored: null,
        systemDark: false,
        expected: 'light',
      },
      {
        name: 'invalid stored value',
        stored: 'sepia',
        systemDark: true,
        expected: 'dark',
      },
      {
        name: 'localStorage failure',
        storageFailure: true,
        systemDark: true,
        expected: 'dark',
      },
      {
        name: 'matchMedia failure',
        stored: null,
        mediaFailure: true,
        expected: 'light',
      },
    ];

    for (const fixture of fixtures) {
      const document = { documentElement: { dataset: {} } };
      const window = {
        matchMedia() {
          if (fixture.mediaFailure) throw new Error('matchMedia unavailable');
          return { matches: fixture.systemDark };
        },
      };
      if (fixture.storageFailure) {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('localStorage unavailable');
          },
        });
      } else {
        window.localStorage = { getItem: () => fixture.stored };
      }
      const windowKeys = Object.keys(window).sort();

      assert.doesNotThrow(
        () => vm.runInNewContext(source, { document, window }),
        fixture.name,
      );
      assert.equal(document.documentElement.dataset.theme, fixture.expected);
      assert.deepEqual(Object.keys(window).sort(), windowKeys);
    }

    assert.doesNotMatch(source, /DOMContentLoaded|Math\.random|Date\.|nonce|cspNonce/u);
  });

  test('boilerplate loads theme synchronously after GA4 and before CSS', async () => {
    const source = await read('views/layouts/boilerplate.ejs');
    const gtm = source.indexOf("'GTM-TBCRW55F'");
    const ga4 = source.indexOf('window.__GA4_EVENT__');
    const theme = source.indexOf('<script src="/js/theme.js"></script>');
    const css = source.indexOf('<link href="/css/login.css"');

    assert.ok(gtm >= 0);
    assert.ok(ga4 > gtm);
    assert.ok(theme > ga4);
    assert.ok(css > theme);
    assert.doesNotMatch(
      source.match(/<script[^>]+src="\/js\/theme\.js"[^>]*>/u)?.[0] || '',
      /\b(?:async|defer|type\s*=\s*["']module["'])\b/iu,
    );
  });
});

describe('declarative server flash transport', () => {
  test('hostile messages remain escaped data and round-trip with String(array) behavior', async () => {
    const source = await read('views/layouts/boilerplate.ejs');
    const hostile = `quotes " ' < > </script> & ` +
      String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    const messages = {
      success: [hostile, 'second success'],
      info: [`info ${hostile}`],
      warning: [`warning ${hostile}`],
      error: [`error ${hostile}`],
    };
    const html = ejs.render(source, {
      body: '',
      canonicalUrl: null,
      cspNonce: 'known-nonce',
      csrfToken: 'csrf-token',
      currentUser: null,
      data: {},
      ga4EventJson: 'null',
      include: () => '',
      layout: () => {},
      meta: { title: 'Flash transport' },
      ...messages,
    });

    for (const [type, values] of Object.entries(messages)) {
      assert.equal(attributeValue(html, `data-flash-${type}`), String(values));
      for (const body of externalScriptBodies(html)) {
        assert.equal(body.includes(String(values)), false);
      }
    }

    assert.match(html, /&lt;\/script&gt;/u);
    assert.match(html, /&#34;|&#39;/u);
    assert.match(html, /&amp;/u);
    assert.equal(html.includes('<script id="server-xss">'), false);

    const withoutMessages = ejs.render(source, {
      body: '',
      canonicalUrl: null,
      cspNonce: 'known-nonce',
      csrfToken: 'csrf-token',
      currentUser: null,
      data: {},
      error: [],
      ga4EventJson: 'null',
      include: () => '',
      info: [],
      layout: () => {},
      meta: { title: 'No flash' },
      success: [],
      warning: [],
    });
    assert.doesNotMatch(withoutMessages, /data-flash-(?:success|info|warning|error)=/u);
  });

  test('external bootstrap emits populated types once with established metadata', async () => {
    const source = await read('public/js/flash-messages.js');
    const container = new FakeElement('div');
    Object.assign(container.dataset, {
      flashSuccess: 'saved',
      flashInfo: 'heads up',
      flashWarning: 'careful',
      flashError: 'failed',
    });
    const timeouts = [];
    const document = {
      createElement: tagName => new FakeElement(tagName),
      getElementById: id => id === 'flash-messages' ? container : null,
      querySelectorAll: () => [],
    };
    const context = vm.createContext({
      clearInterval() {},
      document,
      setInterval: () => 1,
      setTimeout(_callback, delay) {
        timeouts.push(delay);
        return 1;
      },
    });

    vm.runInContext(source, context);
    assert.equal(typeof context.createFlashMsg, 'function');
    assert.equal(container.children.length, 4);
    assert.deepEqual(
      container.children.map(message => message.getAttribute('data-flash-message')),
      ['success-msg', 'info-msg', 'warning-msg', 'error-msg'],
    );
    assert.deepEqual(
      container.children.map(message => message.children[0].textContent),
      ['saved', 'heads up', 'careful', 'failed'],
    );
    assert.deepEqual(
      container.children.map(message => Number(message.children[1].textContent)),
      [5, 10, 10, 15],
    );
    assert.deepEqual(timeouts, [5_000, 10_000, 10_000, 15_000]);

    vm.runInContext(source, context);
    assert.equal(container.children.length, 4);
    assert.deepEqual(timeouts, [5_000, 10_000, 10_000, 15_000]);
    assert.equal(container.dataset.flashInitialized, 'true');

    const emptyContainer = new FakeElement('div');
    emptyContainer.dataset.flashSuccess = '';
    vm.runInNewContext(source, {
      clearInterval() {},
      document: {
        createElement: tagName => new FakeElement(tagName),
        getElementById: () => emptyContainer,
        querySelectorAll: () => [],
      },
      setInterval: () => 1,
      setTimeout: () => 1,
    });
    assert.equal(emptyContainer.children.length, 0);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/u);
  });
});

describe('external search placeholder behavior', () => {
  async function runSearch(width, input) {
    const source = await read('public/js/general.js');
    const start = source.indexOf('////// SEARCH');
    const end = source.indexOf('////// RESET WIDTH + NAVBAR LOGIC', start);
    assert.ok(start >= 0 && end > start);
    const searchSource = source.slice(start, end);
    const resizeListeners = [];
    const window = {
      innerWidth: width,
      addEventListener(type, listener) {
        if (type === 'resize') resizeListeners.push(listener);
      },
    };
    const document = {
      getElementById(id) {
        if (id === 'search-input-box') return input;
        return null;
      },
    };
    vm.runInNewContext(searchSource, { document, window });
    return { resizeListeners, searchSource, window };
  }

  test('does nothing when the search partial is absent', async () => {
    const result = await runSearch(1_000, null);
    assert.equal(result.resizeListeners.length, 0);
  });

  test('uses the wide and narrow text and updates through one resize listener', async () => {
    const wideInput = { placeholder: '' };
    const wide = await runSearch(1_000, wideInput);
    assert.equal(
      wideInput.placeholder,
      'Search for a national or provincial park.',
    );
    assert.equal(wide.resizeListeners.length, 1);

    const narrowInput = { placeholder: '' };
    const narrow = await runSearch(775, narrowInput);
    assert.equal(narrowInput.placeholder, 'Search for a park.');
    assert.equal(narrow.resizeListeners.length, 1);
    narrow.window.innerWidth = 776;
    narrow.resizeListeners[0]();
    assert.equal(
      narrowInput.placeholder,
      'Search for a national or provincial park.',
    );

    const partial = await read('views/partials/search.ejs');
    assert.doesNotMatch(partial, /<script\b/iu);
  });
});

describe('external forgot-password binding', () => {
  test('binds the exact three elements once through the shared API', async () => {
    const source = await read('public/js/forgotPassword.js');
    const form = { dataset: {} };
    const passwordInput = {};
    const confirmationInput = {};
    const elements = new Map([
      ['resetForm', form],
      ['new_password', passwordInput],
      ['new_password_repeat', confirmationInput],
    ]);
    const calls = [];
    const context = vm.createContext({
      document: { getElementById: id => elements.get(id) || null },
      window: {
        CampPicsPasswordPolicy: {
          bindPasswordForm(options) {
            calls.push(options);
          },
        },
      },
    });

    vm.runInContext(source, context);
    vm.runInContext(source, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].form, form);
    assert.equal(calls[0].passwordInput, passwordInput);
    assert.equal(calls[0].confirmationInput, confirmationInput);
    assert.equal(form.dataset.passwordPolicyBound, 'true');
  });

  test('missing elements or policy safely do nothing and rules are not duplicated', async () => {
    const source = await read('public/js/forgotPassword.js');
    const complete = {
      resetForm: { dataset: {} },
      new_password: {},
      new_password_repeat: {},
    };
    for (const missing of [
      'resetForm',
      'new_password',
      'new_password_repeat',
      'policy',
    ]) {
      let bindCalls = 0;
      assert.doesNotThrow(() => vm.runInNewContext(source, {
        document: {
          getElementById(id) {
            return id === missing ? null : complete[id] || null;
          },
        },
        window: missing === 'policy'
          ? {}
          : {
              CampPicsPasswordPolicy: {
                bindPasswordForm() {
                  bindCalls += 1;
                },
              },
            },
      }));
      assert.equal(bindCalls, 0);
    }
    assert.doesNotMatch(
      source,
      /setCustomValidity|POLICY_MESSAGE|CONFIRMATION_MESSAGE|\[A-Z\]|\[a-z\]|\\d|length\s*[<>]=?/u,
    );

    const template = await read('views/user/forgotPassword.ejs');
    const formEnd = template.indexOf('</form>');
    const script = template.indexOf('<script src="/js/forgotPassword.js"></script>');
    assert.ok(formEnd >= 0 && script > formEnd);
    assert.doesNotMatch(template, /<script\b(?![^>]*\bsrc\s*=)/iu);
  });
});

function createAdminHarness({
  uploadPage = '1',
  userPage = '1',
  uploadPayload = { uploads: [], hasMoreUploads: true },
  userPayload = { users: [], hasMoreUsers: true },
} = {}) {
  const state = new FakeElement('div');
  Object.assign(state.dataset, { uploadPage, userPage });
  const uploads = new FakeElement('div');
  const users = new FakeElement('div');
  const uploadButton = new FakeElement('button');
  const userButton = new FakeElement('button');
  const elements = new Map([
    ['admin-dashboard-state', state],
    ['uploads', uploads],
    ['users', users],
    ['loadMoreUploads', uploadButton],
    ['loadMoreUsers', userButton],
  ]);
  const documentListeners = new Map();
  const document = {
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    createElement: tagName => new FakeElement(tagName),
    createTextNode(value) {
      const text = new FakeElement('#text');
      text.textContent = String(value);
      return text;
    },
    getElementById: id => elements.get(id) || null,
  };
  const fetchCalls = [];
  const mediaCalls = {
    images: [],
    photoUrls: [],
    youtubeValues: [],
  };
  const confirmCalls = [];
  let confirmResult = true;
  const window = {
    CampPicsCsrf: { getToken: () => 'page-csrf-token' },
    CampPicsMedia: {
      createImageElement(options) {
        mediaCalls.images.push(options);
        const image = new FakeElement('img');
        Object.assign(image, options);
        return image;
      },
      extractYouTubeId(value) {
        mediaCalls.youtubeValues.push(value);
        return value === 'https://youtu.be/abc123DEF45'
          ? 'abc123DEF45'
          : null;
      },
      getSafeHttpUrl(value) {
        mediaCalls.photoUrls.push(value);
        return typeof value === 'string' && value.startsWith('https://')
          ? value
          : null;
      },
    },
    confirm(message) {
      confirmCalls.push(message);
      return confirmResult;
    },
  };
  const context = vm.createContext({
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        json: async () => url.includes('uploadPage')
          ? uploadPayload
          : userPayload,
      };
    },
    window,
  });

  return {
    confirmCalls,
    context,
    documentListeners,
    fetchCalls,
    mediaCalls,
    setConfirmResult(value) {
      confirmResult = value;
    },
    uploadButton,
    uploads,
    userButton,
    users,
    window,
  };
}

describe('external administrator dashboard behavior', () => {
  test('strict page state drives unchanged pagination requests with safe fallback', async () => {
    const source = await read('public/js/adminDashboard.js');
    for (const fixture of [
      {
        uploadPage: '4',
        userPage: '8',
        urls: [
          '/a/dashboard?uploadPage=5',
          '/a/dashboard?userPage=9',
        ],
      },
      {
        uploadPage: '01',
        userPage: 'not-a-page',
        urls: [
          '/a/dashboard?uploadPage=2',
          '/a/dashboard?userPage=2',
        ],
      },
      ...[
        ['0', '-1'],
        ['1.5', ' 2'],
        ['9007199254740992', '2e3'],
      ].map(([uploadPage, userPage]) => ({
        uploadPage,
        userPage,
        urls: [
          '/a/dashboard?uploadPage=2',
          '/a/dashboard?userPage=2',
        ],
      })),
    ]) {
      const harness = createAdminHarness(fixture);
      vm.runInContext(source, harness.context);
      await harness.uploadButton.listeners.get('click')[0]();
      await harness.userButton.listeners.get('click')[0]();

      assert.deepEqual(
        harness.fetchCalls.map(call => call.url),
        fixture.urls,
      );
      for (const call of harness.fetchCalls) {
        assert.deepEqual(
          JSON.parse(JSON.stringify(call.options.headers)),
          { Accept: 'application/json' },
        );
      }
    }
  });

  test('constructs safe media and user rows with CSRF controls and confirmations', async () => {
    const source = await read('public/js/adminDashboard.js');
    const unsafe = '<img src=x onerror=alert(1)></div><script>attack()</script>';
    const photoUrl = 'https://cdn.example.test/photo.jpg';
    const harness = createAdminHarness({
      uploadPayload: {
        uploads: [
          {
            adminPhotoUrl: photoUrl,
            campgroundName: unsafe,
            campsiteName: unsafe,
            createdAt: '2026-08-01T00:00:00.000Z',
            mediaType: 'photo',
            parkName: unsafe,
            uploader: { fname: unsafe, username: unsafe },
          },
          {
            adminPhotoUrl: null,
            campgroundName: null,
            campsiteName: null,
            createdAt: '2026-08-01T00:00:00.000Z',
            mediaType: 'video',
            parkName: 'Video Park',
            uploader: { fname: 'Viewer', username: 'viewer@example.test' },
            youtubeId: 'https://youtu.be/abc123DEF45',
          },
        ],
        hasMoreUploads: false,
      },
      userPayload: {
        users: [
          {
            _id: 'user/id',
            blocked: false,
            date_created: '2026-01-02T00:00:00.000Z',
            email_verified: false,
            fname: unsafe,
            username: unsafe,
          },
          {
            _id: 'blocked-user',
            blocked: true,
            date_created: '2026-01-03T00:00:00.000Z',
            email_verified: true,
            fname: 'Blocked',
            username: 'blocked@example.test',
          },
        ],
        hasMoreUsers: false,
      },
    });
    const initialWindowKeys = Object.keys(harness.window).sort();

    vm.runInContext(source, harness.context);
    await harness.uploadButton.listeners.get('click')[0]();
    await harness.userButton.listeners.get('click')[0]();

    assert.deepEqual(Object.keys(harness.window).sort(), initialWindowKeys);
    assert.equal(harness.uploads.children.length, 2);
    assert.equal(harness.users.children.length, 2);
    assert.equal(combinedText(harness.uploads.children[0]).includes(unsafe), true);
    assert.equal(combinedText(harness.users.children[0]).includes(unsafe), true);
    assert.deepEqual(harness.mediaCalls.photoUrls, [photoUrl]);
    assert.deepEqual(
      harness.mediaCalls.youtubeValues,
      ['https://youtu.be/abc123DEF45'],
    );
    assert.deepEqual(
      harness.mediaCalls.images.map(image => image.src),
      [
        photoUrl,
        'https://img.youtube.com/vi/abc123DEF45/hqdefault.jpg',
      ],
    );
    assert.equal(harness.uploadButton.removed, true);
    assert.equal(harness.userButton.removed, true);

    const forms = harness.users.children.flatMap(row =>
      findAll(row, element => element.tagName === 'FORM'));
    assert.equal(forms.length, 2);
    assert.deepEqual(
      forms.map(form => form.action),
      [
        '/a/user/user%2Fid/block',
        '/a/user/blocked-user/unblock',
      ],
    );
    assert.deepEqual(
      forms.map(form => form.dataset.action),
      ['block', 'unblock'],
    );
    assert.deepEqual(
      forms.map(form => findAll(
        form,
        element => element.tagName === 'INPUT',
      )[0].value),
      ['page-csrf-token', 'page-csrf-token'],
    );
    assert.deepEqual(
      forms.map(form => findAll(
        form,
        element => element.tagName === 'BUTTON',
      )[0].className),
      ['block-btn', 'unblock-btn'],
    );

    const submit = harness.documentListeners.get('submit')[0];
    let prevented = 0;
    harness.setConfirmResult(false);
    submit({ target: forms[0], preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1);
    harness.setConfirmResult(true);
    submit({ target: forms[1], preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1);
    assert.deepEqual(harness.confirmCalls, [
      'Block this user?',
      'Unblock this user?',
    ]);

    assert.doesNotMatch(
      source,
      /innerHTML|outerHTML|insertAdjacentHTML|\bon[a-z]+\s*=/iu,
    );
    assert.match(source, /^\(function initializeAdminDashboard\(\)/u);
  });

  test('template transports escaped non-executable state and preserves script order', async () => {
    const template = await read('views/admin/dashboard.ejs');
    const boilerplate = await read('views/layouts/boilerplate.ejs');
    const html = ejs.render(template, {
      extractYouTubeVideoId: () => null,
      hasMoreUploads: false,
      hasMoreUsers: false,
      include: () => '',
      layout: () => {},
      uploadPage: '2&quot; data-attack=&quot;yes',
      uploads: [],
      userPage: '<script>attack()</script>',
      users: [],
    });

    assert.match(html, /id="admin-dashboard-state"/u);
    assert.match(html, /data-upload-page="2&amp;quot; data-attack=&amp;quot;yes"/u);
    assert.match(html, /data-user-page="&lt;script&gt;attack\(\)&lt;\/script&gt;"/u);
    assert.ok(
      html.indexOf('/js/mediaRendering.js') <
        html.indexOf('/js/adminDashboard.js'),
    );
    assert.equal(externalScriptBodies(html).length, 0);

    const fullPage = ejs.render(boilerplate, {
      body: html,
      canonicalUrl: null,
      cspNonce: 'known-nonce',
      csrfToken: 'csrf-token',
      currentUser: null,
      data: {},
      error: [],
      ga4EventJson: 'null',
      include: () => '',
      info: [],
      layout: () => {},
      meta: { title: 'Administrator' },
      success: [],
      warning: [],
    });
    assert.ok(
      fullPage.indexOf('/js/csrf.js') <
        fullPage.indexOf('/js/adminDashboard.js'),
    );
  });
});

describe('CSP and scope regression guards for externalization', () => {
  test('the four retained bootstrap contracts remain exact and nonced', async () => {
    const boilerplate = await read('views/layouts/boilerplate.ejs');
    const showPark = await read('views/parks/showPark.ejs');
    const allParks = await read('views/parks/allParks.ejs');
    const retained = [
      boilerplate.match(/<script nonce="<%= cspNonce %>">\(function\(w,d,s,l,i\)[\s\S]*?<\/script>/u)?.[0],
      boilerplate.match(/<script nonce="<%= cspNonce %>">\s*window\.__GA4_EVENT__ = <%- ga4EventJson %>;\s*<\/script>/u)?.[0],
      showPark.match(/<script nonce="<%= cspNonce %>">[\s\S]*?window\.PARK[\s\S]*?<\/script>/u)?.[0],
      allParks.match(/<script nonce="<%= cspNonce %>">[\s\S]*?window\.ALL_PARKS[\s\S]*?<\/script>/u)?.[0],
    ];

    assert.equal(retained.every(Boolean), true);
    assert.match(retained[0], /GTM-TBCRW55F/u);
    assert.match(retained[1], /window\.__GA4_EVENT__ = <%- ga4EventJson %>/u);
    assert.match(retained[2], /window\.PARK = <%- parkPageJson %>/u);
    assert.match(retained[2], /window\.CURRENT_USER_ID/u);
    assert.match(retained[2], /window\.CURRENT_USER_IS_ADMIN/u);
    assert.match(retained[2], /window\.CURRENT_USER_EMAIL_VERIFIED/u);
    assert.match(retained[3], /window\.ALL_PARKS = <%- parksJson %>/u);
  });

  test('protected files outside ordinary logout, dependencies, CSP wiring, and engine policy remain unchanged', async () => {
    const protectedStatus = execFileSync('git', [
      'status',
      '--short',
      '--',
      'app.js',
      'controllers',
      'middleware.js',
      'models',
      'package.json',
      'package-lock.json',
      'routes',
      'utils/cspNonce.js',
      'utils/serializeForInlineScript.js',
      'public/js/csrf.js',
      'public/js/passwordPolicy.js',
    ], { cwd: root, encoding: 'utf8' });
    const ordinaryLogoutFiles = new Set([
      'controllers/users.js',
      'routes/users.js',
    ]);
    const unexpectedProtectedChanges = protectedStatus
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter(line => !ordinaryLogoutFiles.has(
        line.slice(3).replaceAll('\\', '/'),
      ));
    assert.deepEqual(unexpectedProtectedChanges, []);

    const packageJson = JSON.parse(await read('package.json'));
    assert.deepEqual(packageJson.engines, {
      node: '24.x',
      npm: '11.x',
    });

    const app = await read('app.js');
    const scriptDirective = app.match(/scriptSrc:\s*\[([^\]]+)\]/u)?.[1];
    const styleDirective = app.match(/styleSrc:\s*\[([^\]]+)\]/u)?.[1];
    assert.match(scriptDirective, /"'self'"/u);
    assert.match(scriptDirective, /cspNonceSource/u);
    assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval|\*/u);
    assert.match(styleDirective, /"'unsafe-inline'"/u);
    assert.match(app, /scriptSrcAttr:\s*\["'none'"\]/u);
  });
});
