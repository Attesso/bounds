import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { canonical } from '../src/canonical.mjs';
import { captureDetail, detailHash, verifyDetail, DETAIL_VERSION, MAX_DETAIL_BYTES } from '../src/detail.mjs';
import { verifyChain } from '../src/ledger.mjs';
import { append, deleteDetail, init, paths, readDetail, readState, writeDetail } from '../src/store.mjs';
import { tempDir } from './helpers.mjs';

const AT = '2026-11-05T17:00:00.000Z';
const SECRET = ['sk-', '0'.repeat(40)].join('');
const BEARER = ['Bearer', 'a'.repeat(24)].join(' ');
const capture = (tool, input, action = 'tool.call') => captureDetail({ seq: 1, at: AT, action, tool, input });
const workspace = () => {
  const dir = tempDir('attesso-detail');
  init(dir);
  return dir;
};

test('captureDetail records a small, verified terminal preview', () => {
  const { detail, hash } = capture('terminal', { command: 'npm test', cwd: '/tmp' }, 'shell.execute');
  assert.equal(detail.version, DETAIL_VERSION);
  assert.equal(detail.seq, 1);
  assert.equal(detail.at, AT);
  assert.equal(detail.action, 'shell.execute');
  assert.equal(detail.tool, 'terminal');
  assert.equal(detail.summary, 'npm test');
  assert.deepEqual(detail.fields, { command: 'npm test', cwd: '/tmp' });
  assert.deepEqual(detail.redactions, []);
  assert.equal(detail.truncated.fields, false);
  assert.equal(detail.truncated.bytes, Buffer.byteLength(canonical(detail)));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(detailHash(detail), hash);
  assert.deepEqual(verifyDetail({ seq: 1, detail_hash: hash }, detail), { ok: true });
});

test('file tools capture paths and sizes, never contents', () => {
  const read = capture('Read', { file_path: '/tmp/a.txt', offset: 0, limit: 10 }, 'file.read').detail;
  assert.equal(read.tool, 'Read');
  assert.deepEqual(read.fields, { path: '/tmp/a.txt', offset: 0, limit: 10 });
  assert.equal(read.summary, '/tmp/a.txt');

  const write = capture('write_file', { path: '/tmp/out', content: `hello ${SECRET}` }, 'file.write').detail;
  assert.equal(write.fields.path, '/tmp/out');
  assert.equal(write.fields.bytes, Buffer.byteLength(`hello ${SECRET}`));
  assert.equal(JSON.stringify(write).includes(SECRET), false);
  assert.equal(write.fields.content, undefined);
});

test('a patch records counts, not the patch text', () => {
  const patch = '--- a/file\n+++ b/file\n+added\n-removed\n';
  const { detail } = capture('apply_patch', { path: '/tmp/file', patch }, 'file.write');
  assert.equal(detail.fields.added, 1);
  assert.equal(detail.fields.removed, 1);
  assert.equal(detail.fields.path, '/tmp/file');
  assert.equal(JSON.stringify(detail).includes('+added'), false);
  assert.equal(JSON.stringify(detail).includes('-removed'), false);
});

test('web, search and delegation capture only the safe field', () => {
  assert.equal(capture('web_search', { query: 'agent policy' }, 'web.read').detail.summary, 'agent policy');
  const extract = capture('web_extract', { urls: ['https://a.test', 'https://b.test'] }, 'web.read').detail;
  assert.equal(extract.fields.url, 'https://a.test');
  assert.equal(extract.fields.url_count, 2);
  assert.equal(capture('search_files', { pattern: 'foo', path: '/tmp' }, 'file.read').detail.summary, 'foo');
  const delegated = capture('delegate_task', { tasks: [{ goal: 'fix the test', context: 'secret context' }] }, 'agent.delegate').detail;
  assert.equal(delegated.fields.goal, 'fix the test');
  assert.equal(JSON.stringify(delegated).includes('secret context'), false);
});

test('a command array is joined and a message keeps only recipient and subject', () => {
  assert.equal(capture('terminal', { command: ['npm', 'test'] }).detail.summary, 'npm test');
  const sent = capture(
    'message.send',
    { to: 'partner@example.com', subject: 'hello', body: 'secret body' },
    'message.send',
  ).detail;
  assert.equal(sent.fields.to, 'partner@example.com');
  assert.equal(sent.fields.subject, 'hello');
  assert.equal(JSON.stringify(sent).includes('secret body'), false);
});

test('an unknown tool keeps key names and no values', () => {
  const { detail } = capture('mystery', { command: 'x', token: 'abc' });
  assert.deepEqual(detail.fields, { keys: 'command, token' });
  assert.equal(detail.summary, 'mystery (command, token)');
  assert.equal(JSON.stringify(detail).includes('abc'), false);
});

