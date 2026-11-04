import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { entryHash, signEntry, verifyChain } from '../src/ledger.mjs';
import { policyDigest } from '../src/policy.mjs';
import { rulesDigest } from '../src/rules.mjs';
import { explain } from '../src/setup.mjs';
import { append, init, paths, readState } from '../src/store.mjs';

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-provenance-'));
  init(dir);
  return dir;
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const setPolicy = (dir, policy) => writeFileSync(paths(dir).policy, JSON.stringify(policy));

const tool = (dir, name, task = 'task-1') =>
  append(dir, { action: 'tool.call', subject: name, task, capability: 'read', trust: 'internal' });

test('an entry records the rules digest, and a rules edit changes it', () => {
  const dir = workspace();
  const first = tool(dir, 'read_file');
  assert.equal(first.rules_digest, rulesDigest(readJson(paths(dir).rules)));

  writeFileSync(
    paths(dir).rules,
    JSON.stringify({ version: 1, rules: [{ id: 'steps-9', max_steps: 9, deny: { all: true } }] }),
  );
  const second = tool(dir, 'read_file');
  assert.notEqual(second.rules_digest, first.rules_digest);

  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('a policy refusal names the field that refused it', () => {
  const cases = [
    {
      policy: { version: 1, action: 'purchase.execute', currency: 'EUR', max_amount: 1000 },
      proposal: { action: 'purchase.execute', amount: { minor: 2000, currency: 'EUR' } },
      code: 'ABOVE_MAXIMUM',
      rule: 'policy.max_amount',
    },
    {
      policy: { version: 1, action: 'purchase.execute', subjects: ['shop.example'] },
      proposal: { action: 'purchase.execute', subject: 'other.example' },
      code: 'VALUE_NOT_ALLOWED',
      rule: 'policy.subjects',
    },
    {
      policy: { version: 1, action: 'purchase.execute', currency: 'EUR', max_amount: 1000 },
      proposal: { action: 'purchase.execute', amount: { minor: 100, currency: 'USD' } },
      code: 'VALUE_MISMATCH',
      rule: 'policy.currency',
    },
    {
      policy: { version: 1, action: 'purchase.execute', on_or_after: '2030-01-01T00:00:00Z' },
      proposal: { action: 'purchase.execute' },
      code: 'OUTSIDE_DATE_RANGE',
      rule: 'policy.on_or_after',
    },
  ];

  for (const item of cases) {
    const dir = workspace();
    setPolicy(dir, item.policy);
    const entry = append(dir, item.proposal);
    assert.equal(entry.code, item.code);
    assert.equal(entry.rule, item.rule);
  }
});

test('engine facts live on the entry, and user meta stays user meta', () => {
  const dir = workspace();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'read_file',
    capability: 'read',
    trust: 'internal',
    meta: { tokens: 5, args_hash: 'fingerprint' },
  });
  assert.equal(entry.args_hash, 'fingerprint');
  assert.deepEqual(entry.meta, { tokens: 5 });
});

test('a path refusal records the rule and the tainting step on the entry', () => {
  const dir = workspace();
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'job-1' });
  const blocked = append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'job-1' });
  assert.equal(blocked.code, 'PATH_DENIED');
  assert.equal(blocked.rule, 'no-send-after-untrusted-read');
  assert.equal(blocked.tainted_by, 1);
  assert.equal(blocked.meta, undefined);
});

test('policy and rules snapshots are stored by their own digest', () => {
  const dir = workspace();
  tool(dir, 'read_file');
  const policy = readJson(paths(dir).policy);
  const rules = readJson(paths(dir).rules);
  const policyFile = join(paths(dir).policies, `${policyDigest(policy)}.json`);
  const rulesFile = join(paths(dir).policies, `${rulesDigest(rules)}.json`);
  assert.equal(existsSync(policyFile), true);
  assert.equal(existsSync(rulesFile), true);
  assert.equal(policyDigest(readJson(policyFile)), policyDigest(policy));
  assert.equal(rulesDigest(readJson(rulesFile)), rulesDigest(rules));
});

test('explain still reads entries that kept the rule in meta', () => {
  const dir = workspace();
  const detail = explain(dir, 1, {
    entries: [{ seq: 1, action: 'mail.send', decision: 'DENY', code: 'PATH_DENIED', meta: { rule: 'old-rule', tainted_by: 3 } }],
  });
  assert.equal(detail.rule, 'old-rule');
  assert.equal(detail.tainted_by, null);
  assert.match(detail.advice, /old-rule/);
});

test('a policy refusal explains the field, not a taint that never happened', () => {
  const dir = workspace();
  setPolicy(dir, { version: 1, action: 'tool.call', subjects: ['read_file'] });
  append(dir, { action: 'tool.call', subject: 'terminal' });
  const detail = explain(dir, 1, readState(dir));
  assert.equal(detail.rule, 'policy.subjects');
  assert.match(detail.advice, /policy\.subjects/);
  assert.doesNotMatch(detail.advice, /undefined|step #/);
});

test('an entry without the new fields still verifies', () => {
  const dir = workspace();
  tool(dir, 'read_file');
  const state = readState(dir);
  const entry = { ...state.entries[0] };
  delete entry.rules_digest;
  entry.sig = signEntry(entry, state.key.private);
  const result = verifyChain([entry], state.key.public, { count: 1, hash: entryHash(entry) });
  assert.equal(result.ok, true);
});
