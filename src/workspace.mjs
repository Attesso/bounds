import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const VERSION = 1;

export function workspacePath(home = homedir()) {
  return join(home, '.config', 'attesso', 'config.json');
}

function normalizeUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('sync_url is required');
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('sync_url must be a valid URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('sync_url must use https, or http on localhost');
  }
  if (url.username || url.password) throw new Error('sync_url must not contain credentials');
  return url.toString().replace(/\/$/, '');
}

function normalizeKey(input) {
  if (typeof input !== 'string') throw new Error('api_key is required');
  const key = input.trim();
  if (!/^att_[A-Za-z0-9._-]{8,}$/.test(key)) throw new Error('api_key must be an Attesso API key');
  return key;
}

function normalizeName(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const name = String(input).trim();
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error('workspace must be 1 to 80 printable characters');
  return name;
}

export function readWorkspace({ home = homedir() } = {}) {
  const file = workspacePath(home);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!raw || raw.version !== VERSION) throw new Error(`${file} is not a version 1 workspace config`);
  return {
    version: VERSION,
    sync_url: normalizeUrl(raw.sync_url),
    api_key: normalizeKey(raw.api_key),
    workspace: normalizeName(raw.workspace),
  };
}

export function writeWorkspace({ home = homedir(), syncUrl, apiKey, workspace } = {}) {
  const file = workspacePath(home);
  const value = {
    version: VERSION,
    sync_url: normalizeUrl(syncUrl),
    api_key: normalizeKey(apiKey),
    workspace: normalizeName(workspace),
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return { sync_url: value.sync_url, workspace: value.workspace };
}

export function clearWorkspace({ home = homedir() } = {}) {
  const file = workspacePath(home);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function workspaceView({ home = homedir() } = {}) {
  const config = readWorkspace({ home });
  if (!config) return { connected: false };
  return { connected: true, sync_url: config.sync_url, workspace: config.workspace };
}

export function resolveWorkspace({ home = homedir(), url, key, env = process.env } = {}) {
  const config = readWorkspace({ home });
  const resolvedUrl = url ?? env.ATTESSO_SYNC_URL ?? config?.sync_url;
  const resolvedKey = key ?? env.ATTESSO_API_KEY ?? config?.api_key;
  if (!resolvedUrl) throw new Error('no sync URL: connect a hosted workspace or pass --url');
  if (!resolvedKey) throw new Error('no API key: connect a hosted workspace or pass --key');
  return { url: normalizeUrl(resolvedUrl), key: normalizeKey(resolvedKey) };
}
