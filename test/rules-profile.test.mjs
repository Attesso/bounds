import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { init, paths, readState, setRulesProfile } from '../src/store.mjs';
import { runCli, tempDir } from './helpers.mjs';
import { verifyChain } from '../src/ledger.mjs';

const strict = () => ({
  version: 1,
  rules: [
    {
      id: 'no-send-after-untrusted-read',
      deny: { capabilities: ['send', 'execute'] },
      if_path: { trust: 'untrusted', capability: 'read' },
    },
  ],
});

test('setRulesProfile replaces a stale profile and keeps a backup', () => {
  const dir = tempDir('attesso-profile');
  init(dir, { profile: 'strict' });
  const before = readFileSync(paths(dir).rules, 'utf8');

  const result = setRulesProfile(dir, 'balanced');

  const after = readFileSync(paths(dir).rules, 'utf8');
  const migrated = JSON.parse(after);
  assert.equal(migrated.rules[0].deny.capabilities.length, 1);
  assert.deepEqual(migrated.rules[0].deny.capabilities, ['send']);
  assert.equal(migrated.rules[0].if_path.within_minutes, 30);
  assert.equal(result.profile, 'balanced');
  assert.equal(readFileSync(`${paths(dir).rules}.bak`, 'utf8'), before);
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('setRulesProfile is idempotent and refuses an unknown profile without writing', () => {
  const dir = tempDir('attesso-profile');
  init(dir);
  const before = readFileSync(paths(dir).rules, 'utf8');
  const beforeStat = statSync(paths(dir).rules);
  assert.throws(() => setRulesProfile(dir, 'nope'), /unknown rule profile/);
  assert.equal(readFileSync(paths(dir).rules, 'utf8'), before);
  assert.equal(statSync(paths(dir).rules).ino, beforeStat.ino);
  assert.equal(existsSync(`${paths(dir).rules}.bak`), false);

  setRulesProfile(dir, 'balanced');
  const once = readFileSync(paths(dir).rules, 'utf8');
  setRulesProfile(dir, 'balanced');
  assert.equal(readFileSync(paths(dir).rules, 'utf8'), once);
});

test('the rules command reports the new profile through the CLI', () => {
  const dir = tempDir('attesso-profile');
  init(dir);
  const result = runCli(dir, 'rules', 'set-profile', 'balanced');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /balanced/);
  assert.match(result.stdout, /digest/);
});

test('an old ledger with a stale strict profile can be migrated without touching its chain', () => {
  const dir = tempDir('attesso-profile');
  init(dir);
  writeFileSync(paths(dir).rules, JSON.stringify(strict()));
  setRulesProfile(dir, 'balanced');
  const state = readState(dir);
  assert.equal(state.rules.rules[0].if_path.within_minutes, 30);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});
