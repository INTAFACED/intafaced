#!/usr/bin/env node
/**
 * Local preview of the trade operator desk.
 *
 *   node tooling/preview/trade-ops/run.mjs            serve the built apps/admin on :3216 (build first: pnpm --filter @intafaced/admin build)
 *
 * :3216 is the console (proxy to a private `next start`). The console's EDGE_URL points at the TEST edge in
 * ./base.mjs and ./fixtures/*.mjs, which passes market data through to the real local stack on :3210.
 * Sign in with any email and password, code 123456. Everything marked TEST is a fixture.
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { baseRoutes, createState } from './base.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const PORT = Number(process.env.TROPS_PORT ?? 3216);
const adminDir = join(repo, 'apps/admin');

const freePort = () =>
  new Promise((done) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const BANNER = `<script>(()=>{const show=()=>{if(document.getElementById('trops-label'))return;const l=document.createElement('div');l.id='trops-label';l.setAttribute('role','note');l.textContent='Local preview · operator sign-in, orders, kill switch and approvals are TEST data · market list is the real local stack';l.style.cssText='position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:600 10px/1 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#C8F64A;background:rgba(12,14,13,.88);border:1px solid rgba(200,246,74,.35);padding:5px 10px;border-radius:999px;white-space:nowrap';document.body.appendChild(l)};const later=()=>setTimeout(show,800);document.readyState==='complete'?later():addEventListener('load',later)})();</script>`;

async function main() {
  const state = await createState();
  const routes = [...baseRoutes(state)];
  for (const file of readdirSync(join(import.meta.dirname, 'fixtures'))
    .filter((f) => f.endsWith('.mjs'))
    .sort()) {
    const mod = await import(pathToFileURL(join(import.meta.dirname, 'fixtures', file)).href);
    routes.push(...mod.default(state));
  }
  const edge = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://edge');
    const route = routes.find(
      (r) => r.method === req.method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)),
    );
    const send = (status, body) =>
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    if (!route) return send(404, { code: 'not_found', message: `no route ${req.method} ${url.pathname}` });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await route.handle({ url, query: url.searchParams, body, headers: req.headers });
      return send(out.status, out.body);
    } catch (error) {
      console.error('TEST edge defect', error);
      return send(500, { code: 'test_edge_defect', message: String(error?.message ?? error) });
    }
  });
  const edgePort = await freePort();
  await new Promise((done) => edge.listen(edgePort, '127.0.0.1', done));

  const nextPort = await freePort();
  const next = spawn(
    process.execPath,
    [join(adminDir, 'node_modules/next/dist/bin/next'), 'start', '--port', String(nextPort), '--hostname', '127.0.0.1'],
    {
      cwd: adminDir,
      env: {
        ...process.env,
        ADMIN_ORIGIN: `http://localhost:${PORT}`,
        EDGE_URL: `http://127.0.0.1:${edgePort}`,
        ADMIN_SESSION_SECRET: randomBytes(32).toString('base64url'),
        APP_ENV: 'dev',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  const front = createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    const up = httpRequest({ host: '127.0.0.1', port: nextPort, method: req.method, path: req.url, headers }, (r) => {
      if (!String(r.headers['content-type'] ?? '').startsWith('text/html')) {
        res.writeHead(r.statusCode, r.headers);
        return r.pipe(res);
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const out = { ...r.headers };
        delete out['content-length'];
        delete out['transfer-encoding'];
        const html = Buffer.concat(chunks).toString('utf8');
        // The console's CSP only runs scripts that carry its per-response nonce, so the label takes the same nonce.
        const nonce = /'nonce-([^']+)'/.exec(String(r.headers['content-security-policy'] ?? ''))?.[1];
        const banner = nonce ? BANNER.replace('<script>', `<script nonce="${nonce}">`) : BANNER;
        res.writeHead(r.statusCode, out).end(html.includes('</body>') ? html.replace('</body>', `${banner}</body>`) : html + banner);
      });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The console is still starting. Reload in a few seconds.');
    });
    req.pipe(up);
  });
  await new Promise((done, fail) => front.once('error', fail).listen(PORT, '127.0.0.1', done));
  const stop = () => {
    next.kill('SIGTERM');
    front.close();
    edge.close();
    setTimeout(() => process.exit(0), 400).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for (let i = 0; i < 400; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${nextPort}/login`, { headers: { host: `localhost:${PORT}` } }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await sleep(300);
  }
  console.log(
    `TROPS preview ready: http://localhost:${PORT}/trade-ops  (sign in: any email + password, code 123456)\nTEST edge on :${edgePort}; real market data from :3210.`,
  );
}
await main();
