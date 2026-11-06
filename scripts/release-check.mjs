#!/usr/bin/env node
// Read-only release checks for the attesso package: clean tree, version ahead
// of the registry, tarball contents, a clean install under a temp HOME, the
// CLI, the local UI, and the dist-tags. It never publishes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startUi } from '../src/ui/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ALLOWED = ['bin/', 'src/', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'package.json'];
const FORBIDDEN = [/^test\//, /^testdata\//, /^\.git/, /^node_modules\//, /^\.attesso\//, /\.log$/];
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const version = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function semverGt(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

try {
  const dirty = run('git', ['status', '--porcelain', '--', '.']);
  record('tree is clean', dirty === '', dirty.split('\n').slice(0, 3).join(' | '));
} catch (error) { record('tree is clean', false, error.message); }

const local = version();
try {
  const latest = run('npm', ['view', 'attesso', 'version']);
  record(`version ${local} is ahead of ${latest}`, semverGt(local, latest));
} catch (error) { record('version is ahead of the registry', false, error.message); }

try {
  const dry = JSON.parse(run('npm', ['pack', '--dry-run', '--json']));
  const files = (Array.isArray(dry) ? dry[0] : dry).files.map((entry) => entry.path);
  const outside = files.filter((file) => !ALLOWED.some((prefix) => file === prefix || file.startsWith(prefix)));
  const forbidden = files.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
  record('tarball ships only the allowlist', outside.length === 0, outside.slice(0, 5).join(', '));
  record('tarball ships no test or local state', forbidden.length === 0, forbidden.slice(0, 5).join(', '));
} catch (error) { record('tarball contents', false, error.message); }

const temp = mkdtempSync(join(tmpdir(), 'attesso-release-'));
try {
  const tarball = run('npm', ['pack', '--pack-destination', temp]).split('\n').pop();
  const consumer = join(temp, 'consumer');
  const home = join(temp, 'home');
  mkdirSync(consumer, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true }));
  const env = { ...process.env, HOME: home, npm_config_cache: join(temp, 'npm-cache') };
  execFileSync('npm', ['install', '--no-save', '--no-package-lock', join(temp, tarball)], { cwd: consumer, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cli = join(consumer, 'node_modules/attesso/bin/attesso.mjs');
  const ledger = join(temp, 'ledger');
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/attesso/package.json'), 'utf8'));
  record('installed package version matches', installed.version === local, installed.version);
  const help = run('node', [cli, '--help']);
  record('installed CLI runs', help.length > 0, help.split('\n')[0]);
  run('node', [cli, '--dir', ledger, 'init']);
  run('node', [cli, '--dir', ledger, 'run', 'start', '--goal', 'release check']);
  run('node', [cli, '--dir', ledger, 'run', 'end', '--outcome', 'success']);
  const status = run('node', [cli, '--dir', ledger, 'status']);
  record('installed CLI records a run', status.length > 0, status.split('\n')[0]);

  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const headers = { 'x-bounds-token': ui.token };
    const page = await fetch(ui.url, { headers });
    const api = await fetch(new URL('api/status', ui.url), { headers });
    const calls = await fetch(new URL('api/v1/calls?tz=UTC', ui.url), { headers });
    record('local UI serves the page and the API', page.status === 200 && api.status === 200 && calls.status === 200, `${page.status}/${api.status}/${calls.status}`);
  } finally {
    await ui.close();
  }
} catch (error) { record('clean install and local UI', false, error.message); }

try {
  const tags = JSON.parse(run('npm', ['view', 'attesso', 'dist-tags', '--json']));
  record('next is not behind latest', !tags.next || !tags.latest || !semverGt(tags.latest, tags.next), JSON.stringify(tags));
} catch (error) { record('dist-tags readable', false, error.message); }

let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? ` (${result.detail})` : ''}`);
}
console.log(failed === 0 ? `release check passed for ${local}` : `release check failed: ${failed} problem(s)`);
process.exit(failed === 0 ? 0 : 1);
