'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectPath } = require('../src/path-policy');

function tempDir(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

test('project path policy permits ordinary files but blocks secret-like names and .git at every depth', () => {
  const root = tempDir('agt-path-root-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'ok');
  fs.writeFileSync(path.join(root, '.env.example'), 'template');
  assert.strictEqual(projectPath(root, 'src/index.js'), path.join(root, 'src', 'index.js'));
  assert.strictEqual(projectPath(root, '.env.example'), path.join(root, '.env.example'));
  for (const name of ['.env', 'credentials.json', 'secrets.txt', 'id_rsa', 'private.pem', 'folder/secrets/key.txt', '.git/config']) {
    assert.throws(() => projectPath(root, name), /secret-like|\.git/ , `expected ${name} to be blocked`);
  }
});

test('project path policy rejects symlinked parents even when the destination is missing', { skip: process.platform === 'win32' }, () => {
  const root = tempDir('agt-path-root-'), outside = tempDir('agt-path-outside-');
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
  fs.writeFileSync(path.join(outside, 'present.txt'), 'outside');
  assert.throws(() => projectPath(root, 'link/present.txt'), /symbolic links/);
  assert.throws(() => projectPath(root, 'link/new.txt'), /symbolic links/);
  assert.throws(() => projectPath(root, 'link/.git/config'), /\.git|symbolic links/);
});

test('project path policy rejects a symlink alias to the repository git directory', { skip: process.platform === 'win32' }, () => {
  const root = tempDir('agt-path-root-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'metadata'), 'dir');
  assert.throws(() => projectPath(root, 'metadata/config'), /symbolic links/);
});
