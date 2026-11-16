#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), readline = require('readline'), crypto = require('crypto');
const { spawn, spawnSync, exec } = require('child_process');
const G = require('./common');
const T = require('./textutil');
const K = require('./keys');
const Manus = require('./manus');
const PathPolicy = require('./path-policy');
const { P, c, sym } = G;
const PKG_NAME = require('../package.json').name;

const out = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = n => crypto.randomBytes(n).toString('hex');
const num = n => Number(n || 0).toLocaleString('en-US');

K.loadKeys();
let CFG, CFG_ERR = null;
try { CFG = G.loadConfig(); } catch (e) { CFG_ERR = e; CFG = { ...G.DEFAULT_CONFIG }; }
const base = () => `http://127.0.0.1:${CFG.port}`;

// chat state (module level so helpers can use it)
let S = null, ROOT = process.cwd(), lane = CFG.defaultLane, model = null, debug = false;
let ask, flush = () => {};
function askOnce(q) {
  return new Promise(res => { const r = readline.createInterface({ input: process.stdin, output: process.stdout }); r.question(q, a => { r.close(); res(a); }); });
}
ask = askOnce;

function parseArgs(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n') flags.n = args[++i];
    else if (a === '-f') flags.follow = true;
    else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else if (a === '--model' || a === '--lane') flags[a.slice(2)] = args[++i];
    else if (a === '--limit' || a === '--cursor') flags[a.slice(2)] = args[++i];
    else if (a.startsWith('--')) { const raw = a.slice(2), eq = raw.indexOf('='); const k = eq < 0 ? raw : raw.slice(0, eq), v = eq < 0 ? undefined : raw.slice(eq + 1); flags[k] = v === undefined ? true : v; }
    else pos.push(a);
  }
  return { flags, pos };
}

function lg(level, event, data = {}) {
  const rec = { ts: new Date().toISOString(), level, event, session: S && S.id, ...data };
  G.appendJsonl(P.agentLog, rec);
  if (debug) out(c.dim('  ' + G.formatLog(rec)));
}

// ================= router control =================
async function rget(p, { method = 'GET', timeout = 2500 } = {}) {
  try {
    const r = await fetch(base() + p, {
      method, signal: AbortSignal.timeout(timeout),
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    });
    let json = null; try { json = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json };
  } catch { return null; }
}
async function startRouter() {
  const cur = await rget('/health');
  if (cur && cur.json && cur.json.status) return { already: true, health: cur.json };
  G.ensureDirs();
  const fd = G.openPrivateAppend(P.routerOut);
  let child;
  try { child = spawn(process.execPath, [path.join(__dirname, 'router.js')], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env }); }
  finally { try { fs.closeSync(fd); } catch {} }
  let spawnErr = null;
  child.on('error', e => { spawnErr = e; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await rget('/health');
    if (r && r.json && r.json.status) return { started: true, health: r.json };
    if (spawnErr || child.exitCode !== null) break;
  }
  throw new Error('router did not start.\n' + G.tailFile(P.routerOut, 15).join('\n') + '\n(more: agt logs router)');
}
async function stopRouter() {
  const r = await rget('/admin/shutdown', { method: 'POST' });
  if (r && r.ok) { for (let i = 0; i < 20; i++) { await sleep(150); if (!(await rget('/health', { timeout: 500 }))) break; } return 'stopped'; }
  if (r) return 'could not stop it (an old router? end the node process that runs it, or restart your terminal)';
  let pid;
  try {
    const raw = G.readPrivateFile(P.pid).trim();
    if (!/^[1-9]\d{0,9}$/.test(raw)) return 'refusing to signal an invalid PID from the router file';
    pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid === process.pid) return 'refusing to signal an invalid or current-process PID';
    process.kill(pid, 0);
  } catch (e) { return e.code === 'ENOENT' || e.code === 'ESRCH' ? 'not running (stale PID file)' : e.code === 'EPERM' ? 'cannot verify permission to stop the router process' : 'not running'; }
  const expected = path.resolve(__dirname, 'router.js');
  const check = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    : spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000 });
  if (check.error || check.status !== 0 || !String(check.stdout || '').includes(expected)) return `refusing to signal PID ${pid}; it is not verified as this AGT router`;
  try { process.kill(pid, 'SIGTERM'); await sleep(500); return 'stopped (via verified PID file)'; }
  catch (e) { return e.code === 'ESRCH' ? 'not running' : `could not stop verified router PID ${pid}: ${e.message}`; }
}

// ================= display helpers =================
const dot = s => ({ ok: c.green('● ok'), degraded: c.yellow('● degraded'), down: c.red('● down') }[s] || c.dim('● ' + s));
function printHealth(h) {
  out(`${c.bold('Router')}  ${dot(h.status)}`);
  out(c.dim(`  pid ${h.pid} · port ${h.port} · up ${G.dur(h.uptime_s)} · v${h.version}`));
  out(c.bold('Providers'));
  for (const p of h.providers) out(`  ${p.configured ? sym.ok : sym.fail} ${p.name} ${c.dim(p.keyEnv + (p.configured ? '' : ' (not set)'))}`);
  out(c.bold('Lanes'));
  for (const [n, l] of Object.entries(h.lanes)) out(`  ${n}: ${l.ready}/${l.steps} ready ${l.next ? '→ ' + c.cyan(l.next) : c.red('→ nothing available')}`);
  const cool = Object.entries(h.cooling);
  if (cool.length) { out(c.bold('Parked (cooling down)')); for (const [k, s] of cool) out(`  ${sym.warn} ${k} ${c.dim(s + 's left')}`); }
  if (h.probes) {
    out(c.bold('Live probe'));
    for (const p of h.probes) out(p.ok ? `  ${sym.ok} ${p.name} ${c.dim(p.ms + 'ms')}` : `  ${sym.fail} ${p.name} ${p.status ? 'HTTP ' + p.status : ''}\n${p.error}`);
  }
  if (h.issues && h.issues.length) { out(c.bold('Config notes')); for (const i of h.issues) out(`  ${sym.warn} ${i}`); }
}
function printLogLines(file, n) {
  const lines = G.tailFile(file, n);
  if (!lines.length) return out(c.dim('(empty)'));
  for (const l of lines) { try { out(G.formatLog(JSON.parse(l))); } catch { out(l); } }
}
function followLog(file) {
  fs.appendFileSync(file, '');
  let pos = fs.statSync(file).size, buf = '';
  const show = l => { try { out(G.formatLog(JSON.parse(l))); } catch { out(l); } };
  fs.watchFile(file, { interval: 400 }, st => {
    if (st.size < pos) pos = 0; // the log was rotated
    if (st.size === pos) return;
    const fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(st.size - pos);
    fs.readSync(fd, chunk, 0, chunk.length, pos);
    fs.closeSync(fd);
    pos = st.size;
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { show(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  process.on('SIGINT', () => { fs.unwatchFile(file); process.exit(0); });
}

// ================= sessions & change log =================
const nextId = () => `chg_${Date.now().toString(36)}_${rand(8)}`;
function logChange(rec) { G.appendJsonl(P.changes, { ts: new Date().toISOString(), session: S && S.id, cwd: ROOT, ...rec }); }
function privateCommandMeta(command) {
  const value = String(command || '');
  return { command_summary: 'command details omitted', command_length: Buffer.byteLength(value), command_sha256: crypto.createHash('sha256').update(value).digest('hex') };
}
function safeToolLogArgs(name, args) {
  if (name === 'run_command') return { path: ROOT, ...privateCommandMeta(args.command) };
  if (name === 'write_file') return { path: args.path, content_chars: String(args.content || '').length };
  if (name === 'edit_file') return { path: args.path, old_chars: String(args.old_str || '').length, new_chars: String(args.new_str || '').length };
  return args;
}
const sessionLocks = new Map();
const sessionLockPath = id => path.join(P.sessions, `.${id}.lock`);
function lockOwner(id) {
  const file = sessionLockPath(id);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (st.isSymbolicLink()) return { pid: null, malformed: true };
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const pid = Number(lock && lock.pid);
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); return lock; } catch (e) { if (e.code === 'EPERM') return lock; }
  } else if (Date.now() - st.mtimeMs < 30000) return { pid: null, malformed: true };
  try { fs.rmSync(file, { force: true }); } catch {}
  return null;
}
function sessionLockedByOther(id) {
  const owner = lockOwner(id);
  return !!owner && !sessionLocks.has(id);
}
function acquireSessionLock(id) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid session id');
  G.ensureDirs();
  const token = rand(16), file = sessionLockPath(id);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() }));
      fs.fsyncSync(fd); fs.closeSync(fd);
      sessionLocks.set(id, token);
      return;
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (e.code !== 'EEXIST') throw e;
      const owner = lockOwner(id);
      if (owner) throw new Error(`session ${id} is already active in process ${owner.pid || 'unknown'}; close that chat before resuming it`);
    }
  }
  throw new Error(`could not acquire a lock for session ${id}`);
}
function releaseSessionLock(id) {
  const token = sessionLocks.get(id);
  if (!token) return;
  try {
    const file = sessionLockPath(id), lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (lock.pid === process.pid && lock.token === token) fs.rmSync(file, { force: true });
  } catch {}
  sessionLocks.delete(id);
}
function listSessions() {
  try {
    const root = fs.realpathSync(P.sessions);
    return fs.readdirSync(P.sessions).filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const file = path.join(P.sessions, f), st = fs.lstatSync(file);
          if (st.isSymbolicLink() || !st.isFile() || !T.isInside(root, fs.realpathSync(file))) return null;
          const s = JSON.parse(fs.readFileSync(file, 'utf8'));
          const fileId = f.slice(0, -5);
          return s && typeof s.id === 'string' && s.id === fileId && /^[A-Za-z0-9_-]{1,128}$/.test(s.id) && Array.isArray(s.messages) ? s : null;
        } catch { return null; }
      })
      .filter(Boolean).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  } catch { return []; }
}
function sessionMatches(part, cwd) {
  const all = listSessions().filter(s => !cwd || s.cwd === cwd);
  if (!part) return all.length ? [all[0]] : [];
  const exact = all.filter(s => s.id === part);
  if (exact.length) return exact;
  const prefix = all.filter(s => s.id.startsWith(part));
  return prefix.length ? prefix : all.filter(s => s.id.includes(part));
}
function findSession(part, cwd) {
  const matches = sessionMatches(part, cwd);
  return matches.length === 1 ? matches[0] : null;
}
const newSession = () => ({ id: new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + rand(6), cwd: ROOT, lane, model, created: new Date().toISOString(), updated: new Date().toISOString(), title: '', messages: [], usage: { prompt: 0, completion: 0 } });
function saveSession() {
  if (!S || !S.messages.length) return;
  S.updated = new Date().toISOString(); S.lane = lane; S.model = model;
  const f = path.join(P.sessions, S.id + '.json');
  const tmp = `${f}.${process.pid}.${rand(6)}.tmp`;
  G.privateFilePath(f); G.privateFilePath(tmp);
  fs.writeFileSync(tmp, JSON.stringify(S), { flag: 'wx', mode: 0o600 });
  G.privateFilePath(f); fs.renameSync(tmp, f);
}

