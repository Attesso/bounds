import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { append, init, paths, readState } from '../src/store.mjs';
import { evaluatePath, validateRules } from '../src/rules.mjs';
import { explain, suggest, writeAgentContext } from '../src/setup.mjs';
import { wireHermes } from '../src/install.mjs';

const workspace = (rules) => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-veto-'));
  init(dir);
  if (rules) writeFileSync(paths(dir).rules, JSON.stringify(rules));
  return dir;
};

const call = (dir, toolInput, tool = 'terminal') =>
  append(dir, {
    action: tool === 'terminal' ? 'shell.execute' : 'file.write',
    subject: tool,
    task: 'task-1',
    capability: 'execute',
    trust: 'internal',
    args_hash: createHash('sha256').update(JSON.stringify(toolInput)).digest('base64url').slice(0, 16),
  });

test('a same-arguments rule refuses the repeat and allows a different command', () => {
  const dir = workspace({
    version: 1,
    rules: [
      {
        id: 'no-repeat-terminal',
        deny: { capabilities: ['execute'] },
        if_path: { capability: 'execute', subject: 'terminal', same_arguments: true, within_minutes: 30 },
      },
    ],
  });
  assert.equal(call(dir, { command: 'ls /tmp' }).decision, 'ALLOW');
  const repeat = call(dir, { command: 'ls /tmp' });
  assert.equal(repeat.decision, 'DENY');
  assert.equal(repeat.rule, 'no-repeat-terminal');
  assert.equal(call(dir, { command: 'echo hi' }).decision, 'ALLOW');
});

test('suggest proposes a rule only for genuinely identical calls', () => {
  const dir = workspace();
  call(dir, { command: 'ls /tmp' });
  call(dir, { command: 'ls /tmp' });
  call(dir, { command: 'ls /tmp' });
  call(dir, { command: 'echo hi' });
  const proposal = suggest(dir, readState(dir));
  assert.equal(proposal.repeats.length, 1);
  assert.equal(proposal.repeats[0].count, 3);
  assert.equal(proposal.repeats[0].rule.if_path.same_arguments, true);
  assert.equal(proposal.repeats[0].rule.if_path.subject, 'terminal');
});

test('suggest ignores calls it cannot fingerprint', () => {
  const dir = workspace();
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  assert.equal(suggest(dir, readState(dir)).repeats.length, 0);
});

test('explain names the step that tainted the task', () => {
  const dir = workspace();
  append(dir, { action: 'web.read', subject: 'web_extract', task: 'task-1', capability: 'read', trust: 'untrusted' });
  const denied = append(dir, { action: 'mail.send', subject: 'partner@example.com', task: 'task-1', capability: 'send' });
  const detail = explain(dir, denied.seq, readState(dir));
  assert.equal(detail.found, true);
  assert.equal(detail.code, 'PATH_DENIED');
  assert.equal(detail.tainted_by.seq, 1);
  assert.match(detail.advice, /read web_extract at step #1/);
});

test('setup writes the agent block once and leaves the config alone on a dry run', () => {
  const home = mkdtempSync(join(tmpdir(), 'attesso-home-'));
  const config = join(home, 'config.yaml');
  writeFileSync(config, 'approvals:\n  mode: "off"\n');
  const result = wireHermes('/usr/local/bin/attesso', '.attesso', { dryRun: true, path: config });
  assert.equal(result.applied, false);
  assert.equal(readFileSync(config, 'utf8'), 'approvals:\n  mode: "off"\n');
  assert.match(result.snippet, /attesso.*hook --observe/);

  const applied = wireHermes('/usr/local/bin/attesso', '.attesso', { path: config });
  assert.equal(applied.applied, true);
  assert.match(readFileSync(config, 'utf8'), /pre_tool_call/);
  assert.equal(wireHermes('/usr/local/bin/attesso', '.attesso', { path: config }).reason, 'already wired');

  const cwd = mkdtempSync(join(tmpdir(), 'attesso-cwd-'));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    writeAgentContext(cwd);
    const first = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.match(first, /<!-- attesso:start -->/);
    writeAgentContext(cwd);
    const second = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.equal(second, first);
    assert.equal(existsSync(join(cwd, 'AGENTS.md')), true);
  } finally {
    process.chdir(previous);
  }
});

test('a repeat ceiling cannot fire without a fingerprint', () => {
  const counting = validateRules({
    version: 1,
    rules: [{ id: 'repeat-2', max_repeats: 2, deny: { capabilities: ['execute'] } }],
  });
  const verdict = evaluatePath(
    counting,
    [
      { seq: 1, capability: 'execute' },
      { seq: 2, capability: 'execute' },
    ],
    { capability: 'execute' },
  );
  assert.equal(verdict, null);
});

test('a step ceiling stops the task before it runs away', () => {
  const dir = workspace({ version: 1, rules: [{ id: 'steps-2', max_steps: 2, deny: { all: true } }] });
  assert.equal(call(dir, { command: 'one' }).decision, 'ALLOW');
  assert.equal(call(dir, { command: 'two' }).decision, 'ALLOW');
  const third = call(dir, { command: 'three' });
  assert.equal(third.decision, 'DENY');
  assert.equal(third.code, 'STEP_LIMIT');
});

test('a repeat ceiling stops a loop at the third identical call', () => {
  const dir = workspace({ version: 1, rules: [{ id: 'no-loop-2', max_repeats: 2, deny: { capabilities: ['execute'] } }] });
  assert.equal(call(dir, { command: 'npm test' }).decision, 'ALLOW');
  assert.equal(call(dir, { command: 'npm test' }).decision, 'ALLOW');
  const third = call(dir, { command: 'npm test' });
  assert.equal(third.decision, 'DENY');
  assert.equal(third.code, 'REPEAT_LIMIT');
  assert.equal(third.rule, 'no-loop-2');
  assert.equal(call(dir, { command: 'npm run lint' }).decision, 'ALLOW');
});
