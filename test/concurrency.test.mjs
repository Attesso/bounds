import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { verifyChain } from '../src/ledger.mjs';
import { append, paths, readState } from '../src/store.mjs';
import { bin, initWorkspace, readJson, runCli, tempDir } from './helpers.mjs';

const logAsync = (dir, args) =>
  new Promise((resolve) => {
    const child = spawn('node', [bin, '--dir', dir, 'log', ...args], { encoding: 'utf8' });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });

test('eight writers produce one chain with no lost decision', async () => {
  const dir = initWorkspace('attesso-race');
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      logAsync(dir, ['--action', 'tool.call', '--subject', `s${index}`, '--capability', 'read']),
    ),
  );
  for (const result of results) assert.equal(result.code, 0, result.stderr);

  const state = readState(dir);
  assert.equal(state.entries.length, 8);
  assert.deepEqual(state.entries.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(state.entries.map((entry) => entry.subject)).size, 8);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('concurrent identical calls stop at the repeat ceiling', async () => {
  const dir = initWorkspace('attesso-race-repeat');
  writeFileSync(
    paths(dir).rules,
    JSON.stringify({ version: 1, rules: [{ id: 'identical', deny: { all: true }, max_repeats: 2 }] }),
  );
  const args = ['--action', 'tool.call', '--subject', 'read_file', '--capability', 'read', '--meta', 'args_hash=same'];
  await Promise.all(Array.from({ length: 8 }, () => logAsync(dir, args)));

  const state = readState(dir);
  assert.equal(state.entries.length, 8);
  assert.equal(state.entries.filter((entry) => entry.decision === 'ALLOW').length, 2);
  assert.equal(state.entries.filter((entry) => entry.code === 'REPEAT_LIMIT').length, 6);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('two serve processes share one ledger without interleaving', async () => {
  const dir = initWorkspace('attesso-race-serve');
  const runOne = (prefix) =>
    new Promise((resolve) => {
      const child = spawn('node', [bin, '--dir', dir, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      for (let index = 0; index < 5; index += 1) {
        child.stdin.write(`${JSON.stringify({ action: 'tool.call', subject: `${prefix}${index}`, capability: 'read' })}\n`);
      }
      child.stdin.end();
    });

  const [first, second] = await Promise.all([runOne('a'), runOne('b')]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  for (const line of `${first.stdout}${second.stdout}`.trim().split('\n')) {
    assert.equal('error' in JSON.parse(line), false, line);
  }

  const state = readState(dir);
  assert.equal(state.entries.length, 10);
  assert.deepEqual(
    state.entries.map((entry) => entry.seq),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('concurrent writers reclaim one stale lock exactly once', async () => {
  const dir = initWorkspace('attesso-race-stale');
  writeFileSync(paths(dir).lock, '999999');
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      logAsync(dir, ['--action', 'tool.call', '--subject', `s${index}`, '--capability', 'read']),
    ),
  );
  for (const result of results) assert.equal(result.code, 0, result.stderr);

  const state = readState(dir);
  assert.deepEqual(
    state.entries.map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('verify waits out a writer between the line and its head', async () => {
  const dir = initWorkspace('attesso-verify-window');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const other = tempDir('attesso-verify-copy');
  cpSync(dir, other, { recursive: true });

  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  const second = readFileSync(paths(dir).ledger, 'utf8').trimEnd().split('\n')[1];
  writeFileSync(paths(other).ledger, `${readFileSync(paths(other).ledger, 'utf8')}${second}\n`);
  const head = readJson(paths(dir).config).head;
  const lock = paths(other).lock;
  const config = paths(other).config;
  const writer = spawn(process.execPath, [
    '-e',
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(config)},${JSON.stringify(JSON.stringify({ version: 1, head }))});fs.unlinkSync(${JSON.stringify(lock)});},80);`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const result = runCli(other, 'verify');
  writer.kill();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ledger verifies/);
});

test('concurrent init creates exactly one key', async () => {
  const dir = tempDir('attesso-init-race');
  const runs = await Promise.all(
    Array.from({ length: 8 }, () =>
      new Promise((resolve) => {
        const child = spawn('node', [bin, '--dir', dir, 'init'], { encoding: 'utf8' });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      }),
    ),
  );
  const winners = runs.filter((result) => result.code === 0);
  assert.equal(winners.length, 1, JSON.stringify(runs));
  const kid = winners[0].stdout.match(/with key (\S+)/)?.[1];
  assert.ok(kid);
  const state = readState(dir);
  assert.equal(state.key.kid, kid);
  const entry = append(dir, { action: 'tool.call', subject: 'after-init', capability: 'read' });
  assert.equal(entry.seq, 1);
});

test('a killed lock holder is reclaimed', async () => {
  const dir = initWorkspace('attesso-killed-holder');
  const lock = paths(dir).lock;
  const holder = spawn('node', [
    '-e',
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},String(process.pid));setInterval(()=>{},1000);`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.on('close', resolve));
  assert.equal(existsSync(lock), true);

  const entry = append(dir, { action: 'tool.call', subject: 'after-kill', capability: 'read' });
  assert.equal(entry.seq, 1);
  assert.equal(existsSync(lock), false);
});

test('verify reads a read-only ledger without the lock', () => {
  const dir = initWorkspace('attesso-read-only');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  chmodSync(dir, 0o500);
  try {
    const result = runCli(dir, 'verify');
    assert.equal(result.status, 0, result.stderr);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('a writer waits for a live lock holder instead of losing the decision', async () => {
  const dir = initWorkspace('attesso-wait');
  const lock = paths(dir).lock;
  const holder = spawn('node', [
    '-e',
    `const fs=require('fs');const p=${JSON.stringify(lock)};fs.writeFileSync(p,String(process.pid));setTimeout(()=>{try{fs.unlinkSync(p)}catch{}},400);`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 80));

  const result = runCli(dir, 'log', '--action', 'tool.call', '--subject', 'waited', '--capability', 'read');
  assert.equal(result.status, 0, result.stderr);
  holder.kill();

  const state = readState(dir);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].subject, 'waited');
});

test('an interrupted append is repaired by the next one, not duplicated', () => {
  const dir = initWorkspace('attesso-crash');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const firstHead = readJson(paths(dir).config).head;
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });

  // Simulate a crash after the signed line landed and before the head moved.
  writeFileSync(paths(dir).config, JSON.stringify({ version: 1, head: firstHead }));
  const before = readState(dir);
  const interrupted = verifyChain(before.entries, before.key.public, before.config.head);
  assert.equal(interrupted.ok, false);
  assert.match(interrupted.reason, /interrupted append/);

  const third = append(dir, { action: 'tool.call', subject: 'three', capability: 'read' });
  assert.equal(third.seq, 3);
  const after = readState(dir);
  assert.deepEqual(after.entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(verifyChain(after.entries, after.key.public, after.config.head).ok, true);
});

test('a lock with no owner is reported, not silently reclaimed', () => {
  const dir = initWorkspace('attesso-empty-lock');
  writeFileSync(paths(dir).lock, '');
  assert.throws(
    () => append(dir, { action: 'tool.call', subject: 'one', capability: 'read' }),
    /has no owner/,
  );
  assert.equal(existsSync(paths(dir).lock), true);
});

test('a truncated log is refused before another line is written', () => {
  const dir = initWorkspace('attesso-truncated');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  const lines = readFileSync(paths(dir).ledger, 'utf8').trimEnd().split('\n');
  writeFileSync(paths(dir).ledger, `${lines[0]}\n`);

  assert.throws(
    () => append(dir, { action: 'tool.call', subject: 'three', capability: 'read' }),
    /ledger was truncated/,
  );
});

test('a torn trailing line is dropped and the next append continues', () => {
  const dir = initWorkspace('attesso-torn');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  writeFileSync(paths(dir).ledger, `${readFileSync(paths(dir).ledger, 'utf8')}{"seq":2,"prev":`);

  const entry = append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  assert.equal(entry.seq, 2);
  const state = readState(dir);
  assert.deepEqual(state.entries.map((item) => item.seq), [1, 2]);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('a complete entry without a newline is kept and separated', () => {
  const dir = initWorkspace('attesso-no-newline');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  writeFileSync(paths(dir).ledger, readFileSync(paths(dir).ledger, 'utf8').trimEnd());

  const entry = append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  assert.equal(entry.seq, 2);
  const state = readState(dir);
  assert.deepEqual(state.entries.map((item) => item.seq), [1, 2]);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});
