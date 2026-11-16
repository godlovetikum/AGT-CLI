'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { isInside } = require('./textutil');

const VERSION = require('../package.json').version;
// Data folder: AGT_HOME (or the older AG_HOME) wins; otherwise ~/.agt, or the earlier ~/.ag when that
// is where your existing config and history already live.
const FRESH = path.join(os.homedir(), '.agt'), LEGACY = path.join(os.homedir(), '.ag');
const HOME = process.env.AGT_HOME || process.env.AG_HOME || (!fs.existsSync(FRESH) && fs.existsSync(LEGACY) ? LEGACY : FRESH);
const P = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  keys: path.join(HOME, 'keys.env'),
  pid: path.join(HOME, 'router.pid'),
  stats: path.join(HOME, 'router-stats.json'),
  logs: path.join(HOME, 'logs'),
  routerLog: path.join(HOME, 'logs', 'router.log'),
  routerOut: path.join(HOME, 'logs', 'router.out'),
  agentLog: path.join(HOME, 'logs', 'agent.log'),
  sessions: path.join(HOME, 'sessions'),
  backups: path.join(HOME, 'backups'),
  proposed: path.join(HOME, 'proposed'),
  resources: path.join(HOME, 'resources'),
  manusInstructions: path.join(HOME, 'manus-instructions.md'),
  changes: path.join(HOME, 'changes.jsonl'),
};

const DEFAULT_CONFIG = {
  port: 4000,
  defaultLane: 'edit',
  cooldownSec: 300,
  requestTimeoutSec: 120,
  manusTimeoutSec: 600,
  manusPollMs: 2000,
  commandTimeoutSec: 120,
  maxSteps: 25,
  maxToolChars: 30000,
  previewLines: 20,
  // Short names for pinning one exact model: /model fast  (see "agt models")
  aliases: {
    fast: 'groq/openai/gpt-oss-120b',
    big: 'gemini/gemini-3-flash-preview',
  },
  providers: {
    manus: { type: 'manus', url: 'https://api.manus.ai', keyEnv: 'MANUS_API_KEY' },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', keepGeminiFields: true },
    groq: { url: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  },
  lanes: {
    plan: [['gemini', 'gemini-3-flash-preview'], ['groq', 'openai/gpt-oss-120b']],
    edit: [['groq', 'openai/gpt-oss-120b'], ['gemini', 'gemini-3-flash-preview']],
  },
};

// ---------- colors ----------
const TTY = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (a, b) => s => (TTY ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
const c = { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39), cyan: wrap(36, 39) };
const sym = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), info: c.cyan('•') };

