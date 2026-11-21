import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, SCOPES } from '@intafaced/auth';
import { currentAuthorityTestReply } from './test-current-authority.js';
import { UPSTREAMS } from './routes.js';

/**
 * The wire replay for svc-edge: what the front door answers today, recorded before anyone moves its routes.
 *
 * `wire-replay.golden/` holds what the shipped entrypoint (`index.ts`, booted as a process, unchanged) answered on
 * main 2026-11-19, bugs included, to a matrix of requests: every route the process mounts (read from Fastify itself as
 * it boots), plus a set of `/api/*` paths across every upstream prefix, each with its inputs and five callers. Every
 * upstream, identity included, is one loopback stand-in: identity's `currentAuthority` vouches for the signed-in caller,
 * and every other path answers 200 with what reached it (method, path, query, the edge's headers by name). So the
 * recording pins the door: which routes exist, who is refused with which status and code, which paths are forwarded,
 * to what path, and with which headers. Owner settings are blank (no route costs, no sandbox hosts, no matching, no
 * adapters), as on a stack nobody configured.
 *
 * Values that change on every request (request ids, clock times, durations) are replaced by a fixed word before compare.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');
const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
const JWT_SECRET = 'an-edge-wire-replay-jwt-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://app.example.test';

/** Subscribes to Fastify's own start-up channel inside the edge process and writes each route it mounts, one JSON line. */
const ROUTE_TAP = `data:text/javascript,${encodeURIComponent(`
import diagnostics from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
diagnostics.channel('fastify.initialization').subscribe(({ fastify }) => {
  fastify.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) appendFileSync(process.env.WIRE_REPLAY_ROUTES, JSON.stringify({ method, url: r.url }) + '\\n');
  });
});
`)}`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Identity vouches for the signed-in caller; every other path answers with what reached it. */
function standIn(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      void (async () => {
        const authority = currentAuthorityTestReply(
          `http://stand-in${url}`,
          { body: body.toString() },
          {
            expectedUserId: USER,
            expectedCredentialId: SESSION,
            currentTier: 'full',
          },
        );
        if (authority) {
          res.writeHead(authority.status, { 'content-type': 'application/json' });
          res.end(await authority.text());
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            reached: { method: req.method, url },
            headers: Object.keys(req.headers)
              .filter((h) => h.startsWith('x-') || h === 'authorization' || h === 'cookie' || h === 'content-type')
              .sort(),
            bodyBytes: body.length,
          }),
        );
      })();
    });
  });
}

/** Resolves on the edge's own "listening" log line; rejects if the process exits first. */
function waitForListening(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString();
      if (/listening/i.test(output)) resolve();
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => reject(new Error(`svc-edge exited with ${code} before listening:\n${output}`)));
  });
}

async function boot(routesFile: string, upstreamBase: string) {
  const port = await freePort();
  const urls = Object.fromEntries(UPSTREAMS.map((u) => [u.envVar, upstreamBase]));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', ROUTE_TAP, ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: {
      PATH: process.env.PATH,
      VITEST: 'true',
      APP_ENV: 'test',
      NODE_ENV: 'test',
      SERVICE_NAME: 'svc-edge',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(port),
      LOG_LEVEL: 'info',
      OTEL_ENABLED: 'false',
      JWT_ACCESS_SECRET: JWT_SECRET,
      EDGE_PRINCIPAL_SECRET: 'an-edge-wire-replay-principal-secret-long-enough',
      IDENTITY_OWNERSHIP_SECRET: 'an-edge-wire-replay-identity-read-secret-long',
      EDGE_RATE_LIMIT_MAX: '1000000',
      EDGE_RATE_LIMIT_WINDOW_MS: '60000',
      EDGE_BODY_LIMIT_BYTES: '1048576',
      INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
      EDGE_ALLOWED_ORIGINS: ORIGIN,
      EDGE_KILL_STATE_PATH: '',
      EDGE_COMPLIANCE_QUEUE_PATH: join(dirname(routesFile), 'compliance.json'),
      EDGE_RECONCILE_LAST_PATH: join(dirname(routesFile), 'reconcile.json'),
      WIRE_REPLAY_ROUTES: routesFile,
      ...urls,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForListening(child);
  return { child, base: `http://127.0.0.1:${port}` };
}

type Caller = { readonly name: string; readonly headers: () => Promise<Record<string, string>> };

const bearer = async (scopes: readonly string[], mfa: boolean) => {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: [...scopes] as never, tier: 'full', mfa },
    { secret: JWT_SECRET, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 },
  );
  return { authorization: `Bearer ${token}` };
};

/** Nobody; a token nobody signed; an unknown API key; a live session holding no scope; a live session holding every scope, with MFA. */
const CALLERS: readonly Caller[] = [
  { name: 'anon', headers: async () => ({}) },
  { name: 'bad-token', headers: async () => ({ authorization: 'Bearer not.a.token' }) },
  { name: 'api-key', headers: async () => ({ authorization: 'Bearer ifc_replayplaceholderkey' }) },
  { name: 'no-scope', headers: () => bearer([], false) },
  { name: 'all', headers: () => bearer(SCOPES, true) },
];

