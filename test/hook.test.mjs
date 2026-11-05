import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classifyTool } from '../src/classify.mjs';
import { verifyChain } from '../src/ledger.mjs';
import { verifyDetail } from '../src/detail.mjs';
import { paths, readDetail, readState, appendUsage } from '../src/store.mjs';
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

test('observe mode blocks an enforced rule and signs the fact', () => {
  const dir = initWorkspace('attesso-hook');
  writeFileSync(paths(dir).rules, JSON.stringify({
    version: 1,
    rules: [{
      id: 'no-send-enforced',
      deny: { capabilities: ['send'] },
      if_path: { trust: 'untrusted', capability: 'read' },
      enforce: true,
    }],
  }));
  hookCall(dir, { tool_name: 'web_extract' });
  const send = hookCall(dir, { tool_name: 'send_email' }, ['--observe']);
  assert.equal(send.status, 2);
  const body = JSON.parse(send.stdout);
  assert.equal(body.decision, 'block');
  const state = readState(dir);
  assert.equal(state.entries[1].decision, 'DENY');
  assert.equal(state.entries[1].enforce, true);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('observe mode stops a run at its enforced budget', () => {
  const dir = initWorkspace('attesso-hook');
  writeFileSync(paths(dir).rules, JSON.stringify({
    version: 1,
    rules: [{
      id: 'run-budget',
      max_tokens: 1000,
      deny: { capabilities: ['execute'] },
      enforce: true,
    }],
  }));
  appendUsage(dir, { task: 'session-1', inputTokens: 600, outputTokens: 600 });
  const stop = hookCall(dir, { tool_name: 'terminal', tool_input: {} }, ['--observe']);
  assert.equal(stop.status, 2);
  const body = JSON.parse(stop.stdout);
  assert.equal(body.code, 'BUDGET_EXCEEDED');
  assert.match(body.message, /budget/);
  const state = readState(dir);
  assert.equal(state.entries[1].code, 'BUDGET_EXCEEDED');
  assert.equal(state.entries[1].enforce, true);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
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

test('the hook records a local detail for the tool input', () => {
  const dir = initWorkspace('attesso-hook-detail');
  const call = hookCall(dir, { tool_name: 'read_file', tool_input: { path: '/tmp/a.txt' } });
  assert.equal(call.status, 0);
  const entry = readState(dir).entries.at(-1);
  assert.match(entry.detail_hash, /^[a-f0-9]{64}$/);
  const detail = readDetail(dir, entry.seq);
  assert.equal(detail.summary, '/tmp/a.txt');
  assert.deepEqual(verifyDetail(entry, detail), { ok: true });
});
