import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
process.env.ATTESSO_LOCK_WAIT_MS = '50';
import { verifyChain } from '../src/ledger.mjs';
import { append, init, isInitialised, paths, readState } from '../src/store.mjs';

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-ledger-'));
  init(dir);
  writeFileSync(
    paths(dir).policy,
    JSON.stringify({ version: 1, action: 'purchase.execute', currency: 'EUR', max_amount: 25000, subjects: ['shop.example'] }),
  );
  return dir;
};

const proposal = (minor) => ({ action: 'purchase.execute', subject: 'shop.example', amount: { minor, currency: 'EUR' } });

test('a chain of decisions verifies, refusals included', () => {
  const dir = workspace();
  append(dir, proposal(1250));
  append(dir, proposal(30000));
  append(dir, proposal(500));
  const state = readState(dir);
  assert.deepEqual(
    state.entries.map((entry) => entry.code),
    ['ALLOW', 'ABOVE_MAXIMUM', 'ALLOW'],
  );
  const result = verifyChain(state.entries, state.key.public, state.config.head);
  assert.deepEqual(result, { ok: true, reason: 'chain of 3 entries verifies' });
});

test('editing one amount breaks the signature at that entry', () => {
  const dir = workspace();
  append(dir, proposal(1250));
  append(dir, proposal(500));
  const file = paths(dir).ledger;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('"minor":500', '"minor":5');
  writeFileSync(file, lines.join('\n'));
  const state = readState(dir);
  const result = verifyChain(state.entries, state.key.public, state.config.head);
  assert.equal(result.ok, false);
  assert.match(result.reason, /entry 2 signature does not verify/);
});

test('reordering two entries is caught by the chain', () => {
  const dir = workspace();
  append(dir, proposal(1250));
  append(dir, proposal(500));
  const file = paths(dir).ledger;
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  writeFileSync(file, `${[lines[1], lines[0]].join('\n')}\n`);
  const state = readState(dir);
  const result = verifyChain(state.entries, state.key.public, state.config.head);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not chain|carries seq/);
});

test('deleting the last entry is caught by the recorded head', () => {
  const dir = workspace();
  append(dir, proposal(1250));
  append(dir, proposal(500));
  const file = paths(dir).ledger;
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  writeFileSync(file, `${lines[0]}\n`);
  const state = readState(dir);
  const result = verifyChain(state.entries, state.key.public, state.config.head);
  assert.equal(result.ok, false);
  assert.match(result.reason, /config records 2 entries, the log holds 1/);
});

test('a rewritten head is caught even when the entries are untouched', () => {
  const dir = workspace();
  append(dir, proposal(1250));
  const config = JSON.parse(readFileSync(paths(dir).config, 'utf8'));
  config.head.hash = 'A'.repeat(43);
  writeFileSync(paths(dir).config, JSON.stringify(config));
  const state = readState(dir);
  const result = verifyChain(state.entries, state.key.public, state.config.head);
  assert.equal(result.ok, false);
  assert.match(result.reason, /last entry does not match the recorded head/);
});

test('a malformed entry is refused, not thrown', () => {
  const dir = workspace();
  append(dir, proposal(1250));
  const state = readState(dir);

  assert.equal(verifyChain([null], state.key.public, state.config.head).ok, false);
  const bad = structuredClone(state.entries[0]);
  bad.sig = null;
  assert.equal(verifyChain([bad], state.key.public, state.config.head).ok, false);
});

test('a partial init without a key is still uninitialised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-partial-init-'));
  writeFileSync(paths(dir).policy, '{}');
  writeFileSync(paths(dir).config, '{}');
  assert.equal(isInitialised(dir), false);
  init(dir);
  assert.equal(isInitialised(dir), true);
});

test('a live lock waits and then refuses; a stale one is reclaimed', () => {
  const dir = workspace();
  writeFileSync(paths(dir).lock, String(process.pid));
  // Pin the wait: CI raises the budget so eight concurrent writers survive a
  // loaded machine, and this test only asserts that a live holder is refused.
  const budget = process.env.ATTESSO_LOCK_WAIT_MS;
  process.env.ATTESSO_LOCK_WAIT_MS = '50';
  try {
    assert.throws(() => append(dir, proposal(1250)), /holds the ledger/);
  } finally {
    if (budget === undefined) delete process.env.ATTESSO_LOCK_WAIT_MS;
    else process.env.ATTESSO_LOCK_WAIT_MS = budget;
  }

  writeFileSync(paths(dir).lock, '999999');
  const entry = append(dir, proposal(1250));
  assert.equal(entry.seq, 1);
});

test('init refuses to replace an existing key', () => {
  const dir = workspace();
  assert.throws(() => init(dir), /already holds a ledger/);
});

test('an action with no amount records its subject and meta', () => {
  const dir = workspace();
  writeFileSync(paths(dir).policy, JSON.stringify({ version: 1, action: 'tool.call', subjects: ['read_file'] }));
  const entry = append(dir, { action: 'tool.call', subject: 'read_file', meta: { tokens: 1200, cost_usd: 0.0004 } });
  assert.equal(entry.decision, 'ALLOW');
  assert.equal(entry.amount, undefined);
  assert.deepEqual(entry.meta, { tokens: 1200, cost_usd: 0.0004 });
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});
