import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, init } from '../src/store.mjs';
import { Catalog, dayBounds, dayFor, zonedMidnight } from '../src/ui/catalog.mjs';
import { flow, page, parseCursor, parseLimit, summary } from '../src/ui/query.mjs';
import { tempDir } from './helpers.mjs';

const fixture = () => {
  const root = tempDir('attesso-query');
  const dir = join(root, 'ledger');
  mkdirSync(dir, { recursive: true });
  init(dir);
  const add = (at, subject, decision = 'ALLOW', capability = 'read') =>
    append(dir, { action: 'tool.call', subject, task: 'task-a', trust: 'internal', capability }, { now: new Date(at) });
  add('2026-11-01T10:00:00.000Z', 'read_file');
  add('2026-11-01T10:04:00.000Z', 'write_file', 'DENY', 'write');
  add('2026-11-01T23:30:00.000Z', 'send_email', 'DENY', 'send');
  add('2026-11-02T00:05:00.000Z', 'read_file');
  add('2026-11-02T01:00:00.000Z', 'patch');
  return { dir, add };
};

test('the catalog maps days and pages without reading every row', () => {
  const { dir } = fixture();
  const catalog = new Catalog(dir);
  assert.equal(catalog.head, 5);
  assert.ok(catalog.checkpoints.length >= 1);

  const stats = summary(catalog, { day: '2026-11-01', timeZone: 'UTC' });
  assert.deepEqual([stats.calls, stats.blocked, stats.first_seq, stats.last_seq], [3, 0, 1, 3]);

  const buckets = flow(catalog, { day: '2026-11-01', timeZone: 'UTC', bucket: 5 });
  assert.equal(buckets.buckets.reduce((total, item) => total + item.total, 0), 3);
  assert.equal(buckets.buckets.filter((item) => item.minute === 600).reduce((total, item) => total + item.total, 0), 2);

  const first = page(catalog, { day: '2026-11-01', timeZone: 'UTC', limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.equal(first.has_more, true);
  const second = page(catalog, { day: '2026-11-01', timeZone: 'UTC', after: first.rows.at(-1)[0], limit: 2 });
  assert.equal(second.rows.length, 1);
  assert.equal(second.has_more, false);
});

test('a cursor is exclusive and scoped to its time zone', () => {
  const { dir } = fixture();
  const catalog = new Catalog(dir);
  const result = page(catalog, { timeZone: 'UTC', limit: 1 });
  assert.equal(result.rows[0][0], 1);
  assert.match(result.next_cursor, /^v1:1:UTC$/);
  assert.deepEqual(parseCursor('v1:3:UTC', 'UTC'), { seq: 3, timeZone: 'UTC' });
  assert.throws(() => parseCursor('v1:3:Europe/Amsterdam', 'UTC'), /another time zone/);
  assert.throws(() => parseCursor('2', 'UTC'), /invalid cursor/);
  assert.throws(() => parseLimit('0'), /limit/);
  assert.throws(() => parseLimit('201'), /limit/);
});

test('a corrupt index is rebuilt from the signed ledger', () => {
  const { dir } = fixture();
  const path = join(dir, 'ui-index.json');
  const first = new Catalog(dir);
  assert.equal(first.head, 5);
  writeFileSync(path, '{not json');
  const second = new Catalog(dir);
  assert.equal(second.head, 5);
  assert.equal(summary(second, { day: '2026-11-02', timeZone: 'UTC' }).calls, 2);
});

test('a stale index is not used after the ledger changes', () => {
  const { dir, add } = fixture();
  const catalog = new Catalog(dir);
  add('2026-11-02T02:00:00.000Z', 'read_file');
  catalog.refresh();
  assert.equal(catalog.head, 6);
  assert.equal(summary(catalog, { day: '2026-11-02', timeZone: 'UTC' }).calls, 3);
});

test('day boundaries respect a DST-changing zone', () => {
  assert.equal(dayFor('2026-03-29T00:30:00.000Z', 'Europe/Amsterdam'), '2026-03-29');
  assert.equal(dayFor('2026-03-29T22:30:00.000Z', 'Europe/Amsterdam'), '2026-03-30');
  const spring = dayBounds('2026-03-29', 'Europe/Amsterdam');
  assert.equal(spring.end - spring.start, 23 * 60 * 60 * 1000);
  const autumn = dayBounds('2026-10-25', 'Europe/Amsterdam');
  assert.equal(autumn.end - autumn.start, 25 * 60 * 60 * 1000);
  assert.equal(zonedMidnight('2026-03-29', 'Europe/Amsterdam'), Date.parse('2026-03-28T23:00:00.000Z'));
});

test('a missing ledger is an empty catalog, not a crash', () => {
  const dir = tempDir('attesso-query-empty');
  const catalog = new Catalog(dir);
  assert.equal(catalog.head, 0);
  assert.equal(summary(catalog, { day: '2026-11-01', timeZone: 'UTC' }).calls, 0);
});


test('a page can be filtered by tool, capability, decision, hour and search', () => {
  const { dir } = fixture();
  const catalog = new Catalog(dir);
  assert.equal(page(catalog, { day: '2026-11-01', timeZone: 'UTC', limit: 10, filters: { tool: 'read_file' } }).rows.length, 1);
  assert.equal(page(catalog, { day: '2026-11-01', timeZone: 'UTC', limit: 10, filters: { capability: 'write' } }).rows.length, 1);
  assert.equal(page(catalog, { day: '2026-11-01', timeZone: 'UTC', limit: 10, filters: { search: 'send_email' } }).rows.length, 1);
  assert.equal(page(catalog, { day: '2026-11-01', timeZone: 'UTC', limit: 10, filters: { hour: 23 } }).rows.length, 1);
  assert.equal(page(catalog, { day: '2026-11-01', timeZone: 'UTC', limit: 10, filters: { minute: 600 } }).rows.length, 2);
});
