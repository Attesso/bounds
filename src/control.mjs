// Local steering state. This file is deliberately outside the signed ledger:
// it is the operator's current intent, not a decision about an action. A
// decision made under it is signed by append as a control entry.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { withLedgerLock } from './store.mjs';

export const CONTROL_MODES = ['pause', 'stop'];
const controlPath = (dir) => join(dir, 'control.json');
const empty = () => ({ version: 1, tasks: {} });

function fail(message) {
  throw new Error(`CONTROL_INVALID: ${message}`);
}

function validate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('not an object');
  if (value.version !== 1) fail('version must be 1');
  if (value.tasks === null || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) fail('tasks must be an object');
  for (const [task, control] of Object.entries(value.tasks)) {
    if (task === '') fail('task id must not be empty');
    if (control === null || typeof control !== 'object' || Array.isArray(control)) fail(`task ${task} is not an object`);
    if (!CONTROL_MODES.includes(control.mode)) fail(`task ${task} has unknown mode`);
    if (typeof control.at !== 'string' || Number.isNaN(Date.parse(control.at))) fail(`task ${task} has no timestamp`);
    if (control.reason !== undefined && typeof control.reason !== 'string') fail(`task ${task} has a non-string reason`);
  }
  return value;
}

function fsyncDir(path) {
  let handle;
  try {
    handle = openSync(path, 'r');
    fsyncSync(handle);
  } catch {
    // Directory fsync is unavailable on some platforms.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function writeControl(dir, value) {
  validate(value);
  const file = controlPath(dir);
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, file);
  fsyncDir(dir);
}

export function readControl(dir) {
  const file = controlPath(dir);
  if (!existsSync(file)) return empty();
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(error.message);
  }
  return validate(value);
}

export function taskControl(dir, task) {
  return readControl(dir).tasks[task];
}

export function listControl(dir) {
  return Object.entries(readControl(dir).tasks)
    .map(([task, control]) => ({ task, ...control }))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

export function setTaskControl(dir, task, mode, { reason } = {}) {
  if (typeof task !== 'string' || task === '') throw new Error('task id must not be empty');
  if (!CONTROL_MODES.includes(mode)) throw new Error(`mode must be ${CONTROL_MODES.join(' or ')}`);
  if (reason !== undefined && typeof reason !== 'string') throw new Error('reason must be a string');
  return withLedgerLock(dir, () => {
    const value = readControl(dir);
    value.tasks[task] = { mode, at: new Date().toISOString(), ...(reason === undefined ? {} : { reason }) };
    writeControl(dir, value);
    return { task, ...value.tasks[task] };
  });
}

export function clearTaskControl(dir, task) {
  if (typeof task !== 'string' || task === '') throw new Error('task id must not be empty');
  return withLedgerLock(dir, () => {
    const value = readControl(dir);
    if (value.tasks[task] === undefined) return false;
    delete value.tasks[task];
    writeControl(dir, value);
    return true;
  });
}