function copyMissingTree(from, to) {
  if (!fs.existsSync(from)) return;
  try {
    const dstStat = fs.lstatSync(to);
    if (dstStat.isSymbolicLink() || !dstStat.isDirectory()) throw new Error('Manus resources path must be a real directory, not a symlink');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const src = path.join(from, ent.name), dst = path.join(to, ent.name);
    let dstStat = null;
    try { dstStat = fs.lstatSync(dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (dstStat && dstStat.isSymbolicLink()) throw new Error('Manus resources cannot contain symbolic links');
    if (ent.isDirectory()) copyMissingTree(src, dst);
    else if (ent.isFile() && !dstStat) fs.copyFileSync(src, dst);
  }
}
function validatePrivateResourceRoot() {
  G.ensureDirs();
  fs.mkdirSync(P.resources, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(P.resources);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('AGT resources path must be a real directory, not a symlink');
  const homeReal = fs.realpathSync(P.home), resourcesReal = fs.realpathSync(P.resources);
  if (!T.isInside(homeReal, resourcesReal)) throw new Error('AGT resources path resolves outside the private data folder');
  return resourcesReal;
}
function ensureManusResources() {
  validatePrivateResourceRoot();
  const packaged = path.join(__dirname, '..', 'resources');
  copyMissingTree(packaged, P.resources);
  const instructions = path.join(packaged, 'manus', 'AGT_INSTRUCTIONS.md');
  try {
    const st = fs.lstatSync(P.manusInstructions);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('Manus instructions file must be a regular file, not a symlink');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (fs.existsSync(instructions)) fs.copyFileSync(instructions, P.manusInstructions, fs.constants.COPYFILE_EXCL);
  }
}
function readManusInstructions() {
  ensureManusResources();
  try {
    const st = fs.lstatSync(P.manusInstructions);
    if (st.isSymbolicLink() || !st.isFile()) return '';
    return fs.readFileSync(P.manusInstructions, 'utf8').slice(0, 6000);
  } catch { return ''; }
}
const { contextBlocked } = PathPolicy;
const contextIgnoredDirs = new Set(['.git', '.agt', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor']);
function selectedContextPaths() {
  const raw = String(process.env.AGT_MANUS_CONTEXT || 'tree').trim();
  if (!raw || raw === 'tree') return null;
  if (raw.toLowerCase() === 'none') return [];
  return raw.split(/[,\n]/).map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
}
function buildProjectContext() {
  const selected = selectedContextPaths();
  const root = ROOT;
  const tree = [];
  let visited = 0;
  const includePath = rel => !selected || selected.some(s => s === '.' || rel === s || rel.startsWith(s.replace(/\/$/, '') + '/') || s.startsWith(rel.replace(/\/$/, '') + '/'));
  const walk = (dir, prefix = '') => {
    if (visited >= 1000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const ent of entries) {
      if (visited >= 1000 || ent.isSymbolicLink() || contextBlocked(ent.name)) continue;
      if (ent.isDirectory() && contextIgnoredDirs.has(ent.name)) continue;
      const relPath = prefix ? prefix + '/' + ent.name : ent.name;
      if (!includePath(relPath)) continue;
      tree.push(relPath + (ent.isDirectory() ? '/' : ''));
      visited++;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), relPath);
    }
  };
  if (selected && selected.length === 0) return 'Directory tree omitted by AGT_MANUS_CONTEXT=none.';
  walk(root);
  let result = 'Directory tree (relative paths):\n' + (tree.join('\n') || '(empty or inaccessible)');
  const files = String(process.env.AGT_MANUS_CONTEXT_FILES || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  let chars = 0;
  for (const item of files) {
    let full;
    try { full = safe(item); } catch { continue; }
    const segments = path.relative(root, full).replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.some(s => contextIgnoredDirs.has(s))) continue;
    try {
      const lst = fs.lstatSync(full);
      if (!lst.isFile() || lst.isSymbolicLink() || lst.size > 24000) continue;
      if (!T.isInside(fs.realpathSync(root), fs.realpathSync(full))) continue;
      const content = fs.readFileSync(full, 'utf8');
      if (content.includes('\u0000')) continue;
      const section = `\n\nSelected file ${path.relative(root, full).replace(/\\/g, '/')} (explicitly included):\n${content}`;
      if (chars + section.length > 5000) break;
      result += section; chars += section.length;
    } catch {}
  }
  return result.slice(0, 7000);
}
function manusSeedHistory() {
  if (!S || !S.messages.length) return '';
  const rows = S.messages.slice(0, -1).map(m => {
    if (m.role === 'user') return `USER: ${m.content || ''}`;
    if (m.role === 'assistant') return `AGT ASSISTANT: ${m.content || ''}${(m.tool_calls || []).map(tc => `\nRequested local operation: ${tc.function.name} ${tc.function.arguments || ''}`).join('')}`;
    if (m.role === 'tool') return `LOCAL OPERATION RESULT: ${m.content || ''}`;
    return '';
  }).filter(Boolean);
  return rows.join('\n\n').slice(-3000);
}
function manusCurrentInput() {
  const last = S && S.messages[S.messages.length - 1];
  if (!last) return '';
  if (last.role === 'user') return String(last.content || '');
  if (last.role === 'tool') {
    const prior = [...S.messages.slice(0, -1)].reverse().find(m => m.role === 'assistant' && (m.tool_calls || []).some(tc => tc.id === last.tool_call_id));
    const call = prior && prior.tool_calls.find(tc => tc.id === last.tool_call_id);
    return `Result from AGT local operation${call ? ` ${call.function.name} ${call.function.arguments}` : ''}:\n${last.content || ''}`;
  }
  return String(last.content || '');
}
function isManusTarget() {
  const target = G.resolveTarget(CFG, model || lane);
  return !!(target && target.steps.some(([name]) => CFG.providers[name] && CFG.providers[name].type === 'manus'));
}

// ================= file review =================
const rel = full => path.relative(ROOT, full) || '.';
const noGit = full => { if (path.relative(ROOT, full).split(path.sep).some(s => s.toLowerCase() === '.git')) throw new Error('.git is off limits'); };
function safe(p) {
  const full = PathPolicy.projectPath(ROOT, p);
  noGit(full);
  return full;
}
const colorDiff = l => (l.startsWith('+') && !l.startsWith('+++') ? c.green(l) : l.startsWith('-') && !l.startsWith('---') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : c.dim(l));

function makeDiff(r, before, after) {
  return T.unifiedDiff(before, after, before === null ? '/dev/null' : 'a/' + r, 'b/' + r);
}

async function review(action, r, before, after) {
  const lines = makeDiff(r, before, after).replace(/\n$/, '').split('\n');
  const body = lines[0] && lines[0].startsWith('--- ') ? lines.slice(2) : lines;
  const added = body.filter(l => l.startsWith('+')).length;
  const removed = body.filter(l => l.startsWith('-')).length;
  out(`\n${c.yellow('▸ ' + action.toUpperCase())} ${c.bold(r)} ${c.dim(before === null ? '(new file)' : '')}`);
  out(`  ${c.green('+' + added)} ${c.red('-' + removed)} ${c.dim('lines')}`);
  const lim = CFG.previewLines || 20;
  lines.slice(0, lim).forEach(l => out('  ' + colorDiff(l)));
  if (lines.length > lim) out(c.dim(`  … ${lines.length - lim} more diff lines (press d)`));
  for (;;) {
    flush();
    const a = (await ask(`${c.bold('apply?')} ${c.dim('[y]es [n]o [d]iff [v]iew file [s]tage')} › `)).trim().toLowerCase();
    if (a === 'y' || a === 'yes') return { ok: true, added, removed };
    if (a === 'd') lines.forEach(l => out(colorDiff(l)));
    else if (a === 'v') out(c.dim('────── proposed file ──────') + '\n' + after + '\n' + c.dim('───────────────────────────'));
    else if (a === 's') {
      G.ensureDirs();
      const f = path.join(P.proposed, `${Date.now()}-${path.basename(r)}`);
      G.privateFilePath(f);
      fs.writeFileSync(f, after, { flag: 'wx', mode: 0o600 });
      out(c.dim(`  staged copy: ${f}\n  (your real file is untouched; open the copy in your editor, then answer here)`));
    } else if (a === 'n' || a === 'no' || a === '') {
      flush();
      return { ok: false, reason: (await ask(c.dim('  reason for the agent (optional) › '))).trim() };
    } else out(c.dim('  type y, n, d, v or s'));
  }
}

async function applyChange(action, full, before, after) {
  const r = rel(full);
  if (before === after) { out(`${c.cyan('▸')} ${action} ${r} ${c.dim('no change')}`); return 'No change: the file already has this content.'; }
  const d = await review(action, r, before, after);
  if (d.ok) {
    safe(r);
    noGit(full);
    let latest = null;
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('target is no longer a regular file');
      latest = fs.readFileSync(full, 'utf8');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (latest !== before) throw new Error(`file ${r} changed while approval was pending; no change was applied. Read it again and retry.`);
  }
  const id = nextId();
  if (!d.ok) {
    logChange({ id, action, status: 'denied', path: r, abs: full, reason: d.reason });
    out(`  ${sym.fail} denied`);
    return 'The user denied this change.' + (d.reason ? ' Reason: ' + d.reason : '');
  }
  let backup = null;
  if (before !== null) {
    backup = path.join(P.backups, S.id, `${id}-${path.basename(full)}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    G.privateFilePath(backup);
    fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  safe(r);
  const temp = `${full}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, after, { flag: 'wx' });
  try { fs.renameSync(temp, full); } catch (e) { try { fs.rmSync(temp, { force: true }); } catch {} throw e; }
  logChange({ id, action, status: 'applied', path: r, abs: full, existed: before !== null, backup, sha_before: before === null ? null : crypto.createHash('sha1').update(before).digest('hex'), sha_after: crypto.createHash('sha1').update(after).digest('hex'), added: d.added, removed: d.removed });
  out(`  ${sym.ok} applied ${c.dim('(change #' + id + ' · undo with /undo)')}`);
  return `${action === 'edit' ? 'Edited' : 'Wrote'} ${r} (+${d.added} -${d.removed} lines).`;
}

async function undoChange(askFn, id, force) {
  const all = G.readJsonl(P.changes);
  const undone = new Set(all.filter(x => x.action === 'undo' && x.status === 'applied').map(x => String(x.of)));
  const cand = all.filter(x => (x.action === 'write' || x.action === 'edit') && x.status === 'applied' && !undone.has(String(x.id)));
  const t = id ? cand.find(x => String(x.id) === String(id)) : cand.filter(x => x.cwd === ROOT).pop();
  if (!t) { out('nothing to undo' + (id ? ` (no undoable change #${id})` : ' in this folder')); return 1; }
  let full;
  try {
    if (typeof t.cwd !== 'string' || path.relative(path.resolve(ROOT), path.resolve(t.cwd)) !== '') throw new Error('change record belongs to a different project folder');
    if (typeof t.path !== 'string' || path.isAbsolute(t.path)) throw new Error('change record has an invalid relative path');
    full = safe(t.path);
    if (typeof t.abs !== 'string' || path.resolve(t.abs) !== full) throw new Error('change record path does not match its saved project-relative path');
  } catch (e) { out(`${sym.fail} unsafe undo target: ${e.message}`); return 1; }
  const backupFile = file => {
    if (typeof file !== 'string') throw new Error('change record has no valid backup path');
    const root = path.resolve(P.backups), abs = path.resolve(file);
    if (!T.isInside(root, abs) || abs === root) throw new Error('backup is outside AGT backups');
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('backup directory must be a real directory');
    let cursor = root;
    for (const part of path.relative(root, abs).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) throw new Error('symbolic links are not allowed in backups');
    }
    const st = fs.lstatSync(abs);
    if (!st.isFile()) throw new Error('backup is not a regular file');
    if (!T.isInside(fs.realpathSync(root), fs.realpathSync(abs))) throw new Error('backup resolves outside AGT backups');
    return abs;
  };
  const currentHash = () => {
    safe(t.path);
    let st;
    try { st = fs.lstatSync(full); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('undo target is not a regular file');
    return crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
  };
  let sha;
  try { sha = currentHash(); } catch (e) { out(`${sym.fail} unsafe undo target: ${e.message}`); return 1; }
  let validBackup = null;
  if (t.backup) {
    try {
      validBackup = backupFile(t.backup);
      const data = fs.readFileSync(validBackup);
      if (t.sha_before && crypto.createHash('sha1').update(data).digest('hex') !== t.sha_before) throw new Error('backup contents do not match the recorded original');
    } catch (e) { out(`${sym.fail} unsafe undo backup: ${e.message}`); return 1; }
  }
  out(`${c.yellow('▸ UNDO')} #${t.id} ${t.action} ${c.bold(t.path)} ${c.dim(G.ago(t.ts))}`);
  out(c.dim(t.backup ? '  restores the version from before this change' : '  deletes the file this change created'));
  if (sha !== t.sha_after && !force) { out(`${sym.warn} the file changed since then. Undo later changes first, or run: agt undo ${t.id} --force`); return 1; }
  const a = (await askFn('proceed? [y/N] › ')).trim().toLowerCase();
  if (a !== 'y' && a !== 'yes') { out('left as is'); return 0; }
  try {
    const latest = currentHash();
    if (latest !== t.sha_after && !force) throw new Error('the file changed while confirmation was pending; no undo was applied');
    if (validBackup) {
      validBackup = backupFile(t.backup);
      const fd = fs.openSync(validBackup, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let data;
      try { if (!fs.fstatSync(fd).isFile()) throw new Error('backup is not a regular file'); data = fs.readFileSync(fd); }
      finally { fs.closeSync(fd); }
      if (t.sha_before && crypto.createHash('sha1').update(data).digest('hex') !== t.sha_before) throw new Error('backup changed while confirmation was pending');
      const temp = `${full}.${process.pid}.${rand(6)}.undo`;
      fs.writeFileSync(temp, data, { flag: 'wx' });
      try { safe(t.path); fs.renameSync(temp, full); } catch (e) { try { fs.rmSync(temp, { force: true }); } catch {} throw e; }
    } else { safe(t.path); fs.rmSync(full, { force: true }); }
  } catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
  G.appendJsonl(P.changes, { id: nextId(), ts: new Date().toISOString(), action: 'undo', of: t.id, status: 'applied', cwd: ROOT, path: t.path });
  out(`${sym.ok} restored`);
  return 0;
}

// ================= tools =================
const clipForModel = s => {
  const max = CFG.maxToolChars;
  if (s.length <= max) return s;
  out(c.dim(`  (clipped for the model only: sent ${num(max)} of ${num(s.length)} chars)`));
  return s.slice(0, max) + `\n[clipped: showing ${max} of ${s.length} chars. Use start_line/end_line to read more.]`;
};

function safeResource(p) {
  ensureManusResources();
  const full = path.resolve(P.resources, p || '.');
  if (!T.isInside(P.resources, full)) throw new Error('resource path is outside AGT resources');
  const rootReal = validatePrivateResourceRoot();
  const relPath = path.relative(P.resources, full);
  let cursor = P.resources;
  for (const part of relPath.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('symbolic links are not allowed in resources');
  }
  if (relPath.split(path.sep).some(contextBlocked)) throw new Error('secret-like resource files are blocked');
  const real = fs.existsSync(full) ? fs.realpathSync(full) : full;
  if (!T.isInside(rootReal, real)) throw new Error('resource path resolves outside AGT resources');
  return full;
}

const tools = {
  async list_dir({ path: p }) {
    const full = safe(p);
    const items = fs.readdirSync(full, { withFileTypes: true }).filter(d => !['node_modules', '.git'].includes(d.name)).map(d => d.name + (d.isDirectory() ? '/' : ''));
    out(`${c.cyan('▸')} list_dir ${c.bold(rel(full))} ${c.dim(items.length + ' entries')}`);
    return items.join('\n') || '(empty)';
  },
  async read_file({ path: p, start_line, end_line }) {
    const full = safe(p);
    if (fs.statSync(full).isDirectory()) throw new Error(rel(full) + ' is a directory, not a file. Use list_dir to see what is inside.');
    let t = fs.readFileSync(full, 'utf8');
    if (t.includes('\u0000')) throw new Error('binary file, not readable as text');
    const total = t.split('\n').length;
    for (const [label, value] of [['start_line', start_line], ['end_line', end_line]]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${label} must be a positive integer`);
    }
    if (start_line && end_line && end_line < start_line) throw new Error('end_line must be greater than or equal to start_line');
    if (start_line || end_line) t = t.split('\n').slice((start_line || 1) - 1, end_line || undefined).join('\n');
    out(`${c.cyan('▸')} read_file ${c.bold(rel(full))} ${c.dim(total + ' lines, ' + G.bytes(Buffer.byteLength(t)) + (start_line || end_line ? `, range ${start_line || 1}-${end_line || total}` : ''))}`);
    return t;
  },
  async list_resources({ path: p }) {
    const full = safeResource(p);
    if (!fs.statSync(full).isDirectory()) throw new Error('resource path is not a directory');
    const items = fs.readdirSync(full, { withFileTypes: true }).filter(d => !d.isSymbolicLink() && !contextBlocked(d.name)).map(d => path.posix.join(path.relative(P.resources, path.join(full, d.name)).split(path.sep).join('/'), d.isDirectory() ? '' : '') + (d.isDirectory() ? '/' : ''));
    out(`${c.cyan('▸')} list_resources ${c.bold(path.relative(P.resources, full) || '.')} ${c.dim(items.length + ' entries')}`);
    return items.join('\n') || '(empty)';
  },
  async read_resource({ path: p }) {
    const full = safeResource(p);
    if (fs.statSync(full).isDirectory()) throw new Error('resource path is a directory. Use list_resources.');
    if (fs.statSync(full).size > 1e6) throw new Error('resource is too large to send to the model (maximum 1 MB)');
    const t = fs.readFileSync(full, 'utf8');
    if (t.includes('\u0000')) throw new Error('binary resource, not readable as text');
    out(`${c.cyan('▸')} read_resource ${c.bold(path.relative(P.resources, full))} ${c.dim(G.bytes(Buffer.byteLength(t)))}`);
    return t;
  },
  async write_file({ path: p, content }) {
    const full = safe(p); noGit(full);
    if (typeof content !== 'string') throw new Error('content must be a string');
    const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    return applyChange('write', full, before, before === null ? content : T.matchEol(content, before));
  },
  async edit_file({ path: p, old_str, new_str }) {
    const full = safe(p); noGit(full);
    if (!old_str || typeof new_str !== 'string') throw new Error('old_str and new_str are required');
    if (fs.statSync(full).isDirectory()) throw new Error(rel(full) + ' is a directory, not a file.');
    const before = fs.readFileSync(full, 'utf8');
    const e = T.applyEdit(before, old_str, new_str);
    if (!e.ok) throw new Error(`old_str must match exactly once but matched ${e.count} times. Read the file again and use a more specific snippet.`);
    return applyChange('edit', full, before, e.after);
  },
  async run_command({ command }) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is empty');
    const warns = [];
    if (/\.env(?!\.example)/.test(command)) warns.push('mentions an env file');
    if (/\brm\s+-\w*[rf]/.test(command)) warns.push('deletes files');
    if (/\bsudo\b/.test(command)) warns.push('uses sudo');
    if (/\bgit\s+(push|reset\s+--hard|clean|checkout\s+\.|restore)/.test(command)) warns.push('changes git history or discards work');
    if (/(curl|wget)[^|]*\|\s*(sh|bash)/.test(command)) warns.push('pipes a download into a shell');
    out(`\n${c.yellow('▸ RUN')} ${c.bold(command)}`);
    warns.forEach(w => out(`  ${sym.warn} ${c.yellow('caution: ' + w)}`));
    flush();
    const a = (await ask(`${c.bold('run it?')} ${c.dim('[y]es [n]o')} › `)).trim().toLowerCase();
    const id = nextId();
    if (a !== 'y' && a !== 'yes') {
      flush();
      const why = (await ask(c.dim('  reason for the agent (optional) › '))).trim();
      logChange({ id, action: 'run', status: 'denied', ...privateCommandMeta(command), reason: why });
      out(`  ${sym.fail} denied`);
      return 'The user denied this command.' + (why ? ' Reason: ' + why : '');
    }
    const t0 = Date.now();
    const r = await new Promise(resolve => exec(command, { cwd: ROOT, timeout: CFG.commandTimeoutSec * 1000, maxBuffer: 20e6 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    const timedOut = !!(r.err && r.err.killed);
    const code = r.err ? (timedOut ? 'timeout' : r.err.code) : 0;
    out(`${code === 0 ? sym.ok : sym.fail} exit ${code} ${c.dim('· ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')}`);
    if (r.stdout) out(r.stdout.replace(/\n$/, ''));
    if (r.stderr) out(c.red(r.stderr.replace(/\n$/, '')));
    logChange({ id, action: 'run', status: code === 0 ? 'applied' : 'failed', ...privateCommandMeta(command), exit: code, ms: Date.now() - t0 });
    return `exit code: ${code}${timedOut ? ` (timed out after ${CFG.commandTimeoutSec}s)` : ''}\n[stdout]\n${r.stdout}\n[stderr]\n${r.stderr}`;
  },
};

const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } } });
const STR = { type: 'string' }, INT = { type: 'integer' };
const TOOLS = [
  tool('list_dir', 'List files in a project directory', { path: STR }, []),
  tool('read_file', 'Read a text file; optional line range', { path: STR, start_line: INT, end_line: INT }, ['path']),
  tool('list_resources', 'List user-editable AGT reference resources (not project files)', { path: STR }, []),
  tool('read_resource', 'Read a user-editable AGT reference resource by path under the private resources directory', { path: STR }, ['path']),
  tool('write_file', 'Create or overwrite a file with full content', { path: STR, content: STR }, ['path', 'content']),
  tool('edit_file', 'Replace one exact, unique snippet in a file', { path: STR, old_str: STR, new_str: STR }, ['path', 'old_str', 'new_str']),
  tool('run_command', 'Run a shell command in the project root', { command: STR }, ['command']),
];

// ================= model calls =================
let SYSTEM = '', ctl = null, thinking = false;
function buildSystem() {
  let ctx = '';
  for (const f of ['GEMINI.md', 'AGENTS.md']) {
    try {
      const fp = safe(f), st = fs.lstatSync(fp);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 6000) continue;
      const note = fs.readFileSync(fp, 'utf8');
      if (note.includes('\u0000')) continue;
      ctx += `\n\nProject notes (${f}):\n` + note;
    } catch {}
  }
  return `You are a careful coding agent working in ${ROOT}, on ${G.platformName()}. Shell commands run with ${process.platform === 'win32' ? 'cmd.exe' : 'sh'}. Inspect files with your tools before changing anything. Prefer edit_file with a small unique snippet over rewriting whole files. The user reviews every file change and command before it runs; if one is denied, read the reason and adjust. Tool output may be clipped: read large files in line ranges. Never read or print secrets or env files. Reference materials under AGT's private resources directory are available only through list_resources/read_resource. Keep replies short and say what you changed.` + ctx;
}
function prettyErr(text) {
  try {
    const j = JSON.parse(text), e = j.error || j;
    let s = typeof e === 'string' ? e : e.message || text;
    for (const a of e.attempts || []) s += `\n  ${sym.fail} ${a.via} ${a.status ? 'HTTP ' + a.status : 'no response'} (${a.ms}ms)\n${a.error}`;
    return s;
  } catch { return text; }
}
async function callModel(signal) {
  const t0 = Date.now();
  const selected = model || lane;
  const target = G.resolveTarget(CFG, selected);
  const usesManus = !!(target && target.steps.some(([name]) => CFG.providers[name] && CFG.providers[name].type === 'manus'));
  if (S.manusTarget && S.manusTarget !== selected) { S.manusTaskId = null; S.manusUserId = null; }
  S.manusTarget = selected;
  const requestBody = { model: selected, messages: [{ role: 'system', content: SYSTEM }, ...S.messages], tools: TOOLS };
  if (usesManus) {
    requestBody.manus = {
      task_id: S.manusTaskId || null,
      user_id: S.manusUserId || null,
      input: manusCurrentInput(),
      system_context: SYSTEM,
      instructions: readManusInstructions(),
      project_context: buildProjectContext(),
      seed_history: manusSeedHistory(),
    };
  } else {
    S.manusTaskId = null; S.manusUserId = null;
  }
  let r;
  try {
    r = await fetch(base() + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    if (usesManus && signal && signal.aborted) {
      S.manusTaskId = null; S.manusUserId = null; e.manusTimeout = true;
    }
    throw e;
  }
  const text = await r.text();
  const via = r.headers.get('x-router-via'), rid = r.headers.get('x-router-id');
  if (!r.ok) {
    let manusTimeout = false;
    try {
      const errorData = JSON.parse(text);
      if (errorData.manus_task_id) {
        // The remote task may still be running. Keep the user turn in local history,
        // but do not send another message into an in-flight/ambiguous remote task.
        S.manusTaskId = null; S.manusUserId = null; manusTimeout = true;
      }
      if (errorData.manus_ambiguous_create) manusTimeout = true;
    } catch {}
    const e = new Error(`router returned HTTP ${r.status}` + (rid ? ` (request ${rid})` : '')); e.detail = prettyErr(text); e.manusTimeout = manusTimeout; throw e;
  }
  let data; try { data = JSON.parse(text); } catch { throw new Error('router sent invalid JSON:\n' + text); }
  const ch = data.choices && data.choices[0];
  if (!ch) throw new Error('response had no choices:\n' + text);
  const { reasoning, reasoning_content, annotations, refusal, ...msg } = ch.message;
  return { msg, usage: data.usage || {}, via, rid, ms: Date.now() - t0, finish: ch.finish_reason, manus_task_id: data.manus_task_id, manus_user_id: data.manus_user_id };
}
async function execTool(tc) {
  const name = tc.function.name;
  let args;
  try { args = JSON.parse(tc.function.arguments || '{}'); }
  catch (e) { const m = `Error: invalid JSON arguments: ${e.message}`; out(`${sym.fail} ${name}: ${m}`); return m; }
  lg('debug', 'tool_call', { name, args: safeToolLogArgs(name, args) });
  let result;
  try {
    if (!tools[name]) throw new Error('unknown tool ' + name);
    result = String(await tools[name](args));
  } catch (e) { result = 'Error: ' + e.message; out(`  ${sym.fail} ${c.red(e.message)}`); lg('error', 'tool_error', { name, error: e.message }); }
  return clipForModel(result);
}
const think = on => {
  if (!process.stdout.isTTY) return;
  if (on) { process.stdout.write(c.dim('  … waiting for model')); thinking = true; }
  else if (thinking) { process.stdout.write('\r\x1b[K'); thinking = false; }
};
async function runTurn(text) {
  const mark = S.messages.length;
  S.messages.push({ role: 'user', content: text });
  if (!S.title) S.title = text.replace(/\s+/g, ' ').slice(0, 70);
  let step = 0;
  try {
    for (step = 1; step <= CFG.maxSteps; step++) {
      ctl = new AbortController();
      think(true);
      let r;
      try { r = await callModel(ctl.signal); } finally { ctl = null; think(false); }
      const { msg, usage } = r;
      if (r.manus_task_id) S.manusTaskId = r.manus_task_id;
      if (r.manus_user_id) S.manusUserId = r.manus_user_id;
      for (const tc of msg.tool_calls || []) tc.id = tc.id || 'call_' + rand(4);
      S.messages.push(msg);
      S.usage.prompt += usage.prompt_tokens || 0; S.usage.completion += usage.completion_tokens || 0;
      lg('debug', 'model_reply', { via: r.via, ms: r.ms, finish: r.finish, tool_calls: (msg.tool_calls || []).length });
      out(c.dim(`  ↳ ${r.via || lane} · ${(r.ms / 1000).toFixed(1)}s${usage.total_tokens ? ' · ' + num(usage.total_tokens) + ' tokens' : ''}`));
      if (msg.content) out('\n' + msg.content);
      if (!msg.tool_calls || !msg.tool_calls.length) {
        if (!msg.content) out(c.yellow(`(the model returned an empty reply, finish_reason=${r.finish})`));
        break;
      }
      for (const tc of msg.tool_calls) S.messages.push({ role: 'tool', tool_call_id: tc.id, content: await execTool(tc) });
      saveSession();
    }
    if (step > CFG.maxSteps) out(c.yellow(`\n(stopped after ${CFG.maxSteps} steps; say "continue" to go on)`));
  } catch (e) {
    think(false);
    if (e.name === 'AbortError') out(c.yellow('\n■ cancelled'));
    else {
      out(`\n${sym.fail} ${c.red(e.message)}`);
      if (e.detail) out(e.detail);
      out(c.dim('  /log shows router details · agt doctor diagnoses'));
      lg('error', 'turn_failed', { error: e.message, detail: e.detail });
    }
    if (S.messages.length === mark + 1 && !e.manusTimeout) S.messages.length = mark;
  }
  flush(); saveSession();
}

// ================= chat =================
const CHAT_HELP = `${c.bold('Chat commands')}
  /plan, /edit      switch to the named configured lane
  /lane <name>      switch to any configured lane; /lane lists lane names
  /model <target>   pin an alias or exact provider/model-id; e.g. /model fast or /model manus/agent
  /model auto       clear the pin and return to the current lane
  /models [live]    list lanes and aliases; add live to list provider model IDs
  /new              save this chat and start a separate session
  /sessions [count] list local AGT chats; /sessions rm <full-id> deletes one
  /tasks [list|show <id>|resume <id>|stop <id>|delete <id>]  manage Manus tasks
  /compact          summarize this chat to save tokens (full copy is kept)
  /status           show session, context size, and router health
  /health [deep]    show router health; deep also probes providers
  /stats            show request counts per provider (saved snapshot works offline)
  /log [n]          show recent router log lines
  /changes          show files changed; shell command details are redacted
  /undo [id]        restore a file the agent changed
  /debug            toggle verbose debug lines
  /exit             save and quit
${c.dim('Lane selects an ordered failover list. A model pin selects one exact model with no failover.')}
${c.dim('Pasted multi-line text is sent as one message. Ctrl+C cancels a running request.')}`;

async function slash(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case 'help': out(CHAT_HELP); break;
    case 'plan': case 'edit': case 'lane': {
      const want = cmd === 'lane' ? rest[0] : cmd;
      if (want && CFG.lanes[want]) { lane = want; out(`lane: ${c.cyan(lane)}${model ? c.dim('  (model ' + model + ' is still pinned; /model auto to use the lane)') : ''}`); }
      else out(`lanes: ${Object.keys(CFG.lanes).join(', ')}`);
      break;
    }
    case 'model': {
      if (!rest[0]) {
        out(model ? `pinned model: ${c.cyan(model)}  ${c.dim('(/model auto goes back to lane ' + lane + ')')}` : `no model pinned; routing by lane ${c.cyan(lane)}`);
        out(c.dim('pin one: /model <alias|provider/model-id>    e.g. /model manus/agent    list: /models'));
        break;
      }
      if (['auto', 'off', 'lane', 'none'].includes(rest[0])) { model = null; out(`model unpinned; routing by lane ${c.cyan(lane)}`); break; }
      const tg = G.resolveTarget(CFG, rest[0]);
      if (!tg) { out(`${sym.fail} "${rest[0]}" is not a lane, alias, or exact provider/model-id. Example: /model manus/agent. See /models.`); break; }
      if (tg.type === 'lane') { lane = rest[0]; model = null; out(`"${rest[0]}" is a lane: lane set, model unpinned`); break; }
      if (!G.keyOf(CFG, tg.steps[0][0])) out(`${sym.warn} ${tg.steps[0][0]} has no API key yet: agt keys set ${tg.steps[0][0]}`);
      model = rest[0];
      out(`model pinned: ${c.cyan(tg.label)} ${c.dim('(no failover while pinned; /model auto undoes it)')}`);
      break;
    }
    case 'models': await printModels(rest.find(x => x !== 'live'), rest.includes('live')); break;
    case 'new': saveSession(); releaseSessionLock(S.id); S = newSession(); acquireSessionLock(S.id); out(`new session ${S.id}`); break;
    case 'compact': await compact(); break;
    case 'status': {
      const est = Math.round(JSON.stringify(S.messages).length / 4);
      out(`${c.bold('Session')} ${S.id}\n  ${model ? 'model ' + model + ' (pinned)' : 'lane ' + lane} · ${S.messages.length} messages · ~${num(est)} tokens in context`);
      out(c.dim(`  used so far: ${num(S.usage.prompt)} prompt + ${num(S.usage.completion)} completion tokens`));
      if (est > 60000) out(`  ${sym.warn} context is getting large; /new starts fresh (this session stays saved)`);
      const r = await rget('/health');
      if (r && r.json) printHealth(r.json); else out(`${c.red('router not reachable')} (agt router start)`);
      break;
    }
    case 'health': await cmdHealth([], { deep: rest.includes('deep') }); break;
    case 'stats': await cmdStats(); break;
    case 'log': printLogLines(P.routerLog, Number(rest[0]) || 20); break;
    case 'changes': cmdChanges([], {}); break;
    case 'undo':
      if (rest[0] && !/^[A-Za-z0-9_-]{1,128}$/.test(rest[0])) out('change ID must contain only letters, digits, _ or -');
      else await undoChange(ask, rest[0] || null, false);
      break;
    case 'sessions': await cmdSessions(rest); break;
    case 'tasks': await cmdTasks(rest); break;
    case 'debug': debug = !debug; out(`debug ${debug ? 'on' : 'off'}`); break;
    case 'exit': case 'quit': return 'exit';
    default: out(`unknown command /${cmd}. Try /help`);
  }
}

async function cmdChat(pos, flags, resume, initialManusTask = null) {
  if (!process.stdin.isTTY) { out(c.red('chat needs an interactive terminal')); return 1; }
  G.ensureDirs(); G.rotate(P.agentLog);
  ROOT = process.cwd(); debug = !!flags.debug;
  if (flags.plan) lane = 'plan'; else if (flags.edit) lane = 'edit';
  if (!CFG.lanes[lane]) lane = CFG.defaultLane;
  model = null;
  if (flags.lane) { if (CFG.lanes[flags.lane]) lane = flags.lane; else { out(`${sym.fail} unknown lane "${flags.lane}". Lanes: ${Object.keys(CFG.lanes).join(', ')}`); return 1; } }
  if (flags.model) {
    const tg = G.resolveTarget(CFG, flags.model);
    if (!tg) { out(`${sym.fail} unknown model "${flags.model}". See: agt models`); return 1; }
    if (tg.type === 'lane') lane = flags.model; else model = flags.model;
  }

  if (resume) {
    const matches = sessionMatches(resume === true ? null : resume, ROOT);
    S = matches.length === 1 ? matches[0] : null;
    if (!S) {
      if (matches.length > 1) out(`${sym.fail} session id is ambiguous; use a longer id: ${matches.map(x => x.id).join(', ')}`);
      else out(`${sym.fail} no saved session found${resume === true ? ' for this folder' : ''}. List them: agt sessions`);
      return 1;
    }
    if (S.cwd !== ROOT) {
      if (!fs.existsSync(S.cwd)) { out(`${sym.fail} that session's folder no longer exists: ${S.cwd}`); return 1; }
      process.chdir(S.cwd); ROOT = S.cwd;
    }
    if (S.lane && CFG.lanes[S.lane]) lane = S.lane;
    if (S.model && !flags.model && G.resolveTarget(CFG, S.model)) model = S.model;
    S.usage = S.usage || { prompt: 0, completion: 0 };
  } else {
    S = newSession();
    if (initialManusTask) { S.manusTaskId = initialManusTask; S.manusUserId = null; S.manusTarget = 'manus/agent'; }
  }
  try { acquireSessionLock(S.id); }
  catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
  try { SYSTEM = buildSystem(); }
  catch (e) { releaseSessionLock(S.id); out(`${sym.fail} ${e.message}`); return 1; }
  let rs;
  try { rs = await startRouter(); }
  catch (e) { releaseSessionLock(S.id); out(`${sym.fail} ${e.message}`); return 1; }
  const startedRouter = !!rs.started, h = rs.health;
  out(`${c.bold('router')} ${dot(h.status)} ${c.dim('· providers: ' + (h.providers.filter(p => p.configured).map(p => p.name).join(', ') || 'NONE'))}${startedRouter ? c.dim(' · just started') : ''}`);
  if (h.status === 'down') {
    if (isManusTarget() && G.keyOf(CFG, 'manus')) out(`${sym.warn} no synchronous lane provider is ready; the selected Manus task provider remains available.`);
    else out(`${sym.warn} no provider can serve requests. Run: agt doctor`);
  }
  out(`\n${c.bold('agt')} ${c.dim('v' + G.VERSION)} · ${ROOT}\n${c.dim('session ' + S.id + ' · lane ' + lane + (model ? ' · pinned ' + model : '') + (resume ? ` · resumed (${S.messages.length} messages)` : ''))}\n${c.dim('/help for commands · Ctrl+C cancels a request')}`);
  if (initialManusTask) out(`${c.dim('attached to stopped Manus task ' + safeTerminalText(initialManusTask) + '; your next message continues it')}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = []; let waiter = null, waiting = false, quitting = false;
  rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  ask = q => new Promise(res => {
    rl.setPrompt(q);
    if (queue.length) return res(queue.shift());
    waiting = true; waiter = l => { waiting = false; res(l); }; rl.prompt();
  });
  flush = () => { queue.length = 0; };

  const quit = async (code = 0) => {
    if (quitting) return; quitting = true;
    saveSession();
    try {
      if (startedRouter && !flags.keep) out(c.dim('router ' + await stopRouter()));
      else if (startedRouter) out(c.dim('router left running (stop it with: agt router stop)'));
    } finally { releaseSessionLock(S.id); }
    out(c.dim(S.messages.length ? `session saved: ${S.id}  ·  continue with: agt resume` : 'bye'));
    process.exit(code);
  };
  rl.on('SIGINT', () => { if (ctl) ctl.abort(); else if (waiting) { out(''); quit(0); } });
  rl.on('close', () => quit(0));
  for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => quit(0));

  const first = pos.join(' ').trim();
  if (first) await runTurn(first);
  for (;;) {
    let line = await ask(`\n${c.cyan('[' + (model ? 'model: ' + model : lane) + ']')} › `);
    await sleep(50);
    while (queue.length) line += '\n' + queue.shift();
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('/')) { if ((await slash(line)) === 'exit') break; continue; }
    await runTurn(line);
  }
  await quit(0);
  return 0;
}

// ================= keys & setup =================
const KEY_URLS = { manus: 'https://manus.im/app/developers', gemini: 'https://aistudio.google.com/apikey', groq: 'https://console.groq.com/keys', cerebras: 'https://cloud.cerebras.ai', openrouter: 'https://openrouter.ai/keys' };

// Reads a secret without echoing it. With piped input (or forceLine) it just reads one line.
function readSecret(prompt, forceLine = false) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY || forceLine) {
      const r = readline.createInterface({ input: stdin });
      let got = false;
      r.once('line', l => { got = true; r.close(); resolve(l); });
      r.once('close', () => { if (!got) resolve(''); });
      return;
    }
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); // no echo from here on
    process.stdout.write(prompt);
    const done = v => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
      process.stdout.write(v ? c.dim(` (${v.length} characters received)\n`) : '\n');
      resolve(v);
    };
    const onData = chunk => {
      if (chunk.startsWith('\x1b')) return; // arrow keys etc.
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// accepts a provider name (groq) or the variable name (GROQ_API_KEY)
function keyTarget(arg) {
  if (!arg) return null;
  if (CFG.providers[arg]) return { name: CFG.providers[arg].keyEnv, provider: arg };
  const hit = Object.entries(CFG.providers).find(([, p]) => p.keyEnv === arg);
  if (hit) return { name: arg, provider: hit[0] };
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) ? { name: arg, provider: null } : null;
}

async function cmdKeys(pos, flags) {
  const sub = pos[0] || 'list';
  if (sub === 'path') { out(P.keys); return 0; }
  if (sub === 'list') {
    out(c.bold('API keys') + c.dim('  (values are never shown)'));
    for (const [name, p] of Object.entries(CFG.providers)) {
      const v = G.keyOf(CFG, name);
      out(`  ${v ? sym.ok : sym.fail} ${name.padEnd(11)} ${c.dim(p.keyEnv + (v ? ` · ${v.length} chars · from ${K.SOURCE[p.keyEnv] || 'environment'}` : ' · not set'))}`);
    }
    out(c.dim(`\nkeys file: ${P.keys}\nadd a key: agt keys set <provider>`));
    return 0;
  }
  if (sub === 'set') {
    const t = keyTarget(pos[1]);
    if (!t) { out(`usage: agt keys set <provider|VARIABLE_NAME> [--stdin]\nproviders: ${Object.keys(CFG.providers).join(', ')}`); return 1; }
    const value = (await readSecret(`${t.name} (input is hidden): `, !!flags.stdin)).trim();
    if (!value) { out(`${sym.fail} nothing entered, nothing saved`); return 1; }
    try { K.saveKey(t.name, value); } catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
    process.env[t.name] = value;
    out(`${sym.ok} saved ${t.name} to ${P.keys}`);
    const reload = await rget('/admin/reload', { method: 'POST' });
    if (reload && reload.ok) out(c.dim('  running router reloaded its key and config'));
    if (t.provider && !flags['no-test']) {
      const r = await G.probeProvider(CFG, t.provider);
      out(r.ok ? `${sym.ok} ${t.provider} accepted the key (${r.ms}ms)` : `${sym.warn} ${t.provider} said: ${r.status ? 'HTTP ' + r.status + ' ' : ''}${r.error}`);
    }
    return 0;
  }
  if (sub === 'remove') {
    const t = keyTarget(pos[1]);
    if (!t) { out('usage: agt keys remove <provider|VARIABLE_NAME>'); return 1; }
    out(K.removeKey(t.name) ? `${sym.ok} removed ${t.name} from the keys file` : `${sym.info} ${t.name} was not in the keys file`);
    if (process.env[t.name]) out(c.dim('  (it is still set in your environment; remove it there too)'));
    return 0;
  }
  out('usage: agt keys [list|set <provider>|remove <provider>|path]');
  return 1;
}

async function cmdSetup() {
  if (!process.stdin.isTTY) { out('agt setup needs an interactive terminal. Scripted alternative: agt keys set <provider> --stdin'); return 1; }
  out(`${c.bold('agt setup')}  ${c.dim('paste a key and press Enter, or just Enter to skip')}`);
  let added = 0;
  for (const [name, p] of Object.entries(CFG.providers)) {
    if (G.keyOf(CFG, name)) { out(`\n${sym.ok} ${name}: already set (${p.keyEnv})`); continue; }
    out(`\n${c.bold(name)} ${KEY_URLS[name] ? c.dim('free key: ' + KEY_URLS[name]) : ''}`);
    const v = (await readSecret(`  ${p.keyEnv}: `)).trim();
    if (!v) { out(c.dim('  skipped')); continue; }
    try { K.saveKey(p.keyEnv, v); } catch (e) { out(`  ${sym.fail} ${e.message}`); continue; }
    process.env[p.keyEnv] = v; added++;
    const r = await G.probeProvider(CFG, name);
    out(r.ok ? `  ${sym.ok} saved, and ${name} accepted it (${r.ms}ms)` : `  ${sym.warn} saved, but ${name} said: ${r.status ? 'HTTP ' + r.status + ' ' : ''}${r.error}`);
  }
  if (added) {
    const reload = await rget('/admin/reload', { method: 'POST' });
    if (reload && reload.ok) out(c.dim('  running router reloaded its keys and config'));
  }
  out(`\n${added ? 'Done.' : 'Nothing changed.'} Next: ${c.bold('agt doctor')}, then ${c.bold('agt')} inside a project folder.`);
  return 0;
}

// ================= updates =================
async function latestVersion() {
  const reg = (process.env.AGT_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
  try {
    const r = await fetch(`${reg}/${PKG_NAME}/latest`, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.version === 'string' ? j.version : null;
  } catch { return null; }
}
const newer = (a, b) => {
  const parse = v => {
    const m = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v));
    return m && { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : null };
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre && y.pre) return true;
  if (x.pre && !y.pre) return false;
  if (!x.pre && !y.pre) return false;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return false;
    if (y.pre[i] === undefined) return true;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]), yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return Number(x.pre[i]) > Number(y.pre[i]);
    if (xn !== yn) return !xn;
    return x.pre[i] > y.pre[i];
  }
  return false;
};
async function cmdUpdate(pos, flags) {
  const viaNpm = path.resolve(__dirname, '..').split(path.sep).includes('node_modules');
  const latest = await latestVersion();
  out(`installed ${G.VERSION} · latest ${latest || 'unknown (offline?)'}`);
  if (!latest) return 1;
  if (!newer(latest, G.VERSION)) { out(`${sym.ok} already up to date`); return 0; }
  if (flags.check) { out(`${sym.warn} update available: ${latest}`); return 0; }
  if (!viaNpm) { out(`This copy was not installed with npm. Update it with:\n  npm install -g ${PKG_NAME}@latest`); return 0; }
  out(c.dim(`running: npm install -g ${PKG_NAME}@latest`));
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', `${PKG_NAME}@latest`], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) out(`${sym.ok} updated. If a router is running, restart it: agt router restart`);
  return r.status || 0;
}

// ================= models (separate from lanes) =================
async function listModels(name) {
  const p = CFG.providers[name], key = G.keyOf(CFG, name);
  if (!key) return { error: `${p.keyEnv} is not set` };
  if (p.type === 'manus') return { ids: ['agent'] };
  try {
    const r = await fetch(p.url + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    if (!r.ok) return { error: `HTTP ${r.status} ${text}` };
    const j = JSON.parse(text);
    return { ids: (j.data || j.models || []).map(m => String(m.id || m.name).replace(/^models\//, '')).sort() };
  } catch (e) { return { error: e.message }; }
}
async function printModels(filter, live) {
  out(c.bold('Lanes') + c.dim('  (ordered failover, used when no model is pinned)'));
  for (const [n, steps] of Object.entries(CFG.lanes)) out(`  ${n}: ${steps.map(s => s.join('/')).join(c.dim(' → '))}`);
  const al = Object.entries(CFG.aliases || {});
  if (al.length) { out(c.bold('Aliases') + c.dim('  (short names for one model)')); for (const [a, s] of al) out(`  ${a} = ${s}`); }
  out(c.bold('Providers'));
  for (const name of Object.keys(CFG.providers)) {
    if (filter && name !== filter) continue;
    out(`  ${G.keyOf(CFG, name) ? sym.ok : sym.fail} ${name}${G.keyOf(CFG, name) ? '' : c.dim('  (no key)')}`);
    if (!live) continue;
    const r = await listModels(name);
    if (r.error) out(`    ${sym.fail} ${r.error}`);
    else r.ids.forEach(id => out(`    ${name}/${id}`));
  }
  if (filter && !CFG.providers[filter]) out(`${sym.warn} no provider named "${filter}"`);
  out(c.dim(`\nLane: /lane <name>  ·  exact model: /model <alias|provider/model-id>  ·  clear pin: /model auto`));
  out(c.dim(`Example Manus model: /model manus/agent  (or start with: agt --model manus/agent)${live ? '' : '\nsee provider model IDs: agt models --live'}`));
}
const cmdModels = (pos, flags) => printModels(pos[0], !!flags.live).then(() => 0);

// ================= compact =================
async function compact() {
  if (S.messages.length < 4) { out('nothing to compact yet'); return; }
  const text = S.messages.map(m => m.role === 'user' ? `USER: ${m.content}`
    : m.role === 'assistant' ? `ASSISTANT: ${m.content || ''}${(m.tool_calls || []).map(tc => `\n[called ${tc.function.name} ${String(tc.function.arguments).slice(0, 300)}]`).join('')}`
    : `TOOL RESULT: ${String(m.content).slice(0, 1500)}`).join('\n\n');
  const prompt = 'Summarize this coding-agent session so the work can continue in a fresh context. Include: the goal, what has been done (files changed), what remains, and key facts (paths, decisions, errors seen). Be concrete and stay under 350 words.\n\n' + text.slice(-24000);
  out(c.dim('  summarizing this session to save tokens…'));
  let summary = '';
  try {
    const r = await fetch(base() + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(CFG.requestTimeoutSec * 1000),
      body: JSON.stringify({ model: model || lane, messages: [{ role: 'user', content: prompt }] }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`router returned HTTP ${r.status}\n${prettyErr(t)}`);
    summary = (JSON.parse(t).choices[0].message.content || '').trim();
  } catch (e) { out(`${sym.fail} could not summarize: ${e.message}`); return; }
  if (!summary) { out(`${sym.fail} the model returned an empty summary; history left unchanged`); return; }
  const before = JSON.stringify(S.messages).length;
  saveSession();
  fs.writeFileSync(path.join(P.sessions, `${S.id}.${Date.now()}.precompact.bak`), JSON.stringify(S));
  S.manusTaskId = null; S.manusUserId = null;
  S.messages = [
    { role: 'user', content: 'Summary of our work so far (older messages were compacted to save tokens):\n' + summary },
    { role: 'assistant', content: 'Understood. I have the summary and can continue from here.' },
  ];
  saveSession();
  out(`${sym.ok} compacted: ~${num(Math.round(before / 4))} → ~${num(Math.round(JSON.stringify(S.messages).length / 4))} tokens ${c.dim('(the full history is kept in the sessions folder)')}`);
}

// ================= commands =================
async function cmdHealth(pos, flags) {
  const r = await rget('/health' + (flags.deep ? '?deep=1' : ''), { timeout: flags.deep ? 20000 : 2500 });
  if (!r || !r.json || !r.json.status) { out(`${c.bold('Router')}  ${c.red('● not running')}\n${c.dim('  start it: agt router start')}`); return 1; }
  if (flags.json) out(JSON.stringify(r.json, null, 2)); else printHealth(r.json);
  return r.json.status === 'down' ? 2 : 0;
}
async function cmdStats() {
  const r = await rget('/stats');
  let data, offline = false;
  if (r && r.json && r.json.daily) data = r.json;
  else {
    try { data = JSON.parse(G.readPrivateFile(P.stats)); offline = true; }
    catch { out(c.red('no statistics available') + c.dim(' (start the router and make a request first)')); return 1; }
  }
  const daily = data.daily && typeof data.daily === 'object' ? data.daily : {};
  const days = Object.keys(daily).sort().reverse();
  out(c.bold('Requests by day (UTC)'));
  out(c.dim(offline ? '  router is stopped; showing the last persisted snapshot' : '  provider quotas reset on their own clocks, so treat this as an estimate'));
  if (data.since_start && Object.keys(data.since_start).length) {
    out(c.dim('  current router process:'));
    for (const [k, v] of Object.entries(data.since_start)) out(`    ${k}: ${v.ok} ok · ${v.fail} failed`);
  }
  if (!days.length) out('  none recorded yet');
  for (const d of days) {
    out(c.cyan(d));
    for (const [k, v] of Object.entries(daily[d] || {})) out(`  ${k}\n    ${c.green(Number(v.ok || 0) + ' ok')} · ${v.fail ? c.red(v.fail + ' failed') : c.dim('0 failed')}`);
  }
  return 0;
}
async function cmdLogs(pos, flags) {
  const file = (pos[0] || 'router') === 'agent' ? P.agentLog : P.routerLog;
  if (flags.raw) { out(G.tailFile(file, Number(flags.n) || 40).join('\n')); return 0; }
  printLogLines(file, Number(flags.n) || 40);
  if (flags.follow) followLog(file);
  return 0;
}
async function cmdRouter(pos, flags) {
  switch (pos[0] || 'status') {
    case 'start': { const r = await startRouter(); out(r.already ? `${sym.info} already running` : `${sym.ok} started`); printHealth(r.health); return 0; }
    case 'stop': out(`router: ${await stopRouter()}`); return 0;
    case 'restart': { out(`router: ${await stopRouter()}`); await sleep(400); const r = await startRouter(); out(`${sym.ok} started`); printHealth(r.health); return 0; }
    case 'reset': { const r = await rget('/admin/reset', { method: 'POST' }); out(r && r.ok ? `${sym.ok} cooldowns cleared` : `${sym.fail} router not reachable`); return r && r.ok ? 0 : 1; }
    case 'status': return cmdHealth([], flags);
    case 'logs': return cmdLogs(['router'], flags);
    default: out('usage: agt router start|stop|restart|status|reset|logs'); return 1;
  }
}
async function cmdConfig(pos) {
  const sub = pos[0] || 'show';
  if (sub === 'path') { out(P.config); return 0; }
  if (sub === 'edit') {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
    spawnSync(`${editor} "${P.config}"`, { stdio: 'inherit', shell: true });
    try {
      const iss = G.validateConfig(G.loadConfig());
      if (iss.length) iss.forEach(i => out(`${sym.warn} ${i}`)); else out(`${sym.ok} config is valid`);
    } catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
    const r = await rget('/admin/reload', { method: 'POST' });
    if (r && r.ok) out(`${sym.ok} router reloaded the config ${c.dim('(a changed port needs: agt router restart)')}`);
    return 0;
  }
  out(c.dim(P.config));
  if (CFG_ERR) { out(`${sym.fail} ${CFG_ERR.message}`); return 1; }
  out(JSON.stringify(CFG, null, 2));
  for (const i of G.validateConfig(CFG)) out(`${sym.warn} ${i}`);
  return 0;
}
function cmdResources() {
  ensureManusResources();
  out(c.bold('Editable Manus resources') + `\n  integration instructions: ${P.manusInstructions}\n  project knowledge and reusable skills: ${P.resources}`);
  out(c.dim('Edit these Markdown files with your editor. Manus can list and read resources when relevant; they are not sent on every turn.'));
  return 0;
}
async function confirmAction(prompt, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) { out(`${sym.warn} this action needs confirmation; rerun with --yes`); return null; }
  const answer = String(await ask(`${prompt} [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  out('cancelled; no changes made');
  return false;
}
async function cmdSessions(pos, flags = {}) {
  if (pos[0] === 'rm' || pos[0] === 'delete') {
    const id = pos[1];
    if (!id || pos.length !== 2) { out('usage: agt sessions rm <full-session-id> [--yes]'); return 1; }
    const all = listSessions();
    const s = all.find(x => x.id === id);
    if (!s) {
      const matches = sessionMatches(id);
      if (matches.length > 1) out(`session id is ambiguous; use the full id: ${matches.map(x => x.id).join(', ')}`);
      else if (matches.length === 1) out(`use the full session id: ${matches[0].id}`);
      else out(`no saved session with id "${id}"; list sessions with: agt sessions`);
      return 1;
    }
    if (sessionLockedByOther(s.id)) {
      const owner = lockOwner(s.id);
      out(`${sym.fail} chat ${s.id} is active in process ${owner && owner.pid || 'unknown'}; close it before deleting the session`);
      return 1;
    }
    const confirmed = await confirmAction(`Permanently delete local chat ${s.id}?`, flags.yes);
    if (confirmed === null) return 1;
    if (!confirmed) return 0;
    let deletionLock = false;
    if (!sessionLocks.has(s.id)) {
      try { acquireSessionLock(s.id); deletionLock = true; }
      catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
    }
    try {
      // Re-read under the exclusive lock; another process may have changed or removed it while confirmation was pending.
      const current = listSessions().find(x => x.id === s.id);
      if (!current) { out(`${sym.fail} chat ${s.id} changed while confirmation was pending; nothing was deleted`); return 1; }
      const files = fs.readdirSync(P.sessions).filter(name => name === `${s.id}.json` || name === `${s.id}.json.tmp` || (name.startsWith(`${s.id}.json.`) && name.endsWith('.tmp')) || (name.startsWith(`${s.id}.`) && name.endsWith('.precompact.bak')));
      for (const name of files) fs.rmSync(path.join(P.sessions, name), { force: true });
      if (S && S.id === s.id) {
        releaseSessionLock(s.id);
        S = newSession();
        acquireSessionLock(S.id);
        out(`current chat deleted; started new session ${S.id}`);
      }
      out(`${sym.ok} deleted local chat ${s.id} ${c.dim('(project-file backups remain so agt undo still works; remote Manus tasks are managed with agt tasks)')}`);
      return 0;
    } finally { if (deletionLock) releaseSessionLock(s.id); }
  }
  if (pos[0] && !/^\d+$/.test(pos[0])) { out('usage: agt sessions [count] | agt sessions rm <full-session-id> [--yes]'); return 1; }
  const count = pos[0] === undefined ? 15 : Number(pos[0]);
  if (!Number.isSafeInteger(count) || count < 1) { out('session count must be a positive integer'); return 1; }
  const all = listSessions();
  if (!all.length) { out(c.dim('no saved sessions yet')); return 0; }
  all.slice(0, count).forEach(s => {
    const target = s.model ? `model ${s.model}` : `lane ${s.lane || '?'}`;
    const remote = s.manusTaskId ? ` · Manus task ${s.manusTaskId}` : '';
    out(`${c.bold(s.id)} ${c.dim(`· ${target} · ${s.messages.length} msgs · ${G.ago(s.updated)}${remote}`)}`);
    out(c.dim('  ' + s.cwd));
    if (s.title) out('  ' + s.title);
  });
  return 0;
}
function detachManusTask(taskId) {
  let detached = 0, skipped = 0;
  for (const s of listSessions()) {
    if (s.manusTaskId !== taskId) continue;
    if (sessionLockedByOther(s.id)) { skipped++; continue; }
    s.manusTaskId = null;
    s.manusUserId = null;
    try {
      const file = path.join(P.sessions, `${s.id}.json`);
      const tmp = `${file}.${process.pid}.${rand(6)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      detached++;
    } catch {}
  }
  if (S && S.manusTaskId === taskId) { S.manusTaskId = null; S.manusUserId = null; }
  return { detached, skipped };
}
const safeTerminalText = (value, limit = 240) => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, limit);
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function printManusTask(task, localSessions = []) {
  const id = safeTerminalText(task.id);
  const status = safeTerminalText(task.status || 'unknown');
  const title = safeTerminalText(task.title || '(untitled)');
  const created = Number(task.created_at);
  const when = Number.isFinite(created) && created > 0 ? G.ago(new Date(created * 1000).toISOString()) : 'date unknown';
  const credits = Number.isFinite(Number(task.credit_usage)) ? ` · ${Number(task.credit_usage)} credits` : '';
  const linked = localSessions.filter(s => s.manusTaskId === task.id).map(s => s.id);
  out(`${c.bold(id)} ${c.cyan(status)} · ${title} ${c.dim(`· ${safeTerminalText(task.task_type || 'task')} · ${when}${credits}`)}`);
  if (linked.length) out(c.dim('  linked AGT chat: ' + linked.join(', ')));
  if (task.has_running_background_jobs) out(c.dim('  background jobs are still running'));
  if (task.task_url) out(c.dim('  ' + safeTerminalText(task.task_url)));
}
async function cmdTasks(pos = [], flags = {}) {
  let action = pos[0] || 'list';
  if (action === 'list') {
    pos = pos.slice(1);
    if (pos.length) { out('usage: agt tasks [list] [--limit <1-100>] [--cursor <cursor>] [--include-deleted]'); return 1; }
  }
  else if (!['show', 'detail', 'resume', 'stop', 'delete', 'rm'].includes(action)) {
    out('usage: agt tasks [list|show <id>|resume <id>|stop <id>|delete <id>]');
    return 1;
  } else pos = pos.slice(1);
  const taskId = pos[0];
  if (pos.length > 1) { out('usage: agt tasks [list|show <id>|resume <id>|stop <id>|delete <id>]'); return 1; }
  const provider = CFG.providers.manus;
  const key = G.keyOf(CFG, 'manus');
  if (!provider || provider.type !== 'manus') { out(`${sym.fail} Manus is not configured in this AGT profile`); return 1; }
  if (!key) { out(`${sym.fail} MANUS_API_KEY is not set. Set it with: agt keys set manus`); return 1; }
  try {
    if (action === 'list') {
      const limit = flags.limit === undefined ? (flags.n === undefined ? 20 : flags.n) : flags.limit;
      const result = await Manus.listTasks({ provider, key, limit, cursor: flags.cursor, includeDeleted: !!flags['include-deleted'] });
      const tasks = Array.isArray(result.data) ? result.data : [];
      if (!tasks.length) out('no Manus tasks on this page');
      const localSessions = listSessions();
      for (const task of tasks) printManusTask(task, localSessions);
      if (result.has_more && result.next_cursor) out(c.dim(`more tasks: agt tasks --limit ${Number(limit)} --cursor ${shellQuote(safeTerminalText(result.next_cursor, 4096))}`));
      out(c.dim('This is your Manus account task list, not only tasks created by AGT. Use "agt tasks show <id>" for details.'));
      return 0;
    }
    if (!taskId) { out(`usage: agt tasks ${action === 'detail' ? 'show' : action} <task-id>${action === 'stop' || action === 'delete' || action === 'rm' ? ' [--yes]' : ''}`); return 1; }
    const detail = await Manus.getTask({ provider, key, taskId });
    const task = detail.task;
    if (!task) { out(`${sym.fail} Manus did not return that task`); return 1; }
    if (typeof task.id !== 'string' || task.id !== String(taskId).trim()) { out(`${sym.fail} Manus returned a task ID that does not match the requested ID; no task action was taken`); return 1; }
    if (action === 'resume') {
      if (task.status !== 'stopped') {
        const hint = task.status === 'waiting' ? 'handle its pending question or action in Manus first' : task.status === 'running' ? 'wait for it to stop, or stop it before continuing' : 'only a stopped Manus task can be continued from AGT';
        out(`${sym.fail} task status is ${safeTerminalText(task.status || 'unknown')}; ${hint}`);
        return 1;
      }
      if (task.has_running_background_jobs) { out(`${sym.fail} this task still has background jobs; let them finish in Manus before continuing it`); return 1; }
      if (task.task_type && !['standard', 'project'].includes(task.task_type)) { out(`${sym.fail} only standard or project tasks can be continued from AGT`); return 1; }
      const otherLinks = listSessions().filter(s => s.manusTaskId === task.id && (!S || s.id !== S.id));
      if (otherLinks.length) {
        const active = otherLinks.find(s => sessionLockedByOther(s.id));
        out(`${sym.fail} Manus task ${safeTerminalText(task.id)} is already linked to local chat ${otherLinks[0].id}${active ? ' which is active' : ''}; continue it with: agt resume ${otherLinks[0].id}`);
        return 1;
      }
      if (S) {
        const previous = S.manusTaskId;
        model = 'manus/agent'; S.model = model; S.manusTaskId = task.id; S.manusUserId = null; S.manusTarget = model;
        saveSession();
        out(`${sym.ok} attached this chat to stopped Manus task ${safeTerminalText(task.id)}; your next message continues it${previous && previous !== task.id ? ` (the previously linked task ${safeTerminalText(previous)} remains in your Manus account)` : ''}`);
        return 0;
      }
      out(`${sym.ok} opening a chat pinned to stopped Manus task ${safeTerminalText(task.id)}`);
      return cmdChat([], { model: 'manus/agent' }, false, task.id);
    }
    if (action === 'show' || action === 'detail') {
      printManusTask(task, listSessions());
      if (task.share_visibility) out(`visibility: ${safeTerminalText(task.share_visibility)}`);
      if (task.agent_profile) out(`agent profile: ${safeTerminalText(task.agent_profile)}`);
      return 0;
    }
    if (action === 'stop') {
      if (task.status !== 'running') { out(`Manus task ${safeTerminalText(task.id)} is ${safeTerminalText(task.status || 'not running')}; no stop was sent`); return 0; }
      const confirmed = await confirmAction(`Stop running Manus task ${safeTerminalText(task.id)}?`, flags.yes);
      if (confirmed === null) return 1;
      if (!confirmed) return 0;
      await Manus.stopTask({ provider, key, taskId: task.id });
      out(`${sym.ok} stop requested for ${safeTerminalText(task.id)}. Manus documents that a stopped task can still be resumed.`);
      return 0;
    }
    if (action === 'delete' || action === 'rm') {
      if (task.status === 'running') { out(`${sym.warn} task is running; stop it first with: agt tasks stop ${safeTerminalText(task.id)}`); return 1; }
      if (task.has_running_background_jobs) { out(`${sym.warn} Manus reports background jobs are still running; wait for them to finish before deleting this task.`); return 1; }
      const confirmed = await confirmAction(`Permanently delete remote Manus task ${safeTerminalText(task.id)}?`, flags.yes);
      if (confirmed === null) return 1;
      if (!confirmed) return 0;
      await Manus.deleteTask({ provider, key, taskId: task.id });
      const { detached, skipped } = detachManusTask(task.id);
      out(`${sym.ok} deleted Manus task ${safeTerminalText(task.id)}${detached ? ` and detached ${detached} local AGT chat${detached === 1 ? '' : 's'}` : ''}${skipped ? `; ${skipped} active chat${skipped === 1 ? ' was' : 's were'} left unchanged` : ''}`);
      return 0;
    }
    return 1;
  } catch (e) {
    out(`${sym.fail} ${e.message}`);
    if ((action === 'delete' || action === 'rm') && /agent-related|cannot be deleted/i.test(e.message)) out(c.dim('Manus does not allow permanent deletion of some agent-related tasks.'));
    return 1;
  }
}
function cmdShow(pos, flags) {
  const matches = sessionMatches(pos[0]);
  const s = matches.length === 1 ? matches[0] : null;
  if (!s) {
    if (matches.length > 1) out(`session id is ambiguous; use a longer id: ${matches.map(x => x.id).join(', ')}`);
    else out('usage: agt show <session-id>   (list them: agt sessions)');
    return 1;
  }
  out(`${c.bold(s.id)} ${c.dim('· ' + s.cwd + ' · ' + s.lane)}`);
  const cut = t => (flags.full || t.length <= 300 ? t : t.slice(0, 300) + c.dim(`… [${t.length} chars, use --full]`));
  for (const m of s.messages) {
    if (m.role === 'user') out(`\n${c.cyan('You')}\n${m.content}`);
    else if (m.role === 'assistant') {
      if (m.content) out(`\n${c.green('Agent')}\n${m.content}`);
      for (const tc of m.tool_calls || []) out(`  ${c.cyan('▸')} ${tc.function.name} ${c.dim(tc.function.arguments || '')}`);
    } else if (m.role === 'tool') out(c.dim('  ← ') + cut(String(m.content)));
  }
  return 0;
}
function cmdChanges(pos, flags) {
  const all = G.readJsonl(P.changes);
  const undone = new Set(all.filter(x => x.action === 'undo' && x.status === 'applied').map(x => String(x.of)));
  const rows = all.filter(x => x.action !== 'undo').slice(-(Number(flags.n) || 15));
  if (!rows.length) { out(c.dim('no changes recorded yet')); return 0; }
  for (const x of rows) {
    const mark = x.status === 'denied' ? sym.fail : x.status === 'failed' ? sym.warn : sym.ok;
    const what = x.action === 'run' ? `$ [command details redacted${x.command_length ? ` · ${x.command_length} chars` : ''}]` : `${x.action} ${x.path}`;
    const tail = x.action === 'run' ? `exit ${x.exit}` : x.status === 'denied' ? 'denied' : `+${x.added} -${x.removed}`;
    out(`${c.dim('#' + x.id)} ${mark} ${what}`);
    out(c.dim(`     ${tail}${undone.has(String(x.id)) ? ' · undone' : ''} · ${G.ago(x.ts)}${x.reason ? ' · reason: ' + x.reason : ''}`));
  }
  return 0;
}
const cmdUndo = (pos, flags) => {
  const id = pos[0] || null;
  if (id && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) { out('change ID must contain only letters, digits, _ or -'); return 1; }
  return undoChange(askOnce, id, !!flags.force);
};

async function cmdDoctor() {
  const n = { ok: 0, warn: 0, fail: 0 };
  const say = (lvl, msg, hint) => { n[lvl]++; out(`${sym[lvl]} ${msg}`); if (hint) out(c.dim('    → ' + hint)); };
  out(`${c.bold('agt doctor')} ${c.dim('v' + G.VERSION + ' · ' + G.platformName() + ' · ' + process.arch)}\n`);
  if (Number(process.versions.node.split('.')[0]) >= 18) say('ok', `Node ${process.version}`); else say('fail', `Node ${process.version} is too old (18.17 or newer is needed)`, 'update Node.js');
  if (spawnSync('git', ['--version']).error) say('warn', 'git not found (optional: used for the "is this a repo" check)', G.installHint('git')); else say('ok', 'git available');
  try { G.ensureDirs(); fs.accessSync(P.home, fs.constants.W_OK); say('ok', `data folder ${P.home}`); } catch (e) { say('fail', `cannot write ${P.home}: ${e.message}`); }
  if (CFG_ERR) say('fail', CFG_ERR.message, 'agt config edit');
  else { say('ok', `config ${P.config}`); for (const i of G.validateConfig(CFG)) say('warn', i, 'agt config edit'); }
  for (const [name, p] of Object.entries(CFG.providers)) {
    const raw = process.env[p.keyEnv];
    if (!raw) say('warn', `${p.keyEnv} is not set (${name} is skipped)`, `agt keys set ${name}   (or: agt setup)`);
    else if (raw !== raw.trim() || /^["']|["']$/.test(raw)) say('warn', `${p.keyEnv} has stray quotes or spaces`, `fix it: agt keys set ${name}`);
    else say('ok', `${p.keyEnv} is set (${raw.length} chars, from ${K.SOURCE[p.keyEnv] || 'environment'})`);
  }
  for (const name of Object.keys(CFG.providers)) {
    if (!G.keyOf(CFG, name)) continue;
    const r = await G.probeProvider(CFG, name);
    if (r.ok) say('ok', `${name} reachable, key accepted (${r.ms}ms)`);
    else say('fail', `${name}: ${r.status ? 'HTTP ' + r.status + ' ' : ''}${r.error}`,
      r.status === 401 || r.status === 403 ? 'the key was rejected: create a new one' : r.status === 429 ? 'rate limited: wait, or use the other provider' : r.status ? 'provider error: see the message above' : 'no response: check your internet connection');
  }
  const h = await rget('/health');
  if (!h || !h.json || !h.json.status) say('warn', 'router is not running', 'agt router start (agt chat starts it by itself)');
  else {
    const j = h.json;
    say(j.status === 'ok' ? 'ok' : 'warn', `router ${j.status} on port ${j.port} (pid ${j.pid}, up ${G.dur(j.uptime_s)})`);
    if (j.version !== G.VERSION) say('warn', `router runs v${j.version} but the installed files are v${G.VERSION}`, 'agt router restart');
    for (const [k, s] of Object.entries(j.cooling)) say('warn', `${k} is parked for ${s}s`, 'rate limited or erroring: agt logs router');
  }
  const g = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (!g.error && g.status === 0) say('ok', `git repo here (${g.stdout.split('\n').filter(Boolean).length} uncommitted files)`);
  else say('warn', 'this folder is not a git repo', 'git init   (makes every agent edit easy to review)');
  if (!process.env.AGT_NO_UPDATE_CHECK) {
    const latest = await latestVersion();
    if (latest && newer(latest, G.VERSION)) say('warn', `update available: ${latest} (you have ${G.VERSION})`, 'agt update');
    else if (latest) say('ok', `up to date (${G.VERSION})`);
  }
  say('ok', `${listSessions().length} saved sessions`);
  out(`\n${n.ok} ok · ${n.warn} warnings · ${n.fail} problems`);
  return n.fail ? 1 : 0;
}

function cmdHelp(pos) {
  if (pos[0] && COMMANDS[pos[0]]) {
    const k = COMMANDS[pos[0]];
    out(`${c.bold('agt ' + pos[0])} — ${k.desc}\nUsage: ${k.usage}`);
    if (k.notes) out('\n' + k.notes);
    return 0;
  }
  if (pos[0]) { out(`${sym.fail} unknown help topic "${pos[0]}"\n`); }
  out(`${c.bold('agt')} ${c.dim('v' + G.VERSION)}  terminal coding agent with lanes, exact model pins, saved chats, and Manus task controls\n`);
  out(c.bold('Commands and syntax'));
  for (const [n, k] of Object.entries(COMMANDS)) {
    out(`  ${c.cyan(n.padEnd(10))}${k.usage}`);
  }
  out(`\n${c.dim('Details: agt help <command>   Equivalent: agt <command> --help or -h')}`);
  out(`${c.dim('In chat, type /help. Example exact Manus model: /model manus/agent or agt --model manus/agent.')}`);
  out(`\n${c.bold('Data')}  ${c.dim(P.home)}\n${c.dim('  config.json  keys.env  sessions/  logs/  changes.jsonl  backups/  proposed/')}`);
  return pos[0] ? 1 : 0;
}

const COMMANDS = {
  chat: { desc: 'chat with an agent in this folder', usage: 'agt [chat] ["first message"] [--plan|--edit|--lane <name>] [--model <alias|provider/model-id>] [--keep] [--debug]',
    notes: 'A lane is an ordered failover list. --model pins one exact model with no failover. Example: --model manus/agent. In chat use /lane <name> or /model <alias|provider/model-id>; /model auto clears the pin. File writes and commands ask for approval.', run: (p, f) => cmdChat(p, f, false) },
  resume: { desc: 'continue a saved chat for this folder', usage: 'agt resume [session-id] [--model <target>]', notes: 'With no ID, resumes the most recent chat for the current folder. Use agt sessions to list chats.', run: (p, f) => cmdChat([], f, p[0] || true) },
  setup: { desc: 'guided API key setup', usage: 'agt setup', notes: 'Prompts for configured providers; press Enter to skip a provider.', run: cmdSetup },
  keys: { desc: 'list, set, remove, or locate API keys', usage: 'agt keys [list|set <provider|VARIABLE> [--stdin] [--no-test]|remove <provider|VARIABLE>|path]', notes: 'Keys are kept in the private data folder; environment variables take precedence. For scripts: printf %s "$KEY" | agt keys set groq --stdin.', run: cmdKeys },
  models: { desc: 'list lanes, aliases, and provider model IDs', usage: 'agt models [provider] [--live]', notes: 'Use agt models manus --live to see the exact Manus pin manus/agent. In chat use /models or /models live. --live probes provider model lists; it does not send a chat request.', run: cmdModels },
  router: { desc: 'start, stop, restart, or inspect the local router', usage: 'agt router [start|stop|restart|status|reset|logs]', notes: 'No subcommand means status. reset clears provider cooldowns; logs shows the router log.', run: cmdRouter },
  health: { desc: 'show local router health', usage: 'agt health [--deep] [--json]', notes: '--deep probes configured provider keys. --json prints the health response as JSON.', run: cmdHealth },
  stats: { desc: 'show request counts by provider and day', usage: 'agt stats', notes: 'Reads live stats when the router runs, otherwise the last persisted snapshot. Provider quota reset times differ, so counts are estimates.', run: cmdStats },
  doctor: { desc: 'diagnose setup, keys, providers, and router', usage: 'agt doctor', notes: 'Reports problems and suggested fixes. Provider probes use the configured keys.', run: cmdDoctor },
  logs: { desc: 'read router or agent logs', usage: 'agt logs [router|agent] [-n <count>] [-f] [--raw]', notes: 'Default is the router log and last 40 lines. -f follows new lines; --raw prints unformatted log text.', run: cmdLogs },
  sessions: { desc: 'list, inspect, or delete local AGT chats', usage: 'agt sessions [count] | agt sessions rm <full-session-id> [--yes]', notes: 'These are local AGT transcripts, separate from Manus remote tasks. Deletion asks for confirmation; --yes is for scripts. Project-file backups are kept for agt undo. Use agt show <id> to inspect a chat. In chat: /sessions or /sessions rm <full-id>.', run: cmdSessions },
  tasks: { desc: 'list and manage remote Manus account tasks', usage: 'agt tasks [list] [--limit <1-100>] [--cursor <cursor>] [--include-deleted] | agt tasks show <task-id> | agt tasks resume <task-id> | agt tasks stop <task-id> [--yes] | agt tasks delete <task-id> [--yes]', notes: 'Lists tasks for the Manus account tied to MANUS_API_KEY, not just AGT-created tasks. resume continues a stopped task only when no background jobs remain; running/waiting tasks are refused to avoid collisions or skipping a pending confirmation. If already linked to a saved AGT chat, use agt resume <session-id> to avoid duplicate local histories. stop interrupts a running task. delete is permanent, requires confirmation, and Manus may forbid deleting agent-related tasks. After deletion, linked local chats are detached. In chat: /tasks, /tasks show <id>, /tasks resume <id>, /tasks stop <id>, /tasks delete <id>.', run: cmdTasks },
  show: { desc: 'print a saved local chat transcript', usage: 'agt show <session-id> [--full]', notes: 'agt sessions lists IDs. Output is clipped by default; --full prints full tool results.', run: cmdShow },
  changes: { desc: 'show files and commands the agent changed or attempted', usage: 'agt changes [-n <count>]', notes: 'Reads the local change log; the default is the latest 15 entries. Shell command text is omitted from logs and this view.', run: cmdChanges },
  undo: { desc: 'restore a file changed by the agent', usage: 'agt undo [change-id] [--force]', notes: 'Without an ID, chooses the latest applied change. Change IDs are opaque strings. The command checks whether the file changed since; --force overrides that content check but not path/backup safety checks. It asks before restoring.', run: cmdUndo },
  config: { desc: 'view, locate, or edit AGT configuration', usage: 'agt config [show|path|edit]', notes: 'No subcommand prints config. edit opens VISUAL, EDITOR, or the platform default. Restart the router if you change its port.', run: cmdConfig },
  resources: { desc: 'locate editable Manus instructions, project notes, and skills', usage: 'agt resources', notes: 'Seeds only missing resource files; existing edits are preserved.', run: cmdResources },
  update: { desc: 'check for or install a newer registry release', usage: 'agt update [--check]', notes: '--check only reports availability. Updating requires an npm-installed copy and a published npm release.', run: cmdUpdate },
  help: { desc: 'show command list or detailed help for one command', usage: 'agt help [command]', notes: 'Also: agt <command> --help or -h. In an interactive chat, /help lists chat commands.', run: cmdHelp },
  version: { desc: 'print the installed AGT version', usage: 'agt version | agt --version | agt -v', run: () => { out('agt ' + G.VERSION); return 0; } },
};

(async () => {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  let name = pos.shift();
  if (flags.version) name = 'version';
  if (!name) name = flags.help ? 'help' : 'chat';
  if (CFG_ERR && !['doctor', 'config', 'help', 'version'].includes(name)) {
    out(`${sym.fail} ${CFG_ERR.message}\n${c.dim('  fix: agt config edit   (or: agt doctor)')}`); process.exit(1);
  }
  const cmd = COMMANDS[name];
  if (!cmd) { out(`${sym.fail} unknown command "${name}"\n`); cmdHelp([]); process.exit(1); }
  if (flags.help && name !== 'help') { cmdHelp([name]); return; }
  process.exitCode = (await cmd.run(pos, flags)) || 0;
})().catch(e => { out(`${sym.fail} ${c.red(e.message)}`); if (process.argv.includes('--debug')) out(e.stack); process.exit(1); });
