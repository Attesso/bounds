import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { replay, renderReplay } from '../src/replay.mjs';
import { validateRules } from '../src/rules.mjs';
import { append, init, paths, readState } from '../src/store.mjs';
import { initWorkspace, runCli } from './helpers.mjs';

const rulesOf = (dir) => validateRules(JSON.parse(readFileSync(paths(dir).rules, 'utf8')));

const windowRules = (minutes) =>
  validateRules({
    version: 1,
    rules: [
      {
        id: `no-send-after-untrusted-read-${minutes}`,
        deny: { capabilities: ['send', 'execute'] },
        if_path: { trust: 'untrusted', capability: 'read', within_minutes: minutes },
      },
    ],
  });

test('replay recomputes the verdict and names exactly what changed', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'task-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-2' });

  const candidate = { version: 1, action: 'mail.send' };
  const summary = replay(readState(dir).entries, { policy: candidate, rules: rulesOf(dir) });

  assert.equal(summary.total, 3);
  assert.equal(summary.newly_denied, 1);
  assert.equal(summary.newly_allowed, 0);
  assert.equal(summary.unenforceable, 0);
  assert.equal(summary.original_denials, 1);
  assert.equal(summary.candidate_denials, 2);
  assert.equal(summary.denial_rate, 2 / 3);
  assert.deepEqual(summary.changed.map((row) => row.seq), [1]);
  assert.equal(summary.changed[0].to.code, 'ACTION_MISMATCH');
  assert.match(renderReplay(summary), /1 newly denied/);
});

test('replay injects each entry time, so a window boundary reproduces', () => {
  const dir = initWorkspace('attesso-replay');
  const start = new Date('2026-01-01T10:00:00Z');
  const at = (minutes) => new Date(start.getTime() + minutes * 60_000);
  writeFileSync(paths(dir).rules, JSON.stringify(windowRules(30)));
  append(
    dir,
    { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'task-1' },
    { now: start },
  );
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-1' }, { now: at(29) });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-1' }, { now: at(31) });

  const entries = readState(dir).entries;
  const strict = replay(entries, { policy: { version: 1, action: '*' }, rules: windowRules(30) });
  const looser = replay(entries, { policy: { version: 1, action: '*' }, rules: windowRules(40) });

  assert.equal(strict.newly_denied, 0);
  assert.equal(looser.newly_denied, 1);
  assert.deepEqual(looser.changed.map((row) => row.seq), [3]);
});

test('a path rule cannot judge an entry that recorded no capability', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'tool.call', subject: 'mystery', trust: 'untrusted' });

  const summary = replay(readState(dir).entries, {
    policy: { version: 1, action: '*' },
    rules: windowRules(30),
  });

  assert.equal(summary.newly_allowed, 0);
  assert.equal(summary.unenforceable, 1);
  assert.deepEqual(summary.unenforceable_rows[0].reasons, ['NO_CAPABILITY']);
});

test('a same-arguments rule cannot judge an entry without a fingerprint', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'shell.execute', subject: 'terminal', capability: 'execute' });

  const summary = replay(readState(dir).entries, {
    policy: { version: 1, action: '*' },
    rules: validateRules({
      version: 1,
      rules: [
        { id: 'same-args', deny: { capabilities: ['execute'] }, if_path: { capability: 'execute', same_arguments: true } },
      ],
    }),
  });

  assert.equal(summary.unenforceable, 1);
  assert.deepEqual(summary.unenforceable_rows[0].reasons, ['NO_ARGUMENTS']);
});

test('a repeat ceiling cannot judge an entry without a fingerprint', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'shell.execute', subject: 'terminal', capability: 'execute' });
  append(dir, { action: 'shell.execute', subject: 'terminal', capability: 'execute' });

  const summary = replay(readState(dir).entries, {
    policy: { version: 1, action: '*' },
    rules: validateRules({
      version: 1,
      rules: [{ id: 'repeat-2', max_repeats: 2, deny: { capabilities: ['execute'] } }],
    }),
  });

  assert.equal(summary.unenforceable, 2);
  assert.deepEqual(summary.unenforceable_rows[0].reasons, ['NO_ARGUMENTS']);
});

test('a same-arguments rule does not judge an unrelated entry', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'web.read', subject: 'web_extract', capability: 'read', args_hash: 'fingerprint' });
  append(dir, { action: 'shell.execute', subject: 'terminal', capability: 'execute' });

  const summary = replay(readState(dir).entries, {
    policy: { version: 1, action: '*' },
    rules: validateRules({
      version: 1,
      rules: [
        {
          id: 'same-web',
          deny: { capabilities: ['read'] },
          if_path: { capability: 'read', subject: 'web_extract', same_arguments: true },
        },
      ],
    }),
  });

  assert.equal(summary.unenforceable, 0);
});

test('a legacy fingerprint in meta still replays a same-arguments rule', () => {
  const dir = initWorkspace('attesso-replay');
  const entry = append(dir, {
    action: 'web.read',
    subject: 'web_extract',
    capability: 'read',
    args_hash: 'fingerprint',
  });
  const legacy = { ...entry, meta: { ...(entry.meta ?? {}), args_hash: entry.args_hash } };
  delete legacy.args_hash;

  const summary = replay([legacy], {
    policy: { version: 1, action: '*' },
    rules: validateRules({
      version: 1,
      rules: [
        {
          id: 'same-web',
          deny: { capabilities: ['read'] },
          if_path: { capability: 'read', subject: 'web_extract', same_arguments: true },
        },
      ],
    }),
  });

  assert.equal(summary.unenforceable, 0);
});

test('two replays of the same ledger are identical', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'task-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-1' });
  const entries = readState(dir).entries;
  const run = () => replay(entries, { policy: { version: 1, action: 'mail.send' }, rules: rulesOf(dir) });
  assert.deepEqual(run(), run());
});

test('the command exits 1 only when the new-denial gate is exceeded', () => {
  const dir = initWorkspace('attesso-replay');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'task-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'task-1' });
  const candidate = join(dir, 'candidate.json');
  writeFileSync(candidate, JSON.stringify({ version: 1, action: 'mail.send' }));

  const run = (...extra) => runCli(dir, 'replay', '--policy', candidate, '--json', ...extra);

  const gated = run('--max-newly-denied', '0');
  assert.equal(gated.status, 1, gated.stderr);
  assert.equal(JSON.parse(gated.stdout).newly_denied, 1);

  const allowed = run('--max-newly-denied', '5');
  assert.equal(allowed.status, 0, allowed.stderr);
});