/** What a body-taking request sends: nothing, an empty object, a wrong type, and JSON that does not parse. */
const BODIES: ReadonlyArray<[string, string | undefined]> = [
  ['absent', undefined],
  ['empty', '{}'],
  ['wrong-type', '7'],
  ['malformed', '{'],
];

/** The `/api/*` paths tried: each upstream's plain, internal and tRPC path, and the paths the door must judge itself. */
function apiPaths(): string[] {
  const own = UPSTREAMS.flatMap((u) => [`${u.prefix}/health`, `${u.prefix}/internal/jobs`, `${u.prefix}/trpc/x.y?input=%7B%7D`]);
  return [
    ...own,
    '/api/unknown/x',
    '/api/bank/../ledger/post',
    '/api/bank/%2e%2e/x',
    '/api/bank//health',
    '/api/bank/test-partner/venue',
    '/api/pay/v1/payments',
    '/api/pay/checkout/x',
    '/api/v1/orders',
    '/api/identity/trpc/auth.refresh',
  ];
}

const COMMON = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

type Answer = { status: number; headers: Record<string, string>; body: string };

/** Reply headers that are part of the door's answer; the rest are transport or change with every request. */
const KEPT_HEADERS =
  /^(content-type|location|retry-after|www-authenticate|allow|access-control-.*|x-intafaced-.*|x-ratelimit-limit|cache-control|vary|set-cookie|content-security-policy|x-frame-options|x-content-type-options|strict-transport-security|referrer-policy|cross-origin-.*|idempotency-.*)$/;

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const FIXED_IDS = new Set([USER, SESSION, ID]);

/** Request ids, clock times and metric samples change on every call; the fixed ids this test sends stay as they are. */
function steady(text: string, path: string): string {
  let out = text.replace(ISO, '<time>').replace(UUID, (id) => (FIXED_IDS.has(id) ? id : '<uuid>'));
  // The scrape's samples count every request before it, so only the metrics it names (`# HELP`, `# TYPE`) are kept.
  if (path.startsWith('/metrics'))
    out = out
      .split('\n')
      .filter((l) => l.startsWith('# '))
      .join('\n');
  return out.replace(/"(serverReceived|serverSent|receivedAt|sentAt|uptimeSeconds|durationMs)":\s*[0-9.]+/g, '"$1":"<n>"');
}

