import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluatePath, validateRules } from '../src/rules.mjs';
import { append, appendUsage, init, paths, readState } from '../src/store.mjs';
import { verifyChain } from '../src/ledger.mjs';

const rules = validateRules({
  version: 1,
  rules: [
    { id: 'no-send-after-untrusted-read', deny: { capabilities: ['send', 'execute'] }, if_path: { trust: 'untrusted', capability: 'read' } },
  ],
});

const entry = (seq, trust, capability, at = '2026-10-31T12:00:00Z') => ({ seq, trust, capability, at });

const usageEntry = (seq, input, output, cost = 0, runId) => ({
  seq,
  action: 'llm.session',
  capability: 'model',
  at: '2026-10-31T12:00:00Z',
  ...(runId ? { run_id: runId } : {}),
  meta: { usage: { input_tokens: input, output_tokens: output, cached_tokens: 0, cost_usd: cost } },
});

test('a rule needs a deny and a path condition', () => {
  assert.throws(() => validateRules({ version: 1 }), /rules must be a list/);
  assert.throws(() => validateRules({ version: 1, rules: [{ id: 'a', if_path: { trust: 'untrusted' } }] }), /denies nothing/);
  assert.throws(
    () => validateRules({ version: 1, rules: [{ id: 'a', deny: { capability: 'delete' }, if_path: { trust: 'untrusted' } }] }),
    /unknown capability delete/,
  );
  assert.throws(() => validateRules({ version: 1, rules: [{ id: 'a', deny: { capability: 'send' }, if_path: {} }] }), /no path condition/);
  assert.throws(
    () => validateRules({ version: 1, rules: [{ id: 'a', deny: { capability: 'send' }, if_path: { trust: 'untrusted' }, enforce: 'yes' }] }),
    /boolean enforce/,
  );
});

test('an enforced rule says so in its verdict', () => {
  const enforced = validateRules({
    version: 1,
    rules: [{ id: 'enforced', deny: { capability: 'send' }, if_path: { trust: 'untrusted', capability: 'read' }, enforce: true }],
  });
  assert.deepEqual(
    evaluatePath(enforced, [entry(1, 'untrusted', 'read')], { capability: 'send' }),
    { decision: 'DENY', code: 'PATH_DENIED', rule: 'enforced', tainted_by: 1, enforce: true },
  );
});

test('a run budget needs a positive ceiling', () => {
  assert.throws(
    () => validateRules({ version: 1, rules: [{ id: 'b', max_tokens: 0, deny: { capabilities: ['execute'] } }] }),
    /max_tokens of at least 1/,
  );
  assert.throws(
    () => validateRules({ version: 1, rules: [{ id: 'b', max_cost_usd: -1, deny: { capabilities: ['execute'] } }] }),
    /positive max_cost_usd/,
  );
});

test('a run budget blocks the next execute at the ceiling and not before', () => {
  const budget = validateRules({
    version: 1,
    rules: [{ id: 'run-budget', max_tokens: 200000, deny: { capabilities: ['execute'] } }],
  });
  assert.equal(evaluatePath(budget, [usageEntry(1, 100000, 99999)], { capability: 'execute' }), null);
  assert.deepEqual(
    evaluatePath(budget, [usageEntry(1, 100000, 100000)], { capability: 'execute' }),
    { decision: 'DENY', code: 'BUDGET_EXCEEDED', rule: 'run-budget' },
  );
});

test('a run budget sums only the active run and falls back to the task without one', () => {
  const budget = validateRules({
    version: 1,
    rules: [{ id: 'run-budget', max_tokens: 1000, deny: { capabilities: ['execute'] } }],
  });
  const history = [usageEntry(1, 600, 600, 0, 'run_a')];
  assert.equal(evaluatePath(budget, history, { capability: 'execute', run_id: 'run_a' })?.code, 'BUDGET_EXCEEDED');
  assert.equal(evaluatePath(budget, history, { capability: 'execute', run_id: 'run_b' }), null);
  assert.equal(evaluatePath(budget, history, { capability: 'execute' })?.code, 'BUDGET_EXCEEDED');
});

test('a run budget can count recorded cost', () => {
  const budget = validateRules({
    version: 1,
    rules: [{ id: 'run-budget', max_cost_usd: 0.5, deny: { capabilities: ['execute'] } }],
  });
  assert.equal(evaluatePath(budget, [usageEntry(1, 0, 0, 0.49)], { capability: 'execute' }), null);
  assert.equal(evaluatePath(budget, [usageEntry(1, 0, 0, 0.5)], { capability: 'execute' })?.code, 'BUDGET_EXCEEDED');
});

test('a run budget without usage does not fire', () => {
  const budget = validateRules({
    version: 1,
    rules: [{ id: 'run-budget', max_tokens: 200000, deny: { capabilities: ['execute'] } }],
  });
  assert.equal(evaluatePath(budget, [], { capability: 'execute' }), null);
});

test('an enforced run budget says so in its verdict', () => {
  const budget = validateRules({
    version: 1,
    rules: [{ id: 'run-budget', max_tokens: 1000, deny: { capabilities: ['execute'] }, enforce: true }],
  });
  assert.deepEqual(
    evaluatePath(budget, [usageEntry(1, 600, 600)], { capability: 'execute' }),
    { decision: 'DENY', code: 'BUDGET_EXCEEDED', rule: 'run-budget', enforce: true },
  );
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

test('a run budget sums only its own task and blocks the next execute', () => {
  const dir = workspace();
  writeFileSync(paths(dir).rules, JSON.stringify({
    version: 1,
    rules: [{ id: 'run-budget', max_tokens: 200000, deny: { capabilities: ['execute'] } }],
  }));
  appendUsage(dir, { task: 'task-a', inputTokens: 150000, outputTokens: 60000 });
  const blocked = append(dir, { action: 'shell.execute', capability: 'execute', task: 'task-a' });
  assert.equal(blocked.code, 'BUDGET_EXCEEDED');
  const other = append(dir, { action: 'shell.execute', capability: 'execute', task: 'task-b' });
  assert.equal(other.decision, 'ALLOW');
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
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
