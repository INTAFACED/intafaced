#!/usr/bin/env node
/**
 * One-command local click-through of the investor questionnaire and the founder CRM.
 *
 *   pnpm preview:outreach            build what is missing or stale, then serve
 *   pnpm preview:outreach --rebuild  force a fresh build (after local source edits)
 *
 * Questionnaire: http://localhost:4400/invest   Founder CRM: http://localhost:4401/crm
 * Both read and write one in-memory test store (./fixture.mjs). Nothing is saved,
 * emailed or deployed, and every page carries a "test data, not live" label.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createOutreachFixture, seedTestEnquiries, FixtureError } from './fixture.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const rebuild = process.argv.includes('--rebuild');
// Opt-in: also serve the questionnaire to phones on the same Wi-Fi. The founder console stays
// on localhost because it refuses plain-HTTP origins other than localhost by design.
const lan = process.argv.includes('--lan');
const PUBLIC_PORT = Number(process.env.PREVIEW_PUBLIC_PORT ?? 4400);
const ADMIN_PORT = Number(process.env.PREVIEW_ADMIN_PORT ?? 4401);
const invitationDist = join(repo, 'apps/invitation/dist');
const adminDir = join(repo, 'apps/admin');

// The privacy contact and retention notice Nitro approved on 2026-10-11; the real join build sets the same values.
const PUBLIC_NOTICE = {
  OUTREACH_CONTACT_URL: 'mailto:privacy@intafaced.com',
  OUTREACH_RETENTION_NOTICE:
    'Inactive enquiries become due for deletion six calendar months after our last meaningful contact. We review ongoing discussions separately. Outreach backups expire within 30 days, and deletion records are applied before restored contacts become available.',
};

// The questionnaire has its sticky action at the bottom; the console has its header at the top.
// The label is added a second after load so it never races React hydration of the console.
const LABEL = (edge) =>
  `<script>(()=>{const show=()=>{if(document.getElementById('intafaced-preview-label'))return;const l=document.createElement('div');l.id='intafaced-preview-label';l.setAttribute('role','note');l.textContent='Local preview · test data · not live';l.style.cssText='position:fixed;${edge}:8px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:600 10px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#C8F64A;background:rgba(12,14,13,.82);border:1px solid rgba(200,246,74,.35);padding:5px 10px;border-radius:999px;white-space:nowrap';document.body.appendChild(l);if('${edge}'==='bottom')document.body.style.paddingBottom='40px';};const later=()=>setTimeout(show,1000);document.readyState==='complete'?later():addEventListener('load',later);})();</script>`;
const label = (html, edge) => (html.includes('</body>') ? html.replace('</body>', `${LABEL(edge)}</body>`) : html + LABEL(edge));

function pnpm(args, env = {}) {
  // Reuse the pnpm that launched us: a JS entry runs under this node, a standalone binary runs directly.
  const viaPnpm = process.env.npm_execpath;
  const [command, prefix] = !viaPnpm ? ['pnpm', []] : /\.[cm]?js$/.test(viaPnpm) ? [process.execPath, [viaPnpm]] : [viaPnpm, []];
  const result = spawnSync(command, [...prefix, ...args], { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env } });
  return result.status === 0;
}

/** The last commit that touched anything the three builds read, so tooling-only commits skip a rebuild. */
function head() {
  try {
    const inputs = ['apps/invitation', 'apps/admin', 'packages', 'vendor/upstream-exchange/05_Web_Front/src', 'pnpm-lock.yaml'];
    return execFileSync('git', ['log', '-1', '--format=%H', '--', ...inputs], { cwd: repo, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureBuilt() {
  const commit = head();
  const stamps = {
    contracts: join(repo, 'packages/contracts/dist/.preview-stamp'),
    invitation: join(invitationDist, '.preview-stamp'),
    admin: join(adminDir, '.next/.preview-stamp'),
  };
  const fresh = (file) => !rebuild && existsSync(file) && readFileSync(file, 'utf8') === commit;
  if (!existsSync(join(repo, 'node_modules'))) fail('Dependencies are missing. Run `pnpm install` in this checkout first.');
  if (!fresh(stamps.contracts) || !fresh(stamps.admin)) {
    console.log('Building shared packages…');
    if (!pnpm(['--filter', '@intafaced/admin^...', '--filter', '@intafaced/contracts', 'run', 'build']))
      fail('Shared package build failed.');
    writeFileSync(stamps.contracts, commit);
  }
  if (!fresh(stamps.invitation)) {
    console.log('Building the questionnaire…');
    if (!pnpm(['--filter', '@intafaced/invitation', 'run', 'build'], PUBLIC_NOTICE)) fail('Questionnaire build failed.');
    writeFileSync(stamps.invitation, commit);
  }
  if (!fresh(stamps.admin)) {
    console.log('Building the founder console…');
    // next/font fetches Inter from Google Fonts at build time and that fetch is occasionally flaky.
    let built = false;
    for (let attempt = 1; attempt <= 3 && !built; attempt += 1)
      built = pnpm(['--filter', '@intafaced/admin', 'run', 'build'], { NEXT_TELEMETRY_DISABLED: '1' });
    if (!built) fail('Founder console build failed three times (often the Google Fonts download). Check the network and retry.');
    writeFileSync(stamps.admin, commit);
  }
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function freePort() {
  return new Promise((done, reject) => {
    const probe = netServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/** Listen on IPv4 and IPv6 loopback so http://localhost works in every browser. */
async function listenLocal(handler, port, everywhere = false) {
  const servers = [];
  for (const host of [everywhere ? '0.0.0.0' : '127.0.0.1', '::1']) {
    const server = createServer(handler);
    await new Promise((done, reject) => {
      server.once('error', (error) => (host === '::1' && error.code === 'EADDRNOTAVAIL' ? done() : reject(error)));
      server.listen(port, host, done);
    });
    servers.push(server);
  }
  return servers;
}

async function readJson(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1_000_000) throw new FixtureError('ops.crm.invalid_input');
  }
  return text ? JSON.parse(text) : {};
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function failure(error) {
  if (error instanceof FixtureError) return { status: error.status, code: error.code };
  // The founder identity stand-ins throw their own error classes with the same { code, status } shape.
  if (typeof error?.code === 'string' && /^auth\.[a-z_]+$/.test(error.code) && Number.isInteger(error?.status)) {
    return { status: error.status, code: error.code };
  }
  if (error?.name === 'ZodError' || error instanceof SyntaxError) return { status: 400, code: 'ops.crm.invalid_input' };
  console.error('Preview fixture defect:', error);
  return { status: 500, code: 'ops.crm.storage_unavailable' };
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

function questionnaireServer(fixture) {
  return async (request, response) => {
    const path = new URL(request.url, 'http://preview').pathname;
    const call = /^\/api\/ops\/trpc\/outreach\.(capture|resume|answer|addInterests)$/.exec(path);
    if (call) {
      if (request.method !== 'POST') return reply(response, 405, { error: { message: 'ops.crm.invalid_input' } });
      try {
        return reply(response, 200, { result: { data: fixture.publicApi[call[1]](await readJson(request)) } });
      } catch (error) {
        const { status, code } = failure(error);
        // The public client reads the bare error message, as served by the edge.
        return reply(response, status === 500 ? 503 : 400, { error: { message: code } });
      }
    }
    if (path.startsWith('/api/')) return reply(response, 404, { error: { message: 'not_found' } });
    const asset = path.startsWith('/assets/') || ['/component-licenses.txt', '/font-OFL.txt'].includes(path);
    const file = asset ? resolve(invitationDist, `.${path}`) : join(invitationDist, 'index.html');
    if (!file.startsWith(`${invitationDist}/`)) return response.writeHead(404).end();
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store' });
      response.end(type === 'text/html' ? label(body.toString('utf8'), 'top') : body);
    } catch {
      response.writeHead(404).end();
    }
  };
}

function edgeServer(fixture) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://edge');
    const procedure = /^\/api\/(?:identity|ops)\/trpc\/(.+)$/.exec(url.pathname)?.[1];
    const handler = procedure && fixture.founderApi[procedure];
    if (!handler) return reply(response, 404, { error: { message: 'not available in the local preview', data: { path: url.pathname } } });
    try {
      const input = request.method === 'POST' ? await readJson(request) : JSON.parse(url.searchParams.get('input') ?? '{}');
      return reply(response, 200, { result: { data: { json: handler(input) } } });
    } catch (error) {
      const { status, code } = failure(error);
      // intafacedCode is where the real services put their typed code, and where the console reads it.
      return reply(response, status, { error: { message: code, code: 'BAD_REQUEST', data: { httpStatus: status, intafacedCode: code } } });
    }
  };
}

/** Forwards the founder console unchanged except for the preview label on HTML pages. */
function consoleProxy(nextPort) {
  return (request, response) => {
    const headers = { ...request.headers };
    delete headers['accept-encoding'];
    const upstream = httpRequest({ host: '127.0.0.1', port: nextPort, method: request.method, path: request.url, headers }, (reply) => {
      const html = String(reply.headers['content-type'] ?? '').startsWith('text/html');
      if (!html) {
        response.writeHead(reply.statusCode, reply.headers);
        return reply.pipe(response);
      }
      const chunks = [];
      reply.on('data', (chunk) => chunks.push(chunk));
      reply.on('end', () => {
        const outgoing = { ...reply.headers };
        delete outgoing['content-length'];
        delete outgoing['transfer-encoding'];
        response.writeHead(reply.statusCode, outgoing).end(label(Buffer.concat(chunks).toString('utf8'), 'bottom'));
      });
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('The founder console is still starting. Reload in a few seconds.');
    });
    request.pipe(upstream);
  };
}

function phoneLines() {
  if (!lan) return '';
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === 'IPv4' && !address.internal)
    .map((address) => `\n  On your phone   http://${address.address}:${PUBLIC_PORT}/invest  (same Wi-Fi or VPN)`);
  return addresses.join('') || '\n  On your phone   no Wi-Fi address found';
}

async function main() {
  ensureBuilt();
  const contracts = await import(pathToFileURL(join(repo, 'packages/contracts/dist/index.js')).href);
  const fixture = createOutreachFixture(contracts);
  seedTestEnquiries(fixture);

  const servers = [...(await listenLocal(questionnaireServer(fixture), PUBLIC_PORT, lan))];
  const edgePort = await freePort();
  const edge = createServer(edgeServer(fixture));
  await new Promise((done) => edge.listen(edgePort, '127.0.0.1', done));
  servers.push(edge);

  const nextPort = await freePort();
  // Claim the console port before starting Next, so a busy port never leaves Next running alone.
  servers.push(...(await listenLocal(consoleProxy(nextPort), ADMIN_PORT)));
  const adminOrigin = `http://localhost:${ADMIN_PORT}`;
  const next = spawn(
    process.execPath,
    [join(adminDir, 'node_modules/next/dist/bin/next'), 'start', '--port', String(nextPort), '--hostname', '127.0.0.1'],
    {
      cwd: adminDir,
      env: {
        ...process.env,
        ADMIN_ORIGIN: adminOrigin,
        EDGE_URL: `http://127.0.0.1:${edgePort}`,
        // Local-only session key, regenerated each run; never a deployment secret.
        ADMIN_SESSION_SECRET: (await import('node:crypto')).randomBytes(32).toString('base64url'),
        APP_ENV: 'dev',
        // Launch scope: the founder CRM only; the exchange modules answer 404.
        ADMIN_MODULES: 'crm',
        // Shows the one-time founder sign-up page with the TEST invites. Off unless set to exactly 'open'.
        ADMIN_FOUNDER_ENROLMENT: 'open',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
    next.kill('SIGTERM');
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  next.once('exit', (code) => {
    if (!stopping && code !== null && code !== 0) fail(`The founder console stopped (exit ${code}).`);
  });

  let ready = false;
  // Up to two minutes: Next starts slowly when the Mac is busy with other builds.
  for (let i = 0; i < 400 && !ready; i += 1) {
    ready = await fetch(`http://127.0.0.1:${nextPort}/login`, { headers: { host: `localhost:${ADMIN_PORT}` } }).then(
      (r) => r.ok,
      () => false,
    );
    if (!ready) await sleep(300);
  }
  if (!ready) {
    next.kill('SIGTERM');
    fail('The founder console did not start within two minutes.');
  }
  console.log(`
INTAFACED local preview — test data, not live. Nothing is saved, emailed or deployed.

  Questionnaire   http://localhost:${PUBLIC_PORT}/invest${phoneLines()}
  Founder CRM     http://localhost:${ADMIN_PORT}/crm
                  sign in with any email and password, code 123456
  Founder sign-up http://localhost:${ADMIN_PORT}/enroll   invite TEST-INVITE-NITRO, code 123456
  Security        http://localhost:${ADMIN_PORT}/security (after signing in)
  Forgot password http://localhost:${ADMIN_PORT}/reset    code 123456 + recovery code FACED-00001

An enquiry sent from the questionnaire appears in the CRM. Restarting resets everything.
Press Ctrl+C to stop.
`);
}

await main();
