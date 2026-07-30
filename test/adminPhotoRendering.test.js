import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
  getAdminPhotoUrl,
  serializeAdminUpload,
} from '../controllers/admin.js';

describe('administrator photo URL compatibility', () => {
  test('prefers the new URL and preserves legacy URL-valued records', () => {
    assert.equal(
      getAdminPhotoUrl({
        cloudinaryUrl: 'https://res.cloudinary.com/demo/image/upload/v1/new.jpg',
        cloudinaryId: 'https://res.cloudinary.com/demo/image/upload/v1/old.jpg',
      }),
      'https://res.cloudinary.com/demo/image/upload/v1/new.jpg',
    );
    assert.equal(
      getAdminPhotoUrl({
        cloudinaryId:
          'https://res.cloudinary.com/demo/image/upload/v1/legacy.jpg',
      }),
      'https://res.cloudinary.com/demo/image/upload/v1/legacy.jpg',
    );
  });

  test('never turns a public ID or malformed/unsafe value into a browser URL', () => {
    const rejected = [
      { cloudinaryId: 'camp-parks/example' },
      { cloudinaryUrl: 'javascript:alert(1)' },
      { cloudinaryUrl: 'not a URL' },
      { cloudinaryUrl: 'https://user:pass@example.test/photo.jpg' },
    ];

    rejected.forEach(upload => assert.equal(getAdminPhotoUrl(upload), null));
  });

  test('serializes one photo URL used by both dashboard rendering paths', async () => {
    const upload = serializeAdminUpload({
      mediaType: 'photo',
      cloudinaryUrl:
        'https://res.cloudinary.com/demo/image/upload/v1/example.jpg',
      cloudinaryPublicId: 'camp-parks/example',
    });
    assert.equal(
      upload.adminPhotoUrl,
      'https://res.cloudinary.com/demo/image/upload/v1/example.jpg',
    );

    const template = await readFile('views/admin/dashboard.ejs', 'utf8');
    assert.match(template, /u\.adminPhotoUrl/);
    assert.match(
      template,
      /getSafeHttpUrl\(upload\.adminPhotoUrl\)/,
    );
    assert.doesNotMatch(
      template,
      /getSafeHttpUrl\((?:u|upload)\.cloudinary(?:Id|PublicId)\)/,
    );
  });
});
