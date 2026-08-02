import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ejs from 'ejs';

import {
  createParkSearchViewResult,
  serializePublicParkSearchResult,
} from '../utils/parkSearch.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const controllerPath = path.join(root, 'controllers', 'camp.js');
const campRoutesPath = path.join(root, 'routes', 'camp.js');
const helperPath = path.join(root, 'utils', 'parkSearch.js');
const templatePath = path.join(root, 'views', 'parks', 'results.ejs');

const [
  controllerSource,
  campRoutesSource,
  helperSource,
  templateSource,
] = await Promise.all([
  readFile(controllerPath, 'utf8'),
  readFile(campRoutesPath, 'utf8'),
  readFile(helperPath, 'utf8'),
  readFile(templatePath, 'utf8'),
]);

describe('park-search result EJS rendering', () => {
  test('escapes hostile stored fields while fixed mark elements still render', async () => {
    const serialized = serializePublicParkSearchResult({
      name: '<img src=x onerror=alert(1)> Banff',
      province: '\"><svg onload=alert(2)>',
      type: 'campground',
      parkType: 'national',
      parentPark: '</a><script>alert(3)</script>',
      image: 'x\" onerror=\"alert(4)',
      slug: '//evil.example/redirect',
      keywords: ['banff'],
    }, 5);
    const result = createParkSearchViewResult(serialized, 'banff');

    const rendered = await ejs.renderFile(templatePath, {
      layout() {},
      meta: {},
      data: { query: '<script>query()</script>', results: [result] },
    });

    assert.match(rendered, /<mark>Banff<\/mark>/u);
    assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/u);
    assert.match(rendered, /&lt;\/a&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/u);
    assert.match(rendered, /&lt;svg onload=alert\(2\)&gt;/u);
    assert.match(rendered, /Search: '&lt;script&gt;query\(\)&lt;\/script&gt;'/u);
    assert.match(rendered, /href="\/camp\/park\//u);
    assert.match(rendered, /src="x&#34; onerror=&#34;alert\(4\)"/u);
    assert.doesNotMatch(rendered, /href="\/\/evil\.example/u);
    assert.doesNotMatch(rendered, /<script>query\(\)<\/script>/u);
    assert.doesNotMatch(rendered, /<script>alert\(3\)<\/script>/u);
    assert.doesNotMatch(rendered, /<svg onload=alert\(2\)>/u);
    assert.doesNotMatch(rendered, /<img src=x onerror=alert\(1\)>/u);
  });

  test('the changed template compiles with the repository EJS engine', () => {
    assert.doesNotThrow(() => ejs.compile(templateSource, {
      filename: templatePath,
    }));
  });
});

describe('park-search source guards', () => {
  test('highlighted database strings use escaped output and fixed mark markup', () => {
    const unescapedExpressions = [...templateSource.matchAll(/<%-([\s\S]*?)%>/gu)]
      .map(match => match[1].trim());

    assert.deepEqual(unescapedExpressions, ["include('../partials/search')"]);
    assert.doesNotMatch(
      templateSource,
      /_(?:name|parent|province)Highlighted/u,
    );
    assert.match(templateSource, /<mark><%= segment\.text %><\/mark>/u);
    assert.doesNotMatch(helperSource, /<mark>|<%-|<%=/u);
  });

  test('both handlers use shared query parsing and ranking without source spreads', () => {
    const apiStart = controllerSource.indexOf(
      'export function createSearchApiHandler',
    );
    const apiEnd = controllerSource.indexOf(
      'export const searchApi',
      apiStart,
    );
    const pageStart = controllerSource.indexOf(
      'export function createSearchResultsHandler',
    );
    const pageEnd = controllerSource.indexOf(
      'export const searchResults',
      pageStart,
    );
    assert.ok(apiStart >= 0 && apiEnd > apiStart);
    assert.ok(pageStart >= 0 && pageEnd > pageStart);

    const apiHandler = controllerSource.slice(apiStart, apiEnd);
    const pageHandler = controllerSource.slice(pageStart, pageEnd);
    for (const handlerSource of [apiHandler, pageHandler]) {
      assert.match(handlerSource, /parseParkSearchQuery\(req\?\.query\?\.q\)/u);
      assert.match(handlerSource, /rankParkSearchEntries\(/u);
      assert.doesNotMatch(handlerSource, /\.\.\./u);
      assert.doesNotMatch(
        handlerSource,
        /\bq(?:\?\.)?\.(?:trim|slice)\(|const\s*\{\s*q\s*\}/u,
      );
    }
  });

  test('API serialization is explicit and one-result redirects use the view destination', () => {
    assert.doesNotMatch(helperSource, /\.\.\.(?:entry|result|source|item)/u);
    assert.match(
      controllerSource,
      /res\.redirect\(viewResults\[0\]\.destination\)/u,
    );
    assert.doesNotMatch(
      controllerSource,
      /res\.redirect\(`\/camp\/park\/\$\{/u,
    );
    assert.match(templateSource, /href="<%= result\.destination %>"/u);
    assert.doesNotMatch(templateSource, /href="\/camp<%= result\.slug %>"/u);
  });

  test('schemas, indexes, search handler, and cache data stay untouched', () => {
    const status = execFileSync(
      'git',
      [
        'status',
        '--short',
        '--',
        'models',
        'cache/parkSearch.json',
      ],
      { cwd: root, encoding: 'utf8' },
    );

    assert.equal(status.trim(), '');
    assert.match(
      campRoutesSource,
      /router\.route\('\/search-api'\)\s*\.get\(parkSearchApiLimiter, camp\.searchApi\)/u,
    );
    assert.match(
      campRoutesSource,
      /router\.route\('\/search'\)\s*\.get\(camp\.searchResults\)/u,
    );
  });
});
