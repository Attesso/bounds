import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluatePath, validateRules } from '../src/rules.mjs';
import { append, init, paths, readState } from '../src/store.mjs';
import { verifyChain } from '../src/ledger.mjs';

const rules = validateRules({
  version: 1,
  rules: [
    { id: 'no-send-after-untrusted-read', deny: { capabilities: ['send', 'execute'] }, if_path: { trust: 'untrusted', capability: 'read' } },
  ],
});

const entry = (seq, trust, capability, at = '2026-10-31T12:00:00Z') => ({ seq, trust, capability, at });

test('a rule needs a deny and a path condition', () => {
  assert.throws(() => validateRules({ version: 1 }), /rules must be a list/);
  assert.throws(() => validateRules({ version: 1, rules: [{ id: 'a', if_path: { trust: 'untrusted' } }] }), /denies nothing/);
  assert.throws(
    () => validateRules({ version: 1, rules: [{ id: 'a', deny: { capability: 'delete' }, if_path: { trust: 'untrusted' } }] }),
    /unknown capability delete/,
  );
  assert.throws(() => validateRules({ version: 1, rules: [{ id: 'a', deny: { capability: 'send' }, if_path: {} }] }), /no path condition/);
});

test('an untrusted read blocks a later send and names the step', () => {
  const verdict = evaluatePath(rules, [entry(1, 'internal', 'read'), entry(2, 'untrusted', 'read')], { capability: 'send' });
  assert.deepEqual(verdict, { decision: 'DENY', code: 'PATH_DENIED', rule: 'no-send-after-untrusted-read', tainted_by: 2 });
});

test('an internal read does not taint the path', () => {
  assert.equal(evaluatePath(rules, [entry(1, 'internal', 'read')], { capability: 'send' }), null);
});

test('a capability the rule does not deny passes', () => {
  assert.equal(evaluatePath(rules, [entry(1, 'untrusted', 'read')], { capability: 'read' }), null);
});

test('a taint older than the window no longer applies', () => {
  const withWindow = validateRules({
    version: 1,
    rules: [{ id: 'windowed', deny: { capability: 'send' }, if_path: { trust: 'untrusted', capability: 'read', within_minutes: 10 } }],
  });
  const old = entry(1, 'untrusted', 'read', '2026-10-31T11:00:00Z');
  assert.equal(evaluatePath(withWindow, [old], { capability: 'send' }, new Date('2026-10-31T12:00:00Z')), null);
  assert.equal(evaluatePath(withWindow, [old], { capability: 'send' }, new Date('2026-10-31T11:05:00Z'))?.code, 'PATH_DENIED');
});

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-path-'));
  init(dir);
  writeFileSync(paths(dir).policy, JSON.stringify({ version: 1, action: '*' }));
  return dir;
};

test('the store enforces the path and keeps the chain verifiable', () => {
  const dir = workspace();
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'task-1' });
  const blocked = append(dir, { action: 'mail.send', subject: 'external@example.com', capability: 'send', task: 'task-1' });
  assert.equal(blocked.decision, 'DENY');
  assert.equal(blocked.code, 'PATH_DENIED');
  assert.deepEqual({ rule: blocked.rule, tainted_by: blocked.tainted_by }, { rule: 'no-send-after-untrusted-read', tainted_by: 1 });

  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('another task is judged on its own path', () => {
  const dir = workspace();
  append(dir, { action: 'web.read', capability: 'read', trust: 'untrusted', task: 'task-1' });
  const other = append(dir, { action: 'mail.send', capability: 'send', task: 'task-2' });
  assert.equal(other.decision, 'ALLOW');
});

test('an internal read leaves the send allowed in the same task', () => {
  const dir = workspace();
  append(dir, { action: 'file.read', capability: 'read', trust: 'internal', task: 'task-3' });
  const sent = append(dir, { action: 'mail.send', capability: 'send', task: 'task-3' });
  assert.equal(sent.decision, 'ALLOW');
});

test('init ships the balanced read-then-send and repeat-read rules', () => {
  const dir = workspace();
  const shipped = JSON.parse(readFileSync(paths(dir).rules, 'utf8'));
  assert.equal(shipped.rules.length, 2);
  assert.equal(shipped.rules[0].id, 'no-send-after-untrusted-read');
  assert.deepEqual(shipped.rules[0].deny.capabilities, ['send']);
  assert.equal(shipped.rules[0].if_path.within_minutes, 30);
  assert.equal(shipped.rules[1].id, 'no-repeat-web-extract');
});

test('init --profile strict also denies write and execute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-strict-'));
  init(dir, { profile: 'strict' });
  const shipped = JSON.parse(readFileSync(paths(dir).rules, 'utf8'));
  assert.deepEqual(shipped.rules[0].deny.capabilities, ['send', 'write', 'execute']);
  assert.throws(() => init(mkdtempSync(join(tmpdir(), 'attesso-strict-')), { profile: 'nope' }), /unknown rule profile/);
});
