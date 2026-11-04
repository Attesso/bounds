import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { evaluatePathScope, validatePathsConfig } from '../src/fs-paths.mjs';
import { hookCall, initWorkspace, tempDir } from './helpers.mjs';

const fixture = () => {
  const root = tempDir('attesso-path-root');
  const outside = tempDir('attesso-path-outside');
  mkdirSync(join(root, 'nested'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, outside };
};
const config = (root) => ({
  version: 1,
  allowed_roots: [{ path: root, access: ['read', 'write'] }],
  exclusions: ['**/.env', '**/.ssh/**'],
});
const proposal = (path, capability = 'read') => ({ path, capability });

test('a path inside an allowed root is allowed for read and write', () => {
  const { root } = fixture();
  const paths = config(root);
  assert.equal(evaluatePathScope(paths, proposal(join(root, 'nested', 'file.txt'))), null);
  assert.equal(evaluatePathScope(paths, proposal(join(root, 'new.txt'), 'write')), null);
});

test('a path outside the root is refused', () => {
  const { root, outside } = fixture();
  const result = evaluatePathScope(config(root), proposal(join(outside, 'file.txt')));
  assert.equal(result.code, 'PATH_SCOPE_DENIED');
  assert.equal(result.rule, 'path-root');
});

test('a read-only root refuses a write and allows a read', () => {
  const { root } = fixture();
  const paths = config(root);
  paths.allowed_roots[0].access = ['read'];
  assert.equal(evaluatePathScope(paths, proposal(join(root, 'a'), 'read')), null);
  assert.equal(evaluatePathScope(paths, proposal(join(root, 'a'), 'write')).rule, 'path-access');
});

test('an exclusion wins over an allowed root', () => {
  const { root } = fixture();
  const result = evaluatePathScope(config(root), proposal(join(root, '.env')));
  assert.equal(result.code, 'PATH_SCOPE_DENIED');
  assert.equal(result.rule, 'path-exclusion');
});

test('a root-level .env and .ssh are excluded by ** globs', () => {
  const { root } = fixture();
  mkdirSync(join(root, '.ssh'), { recursive: true });
  assert.equal(evaluatePathScope(config(root), proposal(join(root, '.env'))).code, 'PATH_SCOPE_DENIED');
  assert.equal(evaluatePathScope(config(root), proposal(join(root, '.ssh', 'id'))).code, 'PATH_SCOPE_DENIED');
});

test('case variants are excluded on case-insensitive platforms', () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const { root } = fixture();
  assert.equal(evaluatePathScope(config(root), proposal(join(root, '.ENV'))).code, 'PATH_SCOPE_DENIED');
  assert.equal(evaluatePathScope(config(root), proposal(join(root, '.SSH', 'id'))).code, 'PATH_SCOPE_DENIED');
});

test('traversal to an outside path is refused after normalisation', () => {
  const { root, outside } = fixture();
  const result = evaluatePathScope(config(root), proposal(join(root, '..', 'outside', 'x')));
  assert.equal(result.code, 'PATH_SCOPE_DENIED');
});

test('a symlink inside the root cannot escape it', () => {
  const { root, outside } = fixture();
  symlinkSync(outside, join(root, 'link'));
  const result = evaluatePathScope(config(root), proposal(join(root, 'link', 'x')));
  assert.equal(result.code, 'PATH_SCOPE_DENIED');
});

test('a file tool with no path is refused, while a non-file tool is not', () => {
  const { root } = fixture();
  assert.equal(evaluatePathScope(config(root), { subject: 'read_file', capability: 'read' }).code, 'PATH_REQUIRED');
  assert.equal(evaluatePathScope(config(root), { subject: 'web_extract', capability: 'read' }), null);
});

test('path config validation names the bad field', () => {
  assert.throws(() => validatePathsConfig({ version: 1, allowed_roots: [{ path: '../x', access: ['read'] }], exclusions: [] }), /traverse/);
  assert.throws(() => validatePathsConfig({ version: 1, allowed_roots: [{ path: '/x', access: ['admin'] }], exclusions: [] }), /unknown access/);
  assert.throws(() => validatePathsConfig({ version: 1, allowed_roots: [], exclusions: ['../.env'] }), /traverse/);
});

test('the hook refuses a path outside the configured scope', () => {
  const dir = initWorkspace('attesso-path-hook');
  const { root, outside } = fixture();
  writeFileSync(join(dir, 'paths.json'), JSON.stringify(config(root)));
  const inside = hookCall(dir, {
    tool_name: 'read_file',
    tool_input: { path: join(root, 'nested', 'file.txt') },
    session_id: 'path-scope',
  });
  assert.equal(inside.status, 0);
  const blocked = hookCall(dir, {
    tool_name: 'read_file',
    tool_input: { path: join(outside, 'file.txt') },
    session_id: 'path-scope-out',
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /PATH_SCOPE_DENIED/);
});


test('shell scope is explicit: unscoped by default, denied only when configured', () => {
  const { root } = fixture();
  const base = config(root);
  assert.equal(evaluatePathScope(base, { capability: 'execute', subject: 'terminal' }), null);
  const strict = validatePathsConfig({ ...base, shell_scope: 'deny' });
  assert.equal(strict.shell_scope, 'deny');
  const result = evaluatePathScope(strict, { capability: 'execute', subject: 'terminal' });
  assert.equal(result.code, 'SHELL_SCOPE_DENIED');
  assert.equal(result.rule, 'shell-scope');
  assert.throws(() => validatePathsConfig({ ...base, shell_scope: 'scoped' }), /shell_scope/);
});


test('the hook refuses an execute capability when shell_scope is deny', () => {
  const dir = initWorkspace('attesso-path-shell');
  const { root } = fixture();
  writeFileSync(join(dir, 'paths.json'), JSON.stringify({ ...config(root), shell_scope: 'deny' }));
  const result = hookCall(dir, { tool_name: 'terminal', tool_input: { command: 'pwd' }, session_id: 'shell-scope' });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /SHELL_SCOPE_DENIED/);
});
