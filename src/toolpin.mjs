// A tool manifest is small, local and hashable. Pin the definitions a harness
// reviewed so a changed description or schema is a refusal, not a quiet edit.
// This module never fetches a server's manifest; the caller supplies it.
import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';

const fail = (message) => {
  throw new Error(`tool manifest is invalid: ${message}`);
};

export function toolsDigest(tools) {
  return createHash('sha256').update(canonical(tools)).digest('base64url');
}

function definitionOf(tool) {
  const name = String(tool?.name ?? '').trim();
  if (name === '') fail('every tool needs a name');
  const definition = {
    name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: tool.inputSchema ?? tool.input_schema ?? null,
  };
  // A tool can change what it returns without touching its input schema. Pin
  // the output contract and annotations too, or a server can alter the effect
  // while the lock still says the definition is unchanged.
  if (tool.title !== undefined) definition.title = tool.title;
  if (tool.outputSchema !== undefined) definition.outputSchema = tool.outputSchema;
  if (tool.annotations !== undefined) definition.annotations = tool.annotations;
  return definition;
}

function digestOf(value) {
  return createHash('sha256').update(canonical(value)).digest('base64url');
}

export function manifestDigest(manifest) {
  return digestOf(manifest);
}

export function definitionHash(tool) {
  return createHash('sha256').update(canonical(definitionOf(tool))).digest('base64url');
}

function manifestTools(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (manifest && Array.isArray(manifest.tools)) return manifest.tools;
  fail('expected a tools array');
}

export function pinManifest(manifest, tools) {
  const list = manifestTools(manifest);
  const pins = {};
  for (const tool of list) {
    const definition = definitionOf(tool);
    if (pins[definition.name] !== undefined) fail(`duplicate tool ${definition.name}`);
    pins[definition.name] = definitionHash(tool);
  }
  const lock = { version: 1, tools_digest: toolsDigest(tools), tools: pins };
  lock.manifest_digest = digestOf(manifest);
  // The server handshake and prompts are model-visible too. Their digests are
  // optional so a tools-only manifest keeps the original lock shape.
  if (manifest.server !== undefined) lock.server_digest = digestOf(manifest.server);
  if (manifest.prompts !== undefined) lock.prompts_digest = digestOf(manifest.prompts);
  if (manifest.resources !== undefined) lock.resources_digest = digestOf(manifest.resources);
  if (manifest.resourceTemplates !== undefined) lock.resource_templates_digest = digestOf(manifest.resourceTemplates);
  return lock;
}

export function validateToolLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) fail('lock is not an object');
  if (lock.version !== 1) fail('lock version must be 1');
  if (typeof lock.tools_digest !== 'string' || lock.tools_digest === '') fail('lock has no tools digest');
  if (!lock.tools || typeof lock.tools !== 'object' || Array.isArray(lock.tools)) fail('lock has no tool map');
  for (const field of ['server_digest', 'prompts_digest', 'resources_digest', 'resource_templates_digest', 'manifest_digest']) {
    if (lock[field] !== undefined && (typeof lock[field] !== 'string' || lock[field] === '')) {
      fail(`lock has an invalid ${field}`);
    }
  }
  for (const [name, hash] of Object.entries(lock.tools)) {
    if (name === '' || typeof hash !== 'string' || hash === '') fail('lock has an invalid tool pin');
  }
  return lock;
}

export function comparePin(lock, manifest, tools) {
  validateToolLock(lock);
  const expected = pinManifest(manifest, tools);
  const names = new Set([...Object.keys(lock.tools), ...Object.keys(expected.tools)]);
  const changed = [];
  const added = [];
  const removed = [];
  for (const name of [...names].sort()) {
    const before = lock.tools[name];
    const after = expected.tools[name];
    if (before === undefined) added.push(name);
    else if (after === undefined) removed.push(name);
    else if (before !== after) changed.push(name);
  }
  const surfaces = [];
  for (const field of ['server', 'prompts', 'resources', 'resource_templates']) {
    if (lock[`${field}_digest`] !== expected[`${field}_digest`]) surfaces.push(field);
  }
  if (lock.manifest_digest !== undefined && lock.manifest_digest !== expected.manifest_digest) surfaces.push('manifest');
  const digestChanged = lock.tools_digest !== expected.tools_digest;
  return {
    ok: !digestChanged && changed.length === 0 && added.length === 0 && removed.length === 0 && surfaces.length === 0,
    digestChanged,
    changed,
    added,
    removed,
    surfaces,
    expected,
  };
}

export function toolGate(lock, currentToolsDigest, proposal) {
  if (!lock) return null;
  validateToolLock(lock);
  if (lock.tools_digest !== currentToolsDigest) {
    return { decision: 'DENY', code: 'TOOL_CHANGED', rule: 'tool.pin', tool_pin: 'changed' };
  }
  if (!proposal.tool_hash) return null;
  const pinned = lock.tools[proposal.subject];
  if (pinned === undefined) {
    return { decision: 'DENY', code: 'TOOL_UNPINNED', rule: 'tool.pin', tool_pin: 'unpinned' };
  }
  if (pinned !== proposal.tool_hash) {
    return { decision: 'DENY', code: 'TOOL_CHANGED', rule: 'tool.pin', tool_pin: 'changed' };
  }
  return null;
}
