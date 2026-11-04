import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, init } from '../src/store.mjs';
import { Catalog } from '../src/ui/catalog.mjs';
import { normalizeUsage, usageForDay } from '../src/usage.mjs';
import { tempDir } from './helpers.mjs';

const fixture = () => {
  const root = tempDir('attesso-usage');
  const dir = join(root, 'ledger');
  mkdirSync(dir, { recursive: true });
  init(dir);
  append(dir, { action: 'tool.call', subject: 'read_file', task: 'task-a', trust: 'internal', capability: 'read' }, { now: new Date('2026-11-02T10:00:00Z') });
  append(dir, { action: 'tool.call', subject: 'write_file', task: 'task-a', trust: 'internal', capability: 'write' }, { now: new Date('2026-11-02T10:01:00Z') });
  append(dir, { action: 'llm.session', subject: 'deepseek', task: 'task-a', meta: { tokens: 1000, cached_tokens: 200, cost_usd: 0.01, api_calls: 4 } }, { now: new Date('2026-11-02T10:02:00Z') });
  return dir;
};

test('usage is task-level and does not invent a per-call number', () => {
  const catalog = new Catalog(fixture());
  const usage = usageForDay(catalog, { day: '2026-11-02', timeZone: 'UTC' });
  const task = usage.tasks.find((item) => item.task === 'task-a');
  assert.equal(task.calls, 2);
  assert.equal(task.tokens, 1000);
  assert.equal(task.cached_tokens, 200);
  assert.equal(task.cost_usd, 0.01);
  assert.equal(task.api_calls, 4);
  assert.equal(usage.totals.measured_calls, 2);
  assert.equal(usage.coverage, 1);
});

test('a per-call usage record is attached to its sequence', () => {
  const usage = normalizeUsage({
    action: 'tool.call', seq: 7, task: 'task-b',
    meta: { usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 } },
  });
  assert.equal(usage.seq, 7);
  assert.equal(usage.tokens, 15);
  assert.equal(usage.source, 'call');
});

test('no usage is not zero, and invalid usage is named', () => {
  const catalog = new Catalog(fixture());
  const usage = usageForDay(catalog, { day: '2026-11-01', timeZone: 'UTC' });
  assert.equal(usage.totals.calls, 0);
  assert.equal(usage.totals.tokens, 0);
  assert.equal(usage.invalid, 0);
  assert.throws(() => normalizeUsage({ action: 'llm.session', task: 'x', meta: { tokens: -1 } }), /non-negative/);
});
