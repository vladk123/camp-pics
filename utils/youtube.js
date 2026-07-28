const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
]);

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MARKUP_OR_CONTROL_PATTERN = /[<>\u0000-\u001F\u007F]/;
const ENCODED_MARKUP_PATTERN = /%(?:3C|3E)/i;

function parseUrl(value) {
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

export function extractYouTubeVideoId(value) {
  const url = parseUrl(value);
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

export function isYouTubeUrl(value) {
  return extractYouTubeVideoId(value) !== null;
}
