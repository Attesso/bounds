import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readState } from '../src/store.mjs';

const bin = fileURLToPath(new URL('../bin/attesso.mjs', import.meta.url));

const session = (dir, extra = []) => {
  const child = spawn('node', [bin, '--dir', dir, 'serve', ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      replies.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  const ask = (request) =>
    new Promise((resolve) => {
      const at = replies.length;
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const poll = setInterval(() => {
        if (replies.length > at) {
          clearInterval(poll);
          resolve(replies[at]);
        }
      }, 5);
    });
  const end = () =>
    new Promise((resolve) => {
      child.on('exit', resolve);
      child.stdin.end();
    });
  return { ask, end };
};

const fresh = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-serve-'));
  run(dir);
  return dir;
};

test('serve answers each line and keeps the chain verifiable', async () => {
  const dir = fresh((path) => {
    execFileSync('node', [bin, '--dir', path, 'init']);
  });
  const daemon = session(dir);
  const read = await daemon.ask({ action: 'web.read', subject: 'docs.example', task: 'job-1', trust: 'untrusted', capability: 'read' });
  assert.equal(read.decision, 'ALLOW');
  const send = await daemon.ask({ action: 'mail.send', subject: 'partner@example.com', task: 'job-1', capability: 'send' });
  assert.equal(send.decision, 'DENY');
  assert.equal(send.code, 'PATH_DENIED');
  assert.equal(send.enforced, true);
  assert.match(send.reason, /no-send-after-untrusted-read \(tainted by step #1\)/);
  await daemon.end();
  const { entries } = readState(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].tainted_by, 1);
});

test('observe mode keeps the verdict and lets the caller proceed', async () => {
  const dir = fresh((path) => {
    execFileSync('node', [bin, '--dir', path, 'init']);
  });
  const daemon = session(dir, ['--observe']);
  await daemon.ask({ action: 'web.read', subject: 'docs.example', task: 'job-1', trust: 'untrusted', capability: 'read' });
  const send = await daemon.ask({ action: 'mail.send', subject: 'partner@example.com', task: 'job-1', capability: 'send' });
  assert.equal(send.decision, 'DENY');
  assert.equal(send.enforced, false);
  await daemon.end();
});

test('a request that is not JSON is answered, not fatal', async () => {
  const dir = fresh((path) => {
    execFileSync('node', [bin, '--dir', path, 'init']);
  });
  const child = spawn('node', [bin, '--dir', dir, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stdin.write('not json\n');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(out, /request is not JSON/);
  child.kill();
});
