import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const showParkSource = await readFile(
  new URL('../public/js/showPark.js', import.meta.url),
  'utf8',
);
const sliderSource = await readFile(
  new URL('../public/js/parkMediaSlider.js', import.meta.url),
  'utf8',
);

test('park and campsite delete controls consume server permission flags only', () => {
  for (const source of [showParkSource, sliderSource]) {
    assert.doesNotMatch(source, /\bitem\.user\b/);
    assert.doesNotMatch(source, /\b[vp]\.user\b/);
    assert.match(source, /item\.canDelete === true/);
    assert.match(source, /item\.isAdminDelete === true/);
  }

  assert.doesNotMatch(
    `${showParkSource}\n${sliderSource}`,
    /item\.[A-Za-z_$][\w$]*\s*===\s*window\.CURRENT_USER_ID|window\.CURRENT_USER_ID\s*===\s*item\./,
  );
});

test('park-media refresh rejects non-OK responses before parsing JSON', () => {
  const start = showParkSource.indexOf('async function refreshParkMedia()');
  const end = showParkSource.indexOf(
    '// Refresh the currently open campsite popup',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const refreshSource = showParkSource.slice(start, end);
  const okCheck = refreshSource.indexOf('if (!res.ok)');
  const jsonParse = refreshSource.indexOf('await res.json()');

  assert.ok(okCheck >= 0);
  assert.ok(jsonParse > okCheck);
  assert.match(
    refreshSource,
    /if \(!res\.ok\) return console\.error\('Could not refresh park media'\)/u,
  );
});
