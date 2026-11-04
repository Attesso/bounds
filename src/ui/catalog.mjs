// A disposable day/offset catalog over the signed ledger. The ledger remains
// the source of truth; this file only helps the local UI read bounded ranges.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isInitialised, paths, readConfig } from '../store.mjs';
import { forEachEntrySync } from '../stream.mjs';

const INDEX_VERSION = 1;
const CHECKPOINT_EVERY = 256;
const INDEX_FILE = 'ui-index.json';

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const statOf = (file) => {
  try {
    const stat = statSync(file);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime_ms: stat.mtimeMs };
  } catch {
    return null;
  }
};
const sameFile = (left, right) =>
  left && right && left.dev === right.dev && left.ino === right.ino && left.size === right.size;

export function validateTimeZone(value) {
  if (value === undefined || value === null || value === '') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    throw new Error(`unknown time zone: ${value}`);
  }
}

const partsAt = (ms, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const value = {};
  for (const part of parts) if (part.type !== 'literal') value[part.type] = Number(part.value);
  return value;
};

const offsetAt = (ms, timeZone) => {
  const p = partsAt(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
};

export function zonedMidnight(day, timeZone) {
  const [year, month, date] = day.split('-').map(Number);
  let guess = Date.UTC(year, month - 1, date);
  // Two passes settle a DST boundary where the offset changes at midnight.
  for (let pass = 0; pass < 2; pass += 1) {
    guess = Date.UTC(year, month - 1, date) - offsetAt(guess, timeZone);
  }
  return guess;
}

export function dayFor(iso, timeZone) {
  const p = partsAt(Date.parse(iso), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const nextDay = (day) => {
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, date + 1));
  return value.toISOString().slice(0, 10);
};

export function dayBounds(day, timeZone) {
  return { start: zonedMidnight(day, timeZone), end: zonedMidnight(nextDay(day), timeZone) };
}

function checkpointAt(ms) {
  return this.checkpoints.reduce((best, item) => (Date.parse(item.at) <= ms ? item : best), null);
}

function indexMatches(index, ledger, stat, head) {
  return index
    && index.version === INDEX_VERSION
    && index.ledger
    && sameFile(index.ledger, stat)
    && index.head === head
    && Array.isArray(index.checkpoints);
}

export class Catalog {
  constructor(dir, { write = true } = {}) {
    this.dir = dir;
    this.file = paths(dir).ledger;
    this.indexFile = paths(dir).uiIndex;
    this.write = write;
    this.checkpoints = [];
    this.head = 0;
    this.signature = null;
    this.ready = false;
    this.load();
  }

  load() {
    if (!isInitialised(this.dir)) return;
    const stat = statOf(this.file);
    if (!stat) return;
    let head;
    try { head = readConfig(this.dir).head.count; } catch { head = null; }
    if (head === null) return;
    const index = readJson(this.indexFile);
    if (indexMatches(index, this.file, stat, head)) {
      this.checkpoints = index.checkpoints;
      this.head = index.head;
      this.signature = stat;
      this.ready = true;
      return;
    }
    this.rebuild();
  }

  rebuild() {
    this.checkpoints = [];
    this.head = 0;
    let end = 0;
    try {
      forEachEntrySync(this.file, (entry, index, start, next) => {
        if (index === 1 || index % CHECKPOINT_EVERY === 0) {
          this.checkpoints.push({ seq: entry.seq, offset: start, at: entry.at });
        }
        this.head = entry.seq;
        end = next;
      });
    } catch {
      // A corrupted ledger is reported by the query, not hidden behind an index.
      this.ready = false;
      return;
    }
    const stat = statOf(this.file);
    if (stat) {
      this.signature = { ...stat, size: end || stat.size };
      this.ready = true;
      this.persist();
    }
  }

  persist() {
    if (!this.write || !this.ready) return;
    const value = {
      version: INDEX_VERSION,
      ledger: this.signature,
      head: this.head,
      checkpoints: this.checkpoints,
    };
    try {
      mkdirSync(dirname(this.indexFile), { recursive: true });
      const temp = `${this.indexFile}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      renameSync(temp, this.indexFile);
    } catch {
      // A read-only ledger still works; the index stays in memory.
    }
  }

  refresh() {
    if (!this.ready) {
      this.load();
      return;
    }
    const stat = statOf(this.file);
    if (!stat) {
      this.ready = false;
      return;
    }
    if (stat.size === this.signature.size && stat.ino === this.signature.ino) return;
    // A live append can be recorded without rescanning. Anything else is a
    // replacement or truncation and gets a full rebuild.
    if (stat.size > this.signature.size && stat.ino === this.signature.ino) {
      this.extendFrom(this.signature.size);
      return;
    }
    this.rebuild();
  }

  extendFrom(offset) {
    try {
      forEachEntrySync(this.file, (entry, index, start, next) => {
        if (index === 1 || (this.head + 1) % CHECKPOINT_EVERY === 0) {
          this.checkpoints.push({ seq: entry.seq, offset: start, at: entry.at });
        }
        this.head = entry.seq;
        this.signature.size = next;
      }, { startOffset: offset });
    } catch {
      this.ready = false;
    }
  }

  record(entry, start, end) {
    if (!this.ready) return;
    if ((this.head + 1) === entry.seq && (this.head % CHECKPOINT_EVERY === 0)) {
      this.checkpoints.push({ seq: entry.seq, offset: start, at: entry.at });
    }
    this.head = entry.seq;
    this.signature.size = end;
  }

  startFor(ms) {
    const checkpoint = checkpointAt.call(this, ms);
    return checkpoint ? checkpoint.offset : 0;
  }

  startForSeq(seq) {
    let start = 0;
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.seq <= seq) start = checkpoint.offset; else break;
    }
    return start;
  }

  scanDay(day, timeZone, onEntry) {
    if (!isInitialised(this.dir)) return;
    this.refresh();
    if (!this.ready) throw new Error('ledger is not readable');
    const { start, end } = dayBounds(day, timeZone);
    forEachEntrySync(this.file, (entry, index, startOffset, endOffset) => {
      const at = Date.parse(entry.at);
      if (at < start) return;
      if (at >= end) return false;
      if (dayFor(entry.at, timeZone) !== day) return;
      onEntry(entry, startOffset, endOffset);
      return undefined;
    }, { startOffset: this.startFor(start) });
  }

  scanAfter(seq, onEntry) {
    if (!isInitialised(this.dir)) return;
    this.refresh();
    if (!this.ready) throw new Error('ledger is not readable');
    let started = false;
    forEachEntrySync(this.file, (entry, index, startOffset, endOffset) => {
      if (!started && entry.seq <= seq) return;
      started = true;
      return onEntry(entry, startOffset, endOffset);
    }, { startOffset: this.startForSeq(seq) });
  }

  scanRecent(days, timeZone, onEntry) {
    if (!isInitialised(this.dir)) return;
    this.refresh();
    if (!this.ready) throw new Error('ledger is not readable');
    const now = Date.now();
    const start = now - days * 24 * 60 * 60 * 1000;
    forEachEntrySync(this.file, (entry, index, startOffset, endOffset) => {
      if (Date.parse(entry.at) < start) return;
      onEntry(entry, startOffset, endOffset);
      return undefined;
    }, { startOffset: this.startFor(start) });
  }
}

export { INDEX_FILE };
