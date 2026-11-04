import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import test from 'node:test';
import { watchEntries } from '../src/watch.mjs';
import { append, paths } from '../src/store.mjs';
import { initWorkspace } from './helpers.mjs';

const collect = async (dir, options) => {
  const controller = new AbortController();
  const seen = [];
  const task = (async () => {
    for await (const entry of watchEntries(dir, { ...options, signal: controller.signal })) {
      seen.push(entry);
      if (seen.length >= (options.limit ?? 1)) controller.abort();
    }
  })();
  await task;
  return seen;
};

test('watch reads existing entries once and stops cleanly', async () => {
  const dir = initWorkspace('attesso-watch');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-1' });
  append(dir, { action: 'shell.execute', subject: 'terminal', capability: 'execute', task: 'task-1' });
  const seen = await collect(dir, { fromSeq: 0, interval: 10, limit: 2 });
  assert.deepEqual(seen.map((entry) => entry.seq), [1, 2]);
  assert.equal(seen[0].task, 'task-1');
});

test('watch emits an entry appended after it starts', async () => {
  const dir = initWorkspace('attesso-watch');
  const controller = new AbortController();
  const seen = [];
  const task = (async () => {
    for await (const entry of watchEntries(dir, { fromSeq: 0, interval: 10, signal: controller.signal })) {
      seen.push(entry.seq);
      controller.abort();
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-1' });
  await task;
  assert.deepEqual(seen, [1]);
});

test('watch filters by task without moving the offset', async () => {
  const dir = initWorkspace('attesso-watch');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-a' });
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-b' });
  const seen = await collect(dir, { fromSeq: 0, task: 'task-b', interval: 10 });
  assert.deepEqual(seen.map((entry) => entry.task), ['task-b']);
});

test('watch holds a partial line until its newline arrives', async () => {
  const dir = initWorkspace('attesso-watch');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-1' });
  const file = paths(dir).ledger;
  appendFileSync(file, '{"v":1,"seq":2');
  const controller = new AbortController();
  const seen = [];
  const task = (async () => {
    for await (const entry of watchEntries(dir, { fromSeq: 0, interval: 10, signal: controller.signal })) {
      seen.push(entry.seq);
      if (seen.length === 2) controller.abort();
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  appendFileSync(file, ',"action":"tool.call","task":"task-1"}\n');
  await task;
  assert.deepEqual(seen, [1, 2]);
});

test('watch refuses a malformed complete line', async () => {
  const dir = initWorkspace('attesso-watch');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-1' });
  appendFileSync(paths(dir).ledger, '{bad}\n');
  await assert.rejects(collect(dir, { fromSeq: 0, interval: 10 }), /ledger line 2 is not JSON/);
});
