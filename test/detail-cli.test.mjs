import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, deleteDetail, paths, readDetail } from '../src/store.mjs';
import { initWorkspace, runCli } from './helpers.mjs';

const withDetail = (prefix = 'attesso-detail-cli') => {
  const dir = initWorkspace(prefix);
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'task-1',
    capability: 'execute',
    detail_input: { command: 'echo hi' },
  });
  return { dir, entry };
};

test('detail prints the verified preview and JSON', () => {
  const { dir, entry } = withDetail();
  const human = runCli(dir, 'detail', String(entry.seq));
  assert.equal(human.status, 0);
  assert.match(human.stdout, /echo hi/);
  assert.match(human.stdout, /local only; never synced/);

  const json = runCli(dir, 'detail', String(entry.seq), '--json');
  assert.equal(json.status, 0);
  const body = JSON.parse(json.stdout);
  assert.equal(body.state, 'verified');
  assert.equal(body.detail.summary, 'echo hi');
  assert.equal(body.entry.detail_hash, entry.detail_hash);
});

test('detail says when no preview was recorded', () => {
  const dir = initWorkspace('attesso-detail-cli-none');
  const entry = append(dir, { action: 'tool.call', subject: 'terminal', task: 'task-1', capability: 'execute' });
  const result = runCli(dir, 'detail', String(entry.seq));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no detail recorded/);
});

test('detail fails clearly for a missing or changed preview', () => {
  const { dir, entry } = withDetail('attesso-detail-cli-missing');
  deleteDetail(dir, entry.seq);
  const missing = runCli(dir, 'detail', String(entry.seq));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /is missing/);

  const changed = withDetail('attesso-detail-cli-changed');
  const detail = readDetail(changed.dir, changed.entry.seq);
  writeFileSync(
    join(paths(changed.dir).details, `${changed.entry.seq}.json`),
    JSON.stringify({ ...detail, summary: 'tampered' }, null, 2),
  );
  const result = runCli(changed.dir, 'detail', String(changed.entry.seq));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not verify/);
});

test('detail --delete removes the preview and leaves the ledger valid', () => {
  const { dir, entry } = withDetail('attesso-detail-cli-delete');
  const deleted = runCli(dir, 'detail', String(entry.seq), '--delete');
  assert.equal(deleted.status, 0);
  assert.equal(readDetail(dir, entry.seq), null);
  const missing = runCli(dir, 'detail', String(entry.seq));
  assert.equal(missing.status, 2);
  const verify = runCli(dir, 'verify');
  assert.equal(verify.status, 0);
});

test('verify --details reports checked, missing and changed previews', () => {
  const ok = withDetail('attesso-detail-cli-verify-ok');
  const good = runCli(ok.dir, 'verify', '--details');
  assert.equal(good.status, 0);
  assert.match(good.stdout, /details: 1 checked, 0 missing, 0 changed/);

  const missing = withDetail('attesso-detail-cli-verify-missing');
  deleteDetail(missing.dir, missing.entry.seq);
  const missingResult = runCli(missing.dir, 'verify', '--details');
  assert.equal(missingResult.status, 0);
  assert.match(missingResult.stdout, /details: 1 checked, 1 missing, 0 changed/);

  const changed = withDetail('attesso-detail-cli-verify-changed');
  const detail = readDetail(changed.dir, changed.entry.seq);
  writeFileSync(
    join(paths(changed.dir).details, `${changed.entry.seq}.json`),
    JSON.stringify({ ...detail, summary: 'tampered' }, null, 2),
  );
  const changedResult = runCli(changed.dir, 'verify', '--details');
  assert.equal(changedResult.status, 2);
  assert.match(changedResult.stdout, /details: 1 checked, 0 missing, 1 changed/);
});
