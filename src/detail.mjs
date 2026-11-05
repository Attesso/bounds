// The detail is a small, local, redacted preview of what a tool was asked to
// do. It is not the payload: file contents, message bodies and patch text are
// never stored. The signed entry carries only the hash of this record, so a
// disclosed excerpt can be checked without shipping the payload.
import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';
import { redactFields, redactText } from './redact.mjs';

export const DETAIL_VERSION = 1;
export const MAX_DETAIL_BYTES = 4096;

const MAX_SUMMARY_CHARS = 200;
const MAX_UNKNOWN_KEYS = 20;
const DEFAULT_FIELD_CAP = 1000;
const FIELD_CAPS = {
  command: 1500,
  cwd: 500,
  path: 1000,
  url: 1500,
  query: 500,
  pattern: 1000,
  goal: 1500,
  subject: 200,
  to: 200,
  keys: 500,
};
const FILE_PATH_FIELDS = ['path', 'file_path', 'target_file', 'notebook_path', 'directory'];
const ALIASES = {
  Bash: 'terminal',
  shell: 'terminal',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'apply_patch',
  patch: 'apply_patch',
  web_fetch: 'web_extract',
};

const stringField = (input, names) => {
  for (const name of names) {
    const value = input?.[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
};

const numberField = (input, name) => {
  const value = input?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const commandOf = (input) => {
  const value = input?.command;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  return undefined;
};

const patchTextOf = (input) => {
  const value = input?.patch ?? input?.input;
  return typeof value === 'string' ? value : undefined;
};

const patchCounts = (text) => {
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
};

const contentBytes = (input) => {
  const value = input?.content ?? input?.file_text;
  return typeof value === 'string' ? Buffer.byteLength(value) : undefined;
};

const urlsOf = (input) => {
  if (Array.isArray(input?.urls)) return input.urls.filter((url) => typeof url === 'string' && url !== '');
  const one = stringField(input, ['url']);
  return one ? [one] : [];
};

const delegateGoalOf = (input) => {
  const direct = stringField(input, ['goal']);
  if (direct) return direct;
  const first = Array.isArray(input?.tasks) ? input.tasks[0] : undefined;
  return typeof first?.goal === 'string' && first.goal !== '' ? first.goal : undefined;
};

const SPECS = {
  terminal: {
    fields: (input) => ({ command: commandOf(input), cwd: stringField(input, ['cwd']) }),
    summary: (fields) => (fields.command ?? '').split('\n')[0],
  },
  read_file: {
    fields: (input) => ({
      path: stringField(input, FILE_PATH_FIELDS),
      offset: numberField(input, 'offset'),
      limit: numberField(input, 'limit'),
    }),
    summary: (fields) => fields.path ?? '',
  },
  write_file: {
    fields: (input) => ({ path: stringField(input, FILE_PATH_FIELDS), bytes: contentBytes(input) }),
    summary: (fields) => fields.path ?? '',
  },
  apply_patch: {
    fields: (input) => {
      const text = patchTextOf(input);
      const counts = text === undefined ? {} : patchCounts(text);
      return { path: stringField(input, FILE_PATH_FIELDS), ...counts };
    },
    summary: (fields) => fields.path ?? '',
  },
  web_search: {
    fields: (input) => ({ query: stringField(input, ['query']) }),
    summary: (fields) => fields.query ?? '',
  },
  web_extract: {
    fields: (input) => {
      const urls = urlsOf(input);
      return { url: urls[0], url_count: urls.length > 1 ? urls.length : undefined };
    },
    summary: (fields) => fields.url ?? '',
  },
  search_files: {
    fields: (input) => ({ pattern: stringField(input, ['pattern', 'query']), path: stringField(input, FILE_PATH_FIELDS) }),
    summary: (fields) => fields.pattern ?? '',
  },
  delegate_task: {
    fields: (input) => ({ goal: delegateGoalOf(input) }),
    summary: (fields) => fields.goal ?? '',
  },
  'message.send': {
    fields: (input) => ({ to: stringField(input, ['to', 'recipient']), subject: stringField(input, ['subject']) }),
    summary: (fields) => fields.to ?? fields.subject ?? '',
  },
};

const compact = (fields) => Object.fromEntries(
  Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ''),
);

// ESC, BEL and the rest of the C0 range can drive a terminal or spoof a log
// line. Newline and tab stay because a command legitimately uses them.
const stripControls = (text) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

const truncateText = (text, limit) => {
  const clean = stripControls(text);
  return clean.length > limit ? { text: clean.slice(0, limit), truncated: true } : { text: clean, truncated: false };
};

const truncateBytes = (text, limit) => {
  const clean = stripControls(text);
  const bytes = Buffer.from(clean);
  if (bytes.length <= limit) return { text: clean, truncated: false };
  return { text: bytes.subarray(0, limit).toString('utf8'), truncated: true };
};

const truncateFields = (fields) => {
  const output = {};
  let truncated = false;
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string') {
      output[name] = value;
      continue;
    }
    const result = truncateBytes(value, FIELD_CAPS[name] ?? DEFAULT_FIELD_CAP);
    output[name] = result.text;
    if (result.truncated) truncated = true;
  }
  return { fields: output, truncated };
};

