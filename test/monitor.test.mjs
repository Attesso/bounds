import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import test from 'node:test';
import { append } from '../src/store.mjs';
import { initWorkspace } from './helpers.mjs';

const decisions = channel('bounds.decision');

test('a subscriber sees the verdict and its digests, never the payload or meta', () => {
  const dir = initWorkspace('attesso-monitor');
  const events = [];
  const listener = (event) => events.push(event);
  decisions.subscribe(listener);
  try {
    append(dir, {
      action: 'tool.call',
      subject: 'read_file',
      capability: 'read',
      task: 'task-1',
      args_hash: 'fingerprint',
      meta: { tokens: 5, note: 'private' },
    });
  } finally {
    decisions.unsubscribe(listener);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].decision, 'ALLOW');
  assert.equal(events[0].code, 'ALLOW');
  assert.equal(events[0].args_hash, 'fingerprint');
  assert.match(events[0].entry_hash, /^[A-Za-z0-9_-]+$/);
  assert.equal('subject' in events[0], false);
  assert.equal('task' in events[0], false);
  assert.equal('amount' in events[0], false);
  assert.equal('meta' in events[0], false);
  assert.equal('sig' in events[0], false);
  assert.equal('note' in events[0], false);

  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  assert.equal(events.length, 1);
});
