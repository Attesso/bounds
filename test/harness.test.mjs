import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { bin, hookCall, initWorkspace } from './helpers.mjs';

test('a Cline refusal reads its nested payload and emits cancel', () => {
  const dir = initWorkspace('attesso-harness');
  const read = hookCall(dir, {
    hook_event_name: undefined,
    preToolUse: { tool: 'web_extract', parameters: { url: 'https://example.com' } },
    taskId: 'task-1',
  });
  assert.equal(read.status, 0);
  assert.equal(JSON.parse(read.stdout).cancel, false);

  const send = hookCall(dir, {
    hook_event_name: undefined,
    preToolUse: { tool: 'send_email', parameters: { to: 'partner@example.com' } },
    taskId: 'task-1',
  });
  assert.equal(send.status, 0);
  const body = JSON.parse(send.stdout);
  assert.equal(body.cancel, true);
  assert.match(body.errorMessage, /no-send-after-untrusted-read/);
});

test('a Claude Code refusal uses the native PreToolUse shape', () => {
  const dir = initWorkspace('attesso-harness');
  hookCall(dir, {
    hook_event_name: 'PreToolUse',
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com' },
  });

  const send = hookCall(dir, {
    hook_event_name: 'PreToolUse',
    tool_name: 'send_email',
    tool_input: { to: 'partner@example.com' },
  });
  assert.equal(send.status, 0);
  const body = JSON.parse(send.stdout);
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /no-send-after-untrusted-read/);
});

test('a Codex refusal uses the same native shape', () => {
  const dir = initWorkspace('attesso-harness');
  hookCall(dir, {
    hook_event_name: 'PreToolUse',
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com' },
  });

  const send = hookCall(dir, {
    hook_event_name: 'PreToolUse',
    tool_name: 'send_email',
    tool_input: { to: 'partner@example.com' },
  });
  const body = JSON.parse(send.stdout);
  assert.equal(send.status, 0);
  assert.equal(body.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
});

test('a Cursor refusal uses permission and both messages', () => {
  const dir = initWorkspace('attesso-harness');
  hookCall(dir, {
    hook_event_name: 'preToolUse',
    tool_name: 'Read',
    tool_input: { path: '/tmp/x' },
    session_id: 'cursor-1',
  });
  hookCall(dir, {
    hook_event_name: 'preToolUse',
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com' },
    session_id: 'cursor-1',
  });

  const send = hookCall(dir, {
    hook_event_name: 'preToolUse',
    tool_name: 'send_email',
    tool_input: { to: 'partner@example.com' },
    session_id: 'cursor-1',
  });
  const body = JSON.parse(send.stdout);
  assert.equal(send.status, 0);
  assert.equal(body.permission, 'deny');
  assert.match(body.user_message, /no-send-after-untrusted-read/);
  assert.match(body.agent_message, /no-send-after-untrusted-read/);
});

test('a Gemini refusal uses decision and reason', () => {
  const dir = initWorkspace('attesso-harness');
  hookCall(dir, {
    hook_event_name: 'BeforeTool',
    tool_name: 'web_fetch',
    tool_input: { url: 'https://example.com' },
  });

  const send = hookCall(dir, {
    hook_event_name: 'BeforeTool',
    tool_name: 'send_email',
    tool_input: { to: 'partner@example.com' },
  });
  const body = JSON.parse(send.stdout);
  assert.equal(send.status, 0);
  assert.equal(body.decision, 'deny');
  assert.match(body.reason, /no-send-after-untrusted-read/);
});

test('observe mode makes no decision in a native harness', () => {
  const dir = initWorkspace('attesso-harness');
  hookCall(dir, {
    hook_event_name: 'PreToolUse',
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com' },
  });

  const send = hookCall(
    dir,
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'send_email',
      tool_input: { to: 'partner@example.com' },
    },
    ['--observe'],
  );
  assert.equal(send.status, 0);
  assert.equal(send.stdout, '');
});

test('an unreadable ledger fails closed in enforce and stays out of the way in observe', () => {
  const dir = initWorkspace('attesso-harness');
  writeFileSync(join(dir, 'policy.json'), '{not json');

  const claude = hookCall(dir, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { path: '/tmp/x' },
  });
  assert.equal(claude.status, 0);
  assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecisionReason, /could not read the ledger/);

  const hermes = hookCall(dir, { tool_name: 'Read', tool_input: { path: '/tmp/x' } });
  assert.equal(hermes.status, 2);
  assert.equal(JSON.parse(hermes.stdout).decision, 'block');

  const observe = hookCall(
    dir,
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { path: '/tmp/x' } },
    ['--observe'],
  );
  assert.equal(observe.status, 0);
  assert.equal(observe.stdout, '');
});

test('a non-JSON hook input fails closed in enforce and stays out of the way in observe', () => {
  const dir = initWorkspace('attesso-harness');
  const enforced = spawnSync(process.execPath, [bin, '--dir', dir, 'hook'], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(enforced.status, 2);

  const observed = spawnSync(process.execPath, [bin, '--dir', dir, 'hook', '--observe'], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(observed.status, 0);
});

test('an unknown event gets the conservative union and exits 2', () => {
  const dir = initWorkspace('attesso-harness');
  hookCall(dir, { hook_event_name: 'UnknownEvent', tool_name: 'web_extract', tool_input: { url: 'https://example.com' } });
  const send = hookCall(dir, {
    hook_event_name: 'UnknownEvent',
    tool_name: 'send_email',
    tool_input: { to: 'partner@example.com' },
  });
  assert.equal(send.status, 2);
  const body = JSON.parse(send.stdout);
  assert.equal(body.decision, 'block');
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(body.permission, 'deny');
  assert.equal(body.cancel, true);
});

test('native tool names map to the same capabilities', async () => {
  const { classifyTool } = await import('../src/classify.mjs');
  assert.deepEqual(classifyTool('Bash'), { action: 'shell.execute', capability: 'execute', trust: 'internal' });
  assert.deepEqual(classifyTool('Read'), { action: 'tool.call', capability: 'read', trust: 'internal' });
  assert.deepEqual(classifyTool('WebFetch'), { action: 'web.read', capability: 'read', trust: 'untrusted' });
  assert.deepEqual(classifyTool('Write'), { action: 'file.write', capability: 'write', trust: 'internal' });
  assert.deepEqual(classifyTool('execute_command'), { action: 'shell.execute', capability: 'execute', trust: 'internal' });
  assert.deepEqual(classifyTool('write_to_file'), { action: 'file.write', capability: 'write', trust: 'internal' });
});


