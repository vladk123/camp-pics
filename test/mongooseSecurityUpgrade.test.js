import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import mongoose from 'mongoose';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedMongooseDependencies = Object.freeze({
  bson: '^6.10.4',
  kareem: '2.6.3',
  mongodb: '~6.20.0',
  mpath: '0.9.0',
  mquery: '5.0.0',
  ms: '2.1.3',
  sift: '17.1.3',
});
const filterArgumentIndexes = new Map([
  ['countDocuments', 0],
  ['deleteMany', 0],
  ['deleteOne', 0],
  ['distinct', 1],
  ['exists', 0],
  ['find', 0],
  ['findById', 0],
  ['findByIdAndDelete', 0],
  ['findByIdAndUpdate', 0],
  ['findOne', 0],
  ['findOneAndDelete', 0],
  ['findOneAndReplace', 0],
  ['findOneAndUpdate', 0],
  ['replaceOne', 0],
  ['updateMany', 0],
  ['updateOne', 0],
  ['where', 0],
]);
const updateMethods = new Set([
  'findByIdAndUpdate',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
]);
const operationPattern = new RegExp(
  `\\.(${[...filterArgumentIndexes.keys()].sort((left, right) => right.length - left.length).join('|')})\\s*\\(`,
  'gu',
);

async function listJavaScriptFiles(relativePath) {
  const entries = await readdir(path.join(root, relativePath), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(child));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(child);
    }
  }
  return files;
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

function scanDelimited(source, startIndex, separator) {
  const values = [];
  let valueStart = startIndex;
  let parentheses = 1;
  let braces = 0;
  let brackets = 0;
  let quote = null;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;

    if (parentheses === 0) {
      values.push(source.slice(valueStart, index).trim());
      return values;
    }
    if (
      character === separator &&
      parentheses === 1 &&
      braces === 0 &&
      brackets === 0
    ) {
      values.push(source.slice(valueStart, index).trim());
      valueStart = index + 1;
    }
  }

  throw new Error('Unterminated Mongoose operation call in source guard.');
}

function operationCalls(source) {
  const calls = [];
  operationPattern.lastIndex = 0;
  for (let match = operationPattern.exec(source); match; match = operationPattern.exec(source)) {
    calls.push({
      method: match[1],
      arguments: scanDelimited(source, operationPattern.lastIndex, ','),
    });
  }
  return calls;
}

function isRawRequestBody(value) {
  return /^\(?\s*(?:req|request)(?:\?\.|\.)body\s*\)?$/u.test(value);
}

function requestBodySpread(value) {
  return /\.\.\.\s*(?:req|request)(?:\?\.|\.)body\b/u.test(value);
}

