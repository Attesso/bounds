// Query contracts over the catalog. The catalog owns byte ranges; this module
// owns the small JSON shapes the page consumes. Nothing here decides policy.
import { Catalog, dayFor, validateTimeZone } from './catalog.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^v1:(\d+):(.+)$/;
const isAction = (entry) => entry.action !== 'llm.session';
const matches = (row, filters) => {
  if (filters.minute !== undefined) {
    const [hour, minute] = row[1].split(':').map(Number);
    if (Math.floor((hour * 60 + minute) / 5) * 5 !== filters.minute) return false;
  }
  if (filters.hour !== undefined && row[1].slice(0, 2) !== String(filters.hour).padStart(2, '0')) return false;
  if (filters.tool && row[2] !== filters.tool) return false;
  if (filters.capability && row[3] !== filters.capability) return false;
  if (filters.decision && row[4] !== filters.decision) return false;
  if (filters.search && !row.join(' ').toLowerCase().includes(filters.search)) return false;
  return true;
};

const pad = (value) => String(value).padStart(2, '0');
const timeParts = (iso, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso));
  const result = {};
  for (const part of parts) if (part.type === 'hour' || part.type === 'minute') result[part.type] = Number(part.value);
  return result;
};

export function rowFor(entry, timeZone) {
  const time = timeParts(entry.at, timeZone);
  return [
    entry.seq,
    `${pad(time.hour)}:${pad(time.minute)}`,
    entry.subject ?? 'unknown',
    entry.capability ?? 'unknown',
    entry.decision ?? 'UNKNOWN',
    entry.code ?? '',
    entry.task ?? 'unknown',
  ];
}

export function parseDay(value, timeZone) {
  const day = value ?? dayFor(new Date().toISOString(), timeZone);
  if (!DAY.test(day)) throw new Error(`invalid day: ${day}`);
  // Reject impossible calendar dates such as 2026-02-31.
  const [year, month, date] = day.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error(`invalid day: ${day}`);
  }
  return day;
}

export function parseCursor(value, timeZone) {
  if (value === undefined || value === null || value === '') return { seq: 0, timeZone };
  const match = CURSOR.exec(String(value));
  if (!match) throw new Error('invalid cursor');
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid cursor');
  const cursorZone = validateTimeZone(match[2]);
  if (cursorZone !== timeZone) throw new Error('cursor belongs to another time zone');
  return { seq, timeZone };
}

export const makeCursor = (seq, timeZone) => `v1:${seq}:${timeZone}`;

export function parseLimit(value, { fallback = 100, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error(`limit must be an integer from 1 to ${max}`);
  }
  return number;
}

export function summary(catalog, { day, timeZone }) {
  let calls = 0;
  let blocked = 0;
  let first = null;
  let last = null;
  catalog.scanDay(day, timeZone, (entry) => {
    if (!isAction(entry)) return;
    calls += 1;
    if (entry.decision === 'DENY') blocked += 1;
    if (first === null) first = entry.seq;
    last = entry.seq;
  });
  return { day, calls, blocked, allowed: calls - blocked, first_seq: first, last_seq: last, head: catalog.head, generated_at: new Date().toISOString() };
}

export function flow(catalog, { day, timeZone, bucket = 5 }) {
  if (!Number.isInteger(bucket) || bucket < 1 || bucket > 60) throw new Error('bucket must be between 1 and 60 minutes');
  const buckets = new Map();
  catalog.scanDay(day, timeZone, (entry) => {
    if (!isAction(entry)) return;
    const time = timeParts(entry.at, timeZone);
    const minute = Math.floor((time.hour * 60 + time.minute) / bucket) * bucket;
    const capability = entry.capability ?? 'unknown';
    const key = `${minute}|${capability}`;
    const item = buckets.get(key) ?? { minute, capability, total: 0, allowed: 0, blocked: 0, tools: new Set(), tasks: new Set(), codes: new Set() };
    item.total += 1;
    item.tools.add(entry.subject ?? 'unknown');
    item.tasks.add(entry.task ?? 'unknown');
    if (entry.decision === 'DENY') item.codes.add(entry.code ?? 'policy');
    if (entry.decision === 'DENY') item.blocked += 1; else item.allowed += 1;
    buckets.set(key, item);
  });
  return {
    day,
    bucket,
    buckets: [...buckets.values()]
      .map((item) => ({ ...item, tools: [...item.tools].sort(), tasks: [...item.tasks].sort(), codes: [...item.codes].sort() }))
      .sort((left, right) => left.minute - right.minute || left.capability.localeCompare(right.capability)),
  };
}

export function days(catalog, { timeZone, limit = 14 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 90) throw new Error('limit must be between 1 and 90');
  const map = new Map();
  catalog.scanRecent(limit + 1, timeZone, (entry) => {
    if (!isAction(entry)) return;
    const day = dayFor(entry.at, timeZone);
    const item = map.get(day) ?? { day, calls: 0, blocked: 0 };
    item.calls += 1;
    if (entry.decision === 'DENY') item.blocked += 1;
    map.set(day, item);
  });
  return [...map.values()].sort((left, right) => left.day.localeCompare(right.day)).slice(-limit);
}

export function page(catalog, { day, timeZone, after = 0, limit = 100, filters = null }) {
  const rows = [];
  let hasMore = false;
  const collect = (entry) => {
    if (!isAction(entry)) return;
    if (entry.seq <= after) return;
    const row = rowFor(entry, timeZone);
    if (filters && !matches(row, filters)) return;
    if (rows.length >= limit) {
      hasMore = true;
      return false;
    }
    row[7] = dayFor(entry.at, timeZone);
    rows.push(row);
    return undefined;
  };
  if (day) {
    catalog.scanDay(day, timeZone, collect);
  } else {
    catalog.scanAfter(after, collect);
  }
  const last = rows.length ? rows[rows.length - 1][0] : after;
  return {
    rows,
    next_cursor: makeCursor(last, timeZone),
    has_more: hasMore,
    head: catalog.head,
  };
}

export { Catalog };
