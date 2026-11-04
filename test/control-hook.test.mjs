import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTaskControl } from '../src/control.mjs';
import { readState } from '../src/store.mjs';
import { hookCall, initWorkspace, runCli } from './helpers.mjs';

test('a paused task is refused and the next entry carries the control', () => {
  const dir = initWorkspace('attesso-control-hook');
  runCli(dir, 'pause', 'session-1', '--reason', 'inspect the diff');
  const blocked = hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'ls' } });
  assert.equal(blocked.status, 2);
  const body = JSON.parse(blocked.stdout);
  assert.equal(body.decision, 'block');
  assert.equal(body.code, 'TASK_PAUSED');
  assert.match(body.message, /attesso resume session-1/);
  const { entries } = readState(dir);
  assert.equal(entries[0].control.mode, 'pause');
  assert.equal(entries[0].control.reason, 'inspect the diff');
});

test('a pause on one task does not block another task', () => {
  const dir = initWorkspace('attesso-control-hook');
  setTaskControl(dir, 'task-a', 'pause');
  const other = hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'ls' }, session_id: 'task-b' });
  assert.equal(other.status, 0);
  assert.equal(JSON.parse(other.stdout).decision, 'allow');
});

test('resume releases a paused task and stop persists', () => {
  const dir = initWorkspace('attesso-control-hook');
  runCli(dir, 'stop', 'session-1');
  assert.equal(hookCall(dir, { tool_name: 'terminal', tool_input: {} }).status, 2);
  runCli(dir, 'resume', 'session-1');
  assert.equal(hookCall(dir, { tool_name: 'terminal', tool_input: {} }).status, 0);
  runCli(dir, 'stop', 'session-1');
  runCli(dir, 'resume', 'session-1');
  runCli(dir, 'pause', 'session-1');
  assert.equal(hookCall(dir, { tool_name: 'terminal', tool_input: {} }).status, 2);
});

test('pause is an explicit override of observe', () => {
  const dir = initWorkspace('attesso-control-hook');
  runCli(dir, 'pause', 'session-1');
  const blocked = hookCall(dir, { tool_name: 'terminal', tool_input: {} }, ['--observe']);
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
});

test('a malformed control file fails closed and does not append', () => {
  const dir = initWorkspace('attesso-control-hook');
  writeFileSync(join(dir, 'control.json'), '{not json');
  const blocked = hookCall(dir, { tool_name: 'terminal', tool_input: {} });
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).code, 'CONTROL_UNAVAILABLE');
  assert.equal(readState(dir).entries.length, 0);
});

test('the control command lists and clears one task', () => {
  const dir = initWorkspace('attesso-control-hook');
  runCli(dir, 'pause', 'task-a', '--reason', 'inspect');
  runCli(dir, 'stop', 'task-b');
  const listed = runCli(dir, 'control');
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /task-a\s+pause/);
  assert.match(listed.stdout, /task-b\s+stop/);
  assert.equal(runCli(dir, 'resume', 'task-a').status, 0);
  assert.doesNotMatch(runCli(dir, 'control').stdout, /task-a/);
});
