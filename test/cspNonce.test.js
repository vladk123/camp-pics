import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import express from 'express';
import helmet from 'helmet';

import {
  CSP_NONCE_BYTE_LENGTH,
  createCspNonceMiddleware,
  cspNonceSource,
} from '../utils/cspNonce.js';

const APPROVED_SCRIPT_SOURCES = [
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
];

const EXPECTED_NON_CSP_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security':
    'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'DENY',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
};

function invokeMiddleware(middleware, req = {}, locals = {}) {
  const res = { locals };
  const nextArguments = [];
  middleware(req, res, (...args) => {
    nextArguments.push(args);
  });
  return { nextArguments, req, res };
}

function parseCspHeader(header) {
  const directives = new Map();

  for (const rawDirective of header.split(';')) {
    const directive = rawDirective.trim();
    if (!directive) throw new Error('CSP contains an empty directive name.');

    const [rawName, ...values] = directive.split(/\s+/u);
    const name = rawName.toLowerCase();
    if (!name) throw new Error('CSP contains an empty directive name.');
    if (directives.has(name)) {
      throw new Error(`CSP contains duplicate directive ${name}.`);
    }

    directives.set(name, values);
  }

  return directives;
}

function expectedCspDirectives(nonce) {
  return new Map([
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['font-src', ["'self'", 'https://cdnjs.cloudflare.com']],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'self'"]],
    ['img-src', [
      "'self'",
      'data:',
      'blob:',
      'https://res.cloudinary.com/example/',
      'https://img.youtube.com',
      'https://www.googletagmanager.com',
    ]],
    ['object-src', []],
    ['script-src', [
      "'self'",
      `'nonce-${nonce}'`,
      ...APPROVED_SCRIPT_SOURCES,
    ]],
    ['script-src-attr', ["'none'"]],
    ['style-src', [
      "'self'",
      "'unsafe-inline'",
      'https://cdnjs.cloudflare.com',
      'https://fonts.googleapis.com',
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com',
    ]],
    ['upgrade-insecure-requests', []],
    ['connect-src', [
      "'self'",
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com',
    ]],
    ['worker-src', ["'self'"]],
    ['frame-src', ["'self'", 'https://www.youtube.com']],
  ]);
}

function assertExactCspContract(header, nonce) {
  const actual = parseCspHeader(header);
  const expected = expectedCspDirectives(nonce);

  assert.deepEqual(
    [...actual.keys()].sort(),
    [...expected.keys()].sort(),
    'CSP directive names should match without depending on top-level order',
  );
  for (const [name, values] of expected) {
    assert.deepEqual(
      actual.get(name),
      values,
      `${name} should preserve its exact value-token order`,
    );
  }

  return actual;
}

