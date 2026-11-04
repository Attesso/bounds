// Hosted sync: upload the next bounded window of local decisions to Attesso.
// The local ledger stays authoritative; this only mirrors summary rows and
// advances a durable cursor after the server confirms the batch.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entryHash } from './ledger.mjs';
import { forEachEntrySync } from './stream.mjs';
import { paths, readKey } from './store.mjs';

export const SYNC_VERSION = 1;
export const DEFAULT_LIMIT = 50;

export function syncPath(dir) {
  return join(dir, 'sync.json');
}

export function readSyncState(dir) {
  const file = syncPath(dir);
  if (!existsSync(file)) return { version: SYNC_VERSION, last_seq: 0 };
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.version !== SYNC_VERSION || !Number.isSafeInteger(value.last_seq) || value.last_seq < 0) {
    throw new Error('sync state is invalid');
  }
  return value;
}

function writeSyncState(dir, lastSeq, deviceId) {
  const file = syncPath(dir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: SYNC_VERSION, device_id: deviceId, last_seq: lastSeq }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function endpoint(base) {
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('sync url must use HTTPS, except on localhost');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path.endsWith('/v1/bounds/sync') ? path : `${path}/v1/bounds/sync`;
  return parsed.toString();
}

export async function sync({
  dir,
  url,
  key,
  limit = DEFAULT_LIMIT,
  dryRun = false,
  fetchImpl = fetch,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  const ledgerPath = paths(dir).ledger;
  if (!existsSync(ledgerPath)) throw new Error('no ledger to sync');
  if (!url) throw new Error('sync url is required');
  if (!key && !dryRun) throw new Error('sync API key is required');
  const deviceId = readKey(dir).kid;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(deviceId)) {
    throw new Error('ledger key id is not a valid device id');
  }
  let state = readSyncState(dir);
  if (state.device_id && state.device_id !== deviceId) {
    state = { version: SYNC_VERSION, last_seq: 0 };
  }
  const entries = [];
  forEachEntrySync(ledgerPath, (entry) => {
    if (entry.seq <= state.last_seq) return;
    if (entries.length >= limit) return false;
    entries.push({
      seq: entry.seq,
      occurred_at: entry.at,
      action: entry.action,
      subject: entry.subject ?? null,
      capability: entry.capability ?? null,
      decision: entry.decision,
      code: entry.code,
      task: entry.task ?? null,
      entry_hash: entryHash(entry),
    });
  });
  if (entries.length === 0) {
    return { accepted: 0, skipped: 0, metered: 0, last_seq: state.last_seq, device_id: deviceId };
  }
  const body = { device_id: deviceId, entries };
  if (dryRun) {
    return { accepted: 0, skipped: 0, metered: 0, last_seq: state.last_seq, device_id: deviceId, dry_run: true, entries: entries.length };
  }
  const response = await fetchImpl(endpoint(url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`sync failed with status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`sync failed with status ${response.status}`);
  }
  const accepted = Number(payload.accepted);
  const skipped = Number(payload.skipped);
  const metered = Number(payload.metered);
  if (![accepted, skipped, metered].every(Number.isSafeInteger) || accepted < 0 || skipped < 0 || metered < 0) {
    throw new Error('sync response is invalid');
  }
  const lastSeq = entries[entries.length - 1].seq;
  writeSyncState(dir, lastSeq, deviceId);
  return { accepted, skipped, metered, last_seq: lastSeq, device_id: deviceId };
}


// watchSync keeps the hosted mirror current for a long-running agent session.
// It never advances the cursor on an error; the next tick retries the same
// window. Callers stop it with an AbortSignal.
export async function watchSync({
  dir,
  url,
  key,
  limit = DEFAULT_LIMIT,
  intervalMs = 5000,
  signal,
  onResult = () => {},
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300_000) {
    throw new Error('interval must be an integer from 1000 to 300000 milliseconds');
  }
  while (!signal?.aborted) {
    try {
      const result = await sync({ dir, url, key, limit });
      if (result.accepted || result.skipped || result.metered) onResult(result);
    } catch (error) {
      onResult(error);
    }
    if (signal?.aborted) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
