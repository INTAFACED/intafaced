/**
 * The founder console (apps/admin) for the look gate, with no stack: its production build under `next start`, pointed at
 * a stand-in Edge that answers only the founder check (identity `accountControls.operatorStatus`: this TEST founder is
 * enabled) and refuses every other call with a typed 503, so each console room shows its own refuse state inside the
 * signed-in shell. The session cookie is sealed here the way apps/admin/src/lib/founder-session.ts seals it, with a
 * secret made for this run; a room that lands on /login instead is reported, so a change to that format cannot pass
 * unseen. Nothing here reaches a service.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADMIN_COOKIE = '__Host-intafaced-admin';
export const FOUNDER = '00000000-0000-4000-8000-0000000000f1';
const REFUSAL = {
  error: { message: 'The look gate renders rooms without services.', data: { code: 'look_gate.no_services', httpStatus: 503 } },
};

/** The console's static rooms: every `page.tsx` under `(console)` with no dynamic segment, plus the sign-in page. */
export function adminRoutes(root) {
  const base = join(root, 'apps/admin/src/app/(console)');
  const out = existsSync(join(root, 'apps/admin/src/app/login/page.tsx')) ? ['/login'] : [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        // Dynamic segments, Next's private (_x) and slot (@x) folders, and the test-only route probe are no rooms.
        if (!/^[[_@]/.test(name) && !(dir === base && name === 'route-probe')) walk(path);
      } else if (name === 'page.tsx') {
        const route =
          '/' +
          relative(base, dir)
            .split(sep)
            .filter((p) => p && !p.startsWith('('))
            .join('/');
        out.push(route);
      }
    }
  };
  if (existsSync(base)) walk(base);
  return [...new Set(out)].sort();
}

/** The sealed founder session cookie value (AES-256-GCM, AAD `<cookie>\n<origin>\nv1`, as founder-session.ts). */
export function sealSession(session, key, origin) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${ADMIN_COOKIE}\n${origin}\nv1`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/** What the stand-in Edge answers for one request path: the founder check, or the refusal. */
export function edgeAnswer(path) {
  if (/^\/api\/identity\/trpc\/accountControls\.operatorStatus(?:\?|$)/.test(path))
    return {
      status: 200,
      json: { result: { data: { status: 'enabled', userId: FOUNDER, version: '1', changedAt: '2026-10-01T00:00:00.000Z' } } },
    };
  return { status: 503, json: REFUSAL };
}

function listen(server, port) {
  return new Promise((ok, fail) => {
    server.once('error', (error) => fail(new Error(`the look gate needs port ${port} for the founder console: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => ok(server.address().port));
  });
}

/**
 * Starts the stand-in Edge and the console. Returns `{ origin, cookie, stop }`, where `cookie` is a Playwright cookie
 * for a signed-in TEST founder. The console's server runs with its clock at `now` (frozen-clock.cjs), as the pages' is.
 * Throws, naming the build step, when there is no console build.
 */
export async function startAdmin(root, { now, port: ADMIN_PORT }) {
  const dir = join(root, 'apps/admin');
  if (!existsSync(join(dir, '.next/BUILD_ID')))
    throw new Error(`no founder console build in ${dir}/.next: pnpm turbo run build --filter=@intafaced/admin`);
  const edge = http.createServer((req, res) => {
    const a = edgeAnswer(req.url ?? '/');
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.json));
  });
  // Fixed ports: the console prints its own settings (EDGE_URL, ADMIN_ORIGIN), so a port drawn per run would change the
  // shot. One gate run holds them at a time (each CI shard is its own runner).
  const edgePort = await listen(edge, ADMIN_PORT + 1);
  const port = ADMIN_PORT;
  // The ready check below would accept any server on the port, so make sure it is ours to take.
  const probe = http.createServer();
  await listen(probe, port).catch((error) => {
    edge.close();
    throw error;
  });
  await new Promise((ok) => probe.close(ok));
  const origin = `http://127.0.0.1:${port}`;
  const key = randomBytes(32);
  // A clean environment: a setting the caller happens to hold (ADMIN_MODULES, LAUNCH_DROP, a posture variable) would
  // change what the console renders, so only the path and the gate's own values go in.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    APP_ENV: 'dev',
    NODE_ENV: 'production',
    EDGE_URL: `http://127.0.0.1:${edgePort}`,
    ADMIN_ORIGIN: origin,
    ADMIN_SESSION_SECRET: key.toString('base64url'),
    NEXT_TELEMETRY_DISABLED: '1',
    LOOK_GATE_NOW: String(now),
    // Next to this file, so CI's copy of the gate from main preloads main's clock, never the pull request's.
    NODE_OPTIONS: `--require "${fileURLToPath(new URL('./frozen-clock.cjs', import.meta.url))}"`,
  };
  const next = spawn(
    process.execPath,
    [join(dir, 'node_modules/next/dist/bin/next'), 'start', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  next.stdout.on('data', (d) => (log = (log + d).slice(-4000)));
  next.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  const stop = () => {
    next.kill('SIGTERM');
    edge.close();
  };
  // A gate run that throws never reaches stop(): the console must not outlive it and hold the port.
  process.once('exit', () => next.kill('SIGTERM'));
  for (let i = 0; ; i++) {
    const up = await fetch(`${origin}/login`)
      .then((r) => r.status < 500)
      .catch(() => false);
    if (up) break;
    if (i > 120 || next.exitCode !== null) {
      stop();
      throw new Error(`the founder console did not start on ${origin}:\n${log}`);
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const session = {
    userId: FOUNDER,
    accessToken: 'look-gate-test-token',
    refreshToken: 'look-gate-test-refresh',
    expiresAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
    issuedAt: new Date(now - 60 * 1000).toISOString(),
    csrf: randomBytes(32).toString('base64url'),
  };
  const cookie = {
    name: ADMIN_COOKIE,
    value: sealSession(session, key, origin),
    domain: '127.0.0.1',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  };
  return { origin, cookie, stop, logs: () => log };
}
