import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyLegacyCloudinaryId,
  isValidCloudinaryPublicId,
  parseCloudinaryDeliveryUrl,
  resolveCloudinaryPhotoIdentity,
} from '../utils/cloudinaryPhotoIdentity.js';

const VERSIONED_URL =
  'https://res.cloudinary.com/demo/image/upload/v123456/camp-parks/example.jpg';

describe('Cloudinary photo public IDs', () => {
  test('accepts explicit and folder-based IDs without treating URLs as IDs', () => {
    assert.equal(isValidCloudinaryPublicId('example'), true);
    assert.equal(isValidCloudinaryPublicId('camp-parks/example'), true);
    assert.equal(isValidCloudinaryPublicId('  camp-parks/example  '), true);
    assert.equal(isValidCloudinaryPublicId(VERSIONED_URL), false);
    assert.equal(isValidCloudinaryPublicId('javascript:alert(1)'), false);
    assert.equal(isValidCloudinaryPublicId('bad\u0000value'), false);
    assert.equal(isValidCloudinaryPublicId(''), false);
  });
});

describe('Cloudinary delivery URL parsing', () => {
  test('parses versioned URLs and strips query strings and fragments', () => {
    assert.deepEqual(
      parseCloudinaryDeliveryUrl(`${VERSIONED_URL}?download=1#preview`),
      {
        publicId: 'camp-parks/example',
        deliveryUrl: VERSIONED_URL,
      },
    );
  });

  test('parses versioned URLs with transformation segments', () => {
    assert.deepEqual(
      parseCloudinaryDeliveryUrl(
        'https://res.cloudinary.com/demo/image/upload/c_fill,w_800/q_auto/v123456/camp-parks/example.webp',
      ),
      {
        publicId: 'camp-parks/example',
        deliveryUrl:
          'https://res.cloudinary.com/demo/image/upload/c_fill,w_800/q_auto/v123456/camp-parks/example.webp',
      },
    );
  });

  test('accepts an unversioned URL only when no transformed boundary is inferred', () => {
    assert.equal(
      parseCloudinaryDeliveryUrl(
        'https://res.cloudinary.com/demo/image/upload/camp-parks/example.jpg',
      )?.publicId,
      'camp-parks/example',
    );
    assert.equal(
      parseCloudinaryDeliveryUrl(
        'https://res.cloudinary.com/demo/image/upload/c_fill,w_800/camp-parks/example.jpg',
      ),
      null,
    );
  });

  test('enforces exact host, credentials, protocol, resource type, and delivery type', () => {
    const rejected = [
      'https://res.cloudinary.com.evil.example/demo/image/upload/v1/example.jpg',
      'https://evil.example/res.cloudinary.com/demo/image/upload/v1/example.jpg',
      'https://user:pass@res.cloudinary.com/demo/image/upload/v1/example.jpg',
      'ftp://res.cloudinary.com/demo/image/upload/v1/example.jpg',
      'https://res.cloudinary.com/demo/video/upload/v1/example.jpg',
      'https://res.cloudinary.com/demo/image/fetch/v1/example.jpg',
      'https://res.cloudinary.com/demo/image/upload/v1/no-extension',
      'not a URL',
    ];

    rejected.forEach(value => {
      assert.equal(parseCloudinaryDeliveryUrl(value), null, value);
    });
  });
});

describe('legacy identity classification and compatibility resolution', () => {
  test('classifies URL-valued and public-ID-valued legacy fields', () => {
    assert.equal(classifyLegacyCloudinaryId(VERSIONED_URL).kind, 'deliveryUrl');
    assert.deepEqual(classifyLegacyCloudinaryId('camp-parks/example'), {
      kind: 'publicId',
      publicId: 'camp-parks/example',
    });
    assert.deepEqual(classifyLegacyCloudinaryId('https://example.test/photo.jpg'), {
      kind: 'malformed',
    });
  });

  test('resolves agreeing explicit, URL-derived, and legacy candidates', () => {
    const result = resolveCloudinaryPhotoIdentity({
      photo: {
        cloudinaryPublicId: 'camp-parks/example',
        url: VERSIONED_URL,
      },
      upload: {
        cloudinaryPublicId: 'camp-parks/example',
        cloudinaryUrl: VERSIONED_URL,
        cloudinaryId: VERSIONED_URL,
      },
      userUpload: {
        cloudinaryPublicId: 'camp-parks/example',
        cloudinaryUrl: VERSIONED_URL,
      },
    });

    assert.equal(result.conflict, false);
    assert.equal(result.unresolved, false);
    assert.equal(result.publicId, 'camp-parks/example');
    assert.equal(result.deliveryUrl, VERSIONED_URL);
  });

  test('supports either legacy field shape', () => {
    assert.equal(
      resolveCloudinaryPhotoIdentity({
        upload: { cloudinaryId: VERSIONED_URL },
      }).publicId,
      'camp-parks/example',
    );
    assert.equal(
      resolveCloudinaryPhotoIdentity({
        upload: { cloudinaryId: 'camp-parks/example' },
      }).publicId,
      'camp-parks/example',
    );
  });

  test('reports conflicts without selecting an identity', () => {
    const result = resolveCloudinaryPhotoIdentity({
      photo: {
        cloudinaryPublicId: 'camp-parks/explicit',
        url: VERSIONED_URL,
      },
    });

    assert.equal(result.conflict, true);
    assert.equal(result.publicId, null);
    assert.equal(result.deliveryUrl, null);
  });

  test('reports missing candidates as unresolved', () => {
    const result = resolveCloudinaryPhotoIdentity({});
    assert.equal(result.conflict, false);
    assert.equal(result.unresolved, true);
    assert.equal(result.publicId, null);
  });
});
