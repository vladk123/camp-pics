import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createSearchApiHandler,
  createSearchResultsHandler,
} from '../controllers/camp.js';
import {
  MAX_PARK_SEARCH_QUERY_LENGTH,
  PUBLIC_PARK_SEARCH_RESULT_KEYS,
  computeParkSearchScore,
  createHighlightSegments,
  createParkSearchDestination,
  createParkSearchViewResult,
  isValidRelativeParkSlug,
  parseParkSearchQuery,
  rankParkSearchEntries,
  serializePublicParkSearchResult,
} from '../utils/parkSearch.js';

const VIEW_RESULT_KEYS = [
  ...PUBLIC_PARK_SEARCH_RESULT_KEYS,
  'destination',
  'nameSegments',
  'parentParkSegments',
  'provinceSegments',
];

function cacheEntry(overrides = {}) {
  return {
    _id: { providerValue: 'database-id' },
    __v: 7,
    name: 'Banff',
    province: 'Alberta',
    type: 'park',
    parkType: 'national',
    parentPark: null,
    keywords: ['mountains'],
    coordinates: { lat: 51.1784, lng: -115.5708 },
    image: 'https://images.example.test/banff.jpg',
    slug: '/park/banff',
    _nameNorm: 'banff',
    _provinceNorm: 'alberta',
    _keywordsNorm: ['mountains'],
    arbitraryFutureField: 'private-future-value',
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    redirectTarget: undefined,
    renderData: undefined,
    view: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(target) {
      this.redirectTarget = target;
      return this;
    },
    render(view, data) {
      this.view = view;
      this.renderData = data;
      return this;
    },
  };
}

async function invoke(handler, req) {
  const res = responseRecorder();
  const nextCalls = [];
  await handler(req, res, error => nextCalls.push(error));
  return { res, nextCalls };
}

describe('park-search query parsing', () => {
  const fiftyCharacters = 'A'.repeat(MAX_PARK_SEARCH_QUERY_LENGTH);
  const cases = [
    ['missing value', undefined, { query: '', hasQuery: false }],
    ['null', null, { query: '', hasQuery: false }],
    ['empty string', '', { query: '', hasQuery: false }],
    ['whitespace only', ' \r\n\t ', { query: '', hasQuery: false }],
    ['ordinary string', 'banff', { query: 'banff', hasQuery: true }],
    ['surrounding whitespace', '  Banff  ', { query: 'banff', hasQuery: true }],
    ['mixed case', 'BaNfF', { query: 'banff', hasQuery: true }],
    ['accented text', '\u00c9COLE', { query: '\u00e9cole', hasQuery: true }],
    ['exactly 50 characters', fiftyCharacters, {
      query: fiftyCharacters.toLowerCase(),
      hasQuery: true,
    }],
    ['over 50 characters', `${fiftyCharacters}BC`, {
      query: fiftyCharacters.toLowerCase(),
      hasQuery: true,
    }],
    ['array', ['banff'], { query: '', hasQuery: false }],
    ['object', { q: 'banff' }, { query: '', hasQuery: false }],
    ['number', 42, { query: '', hasQuery: false }],
    ['boolean', true, { query: '', hasQuery: false }],
  ];

  for (const [label, value, expected] of cases) {
    test(label, () => {
      const before = typeof structuredClone === 'function'
        ? structuredClone(value)
        : value;
      const parsed = parseParkSearchQuery(value);

      assert.deepEqual(parsed, expected);
      assert.deepEqual(Object.keys(parsed), ['query', 'hasQuery']);
      assert.deepEqual(value, before);
      assert.ok(parsed.query.length <= MAX_PARK_SEARCH_QUERY_LENGTH);
    });
  }

  test('an omitted argument has the stable empty result shape', () => {
    assert.deepEqual(parseParkSearchQuery(), {
      query: '',
      hasQuery: false,
    });
  });
});

