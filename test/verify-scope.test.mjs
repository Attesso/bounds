import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { append, init, paths, verifyLedger } from '../src/store.mjs';

process.env.ATTESSO_LOCK_WAIT_MS = '50';

const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));

const workspace = (count = 5) => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-scope-'));
  init(dir);
  writeFileSync(
    paths(dir).policy,
    JSON.stringify({
      version: 1,
      action: 'purchase.execute',
      currency: 'EUR',
      max_amount: 25000,
      subjects: ['shop.example'],
    }),
  );
  for (let index = 0; index < count; index += 1) {
    append(dir, { action: 'purchase.execute', subject: 'shop.example', amount: { minor: 100 + index, currency: 'EUR' } });
  }
  return dir;
};

const cli = (dir, ...args) => {
  const result = spawnSync('node', [bin, '--dir', dir, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

// The point of these tests: a damaged record must say where it is damaged and
// how much survives. A single "does not verify" throws away the fact that the
// entries before the damage are still provable, which is the part an operator
// acts on.
test('a clean ledger reports every entry verified and no ignored tail', async () => {
  const dir = workspace(5);
  const result = await verifyLedger(dir);
  assert.equal(result.ok, true);
  assert.equal(result.count, 5);
  assert.equal(result.verified, 5);
  assert.equal(result.ignoredTail, false);
});

test('a tampered entry reports how many entries before it verify', async () => {
  const dir = workspace(5);
  const file = paths(dir).ledger;
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[2]);
  entry.subject = 'someone.else';
  lines[2] = JSON.stringify(entry);
  writeFileSync(file, `${lines.join('\n')}\n`);

  const result = await verifyLedger(dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /entry 3 signature does not verify/);
  assert.equal(result.verified, 2);

  const run = cli(dir, 'verify');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /does not verify: entry 3 signature does not verify/);
  assert.match(run.stderr, /2 entries before it verify; the record up to that point is intact/);
});

test('a deleted middle entry reports the scope and the gap', async () => {
  const dir = workspace(5);
  const file = paths(dir).ledger;
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${lines.filter((_, index) => index !== 2).join('\n')}\n`);

  const result = await verifyLedger(dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /entry 3 carries seq 4/);
  assert.equal(result.verified, 2);
});

test('a torn final line is announced instead of silently passing', async () => {
  const dir = workspace(3);
  appendFileSync(paths(dir).ledger, '{"seq":99,"at":"2026-11-06T09:00');

  const result = await verifyLedger(dir);
  assert.equal(result.ok, true);
  assert.equal(result.ignoredTail, true);

  const run = cli(dir, 'verify');
  assert.equal(run.code, 0);
  assert.match(run.stdout, /ledger verifies: chain of 3 entries verifies/);
  assert.match(run.stdout, /note: the last line is incomplete and was ignored/);
});

test('the next append repairs the torn tail rather than appending after it', async () => {
  const dir = workspace(3);
  appendFileSync(paths(dir).ledger, '{"seq":99,"at":"2026-11-06T09:00');
  append(dir, { action: 'purchase.execute', subject: 'shop.example', amount: { minor: 500, currency: 'EUR' } });

  const result = await verifyLedger(dir);
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.equal(result.ignoredTail, false);
});

test('one allow code is written, and both the old and the new one are judged the same', async () => {
  const dir = workspace(0);
  append(dir, { action: 'purchase.execute', subject: 'shop.example', amount: { minor: 100, currency: 'EUR' } });
  const entry = JSON.parse(readFileSync(paths(dir).ledger, 'utf8').trim());
  assert.equal(entry.code, 'ALLOW');
  assert.equal(entry.decision, 'ALLOW');
});
