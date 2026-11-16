'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { setup, cli, mockProvider, cliAsync } = require('./helpers');

const LANES = { edit: [['a', 'model-a']] };

test('keys file parser accepts shell-style and plain lines', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-k-'));
  process.env.AGT_HOME = home; // before requiring: paths are fixed at load time
  const K = require('../src/keys');
  const v = K.parse(['# comment', 'export A="one"', "B='two'", 'C=three # trailing', '', 'bad line', 'D=""'].join('\n'));
  assert.deepStrictEqual(v, { A: 'one', B: 'two', C: 'three', D: '' });
});

test('agt keys set --stdin saves a private file, list never prints the value, doctor shows the source', async t => {
  const a = await mockProvider(() => null);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const env = { ...s.env }; delete env.A_KEY; // so the keys file is the only source

  const r = cli(['keys', 'set', 'a', '--stdin', '--no-test'], env, { input: 'sk-test-12345\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /saved A_KEY/);
  const file = path.join(s.home, 'keys.env');
  assert.match(fs.readFileSync(file, 'utf8'), /^A_KEY="sk-test-12345"$/m);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

  const list = cli(['keys', 'list'], env);
  assert.match(list.stdout, /a\s+A_KEY · 13 chars · from keys file/);
  assert.ok(!list.stdout.includes('sk-test-12345'));

  const doc = await cliAsync(['doctor'], env);
  assert.match(doc.stdout, /A_KEY is set \(13 chars, from keys file\)/);
  assert.match(doc.stdout, /a reachable, key accepted/);

  assert.match(cli(['keys', 'remove', 'a'], env).stdout, /removed A_KEY/);
  assert.match(cli(['keys', 'list'], env).stdout, /not set/);
});

test('real environment variables win over the keys file', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  fs.writeFileSync(path.join(s.home, 'keys.env'), 'A_KEY="from-file"\n');
  const r = cli(['keys', 'list'], { ...s.env, A_KEY: 'from-env' });
  assert.match(r.stdout, /A_KEY · 8 chars · from environment/);
});

test('keys reload updates and removes values loaded from the private file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-key-reload-'));
  const script = `
    const fs = require('fs'), path = require('path');
    const K = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'keys.js'))});
    const file = path.join(process.env.AGT_HOME, 'keys.env');
    fs.writeFileSync(file, 'MANUS_API_KEY="first"\\n');
    K.loadKeys();
    if (process.env.MANUS_API_KEY !== 'first') throw new Error('first load failed');
    fs.writeFileSync(file, 'MANUS_API_KEY="second"\\n');
    K.loadKeys();
    if (process.env.MANUS_API_KEY !== 'second') throw new Error('replacement was not loaded');
    fs.writeFileSync(file, '');
    K.loadKeys();
    if (process.env.MANUS_API_KEY) throw new Error('removed file key is still loaded');
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, AGT_HOME: home, MANUS_API_KEY: '' } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('keys with spaces, quotes or nothing at all are refused', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const env = { ...s.env }; delete env.A_KEY;
  const bad = cli(['keys', 'set', 'a', '--stdin', '--no-test'], env, { input: 'two words\n' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /cannot contain/);
  const empty = cli(['keys', 'set', 'a', '--stdin', '--no-test'], env, { input: '\n' });
  assert.strictEqual(empty.status, 1);
  assert.match(empty.stdout, /nothing entered/);
  assert.ok(!fs.existsSync(path.join(s.home, 'keys.env')));
});

test('keys set refuses a symlinked keys.env and leaves its target unchanged', { skip: process.platform === 'win32' }, async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const outside = path.join(os.tmpdir(), `agt-outside-keys-${process.pid}-${Date.now()}`);
  fs.writeFileSync(outside, 'do-not-overwrite\n');
  fs.symlinkSync(outside, path.join(s.home, 'keys.env'));
  const env = { ...s.env }; delete env.A_KEY;
  const r = cli(['keys', 'set', 'a', '--stdin', '--no-test'], env, { input: 'replacement-key\n' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /regular file, not a symlink/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'do-not-overwrite\n');
  assert.ok(!r.stdout.includes('replacement-key'));
});

test('the router also reads the keys file (so a standalone router works)', async t => {
  const { startRouter, waitUp, post } = require('./helpers');
  const a = await mockProvider(() => null);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const env = { ...s.env }; delete env.A_KEY;
  fs.writeFileSync(path.join(s.home, 'keys.env'), 'A_KEY="file-key"\n');
  const child = startRouter(env);
  t.after(() => child.kill());
  await waitUp(s.base);
  const r = await post(s.base, { model: 'edit', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(a.seen.find(x => x.url.endsWith('/chat/completions')).auth, 'Bearer file-key');
});
