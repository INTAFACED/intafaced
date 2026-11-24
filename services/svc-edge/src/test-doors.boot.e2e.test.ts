import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * TEST partner doors are refused at the edge (project-state #2711).
 *
 * The shipped entrypoint is booted as a process, with its bank upstream pointed at a loopback stand-in that answers
 * every path and records what it served. A request through the edge reaches the stand-in from the edge's own loopback
 * socket, which is exactly what a "loopback only" TEST door would accept, so the edge itself must refuse the TEST
 * namespace. A plain bank path is forwarded, which shows the refusals are the rule and not a dead upstream.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

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

let child: ChildProcess | null = null;
let upstream: Server | null = null;
let base = '';
const reached: string[] = [];

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

beforeAll(async () => {
  upstream = createServer((req, res) => {
    reached.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ REACHED: req.url, peer: req.socket.remoteAddress }));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const bankPort = (upstream.address() as AddressInfo).port;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: {
      ...process.env,
      APP_ENV: 'test',
      NODE_ENV: 'test',
      SERVICE_NAME: 'svc-edge',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(port),
      LOG_LEVEL: 'info',
      OTEL_ENABLED: 'false',
      JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
      EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
      EDGE_RATE_LIMIT_MAX: '300',
      EDGE_RATE_LIMIT_WINDOW_MS: '60000',
      EDGE_BODY_LIMIT_BYTES: '1048576',
      INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
      EDGE_KILL_STATE_PATH: '',
      BANK_URL: `http://127.0.0.1:${bankPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForListening(child);
}, 90_000);

afterAll(async () => {
  child?.kill();
  child = null;
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  upstream = null;
});

async function anonymous(method: 'GET' | 'POST', path: string) {
  const init: RequestInit = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method };
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.text() };
}

describe('TEST partner doors through the real edge', () => {
  it('forwards a plain bank path to the upstream, so the stack under test does forward', async () => {
    const before = reached.length;
    const res = await anonymous('GET', '/api/bank/health');
    expect(res.status, res.body).toBe(200);
    expect(reached.slice(before)).toEqual(['/health']);
  });

  it('refuses every TEST door family anonymously and forwards none of them', async () => {
    const before = reached.length;
    const doors: Array<['GET' | 'POST', string]> = [
      ['GET', '/api/bank/test-partner/venue'],
      ['POST', '/api/bank/test-partner/balances'],
      ['POST', '/api/bank/test-partner/moves'],
      ['POST', '/api/bank/test-partner/direct-debits'],
      ['POST', '/api/bank/test-partner/dd-refund'],
      ['GET', '/api/bank/test-ramp-partner/report'],
      ['POST', '/api/bank/test-ramp-partner/age'],
      ['GET', '/api/bank/test-card-partner/venue'],
      ['POST', '/api/bank/test-card-partner/disputes'],
      ['GET', '/api/bank/test/payin-sim/pay/o-1'],
      ['POST', '/api/bank/TEST-partner/dd-refund'],
      ['POST', '/api/bank/test_partner/dd-refund'],
      ['POST', '/api/bank/test-a-new-door/write'],
    ];
    for (const [method, path] of doors) {
      const res = await anonymous(method, path);
      expect(res.status, `${method} ${path}: ${res.body}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${method} ${path}: ${res.body}`).toBeLessThan(500);
    }
    expect(reached.slice(before)).toEqual([]);
  });
});
