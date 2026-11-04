import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyChain } from '../src/ledger.mjs';
import { receiptFor, signerOf, verifyReceipt } from '../src/receipt.mjs';
import { append, readState } from '../src/store.mjs';
import { initWorkspace } from './helpers.mjs';

const ACTIONS = ['tool.call', 'web.read', 'mail.send', 'purchase.execute'];
const CAPABILITIES = ['read', 'write', 'send', 'execute'];
const TRUSTS = ['trusted', 'untrusted'];
const ALPHABET = ['a', 'Z', ' ', '"', '\\', '\n', '\t', 'e\u0301', '\u4e2d', '\ud83d\ude00'];

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function text(random, max) {
  const length = Math.floor(random() * (max + 1));
  let value = '';
  for (let index = 0; index < length; index += 1) value += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return value;
}

test('random proposals keep one verifiable chain and portable receipts', () => {
  const random = randomSource(20261031);
  const dir = initWorkspace('attesso-fuzz');
  const count = 150;

  for (let index = 0; index < count; index += 1) {
    const proposal = {
      action: ACTIONS[Math.floor(random() * ACTIONS.length)],
      capability: CAPABILITIES[Math.floor(random() * CAPABILITIES.length)],
      trust: TRUSTS[Math.floor(random() * TRUSTS.length)],
      subject: random() < 0.1 ? null : text(random, 120),
      task: random() < 0.5 ? `task-${Math.floor(random() * 4)}` : undefined,
      args_hash: random() < 0.4 ? text(random, 40) : undefined,
      meta: random() < 0.4 ? { note: text(random, 60), nested: { flag: random() < 0.5 } } : undefined,
    };
    if (random() < 0.3) {
      proposal.amount = Math.floor(random() * 100000);
      proposal.currency = 'EUR';
    }
    const entry = append(dir, proposal);
    assert.equal(entry.seq, index + 1, `proposal ${index}`);
  }

  const state = readState(dir);
  assert.equal(state.entries.length, count);
  assert.deepEqual(
    state.entries.map((entry) => entry.seq),
    Array.from({ length: count }, (_, index) => index + 1),
  );
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const index = Math.floor(random() * count);
    const receipt = receiptFor(state.entries, index, signerOf(state.key));
    assert.equal(verifyReceipt(receipt, state.key.public).ok, true, `receipt ${index}`);
  }
});
