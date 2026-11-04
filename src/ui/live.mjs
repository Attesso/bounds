// Byte-offset tail for the signed ledger. The UI server needs new entries, not
// a full re-read: a hook is a separate process, so the file is the boundary.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export class LedgerTail {
  constructor(file, startOffset = 0) {
    this.file = file;
    this.fd = null;
    this.offset = startOffset;
    this.inode = null;
    this.partial = '';
  }

  open() {
    this.fd = openSync(this.file, 'r');
    const stat = fstatSync(this.fd);
    this.inode = stat.ino;
    this.offset = stat.size;
  }

  close() {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // Reads complete lines from the current offset. A partial final line is kept
  // until the writer finishes it, so a reader never sees half an entry.
  read(onLine) {
    if (this.fd === null) return;
    let stat;
    try {
      stat = fstatSync(this.fd);
    } catch {
      this.close();
      return;
    }
    if (stat.ino !== this.inode || stat.size < this.offset) {
      this.close();
      this.open();
      this.partial = '';
      return;
    }
    if (stat.size === this.offset) return;
    const size = stat.size - this.offset;
    const buffer = Buffer.alloc(size);
    const bytes = readSync(this.fd, buffer, 0, size, this.offset);
    this.offset += bytes;
    this.partial += buffer.subarray(0, bytes).toString('utf8');
    let newline;
    while ((newline = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      if (line !== '') onLine(line);
    }
  }
}
