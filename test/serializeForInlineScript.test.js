import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serializeForInlineScript } from '../utils/serializeForInlineScript.js';

test('serializeForInlineScript prevents closing the containing script element', () => {
  const value = {
    name: '</script><script>window.__xssTriggered=true</script>',
    caption: 'quotes " \' & < >',
    separators: '\u2028\u2029',
  };

  const serialized = serializeForInlineScript(value);

  assert.equal(serialized.includes('<'), false);
  assert.equal(serialized.includes('>'), false);
  assert.equal(serialized.includes('&'), false);
  assert.equal(serialized.includes('\u2028'), false);
  assert.equal(serialized.includes('\u2029'), false);
  assert.deepEqual(JSON.parse(serialized), value);
});
