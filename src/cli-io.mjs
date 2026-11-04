// CLI plumbing: argument shapes, JSON files and the --out guard. Keeping it
// out of the command dispatch makes the entry point a wiring table, not a
// second implementation of path handling.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { paths } from './store.mjs';

export function flags(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      out[name] = true;
      continue;
    }
    if (name === 'meta') {
      out.meta = [...(out.meta ?? []), next];
    } else {
      out[name] = next;
    }
    index += 1;
  }
  return out;
}

export function parseMeta(pairs = []) {
  const meta = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--meta expects key=value, got ${pair}`);
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    meta[key] = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return meta;
}

export function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`${label}: ${error.message}`);
    process.exit(2);
  }
}

export function publicKey(path) {
  const text = readFileSync(path, 'utf8');
  return text.trim().startsWith('{') ? JSON.parse(text).public : text;
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(resolve(path))), basename(resolve(path)));
    } catch {
      return resolve(path);
    }
  }
}

export function canonicalOut(path) {
  const absolute = resolve(path);
  try {
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) return null;
    return canonical(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return canonical(absolute);
  }
}

// An --out path that lands on the ledger, its key or a stored snapshot destroys
// the record a command is supposed to prove. Refuse before opening the file.
// A symlink is refused too: resolving only the spelling of the path would let
// `--out receipt.json` overwrite the ledger through a link.
export function assertSafeOut(dir, out) {
  if (!out) return;
  const file = paths(dir);
  const target = canonicalOut(out);
  if (target === null) {
    console.error(`refusing to write ${resolve(out)}; it is a symbolic link`);
    process.exit(2);
  }
  const guarded = [file.key, file.policy, file.rules, file.ledger, file.config, file.tools, file.toolLock, file.lock].map(canonical);
  const snapshotDirs = [file.policies, file.toolsSnapshots].map(canonical);
  for (const snapshotDir of [file.policies, file.toolsSnapshots]) {
    try {
      for (const name of readdirSync(snapshotDir)) guarded.push(canonical(join(snapshotDir, name)));
    } catch {
      // A snapshot directory is created on the first append.
    }
  }
  let targetStat = null;
  try {
    targetStat = statSync(target);
  } catch {
    // A new output file has no inode to compare.
  }
  const sameFile = guarded.some((path) => {
    try {
      const guardedStat = statSync(path);
      return targetStat !== null && guardedStat.dev === targetStat.dev && guardedStat.ino === targetStat.ino;
    } catch {
      return false;
    }
  });
  if (
    sameFile ||
    guarded.includes(target) ||
    snapshotDirs.includes(target) ||
    snapshotDirs.some((snapshotDir) => target.startsWith(`${snapshotDir}${sep}`))
  ) {
    console.error(`refusing to write ${target}; it is part of the ledger`);
    process.exit(2);
  }
}

export function writeJsonOut(dir, value, out) {
  assertSafeOut(dir, out);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
