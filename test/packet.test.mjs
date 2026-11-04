import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { packetFor, verifyPacket } from '../src/packet.mjs';
import { append } from '../src/store.mjs';
import { initWorkspace, runCli, tempDir } from './helpers.mjs';

test('a packet wraps a bundle and verifies in an empty directory', () => {
  const dir = initWorkspace('attesso-packet');
  append(dir, { action: 'web.read', subject: 'docs.example', capability: 'read', trust: 'untrusted', task: 'job-1' });
  append(dir, { action: 'mail.send', subject: 'partner', capability: 'send', task: 'job-1' });

  const packet = packetFor(dir, 2);
  assert.equal(packet.kind, 'attesso.bounds.packet.v1');
  assert.equal(packet.summary.task, 'job-1');
  assert.equal(packet.summary.decisions, 2);
  assert.equal(packet.summary.refused, 1);
  assert.deepEqual(packet.summary.codes, ['ALLOW', 'PATH_DENIED']);
  assert.equal(verifyPacket(packet).ok, true);
  assert.equal(verifyPacket(packet, { replay: true }).ok, true);

  const packetFile = join(tempDir('attesso-packet-file'), 'packet.json');
  const written = runCli(dir, 'packet', '2', '--out', packetFile);
  assert.equal(written.status, 0, written.stderr);
  const empty = tempDir('attesso-packet-empty');
  const checked = runCli(empty, 'verify-packet', packetFile, '--replay');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /packet verifies/);
});

test('a changed packet is refused by its digest and its bundle', () => {
  const dir = initWorkspace('attesso-packet-tamper');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'job-1' });
  const packet = packetFor(dir, 1);

  const titleChanged = structuredClone(packet);
  titleChanged.title = 'A different claim';
  assert.match(verifyPacket(titleChanged).reason, /digest/);

  const bundleChanged = structuredClone(packet);
  bundleChanged.bundles[0].statement.subject = 'other';
  assert.match(verifyPacket(bundleChanged).reason, /digest/);

  const digestChanged = structuredClone(packet);
  digestChanged.digest = '0'.repeat(64);
  assert.match(verifyPacket(digestChanged).reason, /digest/);
});

test('a packet with another task is refused and a foreign packet is not accepted', () => {
  const dir = initWorkspace('attesso-packet-task');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'task-1' });
  append(dir, { action: 'tool.call', subject: 'write_file', capability: 'write', task: 'task-2' });
  const first = packetFor(dir, 1);
  const secondBundle = packetFor(dir, 2).bundles[0];
  const mixed = { ...first, bundles: [first.bundles[0], secondBundle], digest: first.digest };
  assert.equal(verifyPacket(mixed).ok, false);
  assert.match(verifyPacket(mixed).reason, /digest|another task/);
});

test('a packet does not contain private key material', () => {
  const dir = initWorkspace('attesso-packet-secret');
  append(dir, { action: 'tool.call', subject: 'read_file', capability: 'read', task: 'job-1' });
  const text = JSON.stringify(packetFor(dir, 1));
  assert.doesNotMatch(text, /private/i);
  assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
});

test('verify-packet requires a file and fails closed on malformed JSON', () => {
  const dir = initWorkspace('attesso-packet-errors');
  const missing = runCli(dir, 'verify-packet');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /verify-packet <file>/);

  const bad = join(tempDir('attesso-packet-bad'), 'bad.json');
  writeFileSync(bad, '{not json');
  const malformed = runCli(dir, 'verify-packet', bad);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /verify-packet:/);

  rmSync(bad);
});
