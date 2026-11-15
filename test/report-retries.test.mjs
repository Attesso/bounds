import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { buildReport } from '../src/report.mjs';
import { paths } from '../src/store.mjs';
import { hookCall, initWorkspace } from './helpers.mjs';

// The metric that says whether a refusal lands: blocked attempts followed by the
// same call again. It should fall toward zero now that every deny carries a
// remedy and a repeated one stops the task.
test('the report counts refusals that were retried, and the worst call', () => {
  const dir = initWorkspace('attesso-retry-metric');
  writeFileSync(
    paths(dir).rules,
    JSON.stringify({ version: 1, rules: [{ id: 'no-loop-2', max_repeats: 2, deny: { capabilities: ['execute'] } }] }),
  );
  for (let attempt = 0; attempt < 6; attempt += 1) {
    hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'npm test' }, session_id: 'loop' });
  }
  const report = buildReport(dir);
  assert.equal(report.totals.blocked, 4, 'three ceiling refusals plus the stop');
  assert.deepEqual(report.retries, { refusals_retried: 3, worst_call_blocked: 4 });
});

test('a ledger with no retries reports zero', () => {
  const dir = initWorkspace('attesso-retry-clean');
  hookCall(dir, { tool_name: 'read_file', tool_input: { path: '/tmp/a' }, session_id: 'clean' });
  hookCall(dir, { tool_name: 'read_file', tool_input: { path: '/tmp/b' }, session_id: 'clean' });
  const report = buildReport(dir);
  assert.deepEqual(report.retries, { refusals_retried: 0, worst_call_blocked: 0 });
});
