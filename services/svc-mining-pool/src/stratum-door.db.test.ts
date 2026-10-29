import { readFileSync } from 'node:fs';
import { connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { failingPow, grindPow, type PowSpec } from './pow.js';
import { MiningReadStore } from './reads.js';
import { startStratumDoor, stratumWindowId } from './stratum-door.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const SPEC: PowSpec = { dimension: 8, targetBits: 8, testnet: true };
const ENV: NodeJS.ProcessEnv = {
  MINING_POW_DIMENSION: '8',
  MINING_POW_TARGET_BITS: '8',
  MINING_POW_TESTNET: 'true',
  MINING_WORKER_NAME_PATTERN: 'TEST.{worker}',
};
const migration = (name: string) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');

function databaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL required for the miner door tests');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

type Message = { id: unknown; method?: string; params?: unknown[]; result?: unknown; error?: { code: string } | null };

const open: Socket[] = [];

/** A TEST rig on a real socket: one JSON line out, the next line(s) back. */
async function rig(port: number) {
  const socket: Socket = connect(port, '127.0.0.1');
  open.push(socket);
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  socket.setEncoding('utf8');
  const inbox: Message[] = [];
  const waiting: Array<() => void> = [];
  let buffered = '';
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let at = buffered.indexOf('\n');
    while (at !== -1) {
      inbox.push(JSON.parse(buffered.slice(0, at)) as Message);
      buffered = buffered.slice(at + 1);
      at = buffered.indexOf('\n');
    }
    waiting.splice(0).forEach((wake) => wake());
  });
  const next = async (): Promise<Message> => {
    while (inbox.length === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    return inbox.shift()!;
  };
  const call = async (id: number, method: string, params: unknown[]) => {
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return next();
  };
  return { socket, call, next };
}

describe('miner door on a real socket', () => {
  let db: TestDatabase;
  let server: Server;
  let port: number;
  let clock = Date.UTC(2026, 9, 29);

  beforeAll(async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
    vi.stubEnv('APP_ENV', 'test');
    db = await createTestDatabase({
      service: 'mining_pool',
      url: databaseUrl(),
      migrations: [
        migration('0000_mining_pool_init.sql'),
        migration('0001_blank_reward_share.sql'),
        migration('0002_mining_reads.sql'),
        migration('0003_share_workers.sql'),
        migration('0004_pow_solo.sql'),
      ],
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  beforeEach(async () => {
    await db.truncateAll();
    clock = Date.UTC(2026, 9, 29);
    server = startStratumDoor(
      { sql: db.sql, env: ENV, terms: { port: 0, windowSeconds: 604800, assetId: 'TEST' }, now: () => clock },
      '127.0.0.1',
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    open.splice(0).forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const roster = async () => (await new MiningReadStore(db.sql, null).myWorkers(ALICE, 10_080)).workers.map((w) => [w.name, w.hashrate]);
  const shares = () =>
    db.sql`SELECT miner_id, worker_id, weight::text AS weight, pow_nonce, testnet FROM mining_pool.shares ORDER BY worker_id`;

  it('a rig authorizes, gets the pool header for its window, account and rig, and its valid share makes exactly one worker at weight 1', async () => {
    expect(await roster()).toEqual([]);
    const { socket, call, next } = await rig(port);
    expect(await call(1, 'mining.subscribe', [])).toMatchObject({ id: 1, result: [['mining.notify', expect.any(String)]], error: null });
    expect(await call(2, 'mining.authorize', [`${ALICE}.TEST.Rig-A`])).toEqual({ id: 2, result: true, error: null });
    const job = await next();
    const windowId = stratumWindowId(604800, clock);
    expect(job).toMatchObject({
      id: null,
      method: 'mining.notify',
      params: [windowId, expect.stringMatching(/^[0-9a-f]{64}$/), 8, 8, true],
    });
    const header = Buffer.from(job.params![1] as string, 'hex');
    const nonce = grindPow(SPEC, header);
    expect(await call(3, 'mining.submit', [`${ALICE}.TEST.Rig-A`, windowId, nonce])).toEqual({ id: 3, result: true, error: null });
    expect(await roster()).toEqual([['Rig-A', '1']]);
    expect(await shares()).toEqual([{ miner_id: ALICE, worker_id: `worker:${ALICE}:Rig-A`, weight: '1', pow_nonce: nonce, testnet: true }]);

    // The same work again is a duplicate and keeps nothing.
    expect(await call(4, 'mining.submit', [`${ALICE}.TEST.Rig-A`, windowId, nonce])).toEqual({
      id: 4,
      result: null,
      error: { code: 'mining.share_duplicate', message: expect.any(String) },
    });
    // Work that misses the target is refused by the pool's own check and keeps nothing.
    expect(await call(5, 'mining.submit', [`${ALICE}.TEST.Rig-A`, windowId, failingPow(SPEC, header)])).toEqual({
      id: 5,
      result: null,
      error: { code: 'mining.pow_invalid', message: expect.any(String) },
    });
    expect(await roster()).toEqual([['Rig-A', '1']]);
    expect(await shares()).toHaveLength(1);
    socket.destroy();
  });

  it('no worker name is the default worker; a user this connection did not authorize is refused', async () => {
    const { socket, call, next } = await rig(port);
    expect(await call(1, 'mining.authorize', [ALICE])).toEqual({ id: 1, result: true, error: null });
    const job = await next();
    const nonce = grindPow(SPEC, Buffer.from(job.params![1] as string, 'hex'));
    expect(await call(2, 'mining.submit', [`${ALICE}.TEST.Rig-B`, job.params![0], nonce])).toMatchObject({
      error: { code: 'mining.stratum_unauthorized' },
    });
    expect(await call(3, 'mining.submit', [ALICE, job.params![0], nonce])).toEqual({ id: 3, result: true, error: null });
    expect(await roster()).toEqual([['default', '1']]);
    socket.destroy();
  });

  it('a share for a job past its window is mining.job_stale, keeps nothing, and the rig gets the new job', async () => {
    const { socket, call, next } = await rig(port);
    await call(1, 'mining.authorize', [`${ALICE}.TEST.Rig-A`]);
    const job = await next();
    const nonce = grindPow(SPEC, Buffer.from(job.params![1] as string, 'hex'));
    clock += 604800 * 1000;
    expect(await call(2, 'mining.submit', [`${ALICE}.TEST.Rig-A`, job.params![0], nonce])).toMatchObject({
      error: { code: 'mining.job_stale' },
    });
    const renewed = await next();
    expect(renewed.method).toBe('mining.notify');
    expect(renewed.params![0]).toBe(stratumWindowId(604800, clock));
    expect(renewed.params![0]).not.toBe(job.params![0]);
    expect(await shares()).toEqual([]);
    socket.destroy();
  });

  it('a line past the limit closes the connection', async () => {
    const { socket } = await rig(port);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write('x'.repeat(5_000));
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});
