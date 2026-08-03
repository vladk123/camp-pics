import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const removedDependencies = [
  'csv-parser',
  'csvtojson',
  'express-validator',
  'multer-storage-cloudinary',
];
const expectedDependencies = {
  bcryptjs: '^3.0.2',
  cloudinary: '1.41.3',
  compression: '^1.8.1',
  'connect-flash': '^0.1.1',
  'connect-mongo': '^5.1.0',
  'csrf-sync': '^4.2.1',
  dotenv: '^17.2.3',
  ejs: '3.1.10',
  'ejs-mate': '^4.0.0',
  express: '^5.1.0',
  'express-rate-limit': '^8.6.1',
  'express-session': '^1.18.2',
  'express-slow-down': '^3.0.0',
  'form-data': '^4.0.6',
  helmet: '^8.1.0',
  'mailgun.js': '^12.1.1',
  'method-override': '^3.0.0',
  mongoose: '^8.24.2',
  multer: '^2.2.0',
  passport: '^0.7.0',
  'passport-local': '^1.0.0',
  'passport-local-mongoose': '^8.0.0',
  sharp: '^0.34.5',
  streamifier: '^0.1.1',
};

async function listJavaScriptFiles(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(childRelativePath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(childRelativePath);
    }
  }

  return files;
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

