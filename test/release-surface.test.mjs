import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { append, init, paths, readConfig } from '../src/store.mjs';
import { ENGINE_VERSION } from '../src/version.mjs';

process.env.ATTESSO_LOCK_WAIT_MS = '50';

const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

const run = (cwd, ...args) => spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });
const workspace = () => mkdtempSync(join(tmpdir(), 'attesso-release-'));

// A support conversation starts with the version, so the binary has to answer it
// without being told where the ledger is and without printing sixty lines of
// help. And a record has to be able to name the build that judged it.
test('--version prints the package version and nothing else', () => {
  for (const flag of ['--version', '-v', '-V', 'version']) {
    const result = spawnSync('node', [bin, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${flag} exited ${result.status}`);
    assert.equal(result.stdout.trim(), pkg.version, `${flag} printed ${result.stdout}`);
    assert.equal(/unknown command/.test(result.stderr), false, `${flag} fell through to the usage error`);
    assert.equal(/attesso: a local, signed ledger/.test(result.stdout), false, `${flag} printed the help`);
  }
});

test('the reported version is the package version', () => {
  assert.equal(ENGINE_VERSION, pkg.version);
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+/);
});

test('init records the engine that created the ledger, and verify prints it', () => {
  const dir = workspace();
  init(dir);
  assert.equal(readConfig(dir).engine, ENGINE_VERSION);

  const result = run(dir, '--dir', dir, 'verify');
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`engine ${ENGINE_VERSION}`));
});

test('an append keeps the engine a ledger first recorded', () => {
  const dir = workspace();
  init(dir);
  const file = paths(dir).config;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, engine: '0.0.0-first' }));

  append(dir, { action: 'http.get', subject: 'shop.example', capability: 'read', trust: 'internal' });
  assert.equal(readConfig(dir).engine, '0.0.0-first');
});

test('a ledger written before the field existed verifies and is stamped on the next write', () => {
  const dir = workspace();
  init(dir);
  append(dir, { action: 'http.get', subject: 'shop.example', capability: 'read', trust: 'internal' });

  const file = paths(dir).config;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  delete config.engine;
  writeFileSync(file, JSON.stringify(config));

  const verify = run(dir, '--dir', dir, 'verify');
  assert.equal(verify.status, 0);
  assert.equal(/engine /.test(verify.stdout), false);

  append(dir, { action: 'http.get', subject: 'shop.example', capability: 'read', trust: 'internal' });
  assert.equal(readConfig(dir).engine, ENGINE_VERSION);
});
