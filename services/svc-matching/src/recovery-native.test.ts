import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus, type EventBus } from '@intafaced/events';
import { parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './engine/book.js';
import { MatchingEngine } from './engine/engine.js';
import { FileJournal, FileJournalLockedError } from './engine/journal.js';
import './engine/core-tif.js';
import './engine/option.js';
import './engine/mass-quote.js';
import type { MassQuoteCommand, MassQuoteResult } from './engine/mass-quote.js';
import type { EngineOrder } from './engine/types.js';
import { registerRoutes } from './router.js';
import { shutdownMatching } from './shutdown.js';

const MARKET = 'BTC-USDT';
const SECRET = 'matching-native-recovery-secret-at-least-32';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type NativeEngine = MatchingEngine & { massQuote(command: MassQuoteCommand): Promise<MassQuoteResult> };
function order(n: number, accountId: string, side: 'buy' | 'sell', over: Partial<EngineOrder> = {}): EngineOrder {
  return {
    orderId: ID(n),
    accountId,
    type: 'limit',
    side,
    qty: parseAmount('1'),
    price: parseAmount('100'),
    stopPrice: null,
    tif: 'GTC',
    ...over,
  };
}

async function fixture(run: (engine: NativeEngine, journal: FileJournal, path: string, bus: MemoryEventBus) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'matching-recovery-native-'));
  const path = join(dir, 'journal.ndjson');
  const journal = new FileJournal(path);
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, clock: () => new Date('2026-10-11T00:00:00Z'), snapshotEvery: 0 }) as NativeEngine;
  try {
    await run(engine, journal, path, bus);
  } finally {
    try {
      journal.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EBADF') throw err;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('native recovery safeguards', () => {
  it('assignment preserves fill order across writers, with the same attribution after reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-option-native-'));
    try {
      const script = `
        import { MatchingEngine } from './src/engine/engine.ts';
        import { FileJournal } from './src/engine/journal.ts';
        import { MemoryEventBus } from '@intafaced/events';
        import { parseAmount } from '@intafaced/ledger-client/money';
        const path = process.env.NATIVE_JOURNAL_PATH;
        const journal = new FileJournal(path);
        const bus = new MemoryEventBus('svc-matching');
        const clock = () => new Date('2026-10-11T00:00:00Z');
        const engine = new MatchingEngine({ journal, bus, clock, snapshotEvery: 0 });
        const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
        const order = (n, accountId, side, patch = {}) => ({ orderId: id(n), accountId, type: 'limit', side,
          qty: parseAmount('1'), price: parseAmount('10'), stopPrice: null, tif: 'GTC',
          strike: parseAmount('100'), expiry: '2026-12-31T00:00:00Z', ...patch });
        for (const [sell, buy, writer] of [[51, 52, 'writer-a'], [53, 54, 'writer-b'], [55, 56, 'writer-a']]) {
          const maker = await engine.submit('BTC-USDT', order(sell, writer, 'sell'));
          const taker = await engine.submit('BTC-USDT', order(buy, 'holder', 'buy'));
          if (!maker.accepted || !taker.accepted || taker.fills.length !== 1) throw new Error('option contract not admitted');
        }
        const applied = await engine.submit('BTC-USDT', order(57, 'holder', 'sell', { price: null, exercise: true, qty: parseAmount('2') }));
        if (!applied.accepted) throw new Error(JSON.stringify(applied.rejected));
        const before = engine.serialize();
        journal.close();
        const loaded = new FileJournal(path);
        const recoveredBus = new MemoryEventBus('svc-matching');
        const recovered = new MatchingEngine({ journal: loaded, bus: recoveredBus, clock, snapshotEvery: 0 });
        await recovered.recover();
        console.log(JSON.stringify({ makers: applied.fills.map((fill) => fill.makerOrderId),
          replayEqual: recovered.serialize() === before,
          fillEventsEqual: JSON.stringify(recoveredBus.emitted('orderFilled').map((e) => e.payload)) === JSON.stringify(bus.emitted('orderFilled').map((e) => e.payload)) }));
        loaded.close();
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type', 'module', '-e', script], {
        env: { ...process.env, NATIVE_JOURNAL_PATH: join(dir, 'journal.ndjson') },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout);
      expect(observed.makers).toEqual([ID(51), ID(53)]);
      expect(observed.replayEqual).toBe(true);
      expect(observed.fillEventsEqual).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an abandoned recover gate refuses without deleting another recoverer ownership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-recover-gate-native-'));
    const path = join(dir, 'journal.ndjson');
    let recovered: FileJournal | undefined;
    try {
      const first = new FileJournal(path);
      first.append({ kind: 'cancel', marketId: MARKET, at: '2026-10-11T00:00:00Z', orderId: ID(41) });
      first.close();
      const before = readFileSync(path, 'utf8');
      writeFileSync(`${path}.lock`, '1000000000\nstale-writer\n');
      mkdirSync(`${path}.lock.recover`);
      writeFileSync(`${path}.lock.recover/owner`, '1000000000\nstale-recoverer\n');
      expect(() => {
        recovered = new FileJournal(path);
      }).toThrow(FileJournalLockedError);
      expect(readFileSync(`${path}.lock.recover/owner`, 'utf8')).toBe('1000000000\nstale-recoverer\n');
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      recovered?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ambiguous fsync cannot admit a second input at the same journal sequence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-fsync-native-'));
    try {
      const script = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { FileJournal } from './src/engine/journal-io.ts';
        const path = process.env.NATIVE_JOURNAL_PATH;
        const journal = new FileJournal(path);
        const original = fs.fsyncSync;
        fs.fsyncSync = (fd) => { original(fd); throw new Error('fsync ACK lost'); };
        syncBuiltinESMExports();
        const command = { kind: 'cancel', marketId: 'BTC-USDT', at: '2026-10-11T00:00:00Z', orderId: 'first' };
        let firstError = '', secondError = '';
        try { journal.append(command); } catch (err) { firstError = err.message; }
        fs.fsyncSync = original;
        syncBuiltinESMExports();
        try { journal.append({ ...command, orderId: 'second' }); } catch (err) { secondError = err.message; }
        journal.close();
        const reopened = new FileJournal(path);
        console.log(JSON.stringify({ firstError, secondError, records: reopened.read() }));
        reopened.close();
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type', 'module', '-e', script], {
        env: { ...process.env, NATIVE_JOURNAL_PATH: join(dir, 'journal.ndjson') },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout);
      expect(observed.firstError).toContain('fsync ACK lost');
      expect(observed.secondError).toContain('journal_io_unknown');
      expect(observed.records).toHaveLength(1);
      expect(observed.records[0]).toMatchObject({ seq: 1, orderId: 'first' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FOK cannot count the sibling removed by its first print', () => {
    const book = new OrderBook(MARKET);
    book.submit(order(1, 'a', 'sell', { ocoSiblingId: ID(2) }));
    book.submit(order(2, 'b', 'sell', { ocoSiblingId: ID(1) }));
    const before = JSON.stringify(book.toState());
    const result = book.submit(order(3, 'taker', 'buy', { qty: parseAmount('2'), tif: 'FOK' }));
    expect(result.rejected?.code).toBe('fok_unfillable');
    expect(result.fills).toEqual([]);
    expect(JSON.stringify(book.toState())).toBe(before);
  });

  it('a lost fill publication keeps the accepted client ID claimed, including after reload', async () => {
    await fixture(async (engine, journal, path, bus) => {
      await engine.submit(MARKET, order(11, 'maker', 'sell'));
      const failing: EventBus = {
        publish: async () => {
          throw new Error('publication ACK lost');
        },
        subscribe: bus.subscribe.bind(bus),
        close: bus.close.bind(bus),
      };
      const first = new MatchingEngine({ journal, bus: failing, snapshotEvery: 0 });
      await first.recover();
      await expect(
        first.submit(MARKET, order(12, 'taker', 'buy', { clientOrderId: 'accepted-client', environment: 'paper' })),
      ).rejects.toThrow('publication ACK lost');
      const retry = await first.submit(MARKET, order(13, 'taker', 'buy', { clientOrderId: 'accepted-client', environment: 'paper' }));
      expect(retry.rejected?.code).toBe('client_order_id_reuse');
      expect(journal.read().filter((r) => r.kind === 'submit')).toHaveLength(2);
      journal.close();
      const loaded = new FileJournal(path);
      try {
        const recovered = new MatchingEngine({ journal: loaded, bus, snapshotEvery: 0 });
        await recovered.recover();
        expect(
          (await recovered.submit(MARKET, order(14, 'taker', 'buy', { clientOrderId: 'accepted-client', environment: 'paper' }))).rejected
            ?.code,
        ).toBe('client_order_id_reuse');
      } finally {
        loaded.close();
      }
    });
  });

  it('a quote leg that already filled remains APPLIED when the other side refuses', async () => {
    await fixture(async (engine, journal, path, bus) => {
      await engine.submit(MARKET, order(21, 'maker', 'sell'));
      const result = await engine.massQuote({
        setId: 'quote',
        marketId: MARKET,
        accountId: 'taker',
        bid: order(22, 'taker', 'buy'),
        ask: order(23, 'taker', 'sell', { price: null }),
      });
      expect(result.results.map((r) => r.status)).toEqual(['APPLIED', 'REFUSED']);
      expect(bus.emitted('orderFilled')).toHaveLength(1);
      const before = engine.serialize();
      journal.close();
      const loaded = new FileJournal(path);
      try {
        const recovered = new MatchingEngine({
          journal: loaded,
          bus: new MemoryEventBus('svc-matching'),
          clock: () => new Date('2026-10-11T00:00:00Z'),
          snapshotEvery: 0,
        });
        await recovered.recover();
        expect(recovered.serialize()).toBe(before);
      } finally {
        loaded.close();
      }
    });
  });

  it('strict mass-quote requests refuse unsigned and changed signed bytes before journal or order effects', async () => {
    await fixture(async (engine, journal, _path, bus) => {
      const app = Fastify();
      registerRoutes(app, engine, SECRET, { bodyBind: 'require' });
      await app.ready();
      try {
        const payload = JSON.stringify({
          setId: 'quote',
          accountId: 'a',
          bid: { orderId: ID(31), type: 'limit', qty: '1', price: '100', tif: 'GTC' },
        });
        const unsigned = await app.inject({
          method: 'POST',
          url: `/markets/${MARKET}/mass-quote`,
          headers: { 'content-type': 'application/json' },
          payload,
        });
        expect(unsigned.statusCode).toBe(401);
        const changed = await app.inject({
          method: 'POST',
          url: `/markets/${MARKET}/mass-quote`,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
          payload: payload.replace('"100"', '"101"'),
        });
        expect(changed.statusCode).toBe(401);
        const missingProof = await app.inject({
          method: 'POST',
          url: `/markets/${MARKET}/mass-quote`,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
          payload,
        });
        expect(missingProof.statusCode).toBe(400);
        expect(journal.length).toBe(0);
        expect(engine.restingOrderCount).toBe(0);
        expect(bus.published).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });

  it('two signals share one drain and cannot close a native journal before HTTP drains', async () => {
    await fixture(async (engine, journal) => {
      let release = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      const input = {
        engine,
        app: {
          close: async () => {
            calls.push('http');
            await blocked;
          },
        },
        bus: {
          close: async () => {
            calls.push('bus');
          },
        },
        journal,
        exit: () => {
          calls.push('exit');
        },
      };
      const first = shutdownMatching(input);
      const second = shutdownMatching(input);
      expect(calls).toEqual(['http']);
      expect(engine.isEnabled).toBe(false);
      release();
      await Promise.all([first, second]);
      expect(calls).toEqual(['http', 'bus', 'exit']);
    });
  });
});
