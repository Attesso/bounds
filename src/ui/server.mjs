// Local Bounds control surface. One loopback process, one per-run token, one
// ledger. The page is static; all state comes from the same core functions the
// CLI uses. No hosted code and no second policy implementation.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { connect as connectAgent, setModeAll, status as agentStatus } from '../connect.mjs';
import { validatePathsConfig } from '../fs-paths.mjs';
import { clearWorkspace, resolveWorkspace, workspaceView, writeWorkspace } from '../workspace.mjs';
import { isInitialised, paths, readActiveRun, readDetail, readEntries, readKey, readLastRun, readRunBudget } from '../store.mjs';
import { sync } from '../sync.mjs';
import { lastRunFrom } from '../run.mjs';
import { verifyDetail } from '../detail.mjs';
import { verifyEntry } from '../ledger.mjs';
import { Catalog, dayFor, validateTimeZone } from './catalog.mjs';
import { isMetaAction, usageForDay } from '../usage.mjs';
import { days as queryDays, exportCsv as queryExportCsv, flow as queryFlow, page as queryPage, parseCursor, parseDay, parseLimit, rowFor as queryRow, summary as querySummary } from './query.mjs';
import { LedgerTail } from './live.mjs';

const UI_ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = join(UI_ROOT, 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY = 512_000;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const localDay = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  const temp = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
};

function send(req, res, status, type, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS };
  if (buffer.length > 1024 && String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
    const compressed = gzipSync(buffer, { level: 6 });
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
    res.writeHead(status, headers);
    return res.end(compressed);
  }
  res.writeHead(status, headers);
  res.end(buffer);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(`${JSON.stringify(body)}\n`);
}

