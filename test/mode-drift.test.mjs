import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { modeSources, setModeAll, status } from '../src/connect.mjs';
import { init } from '../src/store.mjs';

const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));

// A hook script that keeps its own mode file can drift from the ledger's. The
// dangerous direction is one way: the script says enforce while the product says
// observe, so the person who ran `attesso status` believes nothing is blocking
// when the gate is, or the reverse. Status must report both and name the file.
const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'attesso-mode-'));
  const home = join(root, 'home');
  const veto = join(home, '.hermes', 'attesso-veto');
  const ledger = join(root, 'ledger');
  mkdirSync(veto, { recursive: true });
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(
    join(home, '.hermes', 'config.yaml'),
    ['hooks:', '  pre_tool_call:', `    - command: ${join(veto, 'hook.sh')}`, '      timeout: 10', ''].join('\n'),
  );
  writeFileSync(join(veto, 'hook.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  init(ledger);
  return { root, home, veto, ledger };
};

test('status names the file it read and reports a drift against the hook script', () => {
  const { home, veto, ledger } = sandbox();
  setModeAll(ledger, 'observe', { home });
  writeFileSync(join(veto, 'mode'), 'enforce\n');

  const result = status({ dir: ledger, home });
  assert.equal(result.mode, 'observe');
  assert.equal(result.mode_source, join(ledger, 'mode'));
  assert.equal(result.mode_drift, true);
  assert.deepEqual(result.mode_conflicts, [{ path: join(veto, 'mode'), mode: 'enforce' }]);
});

test('no drift is reported when both files agree', () => {
  const { home, ledger } = sandbox();
  setModeAll(ledger, 'enforce', { home });
  const result = status({ dir: ledger, home });
  assert.equal(result.mode, 'enforce');
  assert.equal(result.mode_drift, false);
  assert.deepEqual(result.mode_conflicts, []);
});

test('attesso mode writes both files, so the CLI can end a drift it did not create', () => {
  const { home, veto, ledger } = sandbox();
  setModeAll(ledger, 'observe', { home });
  writeFileSync(join(veto, 'mode'), 'enforce\n');
  assert.equal(modeSources(ledger, { home }).drift, true);

  setModeAll(ledger, 'enforce', { home });
  const after = modeSources(ledger, { home });
  assert.equal(after.drift, false);
  assert.equal(after.legacy[0].mode, 'enforce');
});

test('the status command warns on stderr-free stdout, naming the conflicting file', () => {
  const { home, veto, ledger } = sandbox();
  setModeAll(ledger, 'observe', { home });
  writeFileSync(join(veto, 'mode'), 'enforce\n');

  const run = spawnSync('node', [bin, '--dir', ledger, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /mode: observe/);
  assert.match(run.stdout, new RegExp(`mode source: .*ledger/mode`));
  assert.match(run.stdout, new RegExp(`warning: .*attesso-veto/mode says enforce`));
  assert.match(run.stdout, /run `attesso mode observe` to align both/);
});
