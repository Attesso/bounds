import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { verifyChain } from '../src/ledger.mjs';
import { serve } from '../src/serve.mjs';
import { appendUsage, init, paths, readRunBudget, readState, setRunBudget } from '../src/store.mjs';
import { hookCall, runCli, tempDir } from './helpers.mjs';

test('setRunBudget writes one rule and keeps the others', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  const result = setRunBudget(dir, { tokens: '1000', enforce: true });
  assert.equal(result.changed, true);
  const rules = JSON.parse(readFileSync(paths(dir).rules, 'utf8'));
  assert.equal(rules.rules[0].id, 'run-budget');
  assert.equal(rules.rules[0].max_tokens, 1000);
  assert.equal(rules.rules[0].enforce, true);
  assert.deepEqual(rules.rules[0].deny.capabilities, ['execute', 'write', 'send']);
  assert.equal(rules.rules.length, 3);
  assert.equal(existsSync(`${paths(dir).rules}.bak`), true);
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('setRunBudget replaces its rule instead of adding a second', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  setRunBudget(dir, { tokens: '1000', enforce: true });
  setRunBudget(dir, { usd: '0.5' });
  const rules = JSON.parse(readFileSync(paths(dir).rules, 'utf8'));
  const budget = rules.rules.filter((rule) => rule.id === 'run-budget');
  assert.equal(budget.length, 1);
  assert.equal(budget[0].max_tokens, undefined);
  assert.equal(budget[0].max_cost_usd, 0.5);
  assert.equal(budget[0].enforce, undefined);
});

test('setRunBudget --off removes only its rule', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  setRunBudget(dir, { tokens: '1000' });
  const result = setRunBudget(dir, { off: true });
  assert.equal(result.changed, true);
  assert.equal(result.rule, undefined);
  const rules = JSON.parse(readFileSync(paths(dir).rules, 'utf8'));
  assert.equal(rules.rules.some((rule) => rule.id === 'run-budget'), false);
  assert.equal(rules.rules.length, 2);
});

test('setRunBudget refuses bad values without writing', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  const before = readFileSync(paths(dir).rules, 'utf8');
  assert.throws(() => setRunBudget(dir, { tokens: '0' }), /--tokens/);
  assert.throws(() => setRunBudget(dir, { usd: '-1' }), /--usd/);
  assert.throws(() => setRunBudget(dir, {}), /--tokens or --usd/);
  assert.throws(() => setRunBudget(dir, { off: true, tokens: '1000' }), /--off/);
  assert.equal(readFileSync(paths(dir).rules, 'utf8'), before);
});

test('readRunBudget reads the rule the page shows', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  assert.equal(readRunBudget(dir), null);
  setRunBudget(dir, { tokens: '1000', usd: '0.5', enforce: true });
  assert.deepEqual(readRunBudget(dir), { tokens: 1000, usd: 0.5, enforce: true });
  setRunBudget(dir, { off: true });
  assert.equal(readRunBudget(dir), null);
});

test('the budget command reports and removes the cap', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  const written = runCli(dir, 'budget', '--tokens', '1000', '--enforce');
  assert.equal(written.status, 0);
  assert.match(written.stdout, /1,000 tokens/);
  assert.match(written.stdout, /enforced/);
  const removed = runCli(dir, 'budget', '--off');
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /removed/);
});

test('a budget written by the CLI stops the next tool call in observe mode', () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  assert.equal(runCli(dir, 'budget', '--tokens', '1000', '--enforce').status, 0);
  assert.equal(runCli(dir, 'usage', '--task', 'session-1', '--input', '600', '--output', '600').status, 0);
  const stop = hookCall(dir, { tool_name: 'terminal', tool_input: {} }, ['--observe']);
  assert.equal(stop.status, 2);
  const body = JSON.parse(stop.stdout);
  assert.equal(body.code, 'BUDGET_EXCEEDED');
  const state = readState(dir);
  assert.equal(state.entries.at(-1).code, 'BUDGET_EXCEEDED');
  assert.equal(state.entries.at(-1).enforce, true);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('serve enforces an enforced budget in observe mode', async () => {
  const dir = tempDir('attesso-budget');
  init(dir);
  setRunBudget(dir, { tokens: '1000', enforce: true });
  appendUsage(dir, { task: 'session-1', inputTokens: 600, outputTokens: 600 });
  const output = { text: '', write(chunk) { this.text += chunk; } };
  const request = {
    id: 7,
    action: 'shell.execute',
    subject: 'terminal',
    task: 'session-1',
    capability: 'execute',
  };
  await serve(dir, { observe: true, input: Readable.from([`${JSON.stringify(request)}\n`]), output });
  const body = JSON.parse(output.text.trim());
  assert.equal(body.code, 'BUDGET_EXCEEDED');
  assert.equal(body.enforced, true);
  assert.equal(body.seq, 2);
});
