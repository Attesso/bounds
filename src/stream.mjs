// Read a JSONL ledger one line at a time. The rules match readEntries: a
// complete malformed line is corruption, a malformed final fragment is a writer
// caught mid-line and is ignored, and a parseable fragment without a newline is
// still an entry.
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseLine, parseTail } from './jsonl.mjs';

// The async reader feeds report and verify; append needs the same byte-exact
// framing without turning every caller into an async function.
export function forEachEntrySync(file, onEntry, { startOffset = 0 } = {}) {
  const fd = openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.alloc(64 * 1024);
  let buffer = '';
  let index = 0;
  let offset = startOffset;
  let readOffset = startOffset;
  try {
    let bytes;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, readOffset)) > 0) {
      readOffset += bytes;
      buffer += decoder.write(chunk.subarray(0, bytes));
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const start = offset;
        offset += Buffer.byteLength(line, 'utf8') + 1;
        index += 1;
        const keep = onEntry(parseLine(line, index), index, start, offset);
        if (keep === false) return;
      }
    }
    buffer += decoder.end();
    if (buffer !== '') {
      const start = offset;
      offset += Buffer.byteLength(buffer, 'utf8');
      const entry = parseTail(buffer, index + 1);
      if (entry !== undefined) onEntry(entry, index + 1, start, offset);
    }
  } finally {
    closeSync(fd);
  }
}

export async function forEachEntry(file, onEntry) {
  const stream = createReadStream(file);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let index = 0;

  const handle = async (line, tail) => {
    index += 1;
    const entry = tail ? parseTail(line, index) : parseLine(line, index);
    if (entry === undefined) return;
    await onEntry(entry, index);
  };

  for await (const chunk of stream) {
    buffer += decoder.write(chunk);
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      await handle(line, false);
      at = buffer.indexOf('\n');
    }
  }
  buffer += decoder.end();
  if (buffer !== '') await handle(buffer, true);
}
