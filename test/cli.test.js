'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { mockProvider, setup, cli, cliAsync, SRC } = require('./helpers');
const VERSION = require('../package.json').version;

const LANES = { edit: [['a', 'model-a']], plan: [['a', 'model-a']] };

test('version, help and unknown commands', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  assert.match(cli(['version'], s.env).stdout, new RegExp('^agt ' + VERSION.replace(/\./g, '\\.')));
  assert.match(cli(['--version'], s.env).stdout, new RegExp('^agt ' + VERSION.replace(/\./g, '\\.')));
  const h = cli(['help'], s.env);
  assert.strictEqual(h.status, 0);
  for (const w of ['chat', 'doctor', 'router', 'undo', 'config', 'resources', 'tasks', 'manus/agent', 'sessions rm']) assert.match(h.stdout, new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(cli(['help', 'undo'], s.env).stdout, /restore a file/);
  for (const cmd of ['chat', 'resume', 'setup', 'keys', 'models', 'router', 'health', 'stats', 'doctor', 'logs', 'sessions', 'tasks', 'show', 'changes', 'undo', 'config', 'resources', 'update', 'help', 'version']) {
    const page = cli(['help', cmd], s.env);
    assert.strictEqual(page.status, 0, `help for ${cmd} should be available`);
    assert.match(page.stdout, new RegExp(`Usage: agt ${cmd}|Usage: agt \\[`), `help for ${cmd} should show usage`);
  }
  assert.strictEqual(cli(['help', 'not-a-command'], s.env).status, 1);
  assert.match(cli(['help', 'tasks'], s.env).stdout, /remote Manus account tasks/);
  const bad = cli(['nonsense'], s.env);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /unknown command/);
});

test('first run creates the data folder and a default config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-first-'));
  const env = { ...process.env, AGT_HOME: path.join(home, 'data'), NO_COLOR: '1', AGT_NO_UPDATE_CHECK: '1' };
  const r = cli(['config', 'path'], env);
  assert.strictEqual(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'data', 'config.json'), 'utf8'));
  assert.strictEqual(cfg.defaultLane, 'edit');
  assert.strictEqual(cfg.providers.manus.type, 'manus');
  assert.strictEqual(cfg.providers.manus.keyEnv, 'MANUS_API_KEY');
  assert.strictEqual(cfg.manusTimeoutSec, 600);
  assert.deepStrictEqual(cfg.lanes.edit[0], ['groq', 'openai/gpt-oss-120b']);
  assert.ok(!JSON.stringify(cfg.lanes.edit).includes('qwen'), 'qwen was removed from the edit lane');
});

test('doctor reports a healthy setup against a mock provider', async t => {
  const a = await mockProvider(() => null);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const r = await cliAsync(['doctor'], s.env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /A_KEY is set/);
  assert.match(r.stdout, /a reachable, key accepted/);
  assert.match(r.stdout, /router is not running/);
  assert.match(r.stdout, /0 problems/);
});

test('doctor flags a missing key and a rejected key', async t => {
  const a = await mockProvider(() => null);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const missing = await cliAsync(['doctor'], { ...s.env, A_KEY: '' });
  assert.match(missing.stdout, /A_KEY is not set/);
  const quoted = await cliAsync(['doctor'], { ...s.env, A_KEY: '"abc"' });
  assert.match(quoted.stdout, /stray quotes/);
});

