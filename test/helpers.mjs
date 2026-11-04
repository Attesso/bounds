// Shared test fixtures: one binary path, one temp-dir initialiser, one CLI
// runner, one hook payload. Tests keep their own domain fixtures.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));

export const tempDir = (prefix) => mkdtempSync(join(tmpdir(), `${prefix}-`));

export const initWorkspace = (prefix) => {
  const dir = tempDir(prefix);
  spawnSync('node', [bin, '--dir', dir, 'init'], { encoding: 'utf8' });
  return dir;
};

export const runCli = (dir, ...args) =>
  spawnSync('node', [bin, '--dir', dir, ...args], { cwd: dir, encoding: 'utf8' });

export const hookCall = (dir, payload, extra = []) =>
  spawnSync('node', [bin, '--dir', dir, 'hook', ...extra], {
    input: JSON.stringify({ hook_event_name: 'pre_tool_call', session_id: 'session-1', ...payload }),
    encoding: 'utf8',
  });

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