describe('park-search ranking and serialization', () => {
  test('keeps every ranking weight and descending order unchanged', () => {
    const fixtures = [
      cacheEntry({ name: 'Banff', slug: '/park/exact-name' }),
      cacheEntry({ name: 'Banff National', slug: '/park/partial-name' }),
      cacheEntry({ name: 'Other A', province: 'Banff', slug: '/park/exact-province' }),
      cacheEntry({ name: 'Other B', province: 'North Banff Region', slug: '/park/partial-province' }),
      cacheEntry({ name: 'Other C', province: 'Elsewhere', keywords: ['banff'], slug: '/park/exact-keyword' }),
      cacheEntry({ name: 'Other D', province: 'Elsewhere', keywords: ['banffshire'], slug: '/park/partial-keyword' }),
    ];

    assert.deepEqual(
      fixtures.map(entry => computeParkSearchScore(entry, 'banff')),
      [10, 5, 4, 2, 3, 1],
    );
    assert.deepEqual(
      rankParkSearchEntries(fixtures, 'banff').map(result => result.score),
      [10, 5, 4, 3, 2, 1],
    );
  });

  test('matches case and accents and puts parks before campgrounds on ties', () => {
    const results = rankParkSearchEntries([
      cacheEntry({
        name: '\u00c9cole Campground',
        type: 'campground',
        parentPark: '\u00c9cole',
        slug: '/park/ecole#ecole-campground',
      }),
      cacheEntry({ name: '\u00c9cole Park', slug: '/park/ecole-park' }),
    ], '\u00c9COLE');

    assert.deepEqual(results.map(result => result.type), ['park', 'campground']);
    assert.deepEqual(results.map(result => result.score), [5, 5]);
  });

  test('skips malformed entries while accepting conservative optional fields', () => {
    const malformed = [
      null,
      {},
      cacheEntry({ name: 17 }),
      cacheEntry({ type: 'campsite' }),
      cacheEntry({ name: '   ' }),
      cacheEntry({ name: 'Banff malformed province', province: { value: 'Banff' } }),
      cacheEntry({ name: 'Banff malformed keywords', keywords: { value: 'Banff' } }),
      cacheEntry({
        name: 'Banff mixed keywords',
        keywords: ['banff', 42, null, { value: 'banff' }],
      }),
    ];

    const results = rankParkSearchEntries(malformed, 'banff');

    assert.equal(results.length, 3);
    assert.equal(results[0].province, 'Alberta');
    assert.equal(results[1].province, null);
    assert.ok(results.every(result => result.type === 'park'));
    assert.ok(results.every(result => Number.isFinite(result.score)));
  });

  test('does not mutate source entries or expose source fields', () => {
    const entries = [
      cacheEntry({ name: 'Banff Two', slug: '/park/banff-two' }),
      cacheEntry({ name: 'Banff One', slug: '/park/banff-one' }),
    ];
    const before = structuredClone(entries);

    const results = rankParkSearchEntries(entries, 'banff');

    assert.deepEqual(entries, before);
    assert.deepEqual(entries.map(entry => entry.name), ['Banff Two', 'Banff One']);
    for (const result of results) {
      assert.deepEqual(Object.keys(result), PUBLIC_PARK_SEARCH_RESULT_KEYS);
      for (const privateKey of [
        '_id',
        '__v',
        'keywords',
        'coordinates',
        '_nameNorm',
        '_provinceNorm',
        '_keywordsNorm',
        'arbitraryFutureField',
      ]) {
        assert.equal(privateKey in result, false, privateKey);
      }
    }
  });

  test('the serializer rejects unusable names, types, and scores', () => {
    assert.equal(serializePublicParkSearchResult(cacheEntry({ name: null }), 1), null);
    assert.equal(serializePublicParkSearchResult(cacheEntry({ type: 'other' }), 1), null);
    assert.equal(serializePublicParkSearchResult(cacheEntry(), Number.NaN), null);
    assert.equal(serializePublicParkSearchResult(cacheEntry(), Infinity), null);
  });
});

