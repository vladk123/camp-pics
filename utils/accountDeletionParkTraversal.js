const CONTENT_FIELDS = Object.freeze({
  photos: 'photo',
  videos: 'video',
  reviews: 'review',
});

const ALL_CONTENT_FIELDS = Object.freeze(Object.keys(CONTENT_FIELDS));
const CAMPGROUND_CONTENT_FIELDS = Object.freeze(['photos', 'reviews']);

export const ACCOUNT_DELETION_USER_REFERENCE_PATHS = Object.freeze([
  'photos.user',
  'videos.user',
  'reviews.user',
  'photos.likedBy',
  'videos.likedBy',
  'reviews.likedBy',
  'campgrounds.photos.user',
  'campgrounds.reviews.user',
  'campgrounds.photos.likedBy',
  'campgrounds.reviews.likedBy',
  'campsites.photos.user',
  'campsites.videos.user',
  'campsites.reviews.user',
  'campsites.photos.likedBy',
  'campsites.videos.likedBy',
  'campsites.reviews.likedBy',
  'campgrounds.campsites.photos.user',
  'campgrounds.campsites.videos.user',
  'campgrounds.campsites.reviews.user',
  'campgrounds.campsites.photos.likedBy',
  'campgrounds.campsites.videos.likedBy',
  'campgrounds.campsites.reviews.likedBy',
]);

export const ACCOUNT_DELETION_MEDIA_ID_PATHS = Object.freeze({
  photo: Object.freeze([
    'photos._id',
    'campgrounds.photos._id',
    'campsites.photos._id',
    'campgrounds.campsites.photos._id',
  ]),
  video: Object.freeze([
    'videos._id',
    'campsites.videos._id',
    'campgrounds.campsites.videos._id',
  ]),
});

function items(value) {
  return Array.isArray(value) ? value : [];
}

export function accountDeletionIdString(value) {
  if (value == null) return null;
  const normalized = typeof value.toString === 'function'
    ? value.toString()
    : String(value);
  return normalized || null;
}

export function accountDeletionIdsEqual(left, right) {
  if (left == null || right == null) return false;
  if (typeof left.equals === 'function') return left.equals(right);
  if (typeof right.equals === 'function') return right.equals(left);
  return accountDeletionIdString(left) === accountDeletionIdString(right);
}

export function forEachParkAccountContent(park, visitor) {
  if (!park || typeof visitor !== 'function') return;

  const visitTarget = (target, fields, location) => {
    if (!target) return;
    for (const field of fields) {
      visitor({
        target,
        field,
        mediaType: CONTENT_FIELDS[field],
        items: items(target[field]),
        location,
      });
    }
  };

  visitTarget(park, ALL_CONTENT_FIELDS, 'park');

  for (const campground of items(park.campgrounds)) {
    visitTarget(campground, CAMPGROUND_CONTENT_FIELDS, 'campground');
    for (const campsite of items(campground?.campsites)) {
      visitTarget(
        campsite,
        ALL_CONTENT_FIELDS,
        'campground-campsite',
      );
    }
  }

  for (const campsite of items(park.campsites)) {
    visitTarget(campsite, ALL_CONTENT_FIELDS, 'standalone-campsite');
  }
}

export function removeUserParkContentAndLikes(park, userId) {
  const counts = {
    photosRemoved: 0,
    videosRemoved: 0,
    reviewsRemoved: 0,
    likesRemoved: 0,
  };
  let changed = false;

  forEachParkAccountContent(park, ({ target, field, items: content }) => {
    const retained = [];
    for (const entry of content) {
      if (accountDeletionIdsEqual(entry?.user, userId)) {
        const countKey = `${CONTENT_FIELDS[field]}sRemoved`;
        counts[countKey] += 1;
        changed = true;
        continue;
      }

      if (Array.isArray(entry?.likedBy)) {
        const retainedLikes = entry.likedBy.filter(
          likedBy => !accountDeletionIdsEqual(likedBy, userId),
        );
        const removedLikes = entry.likedBy.length - retainedLikes.length;
        if (removedLikes > 0) {
          entry.likedBy = retainedLikes;
          counts.likesRemoved += removedLikes;
          changed = true;
        }
      }
      retained.push(entry);
    }

    if (retained.length !== content.length) {
      target[field] = retained;
    }
  });

  return Object.freeze({ changed, ...counts });
}

export function parkHasUserContentOrLikes(park, userId) {
  let found = false;
  forEachParkAccountContent(park, ({ items: content }) => {
    if (found) return;
    found = content.some(entry =>
      accountDeletionIdsEqual(entry?.user, userId) ||
      items(entry?.likedBy).some(likedBy =>
        accountDeletionIdsEqual(likedBy, userId)
      )
    );
  });
  return found;
}
