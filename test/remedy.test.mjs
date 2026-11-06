import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REMEDIES, remedyFor } from '../src/remedy.mjs';
import { hookCall, initWorkspace } from './helpers.mjs';
import { paths } from '../src/store.mjs';

// Every refusal code the reference documents. A new code without a remedy is a
// new retry trap, so this list is the contract: adding a code to the engine
// without teaching it a remedy fails here.
const DOCUMENTED_CODES = [
  'ACTION_MISMATCH',
  'REQUIRED_ATTRIBUTE_MISSING',
  'VALUE_NOT_ALLOWED',
  'VALUE_MISMATCH',
  'ABOVE_MAXIMUM',
  'OUTSIDE_DATE_RANGE',
  'PATH_DENIED',
  'STEP_LIMIT',
  'REPEAT_LIMIT',
  'BUDGET_EXCEEDED',
  'PATH_SCOPE_DENIED',
  'PATH_REQUIRED',
  'SHELL_SCOPE_DENIED',
  'TOOL_CHANGED',
  'TASK_PAUSED',
  'TASK_STOPPED',
  'CONTROL_UNAVAILABLE',
  'DECISION_UNAVAILABLE',
  'EXECUTION_WINDOW_ENDED',
];

test('every documented refusal code has a remedy from the closed list', () => {
  for (const code of DOCUMENTED_CODES) {
    const remedy = remedyFor(code);
    assert.ok(REMEDIES.includes(remedy), `${code} mapped to ${remedy}, which is not in REMEDIES`);
  }
});

test('the list is closed and the fallback stops rather than invites a rewrite', () => {
  assert.equal(remedyFor('SOMETHING_NEW'), 'stop');
  assert.deepEqual([...REMEDIES].sort(), [
    'change_arguments',
    'raise_budget',
    'request_approval',
    'resume_task',
    'stop',
  ]);
});

test('a refused hook call carries the remedy, an allowed one carries none', () => {
  const dir = initWorkspace('attesso-remedy');
  // A send after an untrusted read is the default profile's refusal.
  hookCall(dir, { tool_name: 'web_extract', tool_input: { url: 'https://example.com' }, session_id: 's' });
  const refused = hookCall(dir, { tool_name: 'send_email', tool_input: { to: 'a@b.example' }, session_id: 's' });
  assert.equal(refused.status, 2);
  const body = JSON.parse(refused.stdout);
  // stdout is the rendered harness shape, not the decider's body.
  assert.equal(body.decision, 'block');
  assert.equal(body.remedy, 'request_approval');

  const allowed = hookCall(dir, { tool_name: 'read_file', tool_input: { path: '/tmp/x' }, session_id: 's2' });
  assert.equal(allowed.status, 0);
  assert.equal('remedy' in JSON.parse(allowed.stdout), false);
});

test('a budget refusal says raise_budget', () => {
  const dir = initWorkspace('attesso-remedy-budget');
  spawnSync('node', [join(import.meta.dirname, '..', 'bin', 'attesso.mjs'), '--dir', dir, 'run', 'start'], {
    encoding: 'utf8',
  });
  spawnSync('node', [join(import.meta.dirname, '..', 'bin', 'attesso.mjs'), '--dir', dir, 'budget', '--tokens', '10', '--enforce'], {
    encoding: 'utf8',
  });
  spawnSync(
    'node',
    [join(import.meta.dirname, '..', 'bin', 'attesso.mjs'), '--dir', dir, 'usage', '--task', 's', '--input', '50', '--output', '0', '--cost', '0'],
    { encoding: 'utf8' },
  );
  const refused = hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'echo hi' }, session_id: 's' });
  assert.equal(refused.status, 2);
  const body = JSON.parse(refused.stdout);
  assert.equal(body.code, 'BUDGET_EXCEEDED');
  assert.equal(body.remedy, 'raise_budget');
});

test('serve answers with the same remedy on the same verdict', () => {
  const dir = initWorkspace('attesso-remedy-serve');
  writeFileSync(
    paths(dir).policy,
    JSON.stringify({ version: 1, action: 'purchase.execute', currency: 'EUR', max_amount: 1000, subjects: ['shop.example'] }),
  );
  const request = JSON.stringify({ id: 'r1', action: 'purchase.execute', subject: 'shop.example', amount: { minor: 5000, currency: 'EUR' }, task: 't' });
  const result = spawnSync('node', [join(import.meta.dirname, '..', 'bin', 'attesso.mjs'), '--dir', dir, 'serve'], {
    input: `${request}\n`,
    encoding: 'utf8',
  });
  const answer = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.equal(answer.decision, 'DENY');
  assert.equal(answer.code, 'ABOVE_MAXIMUM');
  assert.equal(answer.remedy, 'change_arguments');
});
