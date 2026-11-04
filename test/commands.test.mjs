import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append } from '../src/store.mjs';
import { initWorkspace, runCli } from './helpers.mjs';

test('the documented command matrix runs end to end', () => {
  const dir = initWorkspace('attesso-commands');
  append(dir, { action: 'web.read', subject: 'docs.example', task: 'job-1', capability: 'read', trust: 'untrusted' });
  append(dir, { action: 'mail.send', subject: 'partner@example.com', task: 'job-1', capability: 'send' });

  const receipt = join(dir, 'receipt.json');
  assert.equal(runCli(dir, 'prove', '1', '--out', receipt).status, 0);
  assert.equal(runCli(dir, 'verify-receipt', receipt).status, 0);

  const checkpoint = join(dir, 'head.json');
  assert.equal(runCli(dir, 'checkpoint', '--out', checkpoint).status, 0);
  assert.equal(runCli(dir, 'verify', '--pin', checkpoint).status, 0);

  const bundle = join(dir, 'bundle.json');
  assert.equal(runCli(dir, 'export', '2', '--out', bundle).status, 0);
  const replayed = runCli(dir, 'verify-bundle', bundle, '--replay');
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.match(replayed.stdout, /replays to the recorded verdict/);

  assert.equal(runCli(dir, 'show').status, 0);
  assert.equal(runCli(dir, 'report', '--json').status, 0);
  assert.equal(runCli(dir, 'replay', '--json').status, 0);
  assert.equal(runCli(dir, 'explain', '2').status, 0);
  assert.equal(runCli(dir, 'suggest', '--json').status, 0);

  const manifest = join(dir, 'tools.manifest.json');
  writeFileSync(manifest, JSON.stringify({ tools: [{ name: 'web_extract', description: 'Fetch a page.' }] }));
  assert.equal(runCli(dir, 'tools', 'verify', '--manifest', manifest).status, 1);
  assert.equal(runCli(dir, 'tools', 'pin', '--manifest', manifest).status, 0);
  assert.equal(runCli(dir, 'tools', 'verify', '--manifest', manifest).status, 0);
});
