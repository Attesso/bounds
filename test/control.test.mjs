import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bundleFor, verifyBundle } from '../src/bundle.mjs';
import { clearTaskControl, listControl, readControl, setTaskControl, taskControl } from '../src/control.mjs';
import { verifyChain } from '../src/ledger.mjs';
import { replay } from '../src/replay.mjs';
import { append, init, paths, readState } from '../src/store.mjs';

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-control-'));
  init(dir);
  return dir;
};

test('a control file is atomic and is read back per task', () => {
  const dir = workspace();
  const paused = setTaskControl(dir, 'task-1', 'pause', { reason: 'inspect the diff' });
  assert.equal(paused.mode, 'pause');
  assert.equal(taskControl(dir, 'task-1').reason, 'inspect the diff');
  assert.deepEqual(listControl(dir).map((item) => item.task), ['task-1']);
  assert.deepEqual(readControl(dir).tasks['task-1'].mode, 'pause');

  setTaskControl(dir, 'task-2', 'stop');
  assert.equal(taskControl(dir, 'task-2').mode, 'stop');
  assert.equal(taskControl(dir, 'missing'), undefined);

  clearTaskControl(dir, 'task-1');
  assert.equal(taskControl(dir, 'task-1'), undefined);
  assert.equal(taskControl(dir, 'task-2').mode, 'stop');
});

test('a malformed control file is a control failure, not an empty map', () => {
  const dir = workspace();
  writeFileSync(join(dir, 'control.json'), '{not json');
  assert.throws(() => readControl(dir), /CONTROL_INVALID/);
});

test('a control entry is signed, marked and skipped by replay', () => {
  const dir = workspace();
  const entry = append(
    dir,
    { action: 'shell.execute', subject: 'terminal', capability: 'execute', task: 'task-1' },
    { control: { mode: 'pause', at: '2026-11-01T12:00:00.000Z', reason: 'inspect the diff' } },
  );
  assert.equal(entry.decision, 'DENY');
  assert.equal(entry.code, 'TASK_PAUSED');
  assert.equal(entry.rule, 'control.pause');
  assert.deepEqual(entry.control, { mode: 'pause', at: '2026-11-01T12:00:00.000Z', reason: 'inspect the diff' });

  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
  const summary = replay(state.entries, { policy: { version: 1, action: '*' }, rules: null });
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.newly_denied, 0);
  assert.equal(summary.changed.length, 0);
});

test('a control bundle verifies but is not replayed', () => {
  const dir = workspace();
  append(
    dir,
    { action: 'shell.execute', subject: 'terminal', capability: 'execute', task: 'task-1' },
    { control: { mode: 'stop', at: '2026-11-01T12:00:00.000Z' } },
  );
  const bundle = bundleFor(dir, 1);
  const result = verifyBundle(bundle, { replay: true });
  assert.equal(result.ok, true);
  assert.match(result.reason, /control verdict is not replayed/);
});

test('the control file is kept outside the signed ledger', () => {
  const dir = workspace();
  setTaskControl(dir, 'task-1', 'pause');
  assert.equal(readFileSync(paths(dir).ledger, 'utf8'), '');
  assert.equal(JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')).version, 1);
});
