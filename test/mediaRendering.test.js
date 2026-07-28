import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  add(...names) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
    names.forEach(name => classes.add(name));
    this.element.className = [...classes].join(' ');
  }

  toggle(name, force) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
    const enabled = force === undefined ? !classes.has(name) : force;
    if (enabled) classes.add(name);
    else classes.delete(name);
    this.element.className = [...classes].join(' ');
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.attributes = new Map();
    this._textContent = '';
  }

  set innerHTML(value) {
    throw new Error(`innerHTML must not be used: ${value}`);
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  remove() {
    this.removed = true;
  }

  set textContent(value) {
    this._textContent = value == null ? '' : String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('');
  }
}

function findByClass(element, className) {
  if (element.className.split(/\s+/).includes(className)) return element;
  for (const child of element.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

function countTag(element, tagName) {
  const expected = tagName.toUpperCase();
  return (element.tagName === expected ? 1 : 0) +
    element.children.reduce(
      (total, child) => total + countTag(child, expected),
      0,
    );
}

function findByTag(element, tagName) {
  const expected = tagName.toUpperCase();
  if (element.tagName === expected) return element;
  for (const child of element.children) {
    const match = findByTag(child, expected);
    if (match) return match;
  }
  return null;
}

const captionPayloads = [
  '<img src=x onerror="window.__xssTriggered=true">',
  '</p><script>window.__xssTriggered=true</script>',
  `quotes "double", 'single', ampersands & and angle brackets < >`,
];

describe('browser media rendering', () => {
  let mediaRendering;

  before(async () => {
    const elementsById = new Map();
    globalThis.document = {
      createElement: tagName => new FakeElement(tagName),
      createTextNode: value => {
        const node = new FakeElement('#text');
        node.textContent = value;
        return node;
      },
      body: new FakeElement('body'),
      getElementById: id => {
        if (!elementsById.has(id)) {
          elementsById.set(id, new FakeElement('div'));
        }
        return elementsById.get(id);
      },
      addEventListener() {},
    };
    globalThis.window = {
      location: {
        origin: 'https://camppics.test',
        href: 'https://camppics.test/camp/park/test',
      },
      CURRENT_USER_ID: '',
      CURRENT_USER_IS_ADMIN: false,
      dataLayer: [],
    };
    globalThis.formatDate = value => String(value);

    await import('../public/js/mediaRendering.js');
    await import('../public/js/parkMediaSlider.js');
    await import('../public/js/showPark.js');
    mediaRendering = window.CampPicsMedia;
  });

  test('park captions remain literal text and do not create elements', () => {
    for (const payload of captionPayloads) {
      const { slidesHTML } = window.buildMediaHTML([{
        _id: 'photo-id',
        type: 'photo',
        user: 'user-id',
        url: 'https://res.cloudinary.com/example/photo.jpg',
        caption: payload,
      }]);

      const slide = slidesHTML[0];
      const caption = findByClass(slide, 'caption');
      assert.equal(caption.textContent, payload);
      assert.equal(countTag(slide, 'script'), 0);
      assert.equal(countTag(slide, 'img'), 2);
    }
  });

  test('park photo/video slides and thumbnails use safe media nodes', () => {
    window.CURRENT_USER_ID = 'owner-id';
    const { slidesHTML, thumbsHTML } = window.buildMediaHTML([
      {
        _id: 'photo-id',
        type: 'photo',
        user: 'owner-id',
        url: 'https://res.cloudinary.com/example/photo.jpg',
        caption: 'Photo caption',
      },
      {
        _id: 'video-id',
        type: 'video',
        user: 'owner-id',
        url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
        caption: 'Video caption',
      },
      {
        _id: 'invalid-video-id',
        type: 'video',
        user: 'someone-else',
        url: 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
        caption: 'Historical caption',
      },
    ]);

    assert.equal(countTag(slidesHTML[0], 'img'), 2);
    assert.equal(countTag(slidesHTML[1], 'iframe'), 1);
    assert.equal(countTag(slidesHTML[2], 'iframe'), 0);
    assert.equal(countTag(slidesHTML[2], 'img'), 1);
    assert.equal(countTag(thumbsHTML[0], 'button'), 1);
    assert.equal(countTag(thumbsHTML[1], 'button'), 1);
    assert.equal(countTag(thumbsHTML[2], 'button'), 0);
    assert.equal(countTag(thumbsHTML[0], 'img'), 1);
    assert.equal(countTag(thumbsHTML[1], 'img'), 1);
    assert.equal(findByClass(slidesHTML[2], 'caption').textContent, 'Historical caption');
  });

  test('thumbnail activation and play controls have distinct behavior', () => {
    const item = {
      _id: 'video-id',
      type: 'video',
      url: 'https://youtu.be/dQw4w9WgXcQ',
      caption: 'Video caption',
    };
    const activated = [];
    const played = [];

    const decorative = mediaRendering.createMediaThumbnail({
      item,
      index: 2,
      onActivate: index => activated.push(index),
    });
    const decorativeImage = findByTag(decorative, 'img');
    const decorativeIcon = findByClass(decorative, 'video-play-overlay');

    decorativeImage.listeners.get('click')();
    assert.deepEqual(activated, [2]);
    assert.equal(decorativeIcon.tagName, 'DIV');
    assert.equal(decorativeIcon.getAttribute('aria-hidden'), 'true');
    assert.equal(decorativeIcon.listeners.has('click'), false);

    const interactive = mediaRendering.createMediaThumbnail({
      item,
      index: 3,
      onActivate: index => activated.push(index),
      onPlay: (selectedItem, caption) => played.push([selectedItem, caption]),
    });
    const interactiveImage = findByTag(interactive, 'img');
    const playControl = findByClass(interactive, 'video-play-control');
    let propagationStops = 0;

    interactiveImage.listeners.get('click')();
    playControl.listeners.get('click')({
      stopPropagation: () => {
        propagationStops += 1;
      },
    });

    assert.deepEqual(activated, [2, 3]);
    assert.equal(playControl.tagName, 'BUTTON');
    assert.equal(playControl.type, 'button');
    assert.equal(playControl.getAttribute('aria-label'), 'Open video fullscreen');
    assert.deepEqual(played, [[item, '']]);
    assert.equal(propagationStops, 1);
  });

  test('fullscreen photo and video captions remain literal text', () => {
    for (const payload of captionPayloads) {
      const photoOverlay = mediaRendering.createFullscreenOverlay({
        type: 'photo',
        url: 'https://res.cloudinary.com/example/photo.jpg',
        caption: payload,
      });
      const photoCaption = findByClass(photoOverlay, 'overlay-caption');
      assert.equal(photoCaption.textContent, payload);
      assert.equal(countTag(photoOverlay, 'script'), 0);
      assert.equal(countTag(photoOverlay, 'img'), 1);

      const videoOverlay = mediaRendering.createFullscreenOverlay({
        type: 'video',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        caption: payload,
      });
      const videoCaption = findByClass(videoOverlay, 'overlay-caption');
      assert.equal(videoCaption.textContent, payload);
      assert.equal(countTag(videoOverlay, 'script'), 0);
      assert.equal(countTag(videoOverlay, 'iframe'), 1);
    }
  });

  test('invalid historical video URLs create no iframe', () => {
    const iframe = mediaRendering.createYouTubeIframe(
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'
    );
    const overlay = mediaRendering.createFullscreenOverlay({
      type: 'video',
      url: 'javascript:alert(1)',
      caption: 'Stored caption',
    });

    assert.equal(iframe, null);
    assert.equal(overlay, null);
  });

  test('campsite analytics record only overlays that actually open', () => {
    document.body.children = [];
    window.dataLayer = [];

    const photoOverlay = window.openCampsiteFullscreen(
      'photo',
      'https://res.cloudinary.com/example/photo.jpg',
      'Photo caption'
    );
    assert.ok(photoOverlay);
    assert.equal(document.body.children.length, 1);
    assert.deepEqual(window.dataLayer, [{
      event: 'media_fullscreen_view',
      media_type: 'photo',
      content_level: 'campsite',
      page_location: window.location.href,
    }]);

    const invalidOverlay = window.openCampsiteFullscreen(
      'video',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'Historical caption'
    );
    assert.equal(invalidOverlay, null);
    assert.equal(document.body.children.length, 1);
    assert.equal(window.dataLayer.length, 1);

    const videoOverlay = window.openCampsiteFullscreen(
      'video',
      'https://youtu.be/dQw4w9WgXcQ',
      'Video caption'
    );
    assert.ok(videoOverlay);
    assert.equal(document.body.children.length, 2);
    assert.equal(window.dataLayer.length, 2);
    assert.equal(window.dataLayer[1].media_type, 'video');
  });

  test('configured invalid-video fallback is a real local asset', () => {
    const relativePath = mediaRendering.VIDEO_PLACEHOLDER
      .replace(/^\/+/, '')
      .split('/');
    const placeholderPath = path.join(process.cwd(), 'public', ...relativePath);

    assert.equal(mediaRendering.VIDEO_PLACEHOLDER, '/images/icons/not-found.jpg');
    assert.equal(existsSync(placeholderPath), true);
  });

  test('browser YouTube parsing accepts only the supported URL shapes', () => {
    assert.equal(
      mediaRendering.extractYouTubeId(
        'www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=30s'
      ),
      'dQw4w9WgXcQ'
    );
    assert.equal(
      mediaRendering.extractYouTubeId(
        'https://youtube.com/shorts/dQw4w9WgXcQ'
      ),
      'dQw4w9WgXcQ'
    );
    assert.equal(
      mediaRendering.extractYouTubeId(
        'https://evil.youtube.com/watch?v=dQw4w9WgXcQ'
      ),
      null
    );
    assert.equal(
      mediaRendering.extractYouTubeId(
        'https://youtube.com/embed/dQw4w9WgXcQ/trailing'
      ),
      null
    );
  });
});
