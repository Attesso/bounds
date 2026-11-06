// The one place the engine's version is read. The CLI reports it on --version,
// and the store stamps it into the ledger config so a record can say which build
// judged it: an entry without that provenance is a decision with no tool behind
// it.
import { readFileSync } from 'node:fs';

export const ENGINE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
