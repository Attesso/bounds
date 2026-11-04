// What a tool call is, decided once for every harness. An unknown tool is an
// untrusted read: the opposite default silently trusts whatever a harness adds.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TOOLS = {
  version: 1,
  trusted_read: [
    'read_file',
    'search_files',
    'skill_view',
    'fact_store',
    'fact_feedback',
    'todo_list',
    'session_search',
  ],
  execute: ['terminal', 'execute_code', 'process_manage', 'delegate_task', 'cronjob_manage', 'shell', 'bash'],
  write: ['write_file', 'patch', 'skill_manage', 'str_replace_editor', 'edit'],
  send: [],
};

const FIELDS = ['trusted_read', 'execute', 'write', 'send'];
const SEND_SHAPE = /send|mail|post|publish/i;
const ALIASES = {
  Bash: 'terminal',
  Shell: 'terminal',
  execute_command: 'terminal',
  run_shell_command: 'terminal',
  Read: 'read_file',
  Grep: 'search_files',
  Glob: 'search_files',
  WebFetch: 'web_extract',
  WebSearch: 'web_search',
  Write: 'write_file',
  Edit: 'patch',
  MultiEdit: 'patch',
  NotebookEdit: 'write_file',
  apply_patch: 'patch',
  write_to_file: 'write_file',
  replace_in_file: 'patch',
  replace: 'patch',
  Delete: 'write_file',
  Task: 'delegate_task',
  Agent: 'delegate_task',
  spawn_agent: 'delegate_task',
  web_fetch: 'web_extract',
  google_web_search: 'web_search',
  browser_action: 'web_search',
  update_plan: 'read_file',
  view_image: 'read_file',
};

export function validateTools(tools) {
  const fail = (message) => {
    throw new Error(`tools.json is invalid: ${message}`);
  };
  if (tools === null || typeof tools !== 'object') fail('not an object');
  if (tools.version !== 1) fail('version must be 1');
  for (const field of FIELDS) {
    if (!Array.isArray(tools[field])) fail(`${field} must be a list`);
    if (tools[field].some((name) => typeof name !== 'string' || name === '')) {
      fail(`${field} must hold non-empty tool names`);
    }
  }
  return tools;
}

export function loadTools(dir) {
  const file = join(dir, 'tools.json');
  if (!existsSync(file)) return DEFAULT_TOOLS;
  return validateTools(JSON.parse(readFileSync(file, 'utf8')));
}

export function classifyTool(toolName, tools = DEFAULT_TOOLS) {
  const raw = String(toolName ?? '').trim();
  const name = ALIASES[raw] ?? raw;
  if (tools.execute.includes(name)) return { action: 'shell.execute', capability: 'execute', trust: 'internal' };
  if (tools.write.includes(name)) return { action: 'file.write', capability: 'write', trust: 'internal' };
  if (tools.send.includes(name)) return { action: 'message.send', capability: 'send', trust: 'internal' };
  if (tools.trusted_read.includes(name)) return { action: 'tool.call', capability: 'read', trust: 'internal' };
  if (SEND_SHAPE.test(name)) return { action: 'message.send', capability: 'send', trust: 'untrusted' };
  return { action: 'web.read', capability: 'read', trust: 'untrusted' };
}