describe('dependency and runtime cleanup guards', () => {
  test('manifests contain only the authorized dependency changes', async () => {
    const [packageSource, lockSource, sendEmailSource] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(path.join(root, 'package-lock.json'), 'utf8'),
      readFile(path.join(root, 'utils/sendEmail.js'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource);
    const packageLock = JSON.parse(lockSource);
    const lockRoot = packageLock.packages[''];

    assert.deepEqual(packageJson.dependencies, expectedDependencies);
    assert.deepEqual(lockRoot.dependencies, expectedDependencies);
    assert.deepEqual(lockRoot.dependencies, packageJson.dependencies);
    assert.deepEqual(packageJson.engines, { node: '24.x', npm: '11.x' });
    assert.deepEqual(lockRoot.engines, packageJson.engines);
    assert.equal(packageJson.dependencies.multer, '^2.2.0');
    assert.equal(lockRoot.dependencies.multer, '^2.2.0');
    assert.equal(
      packageLock.packages['node_modules/multer'].version,
      '2.2.0',
    );
    assert.equal(
      packageLock.packages['node_modules/multer'].resolved,
      'https://registry.npmjs.org/multer/-/multer-2.2.0.tgz',
    );
    assert.equal(
      packageLock.packages['node_modules/multer'].integrity,
      'sha512-6rdyFg2kLrMh9Jee7/BMPuV9lEAd7lLW2YUpF9/YxR7njyoUwwQ0ZPh3TaIY50Sw6vlyD2HW3wGOkTS4P79xrQ==',
    );
    assert.deepEqual(
      packageLock.packages['node_modules/multer'].dependencies,
      {
        'append-field': '^1.0.0',
        busboy: '^1.6.0',
        'concat-stream': '^2.0.0',
        'type-is': '^1.6.18',
      },
    );
    assert.deepEqual(
      packageLock.packages['node_modules/multer'].funding,
      {
        type: 'opencollective',
        url: 'https://opencollective.com/express',
      },
    );
    for (const dependency of [
      'minimist',
      'mkdirp',
      'object-assign',
      'xtend',
    ]) {
      assert.equal(
        Object.hasOwn(packageLock.packages, `node_modules/${dependency}`),
        false,
      );
    }
    assert.equal(packageJson.dependencies['form-data'], '^4.0.6');
    assert.equal(lockRoot.dependencies['form-data'], '^4.0.6');
    assert.equal(
      packageLock.packages['node_modules/form-data'].version,
      '4.0.6',
    );
    assert.equal(
      packageLock.packages['node_modules/form-data'].dependencies.hasown,
      '^2.0.4',
    );
    assert.equal(
      packageLock.packages['node_modules/form-data'].dependencies['mime-types'],
      '^2.1.35',
    );
    assert.equal(packageLock.packages['node_modules/hasown'].version, '2.0.4');
    assert.equal(packageLock.packages['node_modules/mime-types'].version, '3.0.1');
    assert.match(
      withoutComments(sendEmailSource),
      /^\s*import\s+FormData\s+from\s+['"]form-data['"];/mu,
    );
    assert.match(
      withoutComments(sendEmailSource),
      /new\s+Mailgun\(FormData\)/u,
    );
    assert.equal(packageJson.dependencies.ejs, '3.1.10');
    assert.equal(lockRoot.dependencies.ejs, '3.1.10');
    assert.equal(packageLock.packages['node_modules/ejs'].version, '3.1.10');
    assert.equal(packageJson.dependencies['ejs-mate'], '^4.0.0');
    assert.equal(packageLock.packages['node_modules/ejs-mate'].version, '4.0.0');
    assert.match(
      withoutComments(sendEmailSource),
      /^\s*import\s+ejs\s+from\s+['"]ejs['"];/mu,
    );
    assert.match(
      withoutComments(sendEmailSource),
      /renderTemplate\s*=\s*ejs\.renderFile/u,
    );
    assert.equal(packageJson.dependencies.cloudinary, '1.41.3');
    assert.equal(packageLock.packages['node_modules/cloudinary'].version, '1.41.3');
    assert.equal(
      Object.hasOwn(packageLock.packages['node_modules/cloudinary'], 'peer'),
      false,
    );

    for (const dependency of removedDependencies) {
      assert.equal(Object.hasOwn(packageJson.dependencies, dependency), false);
      assert.equal(Object.hasOwn(lockRoot.dependencies, dependency), false);
      assert.equal(
        Object.hasOwn(packageLock.packages, `node_modules/${dependency}`),
        false,
      );
    }
  });

  test('tracked production and maintenance sources do not import removed packages', async () => {
    const roots = ['config', 'controllers', 'models', 'routes', 'scripts', 'utils'];
    const files = ['app.js', 'middleware.js'];
    for (const directory of roots) {
      files.push(...await listJavaScriptFiles(directory));
    }
    const publicJavaScriptFiles = await listJavaScriptFiles('public/js');
    files.push(...publicJavaScriptFiles.filter(file => (
      !file.includes(`${path.sep}external-scripts${path.sep}`) &&
      !file.endsWith(`${path.sep}swiper-bundle.min.js`)
    )));

    for (const file of files) {
      const source = withoutComments(await readFile(path.join(root, file), 'utf8'));
      for (const dependency of removedDependencies) {
        const activeImport = new RegExp(
          `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|^\\s*import\\s*)['"]${dependency}(?:\\/[^'"]*)?['"]`,
          'mu',
        );
        assert.doesNotMatch(source, activeImport, `${file} imports ${dependency}`);
      }
    }
  });

  test('Cloudinary remains an active direct runtime dependency', async () => {
    const [configuration, mediaController] = await Promise.all([
      readFile(path.join(root, 'config/cloudinary.js'), 'utf8'),
      readFile(path.join(root, 'controllers/media.js'), 'utf8'),
    ]);

    assert.match(
      configuration,
      /^import \{ v2 as cloudinary \} from 'cloudinary';$/mu,
    );
    assert.match(
      mediaController,
      /^import \{ v2 as cloudinary \} from 'cloudinary';$/mu,
    );
  });

  test('middleware keeps memory uploads and removes only stale dependency code', async () => {
    const middleware = await readFile(path.join(root, 'middleware.js'), 'utf8');

    assert.doesNotMatch(middleware, /^import .* from ['"]mongoose['"];?$/mu);
    assert.doesNotMatch(middleware, /^import .*utils\/logging\.js['"];?$/mu);
    assert.doesNotMatch(middleware, /CloudinaryStorage|multer-storage-cloudinary/u);
    assert.doesNotMatch(middleware, /^import .*config\/cloudinary\.js['"];?$/mu);
    assert.doesNotMatch(middleware, /^import .* from ['"](?:node:)?url['"];?$/mu);
    assert.doesNotMatch(middleware, /checkMongoConnection/u);
    assert.match(middleware, /^import multer from 'multer';$/mu);
    assert.match(middleware, /export const uploadMemory = multer\(\{/u);
    assert.match(middleware, /storage: multer\.memoryStorage\(\)/u);
    assert.match(
      middleware,
      /const PHOTO_UPLOAD_LIMITS = Object\.freeze\(\{[\s\S]*?\}\);/u,
    );
  });
});