test('a secret is redacted in the field and in the summary', () => {
  const { detail } = capture(
    'terminal',
    { command: `curl -H "Authorization: ${BEARER}" https://api.test` },
    'shell.execute',
  );
  assert.equal(detail.fields.command.includes('a'.repeat(24)), false);
  assert.equal(detail.summary.includes('a'.repeat(24)), false);
  assert.ok(detail.redactions.some((redaction) => redaction.field === 'command'));
  assert.ok(detail.redactions.some((redaction) => redaction.field === 'summary'));
});

test('redaction happens before truncation, so a boundary secret cannot survive', () => {
  const command = `${'x'.repeat(1490)} ${SECRET} tail`;
  const { detail } = capture('terminal', { command }, 'shell.execute');
  assert.equal(detail.fields.command.includes(SECRET), false);
  assert.equal(detail.fields.command.length, 1500);
  assert.equal(detail.truncated.fields, true);
});

test('a huge field is capped and the detail fits the size budget', () => {
  const { detail, hash } = capture('terminal', { command: 'x'.repeat(10_000) }, 'shell.execute');
  assert.equal(detail.fields.command.length, 1500);
  assert.equal(detail.summary.length, 200);
  assert.equal(detail.truncated.fields, true);
  assert.ok(Buffer.byteLength(canonical(detail)) <= MAX_DETAIL_BYTES);
  assert.equal(detail.truncated.bytes, Buffer.byteLength(canonical(detail)));
  assert.deepEqual(verifyDetail({ seq: 1, detail_hash: hash }, detail), { ok: true });
});

test('invalid capture inputs are refused at the boundary', () => {
  assert.throws(() => captureDetail({ seq: 0, at: AT, action: 'a', tool: 't' }), /positive integer/);
  assert.throws(() => captureDetail({ seq: 1, at: '', action: 'a', tool: 't' }), /timestamp/);
  assert.throws(() => captureDetail({ seq: 1, at: AT, action: '', tool: 't' }), /action/);
  assert.throws(() => captureDetail({ seq: 1, at: AT, action: 'a', tool: 3 }), /tool/);
  assert.throws(() => captureDetail({ seq: 1, at: AT, action: 'a', tool: 't', input: [] }), /input must be an object/);
});

test('a detail with no tool becomes unknown and empty input is allowed', () => {
  const { detail } = capture(null, null);
  assert.equal(detail.tool, 'unknown');
  assert.equal(detail.summary, 'unknown');
  assert.deepEqual(detail.fields, {});
});

test('verifyDetail refuses a copied, edited or unsupported detail', () => {
  const { detail, hash } = capture('terminal', { command: 'npm test' });
  assert.match(verifyDetail({ seq: 2, detail_hash: hash }, detail).reason, /does not belong/);
  assert.match(verifyDetail({ seq: 1, detail_hash: hash }, { ...detail, summary: 'changed' }).reason, /hash does not match/);
  assert.match(verifyDetail({ seq: 1, detail_hash: hash }, { ...detail, version: 2 }).reason, /version/);
  assert.match(verifyDetail({ seq: 1, detail_hash: 'x' }, detail).reason, /no detail hash/);
});

test('the store writes, reads, protects and deletes a detail', () => {
  const dir = workspace();
  const { detail } = capture('terminal', { command: 'npm test' });
  const file = writeDetail(dir, 1, detail);
  assert.deepEqual(readDetail(dir, 1), detail);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(paths(dir).details).mode & 0o777, 0o700);
  deleteDetail(dir, 1);
  assert.equal(readDetail(dir, 1), null);
  deleteDetail(dir, 1);
});

test('the store refuses a mismatched sequence and a corrupt file', () => {
  const dir = workspace();
  const { detail } = capture('terminal', { command: 'npm test' });
  assert.throws(() => writeDetail(dir, 2, detail), /does not match/);
  writeDetail(dir, 1, detail);
  writeFileSync(join(paths(dir).details, '1.json'), '{bad');
  assert.throws(() => readDetail(dir, 1), /JSON/);
});

test('append writes a detail and binds its hash to the entry', () => {
  const dir = workspace();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'task-1',
    capability: 'execute',
    detail_input: { command: 'echo hi' },
  });
  assert.match(entry.detail_hash, /^[a-f0-9]{64}$/);
  const detail = readDetail(dir, entry.seq);
  assert.equal(detail.summary, 'echo hi');
  assert.deepEqual(verifyDetail(entry, detail), { ok: true });
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});

test('append without a detail input records no hash', () => {
  const dir = workspace();
  const entry = append(dir, { action: 'tool.call', subject: 'terminal', task: 'task-1', capability: 'execute' });
  assert.equal(entry.detail_hash, undefined);
  assert.equal(readDetail(dir, entry.seq), null);
});

test('a detail write failure still appends the decision', () => {
  const dir = workspace();
  writeFileSync(paths(dir).details, 'not a directory');
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'task-1',
    capability: 'execute',
    detail_input: { command: 'echo hi' },
  });
  assert.equal(entry.detail_hash, undefined);
  const state = readState(dir);
  assert.equal(verifyChain(state.entries, state.key.public, state.config.head).ok, true);
});
