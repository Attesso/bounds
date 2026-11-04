import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  clearWorkspace,
  readWorkspace,
  resolveWorkspace,
  workspacePath,
  workspaceView,
  writeWorkspace,
} from '../src/workspace.mjs';
import { tempDir } from './helpers.mjs';

const home = () => tempDir('attesso-workspace-home');

test('a workspace config is private, readable and never exposes its key in the view', () => {
  const root = home();
  const written = writeWorkspace({
    home: root,
    syncUrl: 'https://api.attesso.com',
    apiKey: 'att_test_abcdefghijklmnop',
    workspace: 'Attesso',
  });
  assert.deepEqual(written, { sync_url: 'https://api.attesso.com', workspace: 'Attesso' });
  const file = workspacePath(root);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const config = readWorkspace({ home: root });
  assert.equal(config.api_key, 'att_test_abcdefghijklmnop');
  assert.equal(JSON.stringify(workspaceView({ home: root })).includes('att_test_'), false);
  assert.deepEqual(workspaceView({ home: root }), {
    connected: true,
    sync_url: 'https://api.attesso.com',
    workspace: 'Attesso',
  });
  assert.equal(clearWorkspace({ home: root }), true);
  assert.equal(readWorkspace({ home: root }), null);
  assert.deepEqual(workspaceView({ home: root }), { connected: false });
});

test('explicit values win over environment and config', () => {
  const root = home();
  writeWorkspace({ home: root, syncUrl: 'https://config.example', apiKey: 'att_config_abcdefghijkl' });
  const resolved = resolveWorkspace({
    home: root,
    url: 'https://explicit.example/',
    key: 'att_explicit_abcdefghij',
    env: { ATTESSO_SYNC_URL: 'https://env.example', ATTESSO_API_KEY: 'att_env_abcdefghijkl' },
  });
  assert.deepEqual(resolved, { url: 'https://explicit.example', key: 'att_explicit_abcdefghij' });
});

test('environment and config can be used without either variable being set twice', () => {
  const root = home();
  writeWorkspace({ home: root, syncUrl: 'https://config.example/', apiKey: 'att_config_abcdefghijkl' });
  assert.deepEqual(resolveWorkspace({ home: root, env: {} }), {
    url: 'https://config.example',
    key: 'att_config_abcdefghijkl',
  });
  assert.deepEqual(resolveWorkspace({
    home: root,
    env: { ATTESSO_SYNC_URL: 'http://localhost:8787/', ATTESSO_API_KEY: 'att_env_abcdefghijkl' },
  }), { url: 'http://localhost:8787', key: 'att_env_abcdefghijkl' });
});

test('workspace validation fails closed on remote http, credentials and short keys', () => {
  const root = home();
  assert.throws(() => writeWorkspace({ home: root, syncUrl: 'http://api.attesso.com', apiKey: 'att_test_abcdefghij' }), /https/);
  assert.throws(() => writeWorkspace({ home: root, syncUrl: 'https://api.attesso.com', apiKey: 'short' }), /API key/);
  assert.throws(() => writeWorkspace({ home: root, syncUrl: 'https://user:pass@api.attesso.com', apiKey: 'att_test_abcdefghij' }), /credentials/);
  assert.throws(() => resolveWorkspace({ home: root, env: {} }), /no sync URL/);
});

test('a malformed workspace config is named instead of ignored', () => {
  const root = home();
  mkdirSync(join(root, '.config', 'attesso'), { recursive: true });
  writeFileSync(workspacePath(root), '{bad', { mode: 0o600 });
  assert.throws(() => readWorkspace({ home: root }), /not valid JSON/);
  writeFileSync(workspacePath(root), JSON.stringify({ version: 2 }), { mode: 0o600 });
  assert.throws(() => readWorkspace({ home: root }), /version 1/);
  assert.equal(join(root, '.config', 'attesso', 'config.json'), workspacePath(root));
});
