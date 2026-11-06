import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { hookCall, initWorkspace, runCli } from './helpers.mjs';
import { paths } from '../src/store.mjs';

// D7: a parse failure must name the file that failed. Blaming the ledger when
// policy.json is the broken file sends the operator to the wrong file.
test('a corrupt policy.json is named as the file that failed', () => {
  const dir = initWorkspace('attesso-named-file');
  writeFileSync(paths(dir).policy, '{ this is not json');
  const result = hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'echo hi' }, session_id: 's' });
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout);
  assert.match(body.message, /could not read policy\.json/);
  assert.doesNotMatch(body.message, /could not read the ledger/);
});

test('a corrupt rules.json is named too, not folded into the ledger', () => {
  const dir = initWorkspace('attesso-named-rules');
  writeFileSync(paths(dir).rules, '[ not json');
  const result = hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'echo hi' }, session_id: 's' });
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).message, /could not read rules\.json/);
});

// D8: the terminal must not be repaintable from a recorded string, and the
// record must still hold the bytes the agent sent.
test('control bytes are stripped when printing and kept in the record', () => {
  const dir = initWorkspace('attesso-print-safety');
  const subject = '\u001b[2J\u001b[31mREDACTED';
  const logged = runCli(dir, 'log', '--action', 'tool.call', '--subject', subject, '--capability', 'read');
  assert.equal(logged.status, 0);

  const shown = runCli(dir, 'show', '--limit', '5');
  assert.equal(shown.stdout.includes('\u001b'), false, 'show printed a raw escape byte');
  assert.match(shown.stdout, /REDACTED/);

  const row = runCli(dir, 'log', '--action', 'tool.call', '--subject', '\u001b]0;pwned\u0007x', '--capability', 'read');
  assert.equal(row.stdout.includes('\u001b'), false, 'log echoed a raw escape byte');

  const stored = readFileSync(paths(dir).ledger, 'utf8');
  assert.match(stored, /\\u001b/, 'the record lost the bytes the agent sent');
  assert.equal(runCli(dir, 'verify').status, 0);
});
