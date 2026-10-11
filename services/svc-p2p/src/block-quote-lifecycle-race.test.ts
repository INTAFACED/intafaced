/**
 * Accept and expire each load a quote, decide in memory, then save.
 * A firm accept must keep its fill price. An expired quote must not come back bound.
 * Concurrent accept and expire cannot both return success.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { BlockRfqService, type BlockQuote } from './block-rfq.js';
import { SqlBlockQuoteStore, type BlockQuoteStore } from './block-rfq-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const EXPIRY = '2026-08-26T12:05:00.000Z';
const PRICE = '1.25';
const SIZE = '2';

const maker = { userId: MAKER } as Principal;
const taker = { userId: TAKER } as Principal;

function quoteBody() {
  return {
    takerId: TAKER,
    side: 'sell' as const,
    asset: 'USDT',
    fiatCurrency: 'USD',
    size: SIZE,
    price: PRICE,
    expiresAt: EXPIRY,
    capacity: 'principal',
    firmness: 'firm',
  };
}

/** Both loads finish before either caller continues, so both decide from `open`. */
function releaseAfterLoads(inner: SqlBlockQuoteStore, parties: number): BlockQuoteStore {
  let arrived = 0;
  let openGate: () => void = () => undefined;
  const released = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('block quote lifecycle gate timed out')), 5_000);
    openGate = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return {
    async save(quote) {
      await inner.save(quote);
    },
    async load(quoteId) {
      const row = await inner.load(quoteId);
      arrived += 1;
      if (arrived >= parties) openGate();
      else await released;
      return row;
    },
  };
}

/** One load returns a snapshot taken before the other writer committed. */
function staleOnce(inner: SqlBlockQuoteStore, stale: BlockQuote): BlockQuoteStore {
  let pending: BlockQuote | null = stale;
  return {
    async save(quote) {
      await inner.save(quote);
    },
    async load(quoteId) {
      if (pending && pending.quoteId === quoteId) {
        const snap = pending;
        pending = null;
        return { ...snap };
      }
      return inner.load(quoteId);
    },
  };
}

describe('block quote lifecycle race', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is required — Docker is down and a skip is not a pass');
    db = await createTestDatabase({ service: 'p2p', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('concurrent accept and expire cannot both succeed, and the winner keeps its fill', async () => {
    const sqlStore = new SqlBlockQuoteStore(db!.sql);
    const svc = new BlockRfqService(sqlStore, { now: () => NOW });
    const quoted = await svc.quote(maker, quoteBody());
    const gated = new BlockRfqService(releaseAfterLoads(sqlStore, 2), { now: () => NOW });

    const settled = await Promise.allSettled([
      gated.accept(taker, { quoteId: quoted.quoteId }),
      gated.expire(maker, { quoteId: quoted.quoteId }),
    ]);

    const won = settled.filter((result) => result.status === 'fulfilled');
    expect(won).toHaveLength(1);

    const stored = await svc.get(taker, quoted.quoteId);
    expect(stored.size).toBe(quoted.size);
    expect(stored.price).toBe(quoted.price);
    expect(stored.notional).toBe(quoted.notional);

    if (settled[0]!.status === 'fulfilled') {
      expect(settled[1]!.status).toBe('rejected');
      expect(stored.lifecycle).toBe('bound');
      expect(stored.fillPrice).toBe(PRICE);
      expect(stored.acceptedAt).toBe(NOW.toISOString());
    } else {
      expect(settled[0]!.status).toBe('rejected');
      expect(stored.lifecycle).toBe('expired');
      expect(stored.fillPrice).toBeNull();
      expect(stored.acceptedAt).toBeNull();
    }
  });

  it('a firm accept is not replaced by expired with a null fill price', async () => {
    const sqlStore = new SqlBlockQuoteStore(db!.sql);
    const svc = new BlockRfqService(sqlStore, { now: () => NOW });
    const quoted = await svc.quote(maker, quoteBody());
    const open = await sqlStore.load(quoted.quoteId);
    if (!open) throw new Error('quoted row missing');
    const bound = await svc.accept(taker, { quoteId: quoted.quoteId });
    expect(bound.fillPrice).toBe(PRICE);

    const raced = new BlockRfqService(staleOnce(sqlStore, open), { now: () => NOW });
    await expect(raced.expire(maker, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'p2p.rfq_already_bound',
    });

    const stored = await svc.get(taker, quoted.quoteId);
    expect(stored.lifecycle).toBe('bound');
    expect(stored.fillPrice).toBe(PRICE);
    expect(stored.size).toBe(quoted.size);
    expect(stored.price).toBe(quoted.price);
    expect(stored.notional).toBe(quoted.notional);
  });

  it('an expired quote is not written back to bound', async () => {
    const sqlStore = new SqlBlockQuoteStore(db!.sql);
    const svc = new BlockRfqService(sqlStore, { now: () => NOW });
    const quoted = await svc.quote(maker, quoteBody());
    const open = await sqlStore.load(quoted.quoteId);
    if (!open) throw new Error('quoted row missing');
    const expired = await svc.expire(maker, { quoteId: quoted.quoteId });
    expect(expired.lifecycle).toBe('expired');
    expect(expired.fillPrice).toBeNull();

    const raced = new BlockRfqService(staleOnce(sqlStore, open), { now: () => NOW });
    await expect(raced.accept(taker, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'p2p.rfq_expired',
    });

    const stored = await svc.get(taker, quoted.quoteId);
    expect(stored.lifecycle).toBe('expired');
    expect(stored.fillPrice).toBeNull();
    expect(stored.acceptedAt).toBeNull();
    expect(stored.size).toBe(quoted.size);
    expect(stored.price).toBe(quoted.price);
    expect(stored.notional).toBe(quoted.notional);
  });
  it('refuses changed original terms on the same open quote ID', async () => {
    const store = new SqlBlockQuoteStore(db!.sql);
    const svc = new BlockRfqService(store, { now: () => NOW });
    const quoted = await svc.quote(maker, quoteBody());
    const original = await store.load(quoted.quoteId);
    if (!original) throw new Error('quoted row missing');
    for (const changed of [
      { size: parseAmount('3') },
      { makerId: '33333333-3333-4333-8333-333333333333' },
      { asset: 'BTC' },
      { price: parseAmount('2') },
    ]) {
      await expect(store.save({ ...original, ...changed })).rejects.toMatchObject({ code: 'p2p.rfq_terms_conflict' });
    }
    expect(await svc.get(taker, quoted.quoteId)).toEqual(quoted);
  });
});
