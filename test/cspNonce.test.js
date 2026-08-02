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

function invokeMiddleware(middleware, req = {}, locals = {}) {
  const res = { locals };
  const nextArguments = [];
  middleware(req, res, (...args) => {
    nextArguments.push(args);
  });
  return { nextArguments, req, res };
}

function getDirective(header, name) {
  return header
    .split(';')
    .map(value => value.trim())
    .find(value => value === name || value.startsWith(`${name} `));
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
  test('each response header authorizes only its own nonce and keeps the Phase 1 policy', async () => {
    const app = express();
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

      for (const [header, nonce] of [
        [firstHeader, firstBody.nonce],
        [secondHeader, secondBody.nonce],
      ]) {
        const scriptSrc = getDirective(header, 'script-src');
        const styleSrc = getDirective(header, 'style-src');

        assert.ok(scriptSrc.split(/\s+/u).includes("'self'"));
        assert.ok(scriptSrc.split(/\s+/u).includes(`'nonce-${nonce}'`));
        for (const source of APPROVED_SCRIPT_SOURCES) {
          assert.ok(scriptSrc.split(/\s+/u).includes(source));
        }
        assert.equal(scriptSrc.includes("'unsafe-inline'"), false);
        assert.equal(scriptSrc.includes("'unsafe-eval'"), false);
        assert.ok(styleSrc.split(/\s+/u).includes("'unsafe-inline'"));
        assert.equal(getDirective(header, 'script-src-attr'), "script-src-attr 'none'");
      }

      assert.equal(
        secondHeader.includes(`'nonce-${firstBody.nonce}'`),
        false,
      );
    });
  });
});
