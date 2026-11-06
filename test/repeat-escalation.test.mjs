import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { listControl } from '../src/control.mjs';
import { bin, hookCall, initWorkspace } from './helpers.mjs';
import { paths, readEntries } from '../src/store.mjs';

// The trap this closes: one measured ledger has an identical call refused 106
// times. A refusal with a remedy is an answer; a task that keeps being refused
// at its ceiling has to end, or the agent spends its budget hearing the same
// sentence.
const repeatWorkspace = () => {
  const dir = initWorkspace('attesso-repeat-escalation');
  writeFileSync(
    paths(dir).rules,
    JSON.stringify({ version: 1, rules: [{ id: 'no-loop-2', max_repeats: 2, deny: { capabilities: ['execute'] } }] }),
  );
  return dir;
};

const shell = (dir, command) =>
  hookCall(dir, { tool_name: 'terminal', tool_input: { command }, session_id: 'task-loop' });

const bodyOf = (result) => JSON.parse(result.stdout || '{}');

test('a loop that ignores the refusal stops the task instead of denying again', () => {
  const dir = repeatWorkspace();

  assert.equal(bodyOf(shell(dir, 'npm test')).decision, 'allow');
  assert.equal(bodyOf(shell(dir, 'npm test')).decision, 'allow');

  // Calls three to five are refused at the ceiling, with a remedy to act on.
  for (const attempt of [3, 4, 5]) {
    const body = bodyOf(shell(dir, 'npm test'));
    assert.equal(body.decision, 'block', `attempt ${attempt} should be refused`);
    assert.equal(body.remedy, 'change_arguments', `attempt ${attempt} should name the remedy`);
  }

  // The sixth is refused often enough to be a loop, not a correction.
  const stopped = shell(dir, 'npm test');
  const body = bodyOf(stopped);
  assert.equal(body.code, 'TASK_STOPPED');
  assert.equal(body.remedy, 'resume_task');
  assert.equal(stopped.status, 2);

  // The code does not claim a state nothing recorded.
  const control = listControl(dir).find((entry) => entry.task === 'task-loop');
  assert.equal(control.mode, 'stop');
  assert.match(control.reason, /kept returning after a refusal/);

  // And the next call is refused by control, before any rule runs: a different
  // command in the same task is stopped too.
  const after = bodyOf(shell(dir, 'npm run lint'));
  assert.equal(after.code, 'TASK_STOPPED');
});

test('the ledger records the stop, so the loop is visible after the fact', () => {
  const dir = repeatWorkspace();
  for (let attempt = 0; attempt < 6; attempt += 1) shell(dir, 'npm test');
  const entries = readEntries(dir);
  const codes = entries.map((entry) => entry.code);
  assert.equal(codes.filter((code) => code === 'REPEAT_LIMIT').length, 3);
  assert.equal(codes.filter((code) => code === 'TASK_STOPPED').length, 1);
});

test('observe mode records the stop verdict without steering the task', () => {
  const dir = repeatWorkspace();
  spawnSync('node', [bin, '--dir', dir, 'mode', 'observe'], { encoding: 'utf8' });
  for (let attempt = 0; attempt < 6; attempt += 1) shell(dir, 'npm test');
  assert.equal(listControl(dir).length, 0);
  const last = readEntries(dir).at(-1);
  assert.equal(last.code, 'TASK_STOPPED');
});

test('the serve path stops the task too, not only the hook', () => {
  const dir = repeatWorkspace();
  const line = JSON.stringify({
    id: 'r',
    action: 'tool.call',
    subject: 'terminal',
    capability: 'execute',
    task: 'task-serve',
    meta: { args_hash: 'same' },
  });
  const result = spawnSync('node', [bin, '--dir', dir, 'serve'], {
    input: `${Array.from({ length: 6 }, () => line).join('\n')}\n`,
    encoding: 'utf8',
  });
  const answers = result.stdout.trim().split('\n').map((each) => JSON.parse(each));
  assert.equal(answers.length, 6);
  assert.equal(answers.filter((answer) => answer.decision === 'ALLOW').length, 2);
  assert.equal(answers.at(-1).code, 'TASK_STOPPED');
  assert.equal(answers.at(-1).remedy, 'resume_task');
  assert.equal(listControl(dir).find((entry) => entry.task === 'task-serve').mode, 'stop');
});
