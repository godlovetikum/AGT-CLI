'use strict';
// API keys can come from the environment or from a private keys file (keys.env in the data
// folder). The environment always wins. The file works the same on every OS, with no shell setup.
const fs = require('fs');
const crypto = require('crypto');
const { P } = require('./common');

const SOURCE = {}; // VARIABLE_NAME -> 'keys file', for values this module loaded
const FILE_KEYS = new Set();

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function regularKeyFile() {
  try {
    const st = fs.lstatSync(P.keys);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('keys.env must be a regular file, not a symlink');
    return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function readFile() {
  try { return regularKeyFile() ? parse(fs.readFileSync(P.keys, 'utf8')) : {}; }
  catch { return {}; }
}

function loadKeys() {
  const vals = readFile();
  for (const k of FILE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(vals, k) && SOURCE[k] === 'keys file') { delete process.env[k]; delete SOURCE[k]; }
  }
  FILE_KEYS.clear();
  for (const [k, v] of Object.entries(vals)) {
    if (v && (!process.env[k] || SOURCE[k] === 'keys file')) { process.env[k] = v; SOURCE[k] = 'keys file'; FILE_KEYS.add(k); }
  }
  return vals;
}

function lines() {
  if (!regularKeyFile()) return null;
  return fs.readFileSync(P.keys, 'utf8').split(/\r?\n/);
}

function write(ls) {
  fs.mkdirSync(P.home, { recursive: true, mode: 0o700 });
  regularKeyFile();
  const tmp = `${P.keys}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, ls.join('\n').replace(/\n*$/, '\n'));
    try { fs.fchmodSync(fd, 0o600); } catch {}
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    regularKeyFile();
    fs.renameSync(tmp, P.keys);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

const dropVar = (ls, name) => ls.filter(l => { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l); return !(m && m[1] === name); });

function saveKey(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a valid variable name`);
  value = String(value).trim();
  if (!value) throw new Error('the key is empty');
  if (/[\s"'\\]/.test(value)) throw new Error('keys cannot contain spaces, quotes or backslashes (was something extra pasted?)');
  const ls = dropVar(lines() || ['# agt API keys. One NAME="value" per line. Keep this file private.'], name);
  ls.push(`${name}="${value}"`);
  write(ls);
  SOURCE[name] = 'keys file'; FILE_KEYS.add(name);
}

function removeKey(name) {
  const ls = lines();
  if (!ls) return false;
  const next = dropVar(ls, name);
  if (next.length === ls.length) return false;
  write(next);
  if (SOURCE[name] === 'keys file') { delete process.env[name]; delete SOURCE[name]; FILE_KEYS.delete(name); }
  return true;
}

module.exports = { parse, readFile, loadKeys, saveKey, removeKey, SOURCE };
