import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyChain } from '../src/ledger.mjs';
import { endRun, lastRunFrom, startRun } from '../src/run.mjs';
import { append, appendUsage, init, readActiveRun, readState, setRunBudget } from '../src/store.mjs';
import { hookCall, runCli, tempDir } from './helpers.mjs';

const workspace = () => {
  const dir = tempDir('attesso-run');
  init(dir);
  return dir;
};

test('startRun opens a signed run and endRun closes it', () => {
  const dir = workspace();
  const run = startRun(dir, { goal: 'fix the test' });
  assert.match(run.id, /^run_/);
  assert.deepEqual(readActiveRun(dir), {
    version: 1,
    id: run.id,
    started_at: run.started_at,
    goal: 'fix the test',
  });
  const started = readState(dir);
  assert.equal(started.entries.at(-1).action, 'run.start');
  assert.equal(started.entries.at(-1).run_id, run.id);
  assert.equal(started.entries.at(-1).meta.goal, 'fix the test');

  const ended = endRun(dir, { outcome: 'success', note: 'tests pass' });
  assert.equal(ended.id, run.id);
  assert.equal(ended.outcome, 'success');
  assert.equal(readActiveRun(dir), null);
  const state = readState(dir);
  assert.equal(state.entries.at(-1).action, 'run.end');
  assert.equal(state.entries.at(-1).run_id, run.id);
  assert.deepEqual(state.entries.at(-1).meta, { outcome: 'success', note: 'tests pass' });
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('endRun refuses an unknown outcome and lastRunFrom reads the closed run', () => {
  const dir = workspace();
  const first = startRun(dir, { goal: 'first' });
  assert.throws(() => endRun(dir, { outcome: 'maybe' }), /outcome must be/);
  endRun(dir, { outcome: 'failed', note: 'budget hit' });

  const active = startRun(dir, { goal: 'second' });
  const last = lastRunFrom(readState(dir).entries);
  assert.equal(last.id, first.id);
  assert.equal(last.goal, 'first');
  assert.equal(last.outcome, 'failed');
  assert.equal(last.note, 'budget hit');

  endRun(dir, { outcome: 'abandoned' });
  const next = lastRunFrom(readState(dir).entries);
  assert.equal(next.id, active.id);
  assert.equal(next.outcome, 'abandoned');
  assert.equal(next.note, null);
});

test('a decision and its usage carry the active run id', () => {
  const dir = workspace();
  const run = startRun(dir, {});
  append(dir, { action: 'tool.call', subject: 'read_file', task: 'task-1', capability: 'read', trust: 'internal' });
  appendUsage(dir, { task: 'task-1', inputTokens: 10, outputTokens: 5 });
  const entries = readState(dir).entries;
  assert.equal(entries.find((entry) => entry.action === 'tool.call').run_id, run.id);
  assert.equal(entries.find((entry) => entry.action === 'llm.session').run_id, run.id);
});

test('two runs in one task do not share a run id', () => {
  const dir = workspace();
  const first = startRun(dir, {});
  append(dir, { action: 'tool.call', subject: 'read_file', task: 'task-1', capability: 'read' });
  endRun(dir);
  const second = startRun(dir, {});
  append(dir, { action: 'tool.call', subject: 'read_file', task: 'task-1', capability: 'read' });
  const calls = readState(dir).entries.filter((entry) => entry.action === 'tool.call');
  assert.equal(calls[0].run_id, first.id);
  assert.equal(calls[1].run_id, second.id);
});

test('a run budget resets with a new run and blocks at the cap', () => {
  const dir = workspace();
  setRunBudget(dir, { tokens: '1000', enforce: true });
  const first = startRun(dir, {});
  appendUsage(dir, { task: 'task-1', inputTokens: 600, outputTokens: 600 });
  const blocked = append(dir, { action: 'shell.execute', capability: 'execute', task: 'task-1' });
  assert.equal(blocked.code, 'BUDGET_EXCEEDED');
  assert.equal(blocked.run_id, first.id);
  endRun(dir);
  const second = startRun(dir, {});
  const allowed = append(dir, { action: 'shell.execute', capability: 'execute', task: 'task-1' });
  assert.equal(allowed.decision, 'ALLOW');
  assert.equal(allowed.run_id, second.id);
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('run start refuses a second active run and run end refuses without one', () => {
  const dir = workspace();
  assert.throws(() => endRun(dir), /no active run/);
  startRun(dir, {});
  assert.throws(() => startRun(dir, {}), /already active/);
});

test('the run commands report through the CLI', () => {
  const dir = workspace();
  const started = runCli(dir, 'run', 'start', '--goal', 'fix the test');
  assert.equal(started.status, 0);
  assert.match(started.stdout, /run_.*started: fix the test/);

  const status = runCli(dir, 'run', 'status', '--json');
  assert.equal(status.status, 0);
  const active = JSON.parse(status.stdout);
  assert.equal(active.goal, 'fix the test');

  const ended = runCli(dir, 'run', 'end', '--outcome', 'success', '--note', 'done');
  assert.equal(ended.status, 0);
  assert.match(ended.stdout, /ended: success \(done\)/);
  assert.deepEqual(readState(dir).entries.at(-1).meta, { outcome: 'success', note: 'done' });

  const none = runCli(dir, 'run', 'status', '--json');
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim(), 'null');
});

test('the hook tags a decision with the active run', () => {
  const dir = workspace();
  const run = startRun(dir, {});
  const call = hookCall(dir, { tool_name: 'read_file' });
  assert.equal(call.status, 0);
  const entries = readState(dir).entries;
  assert.equal(entries.at(-1).run_id, run.id);
});
