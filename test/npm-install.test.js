'use strict';
// Packs the project exactly as `npm publish` would, installs the tarball into a throwaway prefix,
// and runs the installed command. This is what proves "npm install -g agt-cli" works.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const npmBin = WIN ? 'npm.cmd' : 'npm';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-npm-'));
const npm = (args, extra = {}) => spawnSync(npmBin, args, {
  cwd: ROOT, encoding: 'utf8', shell: WIN, timeout: 120000,
  env: { ...process.env, npm_config_cache: path.join(tmp, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' }, ...extra,
});
const available = !npm(['--version']).error;
const VERSION = require('../package.json').version;

test('npm pack contains what users need and none of what they do not', { skip: !available && 'npm not available' }, () => {
  const r = npm(['pack', '--json', '--pack-destination', tmp]);
  assert.strictEqual(r.status, 0, r.stderr);
  const info = JSON.parse(r.stdout)[0];
  const files = info.files.map(f => f.path.replace(/\\/g, '/'));
  for (const need of ['package.json', 'README.md', 'LICENSE', 'bin/agt.js', 'src/cli.js', 'src/router.js', 'src/common.js', 'src/keys.js', 'src/manus.js', 'src/path-policy.js', 'src/textutil.js', 'resources/manus/AGT_INSTRUCTIONS.md', 'resources/templates/PROJECT_KNOWLEDGE.md', 'resources/skills/testing-debugging.md', 'docs/MANUS.md', 'scripts/postinstall.js'])
    assert.ok(files.includes(need), `missing ${need}`);
  for (const bad of files.filter(f => /^(test|\.github|\.git|node_modules)\//.test(f) || f === 'install.js'))
    assert.fail(`should not be published: ${bad}`);
  assert.ok(info.size < 250 * 1024, `package is unexpectedly large: ${info.size} bytes`);
  fs.writeFileSync(path.join(tmp, 'tarball.txt'), path.join(tmp, info.filename));
});

test('installing the tarball gives working agt and agt-cli commands', { skip: !available && 'npm not available' }, () => {
  const tarball = fs.readFileSync(path.join(tmp, 'tarball.txt'), 'utf8');
  const prefix = path.join(tmp, 'prefix');
  const r = npm(['install', '-g', '--prefix', prefix, '--prefer-offline', tarball]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const bin = name => (WIN ? path.join(prefix, name + '.cmd') : path.join(prefix, 'bin', name));
  const env = { ...process.env, AGT_HOME: path.join(tmp, 'data'), AGT_NO_UPDATE_CHECK: '1', NO_COLOR: '1', A_KEY: '', GEMINI_API_KEY: '', GROQ_API_KEY: '' };
  for (const name of ['agt', 'agt-cli']) {
    assert.ok(fs.existsSync(bin(name)), `${name} command was not created`);
    const v = spawnSync(bin(name), ['version'], { encoding: 'utf8', env, shell: WIN, timeout: 30000 });
    assert.strictEqual(v.status, 0, v.stdout + v.stderr);
    assert.strictEqual(v.stdout.trim(), `agt ${VERSION}`);
  }
  const help = spawnSync(bin('agt'), ['help'], { encoding: 'utf8', env, shell: WIN, timeout: 30000 });
  for (const word of ['setup', 'models', 'update', 'doctor']) assert.match(help.stdout, new RegExp(word));
  const resources = spawnSync(bin('agt'), ['resources'], { encoding: 'utf8', env, shell: WIN, timeout: 30000 });
  assert.strictEqual(resources.status, 0, resources.stdout + resources.stderr);
  assert.ok(fs.existsSync(path.join(env.AGT_HOME, 'manus-instructions.md')));
  assert.ok(fs.existsSync(path.join(env.AGT_HOME, 'resources', 'templates', 'PROJECT_KNOWLEDGE.md')));
  assert.ok(fs.existsSync(path.join(env.AGT_HOME, 'resources', 'skills', 'testing-debugging.md')));
  const doc = spawnSync(bin('agt'), ['doctor'], { encoding: 'utf8', env, shell: WIN, timeout: 30000 });
  assert.strictEqual(doc.status, 0, doc.stdout + doc.stderr);
  assert.match(doc.stdout, /0 problems/);
});

test('npm upgrades the same global prefix when the package version increases and preserves AGT_HOME', { skip: !available && 'npm not available' }, () => {
  const tarball = fs.readFileSync(path.join(tmp, 'tarball.txt'), 'utf8');
  const prefix = path.join(tmp, 'upgrade-prefix'), old = path.join(tmp, 'old-package');
  fs.mkdirSync(path.join(old, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: 'agt-cli', version: '1.1.0', bin: { agt: 'bin/agt.js' } }));
  fs.writeFileSync(path.join(old, 'bin', 'agt.js'), '#!/usr/bin/env node\nconsole.log("agt 1.1.0")\n');
  const installOld = npm(['install', '-g', '--prefix', prefix, old]);
  assert.strictEqual(installOld.status, 0, installOld.stdout + installOld.stderr);
  const bin = process.platform === 'win32' ? path.join(prefix, 'agt.cmd') : path.join(prefix, 'bin', 'agt');
  const before = spawnSync(bin, ['version'], { encoding: 'utf8', shell: WIN });
  assert.strictEqual(before.stdout.trim(), 'agt 1.1.0');
  const data = path.join(tmp, 'upgrade-data'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'user-note.txt'), 'keep this');
  const installNew = npm(['install', '-g', '--prefix', prefix, tarball]);
  assert.strictEqual(installNew.status, 0, installNew.stdout + installNew.stderr);
  const after = spawnSync(bin, ['version'], { encoding: 'utf8', env: { ...process.env, AGT_HOME: data, AGT_NO_UPDATE_CHECK: '1' }, shell: WIN });
  assert.strictEqual(after.stdout.trim(), `agt ${VERSION}`);
  assert.strictEqual(fs.readFileSync(path.join(data, 'user-note.txt'), 'utf8'), 'keep this');
});
