'use strict';
const fs = require('fs');
const path = require('path');
const { isInside } = require('./textutil');

function contextBlocked(p) {
  const base = path.basename(p);
  return (/^\.env/i.test(base) && !/\.example$/i.test(base))
    || /^(id_rsa|id_ed25519|id_ecdsa|credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(base)
    || /\.(pem|key|p12|pfx)$/i.test(base);
}

function projectPath(root, input) {
  if (input !== undefined && input !== null && typeof input !== 'string') throw new Error('path must be a string');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(input || '')) throw new Error('control characters are not allowed in paths');
  const rootPath = path.resolve(root);
  const full = path.resolve(rootPath, input || '.');
  if (!isInside(rootPath, full)) throw new Error('path is outside the project folder');
  const segments = path.relative(rootPath, full).split(path.sep).filter(Boolean);
  if (segments.some(s => s.toLowerCase() === '.git')) throw new Error('.git is off limits');
  if (segments.some(contextBlocked)) throw new Error('secret-like files are blocked');
  const rootReal = fs.realpathSync(rootPath);
  let cursor = rootPath, nearest = rootPath;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let st;
    try { st = fs.lstatSync(cursor); }
    catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new Error('symbolic links are blocked for project files');
    nearest = cursor;
  }
  if (!isInside(rootReal, fs.realpathSync(nearest))) throw new Error('path resolves outside the project folder');
  return full;
}

module.exports = { contextBlocked, projectPath };
