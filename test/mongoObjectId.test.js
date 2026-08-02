import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import {
  parseStrictMongoObjectId,
  strictMongoObjectIdsEqual,
} from '../utils/mongoObjectId.js';

const LOWERCASE_ID = '64b7f2d4c9f1e8a123456789';

describe('strict MongoDB ObjectId request parsing', () => {
  for (const [name, value, canonical] of [
    ['lowercase hex', LOWERCASE_ID, LOWERCASE_ID],
    ['uppercase hex', LOWERCASE_ID.toUpperCase(), LOWERCASE_ID],
    ['mixed-case hex', '64B7f2D4c9F1e8A123456789', LOWERCASE_ID],
  ]) {
    test(`accepts ${name} and returns the canonical Mongoose value`, () => {
      const parsed = parseStrictMongoObjectId(value);

      assert.deepEqual(Object.keys(parsed), [
        'valid',
        'stringValue',
        'objectId',
      ]);
      assert.equal(parsed.valid, true);
      assert.equal(parsed.stringValue, canonical);
      assert.ok(parsed.objectId instanceof mongoose.Types.ObjectId);
      assert.equal(parsed.objectId.toHexString(), canonical);
      assert.equal(Object.isFrozen(parsed), true);
      assert.equal(value, value.slice(0));
    });
  }

  const invalidCases = [
    ['missing value', () => parseStrictMongoObjectId()],
    ['undefined', () => parseStrictMongoObjectId(undefined)],
    ['null', () => parseStrictMongoObjectId(null)],
    ['empty string', () => parseStrictMongoObjectId('')],
    ['whitespace-only string', () => parseStrictMongoObjectId('   ')],
    ['leading whitespace', () => parseStrictMongoObjectId(` ${LOWERCASE_ID}`)],
    ['trailing whitespace', () => parseStrictMongoObjectId(`${LOWERCASE_ID} `)],
    ['23 characters', () => parseStrictMongoObjectId('a'.repeat(23))],
    ['25 characters', () => parseStrictMongoObjectId('a'.repeat(25))],
    ['non-hexadecimal character', () => parseStrictMongoObjectId(`${'a'.repeat(23)}g`)],
    ['array', () => parseStrictMongoObjectId([LOWERCASE_ID])],
    ['object', () => parseStrictMongoObjectId({ value: LOWERCASE_ID })],
    ['number', () => parseStrictMongoObjectId(123456789012345678901234)],
    ['boolean', () => parseStrictMongoObjectId(true)],
  ];

  for (const [name, parse] of invalidCases) {
    test(`rejects ${name} without throwing`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = parse();
      });
      assert.deepEqual(result, {
        valid: false,
        stringValue: null,
        objectId: null,
      });
      assert.equal(Object.isFrozen(result), true);
    });
  }

  test('does not mutate array or object inputs and reuses a stable invalid result', () => {
    const arrayInput = [LOWERCASE_ID];
    const objectInput = { nested: { value: LOWERCASE_ID } };
    const expectedArray = structuredClone(arrayInput);
    const expectedObject = structuredClone(objectInput);

    const arrayResult = parseStrictMongoObjectId(arrayInput);
    const objectResult = parseStrictMongoObjectId(objectInput);

    assert.deepEqual(arrayInput, expectedArray);
    assert.deepEqual(objectInput, expectedObject);
    assert.equal(arrayResult, objectResult);
  });
});

describe('safe internal MongoDB ObjectId comparison', () => {
  const target = new mongoose.Types.ObjectId(LOWERCASE_ID);

  test('matches equivalent ObjectId, string, and ObjectId-like values', () => {
    assert.equal(strictMongoObjectIdsEqual(target, target), true);
    assert.equal(strictMongoObjectIdsEqual(target, LOWERCASE_ID), true);
    assert.equal(
      strictMongoObjectIdsEqual(target, LOWERCASE_ID.toUpperCase()),
      true,
    );
    assert.equal(strictMongoObjectIdsEqual(target, {
      toHexString: () => LOWERCASE_ID,
    }), true);
  });

  test('returns false without throwing for missing or invalid candidates', () => {
    const candidates = [
      undefined,
      null,
      '',
      'not-an-object-id',
      42,
      {},
      { toHexString: () => { throw new Error('invalid ID'); } },
    ];

    for (const candidate of candidates) {
      assert.doesNotThrow(() => {
        assert.equal(strictMongoObjectIdsEqual(target, candidate), false);
      });
    }
  });
});
