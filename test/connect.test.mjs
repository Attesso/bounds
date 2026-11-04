import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { bin, tempDir } from './helpers.mjs';

const sandbox = () => {
  const home = tempDir('attesso-connect-home');
  const cwd = tempDir('attesso-connect-cwd');
  const ledger = join(tempDir('attesso-connect-ledger'), 'ledger');
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(join(home, '.hermes', 'config.yaml'), 'model: test\napprovals:\n  mode: "off"\n');
  return { home, cwd, ledger };
};

const run = (sandbox, args, input) =>
  spawnSync(process.execPath, [bin, '--dir', sandbox.ledger, ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    input,
    encoding: 'utf8',
  });

const runDefaultDir = (sandbox, args) =>
  spawnSync(process.execPath, [bin, ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  });

const json = (result) => JSON.parse(result.stdout);
const count = (sandbox) => {
  const file = join(sandbox.ledger, 'ledger.jsonl');
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8').trim();
  return text === '' ? 0 : text.split('\n').length;
};

test('connect initializes, wires a detected harness, stores mode and writes AGENTS.md', () => {
  const s = sandbox();
  const result = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = json(result);
  assert.equal(body.initialized, true);
  assert.equal(body.connected, true);
  assert.equal(body.mode, 'observe');
  assert.deepEqual(body.wired, ['hermes']);
  assert.equal(readFileSync(join(s.ledger, 'mode'), 'utf8').trim(), 'observe');
  assert.equal(existsSync(join(s.cwd, 'AGENTS.md')), true);
  const config = readFileSync(join(s.home, '.hermes', 'config.yaml'), 'utf8');
  assert.match(config, /pre_tool_call:/);
  assert.match(config, /attesso\.mjs.* hook/);
  assert.doesNotMatch(config, /hook --observe/);
});

test('connect is idempotent and status reports the wired mode', () => {
  const s = sandbox();
  run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  const again = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  const second = json(again);
  assert.equal(second.harnesses[0].reason, 'already wired');
  const config = readFileSync(join(s.home, '.hermes', 'config.yaml'), 'utf8');
  assert.equal((config.match(/pre_tool_call:/g) ?? []).length, 1);
  const status = json(run(s, ['status', '--json']));
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'observe');
  assert.deepEqual(status.wired, ['hermes']);
});

