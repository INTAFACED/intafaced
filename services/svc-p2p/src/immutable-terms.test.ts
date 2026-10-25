import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  InsufficientFundsError,
  MemoryLedger,
  parseAmount,
  formatAmount,
  recipes,
  userAvailable,
  tradeEscrowAccount,
  type PostRequest,
} from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { createLedgerClient } from './ledger-client.js';

// Synthetic fixtures only. No real fiat destination or live fee is published here.
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MODERATOR = '44444444-4444-4444-8444-444444444444';
const OFFER = '00000000-0000-4000-8000-0000000000f0';
const TRADE = '00000000-0000-4000-8000-0000000000a6';
const INSTRUMENT = '00000000-0000-4000-8000-0000000000b1';
const drizzle = new URL('../drizzle/', import.meta.url);
const files = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const read = (name: string) => readFileSync(new URL(name, drizzle), 'utf8');
const migrations = files.map(read);

async function seed(sql: TestDatabase['sql'], status: 'created' | 'escrowed' = 'escrowed') {
  await sql`INSERT INTO p2p.offers (id, maker_id, side, asset, fiat_currency, price_type, price, min_amt, max_amt, total_amt, remaining_amt, methods)
    VALUES (${OFFER}, ${SELLER}, 'sell', 'USDT', 'USD', 'fixed', '1', '10', '500', '500', '400', '["sepa"]')`;
  await sql`INSERT INTO p2p.p2p_trades (id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency, amount, price, fiat_amount, method, fee_bps, status, deadline_at, escrowed_at)
    VALUES (${TRADE}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD', '100', '1', '100', 'sepa', 100, ${status}, now() + interval '1 hour', ${status === 'created' ? null : new Date()})`;
  await sql`INSERT INTO p2p.payment_instruments (id, owner_id, method_id, country, fiat_currency, label, details, fingerprint, status)
    VALUES (${INSTRUMENT}, ${SELLER}, 'sepa', 'DE', 'USD', 'Fixture', '{"account_reference":"original"}', ${'a'.repeat(64)}, 'active')`;
  await sql`INSERT INTO p2p.trade_payment_instruments (trade_id, instrument_id, owner_id, method_id, country, fiat_currency, label, details, fingerprint)
    VALUES (${TRADE}, ${INSTRUMENT}, ${SELLER}, 'sepa', 'DE', 'USD', 'Fixture', '{"account_reference":"original"}', ${'a'.repeat(64)})`;
}
async function resolvedDispute(sql: TestDatabase['sql'], resolution: 'release' | 'refund' = 'refund') {
  await sql`UPDATE p2p.p2p_trades SET status = 'disputed' WHERE id = ${TRADE}`;
  await sql`INSERT INTO p2p.p2p_disputes (trade_id, opened_by, reason, deadline_at) VALUES (${TRADE}, ${BUYER}, 'Fixture dispute', now() + interval '1 hour')`;
  await sql`UPDATE p2p.p2p_disputes SET status = 'resolved', moderator_id = ${MODERATOR}, resolution = ${resolution}, resolved_at = now() WHERE trade_id = ${TRADE}`;
}

