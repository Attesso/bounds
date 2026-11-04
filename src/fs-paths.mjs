// Filesystem scope for file tools. This is deliberately separate from the
// action policy: a tool can be allowed by the policy and still fail because the
// path it names is outside the roots the user approved.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const PATH_ACCESS = ['read', 'write'];
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
export const FILE_TOOLS = new Set([
  'read_file', 'write_file', 'patch', 'apply_patch', 'search_files', 'list_dir',
  'create_file', 'delete_file', 'edit_file', 'str_replace_editor', 'notebook_edit',
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'read_files', 'write_to_file', 'replace_in_file',
]);

export function validatePathsConfig(value) {
  const fail = (message) => { throw new Error(`paths.json is invalid: ${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('not an object');
  if (value.version !== 1) fail('version must be 1');
  if (!Array.isArray(value.allowed_roots)) fail('allowed_roots must be a list');
  if (!Array.isArray(value.exclusions)) fail('exclusions must be a list');
  if (value.allowed_roots.length > 128) fail('too many allowed roots');
  if (value.exclusions.length > 128) fail('too many exclusions');
  const roots = value.allowed_roots.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('every allowed root needs path and access');
    if (typeof entry.path !== 'string' || entry.path.trim() === '') fail('allowed root path must not be empty');
    if (entry.path.includes('..')) fail(`allowed root may not traverse: ${entry.path}`);
    if (!Array.isArray(entry.access) || entry.access.length === 0) fail(`allowed root needs access: ${entry.path}`);
    const access = [...new Set(entry.access)];
    if (access.some((item) => !PATH_ACCESS.includes(item))) fail(`unknown access: ${entry.path}`);
    return { path: entry.path.trim(), access };
  });
  const exclusions = value.exclusions.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') fail('exclusion must be a non-empty path');
    if (item.includes('..')) fail(`exclusion may not traverse: ${item}`);
    return item.trim();
  });
  const shellScope = value.shell_scope ?? 'unscoped';
  if (!['unscoped', 'deny'].includes(shellScope)) fail('shell_scope must be unscoped or deny');
  return { version: 1, allowed_roots: roots, exclusions, ...(value.shell_scope === undefined ? {} : { shell_scope: shellScope }) };
}

const expand = (value, home) => value.startsWith('~/') ? join(home, value.slice(2)) : value;
const posix = (value) => value.split(sep).join('/');

function absolutePath(value, { cwd, home }) {
  const expanded = expand(value, home);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

function realOrLexical(value) {
  try {
    return realpathSync(value);
  } catch {
    // A write target may not exist yet. Resolve its existing parent so a symlink
    // in the parent cannot be used to escape the configured root.
    try {
      return join(realpathSync(dirname(value)), value.slice(dirname(value).length + 1));
    } catch {
      return value;
    }
  }
}

function under(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function glob(pattern) {
  const chars = [...posix(pattern)];
  let expression = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '*' && chars[index + 1] === '*') {
      if (chars[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`, CASE_INSENSITIVE ? 'i' : '');
}

export function evaluatePathScope(config, proposal, { cwd = process.cwd(), home = homedir() } = {}) {
  if (!config) return null;
  if (config.shell_scope === 'deny' && proposal.capability === 'execute') {
    return { decision: 'DENY', code: 'SHELL_SCOPE_DENIED', rule: 'shell-scope' };
  }
  if (typeof proposal.path !== 'string' || proposal.path === '') {
    return FILE_TOOLS.has(proposal.subject) ? { decision: 'DENY', code: 'PATH_REQUIRED', rule: 'path-required' } : null;
  }
  const target = realOrLexical(absolutePath(proposal.path, { cwd, home }));
  const targetPosix = posix(target);
  const excluded = config.exclusions.some((pattern) => {
    const expression = glob(pattern);
    return expression.test(targetPosix) || expression.test(posix(proposal.path));
  });
  if (excluded) return { decision: 'DENY', code: 'PATH_SCOPE_DENIED', rule: 'path-exclusion' };
  const capability = proposal.capability;
  if (!PATH_ACCESS.includes(capability)) return null;
  const roots = config.allowed_roots.map((entry) => ({
    root: realOrLexical(absolutePath(entry.path.replace(/\/\*\*$/, ''), { cwd, home })),
    access: entry.access,
  }));
  const match = roots.find((entry) => under(entry.root, target));
  if (!match) return { decision: 'DENY', code: 'PATH_SCOPE_DENIED', rule: 'path-root' };
  if (!match.access.includes(capability)) {
    return { decision: 'DENY', code: 'PATH_SCOPE_DENIED', rule: 'path-access' };
  }
  return null;
}
