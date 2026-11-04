import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { forEachEntry, forEachEntrySync } from '../src/stream.mjs';
import { verifyChain } from '../src/ledger.mjs';
import { append, paths, readEntries, readState, verifyLedger } from '../src/store.mjs';
import { initWorkspace } from './helpers.mjs';

const collect = async (file) => {
  const entries = [];
  await forEachEntry(file, (entry) => entries.push(entry));
  return entries;
};

const collectSync = (file) => {
  const entries = [];
  forEachEntrySync(file, (entry) => entries.push(entry));
  return entries;
};

test('the sync stream agrees with the array and async readers', async () => {
  const dir = initWorkspace('attesso-stream');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  const state = readState(dir);
  assert.deepEqual(collectSync(paths(dir).ledger), state.entries);
  assert.deepEqual(collectSync(paths(dir).ledger), await collect(paths(dir).ledger));
});

test('streaming reads the same entries as the array reader', async () => {
  const dir = initWorkspace('attesso-stream');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'two', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'three', capability: 'read' });

  const state = readState(dir);
  assert.deepEqual(await collect(paths(dir).ledger), state.entries);
  assert.equal((await verifyLedger(dir)).ok, true);
  assert.deepEqual(
    await verifyLedger(dir).then(({ ok, reason }) => ({ ok, reason })),
    verifyChain(state.entries, state.key.public, state.config.head),
  );
});

test('a torn tail is ignored and a parseable tail without a newline still counts', async () => {
  const dir = initWorkspace('attesso-stream');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const valid = readFileSync(paths(dir).ledger, 'utf8');

  writeFileSync(paths(dir).ledger, `${valid}{"partial"`);
  assert.equal((await collect(paths(dir).ledger)).length, 1);
  assert.equal((await verifyLedger(dir)).ok, true);

  writeFileSync(paths(dir).ledger, valid.trimEnd());
  assert.equal((await collect(paths(dir).ledger)).length, 1);
  assert.equal((await verifyLedger(dir)).ok, true);
});

test('a blank complete line is corruption in both readers', async () => {
  const dir = initWorkspace('attesso-stream');
  append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const valid = readFileSync(paths(dir).ledger, 'utf8');
  writeFileSync(paths(dir).ledger, `${valid}\n`);

  assert.throws(() => readEntries(dir), /ledger line 2 is not JSON/);
  await assert.rejects(() => collect(paths(dir).ledger), /ledger line 2 is not JSON/);
  assert.equal((await verifyLedger(dir)).ok, false);
  assert.match((await verifyLedger(dir)).reason, /ledger line 2 is not JSON/);
});

test('a tampered entry fails the streamed verifier with the same reason', async () => {
  const dir = initWorkspace('attesso-stream');
  const entry = append(dir, { action: 'tool.call', subject: 'one', capability: 'read' });
  const state = readState(dir);
  entry.decision = 'DENY';
  writeFileSync(paths(dir).ledger, `${JSON.stringify(entry)}\n`);

  const array = verifyChain([entry], state.key.public, state.config.head);
  const streamed = await verifyLedger(dir);
  assert.equal(array.ok, false);
  assert.equal(streamed.ok, false);
  assert.equal(streamed.reason, array.reason);
});

test('stream and array agree across random entries', async () => {
  const dir = initWorkspace('attesso-stream');
  let seed = 20261101;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  for (let index = 0; index < 30; index += 1) {
    append(dir, {
      action: pick(['tool.call', 'web.read', 'file.write']),
      subject: `tool-${index}-${pick(['plain', 'quote"here', 'line\nbreak', '中文'])}`,
      capability: pick(['read', 'write', 'send', 'execute']),
      trust: pick(['internal', 'untrusted', 'unknown']),
      task: pick(['task-a', 'task-b']),
      meta: { tokens: index, marker: pick(['a', 'b']) },
    });
  }
  const state = readState(dir);
  assert.deepEqual(await collect(paths(dir).ledger), state.entries);
  assert.equal((await verifyLedger(dir)).ok, true);
});
