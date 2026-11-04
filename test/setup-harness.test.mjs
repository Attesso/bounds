import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wireClaude, wireCline, wireCodex, wireGemini } from '../src/install.mjs';
import { detectHarnesses } from '../src/setup.mjs';
import { tempDir } from './helpers.mjs';

const initial = () => ({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'rex session-start' }] }],
  },
});

test('the Claude Code writer preserves existing hooks and is idempotent', () => {
  const path = join(tempDir('attesso-claude'), 'settings.json');
  writeFileSync(path, JSON.stringify(initial()));

  const dry = wireClaude('/opt/attesso', '.attesso', { dryRun: true, path });
  assert.equal(dry.applied, false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.PreToolUse, undefined);

  const applied = wireClaude('/opt/attesso', '.attesso', { path });
  assert.equal(applied.applied, true);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.hooks.SessionStart.length, 1);
  assert.equal(config.hooks.PreToolUse.length, 1);
  assert.match(config.hooks.PreToolUse[0].hooks[0].command, /hook --observe/);
  assert.equal(config.hooks.PreToolUse[0].hooks[0].onFailure, undefined);

  const again = wireClaude('/opt/attesso', '.attesso', { path });
  assert.equal(again.reason, 'already wired');

  const enforce = wireClaude('/opt/attesso', '.attesso', { path, enforce: true });
  assert.equal(enforce.applied, true);
  const enforced = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(enforced.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.doesNotMatch(enforced.hooks.PreToolUse[0].hooks[0].command, /--observe/);
  assert.equal(wireClaude('/opt/attesso', '.attesso', { path, enforce: true }).reason, 'already wired');
});

test('the Codex writer uses the same native hook without Claude-only fields', () => {
  const path = join(tempDir('attesso-codex'), 'hooks.json');
  writeFileSync(path, JSON.stringify(initial()));

  const applied = wireCodex('/opt/attesso', '.attesso', { path, enforce: true });
  assert.equal(applied.applied, true);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.hooks.SessionStart.length, 1);
  assert.match(config.hooks.PreToolUse[0].hooks[0].command, /--dir '\.attesso' hook$/);
  assert.equal(config.hooks.PreToolUse[0].hooks[0].onFailure, undefined);
});

test('the Claude enforce writer sets onFailure block', () => {
  const path = join(tempDir('attesso-claude-enforce'), 'settings.json');
  writeFileSync(path, JSON.stringify(initial()));

  wireClaude('/opt/attesso', '.attesso', { path, enforce: true });
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
});

test('the Gemini writer uses BeforeTool and no Claude-only fields', () => {
  const path = join(tempDir('attesso-gemini'), 'settings.json');
  writeFileSync(path, JSON.stringify(initial()));

  const applied = wireGemini('/opt/attesso', '.attesso', { path });
  assert.equal(applied.applied, true);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.hooks.BeforeTool.length, 1);
  assert.match(config.hooks.BeforeTool[0].hooks[0].command, /hook --observe$/);
  assert.equal(config.hooks.BeforeTool[0].hooks[0].onFailure, undefined);
});

test('the Cline writer installs an executable PreToolUse script', () => {
  const path = tempDir('attesso-cline');
  const dry = wireCline('/opt/attesso', '.attesso', { path, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(existsSync(join(path, 'PreToolUse')), false);

  const applied = wireCline('/opt/attesso', '.attesso', { path });
  assert.equal(applied.applied, true);
  const file = join(path, 'PreToolUse');
  assert.match(readFileSync(file, 'utf8'), /exec '\/opt\/attesso' --dir '\.attesso' hook --observe/);
  assert.equal(statSync(file).mode & 0o111, 0o111);
  assert.equal(wireCline('/opt/attesso', '.attesso', { path }).reason, 'already wired');

  const enforce = wireCline('/opt/attesso', '.attesso', { path, enforce: true });
  assert.equal(enforce.applied, true);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /--observe/);
  assert.equal(wireCline('/opt/attesso', '.attesso', { path, enforce: true }).reason, 'already wired');
});

test('an invalid harness config is refused, not overwritten', () => {
  const path = join(tempDir('attesso-bad-config'), 'settings.json');
  writeFileSync(path, '{not json');
  assert.throws(() => wireClaude('/opt/attesso', '.attesso', { path }), /not valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{not json');
});

test('detection reads the user-level Claude and Codex configs', () => {
  const home = tempDir('attesso-home');
  const cwd = tempDir('attesso-cwd');
  for (const [directory, file] of [['.claude', 'settings.json'], ['.codex', 'hooks.json']]) {
    const dir = join(home, directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), '{}');
  }
  const found = detectHarnesses({ home, cwd });
  assert.deepEqual(found.map((entry) => entry.key), ['claude-code', 'codex']);
});
