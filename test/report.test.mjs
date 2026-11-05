import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, buildReportStream, renderReport } from '../src/report.mjs';
import { endRun, startRun } from '../src/run.mjs';
import { append, appendUsage, init, paths } from '../src/store.mjs';

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-report-'));
  init(dir);
  writeFileSync(paths(dir).policy, JSON.stringify({ version: 1, action: '*' }));
  return dir;
};

const allowed = (dir, tool, task) => append(dir, { action: 'tool.call', subject: tool, task, capability: 'read', trust: 'internal' });

test('the report counts actions, refusals, reasons, tokens and cost per task', () => {
  const dir = workspace();
  allowed(dir, 'read_file', 'task-a');
  allowed(dir, 'search_files', 'task-a');
  append(dir, { action: 'tool.call', subject: 'web_search', task: 'task-a', capability: 'read', trust: 'untrusted' });
  append(dir, { action: 'message.send', subject: 'send_email', task: 'task-a', capability: 'send' });
  append(dir, { action: 'llm.session', subject: 'deepseek', task: 'task-a', meta: { tokens: 1000, cached_tokens: 500, cost_usd: 0.01, api_calls: 4 } });
  allowed(dir, 'read_file', 'task-b');

  const report = buildReport(dir);
  const a = report.tasks.find((task) => task.task === 'task-a');
  assert.equal(a.actions, 4);
  assert.equal(a.allowed, 3);
  assert.equal(a.blocked, 1);
  assert.deepEqual(a.reasons, [{ code: 'PATH_DENIED', count: 1 }]);
  assert.equal(a.tokens, 1000);
  assert.equal(a.cached_tokens, 500);
  assert.equal(a.cost_usd, 0.01);

  const b = report.tasks.find((task) => task.task === 'task-b');
  assert.equal(b.actions, 1);
  assert.equal(b.blocked, 0);

  // llm.session is a cost record, not an action: it must not inflate the count.
  assert.equal(report.totals.actions, 5);
  assert.equal(report.totals.tokens, 1000);

  const rendered = renderReport(report);
  assert.match(rendered, /5 actions, 1 refused \(20%\)/);
  assert.match(rendered, /PATH_DENIED×1/);
  assert.match(rendered, /1,000/);
});

test('run markers are not actions and do not create an unscoped task', () => {
  const dir = workspace();
  startRun(dir, {});
  allowed(dir, 'read_file', 'task-a');
  endRun(dir);

  const report = buildReport(dir);
  assert.equal(report.totals.actions, 1);
  assert.deepEqual(report.tasks.map((task) => task.task), ['task-a']);
  assert.equal(report.tasks[0].actions, 1);
});

test('the streaming report matches the array report', async () => {
  const dir = workspace();
  allowed(dir, 'read_file', 'task-a');
  allowed(dir, 'read_file', 'task-b');
  append(dir, { action: 'web.read', subject: 'web_search', task: 'task-a', capability: 'read', trust: 'untrusted' });
  append(dir, { action: 'mail.send', subject: 'partner@example.com', task: 'task-a', capability: 'send' });
  append(dir, { action: 'llm.session', subject: 'deepseek', task: 'task-a', meta: { tokens: 1000, cost_usd: 0.01 } });

  assert.deepEqual(await buildReportStream(dir), buildReport(dir));
});

test('the report reads measured usage rows as well as legacy totals', () => {
  const dir = workspace();
  appendUsage(dir, { task: 'task-a', inputTokens: 600, outputTokens: 600, costUsd: 0.02 });
  const report = buildReport(dir);
  const a = report.tasks.find((task) => task.task === 'task-a');
  assert.equal(a.actions, 0);
  assert.equal(a.tokens, 1200);
  assert.equal(a.cost_usd, 0.02);
  assert.equal(a.api_calls, 1);
  assert.equal(a.invalid, 0);
});

test('the report counts an invalid usage row instead of crashing', () => {
  const dir = workspace();
  append(dir, {
    action: 'llm.session',
    subject: 'model',
    task: 'task-a',
    capability: 'model',
    meta: { usage: { input_tokens: -1 } },
  });
  const report = buildReport(dir);
  assert.equal(report.totals.invalid, 1);
  assert.match(renderReport(report), /1 invalid usage/);
});

test('a task named __all__ is a task, not an accumulator', () => {
  const dir = workspace();
  append(dir, { action: 'tool.call', subject: 'one', task: '__all__', capability: 'read', trust: 'internal' });
  const report = buildReport(dir);
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].task, '__all__');
  assert.equal(report.totals.actions, 1);
});

test('the report is reachable from the command line', () => {
  const dir = workspace();
  allowed(dir, 'read_file', 'task-a');
  append(dir, { action: 'llm.session', subject: 'deepseek', task: 'task-a', meta: { tokens: 2500, cost_usd: 0.002 } });
  const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));
  const output = execFileSync('node', [bin, '--dir', dir, 'report'], { encoding: 'utf8' });
  assert.match(output, /1 actions, 0 refused/);
  assert.match(output, /2,500/);
});