async function withServer(app, callback) {
  const server = await new Promise(resolve => {
    const listeningServer = app.listen(
      0,
      '127.0.0.1',
      () => resolve(listeningServer),
    );
  });
  const { port } = server.address();

  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

describe('per-response CSP nonce middleware', () => {
  test('requests 16 secure bytes, preserves request state and locals, and calls next once', () => {
    const requestedLengths = [];
    const expectedBytes = Buffer.alloc(CSP_NONCE_BYTE_LENGTH, 0xab);
    const middleware = createCspNonceMiddleware({
      randomBytes(length) {
        requestedLengths.push(length);
        return expectedBytes;
      },
    });
    const session = { marker: 'existing-session-value' };
    const req = { marker: 'existing-request-value', session };
    const locals = { marker: 'existing-local-value' };
    const originalRequest = { ...req };
    const originalSession = { ...session };

    const result = invokeMiddleware(middleware, req, locals);

    assert.deepEqual(requestedLengths, [CSP_NONCE_BYTE_LENGTH]);
    assert.ok(requestedLengths[0] >= 16);
    assert.equal(result.res.locals.cspNonce, expectedBytes.toString('base64'));
    assert.equal(result.res.locals.marker, 'existing-local-value');
    assert.deepEqual(result.nextArguments, [[]]);
    assert.deepEqual(req, originalRequest);
    assert.deepEqual(session, originalSession);
    assert.equal(Buffer.isBuffer(result.res.locals.cspNonce), false);
  });

  test('generation failure forwards the error once without assigning a nonce', () => {
    const failure = new Error('deterministic secure-random failure');
    const locals = { marker: 'preserved' };
    const result = invokeMiddleware(createCspNonceMiddleware({
      randomBytes() {
        throw failure;
      },
    }), { session: { marker: true } }, locals);

    assert.equal(result.nextArguments.length, 1);
    assert.deepEqual(result.nextArguments[0], [failure]);
    assert.equal('cspNonce' in result.res.locals, false);
    assert.deepEqual(result.res.locals, { marker: 'preserved' });
  });

  test('a successful generation calls a throwing downstream next only once', () => {
    const downstreamFailure = new Error('deterministic downstream failure');
    const middleware = createCspNonceMiddleware({
      randomBytes: length => Buffer.alloc(length, 0xcd),
    });
    let nextCalls = 0;

    assert.throws(
      () => middleware({}, { locals: {} }, () => {
        nextCalls += 1;
        throw downstreamFailure;
      }),
      error => error === downstreamFailure,
    );
    assert.equal(nextCalls, 1);
  });

  test('production secure-random generation creates a new Base64 nonce per request', () => {
    const middleware = createCspNonceMiddleware();
    const first = invokeMiddleware(middleware).res.locals.cspNonce;
    const second = invokeMiddleware(middleware).res.locals.cspNonce;

    assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.match(second, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.notEqual(first, second);
    assert.equal(Buffer.from(first, 'base64').length, CSP_NONCE_BYTE_LENGTH);
    assert.equal(Buffer.from(second, 'base64').length, CSP_NONCE_BYTE_LENGTH);
  });

  test('nonce construction uses neither Math.random nor time-based values', async () => {
    const source = await readFile('utils/cspNonce.js', 'utf8');

    assert.match(source, /node:crypto/u);
    assert.doesNotMatch(source, /Math\.random|Date\.now|new Date/u);
  });
});

describe('Helmet CSP nonce integration', () => {
  test('the semantic CSP parser preserves values and rejects invalid names or duplicates', () => {
    assert.deepEqual(
      [...parseCspHeader("SCRIPT-SRC 'self' https://example.test; object-src")],
      [
        ['script-src', ["'self'", 'https://example.test']],
        ['object-src', []],
      ],
    );
    assert.throws(
      () => parseCspHeader("default-src 'self'; ;script-src 'self'"),
      /empty directive name/u,
    );
    assert.throws(
      () => parseCspHeader("default-src 'self';DEFAULT-SRC https:"),
      /duplicate directive default-src/u,
    );
  });

  test('each response header authorizes only its own nonce and keeps the Phase 1 policy', async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(createCspNonceMiddleware());
    app.use(helmet({
      crossOriginEmbedderPolicy: false,
      xPoweredBy: false,
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      noCache: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: [
            "'self'",
            'https://www.googletagmanager.com',
            'https://www.google-analytics.com',
          ],
          scriptSrc: ["'self'", cspNonceSource, ...APPROVED_SCRIPT_SOURCES],
          scriptSrcAttr: ["'none'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://cdnjs.cloudflare.com',
            'https://fonts.googleapis.com',
            'https://www.googletagmanager.com',
            'https://www.google-analytics.com',
          ],
          workerSrc: ["'self'"],
          objectSrc: [],
          imgSrc: [
            "'self'",
            'data:',
            'blob:',
            'https://res.cloudinary.com/example/',
            'https://img.youtube.com',
            'https://www.googletagmanager.com',
          ],
          fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
          frameAncestors: ["'self'"],
          frameSrc: ["'self'", 'https://www.youtube.com'],
          upgradeInsecureRequests: [],
        },
      },
    }));
    app.get('/', (_req, res) => {
      res.json({ nonce: res.locals.cspNonce });
    });

    await withServer(app, async baseUrl => {
      const firstResponse = await fetch(baseUrl);
      const firstBody = await firstResponse.json();
      const firstHeader = firstResponse.headers.get('content-security-policy');
      const secondResponse = await fetch(baseUrl);
      const secondBody = await secondResponse.json();
      const secondHeader = secondResponse.headers.get('content-security-policy');

      assert.ok(firstHeader);
      assert.ok(secondHeader);
      assert.notEqual(firstBody.nonce, secondBody.nonce);

      for (const [response, header, nonce] of [
        [firstResponse, firstHeader, firstBody.nonce],
        [secondResponse, secondHeader, secondBody.nonce],
      ]) {
        const directives = assertExactCspContract(header, nonce);
        const scriptSrc = directives.get('script-src');
        const styleSrc = directives.get('style-src');

        assert.equal(scriptSrc.includes("'unsafe-inline'"), false);
        assert.equal(scriptSrc.includes("'unsafe-eval'"), false);
        assert.ok(styleSrc.includes("'unsafe-inline'"));
        for (const [name, expectedValue] of Object.entries(
          EXPECTED_NON_CSP_HEADERS,
        )) {
          assert.equal(response.headers.get(name), expectedValue, name);
        }
        assert.equal(response.headers.get('cross-origin-embedder-policy'), null);
        assert.equal(response.headers.get('x-powered-by'), null);
      }

      assert.equal(
        firstHeader.includes(`'nonce-${secondBody.nonce}'`),
        false,
      );
      assert.equal(
        secondHeader.includes(`'nonce-${firstBody.nonce}'`),
        false,
      );
    });
  });
});