const canonicalBytes = (detail) => Buffer.byteLength(canonical(detail));

const setCanonicalSize = (detail) => {
  let size = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    detail.truncated.bytes = size;
    const next = canonicalBytes(detail);
    if (next === size) return;
    size = next;
  }
  detail.truncated.bytes = size;
};

export function detailHash(detail) {
  return createHash('sha256').update(canonical(detail)).digest('hex');
}

export function captureDetail({ seq, at, action, tool, input } = {}) {
  if (!Number.isInteger(seq) || seq < 1) throw new Error('detail seq must be a positive integer');
  if (typeof at !== 'string' || at === '') throw new Error('detail at must be a timestamp');
  if (typeof action !== 'string' || action === '') throw new Error('detail action must be a string');
  if (tool !== undefined && tool !== null && typeof tool !== 'string') throw new Error('detail tool must be a string');
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('detail input must be an object');
  }

  const toolName = typeof tool === 'string' && tool !== '' ? tool : 'unknown';
  const spec = SPECS[ALIASES[toolName] ?? toolName];
  const raw = input ?? {};
  const rawFields = spec
    ? compact(spec.fields(raw))
    : (() => {
        const keys = Object.keys(raw).slice(0, MAX_UNKNOWN_KEYS).join(', ');
        return keys ? { keys } : {};
      })();
  const redacted = redactFields(rawFields);
  const truncated = truncateFields(redacted.fields);
  const rawSummary = spec
    ? (spec.summary(truncated.fields) ?? '')
    : (truncated.fields.keys ? `${toolName} (${truncated.fields.keys})` : toolName);
  const summaryRedaction = redactText(String(rawSummary));
  if (summaryRedaction.hits.length > 0) {
    for (const hit of summaryRedaction.hits) {
      redacted.redactions.push({ field: 'summary', kind: hit.kind, count: hit.count });
    }
  }
  const summary = truncateText(summaryRedaction.text, MAX_SUMMARY_CHARS);

  const detail = {
    version: DETAIL_VERSION,
    seq,
    at,
    action,
    tool: toolName,
    summary: summary.text || toolName,
    fields: truncated.fields,
    redactions: redacted.redactions,
    truncated: { fields: truncated.truncated || summary.truncated, bytes: 0 },
  };
  setCanonicalSize(detail);
  if (canonicalBytes(detail) > MAX_DETAIL_BYTES) throw new Error('detail exceeds the size cap');
  return { detail, hash: detailHash(detail) };
}

export function verifyDetail(entry, detail) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'entry is required' };
  if (typeof entry.detail_hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.detail_hash)) {
    return { ok: false, reason: 'entry has no detail hash' };
  }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return { ok: false, reason: 'detail is not an object' };
  }
  if (detail.version !== DETAIL_VERSION) return { ok: false, reason: 'detail version is not supported' };
  if (detail.seq !== entry.seq) return { ok: false, reason: 'detail does not belong to this entry' };
  if (detailHash(detail) !== entry.detail_hash) return { ok: false, reason: 'detail hash does not match the entry' };
  return { ok: true };
}
