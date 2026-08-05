import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXTENSIONS = new Set(['.css', '.ejs', '.js', '.json', '.md']);
const SOURCE_DIRECTORIES = [
  'config',
  'controllers',
  'models',
  'public',
  'routes',
  'scripts',
  'utils',
  'views',
];
const ROOT_SOURCE_FILES = [
  'AGENTS.md',
  'README-rate-limiting.md',
  'README-runtime-configuration.md',
  'README.md',
  'app.js',
  'middleware.js',
  'package.json',
];

async function listTextFiles(relativeDirectory) {
  const entries = await readdir(path.join(root, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTextFiles(relativePath));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }

  return files;
}

async function repositoryLoadingSources() {
  const files = [...ROOT_SOURCE_FILES];
  for (const directory of SOURCE_DIRECTORIES) {
    files.push(...await listTextFiles(directory));
  }
  return Promise.all(files.map(async file => ({
    file,
    source: await readFile(path.join(root, file), 'utf8'),
  })));
}

describe('final dead-code sweep source guards', () => {
  test('removed private browser identifiers have no loading-path references', async () => {
    const sources = await repositoryLoadingSources();
    for (const identifier of [
      'clearActiveProvinceHighlight',
      'currentMarkers',
      'loadCampsitePreview',
    ]) {
      const references = sources
        .filter(({ source }) => source.includes(identifier))
        .map(({ file }) => file);
      assert.deepEqual(references, [], `${identifier}: ${references.join(', ')}`);
    }
  });

  test('removed local imports and variables remain absent from former files', async () => {
    const [app, campController, campRoutes, otherRoutes, login] =
      await Promise.all([
        readFile(path.join(root, 'app.js'), 'utf8'),
        readFile(path.join(root, 'controllers/camp.js'), 'utf8'),
        readFile(path.join(root, 'routes/camp.js'), 'utf8'),
        readFile(path.join(root, 'routes/other.js'), 'utf8'),
        readFile(path.join(root, 'public/js/login.js'), 'utf8'),
      ]);

    assert.doesNotMatch(app, /\bLocalStrategy\b|utils\/cacheSearch\.js/u);
    assert.doesNotMatch(app, /mongoSanitize|express-mongo-sanitize/u);
    assert.doesNotMatch(campController, /\bexpress\b|\brouter\b/u);
    assert.doesNotMatch(campRoutes, /\buploadMemory\b|\bloadCache\b/u);
    assert.doesNotMatch(otherRoutes, /\buploadMemory\b|\bloadCache\b/u);
    assert.doesNotMatch(login, /\bsubmitBtn\b/u);
  });

  test('unreferenced Leaflet backup markers are absent from every loading path', async () => {
    const assetNames = ['marker-icon-old.png', 'marker-icon-2x-old.png'];
    const sources = await repositoryLoadingSources();

    for (const assetName of assetNames) {
      await assert.rejects(
        access(path.join(root, 'public', 'css', 'images', assetName)),
        error => error?.code === 'ENOENT',
      );
      const references = sources
        .filter(({ source }) => source.includes(assetName))
        .map(({ file }) => file);
      assert.deepEqual(references, [], `${assetName}: ${references.join(', ')}`);
    }

    const [leaflet, leafletCss, allParks] = await Promise.all([
      readFile(path.join(root, 'public/js/external-scripts/leaflet.js'), 'utf8'),
      readFile(path.join(root, 'public/css/leaflet.css'), 'utf8'),
      readFile(path.join(root, 'public/js/allParks.js'), 'utf8'),
    ]);
    const loaders = `${leaflet}\n${leafletCss}\n${allParks}`;
    for (const activeAsset of [
      'marker-icon.png',
      'marker-icon-2x.png',
      'marker-icon-highlight.png',
      'marker-shadow.png',
    ]) {
      assert.equal(loaders.includes(activeAsset), true, activeAsset);
    }
  });
});
