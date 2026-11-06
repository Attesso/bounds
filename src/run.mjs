// A run is the unit a budget and a person care about: one task, from start to
// finish. The active run lives in a small state file so a per-call hook can tag
// a decision without scanning the log. The signed run.start and run.end entries
// are the record; the file is only the live pointer.
import { randomBytes } from 'node:crypto';
import { append, readActiveRun, readLastRun, writeActiveRun } from './store.mjs';

const MAX_TEXT = 200;
const OUTCOMES = new Set(['success', 'failed', 'abandoned', 'unknown']);

const textOf = (value, field) => {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${field} must be text`);
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > MAX_TEXT) throw new Error(`${field} must be at most ${MAX_TEXT} characters`);
  return text;
};

export function startRun(dir, { goal } = {}) {
  const active = readActiveRun(dir);
  if (active) throw new Error(`run ${active.id} is already active; end it first`);
  const text = textOf(goal, 'goal');
  const id = `run_${randomBytes(9).toString('base64url')}`;
  const entry = append(
    dir,
    { action: 'run.start', subject: 'run', run_id: id, meta: text ? { goal: text } : undefined },
    { verdict: { decision: 'ALLOW', code: 'ALLOW', rule: 'run.start' } },
  );
  const activeRun = { version: 1, id, started_at: entry.at, ...(text ? { goal: text } : {}) };
  writeActiveRun(dir, { version: 1, active: activeRun, last: readLastRun(dir) });
  return { ...activeRun, seq: entry.seq };
}

export function endRun(dir, { outcome = 'unknown', note } = {}) {
  const active = readActiveRun(dir);
  if (!active) throw new Error('no active run');
  if (!OUTCOMES.has(outcome)) throw new Error('outcome must be success, failed, abandoned or unknown');
  const text = textOf(note, 'note');
  const entry = append(
    dir,
    { action: 'run.end', subject: 'run', run_id: active.id, meta: { outcome, ...(text ? { note: text } : {}) } },
    { verdict: { decision: 'ALLOW', code: 'ALLOW', rule: 'run.end' } },
  );
  writeActiveRun(dir, {
    version: 1,
    active: null,
    last: { ...active, ended_at: entry.at, outcome, ...(text ? { note: text } : {}) },
  });
  return { id: active.id, outcome, note: text || undefined, seq: entry.seq };
}

// The last closed run, read from the record rather than a second state file.
export function lastRunFrom(entries) {
  let end = null;
  let start = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!end) {
      if (entry.action === 'run.end' && typeof entry.run_id === 'string' && entry.run_id !== '') end = entry;
      continue;
    }
    if (entry.action === 'run.start' && entry.run_id === end.run_id) {
      start = entry;
      break;
    }
  }
  if (!end) return null;
  return {
    id: end.run_id,
    started_at: start?.at ?? null,
    ended_at: end.at,
    goal: start?.meta?.goal ?? null,
    outcome: end.meta?.outcome ?? 'unknown',
    note: end.meta?.note ?? null,
  };
}
