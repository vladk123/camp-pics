import { toSlug } from './general.js';

export const MAX_PARK_SEARCH_QUERY_LENGTH = 50;

export const PUBLIC_PARK_SEARCH_RESULT_KEYS = Object.freeze([
  'name',
  'province',
  'type',
  'parkType',
  'parentPark',
  'image',
  'slug',
  'score',
]);

const VALID_RESULT_TYPES = new Set(['park', 'campground']);
const VALID_RELATIVE_PARK_SLUG =
  /^\/park\/[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const COMBINING_MARK = /\p{Mark}/u;

export function parseParkSearchQuery(value) {
  if (typeof value !== 'string') {
    return { query: '', hasQuery: false };
  }

  const query = value
    .trim()
    .toLowerCase()
    .slice(0, MAX_PARK_SEARCH_QUERY_LENGTH);

  return {
    query,
    hasQuery: query.length > 0,
  };
}

export function normalizeParkSearchText(value) {
  if (typeof value !== 'string') return '';

  return value
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase();
}

function optionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function usableName(value) {
  return optionalString(value);
}

export function isValidRelativeParkSlug(value) {
  return typeof value === 'string' &&
    value === value.trim() &&
    !CONTROL_CHARACTERS.test(value) &&
    !value.includes('\\') &&
    !value.includes('?') &&
    VALID_RELATIVE_PARK_SLUG.test(value);
}

function fallbackSlugPart(value, fallback) {
  const slug = typeof value === 'string' ? toSlug(value) : '';
  return slug || fallback;
}

function createFallbackRelativeSlug(result) {
  const nameSlug = fallbackSlugPart(result?.name, 'park');
  if (result?.type !== 'campground') {
    return `/park/${nameSlug}`;
  }

  const parentSlug = fallbackSlugPart(result?.parentPark, nameSlug);
  const campgroundSlug = fallbackSlugPart(result?.name, 'campground');
  const fragment = result?.parentPark
    ? `${parentSlug}-${campgroundSlug}`
    : campgroundSlug;

  return `/park/${parentSlug}#${fragment}`;
}

export function createSafeRelativeParkSlug(result) {
  if (isValidRelativeParkSlug(result?.slug)) return result.slug;
  return createFallbackRelativeSlug(result);
}

export function createParkSearchDestination(result) {
  return `/camp${createSafeRelativeParkSlug(result)}`;
}

export function serializePublicParkSearchResult(entry, score) {
  try {
    if (!entry || typeof entry !== 'object') return null;

    const name = usableName(entry.name);
    const type = entry.type;
    if (!name || !VALID_RESULT_TYPES.has(type) || !Number.isFinite(score)) {
      return null;
    }

    const result = {
      name,
      province: optionalString(entry.province),
      type,
      parkType: optionalString(entry.parkType),
      parentPark: optionalString(entry.parentPark),
      image: optionalString(entry.image),
      slug: null,
      score,
    };
    result.slug = createSafeRelativeParkSlug({
      name: result.name,
      type: result.type,
      parentPark: result.parentPark,
      slug: entry.slug,
    });

    return result;
  } catch {
    return null;
  }
}

export function computeParkSearchScore(entry, query) {
  if (!entry || typeof entry !== 'object') return 0;

  const normalizedQuery = normalizeParkSearchText(query);
  const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 0;

  const name = normalizeParkSearchText(entry.name);
  if (!name || !VALID_RESULT_TYPES.has(entry.type)) return 0;

  const province = normalizeParkSearchText(entry.province);
  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords
      .filter(keyword => typeof keyword === 'string')
      .map(keyword => normalizeParkSearchText(keyword))
    : [];
  let score = 0;

  for (const term of terms) {
    if (name === term) score += 10;
    else if (name.includes(term)) score += 5;

    if (province === term) score += 4;
    else if (province.includes(term)) score += 2;

    if (keywords.includes(term)) score += 3;
    else if (keywords.some(keyword => keyword.includes(term))) score += 1;
  }

  return score;
}

export function rankParkSearchEntries(entries, query) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Park search entries must be an array.');
  }

  const ranked = [];
  entries.forEach((entry, sourceIndex) => {
    try {
      const score = computeParkSearchScore(entry, query);
      if (score <= 0) return;

      const result = serializePublicParkSearchResult(entry, score);
      if (result) ranked.push({ result, sourceIndex });
    } catch {
      // A malformed historical entry must not fail the complete search.
    }
  });

  ranked.sort((left, right) => {
    if (right.result.score !== left.result.score) {
      return right.result.score - left.result.score;
    }
    if (left.result.type !== right.result.type) {
      return left.result.type === 'park' ? -1 : 1;
    }
    return left.sourceIndex - right.sourceIndex;
  });

  return ranked.map(({ result }) => result);
}

function createComparisonMap(text) {
  const groups = [];
  let originalIndex = 0;

  for (const character of text) {
    const start = originalIndex;
    originalIndex += character.length;

    if (COMBINING_MARK.test(character) && groups.length > 0) {
      const previous = groups.at(-1);
      previous.text += character;
      previous.end = originalIndex;
    } else {
      groups.push({ text: character, start, end: originalIndex });
    }
  }

  let comparison = '';
  const boundaries = [];
  for (const group of groups) {
    const normalized = normalizeParkSearchText(group.text);
    comparison += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      boundaries.push({ start: group.start, end: group.end });
    }
  }

  return { comparison, boundaries };
}

function plainTextSegments(text) {
  return text ? [{ text, highlighted: false }] : [];
}

export function createHighlightSegments(text, query) {
  if (typeof text !== 'string') return [];

  const normalizedQuery = normalizeParkSearchText(query);
  if (!text || !normalizedQuery) return plainTextSegments(text);

  const { comparison, boundaries } = createComparisonMap(text);
  const matchIndex = comparison.indexOf(normalizedQuery);
  if (matchIndex < 0) return plainTextSegments(text);

  const firstBoundary = boundaries[matchIndex];
  const lastBoundary = boundaries[matchIndex + normalizedQuery.length - 1];
  if (!firstBoundary || !lastBoundary) return plainTextSegments(text);

  const segments = [];
  const before = text.slice(0, firstBoundary.start);
  const match = text.slice(firstBoundary.start, lastBoundary.end);
  const after = text.slice(lastBoundary.end);

  if (before) segments.push({ text: before, highlighted: false });
  if (match) segments.push({ text: match, highlighted: true });
  if (after) segments.push({ text: after, highlighted: false });
  return segments;
}

export function createParkSearchViewResult(result, query) {
  return {
    name: result.name,
    province: result.province,
    type: result.type,
    parkType: result.parkType,
    parentPark: result.parentPark,
    image: result.image,
    slug: result.slug,
    score: result.score,
    destination: createParkSearchDestination(result),
    nameSegments: createHighlightSegments(result.name, query),
    parentParkSegments: createHighlightSegments(result.parentPark, query),
    provinceSegments: createHighlightSegments(result.province, query),
  };
}