test('doctor shows a provider rejecting the key', async t => {
  const a = await mockProvider(() => null);
  a.server.removeAllListeners('request');
  a.server.on('request', (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid key"}'); });
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const r = await cliAsync(['doctor'], s.env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /HTTP 401/);
  assert.match(r.stdout, /the key was rejected/);
});

test('doctor reports a broken config instead of crashing', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  fs.writeFileSync(path.join(s.home, 'config.json'), '{ not json');
  const r = cli(['doctor'], s.env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /not valid JSON/);
  const other = cli(['stats'], s.env);
  assert.strictEqual(other.status, 1);
  assert.match(other.stdout, /agt config edit/);
});

test('config validation catches bad lanes and providers', async () => {
  const G = require(path.join(SRC, 'common.js'));
  const issues = G.validateConfig({ defaultLane: 'x', providers: { p: { url: 'u' } }, lanes: { x: [['nope', 'm']], y: [] } });
  assert.ok(issues.some(i => /missing "keyEnv"/.test(i)));
  assert.ok(issues.some(i => /unknown provider "nope"/.test(i)));
  assert.ok(issues.some(i => /lane y: must be a non-empty list/.test(i)));
  const manusLane = G.validateConfig({ defaultLane: 'x', providers: { manus: { type: 'manus', url: 'u', keyEnv: 'M' } }, lanes: { x: [['manus', 'agent']] } });
  assert.ok(manusLane.some(i => /Manus is asynchronous/.test(i)));
});

test('router start / health / stop lifecycle through the CLI', async t => {
  const a = await mockProvider(() => null);
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  t.after(async () => { await cliAsync(['router', 'stop'], s.env); await a.close(); });
  assert.strictEqual(cli(['health'], s.env).status, 1);
  const start = cli(['router', 'start'], s.env);
  assert.strictEqual(start.status, 0, start.stdout + start.stderr);
  assert.match(start.stdout, /started/);
  assert.match(cli(['router', 'start'], s.env).stdout, /already running/);
  const h = cli(['health', '--json'], s.env);
  assert.strictEqual(JSON.parse(h.stdout).status, 'ok');
  const deep = await cliAsync(['health', '--deep'], s.env);
  assert.match(deep.stdout, /Live probe\n\s+✓ a/);
  assert.match(cli(['logs', 'router'], s.env).stdout, /start/);
  assert.match(cli(['router', 'stop'], s.env).stdout, /stopped/);
  assert.strictEqual(cli(['health'], s.env).status, 1);
});

test('router stop refuses a corrupt PID 0 instead of signaling the process group', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  fs.writeFileSync(path.join(s.home, 'router.pid'), '0');
  const r = cli(['router', 'stop'], s.env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /refusing to signal an invalid PID/);
});

test('chat refuses to run without a terminal', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const r = cli(['chat'], s.env, { input: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /interactive terminal/);
});

test('sessions, changes and undo work on an empty history', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  assert.match(cli(['sessions'], s.env).stdout, /no saved sessions/);
  assert.match(cli(['changes'], s.env).stdout, /no changes recorded/);
  const u = cli(['undo'], s.env, { cwd: os.tmpdir() });
  assert.strictEqual(u.status, 1);
  assert.match(u.stdout, /nothing to undo/);
  assert.strictEqual(cli(['show', 'nope'], s.env).status, 1);
});

test('sessions rm requires an exact full id and confirmation, then removes session snapshots but keeps undo backups', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const sessions = path.join(s.home, 'sessions');
  const id = '20261115000000-abcd';
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ id, cwd: os.tmpdir(), lane: 'edit', model: 'manus/agent', messages: [{ role: 'user', content: 'private chat' }], updated: new Date().toISOString(), manusTaskId: 'remote-1' }));
  fs.writeFileSync(path.join(sessions, `${id}.123.precompact.bak`), 'full history snapshot');
  fs.writeFileSync(path.join(sessions, `${id}.json.tmp`), 'temporary session file');
  const undoBackup = path.join(s.home, 'backups', 'session', '1-note.txt');
  fs.mkdirSync(path.dirname(undoBackup), { recursive: true });
  fs.writeFileSync(undoBackup, 'preserve for undo');

  const noConfirm = cli(['sessions', 'rm', id], s.env);
  assert.strictEqual(noConfirm.status, 1);
  assert.match(noConfirm.stdout, /rerun with --yes/);
  assert.ok(fs.existsSync(path.join(sessions, `${id}.json`)));

  const partial = cli(['sessions', 'rm', id.slice(0, 15), '--yes'], s.env);
  assert.strictEqual(partial.status, 1);
  assert.match(partial.stdout, /use the full session id/);

  const deleted = cli(['sessions', 'rm', id, '--yes'], s.env);
  assert.strictEqual(deleted.status, 0, deleted.stdout + deleted.stderr);
  assert.match(deleted.stdout, /deleted local chat/);
  assert.ok(!fs.existsSync(path.join(sessions, `${id}.json`)));
  assert.ok(!fs.existsSync(path.join(sessions, `${id}.123.precompact.bak`)));
  assert.ok(!fs.existsSync(path.join(sessions, `${id}.json.tmp`)));
  assert.strictEqual(fs.readFileSync(undoBackup, 'utf8'), 'preserve for undo');
});

