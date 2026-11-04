import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { bundleFor, verifyBundle } from '../src/bundle.mjs';
import { entryHash, signEntry } from '../src/ledger.mjs';
import { append, init, paths, readState } from '../src/store.mjs';
import { initWorkspace, runCli, tempDir } from './helpers.mjs';

test('a bundle carries the policy, the history and a verdict that replays', () => {
  const dir = initWorkspace('attesso-bundle');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'job-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'job-1' });
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'job-2' });

  const bundle = bundleFor(dir, 2);
  assert.equal(bundle.history.length, 1);
  assert.equal(bundle.statement.code, 'PATH_DENIED');

  const result = verifyBundle(bundle, { replay: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.replayed.rule, 'no-send-after-untrusted-read');
  assert.match(result.reason, /replays/);
});

test('a swapped policy, a swapped history entry and a missing rule are refused', () => {
  const dir = initWorkspace('attesso-bundle');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'job-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'job-1' });
  const bundle = bundleFor(dir, 2);

  const policySwap = structuredClone(bundle);
  policySwap.policy.subjects = ['evil.example'];
  assert.match(verifyBundle(policySwap, { replay: true }).reason, /policy_digest/);

  const historySwap = structuredClone(bundle);
  historySwap.history[0].subject = 'elsewhere';
  assert.match(verifyBundle(historySwap, { replay: true }).reason, /history entry/);

  const noRules = structuredClone(bundle);
  noRules.rules = null;
  assert.match(verifyBundle(noRules, { replay: true }).reason, /carries no rules/);
});

test('a missing snapshot names what was not archived', () => {
  const dir = initWorkspace('attesso-bundle');
  const entry = append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  rmSync(join(paths(dir).policies, `${entry.policy_digest}.json`));
  assert.throws(() => bundleFor(dir, 1), /SNAPSHOT_MISSING: policy/);
});

test('an entry from before the rules digest is reported historical', () => {
  const dir = initWorkspace('attesso-bundle');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read' });
  const state = readState(dir);
  const entry = { ...state.entries[0] };
  delete entry.rules_digest;
  entry.sig = signEntry(entry, state.key.private);
  writeFileSync(paths(dir).ledger, `${JSON.stringify(entry)}\n`);
  writeFileSync(paths(dir).config, JSON.stringify({ version: 1, head: { count: 1, hash: entryHash(entry) } }));

  const bundle = bundleFor(dir, 1);
  assert.equal(bundle.rules, null);
  const result = verifyBundle(bundle, { replay: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.historical, true);
});

test('history from another task is refused', () => {
  const dir = initWorkspace('attesso-bundle-task');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'task-1' });
  append(dir, { action: 'web.read', subject: 'other.example', capability: 'read', trust: 'untrusted', task: 'task-2' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-1' });

  const bundle = bundleFor(dir, 3);
  bundle.history = [readState(dir).entries[1]];
  const result = verifyBundle(bundle, { replay: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /another task/);
});

test('a bundle verifies and replays in an empty directory', () => {
  const dir = initWorkspace('attesso-bundle');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'job-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'job-1' });
  const bundleFile = join(dir, 'bundle.json');
  const exported = runCli(dir, 'export', '2', '--out', bundleFile);
  assert.equal(exported.status, 0, exported.stderr);

  const empty = tempDir('attesso-bundle-empty');
  writeFileSync(join(empty, 'bundle.json'), readFileSync(bundleFile));
  const verified = runCli(empty, 'verify-bundle', 'bundle.json', '--replay');
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /replays/);

  const bundle = JSON.parse(readFileSync(join(empty, 'bundle.json'), 'utf8'));
  bundle.policy.action = 'other.action';
  writeFileSync(join(empty, 'bundle.json'), JSON.stringify(bundle));
  assert.equal(runCli(empty, 'verify-bundle', 'bundle.json', '--replay').status, 1);
});
