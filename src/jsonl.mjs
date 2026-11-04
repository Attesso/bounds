// One reading of a JSONL line, shared by the array reader and the stream.
export function parseLine(line, index) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`ledger line ${index} is not JSON; the file was edited or truncated mid-line`);
  }
}

export function parseTail(line, index) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