test('connect without write is a plan and does not create a ledger or mode', () => {
  const s = sandbox();
  const result = run(s, ['connect', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = json(result);
  assert.equal(body.initialized, false);
  assert.equal(body.mode, null);
  assert.equal(existsSync(s.ledger), false);
  assert.equal(existsSync(join(s.cwd, 'AGENTS.md')), false);
  assert.deepEqual(body.next, ['run `attesso init` first']);
});

test('connect rejects an unknown mode before writing anything', () => {
  const s = sandbox();
  const result = run(s, ['connect', '--write', '--mode', 'loud', '--json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid mode/);
  assert.equal(existsSync(s.ledger), false);
});

test('connect reports a pre-existing hooks block as manual and does not overwrite it', () => {
  const s = sandbox();
  const config = 'hooks:\n  other_event: []\napprovals:\n  mode: "off"\n';
  writeFileSync(join(s.home, '.hermes', 'config.yaml'), config);
  const result = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  const body = json(result);
  assert.equal(result.status, 0);
  assert.equal(body.harnesses[0].reason, 'config already has a hooks: block, merge by hand');
  assert.match(body.manual.join(' '), /hermes/);
  assert.equal(readFileSync(join(s.home, '.hermes', 'config.yaml'), 'utf8'), config);
  assert.equal(readFileSync(join(s.ledger, 'mode'), 'utf8').trim(), 'observe');
});

test('connect reports malformed harness config without modifying it', () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.claude'), { recursive: true });
  const invalid = '{not json';
  writeFileSync(join(s.home, '.claude', 'settings.json'), invalid);
  const result = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  assert.equal(result.status, 0);
  const body = json(result);
  const claude = body.harnesses.find((harness) => harness.key === 'claude-code');
  assert.match(claude.error, /not valid JSON/);
  assert.equal(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8'), invalid);
});

test('mode controls whether the installed hook records, observes or enforces', () => {
  const s = sandbox();
  run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  const payload = JSON.stringify({
    hook_event_name: 'pre_tool_call',
    tool_name: 'web_extract',
    tool_input: { url: 'https://example.test' },
    session_id: 'task-mode',
  });
  assert.equal(run(s, ['mode', 'off', '--json']).status, 0);
  const before = count(s);
  const off = run(s, ['hook'], payload);
  assert.equal(off.status, 0);
  assert.equal(count(s), before);
  run(s, ['mode', 'observe', '--json']);
  const observe = run(s, ['hook'], payload);
  assert.equal(observe.status, 0);
  assert.equal(count(s), before + 1);
  run(s, ['mode', 'enforce', '--json']);
  const enforce = run(s, ['hook'], payload);
  assert.equal(enforce.status, 2);
  assert.match(enforce.stdout, /PATH_DENIED|block/);
});

test('status on a missing ledger is a valid uninitialized result', () => {
  const s = sandbox();
  const result = run(s, ['status', '--json']);
  assert.equal(result.status, 0);
  const body = json(result);
  assert.equal(body.initialized, false);
  assert.equal(body.connected, false);
  assert.equal(body.ledger, null);
  assert.deepEqual(body.next, ['run `attesso init` first']);
  assert.equal(new Set(body.next).size, body.next.length);
});

test('connect reports an unknown harness instead of guessing its config', () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.cursor'), { recursive: true });
  writeFileSync(join(s.home, '.cursor', 'hooks.json'), '{}');
  const result = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  assert.equal(result.status, 0);
  const body = json(result);
  const cursor = body.harnesses.find((harness) => harness.key === 'cursor');
  assert.equal(cursor.manual, true);
  assert.match(body.manual.join(' '), /cursor/);
  assert.equal(readFileSync(join(s.ledger, 'mode'), 'utf8').trim(), 'observe');
});

test('connect with no harness initializes and leaves the generic contract in next', () => {
  const s = sandbox();
  s.home = tempDir('attesso-connect-empty-home');
  const result = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  assert.equal(result.status, 0);
  const body = json(result);
  assert.equal(body.initialized, true);
  assert.equal(body.connected, false);
  assert.equal(body.harnesses.length, 0);
  assert.match(body.next.join(' '), /no agent harness detected/i);
  assert.match(body.next.join(' '), /generic hook contract/i);
});

test('an invalid mode file is refused by status and the hook', () => {
  const s = sandbox();
  mkdirSync(s.ledger, { recursive: true });
  writeFileSync(join(s.ledger, 'mode'), 'banana\n');
  const status = run(s, ['status', '--json']);
  assert.equal(status.status, 2);
  assert.match(status.stderr, /invalid mode/);
  const hook = run(s, ['hook'], JSON.stringify({ hook_event_name: 'pre_tool_call', tool_name: 'terminal', tool_input: {}, session_id: 't1' }));
  assert.equal(hook.status, 2);
  assert.match(hook.stderr, /invalid mode/);
});

test('a legacy attesso-veto hook wrapper gets the same mode', () => {
  const s = sandbox();
  const wrapper = join(s.home, '.hermes', 'attesso-veto', 'hook.sh');
  mkdirSync(join(s.home, '.hermes', 'attesso-veto'), { recursive: true });
  writeFileSync(wrapper, '#!/bin/sh\n');
  writeFileSync(join(s.home, '.hermes', 'config.yaml'), `hooks:\n  pre_tool_call:\n    - command: ${wrapper}\n      timeout: 10\napprovals:\n  mode: "off"\n`);
  const result = run(s, ['connect', '--write', '--mode', 'observe', '--json']);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(s.home, '.hermes', 'attesso-veto', 'mode'), 'utf8').trim(), 'observe');
  const status = json(run(s, ['status', '--json']));
  assert.equal(status.mode, 'observe');
  assert.equal(status.connected, true);
});

test('connect writes an absolute ledger path into a global harness config', () => {
  const s = sandbox();
  const result = runDefaultDir(s, ['connect', '--write', '--mode', 'observe', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(join(s.home, '.hermes', 'config.yaml'), 'utf8');
  const expected = `--dir '${join(realpathSync(s.cwd), '.attesso')}'`;
  assert.match(config, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(config, /--dir '\.attesso'/);
});

test('status does not claim a hook aimed at another ledger', () => {
  const s = sandbox();
  const other = join(tempDir('attesso-connect-other'), '.attesso');
  writeFileSync(
    join(s.home, '.hermes', 'config.yaml'),
    `hooks:\n  pre_tool_call:\n    - command: 'attesso --dir ${other} hook'\n      timeout: 10\napprovals:\n  mode: "off"\n`,
  );
  const result = run(s, ['status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = json(result);
  assert.deepEqual(body.wired, []);
  assert.equal(body.connected, false);
});
