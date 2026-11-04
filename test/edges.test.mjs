import assert from 'node:assert/strict';
import { linkSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { verifyChain } from '../src/ledger.mjs';
import { append, paths, readState } from '../src/store.mjs';
import { hookCall, initWorkspace, readJson, runCli } from './helpers.mjs';

test('a malformed policy fails the command with one line, not a stack', () => {
  const dir = initWorkspace('attesso-bad-policy');
  writeFileSync(paths(dir).policy, '{"version":2}');
  const result = runCli(dir, 'log', '--action', 'tool.call');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /policy is invalid: version must be 1/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a malformed ledger line is reported without a stack', () => {
  const dir = initWorkspace('attesso-bad-ledger');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  writeFileSync(paths(dir).ledger, `${readFileSync(paths(dir).ledger, 'utf8')}not json\n`);
  const result = runCli(dir, 'verify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ledger line 2 is not JSON/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a receipt cannot be written over the ledger it proves', () => {
  const dir = initWorkspace('attesso-out-guard');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const before = readFileSync(paths(dir).ledger, 'utf8');
  const result = runCli(dir, 'prove', '1', '--out', paths(dir).ledger);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing to write/);
  assert.equal(readFileSync(paths(dir).ledger, 'utf8'), before);
});

test('a hook payload with no tool name records an unknown untrusted read', () => {
  const dir = initWorkspace('attesso-empty-payload');
  const result = hookCall(dir, {});
  assert.equal(result.status, 0, result.stderr);
  const state = readState(dir);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].action, 'web.read');
  assert.equal(state.entries[0].trust, 'untrusted');
  assert.equal(state.entries[0].subject, null);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('a long subject survives the line and its receipt', () => {
  const dir = initWorkspace('attesso-long-subject');
  const subject = 'x'.repeat(4000);
  append(dir, { action: 'tool.call', subject, capability: 'read' });
  const state = readState(dir);
  assert.equal(state.entries[0].subject.length, 4000);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);

  const receipt = join(dir, 'receipt.json');
  assert.equal(runCli(dir, 'prove', '1', '--out', receipt).status, 0);
  const checked = runCli(dir, 'verify-receipt', receipt);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /pass --key/);

  const keyFile = join(dir, 'public.pem');
  writeFileSync(keyFile, readState(dir).key.public);
  const pinned = runCli(dir, 'verify-receipt', receipt, '--key', keyFile);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.doesNotMatch(pinned.stdout, /pass --key/);
});

test('an empty ledger has a signed checkpoint a pin accepts', () => {
  const dir = initWorkspace('attesso-empty-head');
  const head = join(dir, 'head.json');
  assert.equal(runCli(dir, 'checkpoint', '--out', head).status, 0);
  const checkpoint = readJson(head);
  assert.equal(checkpoint.size, 0);
  const verified = runCli(dir, 'verify', '--pin', head);
  assert.equal(verified.status, 0, verified.stderr);
});

test('a malformed receipt path is refused, not thrown', () => {
  const dir = initWorkspace('attesso-bad-receipt');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const file = join(dir, 'receipt.json');
  assert.equal(runCli(dir, 'prove', '1', '--out', file).status, 0);
  const receipt = readJson(file);
  receipt.path = [null];
  writeFileSync(file, JSON.stringify(receipt));
  const result = runCli(dir, 'verify-receipt', file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /path is not a list of hashes/);
});

test('a negative amount is refused by the log command', () => {
  const dir = initWorkspace('attesso-negative');
  const result = runCli(dir, 'log', '--action', 'purchase.execute', '--amount', '-1', '--currency', 'EUR');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a positive decimal/);
});

test('a blank line in the middle of the ledger is corruption', () => {
  const dir = initWorkspace('attesso-blank-line');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const line = readFileSync(paths(dir).ledger, 'utf8').trimEnd();
  writeFileSync(paths(dir).ledger, `${line}\n\n`);

  assert.throws(() => readState(dir), /ledger line 2 is not JSON/);
  const result = runCli(dir, 'verify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ledger line 2 is not JSON/);
});

test('a receipt cannot be written over the tool pin', () => {
  const dir = initWorkspace('attesso-toolpin-out');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const result = runCli(dir, 'prove', '1', '--out', paths(dir).toolLock);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /part of the ledger/);
});

test('a hard link out cannot overwrite the ledger', () => {
  const dir = initWorkspace('attesso-hardlink-out');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const link = join(dir, 'receipt.json');
  linkSync(paths(dir).ledger, link);
  const before = readFileSync(paths(dir).ledger, 'utf8');

  const result = runCli(dir, 'prove', '1', '--out', link);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /part of the ledger/);
  assert.equal(readFileSync(paths(dir).ledger, 'utf8'), before);
  assert.equal(runCli(dir, 'verify').status, 0);
});

test('a symlink out cannot overwrite the ledger', () => {
  const dir = initWorkspace('attesso-symlink-out');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const link = join(dir, 'receipt.json');
  symlinkSync(paths(dir).ledger, link);
  const before = readFileSync(paths(dir).ledger, 'utf8');

  const result = runCli(dir, 'prove', '1', '--out', link);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /symbolic link/);
  assert.equal(readFileSync(paths(dir).ledger, 'utf8'), before);
  assert.equal(runCli(dir, 'verify').status, 0);
});

test('a reader ignores a line caught mid-write, and verify still passes', () => {
  const dir = initWorkspace('attesso-mid-write');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  writeFileSync(paths(dir).ledger, `${readFileSync(paths(dir).ledger, 'utf8')}{"seq":2`);

  const state = readState(dir);
  assert.equal(state.entries.length, 1);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
  const result = runCli(dir, 'verify');
  assert.equal(result.status, 0, result.stderr);

  const next = append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  assert.equal(next.seq, 2);
});