describe('native P2P original terms and decisions', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required for native P2P proof');
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql);
  });

  it('freezes the complete original trade terms before any lock outcome', async () => {
    for (const [column, value] of [
      ['amount', '10'],
      ['seller_id', OTHER],
      ['buyer_id', OTHER],
      ['asset', 'BTC'],
      ['price', '2'],
      ['fiat_amount', '200'],
      ['fee_bps', '0'],
      ['method', 'other'],
      ['fiat_currency', 'EUR'],
      ['maker_id', OTHER],
      ['taker_id', OTHER],
    ]) {
      await expect(db.sql.unsafe(`UPDATE p2p.p2p_trades SET ${column} = $1 WHERE id = $2`, [value!, TRADE])).rejects.toThrow(
        /immutable original terms/,
      );
    }
    await expect(db.sql`DELETE FROM p2p.p2p_trades WHERE id = ${TRADE}`).rejects.toThrow(/cannot be deleted/);
    expect((await db.sql`SELECT amount::text AS amount, seller_id, buyer_id FROM p2p.p2p_trades`)[0]).toMatchObject({
      amount: '100.000000000000000000',
      seller_id: SELLER,
      buyer_id: BUYER,
    });
  });

  it('never clears an acknowledged lock stamp to enable a void or another lock', async () => {
    await expect(db.sql`UPDATE p2p.p2p_trades SET status = 'created', escrowed_at = null WHERE id = ${TRADE}`).rejects.toThrow(
      /escrow stamp/,
    );
    await expect(
      db.sql`UPDATE p2p.p2p_trades SET status = 'cancelled', resolution = 'voided', resolved_at = now(), deadline_at = null WHERE id = ${TRADE}`,
    ).rejects.toThrow();
  });

  it('freezes the terminal decision and its original recipe reason across later attempts', async () => {
    await db.sql`UPDATE p2p.p2p_trades SET status = 'cancelled', resolution = 'refunded', resolution_reason = 'seller.cancelled', resolved_at = now(), deadline_at = null WHERE id = ${TRADE}`;
    await expect(db.sql`UPDATE p2p.p2p_trades SET status = 'released', resolution = 'released' WHERE id = ${TRADE}`).rejects.toThrow(
      /terminal decision/,
    );
    await expect(db.sql`UPDATE p2p.p2p_trades SET resolution_reason = 'other.reason' WHERE id = ${TRADE}`).rejects.toThrow(
      /terminal decision/,
    );
    await db.sql`UPDATE p2p.p2p_trades SET settled_at = now() WHERE id = ${TRADE}`;
    await expect(db.sql`UPDATE p2p.p2p_trades SET settled_at = null WHERE id = ${TRADE}`).rejects.toThrow(/settlement stamp/);
  });

  it('keeps the frozen pay-to account and its ownership while allowing truthful purge', async () => {
    for (const statement of [
      'details = \'{"account_reference":"other"}\'',
      "fingerprint = repeat('b',64)",
      `owner_id = '${OTHER}'`,
      "method_id = 'other'",
      "fiat_currency = 'EUR'",
    ]) {
      await expect(db.sql.unsafe(`UPDATE p2p.trade_payment_instruments SET ${statement} WHERE trade_id = $1`, [TRADE])).rejects.toThrow(
        /pay-to account frozen/,
      );
    }
    await expect(db.sql`DELETE FROM p2p.trade_payment_instruments WHERE trade_id = ${TRADE}`).rejects.toThrow(/cannot be deleted/);
    await db.sql`UPDATE p2p.trade_payment_instruments SET details = null, purged_at = now() WHERE trade_id = ${TRADE}`;
    expect((await db.sql`SELECT details, fingerprint FROM p2p.trade_payment_instruments`)[0]).toEqual({
      details: null,
      fingerprint: 'a'.repeat(64),
    });
    await expect(
      db.sql`UPDATE p2p.trade_payment_instruments SET details = '{"account_reference":"original"}', purged_at = null WHERE trade_id = ${TRADE}`,
    ).rejects.toThrow();
  });

  it('matches a refund ruling to only a refund decision and refuses void', async () => {
    await resolvedDispute(db.sql);
    await expect(
      db.sql`UPDATE p2p.p2p_trades SET status = 'released', resolution = 'released', resolved_at = now(), deadline_at = null WHERE id = ${TRADE}`,
    ).rejects.toThrow(/human ruling/);
    await expect(
      db.sql`UPDATE p2p.p2p_trades SET status = 'cancelled', resolution = 'voided', resolved_at = now(), deadline_at = null WHERE id = ${TRADE}`,
    ).rejects.toThrow();
    await db.sql`UPDATE p2p.p2p_trades SET status = 'cancelled', resolution = 'refunded', resolved_at = now(), deadline_at = null WHERE id = ${TRADE}`;
  });

  it('freezes the complete resolved ruling attribution, preserving the first human decision', async () => {
    await resolvedDispute(db.sql);
    await expect(db.sql`UPDATE p2p.p2p_disputes SET resolution = 'release' WHERE trade_id = ${TRADE}`).rejects.toThrow(
      /resolved dispute ruling/,
    );
    await expect(db.sql`UPDATE p2p.p2p_disputes SET moderator_id = ${OTHER} WHERE trade_id = ${TRADE}`).rejects.toThrow(
      /resolved dispute ruling/,
    );
    await expect(
      db.sql`UPDATE p2p.p2p_disputes SET resolved_at = resolved_at + interval '1 second' WHERE trade_id = ${TRADE}`,
    ).rejects.toThrow(/resolved dispute ruling/);
  });

  it.each(['transport', 'http_500', 'malformed_ack', 'definitive_funds'] as const)(
    'uses the existing HTTP adapter without inferring an outcome from %s',
    async (failure) => {
      await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
      await seed(db.sql, 'created');
      const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
        if (String(_input).endsWith('/trpc/balance')) return new Response(JSON.stringify({ accountId: 'fixture', amount: '0' }));
        if (failure === 'transport') throw new Error('fixture transport lost acknowledgement');
        if (failure === 'http_500') return new Response('{"message":"uncertain ledger outcome"}', { status: 500 });
        if (failure === 'malformed_ack') return new Response('not-json', { status: 200 });
        return new Response(
          JSON.stringify({
            code: 'ledger.insufficient_funds',
            message: 'Insufficient USDT: requested 100, available 0',
            accountId: 'fixture',
            assetId: 'USDT',
            requested: '100',
            availableBalance: '0',
          }),
          { status: 400 },
        );
      });
      vi.stubGlobal('fetch', fetcher);
      try {
        const ledger = createLedgerClient('http://fixture.invalid', 'synthetic-p2p-fixture-internal-secret');
        const bus = new MemoryEventBus('svc-p2p');
        const publish = vi.spyOn(bus, 'publish');
        const service = new P2pService(db.sql, ledger, bus, { instruments: new InstrumentService(db.sql), feeBps: 100 });
        const cancelling = service.cancelTrade(TRADE, SELLER);
        if (failure === 'definitive_funds') await expect(cancelling).resolves.toMatchObject({ resolution: 'voided' });
        else await expect(cancelling).rejects.toBeInstanceOf(Error);
        const trade = await service.getTrade(TRADE);
        expect(fetcher).toHaveBeenCalledTimes(failure === 'definitive_funds' ? 2 : 1);
        const wire = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
        expect(wire.idempotencyKey).toBe(`p2p.escrow.lock:${TRADE}`);
        expect(wire.entries.map((entry: { amount: string }) => entry.amount)).toEqual(['100', '100']);
        expect(trade.escrowedAt).toBeNull();
        expect(trade.resolution).toBe(failure === 'definitive_funds' ? 'voided' : null);
        expect(trade.status).toBe(failure === 'definitive_funds' ? 'cancelled' : 'created');
        if (failure !== 'definitive_funds') {
          expect(publish).not.toHaveBeenCalled();
          expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id = ${OFFER}`)[0]?.remaining).toBe(
            '400.000000000000000000',
          );
        }
        // The shared client can ask the ledger by key now (it used to throw "not exposed"). What must stay true is that a
        // failed transport, a 500, a malformed answer or a refusal is never read as "not booked": the lookup throws.
        await expect(ledger.getTxByKey(`p2p.escrow.lock:${TRADE}`)).rejects.toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('holds only the same trade during a stalled HTTP request and releases it on an uncertain response', async () => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => {
      entered();
      await gate;
      return new Response('{"message":"uncertain"}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetcher);
    const bus = new MemoryEventBus('svc-p2p');
    const publish = vi.spyOn(bus, 'publish');
    const service = new P2pService(db.sql, createLedgerClient('http://fixture.invalid', 'synthetic-p2p-fixture-internal-secret'), bus, {
      instruments: new InstrumentService(db.sql),
      feeBps: 100,
    });
    const first = service.cancelTrade(TRADE, SELLER).catch((error) => error);
    let second: Promise<unknown> | undefined;
    try {
      await started;
      second = service.cancelTrade(TRADE, SELLER).catch((error) => error);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [row] = await db.sql<
          { blocked: number }[]
        >`SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%p2p_trades%'`;
        blocked = Boolean(row?.blocked);
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await service.getTrade(TRADE)).resolution).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      release();
      await first;
      await second;
      vi.unstubAllGlobals();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await service.getTrade(TRADE)).status).toBe('created');
    expect(publish).not.toHaveBeenCalled();
    expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id = ${OFFER}`)[0]?.remaining).toBe(
      '400.000000000000000000',
    );
  });

  it.each(['headers', 'body', 'error_body'] as const)(
    'aborts real held HTTP %s after a committed ledger lock and replays the original key',
    async (held) => {
      await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
      await seed(db.sql, 'created');
      const ledger = new MemoryLedger();
      await ledger.post(
        recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test-fixture', railRef: 'http-budget' }),
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posted!: () => void;
      const committed = new Promise<void>((resolve) => {
        posted = resolve;
      });
      const keys: string[] = [];
      const server = createServer(async (request, response) => {
        try {
          let body = '';
          for await (const chunk of request) body += chunk;
          const wire = JSON.parse(body) as Omit<PostRequest, 'entries'> & {
            entries: Array<Omit<PostRequest['entries'][number], 'amount'> & { amount: string }>;
          };
          keys.push(wire.idempotencyKey);
          const receipt = await ledger.post({
            ...wire,
            entries: wire.entries.map((entry) => ({ ...entry, amount: parseAmount(entry.amount) })),
          });
          const ack = JSON.stringify({ txId: receipt.id, hash: receipt.hash, postedAt: receipt.postedAt.toISOString() });
          if (keys.length === 1) {
            if (held !== 'headers') {
              response.writeHead(held === 'error_body' ? 500 : 200, { 'content-type': 'application/json' });
              response.write(ack.slice(0, 1));
            }
            posted();
            await gate;
            response.end(held !== 'headers' ? ack.slice(1) : ack);
          } else response.end(ack);
        } catch (error) {
          response.statusCode = 500;
          response.end(String(error));
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('owned fixture HTTP port unavailable');
      const bus = new MemoryEventBus('svc-p2p');
      const publish = vi.spyOn(bus, 'publish');
      // The 100ms budget used to start when fetch started, so a slow CI loop aborted before the fixture
      // posted. The body and error_body cases abort only after the client has the headers, so the abort
      // lands while the held body is read.
      let abortHeld: (() => void) | undefined;
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const controller = new AbortController();
        if (abortHeld) {
          const timer = setTimeout(() => controller.abort(), ms);
          timer.unref();
          return controller.signal;
        }
        abortHeld = () => controller.abort();
        return controller.signal;
      });
      const realFetch = globalThis.fetch.bind(globalThis);
      let headersSeen: (() => void) | undefined;
      const sawHeaders = new Promise<void>((resolve) => {
        headersSeen = resolve;
      });
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await realFetch(input, init);
        // One microtask later the client has continued past await fetch and is reading the held body.
        if (held !== 'headers') queueMicrotask(() => headersSeen?.());
        return response;
      });
      const serviceWith = (timeoutMs: number) =>
        new P2pService(
          db.sql,
          createLedgerClient(`http://127.0.0.1:${address.port}`, 'synthetic-p2p-fixture-internal-secret', { timeoutMs }),
          bus,
          {
            instruments: new InstrumentService(db.sql),
            feeBps: 100,
            deadlines: {
              escrowSeconds: 120,
              paymentSeconds: 900,
              releaseSeconds: 1800,
              disputeSeconds: 604800,
              escalationRecheckSeconds: 3600,
            },
          },
        );
      // Cancel keeps the 100ms budget. The first abort fires only after the fixture posts, so a slow
      // CI loop cannot abort before the ledger lock. The refund replay is not that abort, so it gets
      // a budget a loaded runner can meet.
      const service = serviceWith(100);
      const patient = serviceWith(10_000);
      try {
        const pending = service.cancelTrade(TRADE, SELLER);
        await committed;
        if (held !== 'headers') await sawHeaders;
        if (!abortHeld) throw new Error('ledger post committed before the client armed its abort');
        abortHeld();
        const failed = await pending.catch((error) => error as Error);
        timeoutSpy.mockRestore();
        if (held === 'error_body') {
          // The 500's own body never finishes, so the shared transport cannot read a reason: the refusal is the plain
          // "failed (500)" error (not a funds refusal, so nothing is voided), where the old client surfaced the abort itself.
          expect((failed as Error).message).toMatch(/\/trpc\/post failed \(500\)/);
          expect(failed).not.toBeInstanceOf(InsufficientFundsError);
        } else {
          expect(['TimeoutError', 'AbortError']).toContain((failed as Error).name);
        }
        const original = await service.getTrade(TRADE);
        expect(original.status).toBe('created');
        expect(original.resolution).toBeNull();
        expect(original.escrowedAt).toBeNull();
        expect(publish).not.toHaveBeenCalled();
        expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id = ${OFFER}`)[0]?.remaining).toBe(
          '400.000000000000000000',
        );
        // NOWAIT proves the aborted HTTP attempt released the SQL row lock.
        await db.sql.begin(async (tx) => {
          await tx`SELECT id FROM p2p.p2p_trades WHERE id = ${TRADE} FOR UPDATE NOWAIT`;
        });
        // Immediate, not waited for: the lock must already have committed at the ledger while the response was still held
        // (the gate is not released yet), which is what proves the abort came after the post, not before it.
        expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('100');
        release();
        await db.sql`UPDATE p2p.p2p_trades SET deadline_at = now() - interval '1 hour' WHERE id = ${TRADE}`;
        expect((await patient.sweepDeadlines(undefined, 100)).failed).toBe(0);
        expect((await service.getTrade(TRADE)).resolution).toBe('refunded');
        expect(keys).toEqual([`p2p.escrow.lock:${TRADE}`, `p2p.escrow.lock:${TRADE}`, `p2p.escrow.refund:${TRADE}`]);
        expect(ledger.journal().filter((tx) => tx.idempotencyKey === `p2p.escrow.lock:${TRADE}`)).toHaveLength(1);
        expect(formatAmount((await ledger.balance(userAvailable(SELLER, 'USDT'))).amount)).toBe('1000');
        expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('0');
        expect(ledger.reconcile()).toEqual({ ok: true });
        expect(ledger.verifyChain()).toEqual({ ok: true });
      } finally {
        timeoutSpy.mockRestore();
        vi.unstubAllGlobals();
        release();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    60_000,
  );

  it.each([
    null,
    [],
    {},
    'ack',
    1,
    true,
    { txId: '', hash: '', postedAt: 'not-a-date' },
    { txId: 'fixture', hash: 'fixture' },
    { txId: null, hash: 'fixture', postedAt: '2026-10-11T00:00:00.000Z' },
    { txId: 1, hash: 'fixture', postedAt: '2026-10-11T00:00:00.000Z' },
    { txId: 'fixture', hash: [], postedAt: '2026-10-11T00:00:00.000Z' },
    { txId: 'fixture', hash: ' ', postedAt: '2026-10-11T00:00:00.000Z' },
    { txId: 'fixture', hash: 'fixture', postedAt: null },
    { txId: 'fixture', hash: 'fixture', postedAt: '1' },
    { txId: 'fixture', hash: 'fixture', postedAt: '2026-02-31T00:00:00.000Z' },
  ])('treats real HTTP200 acknowledgement %j as unknown and re-drives only the original intent', async (badAck) => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: SELLER,
        assetId: 'USDT',
        amount: parseAmount('1000'),
        rail: 'test-fixture',
        railRef: 'invalid-ack-control',
      }),
    );
    const keys: string[] = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const wire = JSON.parse(body) as Omit<PostRequest, 'entries'> & {
          entries: Array<Omit<PostRequest['entries'][number], 'amount'> & { amount: string }>;
        };
        keys.push(wire.idempotencyKey);
        if (keys.length === 1) {
          response.end(JSON.stringify(badAck));
          return;
        }
        const receipt = await ledger.post({
          ...wire,
          entries: wire.entries.map((entry) => ({ ...entry, amount: parseAmount(entry.amount) })),
        });
        response.end(JSON.stringify({ txId: receipt.id, hash: receipt.hash, postedAt: receipt.postedAt.toISOString() }));
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('owned HTTP fixture unavailable');
    const bus = new MemoryEventBus('svc-p2p');
    const publish = vi.spyOn(bus, 'publish');
    const service = new P2pService(
      db.sql,
      createLedgerClient(`http://127.0.0.1:${address.port}`, 'synthetic-p2p-fixture-internal-secret'),
      bus,
      {
        instruments: new InstrumentService(db.sql),
        feeBps: 100,
        deadlines: {
          escrowSeconds: 120,
          paymentSeconds: 900,
          releaseSeconds: 1800,
          disputeSeconds: 604800,
          escalationRecheckSeconds: 3600,
        },
      },
    );
    try {
      await expect(service.cancelTrade(TRADE, SELLER)).rejects.toThrow(/invalid post acknowledgement/);
      expect((await service.getTrade(TRADE)).status).toBe('created');
      expect((await service.getTrade(TRADE)).escrowedAt).toBeNull();
      expect((await service.getTrade(TRADE)).settledAt).toBeNull();
      expect(publish).not.toHaveBeenCalled();
      expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('0');
      expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id=${OFFER}`)[0]?.remaining).toBe(
        '400.000000000000000000',
      );
      await expect(new InstrumentService(db.sql).revealForTrade({ tradeId: TRADE, viewerId: BUYER })).rejects.toBeInstanceOf(Error);
      expect(await db.sql`SELECT id FROM p2p.instrument_access_log WHERE outcome='revealed'`).toHaveLength(0);
      await db.sql`UPDATE p2p.p2p_trades SET deadline_at=now()-interval '1 hour' WHERE id=${TRADE}`;
      expect((await service.sweepDeadlines(undefined, 100)).failed).toBe(0);
      expect((await service.getTrade(TRADE)).resolution).toBe('refunded');
      expect(keys).toEqual([`p2p.escrow.lock:${TRADE}`, `p2p.escrow.lock:${TRADE}`, `p2p.escrow.refund:${TRADE}`]);
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `p2p.escrow.lock:${TRADE}`)).toHaveLength(1);
      expect(formatAmount((await ledger.balance(userAvailable(SELLER, 'USDT'))).amount)).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(['released', 'refunded'] as const)(
    'does not stamp or announce %s from a malformed settlement acknowledgement',
    async (resolution) => {
      const ledger = new MemoryLedger();
      await ledger.post(
        recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test-fixture', railRef: 'settlement-ack' }),
      );
      await ledger.post(
        recipes.escrowLock({ tradeId: TRADE, sellerId: SELLER, buyerId: BUYER, assetId: 'USDT', amount: parseAmount('100') }),
      );
      // This fixture starts with acknowledged escrow, including its truthful reputation count.
      await db.sql`INSERT INTO p2p.p2p_reputation(user_id,trades_total) VALUES (${SELLER},1),(${BUYER},1) ON CONFLICT(user_id) DO UPDATE SET trades_total=p2p.p2p_reputation.trades_total+1`;
      const keys: string[] = [];
      const server = createServer(async (request, response) => {
        try {
          let body = '';
          for await (const chunk of request) body += chunk;
          const wire = JSON.parse(body) as Omit<PostRequest, 'entries'> & {
            entries: Array<Omit<PostRequest['entries'][number], 'amount'> & { amount: string }>;
          };
          keys.push(wire.idempotencyKey);
          if (keys.length === 1) {
            response.end('{}');
            return;
          }
          const receipt = await ledger.post({
            ...wire,
            entries: wire.entries.map((entry) => ({ ...entry, amount: parseAmount(entry.amount) })),
          });
          response.end(JSON.stringify({ txId: receipt.id, hash: receipt.hash, postedAt: receipt.postedAt.toISOString() }));
        } catch (error) {
          response.statusCode = 500;
          response.end(String(error));
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('owned HTTP fixture unavailable');
      const bus = new MemoryEventBus('svc-p2p');
      const publish = vi.spyOn(bus, 'publish');
      const service = new P2pService(
        db.sql,
        createLedgerClient(`http://127.0.0.1:${address.port}`, 'synthetic-p2p-fixture-internal-secret'),
        bus,
        { instruments: new InstrumentService(db.sql), feeBps: 100 },
      );
      try {
        const settling = resolution === 'released' ? service.confirmFiatReceived(TRADE, SELLER) : service.cancelTrade(TRADE, SELLER);
        await expect(settling).rejects.toThrow(/invalid post acknowledgement/);
        expect((await service.getTrade(TRADE)).resolution).toBe(resolution);
        expect((await service.getTrade(TRADE)).settledAt).toBeNull();
        expect(publish).not.toHaveBeenCalled();
        expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('100');
        expect((await service.sweepSettlements(100)).settled).toBe(1);
        const key = `p2p.escrow.${resolution === 'released' ? 'release' : 'refund'}:${TRADE}`;
        expect(keys).toEqual([key, key]);
        expect(ledger.journal().filter((tx) => tx.idempotencyKey === key)).toHaveLength(1);
        expect((await service.getTrade(TRADE)).settledAt).not.toBeNull();
        expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('0');
        expect(ledger.reconcile()).toEqual({ ok: true });
        expect(ledger.verifyChain()).toEqual({ ok: true });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each([
    { code: 'ledger.insufficient_funds', message: 'declined', requested: 'not-money', availableBalance: 'also-not-money' },
    { accountId: undefined },
    { assetId: undefined },
    { requested: undefined },
    { availableBalance: undefined },
    { message: undefined },
    { message: '' },
    { requested: '100', availableBalance: '200' },
    { requested: '100', availableBalance: '100' },
    { availableBalance: '-1' },
    { requested: '99' },
    { requested: '1e2' },
    { requested: 100 },
    { availableBalance: false },
    { requested: ' 100' },
    { requested: '100.0000000000000000001' },
    { requested: '100000000000000000000' },
    { assetId: 'BTC' },
    { assetId: null },
    { accountId: null },
    { accountId: 'other-account' },
    { accountId: ' ' },
    { message: 'Insufficient BTC: requested 99, available 0' },
    { code: undefined, message: 'Insufficient USDT: requested 100, available 0' },
    { identity: 'failure' },
    { identity: 'malformed' },
    { identity: 'mismatch' },
    { identity: 'bad_amount' },
  ])('retains native intent for an incomplete or inconsistent actual HTTP400 funds refusal %j', async (override) => {
    await db.sql`TRUNCATE p2p.payment_instruments,p2p.p2p_trades,p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    const responseBody = {
      code: 'ledger.insufficient_funds',
      message: 'Insufficient balance',
      assetId: 'USDT',
      accountId: '',
      requested: '100',
      availableBalance: '0',
      ...override,
    };
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      for await (const _ of request) {
      }
      calls.push(request.url ?? '');
      if (request.url === '/trpc/balance') {
        if ('identity' in override && override.identity === 'failure') {
          response.statusCode = 500;
          response.end('{}');
          return;
        }
        response.end(
          JSON.stringify(
            'identity' in override && override.identity === 'malformed'
              ? {}
              : {
                  accountId: 'identity' in override && override.identity === 'mismatch' ? 'other-account' : '',
                  amount: 'identity' in override && override.identity === 'bad_amount' ? 'not-money' : '0',
                },
          ),
        );
        return;
      }
      response.statusCode = 400;
      response.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('owned HTTP fixture unavailable');
    const bus = new MemoryEventBus('svc-p2p');
    const publish = vi.spyOn(bus, 'publish');
    const service = new P2pService(
      db.sql,
      createLedgerClient(`http://127.0.0.1:${address.port}`, 'synthetic-p2p-fixture-internal-secret'),
      bus,
      { instruments: new InstrumentService(db.sql), feeBps: 100 },
    );
    try {
      await expect(service.cancelTrade(TRADE, SELLER)).rejects.toBeInstanceOf(Error);
      const row = await service.getTrade(TRADE);
      expect(row.status).toBe('created');
      expect(row.resolution).toBeNull();
      expect(row.settledAt).toBeNull();
      expect(row.escrowedAt).toBeNull();
      expect(publish).not.toHaveBeenCalled();
      expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id=${OFFER}`)[0]?.remaining).toBe(
        '400.000000000000000000',
      );
      expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('1');
      expect(calls[0]).toBe('/trpc/post');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(['absent_account', 'changed_current_balance'] as const)(
    'accepts an actual complete first funds refusal for %s using identity only',
    async (mode) => {
      await db.sql`TRUNCATE p2p.payment_instruments,p2p.p2p_trades,p2p.offers CASCADE`;
      await seed(db.sql, 'created');
      const ledger = new MemoryLedger();
      if (mode === 'changed_current_balance') {
        await ledger.post(
          recipes.deposit({
            userId: SELLER,
            assetId: 'USDT',
            amount: parseAmount('100'),
            rail: 'test-fixture',
            railRef: 'create-source-identity',
          }),
        );
        await ledger.post(
          recipes.escrowLock({
            tradeId: '00000000-0000-4000-8000-0000000000a7',
            sellerId: SELLER,
            buyerId: BUYER,
            assetId: 'USDT',
            amount: parseAmount('100'),
          }),
        );
      }
      let balanceReads = 0;
      let failedPosts = 0;
      const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (request.url === '/trpc/balance') {
          balanceReads++;
          if (mode === 'changed_current_balance')
            await ledger.post(
              recipes.deposit({
                userId: SELLER,
                assetId: 'USDT',
                amount: parseAmount('1000'),
                rail: 'test-fixture',
                railRef: 'fund-after-known-refusal',
              }),
            );
          const balance = await ledger.balance(JSON.parse(body));
          response.end(JSON.stringify({ accountId: balance.accountId, amount: formatAmount(balance.amount) }));
          return;
        }
        const wire = JSON.parse(body) as Omit<PostRequest, 'entries'> & {
          entries: Array<Omit<PostRequest['entries'][number], 'amount'> & { amount: string }>;
        };
        try {
          await ledger.post({ ...wire, entries: wire.entries.map((entry) => ({ ...entry, amount: parseAmount(entry.amount) })) });
          response.statusCode = 500;
          response.end('unexpected successful fixture lock');
        } catch (error) {
          failedPosts++;
          const failure = error as {
            code: string;
            message: string;
            accountId: string;
            assetId: string;
            requested: string;
            availableBalance: string;
          };
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              code: failure.code,
              message: failure.message,
              accountId: failure.accountId,
              assetId: failure.assetId,
              requested: failure.requested,
              availableBalance: failure.availableBalance,
            }),
          );
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('owned HTTP fixture unavailable');
      const service = new P2pService(
        db.sql,
        createLedgerClient(`http://127.0.0.1:${address.port}`, 'synthetic-p2p-fixture-internal-secret'),
        new MemoryEventBus('svc-p2p'),
        { instruments: new InstrumentService(db.sql), feeBps: 100 },
      );
      try {
        await expect(service.cancelTrade(TRADE, SELLER)).resolves.toMatchObject({ resolution: 'voided', status: 'cancelled' });
        expect(failedPosts).toBe(1);
        expect(balanceReads).toBe(1);
        expect((await service.getTrade(TRADE)).settledAt).not.toBeNull();
        expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id=${OFFER}`)[0]?.remaining).toBe(
          '500.000000000000000000',
        );
        expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('0');
        expect(formatAmount((await ledger.balance(userAvailable(SELLER, 'USDT'))).amount)).toBe(
          mode === 'changed_current_balance' ? '1000' : '0',
        );
        expect(ledger.reconcile()).toEqual({ ok: true });
        expect(ledger.verifyChain()).toEqual({ ok: true });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it('keeps a delayed remote handler unresolved after timeout and a later funds refusal, then converges exactly', async () => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    const ledger = new MemoryLedger();
    let release!: () => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remoteDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const keys: string[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (request.url === '/trpc/balance') {
        const balance = await ledger.balance(JSON.parse(body));
        response.end(JSON.stringify({ accountId: balance.accountId, amount: formatAmount(balance.amount) }));
        return;
      }
      const wire = JSON.parse(body) as Omit<PostRequest, 'entries'> & {
        entries: Array<Omit<PostRequest['entries'][number], 'amount'> & { amount: string }>;
      };
      keys.push(wire.idempotencyKey);
      const first = keys.length === 1;
      if (first) await gate;
      try {
        const receipt = await ledger.post({
          ...wire,
          entries: wire.entries.map((entry) => ({ ...entry, amount: parseAmount(entry.amount) })),
        });
        response.end(JSON.stringify({ txId: receipt.id, hash: receipt.hash, postedAt: receipt.postedAt.toISOString() }));
      } catch (error) {
        const failure = error as {
          code: string;
          message: string;
          accountId: string;
          assetId: string;
          requested: string;
          availableBalance: string;
        };
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            code: failure.code,
            message: failure.message,
            accountId: failure.accountId,
            assetId: failure.assetId,
            requested: failure.requested,
            availableBalance: failure.availableBalance,
          }),
        );
      } finally {
        if (first) finish();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('owned HTTP fixture unavailable');
    // The first call must time out because the handler is held at the gate; any budget shorter than the gate does that.
    // 100 ms also made the LATER calls (balance, refund) flake on a loaded runner, so it is 2 s: the meaning is unchanged.
    const bus = new MemoryEventBus('svc-p2p');
    const publish = vi.spyOn(bus, 'publish');
    const service = new P2pService(
      db.sql,
      createLedgerClient(`http://127.0.0.1:${address.port}`, 'synthetic-p2p-fixture-internal-secret', { timeoutMs: 2_000 }),
      bus,
      {
        instruments: new InstrumentService(db.sql),
        feeBps: 100,
        deadlines: {
          escrowSeconds: 120,
          paymentSeconds: 900,
          releaseSeconds: 1800,
          disputeSeconds: 604800,
          escalationRecheckSeconds: 3600,
        },
      },
    );
    try {
      await expect(service.cancelTrade(TRADE, SELLER)).rejects.toBeInstanceOf(Error);
      expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('1');
      await expect(service.cancelTrade(TRADE, SELLER)).rejects.toMatchObject({ code: 'p2p.escrow_lock_uncertain' });
      expect((await service.getTrade(TRADE)).resolution).toBeNull();
      expect(publish).not.toHaveBeenCalled();
      expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id=${OFFER}`)[0]?.remaining).toBe(
        '400.000000000000000000',
      );
      await expect(
        db.sql`UPDATE p2p.p2p_trades SET status='cancelled',resolution='voided',resolved_at=now(),deadline_at=null WHERE id=${TRADE}`,
      ).rejects.toThrow(/unresolved escrow lock attempts/);
      // Our abort did not cancel the first accepted remote handler.
      await ledger.post(
        recipes.deposit({
          userId: SELLER,
          assetId: 'USDT',
          amount: parseAmount('100'),
          rail: 'test-fixture',
          railRef: 'fund-after-uncertain-refusal',
        }),
      );
      release();
      await remoteDone;
      expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('100');
      expect((await service.getTrade(TRADE)).status).toBe('created');
      await db.sql`UPDATE p2p.p2p_trades SET deadline_at=now()-interval '1 hour' WHERE id=${TRADE}`;
      expect((await service.sweepDeadlines(undefined, 100)).failed).toBe(0);
      expect((await service.getTrade(TRADE)).resolution).toBe('refunded');
      expect(keys).toEqual([
        `p2p.escrow.lock:${TRADE}`,
        `p2p.escrow.lock:${TRADE}`,
        `p2p.escrow.lock:${TRADE}`,
        `p2p.escrow.refund:${TRADE}`,
      ]);
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `p2p.escrow.lock:${TRADE}`)).toHaveLength(1);
      expect(formatAmount((await ledger.balance(userAvailable(SELLER, 'USDT'))).amount)).toBe('100');
      expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', TRADE))).amount)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.verifyChain()).toEqual({ ok: true });
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 60_000);

  it('persists a committed claim even when its SQL acknowledgement is lost, before any remote effect', async () => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    const ledger = new MemoryLedger();
    const posted = vi.spyOn(ledger, 'post');
    let loseClaimAck = true;
    const faultSql = new Proxy(db.sql, {
      get(target, key, receiver) {
        if (key === 'begin')
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.begin, target, args);
            if (loseClaimAck) {
              loseClaimAck = false;
              throw new Error('fixture committed claim SQL acknowledgement lost');
            }
            return result;
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const service = new P2pService(faultSql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments: new InstrumentService(faultSql),
      feeBps: 100,
    });
    await expect(service.cancelTrade(TRADE, SELLER)).rejects.toThrow(/committed claim SQL acknowledgement lost/);
    expect(posted).not.toHaveBeenCalled();
    expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('1');
    // New process/service cannot mistake the committed pre-dispatch claim for a first attempt.
    const restarted = new P2pService(db.sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments: new InstrumentService(db.sql),
      feeBps: 100,
    });
    await expect(restarted.cancelTrade(TRADE, SELLER)).rejects.toMatchObject({ code: 'p2p.escrow_lock_uncertain' });
    expect(posted).toHaveBeenCalledTimes(1);
    expect((await restarted.getTrade(TRADE)).resolution).toBeNull();
    expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('2');
    expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id=${OFFER}`)[0]?.remaining).toBe(
      '400.000000000000000000',
    );
  });

  it('cannot treat ordinal one as first after another durable claim enters the claim/post gap', async () => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    let signal!: () => void;
    let release!: () => void;
    const claimed = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdFirstCommit = true;
    const faultSql = new Proxy(db.sql, {
      get(target, key, receiver) {
        if (key === 'begin')
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.begin, target, args);
            if (holdFirstCommit) {
              holdFirstCommit = false;
              signal();
              await gate;
            }
            return result;
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const ledger = new MemoryLedger();
    const posted = vi.spyOn(ledger, 'post');
    const firstService = new P2pService(faultSql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments: new InstrumentService(faultSql),
      feeBps: 100,
    });
    const secondService = new P2pService(db.sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments: new InstrumentService(db.sql),
      feeBps: 100,
    });
    const first = firstService.cancelTrade(TRADE, SELLER).catch((error) => error);
    try {
      await claimed;
      await expect(secondService.cancelTrade(TRADE, SELLER)).rejects.toMatchObject({ code: 'p2p.escrow_lock_uncertain' });
      expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('2');
    } finally {
      release();
      expect(await first).toMatchObject({ code: 'p2p.escrow_lock_uncertain' });
    }
    expect(posted).toHaveBeenCalledTimes(2);
    expect((await secondService.getTrade(TRADE)).resolution).toBeNull();
    expect((await db.sql`SELECT remaining_amt::text AS remaining FROM p2p.offers WHERE id=${OFFER}`)[0]?.remaining).toBe(
      '400.000000000000000000',
    );
  });

  it('allows safe zero-attempt down, but re-upgrade keeps surviving claims NULL rather than inventing fresh history', async () => {
    const fresh = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    try {
      await seed(fresh.sql, 'created');
      await fresh.sql.begin(async (tx) => {
        await tx.unsafe(read('0014_p2p_escrow_lock_attempts.down.sql'));
      });
      await fresh.sql.begin(async (tx) => {
        await tx.unsafe(read('0014_p2p_escrow_lock_attempts.sql'));
      });
      expect((await fresh.sql`SELECT escrow_lock_attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.escrow_lock_attempts).toBeNull();
      await expect(
        fresh.sql.begin(async (tx) => {
          await tx.unsafe(read('0014_p2p_escrow_lock_attempts.down.sql'));
        }),
      ).rejects.toThrow(/refusing to remove unresolved/);
    } finally {
      await fresh.drop();
    }
  });

  it('preserves monotonic history and refuses down on unresolved claimed intent', async () => {
    await db.sql`TRUNCATE p2p.payment_instruments, p2p.p2p_trades, p2p.offers CASCADE`;
    await seed(db.sql, 'created');
    expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('0');
    await db.sql`UPDATE p2p.p2p_trades SET escrow_lock_attempts=escrow_lock_attempts+1 WHERE id=${TRADE}`;
    for (const value of ['0', '-1', '3', null])
      await expect(db.sql`UPDATE p2p.p2p_trades SET escrow_lock_attempts=${value}::bigint WHERE id=${TRADE}`).rejects.toThrow();
    await expect(
      db.sql.begin(async (tx) => {
        await tx.unsafe(read('0014_p2p_escrow_lock_attempts.down.sql'));
      }),
    ).rejects.toThrow(/refusing to remove unresolved/);
    expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('1');
  });

  it('preserves populated pre-counter claims as NULL unknown history on upgrade and refuses counter down', async () => {
    const legacy = await createTestDatabase({
      service: 'p2p',
      url: process.env.TEST_DATABASE_URL,
      migrations: files.filter((name) => Number(name.slice(0, 4)) < 14).map(read),
    });
    try {
      await seed(legacy.sql, 'created');
      const before = (await legacy.sql`SELECT to_jsonb(t) AS terms FROM p2p.p2p_trades t`)[0]?.terms;
      await legacy.sql.begin(async (tx) => {
        await tx.unsafe(read('0014_p2p_escrow_lock_attempts.sql'));
      });
      await legacy.sql.begin(async (tx) => {
        await tx.unsafe(read('0014_p2p_escrow_lock_attempts.sql'));
      });
      expect((await legacy.sql`SELECT to_jsonb(t)-'escrow_lock_attempts' AS terms FROM p2p.p2p_trades t`)[0]?.terms).toEqual(before);
      expect((await legacy.sql`SELECT escrow_lock_attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.escrow_lock_attempts).toBeNull();
      await expect(legacy.sql`UPDATE p2p.p2p_trades SET escrow_lock_attempts=0 WHERE id=${TRADE}`).rejects.toThrow(/unknown history/);
      const ledger = new MemoryLedger();
      const service = new P2pService(legacy.sql, ledger, new MemoryEventBus('svc-p2p'), {
        instruments: new InstrumentService(legacy.sql),
        feeBps: 100,
      });
      await expect(service.cancelTrade(TRADE, SELLER)).rejects.toMatchObject({ code: 'p2p.escrow_lock_uncertain' });
      expect((await service.getTrade(TRADE)).status).toBe('created');
      await expect(
        legacy.sql.begin(async (tx) => {
          await tx.unsafe(read('0014_p2p_escrow_lock_attempts.down.sql'));
        }),
      ).rejects.toThrow(/refusing to remove unresolved/);
    } finally {
      await legacy.drop();
    }
  });

  it('refuses a legacy opposite ruling during upgrade without rewriting populated terms', async () => {
    const legacy = await createTestDatabase({
      service: 'p2p',
      url: process.env.TEST_DATABASE_URL,
      migrations: files.filter((name) => Number(name.slice(0, 4)) < 10).map(read),
    });
    try {
      await seed(legacy.sql);
      await resolvedDispute(legacy.sql, 'refund');
      await legacy.sql`UPDATE p2p.p2p_trades SET status = 'released', resolution = 'released', resolved_at = now(), deadline_at = null WHERE id = ${TRADE}`;
      const before = await legacy.sql`SELECT to_jsonb(t) AS terms FROM p2p.p2p_trades t`;
      const ruling = await legacy.sql`SELECT to_jsonb(d) AS terms FROM p2p.p2p_disputes d`;
      for (const file of files.filter((name) => Number(name.slice(0, 4)) >= 10 && Number(name.slice(0, 4)) < 13))
        await legacy.sql.begin(async (tx) => {
          await tx.unsafe(read(file));
        });
      await expect(
        legacy.sql.begin(async (tx) => {
          await tx.unsafe(read('0013_p2p_dispute_ruling_frozen.sql'));
        }),
      ).rejects.toThrow(/opposite party/);
      expect(
        await legacy.sql`SELECT to_jsonb(t) - 'original_terms_claimed_at' - 'escrow_lock_attempts' AS terms FROM p2p.p2p_trades t`,
      ).toEqual(before);
      expect(await legacy.sql`SELECT to_jsonb(d) AS terms FROM p2p.p2p_disputes d`).toEqual(ruling);
    } finally {
      await legacy.drop();
    }
  });

  it.each(['created', 'escrowed'] as const)(
    'preserves legacy %s terms without fabricating provenance, refuses before ledger work, and reverses/repeats',
    async (status) => {
      const oldFiles = files.filter((name) => Number(name.slice(0, 4)) < 10);
      const newFiles = files.filter((name) => Number(name.slice(0, 4)) >= 10);
      const legacy = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations: oldFiles.map(read) });
      try {
        await seed(legacy.sql, status);
        const original = (await legacy.sql`SELECT to_jsonb(t) AS terms FROM p2p.p2p_trades t`)[0]?.terms;
        for (const file of newFiles)
          await legacy.sql.begin(async (tx) => {
            await tx.unsafe(read(file));
          });
        for (const file of newFiles)
          await legacy.sql.begin(async (tx) => {
            await tx.unsafe(read(file));
          });
        expect(
          (
            await legacy.sql`SELECT to_jsonb(t) - 'original_terms_claimed_at' - 'escrow_lock_attempts' - 'terms_snapshot' - 'non_instant' - 'settlement_window_seconds' - 'cash_release_seconds' AS terms FROM p2p.p2p_trades t`
          )[0]?.terms,
        ).toEqual(original);
        const row = (
          await legacy.sql`SELECT amount::text AS amount, original_terms_claimed_at, terms_snapshot, non_instant, settlement_window_seconds, cash_release_seconds FROM p2p.p2p_trades`
        )[0];
        // A legacy order reads as paid on an instant method: the profile columns arrive at their defaults.
        expect(row).toEqual({
          amount: '100.000000000000000000',
          original_terms_claimed_at: null,
          terms_snapshot: null,
          non_instant: false,
          settlement_window_seconds: null,
          cash_release_seconds: null,
        });
        await expect(legacy.sql`UPDATE p2p.p2p_trades SET original_terms_claimed_at = now() WHERE id = ${TRADE}`).rejects.toThrow();
        const ledger = new MemoryLedger();
        const posted = vi.spyOn(ledger, 'post');
        const service = new P2pService(legacy.sql, ledger, new MemoryEventBus('svc-p2p'), {
          instruments: new InstrumentService(legacy.sql),
          feeBps: 100,
        });
        await expect(service.cancelTrade(TRADE, SELLER)).rejects.toMatchObject({ code: 'p2p.escrow_terms_unproven' });
        expect(posted).not.toHaveBeenCalled();
        if (status === 'escrowed') {
          await expect(new InstrumentService(legacy.sql).revealForTrade({ tradeId: TRADE, viewerId: BUYER })).rejects.toMatchObject({
            code: 'p2p.escrow_terms_unproven',
          });
          expect((await legacy.sql`SELECT details FROM p2p.trade_payment_instruments`)[0]?.details).toEqual({
            account_reference: 'original',
          });
          expect(await legacy.sql`SELECT id FROM p2p.instrument_access_log WHERE outcome = 'revealed'`).toHaveLength(0);
        }
        for (const file of [...newFiles].reverse())
          await legacy.sql.begin(async (tx) => {
            await tx.unsafe(read(file.replace('.sql', '.down.sql')));
          });
        expect((await legacy.sql`SELECT amount::text AS amount FROM p2p.p2p_trades`)[0]).toEqual({ amount: '100.000000000000000000' });
        for (const file of newFiles)
          await legacy.sql.begin(async (tx) => {
            await tx.unsafe(read(file));
          });
        expect((await legacy.sql`SELECT original_terms_claimed_at FROM p2p.p2p_trades`)[0]?.original_terms_claimed_at).toBeNull();
      } finally {
        await legacy.drop();
      }
    },
  );
});
