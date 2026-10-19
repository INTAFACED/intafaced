import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount } from '../money.js';
import type { PostRequest } from '../types.js';
import { userAvailable, userHold } from '../accounts.js';
import { recipes } from '../recipes/index.js';
import { fakeLedgerDoor, type DoorCall, type DoorVerify } from './ledger-door.js';

const accept: DoorVerify = () => ({ service: 'svc-test', rejected: null });
const reject: DoorVerify = () => ({ service: null, rejected: 'bad-signature' });
const USER = '11111111-1111-4111-8111-111111111111';

const call = (door: typeof fetch, path: string, body: unknown) =>
  door(`http://ledger.test${path}`, { method: 'POST', headers: {}, body: JSON.stringify(body) });

const wire = (request: PostRequest) => ({
  ...request,
  entries: request.entries.map((e) => ({ ...e, amount: formatAmount(e.amount) })),
});
const deposit = (railRef: string, amount: string) =>
  wire(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef }));

const transfer = (key: string, amount: string) => ({
  idempotencyKey: key,
  module: 'test',
  reason: 'test.hold',
  entries: [
    { account: userAvailable(USER, 'USDT'), direction: 'debit', amount },
    { account: userHold(USER, 'USDT', 'x'), direction: 'credit', amount },
  ],
});

describe('fakeLedgerDoor answers as svc-ledger s2s-http does', () => {
  it('refuses a request whose service signature does not verify', async () => {
    const door = fakeLedgerDoor(new MemoryLedger(), 'secret', reject);
    const res = await call(door, '/trpc/post', transfer('door-key-0', '1'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'ledger.unauthenticated' });
  });

  it('returns the booked entries on a post receipt and records the caller', async () => {
    const calls: DoorCall[] = [];
    const door = fakeLedgerDoor(new MemoryLedger(), 'secret', accept, calls);
    const res = await call(door, '/trpc/post', deposit('door-ref-1', '2'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ balanceAfter: string }> };
    expect(body.entries).toHaveLength(2);
    expect(body.entries.some((e) => e.balanceAfter === '2')).toBe(true);
    expect(calls).toEqual([expect.objectContaining({ path: '/trpc/post', service: 'svc-test' })]);
  });

  it('answers a funds refusal as 400 with the structured amounts', async () => {
    const door = fakeLedgerDoor(new MemoryLedger(), 'secret', accept);
    const res = await call(door, '/trpc/post', transfer('door-key-2', '3'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ledger.insufficient_funds', assetId: 'USDT', requested: '3' });
  });

  it('answers a reused key with a different body as 409', async () => {
    const door = fakeLedgerDoor(new MemoryLedger(), 'secret', accept);
    const first = deposit('door-ref-3', '1');
    expect((await call(door, '/trpc/post', first)).status).toBe(200);
    const again = await call(door, '/trpc/post', { ...deposit('door-ref-3', '2'), idempotencyKey: first.idempotencyKey });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'ledger.idempotency_conflict' });
  });

  it('refuses a txId that is not a uuid and answers an unknown route 404', async () => {
    const door = fakeLedgerDoor(new MemoryLedger(), 'secret', accept);
    expect((await call(door, '/trpc/txById', { txId: 'nope' })).status).toBe(400);
    expect((await call(door, '/trpc/nothing', {})).status).toBe(404);
    expect(await (await call(door, '/trpc/txByKey', { idempotencyKey: 'absent' })).json()).toEqual({ found: false });
  });
});