describe('park-search API handler', () => {
  test('missing and invalid queries return 200 [] without loading or logging', async () => {
    const invalidRequests = [
      {},
      { query: undefined },
      { query: {} },
      { query: { q: null } },
      { query: { q: '' } },
      { query: { q: '   ' } },
      { query: { q: ['banff'] } },
      { query: { q: { value: 'banff' } } },
      { query: { q: 42 } },
      { query: { q: false } },
    ];
    let loadCalls = 0;
    const logCalls = [];
    const handler = createSearchApiHandler({
      async loadSearchData() {
        loadCalls += 1;
        return [];
      },
      async log(...args) {
        logCalls.push(args);
      },
    });

    for (const req of invalidRequests) {
      const { res, nextCalls } = await invoke(handler, req);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, []);
      assert.deepEqual(nextCalls, []);
    }
    assert.equal(loadCalls, 0);
    assert.deepEqual(logCalls, []);
  });

  test('loads once, retains ranking order, caps at 25, and returns exact keys', async () => {
    const entries = Array.from({ length: 30 }, (_, index) => cacheEntry({
      name: `Banff ${index}`,
      type: index === 0 ? 'campground' : 'park',
      parentPark: index === 0 ? 'Banff' : null,
      slug: index === 0
        ? '/park/banff#banff-0'
        : `/park/banff-${index}`,
    }));
    entries.push(null, cacheEntry({ name: 42 }), cacheEntry({ type: 'other' }));
    const before = structuredClone(entries);
    let loadCalls = 0;
    const handler = createSearchApiHandler({
      async loadSearchData() {
        loadCalls += 1;
        return entries;
      },
    });

    const { res, nextCalls } = await invoke(handler, {
      query: { q: 'BANFF' },
    });

    assert.equal(loadCalls, 1);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 25);
    assert.equal(res.body[0].type, 'park');
    assert.deepEqual(nextCalls, []);
    assert.deepEqual(entries, before);
    for (const result of res.body) {
      assert.deepEqual(Object.keys(result), PUBLIC_PARK_SEARCH_RESULT_KEYS);
      assert.equal('_id' in result, false);
      assert.equal('__v' in result, false);
      assert.equal('arbitraryFutureField' in result, false);
    }
  });

  test('returns the established ranking weights in descending order', async () => {
    const entries = [
      cacheEntry({ name: 'Banff', slug: '/park/exact-name' }),
      cacheEntry({ name: 'Banff National', slug: '/park/partial-name' }),
      cacheEntry({ name: 'Other A', province: 'Banff', slug: '/park/exact-province' }),
      cacheEntry({ name: 'Other B', province: 'North Banff Region', slug: '/park/partial-province' }),
      cacheEntry({ name: 'Other C', province: 'Elsewhere', keywords: ['banff'], slug: '/park/exact-keyword' }),
      cacheEntry({ name: 'Other D', province: 'Elsewhere', keywords: ['banffshire'], slug: '/park/partial-keyword' }),
    ];
    const handler = createSearchApiHandler({
      loadSearchData: async () => entries,
    });

    const { res } = await invoke(handler, { query: { q: 'banff' } });

    assert.deepEqual(res.body.map(result => result.score), [10, 5, 4, 3, 2, 1]);
    assert.deepEqual(res.body.map(result => result.name), [
      'Banff',
      'Banff National',
      'Other A',
      'Other C',
      'Other B',
      'Other D',
    ]);
  });

  test('cache or ranking failures retain fixed safe logging and the 500 body', async t => {
    for (const fixture of [
      {
        label: 'cache loader failure',
        createData(failure) {
          throw failure;
        },
      },
      {
        label: 'ranking collection failure',
        createData(failure) {
          return new Proxy([], {
            get(target, property, receiver) {
              if (property === 'forEach') throw failure;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      },
      {
        label: 'invalid cache collection',
        createData() {
          return { entries: [] };
        },
        expectedErrorType: TypeError,
      },
    ]) {
      await t.test(fixture.label, async () => {
        const failure = new Error(fixture.label);
        const logCalls = [];
        const req = { query: { q: 'park' } };
        const handler = createSearchApiHandler({
          async loadSearchData() {
            return fixture.createData(failure);
          },
          async log(...args) {
            logCalls.push(args);
          },
        });

        const { res, nextCalls } = await invoke(handler, req);

        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Search failed' });
        assert.deepEqual(nextCalls, []);
        assert.equal(logCalls.length, 1);
        assert.equal(logCalls[0][0], req);
        assert.equal(logCalls[0][2], 'error');
        assert.equal(logCalls[0][3].message, 'Park search API failed.');
        if (fixture.expectedErrorType) {
          assert.ok(logCalls[0][3].error instanceof fixture.expectedErrorType);
        } else {
          assert.equal(logCalls[0][3].error, failure);
        }
      });
    }
  });
});

describe('park-search page handler', () => {
  test('missing and non-string queries redirect before loading the cache', async () => {
    const invalidRequests = [
      {},
      { query: undefined },
      { query: {} },
      { query: { q: null } },
      { query: { q: '' } },
      { query: { q: '   ' } },
      { query: { q: ['banff'] } },
      { query: { q: { value: 'banff' } } },
      { query: { q: 42 } },
      { query: { q: false } },
    ];
    let loadCalls = 0;
    const handler = createSearchResultsHandler({
      async loadSearchData() {
        loadCalls += 1;
        return [];
      },
    });

    for (const req of invalidRequests) {
      const { res, nextCalls } = await invoke(handler, req);
      assert.equal(res.redirectTarget, '/camp/all-parks');
      assert.equal(res.view, undefined);
      assert.deepEqual(nextCalls, []);
    }
    assert.equal(loadCalls, 0);
  });

  test('valid results render a capped, allowlisted page view model', async () => {
    const entries = Array.from({ length: 55 }, (_, index) => cacheEntry({
      name: `Banff ${index}`,
      slug: `/park/banff-${index}`,
    }));
    let loadCalls = 0;
    const handler = createSearchResultsHandler({
      async loadSearchData() {
        loadCalls += 1;
        return entries;
      },
    });

    const { res, nextCalls } = await invoke(handler, {
      query: { q: '  BANFF  ' },
    });

    assert.equal(loadCalls, 1);
    assert.equal(res.view, 'parks/results');
    assert.equal(res.renderData.data.query, 'banff');
    assert.equal(res.renderData.data.results.length, 50);
    assert.deepEqual(nextCalls, []);
    for (const result of res.renderData.data.results) {
      assert.deepEqual(Object.keys(result), VIEW_RESULT_KEYS);
      assert.ok(result.destination.startsWith('/camp/park/'));
      assert.equal('_id' in result, false);
      assert.equal('__v' in result, false);
      assert.equal('keywords' in result, false);
      assert.equal('arbitraryFutureField' in result, false);
    }
  });

  test('one result redirects to its page-model validated destination', async () => {
    const entry = cacheEntry({
      name: 'Tunnel Mountain',
      type: 'campground',
      parentPark: 'Banff',
      slug: '/park/banff#banff-tunnel-mountain',
    });
    const ranked = rankParkSearchEntries([entry], 'tunnel');
    const expected = createParkSearchViewResult(ranked[0], 'tunnel');
    const handler = createSearchResultsHandler({
      loadSearchData: async () => [entry],
    });

    const { res } = await invoke(handler, { query: { q: 'tunnel' } });

    assert.equal(res.redirectTarget, expected.destination);
    assert.equal(res.redirectTarget, '/camp/park/banff#banff-tunnel-mountain');
    assert.equal(res.view, undefined);
  });

  test('malicious stored slugs cannot produce external redirects', async () => {
    const maliciousSlugs = [
      'https://evil.example/park/banff',
      '//evil.example/park/banff',
      'javascript:alert(1)',
      'data:text/html,attack',
      '/outside/banff',
      '/park/banff?next=//evil.example',
      '/park/banff\\@evil.example',
      '/park/banff\r\nLocation: https://evil.example',
    ];

    for (const slug of maliciousSlugs) {
      const handler = createSearchResultsHandler({
        loadSearchData: async () => [cacheEntry({ slug })],
      });
      const { res } = await invoke(handler, { query: { q: 'banff' } });

      assert.ok(res.redirectTarget.startsWith('/camp/park/'), slug);
      assert.equal(res.redirectTarget, '/camp/park/banff');
      assert.equal(res.redirectTarget.includes('evil.example'), false);
    }
  });

  test('cache and ranking failures pass the original Error to next only', async t => {
    for (const fixture of [
      {
        label: 'cache failure',
        load(failure) {
          throw failure;
        },
      },
      {
        label: 'ranking failure',
        load(failure) {
          return new Proxy([], {
            get(target, property, receiver) {
              if (property === 'forEach') throw failure;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      },
      {
        label: 'invalid cache collection',
        load() {
          return null;
        },
        expectedErrorType: TypeError,
      },
    ]) {
      await t.test(fixture.label, async () => {
        const failure = new Error(fixture.label);
        const handler = createSearchResultsHandler({
          loadSearchData: async () => fixture.load(failure),
        });

        const { res, nextCalls } = await invoke(handler, {
          query: { q: 'banff' },
        });

        assert.equal(nextCalls.length, 1);
        if (fixture.expectedErrorType) {
          assert.ok(nextCalls[0] instanceof fixture.expectedErrorType);
        } else {
          assert.equal(nextCalls[0], failure);
        }
        assert.equal(res.redirectTarget, undefined);
        assert.equal(res.view, undefined);
        assert.equal(res.body, undefined);
      });
    }
  });
});

describe('safe park-search destinations', () => {
  const cases = [
    ['park slug', cacheEntry({ slug: '/park/banff' }), '/camp/park/banff'],
    ['campground fragment', cacheEntry({
      name: 'Tunnel Mountain',
      type: 'campground',
      parentPark: 'Banff',
      slug: '/park/banff#campground-anchor',
    }), '/camp/park/banff#campground-anchor'],
    ['absolute HTTPS URL', cacheEntry({ slug: 'https://evil.example/park/banff' }), '/camp/park/banff'],
    ['protocol-relative URL', cacheEntry({ slug: '//evil.example/park/banff' }), '/camp/park/banff'],
    ['javascript URL', cacheEntry({ slug: 'javascript:alert(1)' }), '/camp/park/banff'],
    ['data URL', cacheEntry({ slug: 'data:text/html,attack' }), '/camp/park/banff'],
    ['file URL', cacheEntry({ slug: 'file:///etc/passwd' }), '/camp/park/banff'],
    ['outside path', cacheEntry({ slug: '/other/banff' }), '/camp/park/banff'],
    ['query string', cacheEntry({ slug: '/park/banff?next=/other' }), '/camp/park/banff'],
    ['backslash', cacheEntry({ slug: '/park/banff\\evil' }), '/camp/park/banff'],
    ['CR/LF', cacheEntry({ slug: '/park/banff\r\nLocation: //evil.example' }), '/camp/park/banff'],
    ['credentials', cacheEntry({ slug: '/park/user@evil.example' }), '/camp/park/banff'],
    ['missing slug', cacheEntry({ slug: undefined }), '/camp/park/banff'],
    ['campground fallback', cacheEntry({
      name: 'Tunnel Mountain',
      type: 'campground',
      parentPark: 'Banff',
      slug: undefined,
    }), '/camp/park/banff#banff-tunnel-mountain'],
  ];

  for (const [label, entry, expected] of cases) {
    test(label, () => {
      const result = serializePublicParkSearchResult(entry, 5);
      const destination = createParkSearchDestination(result);

      assert.equal(destination, expected);
      assert.ok(destination.startsWith('/camp/park/'));
      assert.equal(isValidRelativeParkSlug(result.slug), true);
    });
  }
});

describe('text-only park-search highlight segments', () => {
  test('matches case-insensitively and preserves original casing', () => {
    assert.deepEqual(createHighlightSegments('McGREGOR Lake', 'gregor'), [
      { text: 'Mc', highlighted: false },
      { text: 'GREGOR', highlighted: true },
      { text: ' Lake', highlighted: false },
    ]);
  });

  test('matches accents while retaining precomposed original text', () => {
    assert.deepEqual(createHighlightSegments('\u00c9cole Park', 'ecole'), [
      { text: '\u00c9cole', highlighted: true },
      { text: ' Park', highlighted: false },
    ]);
  });

  test('maps decomposed accents back to complete original boundaries', () => {
    const source = 'Cafe\u0301 Noir';
    assert.deepEqual(createHighlightSegments(source, 'caf\u00e9'), [
      { text: 'Cafe\u0301', highlighted: true },
      { text: ' Noir', highlighted: false },
    ]);
  });

  test('highlights only the first occurrence', () => {
    assert.deepEqual(createHighlightSegments('Banff banff', 'banff'), [
      { text: 'Banff', highlighted: true },
      { text: ' banff', highlighted: false },
    ]);
  });

  test('no match, empty query, and non-string stored text are safe', () => {
    assert.deepEqual(createHighlightSegments('Banff', 'jasper'), [
      { text: 'Banff', highlighted: false },
    ]);
    assert.deepEqual(createHighlightSegments('Banff', ''), [
      { text: 'Banff', highlighted: false },
    ]);
    assert.deepEqual(createHighlightSegments(null, 'banff'), []);
    assert.deepEqual(createHighlightSegments({ text: 'Banff' }, 'banff'), []);
  });

  test('stored and query payloads remain text data and never become helper markup', () => {
    const source = '<img src=x onerror=alert(1)>';
    const sourceBefore = source;
    const storedSegments = createHighlightSegments(source, 'img');
    const querySegments = createHighlightSegments(
      'Ordinary park',
      '<script>alert(1)</script>',
    );

    assert.equal(storedSegments.map(segment => segment.text).join(''), source);
    assert.deepEqual(querySegments, [
      { text: 'Ordinary park', highlighted: false },
    ]);
    assert.equal(source, sourceBefore);
    for (const segments of [storedSegments, querySegments]) {
      assert.ok(segments.every(segment =>
        Object.keys(segment).join(',') === 'text,highlighted'));
      assert.equal(JSON.stringify(segments).includes('<mark>'), false);
      assert.equal(JSON.stringify(segments).includes('</mark>'), false);
    }
  });
});
