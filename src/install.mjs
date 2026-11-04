// Harness installation belongs here. setup decides what to install; this
// module knows only how a hook is written, backed up and replaced.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES } from './harness.mjs';

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

const hookCommand = (cli, dir, enforce = false, modeFile = false) =>
  `${shellQuote(cli)} --dir ${shellQuote(dir)} hook${modeFile ? '' : enforce ? '' : ' --observe'}`;

const hermesConfig = () => join(homedir(), '.hermes', 'config.yaml');

function readJsonConfig(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must hold an object`);
  }
  return parsed;
}

const containsAttesso = (group) => /attesso[^"]*hook/.test(JSON.stringify(group));

function wireJsonHook(path, event, cli, dir, { dryRun = false, enforce = false, failureBlock = false, modeFile = false } = {}) {
  if (!existsSync(path)) return { applied: false, reason: `no config at ${path}` };
  const config = readJsonConfig(path, path);
  const hooks = config.hooks;
  if (hooks !== undefined && (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))) {
    return { applied: false, reason: 'hooks is not an object; merge by hand' };
  }
  const existing = hooks?.[event];
  if (existing !== undefined && !Array.isArray(existing)) {
    return { applied: false, reason: `${event} is not a list; merge by hand` };
  }
  const handler = { type: 'command', command: hookCommand(cli, dir, enforce, modeFile), timeout: 10 };
  if (enforce && failureBlock) handler.onFailure = 'block';
  const groups = existing ?? [];
  const ourGroups = groups.filter(containsAttesso);
  if (ourGroups.some((group) => group.hooks?.some((entry) => entry.command === handler.command))) {
    return { applied: false, reason: 'already wired' };
  }
  const nextGroups = ourGroups.length
    ? groups.map((group) =>
        containsAttesso(group)
          ? {
              ...group,
              hooks: (group.hooks ?? []).map((entry) =>
                /attesso[^"]*hook/.test(entry.command ?? '') ? handler : entry,
              ),
            }
          : group,
      )
    : [...groups, { matcher: '*', hooks: [handler] }];
  const next = {
    ...config,
    hooks: { ...(hooks ?? {}), [event]: nextGroups },
  };
  if (dryRun) return { applied: false, dryRun: true, path, preview: next };
  renameSync(path, `${path}.bak`);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { applied: true, path, changed: ourGroups.length > 0 };
}

export function wireClaude(cli, dir, { dryRun = false, enforce = false, modeFile = false, path = join(homedir(), '.claude', 'settings.json') } = {}) {
  return wireJsonHook(path, HARNESSES['claude-code'].event, cli, dir, { dryRun, enforce, modeFile, failureBlock: true });
}

export function wireCodex(cli, dir, { dryRun = false, enforce = false, modeFile = false, path = join(homedir(), '.codex', 'hooks.json') } = {}) {
  return wireJsonHook(path, HARNESSES.codex.event, cli, dir, { dryRun, enforce, modeFile });
}

export function wireGemini(cli, dir, { dryRun = false, enforce = false, modeFile = false, path = join(homedir(), '.gemini', 'settings.json') } = {}) {
  return wireJsonHook(path, HARNESSES.gemini.event, cli, dir, { dryRun, enforce, modeFile });
}

export function wireCline(cli, dir, { dryRun = false, enforce = false, modeFile = false, path = join(homedir(), 'Documents', 'Cline', 'Hooks') } = {}) {
  const file = join(path, HARNESSES.cline.script);
  const script = `#!/bin/sh\nexec ${hookCommand(cli, dir, enforce, modeFile)}\n`;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current === script) return { applied: false, reason: 'already wired' };
  if (dryRun) return { applied: false, dryRun: true, path: file, preview: script };
  mkdirSync(path, { recursive: true });
  if (existsSync(file)) renameSync(file, `${file}.bak`);
  writeFileSync(file, script, { mode: 0o755 });
  chmodSync(file, 0o755);
  return { applied: true, path: file, changed: current.includes('attesso') };
}

export function wireHermes(cli, dir, { dryRun = false, enforce = false, modeFile = false, path = hermesConfig() } = {}) {
  if (!existsSync(path)) return { applied: false, reason: 'no Hermes config at ~/.hermes/config.yaml' };
  const text = readFileSync(path, 'utf8');
  if (/attesso.*hook/.test(text)) return { applied: false, reason: 'already wired' };
  const block = `hooks:\n  ${HARNESSES.hermes.event}:\n    - command: ${hookCommand(cli, dir, enforce, modeFile)}\n      timeout: 10\n`;
  if (/^hooks:/m.test(text)) {
    return { applied: false, reason: 'config already has a hooks: block, merge by hand', snippet: block };
  }
  const next = text.replace(/^approvals:/m, `${block}approvals:`);
  if (next === text) return { applied: false, reason: 'no anchor to insert before; add the block by hand', snippet: block };
  if (dryRun) return { applied: false, dryRun: true, path, snippet: block };
  renameSync(path, `${path}.bak`);
  writeFileSync(path, next);
  return { applied: true, path, snippet: block };
}

const writers = {
  hermes: wireHermes,
  'claude-code': wireClaude,
  codex: wireCodex,
  gemini: wireGemini,
  cline: wireCline,
};

export function wireHarness(key, cli, dir, options = {}) {
  const writer = writers[key];
  return writer ? writer(cli, dir, options) : { applied: false, reason: `no installer for ${key}` };
}
