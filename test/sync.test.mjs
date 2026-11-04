import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { append, init } from '../src/store.mjs';
import { readSyncState, sync, watchSync } from '../src/sync.mjs';
import { tempDir } from './helpers.mjs';

const fixture = () => {
  const root = tempDir('attesso-sync');
  init(root);
  append(root, { action: 'tool.call', subject: 'read_file', task: 't1', trust: 'internal', capability: 'read' });
  append(root, { action: 'tool.call', subject: 'write_file', task: 't1', trust: 'internal', capability: 'write' });
  return root;
};

const server = async (handler) => {
  const requests = [];
  const instance = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, auth: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      handler(body, response);
    });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${instance.address().port}`,
    requests,
    close: () => new Promise((resolve) => instance.close(resolve)),
  };
};

test('sync uploads the next window and advances the cursor only after success', async () => {
  const root = fixture();
  const http = await server((body, response) => {
    const payload = JSON.parse(body);
    response.end(JSON.stringify({ accepted: payload.entries.length, skipped: 0, metered: payload.entries.length }));
  });
  try {
    const first = await sync({ dir: root, url: http.url, key: 'att_test_key', limit: 1 });
    assert.equal(first.accepted, 1);
    assert.equal(first.last_seq, 1);
    assert.equal(http.requests[0].auth, 'Bearer att_test_key');
    assert.equal(http.requests[0].url, '/v1/bounds/sync');
    assert.equal(readSyncState(root).last_seq, 1);

    const second = await sync({ dir: root, url: http.url, key: 'att_test_key', limit: 1 });
    assert.equal(second.last_seq, 2);
    assert.equal(JSON.parse(http.requests[1].body).entries[0].seq, 2);

    const third = await sync({ dir: root, url: http.url, key: 'att_test_key' });
    assert.equal(third.accepted, 0);
    assert.equal(http.requests.length, 2);
  } finally {
    await http.close();
  }
});

test('a failed sync leaves the cursor in place', async () => {
  const root = fixture();
  const http = await server((body, response) => {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: 'unavailable' }));
  });
  try {
    await assert.rejects(() => sync({ dir: root, url: http.url, key: 'att_test_key' }), /status 503/);
    assert.equal(readSyncState(root).last_seq, 0);
  } finally {
    await http.close();
  }
});

test('dry run reports the window without a request or cursor write', async () => {
  const root = fixture();
  const http = await server((body, response) => response.end(JSON.stringify({ accepted: 1, skipped: 0, metered: 0 })));
  try {
    const result = await sync({ dir: root, url: http.url, key: 'att_test_key', dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.entries, 2);
    assert.equal(http.requests.length, 0);
    assert.equal(readSyncState(root).last_seq, 0);
  } finally {
    await http.close();
  }
});

test('watch sync keeps retrying until the signal stops it', async () => {
  const root = fixture();
  const http = await server((body, response) => {
    const payload = JSON.parse(body);
    response.end(JSON.stringify({ accepted: payload.entries.length, skipped: 0, metered: 0 }));
  });
  try {
    const controller = new AbortController();
    const seen = [];
    const running = watchSync({
      dir: root,
      url: http.url,
      key: 'att_test_key',
      limit: 1,
      intervalMs: 1000,
      signal: controller.signal,
      onResult: (result) => {
        seen.push(result.last_seq);
        controller.abort();
      },
    });
    await running;
    assert.deepEqual(seen, [1]);
    assert.equal(readSyncState(root).last_seq, 1);
  } finally {
    await http.close();
  }
});
