import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import FormData from 'form-data';
import multer from 'multer';

import { createMediaHandlers } from '../controllers/media.js';
import { uploadMemory } from '../middleware.js';

const EXPECTED_LIMITS = {
  fileSize: 10 * 1024 * 1024,
  files: 5,
  fields: 4,
  parts: 10,
  fieldNestingDepth: 0,
};

const VALID_FIELDS = [
  ['_csrf', 'csrf-token'],
  ['caption', 'Flat caption'],
  ['dateTaken', '2026-01-01'],
  ['showUsername', 'true'],
];

function multipartRequest({
  fields = [],
  fileCount = 0,
  ignoredPartCount = 0,
} = {}) {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  for (let index = 0; index < fileCount; index += 1) {
    form.append('photos', Buffer.from(`tiny-photo-${index}`), {
      contentType: 'image/png',
      filename: `photo-${index}.png`,
    });
  }

  const boundary = form.getBoundary();
  const closingBoundary = Buffer.from(`--${boundary}--\r\n`);
  let body = form.getBuffer();
  for (let index = 0; index < ignoredPartCount; index += 1) {
    const closingIndex = body.lastIndexOf(closingBoundary);
    assert.ok(closingIndex >= 0);
    const ignoredPart = Buffer.from(
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nignored-${index}\r\n`,
    );
    body = Buffer.concat([
      body.subarray(0, closingIndex),
      ignoredPart,
      closingBoundary,
    ]);
  }
  const req = Readable.from([body]);
  req.headers = {
    ...form.getHeaders(),
    'content-length': String(body.length),
  };
  req.method = 'POST';
  req.params = { parkSlug: 'multipart-test-park' };
  req.user = { _id: 'multipart-test-user', fname: 'Camper' };
  req.is = type => type === 'multipart/form-data';
  return {
    body,
    partCount: fields.length + fileCount + ignoredPartCount,
    req,
  };
}

function parseWithRealMulter(req) {
  return new Promise((resolve, reject) => {
    uploadMemory.array('photos', 5)(req, {}, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function controllerHarness(uploadMiddleware = uploadMemory) {
  const calls = {
    cloudinary: 0,
    imageValidation: 0,
    parkLookup: 0,
    persistence: 0,
  };
  const handlers = createMediaHandlers({
    ParkModel: {
      async findOne() {
        calls.parkLookup += 1;
        throw new Error('Park lookup must not start after a multipart error');
      },
    },
    cloudinaryClient: {
      uploader: {
        upload_stream() {
          calls.cloudinary += 1;
          throw new Error('Cloudinary must not start after a multipart error');
        },
      },
    },
    uploadMiddleware,
    async validateImage() {
      calls.imageValidation += 1;
      return { valid: true };
    },
    mediaPersistence: {
      async commitMediaCreation() {
        calls.persistence += 1;
        throw new Error('Persistence must not start after a multipart error');
      },
    },
    mediaDeletion: {},
    mediaCleanupJobs: {},
  });
  return { calls, handler: handlers.uploadPhoto };
}

async function invokePhotoController(req, uploadMiddleware = uploadMemory) {
  const { calls, handler } = controllerHarness(uploadMiddleware);
  const res = responseRecorder();
  let nextError;
  await handler(req, res, error => {
    nextError = error;
  });
  assert.equal(nextError, undefined);
  return { calls, res };
}

function erroringUpload(code) {
  return {
    array() {
      return (req, res, callback) => {
        callback(new multer.MulterError(code, 'attacker-controlled-field'));
      };
    },
  };
}

function extractPhotoForm(source, marker) {
  const formPattern = new RegExp(
    `<form\\b[^>]*${marker}[^>]*>[\\s\\S]*?<\\/form>`,
    'u',
  );
  const form = source.match(formPattern)?.[0];
  assert.ok(form, `Missing photo form matching ${marker}`);
  return form;
}

describe('bounded real Multer photo parsing', () => {
  test('uses the exact immutable memory-upload limits', () => {
    assert.deepEqual(uploadMemory.limits, EXPECTED_LIMITS);
    assert.equal(Object.isFrozen(uploadMemory.limits), true);
    assert.equal(uploadMemory.storage.constructor.name, 'MemoryStorage');
  });

  test('parses the valid flat contract into memory buffers only', async () => {
    const { req } = multipartRequest({ fields: VALID_FIELDS, fileCount: 1 });

    await parseWithRealMulter(req);

    assert.deepEqual({ ...req.body }, Object.fromEntries(VALID_FIELDS));
    assert.equal(req.files.length, 1);
    assert.equal(Buffer.isBuffer(req.files[0].buffer), true);
    assert.equal(req.files[0].buffer.toString(), 'tiny-photo-0');
    assert.equal(Object.hasOwn(req.files[0], 'path'), false);
  });

  test('accepts exactly four fields plus five files as nine parts', async () => {
    const { partCount, req } = multipartRequest({
      fields: VALID_FIELDS,
      fileCount: 5,
    });

    await parseWithRealMulter(req);

    assert.equal(partCount, 9);
    assert.equal(Object.keys(req.body).length, 4);
    assert.equal(req.files.length, 5);
    assert.ok(req.files.every(file => Buffer.isBuffer(file.buffer)));
    assert.ok(req.files.every(file => !Object.hasOwn(file, 'path')));
  });

  test('rejects a tenth multipart part with LIMIT_PART_COUNT', async () => {
    const { partCount, req } = multipartRequest({
      fields: VALID_FIELDS,
      fileCount: 5,
      ignoredPartCount: 1,
    });

    assert.equal(partCount, 10);
    await assert.rejects(
      parseWithRealMulter(req),
      error => error.code === 'LIMIT_PART_COUNT',
    );

    const { calls, res } = await invokePhotoController(
      multipartRequest({
        fields: VALID_FIELDS,
        fileCount: 5,
        ignoredPartCount: 1,
      }).req,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: 'UPLOAD_ERROR',
      message: 'The upload form could not be processed.',
    });
    assert.deepEqual(calls, {
      cloudinary: 0,
      imageValidation: 0,
      parkLookup: 0,
      persistence: 0,
    });
  });

  test('rejects bracket nesting before adding the nested value', async () => {
    const { req } = multipartRequest({
      fields: [['caption[nested]', 'must-not-be-added']],
    });

    await assert.rejects(
      parseWithRealMulter(req),
      error => error.code === 'LIMIT_FIELD_NESTING',
    );
    assert.equal(Object.hasOwn(req.body, 'caption'), false);
    assert.equal(Object.hasOwn(req.body, 'caption[nested]'), false);
  });

  test('returns only the generic bounded response for nested fields', async () => {
    const rawFieldName = 'caption[nested]';
    const { req } = multipartRequest({
      fields: [[rawFieldName, 'must-not-be-added']],
    });

    const { calls, res } = await invokePhotoController(req);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: 'UPLOAD_ERROR',
      message: 'The upload form could not be processed.',
    });
    assert.equal(JSON.stringify(res.body).includes(rawFieldName), false);
    assert.deepEqual(calls, {
      cloudinary: 0,
      imageValidation: 0,
      parkLookup: 0,
      persistence: 0,
    });
  });

  test('rejects a fifth non-file field and keeps its response content-free', async () => {
    const fields = [...VALID_FIELDS, ['extraField', 'must-not-be-added']];
    const parserRequest = multipartRequest({ fields }).req;
    await assert.rejects(
      parseWithRealMulter(parserRequest),
      error => error.code === 'LIMIT_FIELD_COUNT',
    );

    const rawFieldName = 'extraField';
    const { calls, res } = await invokePhotoController(
      multipartRequest({ fields }).req,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: 'UPLOAD_ERROR',
      message: 'The upload form could not be processed.',
    });
    assert.equal(JSON.stringify(res.body).includes(rawFieldName), false);
    assert.deepEqual(calls, {
      cloudinary: 0,
      imageValidation: 0,
      parkLookup: 0,
      persistence: 0,
    });
  });

  test('rejects six photo parts and preserves the too-many-files response', async () => {
    const parserRequest = multipartRequest({ fileCount: 6 }).req;
    await assert.rejects(
      parseWithRealMulter(parserRequest),
      error => [
        'LIMIT_FILE_COUNT',
        'LIMIT_UNEXPECTED_FILE',
      ].includes(error.code),
    );

    const { calls, res } = await invokePhotoController(
      multipartRequest({ fileCount: 6 }).req,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: 'Too many files uploaded.',
      message: 'Too many files uploaded.',
    });
    assert.deepEqual(calls, {
      cloudinary: 0,
      imageValidation: 0,
      parkLookup: 0,
      persistence: 0,
    });
  });

  for (const code of ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE']) {
    test(`${code} maps to the existing too-many-files response`, async () => {
      const { res } = await invokePhotoController(
        multipartRequest().req,
        erroringUpload(code),
      );
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, {
        error: 'Too many files uploaded.',
        message: 'Too many files uploaded.',
      });
    });
  }

  test('keeps the 10 MB LIMIT_FILE_SIZE response unchanged', async () => {
    assert.equal(uploadMemory.limits.fileSize, 10 * 1024 * 1024);
    const { res } = await invokePhotoController(
      multipartRequest().req,
      erroringUpload('LIMIT_FILE_SIZE'),
    );
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.body, {
      error: 'Each file must be under 10MB.',
      message: 'Each file must be under 10MB.',
    });
  });
});

describe('CampPics photo multipart source contracts', () => {
  test('both photo forms expose only four flat fields and photos files', async () => {
    const [parkTemplate, campsiteTemplate, csrfPartial] = await Promise.all([
      readFile('views/partials/modals/parkMediaUpload.ejs', 'utf8'),
      readFile('views/partials/modals/campsiteModalContent.ejs', 'utf8'),
      readFile('views/partials/csrfField.ejs', 'utf8'),
    ]);
    const csrfNames = [...csrfPartial.matchAll(/\bname=["']([^"']+)["']/gu)]
      .map(match => match[1]);
    assert.deepEqual(csrfNames, ['_csrf']);

    for (const [label, form] of [
      ['park', extractPhotoForm(parkTemplate, 'id="park-photo-form"')],
      [
        'campsite',
        extractPhotoForm(campsiteTemplate, 'class="[^"]*campsite-photo-form[^"]*"'),
      ],
    ]) {
      const inputNames = [...form.matchAll(/\bname=["']([^"']+)["']/gu)]
        .map(match => match[1]);
      const fileNames = [...form.matchAll(
        /<input\b[^>]*\btype=["']file["'][^>]*\bname=["']([^"']+)["'][^>]*>/gu,
      )].map(match => match[1]);
      const nonFileNames = [...csrfNames, ...inputNames.filter(
        name => !fileNames.includes(name),
      )].sort();

      assert.deepEqual(
        nonFileNames,
        ['_csrf', 'caption', 'dateTaken', 'showUsername'],
        `${label} photo form changed its non-file multipart fields`,
      );
      assert.deepEqual(
        fileNames,
        ['photos'],
        `${label} photo form changed its file field`,
      );
      assert.equal(
        [...nonFileNames, ...fileNames].some(name => name.includes('[')),
        false,
        `${label} photo form introduced bracket nesting`,
      );
      assert.equal(
        (form.match(/include\(['"]\.\.\/csrfField['"]\)/gu) || []).length,
        1,
        `${label} photo form must include one CSRF field`,
      );
    }
  });

  test('controller parsing remains bounded and does not expose Multer details', async () => {
    const source = await readFile('controllers/media.js', 'utf8');
    const parsingStart = source.indexOf('// Phase A: request parsing');
    const parsingEnd = source.indexOf('// Fields and files are now accessible');
    assert.ok(parsingStart >= 0);
    assert.ok(parsingEnd > parsingStart);
    const parsingSource = source.slice(parsingStart, parsingEnd);

    assert.match(parsingSource, /uploadMiddleware\.array\('photos', 5\)/u);
    assert.match(parsingSource, /err\.code === "LIMIT_FILE_COUNT"/u);
    assert.match(parsingSource, /err\.code === "LIMIT_UNEXPECTED_FILE"/u);
    assert.doesNotMatch(parsingSource, /err\.(?:message|field|stack)/u);
    assert.doesNotMatch(parsingSource, /console\.(?:error|log|warn)/u);
    assert.doesNotMatch(parsingSource, /json\(err\)/u);
  });
});
