import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));

const run = (cwd, ...args) => {
  try {
    return { code: 0, output: execFileSync('node', [bin, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const workspace = () => mkdtempSync(join(tmpdir(), 'attesso-cli-'));

test('init, log, verify and show work end to end', () => {
  const dir = workspace();
  const init = run(dir, 'init');
  assert.equal(init.code, 0, init.output);
  assert.match(init.output, /created .attesso with key/);

  writeFileSync(
    join(dir, '.attesso/policy.json'),
    JSON.stringify({ version: 1, action: 'purchase.execute', currency: 'EUR', max_amount: 25000, subjects: ['shop.example'] }),
  );

  const allowed = run(dir, 'log', '--action', 'purchase.execute', '--amount', '12.50', '--currency', 'EUR', '--subject', 'shop.example');
  assert.equal(allowed.code, 0, allowed.output);
  assert.match(allowed.output, /#1 ALLOW purchase\.execute shop\.example 12\.50 EUR \(ALLOW\)/);

  const refused = run(dir, 'log', '--action', 'purchase.execute', '--amount', '300.00', '--currency', 'EUR', '--subject', 'shop.example');
  assert.equal(refused.code, 1);
  assert.match(refused.output, /#2 DENY .* \(ABOVE_MAXIMUM\)/);

  const verified = run(dir, 'verify');
  assert.equal(verified.code, 0, verified.output);
  assert.match(verified.output, /ledger verifies: chain of 2 entries verifies/);

  const shown = run(dir, 'show');
  assert.match(shown.output, /2 decisions: 1 allowed, 1 refused/);
  assert.match(shown.output, /1 {2}DENY ABOVE_MAXIMUM/);
});

test('an edited ledger fails verification from the command line', () => {
  const dir = workspace();
  run(dir, 'init');
  writeFileSync(
    join(dir, '.attesso/policy.json'),
    JSON.stringify({ version: 1, action: 'purchase.execute', currency: 'EUR', max_amount: 25000 }),
  );
  run(dir, 'log', '--action', 'purchase.execute', '--amount', '12.50', '--currency', 'EUR');

  const ledger = join(dir, '.attesso/ledger.jsonl');
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"minor":1250', '"minor":125'));

  const verified = run(dir, 'verify');
  assert.equal(verified.code, 1);
  assert.match(verified.output, /does not verify: entry 1 signature does not verify/);
});

test('log without a ledger explains what to run', () => {
  const result = run(workspace(), 'log', '--action', 'a', '--amount', '1', '--currency', 'EUR');
  assert.equal(result.code, 2);
  assert.match(result.output, /run attesso init first/);
});

test('an unsupported currency is refused with the reason', () => {
  const dir = workspace();
  run(dir, 'init');
  const result = run(dir, 'log', '--action', 'EXAMPLE.action', '--amount', '1', '--currency', 'XYZ');
  assert.equal(result.code, 1);
  assert.match(result.output, /unsupported currency XYZ/);
});

test('a non-money action logs its subject, meta and totals', () => {
  const dir = workspace();
  run(dir, 'init');
  writeFileSync(join(dir, '.attesso/policy.json'), JSON.stringify({ version: 1, action: 'tool.call', subjects: ['read_file'] }));

  const allowed = run(dir, 'log', '--action', 'tool.call', '--subject', 'read_file', '--meta', 'tokens=1200', '--meta', 'cost_usd=0.0004');
  assert.equal(allowed.code, 0, allowed.output);
  assert.match(allowed.output, /#1 ALLOW tool\.call read_file \(ALLOW\)/);

  const refused = run(dir, 'log', '--action', 'tool.call', '--subject', 'terminal');
  assert.equal(refused.code, 1);
  assert.match(refused.output, /\(VALUE_NOT_ALLOWED\)/);

  const shown = run(dir, 'show');
  assert.match(shown.output, /1,200 tokens, 0\.0004 USD/);
  assert.match(shown.output, /read_file/);
});

test('a send after an untrusted read is refused with the tainting step', () => {
  const dir = workspace();
  run(dir, 'init');
  writeFileSync(join(dir, '.attesso/policy.json'), JSON.stringify({ version: 1, action: '*' }));

  const read = run(dir, 'log', '--action', 'web.read', '--subject', 'docs.example', '--task', 'job-1', '--trust', 'untrusted', '--capability', 'read');
  assert.equal(read.code, 0, read.output);

  const send = run(dir, 'log', '--action', 'mail.send', '--subject', 'partner@example.com', '--task', 'job-1', '--capability', 'send');
  assert.equal(send.code, 1);
  assert.match(send.output, /\(PATH_DENIED by step #1 under no-send-after-untrusted-read\)/);

  const otherTask = run(dir, 'log', '--action', 'mail.send', '--subject', 'partner@example.com', '--task', 'job-2', '--capability', 'send');
  assert.equal(otherTask.code, 0, otherTask.output);
});

test('the documented read-then-send example refuses the send for its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-readme-'));
  const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));
  const run = (args) => spawnSync('node', [bin, '--dir', dir, ...args], { encoding: 'utf8' });
  assert.equal(run(['init']).status, 0);
  const read = run(['log', '--action', 'web.read', '--subject', 'docs.example', '--task', 'job-1', '--trust', 'untrusted', '--capability', 'read']);
  assert.equal(read.status, 0, read.stderr);
  const send = run(['log', '--action', 'mail.send', '--subject', 'partner@example.com', '--task', 'job-1', '--capability', 'send']);
  assert.equal(send.status, 1);
  assert.match(send.stdout, /PATH_DENIED by step #1 under no-send-after-untrusted-read/);
  assert.equal(run(['verify']).status, 0);
});
