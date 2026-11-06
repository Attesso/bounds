// One canonical form for anything that is hashed or signed. Key order must not
// depend on how a caller happened to build the object.
//
// It must also agree with what the ledger stores, byte for byte. The writer
// serialises an entry with JSON.stringify, so this has to follow the same rules:
// an `undefined` member is dropped, an `undefined` array slot becomes null, a
// NaN or infinite number becomes null, and an object with toJSON (a Date) is
// serialised through it. When the two disagreed, a signature covered bytes the
// file could not hold and the entry became unverifiable for good; that is the
// archived ledger of 4 November 2026. Anything JSON cannot represent at all (a
// BigInt, a function, a symbol, a cycle) throws here rather than being signed
// as something else.
export class UnserialisableValue extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnserialisableValue';
  }
}

function serialise(value, path, seen) {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (type === 'bigint') {
    throw new UnserialisableValue(`cannot sign a BigInt at ${path}; pass it as a string`);
  }

  if (typeof value.toJSON === 'function') return serialise(value.toJSON(), path, seen);

  if (seen.has(value)) {
    throw new UnserialisableValue(`cannot sign a circular structure at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // An index loop, not map: map preserves holes, and a hole would be written
      // as an empty slot - `[,1]` - which is not JSON at all.
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = serialise(value[index], `${path}[${index}]`, seen);
        items.push(item === undefined ? 'null' : item);
      }
      return `[${items.join(',')}]`;
    }
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const serialised = serialise(value[key], `${path}.${key}`, seen);
      if (serialised !== undefined) parts.push(`${JSON.stringify(key)}:${serialised}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonical(value) {
  return serialise(value, '$', new Set());
}
