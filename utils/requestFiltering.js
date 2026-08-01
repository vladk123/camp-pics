export const MAX_URL_PATTERN_COUNT = 200;
export const MAX_URL_PATTERN_LENGTH = 256;

/**
 * Parse literal, comma-delimited URL fragments once at startup.
 *
 * Oversized entries and entries beyond the fixed count limit are ignored. This
 * avoids turning truncated configuration into a broader substring match.
 */
export function parseUrlPatterns(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string') {
    throw new TypeError('URL pattern configuration must be a string, null, or undefined.');
  }

  const patterns = [];
  const seen = new Set();

  for (const rawPattern of value.split(',')) {
    const pattern = rawPattern.trim();
    if (!pattern || pattern.length > MAX_URL_PATTERN_LENGTH || seen.has(pattern)) {
      continue;
    }

    seen.add(pattern);
    patterns.push(pattern);
    if (patterns.length === MAX_URL_PATTERN_COUNT) break;
  }

  return patterns;
}

export function matchesLiteralUrlPattern(url, patterns) {
  if (typeof url !== 'string' || !Array.isArray(patterns)) return false;

  return patterns.some(pattern =>
    typeof pattern === 'string' && pattern.length > 0 && url.includes(pattern));
}