function prototypeSensitivePath(value) {
  return /['"`](?:__proto__|constructor\.prototype|prototype)(?:\.|['"`])/u.test(value);
}

function restoreObjectPrototype(descriptors) {
  for (const key of Reflect.ownKeys(Object.prototype)) {
    if (!Object.hasOwn(descriptors, key)) delete Object.prototype[key];
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    Object.defineProperty(Object.prototype, key, descriptors[key]);
  }
}

function assertPrototypePropertiesAbsent() {
  const freshObject = {};
  for (const property of ['$fullPath', '$parentSchemaDocArray']) {
    assert.equal(Object.hasOwn(Object.prototype, property), false);
    assert.equal(Object.prototype[property], undefined);
    assert.equal(freshObject[property], undefined);
    assert.equal(
      Object.prototype.propertyIsEnumerable.call(Object.prototype, property),
      false,
    );
  }
}

describe('Mongoose 8.24.2 security upgrade', () => {
  test('installed package and lockfile keep the exact dependency contract', async () => {
    const [packageSource, lockSource] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(path.join(root, 'package-lock.json'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource);
    const packageLock = JSON.parse(lockSource);
    const lockRoot = packageLock.packages[''];
    const mongooseEntry = packageLock.packages['node_modules/mongoose'];

    assert.equal(mongoose.version, '8.24.2');
    assert.equal(packageJson.dependencies.mongoose, '^8.24.2');
    assert.equal(lockRoot.dependencies.mongoose, '^8.24.2');
    assert.equal(mongooseEntry.version, '8.24.2');
    assert.equal(packageLock.packages['node_modules/mongodb'].version, '6.20.0');
    assert.equal(packageLock.packages['node_modules/bson'].version, '6.10.4');
    assert.deepEqual(
      mongooseEntry.dependencies,
      expectedMongooseDependencies,
    );
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(lockRoot.engines, packageJson.engines);
  });

  test('$nor branches are recursively sanitized without a database connection', () => {
    const dangerousSelector = { $ne: null };
    const filter = { $nor: [{ username: dangerousSelector }] };
    const readyState = mongoose.connection.readyState;

    assert.equal(readyState, 0);
    assert.strictEqual(mongoose.sanitizeFilter(filter), filter);
    assert.deepEqual(filter, {
      $nor: [{ username: { $eq: { $ne: null } } }],
    });
    assert.deepEqual(Object.keys(filter.$nor[0].username), ['$eq']);
    assert.equal(Object.hasOwn(filter.$nor[0].username, '$ne'), false);
    assert.strictEqual(filter.$nor[0].username.$eq, dangerousSelector);
    assert.equal(Object.hasOwn(filter.$nor[0].username.$eq, '$ne'), true);
    assert.equal(mongoose.connection.readyState, readyState);
  });

  test('casting a __proto__-prefixed update cannot pollute Object.prototype', () => {
    const modelName = `MongooseSecurityUpgrade${process.pid}${Date.now()}`;
    const TestModel = mongoose.model(
      modelName,
      new mongoose.Schema({ name: String }),
    );
    const maliciousUpdate = JSON.parse(
      '{"$set":{"__proto__.x":"anything"}}',
    );
    const originalDescriptors = Object.getOwnPropertyDescriptors(
      Object.prototype,
    );
    const readyState = mongoose.connection.readyState;

    try {
      assert.equal(readyState, 0);
      assert.equal(Object.hasOwn(maliciousUpdate.$set, '__proto__.x'), true);
      assertPrototypePropertiesAbsent();

      const query = TestModel.updateOne({}, {});
      try {
        query._castUpdate(maliciousUpdate);
      } catch {
        // A cast error is acceptable only if no pollution occurred before it.
      }

      assertPrototypePropertiesAbsent();
      assert.deepEqual(
        Object.getOwnPropertyDescriptors(Object.prototype),
        originalDescriptors,
      );
      assert.equal(mongoose.connection.readyState, readyState);
    } finally {
      restoreObjectPrototype(originalDescriptors);
      mongoose.deleteModel(modelName);
    }
  });

  test('production query and update calls do not receive raw request objects', async () => {
    const productionFiles = ['app.js'];
    for (const directory of ['controllers', 'routes', 'utils', 'scripts']) {
      productionFiles.push(...await listJavaScriptFiles(directory));
    }

    const violations = [];
    const sanitizeFilterUses = [];
    const prototypeSensitiveUses = [];
    for (const file of productionFiles) {
      const source = withoutComments(
        await readFile(path.join(root, file), 'utf8'),
      );
      if (/\bsanitizeFilter\b/u.test(source)) sanitizeFilterUses.push(file);
      if (/__proto__|constructor\.prototype/u.test(source)) {
        prototypeSensitiveUses.push(file);
      }

      for (const operation of operationCalls(source)) {
        const filter = operation.arguments[
          filterArgumentIndexes.get(operation.method)
        ] || '';
        const update = updateMethods.has(operation.method)
          ? operation.arguments[1] || ''
          : '';
        for (const [kind, value] of [['filter', filter], ['update', update]]) {
          if (!value) continue;
          if (isRawRequestBody(value)) {
            violations.push(`${file}: raw request body used as ${kind}`);
          }
          if (requestBodySpread(value)) {
            violations.push(`${file}: request body spread into ${kind}`);
          }
          if (prototypeSensitivePath(value)) {
            violations.push(`${file}: prototype-sensitive ${kind} path`);
          }
        }
      }
    }

    assert.deepEqual(sanitizeFilterUses, []);
    assert.deepEqual(prototypeSensitiveUses, []);
    assert.deepEqual(violations, []);
  });

  test('production models and database behavior sources remain unchanged', () => {
    const protectedPaths = [
      'app.js',
      'config',
      'controllers',
      'middleware.js',
      'models',
      'public',
      'routes',
      'scripts',
      'utils',
      'views',
    ];
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', '--', ...protectedPaths],
      { cwd: root, encoding: 'utf8' },
    ).trim();

    assert.equal(changed, '');
  });
});
