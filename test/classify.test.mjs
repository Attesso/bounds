import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classifyTool, loadTools, validateTools } from '../src/classify.mjs';
import { hookCall, initWorkspace } from './helpers.mjs';

test('known tools keep their action, capability and trust', () => {
  assert.deepEqual(classifyTool('web_search'), { action: 'web.read', capability: 'read', trust: 'untrusted' });
  assert.deepEqual(classifyTool('terminal'), { action: 'shell.execute', capability: 'execute', trust: 'internal' });
  assert.deepEqual(classifyTool('write_file'), { action: 'file.write', capability: 'write', trust: 'internal' });
  assert.deepEqual(classifyTool('read_file'), { action: 'tool.call', capability: 'read', trust: 'internal' });
});

test('a tool nobody listed is untrusted, not internal', () => {
  assert.deepEqual(classifyTool('custom_fetch_url'), { action: 'web.read', capability: 'read', trust: 'untrusted' });
  assert.deepEqual(classifyTool('mcp__filesystem__read'), { action: 'web.read', capability: 'read', trust: 'untrusted' });
});

test('an unlisted send is still a send, and still untrusted', () => {
  assert.deepEqual(classifyTool('send_mail_custom'), {
    action: 'message.send',
    capability: 'send',
    trust: 'untrusted',
  });
});

test('init writes tools.json, and an allowlist entry flips one tool to internal', () => {
  const dir = initWorkspace('attesso-classify');
  const file = join(dir, 'tools.json');
  assert.equal(existsSync(file), true);
  assert.equal(loadTools(dir).version, 1);

  const tools = JSON.parse(readFileSync(file, 'utf8'));
  tools.trusted_read.push('custom_fetch_url');
  writeFileSync(file, JSON.stringify(tools));

  assert.deepEqual(classifyTool('custom_fetch_url', loadTools(dir)), {
    action: 'tool.call',
    capability: 'read',
    trust: 'internal',
  });
  assert.equal(classifyTool('custom_fetch_url').trust, 'untrusted');
});

test('an invalid tools.json names the field it cannot read', () => {
  assert.throws(() => validateTools({ version: 2 }), /version must be 1/);
  assert.throws(
    () => validateTools({ version: 1, trusted_read: [], execute: [], write: [], send: 'mail' }),
    /send must be a list/,
  );
});

test('the hook taints the task when an unknown tool reads', () => {
  const dir = initWorkspace('attesso-classify');
  const read = hookCall(dir, { tool_name: 'custom_fetch_url', tool_input: { url: 'https://example.com' } });
  assert.equal(read.status, 0, read.stderr);

  const write = hookCall(dir, { tool_name: 'send_email', tool_input: { to: 'partner@example.com' } });
  assert.equal(write.status, 2);
  const body = JSON.parse(write.stdout);
  assert.equal(body.code, 'PATH_DENIED');
  assert.match(body.message, /no-send-after-untrusted-read/);
});

test('the shipped tools file is the one the classifier reads', () => {
  const dir = initWorkspace('attesso-classify');
  const shipped = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'));
  assert.deepEqual(shipped, loadTools(dir));
});
