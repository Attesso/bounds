import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { entryHash, signEntry, verifyChain } from '../src/ledger.mjs';
import { checkpointFor, receiptFor, signerOf, verifyCheckpoint, verifyPinned, verifyReceipt } from '../src/receipt.mjs';
import { append, init, paths, readState } from '../src/store.mjs';
import { initWorkspace, runCli, tempDir } from './helpers.mjs';

const resign = (entries, key) => {
  let prev = 'genesis';
  return entries.map((entry) => {
    const copy = { ...entry, prev };
    copy.sig = signEntry(copy, key.private);
    prev = entryHash(copy);
    return copy;
  });
};

test('a receipt verifies offline for every entry in a real ledger', () => {
  const dir = initWorkspace('attesso-receipt');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'job-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'job-1' });
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'job-2' });

  const state = readState(dir);
  for (const entry of state.entries) {
    const receipt = receiptFor(state.entries, entry.seq - 1, signerOf(state.key));
    const result = verifyReceipt(receipt, state.key.public);
    assert.equal(result.ok, true, `${entry.seq}: ${result.reason}`);
  }
});

test('a tampered entry, a wrong index and a wrong key are all refused', () => {
  const dir = initWorkspace('attesso-receipt');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'search_files', capability: 'read' });
  const state = readState(dir);
  const receipt = receiptFor(state.entries, 1, signerOf(state.key));

  const tampered = structuredClone(receipt);
  tampered.entry.subject = 'elsewhere';
  assert.match(verifyReceipt(tampered, state.key.public).reason, /proof/);

  const wrongIndex = structuredClone(receipt);
  wrongIndex.leaf_index = 0;
  assert.equal(verifyReceipt(wrongIndex, state.key.public).ok, false);

  const shiftedIndex = structuredClone(receipt);
  shiftedIndex.leaf_index += 1;
  assert.match(verifyReceipt(shiftedIndex, state.key.public).reason, /leaf index does not match/);

  const badPath = structuredClone(receipt);
  badPath.path = [null];
  assert.match(verifyReceipt(badPath, state.key.public).reason, /path is not a list of hashes/);

  const badRoot = structuredClone(receipt);
  badRoot.checkpoint.root = null;
  assert.equal(verifyReceipt(badRoot, state.key.public).ok, false);

  const other = initWorkspace('attesso-receipt');
  assert.equal(verifyReceipt(receipt, readState(other).key.public).ok, false);
  assert.equal(verifyReceipt(null).ok, false);
});

test('the checkpoint is signed, and a pin catches a rewrite below it', () => {
  const dir = initWorkspace('attesso-receipt');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read', task: 't' });
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read', task: 't' });
  let state = readState(dir);
  const pinned = checkpointFor(state.entries, {
    kid: state.key.kid,
    privatePem: state.key.private,
    at: new Date('2026-10-31T12:00:00Z'),
  });
  assert.equal(verifyCheckpoint(pinned, state.key.public), true);
  assert.equal(verifyCheckpoint({ ...pinned, size: 99 }, state.key.public), false);

  append(dir, { action: 'tool.call', subject: 'three', capability: 'read', task: 't' });
  state = readState(dir);
  assert.equal(verifyPinned(state.entries, pinned, state.key.public).ok, true);

  // An attacker holding the key can re-sign a rewritten prefix; the pin is what
  // they cannot re-derive.
  const rewritten = state.entries.map((entry, index) => (index === 0 ? { ...entry, subject: 'somewhere-else' } : entry));
  const head = resign(rewritten, state.key);
  let prev = 'genesis';
  for (const entry of head) prev = entryHash(entry);
  writeFileSync(paths(dir).ledger, `${head.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  writeFileSync(paths(dir).config, JSON.stringify({ version: 1, head: { count: head.length, hash: prev } }));

  const after = readState(dir);
  assert.equal(verifyChain(after.entries, after.key.public, after.config.head).ok, true);
  const result = verifyPinned(after.entries, pinned, after.key.public);
  assert.equal(result.ok, false);
  assert.match(result.reason, /pin|prefix|rewritten/);
});

test('a receipt proves itself in an empty directory, with no .attesso', () => {
  const dir = initWorkspace('attesso-receipt');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  const receiptFile = join(dir, 'receipt.json');
  const proved = runCli(dir, 'prove', '2', '--out', receiptFile);
  assert.equal(proved.status, 0, proved.stderr);

  const empty = tempDir('attesso-empty');
  writeFileSync(join(empty, 'receipt.json'), readFileSync(receiptFile));
  const verified = runCli(empty, 'verify-receipt', 'receipt.json');
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /receipt verifies/);

  const receipt = JSON.parse(readFileSync(join(empty, 'receipt.json'), 'utf8'));
  receipt.entry.subject = 'elsewhere';
  writeFileSync(join(empty, 'receipt.json'), JSON.stringify(receipt));
  assert.equal(runCli(empty, 'verify-receipt', 'receipt.json').status, 1);
});

test('a checkpoint can be pinned from the command line', () => {
  const dir = initWorkspace('attesso-receipt');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const head = join(dir, 'head.json');
  assert.equal(runCli(dir, 'checkpoint', '--out', head).status, 0);
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  const verified = runCli(dir, 'verify', '--pin', head);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /pinned head/);
});
