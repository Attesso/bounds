#!/usr/bin/env node
// Control-only MCP server. Keep this separate from attesso-mcp, which is a
// proxy and must not gain a second job.
import { homedir } from 'node:os';
import { createControl, createServer } from '../src/mcp/control.mjs';

const argv = process.argv.slice(2);
const dirAt = argv.indexOf('--dir');
const dir = dirAt === -1 ? '.attesso' : argv[dirAt + 1];
const homeAt = argv.indexOf('--home');
const home = homeAt === -1 ? homedir() : argv[homeAt + 1];
const control = createControl({ dir, home });
createServer({ control });