/**
 * Any method Fastify mounts, TRACE and WebDAV included, so `node:http` rather than `fetch`. Each request gets its own
 * socket (`agent: false`): the server closes some connections after answering (a TRACE with a body), and a pooled
 * socket reused in that window fails with ECONNRESET under load. `connection` is not a recorded header.
 */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body: string | undefined) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers, agent: false }, (res) => {
      if (req.reusedSocket) reject(new Error(`${method} ${path} went out on a reused socket; every request needs its own`));
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function send(base: string, method: string, path: string, body: string | undefined, h: Record<string, string>, origin: boolean) {
  const headers: Record<string, string> = { ...h, ...(origin ? { origin: ORIGIN } : {}) };
  if (method === 'OPTIONS') headers['access-control-request-method'] = 'POST';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await raw(base, method, path, headers, body);
  const kept: Record<string, string> = {};
  for (const k of Object.keys(res.headers).sort()) if (KEPT_HEADERS.test(k)) kept[k] = steady([res.headers[k]].flat().join(', '), path);
  return { status: res.status, headers: kept, body: steady(res.body, path) } satisfies Answer;
}

interface Golden {
  /** Every route the process mounted, `METHOD url`, in the order it mounted them. */
  readonly routes: string[];
  /** Per request `METHOD path`, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

async function replay(): Promise<Golden> {
  const dir = mkdtempSync(join(tmpdir(), 'edge-wire-replay-'));
  const routesFile = join(dir, 'routes.jsonl');
  writeFileSync(routesFile, '');
  const upstream = standIn();
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { child, base } = await boot(routesFile, `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  try {
    const mounted = readFileSync(routesFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; url: string });
    const routes = mounted.map((r) => `${r.method} ${r.url}`);
    const requests: Array<{ method: string; path: string }> = [];
    for (const r of mounted) {
      if (r.method === 'HEAD') continue;
      if (r.url === '/api/*') {
        // The catch-all is mounted for every method: the common ones try every path, the rest one forwarded path.
        for (const path of COMMON.includes(r.method) ? apiPaths() : ['/api/bank/health']) requests.push({ method: r.method, path });
        continue;
      }
      requests.push({ method: r.method, path: r.url.replace(/:[A-Za-z]+/g, ID).replace(/\*$/, 'x') });
    }
    requests.push({ method: 'GET', path: '/not-a-route' });
    const callers = await Promise.all(CALLERS.map(async (c) => [c.name, await c.headers()] as const));
    const answers: Golden['answers'] = {};
    for (const { method, path } of requests.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))) {
      const key = `${method} ${path}`;
      if (answers[key]) continue;
      const row: Record<string, Answer> = {};
      const bodies = method === 'GET' || method === 'DELETE' || method === 'OPTIONS' ? BODIES.slice(0, 1) : BODIES;
      for (const [inputName, body] of bodies)
        for (const [callerName, h] of method === 'OPTIONS' ? callers.slice(0, 1) : callers)
          row[`${inputName} ${callerName}`] = await send(base, method, path, body, h, method === 'OPTIONS' || callerName === 'all');
      answers[key] = row;
    }
    return { routes, answers };
  } finally {
    child.kill();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One recorded file: each distinct header set and body once, every answer a status and their indexes. A header set is
 * kept as `[name, value]` pairs, so a header named like a credential (`access-control-allow-credentials`) is not a
 * `name: value` line the secret scan reads as a committed credential.
 */
interface Shard {
  readonly headers: Array<Array<[string, string]>>;
  readonly bodies: string[];
  readonly answers: Record<string, Record<string, [number, number, number]>>;
}

/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;

/** The file a request is kept in: its path's first part, and for `/api` the upstream's part too (`api-bank`). */
function shardOf(call: string): string {
  const parts = call.split(' ')[1]!.split('?')[0]!.split('/').filter(Boolean);
  const name = (parts[0] === 'api' ? parts.slice(0, 2) : parts.slice(0, 1)).join('-').replace(/[^A-Za-z0-9-]/g, '_');
  return name || 'root';
}

function shard(calls: Array<[string, Record<string, Answer>]>): Shard {
  const headers: Shard['headers'] = [];
  const bodies: string[] = [];
  const hIndex = new Map<string, number>();
  const bIndex = new Map<string, number>();
  const answers: Shard['answers'] = {};
  for (const [call, row] of calls) {
    answers[call] = {};
    for (const [k, a] of Object.entries(row)) {
      const h = JSON.stringify(a.headers);
      if (!hIndex.has(h)) hIndex.set(h, headers.push(Object.entries(a.headers)) - 1);
      if (!bIndex.has(a.body)) bIndex.set(a.body, bodies.push(a.body) - 1);
      answers[call][k] = [a.status, hIndex.get(h)!, bIndex.get(a.body)!];
    }
  }
  return { headers, bodies, answers };
}

/** Written in the repo's own format (the format check reads JSON), each file under SHARD_BYTES. */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, value: unknown) => {
    const file = fileURLToPath(goldenJson(name));
    return prettier.format(JSON.stringify(value), { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const groups = new Map<string, Array<[string, Record<string, Answer>]>>();
  for (const entry of Object.entries(g.answers)) groups.set(shardOf(entry[0]), [...(groups.get(shardOf(entry[0])) ?? []), entry]);
  const files = new Map<string, string>([['routes', await format('routes', g.routes)]]);
  for (const [name, calls] of groups) files.set(name, await format(name, shard(calls)));
  for (const [name, text] of files)
    if (Buffer.byteLength(text) > SHARD_BYTES) throw new Error(`${name}.json is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
}

function readGolden(): Golden {
  const g: Golden = {
    routes: JSON.parse(readFileSync(new URL('./wire-replay.golden/routes.json', import.meta.url), 'utf8')) as string[],
    answers: {},
  };
  for (const file of readdirSync(GOLDEN).filter((f) => f !== 'routes.json')) {
    const s = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as Shard;
    for (const [call, row] of Object.entries(s.answers))
      g.answers[call] = Object.fromEntries(
        Object.entries(row).map(([k, [status, h, b]]) => [k, { status, headers: Object.fromEntries(s.headers[h]!), body: s.bodies[b]! }]),
      );
  }
  return g;
}

describe('the wire replay: svc-edge answers every route and door as recorded', () => {
  it('every request in the matrix gets the recorded status, headers and body', async () => {
    const now = await replay();
    if (process.env.WIRE_REPLAY_WRITE === '1') await writeGolden(now);
    const golden = readGolden();
    expect(now.routes).toEqual(golden.routes);
    const flat = (g: Golden) =>
      Object.fromEntries(Object.entries(g.answers).flatMap(([call, a]) => Object.entries(a).map(([k, v]) => [`${call} ${k}`, v])));
    const was = flat(golden);
    const is = flat(now);
    expect(Object.keys(is).sort()).toEqual(Object.keys(was).sort());
    const diffs = Object.entries(was)
      .filter(([key, a]) => JSON.stringify(is[key]) !== JSON.stringify(a))
      .map(([key, a]) => `${key}: ${a.status} ${a.body.slice(0, 160)} != ${is[key]?.status} ${is[key]?.body.slice(0, 160)}`);
    expect(diffs).toEqual([]);
  }, 300_000);
});