// ---------- platform ----------
const isTermux = () => /com\.termux/.test(process.env.PREFIX || '') || !!process.env.TERMUX_VERSION;
const platformName = () => (isTermux() ? 'Android (Termux)' : { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform);
function installHint(pkg) {
  if (isTermux()) return `pkg install ${pkg}`;
  if (process.platform === 'win32') return pkg === 'git' ? 'winget install --id Git.Git' : `install ${pkg}`;
  if (process.platform === 'darwin') return `brew install ${pkg}`;
  return `install ${pkg} with your package manager (for example: sudo apt install ${pkg})`;
}

// ---------- formatting ----------
const dur = s => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const bytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ago = iso => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
function formatLog(r) {
  const { ts, level, event, ...rest } = r;
  const lv = level === 'error' ? c.red('ERR') : level === 'warn' ? c.yellow('WRN') : level === 'debug' ? c.dim('dbg') : c.green('inf');
  const kv = Object.entries(rest).map(([k, v]) => `${c.dim(k + '=')}${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  return `${c.dim((ts || '').slice(11, 19))} ${lv} ${c.bold(event)} ${kv}`;
}

// ---------- files ----------
function ensureDirs() {
  fs.mkdirSync(P.home, { recursive: true, mode: 0o700 });
  const homeStat = fs.lstatSync(P.home);
  if (!homeStat.isDirectory() && !homeStat.isSymbolicLink()) throw new Error(`AGT data path is not a directory: ${P.home}`);
  const homeReal = fs.realpathSync(P.home);
  if (!homeStat.isSymbolicLink()) try { fs.chmodSync(P.home, 0o700); } catch {}
  for (const d of [P.logs, P.sessions, P.backups, P.proposed, P.resources]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`AGT private directory must not be a symlink: ${d}`);
    const real = fs.realpathSync(d);
    if (!isInside(homeReal, real)) throw new Error(`AGT private directory resolves outside the data folder: ${d}`);
    try { fs.chmodSync(d, 0o700); } catch {}
  }
}
function privateFilePath(file) {
  const abs = path.resolve(file), homePath = path.resolve(P.home);
  if (!isInside(homePath, abs) || abs === homePath) throw new Error('AGT file path is outside the private data folder');
  const homeReal = fs.realpathSync(P.home);
  let cursor = homePath, nearest = homePath;
  const parts = path.relative(homePath, abs).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let st;
    try { st = fs.lstatSync(cursor); }
    catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new Error(`AGT private file cannot be a symlink: ${cursor}`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`AGT file parent is not a directory: ${cursor}`);
    nearest = cursor;
  }
  if (!isInside(homeReal, fs.realpathSync(nearest))) throw new Error('AGT file resolves outside the private data folder');
  return abs;
}
function readPrivateFile(file, encoding = 'utf8') {
  const abs = privateFilePath(file);
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error(`AGT private path is not a regular file: ${abs}`);
  return fs.readFileSync(abs, encoding);
}
function writePrivateFile(file, content, mode = 0o600) {
  const abs = privateFilePath(file);
  const parent = path.dirname(abs);
  if (!fs.existsSync(parent)) throw new Error(`AGT private directory does not exist: ${parent}`);
  const tmp = `${abs}.${process.pid}.${require('crypto').randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content);
    try { fs.fchmodSync(fd, mode); } catch {}
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    privateFilePath(abs);
    fs.renameSync(tmp, abs);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}
function openPrivateAppend(file) {
  const abs = privateFilePath(file);
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(abs, flags, 0o600);
  if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw new Error(`AGT log is not a regular file: ${abs}`); }
  return fd;
}
function appendJsonl(file, obj) {
  let fd;
  try { fd = openPrivateAppend(file); fs.writeSync(fd, JSON.stringify(obj) + '\n'); }
  catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function readJsonl(file) {
  try { return readPrivateFile(file).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function tailFile(file, n) { try { return readPrivateFile(file).split('\n').filter(Boolean).slice(-n); } catch { return []; } }
function rotate(file, max = 2e6) { try { const abs = privateFilePath(file), st = fs.lstatSync(abs); if (!st.isFile()) return; if (st.size > max) fs.renameSync(abs, abs + '.1'); } catch {} }

// ---------- config ----------
function loadConfig() {
  ensureDirs();
  privateFilePath(P.config);
  if (!fs.existsSync(P.config)) writePrivateFile(P.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  let user;
  try { user = JSON.parse(readPrivateFile(P.config)); }
  catch (e) { throw new Error(`config is not valid JSON (${P.config}): ${e.message}`); }
  // Add the dedicated task provider to existing configs without re-enabling
  // providers or lanes that a user has intentionally customized.
  const providers = { ...(user.providers || {}) };
  if (!Object.prototype.hasOwnProperty.call(providers, 'manus')) providers.manus = { ...DEFAULT_CONFIG.providers.manus };
  return { ...DEFAULT_CONFIG, ...user, providers };
}
function validateConfig(cfg) {
  const issues = [];
  if (!cfg.providers || typeof cfg.providers !== 'object') return ['"providers" must be an object'];
  for (const [n, p] of Object.entries(cfg.providers)) {
    if (!p.url) issues.push(`provider ${n}: missing "url"`);
    if (!p.keyEnv) issues.push(`provider ${n}: missing "keyEnv"`);
  }
  for (const [ln, steps] of Object.entries(cfg.lanes || {})) {
    if (!Array.isArray(steps) || !steps.length) { issues.push(`lane ${ln}: must be a non-empty list`); continue; }
    steps.forEach((s, i) => {
      if (!Array.isArray(s) || s.length !== 2) issues.push(`lane ${ln} step ${i + 1}: must be ["provider", "model"]`);
      else if (!cfg.providers[s[0]]) issues.push(`lane ${ln}: unknown provider "${s[0]}"`);
      else if (cfg.providers[s[0]].type === 'manus') issues.push(`lane ${ln}: Manus is asynchronous and must be pinned directly, not added to a failover lane`);
    });
  }
  if (!(cfg.lanes && cfg.lanes[cfg.defaultLane])) issues.push(`defaultLane "${cfg.defaultLane}" is not a lane`);
  for (const [a, spec] of Object.entries(cfg.aliases || {})) {
    if (cfg.lanes && cfg.lanes[a]) issues.push(`alias "${a}" has the same name as a lane (the lane wins)`);
    if (!resolveTarget({ ...cfg, aliases: {} }, spec)) issues.push(`alias "${a}": "${spec}" is not a lane or a provider/model pair`);
  }
  return issues;
}
// What a name means: a lane (ordered failover list), an alias, or one exact "provider/model".
// A pinned model has no failover: only that model is tried.
function resolveTarget(cfg, name) {
  if (typeof name !== 'string' || !name) return null;
  if (cfg.lanes && cfg.lanes[name]) return { type: 'lane', label: name, steps: cfg.lanes[name] };
  const spec = (cfg.aliases && cfg.aliases[name]) || name;
  if (cfg.lanes && cfg.lanes[spec]) return { type: 'lane', label: name, steps: cfg.lanes[spec] };
  const i = spec.indexOf('/');
  if (i > 0 && i < spec.length - 1) {
    const p = spec.slice(0, i), m = spec.slice(i + 1);
    if (cfg.providers && cfg.providers[p]) return { type: 'model', label: name === spec ? spec : `${name} (${spec})`, steps: [[p, m]] };
  }
  return null;
}
function keyOf(cfg, name) {
  const p = cfg.providers[name];
  if (!p || !p.keyEnv) return undefined;
  const v = (process.env[p.keyEnv] || '').trim().replace(/^["']|["']$/g, '');
  return v || undefined;
}

// ---------- provider probe (lists models: costs no tokens) ----------
async function probeProvider(cfg, name, timeoutMs = 8000) {
  const p = cfg.providers[name], key = keyOf(cfg, name);
  if (!key) return { name, ok: false, error: `${p && p.keyEnv} is not set` };
  const t = Date.now();
  try {
    const manus = p.type === 'manus';
    const r = await fetch(p.url + (manus ? '/v2/user.me' : '/models'), { headers: manus ? { 'x-manus-api-key': key } : { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t;
    if (r.ok) return { name, ok: true, status: r.status, ms };
    return { name, ok: false, status: r.status, ms, error: (await r.text()).slice(0, 4000) };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t, error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}

module.exports = { VERSION, P, DEFAULT_CONFIG, resolveTarget, isTermux, platformName, installHint, c, sym, dur, bytes, ago, formatLog, ensureDirs, privateFilePath, readPrivateFile, writePrivateFile, openPrivateAppend, appendJsonl, readJsonl, tailFile, rotate, loadConfig, validateConfig, keyOf, probeProvider };
