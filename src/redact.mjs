// Redaction runs before the detail is written. A secret that reaches the
// local details directory is already leaked, even if a later renderer would
// hide it, so this module is the only redaction pass.
//
// The patterns are specific on purpose. A generic "looks random" rule also
// redacts git SHAs, UUIDs, hashes and test data, which turns the detail into
// noise and defeats the point of seeing the act.
const MAX_SCAN_CHARS = 8192;
const RULES = [
  {
    kind: 'key',
    // A private-key block can contain values that later rules would match;
    // replace the whole block first. An unterminated block is redacted to the
    // end of the scan so a truncated PEM cannot leak its body.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replace: '[redacted:jwt]',
  },
  {
    kind: 'key',
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AC[0-9a-f]{32}|SK[0-9a-f]{32}|SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|hooks\.slack\.com\/services\/[A-Za-z0-9/]+)\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'key',
    // No leading boundary: a key glued to a preceding word character is
    // still a key. The trailing boundary keeps the rule from eating prose.
    pattern: /sk-[A-Za-z0-9_-]{20,}\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'key',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'key',
    pattern: /AKIA[0-9A-Z]{16}\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'key',
    pattern: /AIza[0-9A-Za-z_-]{35}\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'key',
    pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/g,
    replace: '[redacted:key]',
  },
  {
    kind: 'token',
    pattern: /\bdigest\s+[^\r\n]+/gi,
    replace: 'digest [redacted:token]',
  },
  {
    kind: 'token',
    pattern: /\b(basic|apikey|api-key|negotiate)\s+[A-Za-z0-9+/=._~-]{8,}/gi,
    replace: '$1 [redacted:token]',
  },
  {
    kind: 'token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: 'Bearer [redacted:token]',
  },
  {
    kind: 'secret',
    // Connection strings and URL userinfo, including an empty user such as
    // redis://:password@host.
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/gi,
    replace: '$1[redacted:secret]$3',
  },
  {
    kind: 'secret',
    pattern: /([?&][^=&#\s]*(?:token|key|secret|signature|password)[^=]*=)[^&\s]+/gi,
    replace: '$1[redacted:secret]',
  },
  {
    kind: 'secret',
    pattern: /(^|\s)(--?(?:password|passwd|token|api[-_]?key|secret|authorization|user)\s+)(\S+)/gi,
    replace: '$1$2[redacted:secret]',
  },
  {
    kind: 'secret',
    pattern: /(\s-u\s+)(\S+:\S+)/gi,
    replace: '$1[redacted:secret]',
  },
  {
    kind: 'secret',
    pattern: /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
    replace: '$1: [redacted:secret]',
  },
  {
    kind: 'secret',
    pattern: /\b(aws_secret_access_key|secret_access_key)\s+(\S+)/gi,
    replace: '$1 [redacted:secret]',
  },
  {
    kind: 'secret',
    // The optional prefix covers env-style names such as OPENAI_API_KEY and
    // my_password, and _key covers AWS_SECRET_ACCESS_KEY / SECRET_KEY. The
    // optional quotes cover JSON bodies. Values that are plainly not secrets
    // (none, true, false, null, an algorithm name) stay readable.
    pattern: /(["']?)([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization|signature|dsn|_key))\1?\s*[:=]\s*(?!(?:none|true|false|null|sha256:)\b)("[^"]*"|'[^']*'|[^,\s;&}]+)/gi,
    replace: (_match, quote, name) => `${quote}${name}=[redacted:secret]`,
  },
];

export function redactText(value) {
  if (typeof value !== 'string') throw new Error('redactText requires a string');
  let text = value;
  const counts = new Map();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const matches = text.match(rule.pattern);
    if (!matches || matches.length === 0) continue;
    counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + matches.length);
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, rule.replace);
  }
  return {
    text,
    hits: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

export function redactFields(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('fields must be an object');
  }
  const output = {};
  const redactions = [];
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      // The field cap is below this bound, so the extra tail only exists to
      // catch a pattern that straddles the cap. Scanning the full command
      // would make a 10 MB input a 10 MB regex pass for no extra evidence.
      const result = redactText(value.slice(0, MAX_SCAN_CHARS));
      output[field] = result.text;
      for (const hit of result.hits) redactions.push({ field, kind: hit.kind, count: hit.count });
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[field] = value;
      continue;
    }
    throw new Error(`field ${field} must be a string, number, boolean or null`);
  }
  return { fields: output, redactions };
}
