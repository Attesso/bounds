import assert from 'node:assert/strict';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { init, paths } from '../src/store.mjs';
import { Catalog } from '../src/ui/catalog.mjs';
import { page, summary } from '../src/ui/query.mjs';
import { tempDir } from './helpers.mjs';

test('a million-entry ledger stays bounded', { skip: process.env.ATTESSO_LARGE !== '1', timeout: 180_000 }, async () => {
  const dir = join(tempDir('attesso-large'), 'ledger');
  mkdirSync(dir, { recursive: true });
  init(dir);
  const file = paths(dir).ledger;
  const stream = createWriteStream(file);
  const base = Date.UTC(2026, 0, 1);
  const lines = [];
  for (let index = 1; index <= 1_000_000; index += 1) {
    const at = new Date(base + Math.floor((index - 1) / 10_000) * 86_400_000 + ((index - 1) % 10_000) * 1000).toISOString();
    lines.push(JSON.stringify({ seq: index, at, action: 'tool.call', subject: 'read_file', task: 'large', trust: 'internal', capability: 'read', decision: 'ALLOW', code: 'ALLOW' }));
    if (lines.length === 10_000) {
      if (!stream.write(`${lines.join('\n')}\n`)) await once(stream, 'drain');
      lines.length = 0;
    }
  }
  if (lines.length) stream.write(`${lines.join('\n')}\n`);
  stream.end();
  await once(stream, 'finish');
  writeFileSync(paths(dir).config, JSON.stringify({ version: 1, head: { count: 1_000_000, hash: 'large-fixture' } }));

  const started = Date.now();
  const catalog = new Catalog(dir);
  const built = Date.now();
  const stats = summary(catalog, { day: '2026-01-01', timeZone: 'UTC' });
  const result = page(catalog, { day: '2026-01-01', timeZone: 'UTC', limit: 100 });
  const finished = Date.now();
  assert.equal(catalog.head, 1_000_000);
  assert.equal(stats.calls, 10_000);
  assert.equal(result.rows.length, 100);
  assert.equal(result.has_more, true);
  console.log(`large fixture: build=${built - started}ms query=${finished - built}ms`);
});
