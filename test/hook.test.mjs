import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classifyTool } from '../src/classify.mjs';
import { readState } from '../src/store.mjs';
import { hookCall, initWorkspace } from './helpers.mjs';

test('the hook allows a read and refuses the send that follows it', () => {
  const dir = initWorkspace('attesso-hook');
  const read = hookCall(dir, { tool_name: 'web_extract', tool_input: { url: 'https://example.com' } });
  assert.equal(read.status, 0);

  const send = hookCall(dir, { tool_name: 'send_email', tool_input: { to: 'partner@example.com' } });
  assert.equal(send.status, 2);
  const body = JSON.parse(send.stdout);
  assert.equal(body.decision, 'block');
  assert.equal(body.code, 'PATH_DENIED');
  assert.match(body.message, /no-send-after-untrusted-read/);

  const { entries } = readState(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].capability, 'send');
  assert.equal(entries[1].tainted_by, 1);
});

test('balanced allows a write after an untrusted read', () => {
  const dir = initWorkspace('attesso-hook');
  const read = hookCall(dir, { tool_name: 'web_extract', tool_input: { url: 'https://example.com' } });
  assert.equal(read.status, 0);
  const write = hookCall(dir, { tool_name: 'write_file', tool_input: { path: '/tmp/x' } });
  assert.equal(write.status, 0);
  const body = JSON.parse(write.stdout);
  assert.equal(body.decision, 'allow');
  const { entries } = readState(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].capability, 'write');
});

test('observe mode records the refusal and still exits 0', () => {
  const dir = initWorkspace('attesso-hook');
  hookCall(dir, { tool_name: 'web_search' });
  const write = hookCall(dir, { tool_name: 'send_email' }, ['--observe']);
  assert.equal(write.status, 0);
  assert.equal(JSON.parse(write.stdout).decision, 'allow');
  const { entries } = readState(dir);
  assert.equal(entries[1].decision, 'DENY');
});

test('a task boundary keeps the taint from crossing sessions', () => {
  const dir = initWorkspace('attesso-hook');
  hookCall(dir, { tool_name: 'web_extract' });
  const other = hookCall(dir, { tool_name: 'write_file', session_id: 'session-2' });
  assert.equal(other.status, 0);
});

test('a policy refusal names the field and no taint step', () => {
  const dir = initWorkspace('attesso-hook');
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ version: 1, action: 'shell.execute', subjects: ['bash'] }));
  const refused = hookCall(dir, { tool_name: 'terminal', tool_input: {} });
  assert.equal(refused.status, 2);
  const body = JSON.parse(refused.stdout);
  assert.equal(body.code, 'VALUE_NOT_ALLOWED');
  assert.match(body.message, /by policy\.subjects/);
  assert.doesNotMatch(body.message, /undefined/);
});

test('tool names map to one capability each', () => {
  assert.deepEqual(classifyTool('web_search'), { action: 'web.read', capability: 'read', trust: 'untrusted' });
  assert.deepEqual(classifyTool('terminal'), { action: 'shell.execute', capability: 'execute', trust: 'internal' });
  assert.deepEqual(classifyTool('write_file'), { action: 'file.write', capability: 'write', trust: 'internal' });
  assert.equal(classifyTool('send_email').capability, 'send');
  assert.equal(classifyTool('read_file').capability, 'read');
});
