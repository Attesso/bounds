import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { bundleFor, verifyBundle } from '../src/bundle.mjs';
import { packetFor, verifyPacket } from '../src/packet.mjs';
import { buildReport } from '../src/report.mjs';
import { append, readDetail } from '../src/store.mjs';
import { sync } from '../src/sync.mjs';
import { initWorkspace } from './helpers.mjs';

const FLAG = 'unique-command-xyz';

const fixture = (prefix = 'attesso-detail-privacy') => {
  const dir = initWorkspace(prefix);
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'task-1',
    capability: 'execute',
    detail_input: { command: `echo ${FLAG}` },
  });
  return { dir, entry };
};

test('the detail payload never enters sync, bundle, packet or report', async () => {
  const { dir, entry } = fixture();
  assert.match(readDetail(dir, entry.seq).summary, new RegExp(FLAG));

  assert.equal(JSON.stringify(buildReport(dir)).includes(FLAG), false);

  const bundle = bundleFor(dir, entry.seq);
  assert.equal(JSON.stringify(bundle).includes(FLAG), false);
  assert.equal(bundle.statement.detail_hash, entry.detail_hash);
  assert.equal(verifyBundle(bundle).ok, true);

  const packet = packetFor(dir, entry.seq);
  assert.equal(JSON.stringify(packet).includes(FLAG), false);
  assert.equal(verifyPacket(packet).ok, true);

  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(body);
      const parsed = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ accepted: parsed.entries.length, skipped: 0, metered: parsed.entries.length }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await sync({ dir, url: `http://127.0.0.1:${server.address().port}`, key: 'att_test_key' });
    assert.equal(result.accepted, 1);
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0]);
    assert.equal(JSON.stringify(body).includes(FLAG), false);
    assert.equal('detail_hash' in body.entries[0], false);
    assert.equal(body.entries[0].action, 'tool.call');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
