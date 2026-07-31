import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Email } from '../models/email.js';

test('Email schema keeps legacy content hidden and adds optional template metadata', () => {
  const template = Email.schema.path('template');
  const html = Email.schema.path('html');
  const subject = Email.schema.path('subject');

  assert.ok(template);
  assert.equal(template.options.required, undefined);
  assert.ok(html);
  assert.ok(subject);
  assert.equal(html.options.select, false);
  assert.equal(subject.options.select, false);

  for (const path of ['to', 'userId', 'messageId', 'sentAt']) {
    assert.ok(Email.schema.path(path), path);
  }
});

test('Email schema adds no indexes or TTL configuration', () => {
  assert.deepEqual(Email.schema.indexes(), []);

  for (const path of Object.values(Email.schema.paths)) {
    assert.equal(path.options.expires, undefined, path.path);
    assert.notEqual(path.options.index, 'ttl', path.path);
  }
});
