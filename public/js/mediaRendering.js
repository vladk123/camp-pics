(function initializeMediaRendering(global) {
  const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
  ]);

  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const MARKUP_OR_CONTROL_PATTERN = /[<>\u0000-\u001F\u007F]/;
  const ENCODED_MARKUP_PATTERN = /%(?:3C|3E)/i;
  const PHOTO_PLACEHOLDER = '/images/icons/not-found.jpg';
  const VIDEO_PLACEHOLDER = PHOTO_PLACEHOLDER;

  function parseYouTubeUrl(value) {
    if (typeof value !== 'string') return null;

    const candidate = value.trim();
    if (
      !candidate ||
      MARKUP_OR_CONTROL_PATTERN.test(candidate) ||
      ENCODED_MARKUP_PATTERN.test(candidate)
    ) {
      return null;
    }

    const hasProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate);

    try {
      return new URL(hasProtocol ? candidate : `https://${candidate}`);
    } catch {
      return null;
    }
  }

  function extractYouTubeId(value) {
    const url = parseYouTubeUrl(value);
    if (!url) return null;

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }

    const hostname = url.hostname.toLowerCase();

    if (hostname === 'youtu.be') {
      const pathMatch = url.pathname.match(/^\/([A-Za-z0-9_-]{11})$/);
      return pathMatch ? pathMatch[1] : null;
    }

    if (!YOUTUBE_HOSTS.has(hostname)) return null;

    if (url.pathname === '/watch') {
      const videoIds = url.searchParams.getAll('v');
      return videoIds.length === 1 && VIDEO_ID_PATTERN.test(videoIds[0])
        ? videoIds[0]
        : null;
    }

    const pathMatch = url.pathname.match(
      /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})$/
    );
    return pathMatch ? pathMatch[1] : null;
  }

  function getSafeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;

    try {
      const url = new URL(value, global.location.origin);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function createCaptionElement({
    tagName = 'div',
    className = '',
    text = '',
    hidden = false,
  } = {}) {
    const caption = document.createElement(tagName);
    caption.className = className;
    caption.textContent = text == null ? '' : String(text);
    if (hidden) caption.classList.add('media-caption--hidden');
    return caption;
  }

  function createImageElement({
    src,
    alt = '',
    className = '',
    fallbackSrc = PHOTO_PLACEHOLDER,
  } = {}) {
    const image = document.createElement('img');
    const safeSrc = getSafeHttpUrl(src);
    const safeFallback = getSafeHttpUrl(fallbackSrc);

    if (safeSrc || safeFallback) image.src = safeSrc || safeFallback;
    image.alt = alt == null ? '' : String(alt);
    image.className = className;
    return image;
  }

  function createYouTubeIframe(value, { title = 'YouTube video' } = {}) {
    const videoId = extractYouTubeId(value);
    if (!videoId) return null;

    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${videoId}`;
    iframe.title = title;
    iframe.frameBorder = '0';
    iframe.allowFullscreen = true;
    return iframe;
  }

  function createMediaThumbnail({
    item,
    index,
    caption = '',
    wrapperClassName = 'thumb-wrapper',
    imageClassName = '',
    canDelete = false,
    isAdminDelete = false,
    onActivate,
    onPlay,
    onDelete,
  }) {
    const wrapper = document.createElement('div');
    wrapper.className = wrapperClassName;
    wrapper.dataset.index = String(index);
    wrapper.dataset.id = item._id == null ? '' : String(item._id);
    wrapper.dataset.type = item.type;

    const videoId = item.type === 'video'
      ? extractYouTubeId(item.url)
      : null;
    const image = createImageElement({
      src: item.type === 'photo'
        ? item.url
        : videoId
          ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
          : VIDEO_PLACEHOLDER,
      alt: item.caption || (
        item.type === 'photo'
          ? `Photo ${index + 1}`
          : 'Video thumbnail'
      ),
      className: imageClassName,
      fallbackSrc: item.type === 'photo'
        ? PHOTO_PLACEHOLDER
        : VIDEO_PLACEHOLDER,
    });
    image.dataset.index = String(index);

    if (typeof onActivate === 'function') {
      image.addEventListener('click', () => onActivate(index, item));
    }

    wrapper.appendChild(image);

    if (videoId) {
      if (typeof onPlay === 'function') {
        const playControl = document.createElement('button');
        playControl.className = 'video-play-overlay video-play-control';
        playControl.type = 'button';
        playControl.setAttribute('aria-label', 'Open video fullscreen');
        playControl.addEventListener('click', event => {
          event.stopPropagation();
          onPlay(item, caption);
        });
        wrapper.appendChild(playControl);
      } else {
        const playIcon = document.createElement('div');
        playIcon.className = 'video-play-overlay';
        playIcon.setAttribute('aria-hidden', 'true');
        wrapper.appendChild(playIcon);
      }
    }

    if (canDelete) {
      const deleteButton = document.createElement('button');
      deleteButton.className = `media-thumb-delete${isAdminDelete ? ' admin-delete' : ''}`;
      deleteButton.type = 'button';
      deleteButton.title = 'Delete';
      deleteButton.textContent = '\u00d7';
      deleteButton.addEventListener('click', event => {
        event.stopPropagation();
        if (typeof onDelete === 'function') onDelete(item);
      });
      wrapper.appendChild(deleteButton);
    }

    return wrapper;
  }

  function createFullscreenOverlay({ type, url, caption = '' }) {
    const media = type === 'video'
      ? createYouTubeIframe(url, { title: 'Fullscreen YouTube video' })
      : createImageElement({
          src: url,
          alt: caption,
          className: 'media-fullscreen-image',
          fallbackSrc: '',
        });

    if (!media || (type !== 'video' && !getSafeHttpUrl(url))) return null;

    const overlay = document.createElement('div');
    overlay.className = 'media-fullscreen-overlay';

    const mediaWrapper = document.createElement('div');
    mediaWrapper.className = 'media-fullscreen-content';

    if (type === 'video') {
      media.className = 'media-fullscreen-video';
    }

    mediaWrapper.appendChild(media);

    if (caption) {
      mediaWrapper.appendChild(createCaptionElement({
        tagName: 'p',
        className: 'overlay-caption',
        text: caption,
      }));
    }

    overlay.appendChild(mediaWrapper);
    overlay.addEventListener('click', () => overlay.remove());
    return overlay;
  }

  global.CampPicsMedia = Object.freeze({
    VIDEO_PLACEHOLDER,
    PHOTO_PLACEHOLDER,
    extractYouTubeId,
    isYouTubeUrl: value => extractYouTubeId(value) !== null,
    getSafeHttpUrl,
    createCaptionElement,
    createImageElement,
    createYouTubeIframe,
    createMediaThumbnail,
    createFullscreenOverlay,
  });
})(window);
