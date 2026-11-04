// A live reader over the ledger. It keeps a byte offset and a partial-line
// buffer, so watching a large ledger does not reread it on every tick.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseLine } from './jsonl.mjs';
import { paths } from './store.mjs';

const CHUNK = 64 * 1024;

function readRange(file, start, end) {
  const handle = openSync(file, 'r');
  const buffer = Buffer.alloc(end - start);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const bytes = readSync(handle, buffer, offset, buffer.length - offset, start + offset);
      if (bytes === 0) break;
      offset += bytes;
    }
  } finally {
    closeSync(handle);
  }
  return buffer.subarray(0, offset);
}

const wait = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

export async function* watchEntries(
  dir,
  { fromSeq = Number.MAX_SAFE_INTEGER, task, interval = 250, signal } = {},
) {
  const file = paths(dir).ledger;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let offset = 0;
  let index = 0;

  const parse = () => {
    const entries = [];
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      index += 1;
      const entry = parseLine(line, index);
      if ((task === undefined || entry.task === task) && entry.seq > fromSeq) entries.push(entry);
    }
    return entries;
  };

  let size = statSync(file).size;
  while (offset < size) {
    const end = Math.min(offset + CHUNK, size);
    buffer += decoder.write(readRange(file, offset, end));
    offset = end;
    for (const entry of parse()) yield entry;
  }

  while (!signal?.aborted) {
    await wait(interval, signal);
    if (signal?.aborted) return;
    size = statSync(file).size;
    if (size < offset) throw new Error('the ledger shrank while watch was reading it');
    if (size === offset) continue;
    buffer += decoder.write(readRange(file, offset, size));
    offset = size;
    for (const entry of parse()) yield entry;
  }
}
