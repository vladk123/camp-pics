import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Types } from 'mongoose';

import {
  PUBLIC_MEDIA_KEYS,
  mediaOwnerMatchesViewer,
  serializePublicMedia,
} from '../utils/publicMediaSerializer.js';

function mediaFixture(ownerId) {
  return {
    _id: 'media-id',
    user: ownerId,
    url: 'https://example.test/photo.jpg',
    caption: 'Lake view',
    username: 'Camper',
    dateTaken: '2026-01-02T00:00:00.000Z',
    uploadedAt: '2026-01-03T00:00:00.000Z',
    likedBy: ['other-user-id'],
    approved: false,
    socialMediaApproved: true,
    showUsername: true,
    cloudinaryPublicId: 'camp-pics/private-id',
    cloudinaryId: 'legacy-private-id',
    moderationState: 'internal',
    futureMediaField: 'future-value',
  };
}

describe('shared public media serializer', () => {
  test('compares ObjectId-like owners and string viewer IDs safely', () => {
    const ownerId = new Types.ObjectId();
    assert.equal(mediaOwnerMatchesViewer(ownerId, ownerId.toString()), true);
    assert.equal(
      mediaOwnerMatchesViewer(
        { _id: { toString: () => ownerId.toString() } },
        ownerId,
      ),
      true,
    );
    assert.equal(mediaOwnerMatchesViewer(ownerId, new Types.ObjectId()), false);
    assert.equal(mediaOwnerMatchesViewer(null, null), false);
  });

  test('anonymous, owner, administrator, and unrelated viewers get exact flags', () => {
    const ownerId = new Types.ObjectId();
    const item = mediaFixture(ownerId);
    const cases = [
      { viewer: null, canDelete: false, isAdminDelete: false },
      {
        viewer: { _id: ownerId.toString(), isAdmin: false },
        canDelete: true,
        isAdminDelete: false,
      },
      {
        viewer: { _id: new Types.ObjectId(), isAdmin: true },
        canDelete: true,
        isAdminDelete: true,
      },
      {
        viewer: { _id: new Types.ObjectId(), isAdmin: false },
        canDelete: false,
        isAdminDelete: false,
      },
    ];

    for (const expected of cases) {
      const serialized = serializePublicMedia(item, expected.viewer);
      assert.deepEqual(Object.keys(serialized), [...PUBLIC_MEDIA_KEYS]);
      assert.equal(serialized.canDelete, expected.canDelete);
      assert.equal(serialized.isAdminDelete, expected.isAdminDelete);
      assert.equal('user' in serialized, false);
      assert.equal('likedBy' in serialized, false);
      assert.equal('approved' in serialized, false);
      assert.equal('cloudinaryPublicId' in serialized, false);
      assert.equal('futureMediaField' in serialized, false);
    }
  });

  test('an administrator deleting their own media is presented as an owner delete', () => {
    const ownerId = new Types.ObjectId();
    const serialized = serializePublicMedia(mediaFixture(ownerId), {
      _id: ownerId.toString(),
      isAdmin: true,
    });

    assert.equal(serialized.canDelete, true);
    assert.equal(serialized.isAdminDelete, false);
  });
});
