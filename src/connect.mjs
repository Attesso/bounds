// Agent-controlled setup. The connector is the command an agent can run
// without opening Bounds: initialize the ledger, write a mode file, wire the
// harness hook, and report a machine-readable result on stdout.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { detectHarnesses, writeAgentContext } from './setup.mjs';
import { wireHarness } from './install.mjs';
import { init, isInitialised, paths } from './store.mjs';

export const CONNECT_MODES = ['off', 'observe', 'enforce'];
export const MODE_FILE = 'mode';

export function modePath(dir) {
  return join(dir, MODE_FILE);
}

export function readMode(dir) {
  const file = modePath(dir);
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  if (!CONNECT_MODES.includes(value)) {
    throw new Error(`invalid mode '${value}'; expected ${CONNECT_MODES.join(', ')}`);
  }
  return value;
}

export function setModeAll(dir, mode, { home = homedir() } = {}) {
  setMode(dir, mode);
  for (const legacyDir of legacyModeDirs(home)) setMode(legacyDir, mode);
  return mode;
}

export function setMode(dir, mode) {
  if (!CONNECT_MODES.includes(mode)) {
    throw new Error(`invalid mode '${mode}'; expected ${CONNECT_MODES.join(', ')}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = modePath(dir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${mode}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return mode;
}

function legacyModeDirs(home) {
  const config = join(home, '.hermes', 'config.yaml');
  if (!existsSync(config)) return [];
  try {
    const text = readFileSync(config, 'utf8');
    const match = text.match(/^\s*-\s*command:\s*(.+hook\.sh)\s*$/m);
    if (!match) return [];
    const command = match[1].trim().replace(/^['"]|['"]$/g, '');
    return command.includes('attesso-veto') ? [dirname(command)] : [];
  } catch {
    return [];
  }
}

function wiredHarnesses(harnesses, { dir, cwd }) {
  const ledger = resolve(dir);
  return harnesses.map((harness) => {
    const candidate = harness.key === 'cline' ? join(harness.path, 'PreToolUse') : harness.path;
    let wired = false;
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, 'utf8');
        // A hook for a different ledger is not this project's connection. The
        // legacy wrapper has no --dir, so it keeps counting as wired.
        const match = text.match(/--dir\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
        const target = match ? match[1] || match[2] || match[3] : null;
        wired = target ? resolve(cwd, target) === ledger : /attesso[^\n"]*hook/.test(text);
      } catch {
        wired = false;
      }
    }
    return { ...harness, wired };
  });
}

function instructions({ initialized, mode, wired, manual }) {
  if (!initialized) return ['run `attesso init` first'];
  const next = [];
  if (!mode) next.push('run `attesso connect --write --mode observe` from the agent');
  else if (mode === 'off') next.push('run `attesso mode observe` to start recording');
  if (manual.length) next.push('wire the listed harnesses by hand, or use the generic hook contract');
  if (mode && !wired.length && !manual.length) {
    next.push('no agent harness detected; wire the generic hook contract or run `attesso connect` from an agent project');
  }
  return next;
}

export function status({ dir, cwd = process.cwd(), home = homedir() } = {}) {
  const initialized = isInitialised(dir);
  const mode = readMode(dir);
  const detected = wiredHarnesses(detectHarnesses({ home, cwd }), { dir, cwd });
  const wired = detected.filter((harness) => harness.wired);
  const manual = detected.filter((harness) => !['hermes', 'claude-code', 'codex', 'gemini', 'cline'].includes(harness.key));
  return {
    initialized,
    mode,
    ledger: initialized ? paths(dir).dir : null,
    harnesses: detected,
    wired: wired.map((harness) => harness.key),
    manual: manual.map((harness) => harness.key),
    connected: initialized && mode !== null && mode !== 'off' && wired.length > 0,
    next: instructions({ initialized, mode, wired, manual }),
  };
}

export function connect({
  dir,
  cwd = process.cwd(),
  home = homedir(),
  cli,
  write = false,
  mode = 'observe',
  harness: only = null,
} = {}) {
  if (!CONNECT_MODES.includes(mode)) {
    throw new Error(`invalid mode '${mode}'; expected ${CONNECT_MODES.join(', ')}`);
  }
  // Harness configs are global. A relative --dir becomes a hook that points at
  // whatever .attesso happens to be in the agent's current directory, so the
  // ledger path must be absolute before it is written anywhere.
  const ledgerDir = resolve(dir);
  const initialized = isInitialised(ledgerDir);
  if (write && !initialized) init(ledgerDir);
  const detected = detectHarnesses({ home, cwd }).filter((harness) => !only || harness.key === only);
  const agentContext = writeAgentContext(cwd, { dryRun: !write });
  const results = [];
  for (const harness of detected) {
    if (!['hermes', 'claude-code', 'codex', 'gemini', 'cline'].includes(harness.key)) {
      results.push({
        key: harness.key,
        path: harness.path,
        wired: false,
        manual: true,
        reason: 'no automatic installer; use the generic hook contract',
      });
      continue;
    }
    try {
      const result = wireHarness(harness.key, cli, ledgerDir, {
        dryRun: !write,
        enforce: mode === 'enforce',
        modeFile: true,
        path: harness.path,
      });
      const warnings = [];
      if (harness.key === 'codex' && result.applied) warnings.push('Codex requires running /hooks and trusting the installed command');
      results.push({ key: harness.key, path: harness.path, ...result, ...(warnings.length ? { warnings } : {}) });
    } catch (error) {
      results.push({ key: harness.key, path: harness.path, wired: false, error: error.message });
    }
  }
  if (write) setModeAll(ledgerDir, mode, { home });
  const wired = results.filter((result) => result.applied || result.reason === 'already wired');
  const effectiveMode = write ? mode : readMode(ledgerDir);
  return {
    initialized: isInitialised(ledgerDir),
    mode: effectiveMode,
    connected: isInitialised(ledgerDir) && effectiveMode !== null && effectiveMode !== 'off' && wired.length > 0,
    ledger: paths(ledgerDir).dir,
    harnesses: results,
    wired: wired.map((result) => result.key),
    manual: results.filter((result) => result.manual || result.error || result.reason?.includes('merge by hand')).map((result) => result.key),
    agent_context: agentContext,
    next: instructions({ initialized: isInitialised(ledgerDir), mode: effectiveMode, wired, manual: results.filter((result) => result.manual || result.error) }),
  };
}