function queryInt(url, name, min, max) {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

function queryString(url, name, max = 200) {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return undefined;
  if (value.length > max) throw new Error(`${name} is too long`);
  return value;
}

function callFilters(url) {
  return {
    minute: queryInt(url, 'minute', 0, 1435),
    hour: queryInt(url, 'hour', 0, 23),
    tool: queryString(url, 'tool', 160),
    capability: queryString(url, 'capability', 32),
    decision: queryString(url, 'decision', 16),
    search: queryString(url, 'search', 200)?.toLowerCase(),
  };
}

function body(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function readPaths(dir) {
  const value = readJson(paths(dir).fsPaths, null);
  if (value === null) return { version: 1, allowed_roots: [], exclusions: [] };
  return validatePathsConfig(value);
}

function staticFile(name) {
  const file = resolve(STATIC_ROOT, normalize(name));
  if (!file.startsWith(STATIC_ROOT + sep)) return null;
  if (!['index.html', 'app.js', 'app.css'].includes(name.split('/').pop())) return null;
  if (!existsSync(file)) return null;
  return { file, type: MIME[extname(file)] ?? 'application/octet-stream' };
}

export function startUi({
  dir = '.attesso',
  cwd = process.cwd(),
  home = homedir(),
  port = 0,
  open = true,
} = {}) {
  const ledger = resolve(dir);
  const catalog = new Catalog(ledger);
  const token = randomBytes(24).toString('hex');
  const clients = new Set();
  const tail = new LedgerTail(paths(ledger).ledger);
  let tailTimer = null;

  const authorized = (req) => {
    const value = String(req.headers['x-bounds-token'] ?? '');
    if (value.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };
  const sameOrigin = (req, address) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    const allowed = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
    return allowed.includes(origin);
  };

  const broadcast = (entry) => {
    const day = localDay(new Date(entry.at));
    const message = `id: ${entry.seq}\nevent: decision\ndata: ${JSON.stringify({ day, row: queryRow(entry, TZ), seq: entry.seq })}\n\n`;
    for (const client of clients) {
      try {
        if (client.res.writableLength > 1_000_000) {
          client.res.end();
          clients.delete(client);
          continue;
        }
        client.res.write(message);
      } catch {
        clients.delete(client);
      }
    }
  };

  const poll = () => {
    if (clients.size === 0) return;
    try {
      tail.read((line) => {
        try {
          const entry = JSON.parse(line);
          if (entry?.seq && !isMetaAction(entry)) broadcast(entry);
        } catch {
          // A malformed complete line is a ledger error; do not invent an event.
        }
      });
    } catch {
      // The ledger can be replaced while the UI is open. The next poll reopens it.
    }
  };

  const server = createServer(async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'loopback only' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const address = server.address();
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const page = readFileSync(join(STATIC_ROOT, 'index.html'), 'utf8').replace('__BOUNDS_TOKEN__', token);
        return send(req, res, 200, MIME['.html'], page);
      }
      if (!url.pathname.startsWith('/api/')) {
        const file = staticFile(url.pathname.slice(1));
        if (!file) return json(res, 404, { error: 'not found' });
        return send(req, res, 200, file.type, readFileSync(file.file));
      }
      if (!authorized(req)) return json(res, 401, { error: 'missing bounds token' });
      if (!sameOrigin(req, address)) return json(res, 403, { error: 'origin refused' });

      if (url.pathname === '/api/status' && req.method === 'GET') {
        let pathsValue;
        try { pathsValue = readPaths(ledger); } catch (error) { pathsValue = null; }
        let budgetValue;
        try { budgetValue = readRunBudget(ledger); } catch (error) { budgetValue = { error: 'rules unreadable' }; }
        let runValue;
        try { runValue = readActiveRun(ledger); } catch (error) { runValue = { error: 'run unreadable' }; }
        let lastValue;
        try { lastValue = readLastRun(ledger) ?? lastRunFrom(readEntries(ledger)); } catch (error) { lastValue = { error: 'runs unreadable' }; }
        return json(res, 200, { ...agentStatus({ dir: ledger, cwd, home }), paths: pathsValue, budget: budgetValue, run: runValue, last: lastValue });
      }
      if (url.pathname === '/api/v1/detail' && req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method not allowed' });
      }
      if (url.pathname.startsWith('/api/v1/') && req.method === 'GET') {
        try {
          const timeZone = validateTimeZone(url.searchParams.get('tz') ?? undefined);
          if (url.pathname === '/api/v1/detail') {
            const rawSeq = url.searchParams.get('seq') ?? '';
            if (!/^[1-9][0-9]*$/.test(rawSeq)) return json(res, 400, { error: 'seq must be a positive integer' });
            const seq = Number(rawSeq);
            let entry;
            catalog.scanAfter(seq - 1, (item) => {
              if (item.seq !== seq) return;
              entry = item;
              return false;
            });
            if (!entry) return json(res, 404, { error: 'no such decision' });
            if (!verifyEntry(entry, readKey(ledger).public)) {
              return json(res, 200, { seq, state: 'changed', reason: 'entry signature does not verify' });
            }
            if (entry.meta?.detail === 'unavailable') return json(res, 200, { seq, state: 'unavailable' });
            if (typeof entry.detail_hash !== 'string') return json(res, 200, { seq, state: 'none' });
            let detail;
            try {
              detail = readDetail(ledger, seq);
            } catch {
              return json(res, 200, { seq, state: 'changed', reason: 'preview is unreadable' });
            }
            if (!detail) return json(res, 200, { seq, state: 'missing' });
            const checked = verifyDetail(entry, detail);
            if (!checked.ok) return json(res, 200, { seq, state: 'changed', reason: checked.reason });
            return json(res, 200, { seq, state: 'verified', detail });
          }
          if (url.pathname === '/api/v1/call') {
            const rawSeq = url.searchParams.get('seq') ?? '';
            if (!/^[1-9][0-9]*$/.test(rawSeq)) return json(res, 400, { error: 'seq must be a positive integer' });
            const seq = Number(rawSeq);
            let entry;
            catalog.scanAfter(seq - 1, (item) => {
              if (item.seq !== seq) return;
              entry = item;
              return false;
            });
            if (!entry || isMetaAction(entry)) return json(res, 404, { error: 'no such decision' });
            return json(res, 200, { row: queryRow(entry, timeZone), day: dayFor(entry.at, timeZone) });
          }
          if (url.pathname === '/api/v1/summary') {
            return json(res, 200, querySummary(catalog, { day: parseDay(url.searchParams.get('day'), timeZone), timeZone }));
          }
          if (url.pathname === '/api/v1/flow') {
            return json(res, 200, queryFlow(catalog, {
              day: parseDay(url.searchParams.get('day'), timeZone),
              timeZone,
              bucket: parseLimit(url.searchParams.get('bucket'), { fallback: 5, max: 60 }),
            }));
          }
          if (url.pathname === '/api/v1/usage') {
            return json(res, 200, usageForDay(catalog, {
              day: parseDay(url.searchParams.get('day'), timeZone),
              timeZone,
            }));
          }
          if (url.pathname === '/api/v1/days') {
            return json(res, 200, { days: queryDays(catalog, {
              timeZone,
              limit: parseLimit(url.searchParams.get('limit'), { fallback: 14, max: 90 }),
            }) });
          }
          if (url.pathname === '/api/v1/calls') {
            const cursor = parseCursor(url.searchParams.get('cursor'), timeZone);
            const day = url.searchParams.get('day') ? parseDay(url.searchParams.get('day'), timeZone) : null;
            return json(res, 200, queryPage(catalog, {
              day,
              timeZone,
              after: cursor.seq,
              limit: parseLimit(url.searchParams.get('limit'), { fallback: 100, max: 200 }),
              filters: callFilters(url),
            }));
          }
          if (url.pathname === '/api/v1/calls/export') {
            const day = url.searchParams.get('day') ? parseDay(url.searchParams.get('day'), timeZone) : null;
            return send(req, res, 200, 'text/csv; charset=utf-8', queryExportCsv(catalog, {
              day,
              timeZone,
              filters: callFilters(url),
            }));
          }
          return json(res, 404, { error: 'unknown api' });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
        if (isInitialised(ledger) && after > 0) {
          try {
            catalog.scanAfter(after, (entry) => {
              if (isMetaAction(entry)) return;
              const day = localDay(new Date(entry.at));
              res.write(`id: ${entry.seq}\nevent: decision\ndata: ${JSON.stringify({ day, row: queryRow(entry, TZ), seq: entry.seq })}\n\n`);
            });
          } catch {
            res.write('event: reset\ndata: {}\n\n');
          }
        }
        const client = { res };
        clients.add(client);
        req.on('close', () => clients.delete(client));
        return;
      }
      if (url.pathname === '/api/mode' && req.method === 'POST') {
        try {
          const { mode } = await body(req);
          setModeAll(ledger, mode, { home });
          return json(res, 200, { ok: true, mode, status: agentStatus({ dir: ledger, cwd, home }) });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/paths' && req.method === 'GET') {
        try { return json(res, 200, readPaths(ledger)); } catch (error) { return json(res, 500, { error: error.message }); }
      }
      if (url.pathname === '/api/paths' && req.method === 'POST') {
        try {
          const next = validatePathsConfig(await body(req));
          writeJson(paths(ledger).fsPaths, next);
          return json(res, 200, { ok: true, paths: next });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/workspace' && req.method === 'GET') {
        try { return json(res, 200, workspaceView({ home })); } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/workspace' && req.method === 'POST') {
        try {
          const input = await body(req);
          writeWorkspace({
            home,
            syncUrl: input.sync_url,
            apiKey: input.api_key,
            workspace: input.workspace,
          });
          return json(res, 200, { ok: true, ...workspaceView({ home }) });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/workspace' && req.method === 'DELETE') {
        try {
          const removed = clearWorkspace({ home });
          return json(res, 200, { ok: true, removed, ...workspaceView({ home }) });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        try {
          const credentials = resolveWorkspace({ home });
          const result = await sync({ dir: ledger, url: credentials.url, key: credentials.key, limit: 50 });
          return json(res, 200, result);
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === '/api/connect' && req.method === 'POST') {
        try {
          const { mode = 'observe' } = await body(req);
          const result = connectAgent({ dir: ledger, cwd, home, write: true, mode, cli: process.argv[1] });
          if (tail.fd === null && isInitialised(ledger)) {
            tail.open();
            if (!tailTimer) tailTimer = setInterval(poll, 400);
          }
          let pathsValue;
          try { pathsValue = readPaths(ledger); } catch { pathsValue = null; }
          return json(res, 200, { ok: true, result, status: { ...agentStatus({ dir: ledger, cwd, home }), paths: pathsValue } });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      return json(res, 404, { error: 'unknown api' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try { client.res.write(': heartbeat\n\n'); } catch { clients.delete(client); }
    }
  }, 15_000);

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', rejectStart);
      const address = server.address();
      if (isInitialised(ledger)) {
        try {
          tail.open();
          tailTimer = setInterval(poll, 400);
        } catch {
          // A headless machine can still use the URL printed by the CLI.
        }
      }
      const url = `http://127.0.0.1:${address.port}/`;
      if (open) {
        try {
          const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
          const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
          const child = spawn(command, args, { detached: true, stdio: 'ignore' });
          child.on('error', () => {});
          child.unref();
        } catch {
          // A headless machine can still use the URL printed by the CLI.
        }
      }
      resolveStart({
        token,
        port: address.port,
        url,
        server,
        close: () => new Promise((resolveClose) => {
          clearInterval(heartbeat);
          if (tailTimer) clearInterval(tailTimer);
          for (const client of clients) client.res.end();
          clients.clear();
          tail.close();
          server.close(resolveClose);
        }),
      });
    });
  });
}
