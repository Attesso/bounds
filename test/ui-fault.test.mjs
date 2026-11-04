import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, init, paths } from '../src/store.mjs';
import { Catalog } from '../src/ui/catalog.mjs';
import { page, summary } from '../src/ui/query.mjs';
import { startUi } from '../src/ui/server.mjs';
import { tempDir } from './helpers.mjs';

const fixture = () => {
  const root = tempDir('attesso-fault');
  const dir = join(root, 'ledger');
  mkdirSync(dir, { recursive: true });
  init(dir);
  append(dir, { action: 'tool.call', subject: 'read_file', task: 'a', trust: 'internal', capability: 'read' }, { now: new Date('2026-11-02T10:00:00Z') });
  return dir;
};
const homeOf = () => tempDir('attesso-fault-home');

test('a read-only ledger still serves a bounded page', () => {
  const dir = fixture();
  const mode = readFileSync(paths(dir).ledger).length ? 0o444 : 0o600;
  chmodSync(paths(dir).ledger, mode);
  try {
    const catalog = new Catalog(dir, { write: false });
    assert.equal(summary(catalog, { day: '2026-11-02', timeZone: 'UTC' }).calls, 1);
    assert.equal(page(catalog, { day: '2026-11-02', timeZone: 'UTC', limit: 1 }).rows.length, 1);
  } finally {
    chmodSync(paths(dir).ledger, 0o600);
  }
});

test('a corrupt sidecar is ignored and the ledger remains authoritative', () => {
  const dir = fixture();
  const catalog = new Catalog(dir);
  assert.equal(catalog.head, 1);
  writeFileSync(join(dir, 'ui-index.json'), '{"version":1,"head":999}');
  const next = new Catalog(dir);
  assert.equal(next.head, 1);
  assert.equal(summary(next, { day: '2026-11-02', timeZone: 'UTC' }).calls, 1);
});

test('a malformed final line does not invent a call', () => {
  const dir = fixture();
  const file = paths(dir).ledger;
  writeFileSync(file, readFileSync(file, 'utf8') + '{"seq":2');
  const catalog = new Catalog(dir);
  assert.equal(summary(catalog, { day: '2026-11-02', timeZone: 'UTC' }).calls, 1);
});

test('concurrent v1 pages agree and the server can restart safely', async () => {
  const dir = fixture();
  const home = homeOf();
  const ui = await startUi({ dir, home, port: 0, open: false });
  try {
    const url = 'api/v1/calls?day=2026-11-02&tz=UTC&limit=1';
    const results = await Promise.all(Array.from({ length: 8 }, () => fetch(ui.url + url, { headers: { 'x-bounds-token': ui.token } }).then((response) => response.json())));
    assert.deepEqual(results.map((body) => body.rows[0][0]), Array(8).fill(1));
    await ui.close();
    const again = await startUi({ dir, home, port: 0, open: false });
    try {
      const response = await fetch(again.url + 'api/v1/calls?day=2026-11-02&tz=UTC&limit=1', { headers: { 'x-bounds-token': again.token } });
      assert.equal((await response.json()).rows[0][0], 1);
    } finally {
      await again.close();
    }
  } finally {
    await ui.close().catch(() => {});
  }
});
