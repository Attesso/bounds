import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { bin, initWorkspace, runCli, tempDir } from './helpers.mjs';

test('usage and malformed-input paths fail with the documented exit codes', () => {
  const dir = initWorkspace('attesso-cli-errors');

  assert.equal(runCli(dir, 'prove').status, 1);
  assert.equal(runCli(dir, 'verify-receipt').status, 2);
  assert.equal(runCli(dir, 'verify-bundle').status, 2);
  assert.equal(runCli(dir, 'export').status, 1);
  assert.equal(runCli(dir, 'log').status, 2);
  assert.equal(runCli(dir, 'log', '--action', 'tool.call', '--amount', '1').status, 2);
  assert.equal(runCli(dir, 'log', '--action', 'tool.call', '--amount', '1', '--currency', 'XYZ').status, 1);
  assert.equal(runCli(dir, 'log', '--action', 'tool.call', '--meta', 'broken').status, 2);
  assert.equal(runCli(dir, 'log', '--action', 'tool.call', '--trust', 'nope').status, 2);
  assert.equal(runCli(dir, 'log', '--action', 'tool.call', '--capability', 'nope').status, 2);
  assert.equal(runCli(dir, 'log', '--action', 'tool.call', '--json').status, 0);
  assert.equal(runCli(dir, 'tools').status, 2);
  assert.equal(runCli(dir, 'tools', 'verify').status, 2);
  assert.equal(runCli(tempDir('attesso-cli-errors'), 'init', '--profile', 'nope').status, 1);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{');
  assert.equal(runCli(dir, 'verify', '--pin', bad).status, 2);
  assert.equal(runCli(dir, 'replay', '--rules', bad).status, 2);
  assert.equal(runCli(dir, 'verify-receipt', bad).status, 2);
  assert.equal(runCli(dir, 'verify-bundle', bad).status, 2);
  assert.equal(runCli(dir, 'tools', 'pin', '--manifest', bad).status, 2);

  const invalidManifest = join(dir, 'invalid-manifest.json');
  writeFileSync(invalidManifest, '{}');
  assert.equal(runCli(dir, 'tools', 'pin', '--manifest', invalidManifest).status, 1);

  const malformedHook = spawnSync('node', [bin, '--dir', dir, 'hook'], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(malformedHook.status, 2);

  assert.equal(runCli(dir, 'unknown').status, 2);
  assert.equal(runCli(dir, '--help').status, 0);
  assert.equal(runCli(dir).status, 0);
  assert.equal(runCli(tempDir('attesso-cli-errors'), 'setup', '--dry-run').status, 0);
});

test('show, report and explain handle an empty ledger', () => {
  const dir = initWorkspace('attesso-empty');
  const show = runCli(dir, 'show');
  assert.equal(show.status, 0);
  assert.match(show.stdout, /no decisions yet/);

  const report = runCli(dir, 'report');
  assert.equal(report.status, 0);
  assert.match(report.stdout, /0 entries/);

  assert.equal(runCli(dir, 'explain', '1').status, 1);
});