test('AGT refuses a symlinked private sessions directory instead of reading outside data', { skip: process.platform === 'win32' }, async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-outside-sessions-'));
  fs.writeFileSync(path.join(outside, 'private.json'), JSON.stringify({ id: 'private', cwd: outside, messages: [{ role: 'user', content: 'outside' }] }));
  fs.rmSync(path.join(s.home, 'sessions'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(s.home, 'sessions'), 'dir');
  const r = cli(['sessions'], s.env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /private directory must not be a symlink/);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'private.json'), 'utf8').includes('outside'), true);
});

test('agt stats reads the last persisted daily snapshot when the router is stopped', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  fs.writeFileSync(path.join(s.home, 'router-stats.json'), JSON.stringify({ daily: { '2026-11-15': { 'a/model-a': { ok: 4, fail: 2 } } } }));
  const r = cli(['stats'], s.env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /router is stopped; showing the last persisted snapshot/);
  assert.match(r.stdout, /4 ok/);
  assert.match(r.stdout, /2 failed/);
});

test('undo restores a backed-up file and refuses when the file changed since', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-proj-')));
  const file = path.join(proj, 'x.txt');
  const backup = path.join(s.home, 'backups', 'sess', '1-x.txt');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, 'old');
  fs.writeFileSync(file, 'new');
  const sha = require('crypto').createHash('sha1').update('new').digest('hex');
  fs.writeFileSync(path.join(s.home, 'changes.jsonl'), JSON.stringify({ id: 1, ts: new Date().toISOString(), action: 'edit', status: 'applied', path: 'x.txt', abs: file, cwd: proj, backup, sha_after: sha, added: 1, removed: 1 }) + '\n');

  fs.writeFileSync(file, 'someone edited this');
  const refused = cli(['undo'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stdout, /changed since then/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'someone edited this');

  const forced = cli(['undo', '--force'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(forced.status, 0, forced.stdout);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old');
  assert.match(cli(['changes'], s.env).stdout, /undone/);
});

test('undo rejects forged absolute paths and symlinked project or backup targets', { skip: process.platform === 'win32' }, async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-undo-safe-')));
  const outside = path.join(os.tmpdir(), `agt-outside-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'must stay unchanged');
  const inside = path.join(proj, 'inside.txt');
  fs.writeFileSync(inside, 'new');
  const sha = require('crypto').createHash('sha1').update('new').digest('hex');
  const log = path.join(s.home, 'changes.jsonl');

  fs.writeFileSync(log, JSON.stringify({ id: 11, ts: new Date().toISOString(), action: 'write', status: 'applied', path: 'inside.txt', abs: outside, cwd: proj, backup: null, sha_after: sha }) + '\n');
  const forged = cli(['undo', '11'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(forged.status, 1);
  assert.match(forged.stdout, /does not match/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'must stay unchanged');

  const backup = path.join(s.home, 'backups', 'sess', 'outside.txt');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.symlinkSync(outside, backup);
  fs.writeFileSync(log, JSON.stringify({ id: 12, ts: new Date().toISOString(), action: 'write', status: 'applied', path: 'inside.txt', abs: inside, cwd: proj, backup, sha_after: sha }) + '\n');
  const backupLink = cli(['undo', '12'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(backupLink.status, 1);
  assert.match(backupLink.stdout, /symbolic links are not allowed in backups/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'must stay unchanged');

  const alias = path.join(proj, 'alias.txt');
  fs.symlinkSync(outside, alias);
  fs.writeFileSync(log, JSON.stringify({ id: 13, ts: new Date().toISOString(), action: 'write', status: 'applied', path: 'alias.txt', abs: alias, cwd: proj, backup: null, sha_after: sha }) + '\n');
  const targetLink = cli(['undo', '13', '--force'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(targetLink.status, 1);
  assert.match(targetLink.stdout, /unsafe undo target|symbolic links/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'must stay unchanged');
});
