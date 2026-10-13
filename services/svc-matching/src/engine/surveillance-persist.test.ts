import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { FileJournal, MemoryJournal, replay, type EngineJournal, type JournalCommand, type JournalRecord } from './journal.js';
import type { EngineOrder, EngineSurveillanceCase, OrderSide } from './types.js';
import { AUTO_CLOSE_FORBIDDEN, closeSurveillanceCase } from './surveillance-case.js';
import {
  AUTO_ADJUDICATE_FORBIDDEN,
  DETECTOR_GAP,
  adjudicateSurveillanceCase,
  detectorGap,
  installSurveillancePersist,
  layeringThresholdUnset,
  recordOpenSurveillanceCase,
  runDetector,
  spoofingThresholdUnset,
  type AdjudicateRefuse,
  type DetectorRefuse,
  type DetectorStatus,
} from './surveillance-persist.js';

installSurveillancePersist();

/**
 * H9 — journal open cases (not an in-process Map alone).
 * Spoofing/layering refuse auto-adjudicate. Unset thresholds are detector_gap, never 0.
 * No fines. No invented magnitudes.
 */

const MARKET = 'BTC/USDT';
const OWN = '11111111-1111-4111-8111-111111111111';
const TAKE = '22222222-2222-4222-8222-222222222222';

type PersistEngine = MatchingEngine & {
  adjudicateSurveillanceCase(cmd: { readonly reason?: string | null }): AdjudicateRefuse;
  detectorStatus(reason: string): DetectorStatus;
  runDetector(reason: string): DetectorRefuse;
};

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: parseAmount(spec.price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 }) as PersistEngine;
  return { journal, bus, engine };
}

/** Match appends succeed. The surveillance read or append after accept throws. */
class FaultAfterAcceptJournal implements EngineJournal {
  private readonly inner = new MemoryJournal();

  constructor(private readonly fault: 'read' | 'append') {}

  append(command: JournalCommand): JournalRecord {
    if (this.fault === 'append' && command.kind === 'open_surveillance') {
      throw new Error('journal append failed');
    }
    return this.inner.append(command);
  }

  read(): readonly JournalRecord[] {
    if (this.fault === 'read') throw new Error('journal read failed');
    return this.inner.read();
  }

  get length(): number {
    return this.inner.length;
  }

  close(): void {
    this.inner.close();
  }

  recorded(): readonly JournalRecord[] {
    return this.inner.read();
  }
}

function spoofingCase(): EngineSurveillanceCase {
  return { accountId: 'desk', marketId: MARKET, reason: 'spoofing', status: 'open' };
}

function layeringCase(): EngineSurveillanceCase {
  return { accountId: 'desk', marketId: MARKET, reason: 'layering', status: 'open' };
}

describe('surveillance persist — open cases survive recover; no auto-adjudicate; detector_gap', () => {
  it('named spoofing case persists across recover wrap', async () => {
    const { engine } = build();
    const opened = recordOpenSurveillanceCase(engine, {
      accountId: 'desk',
      marketId: MARKET,
      reason: 'spoofing',
    });
    expect(opened).toEqual({ ok: true, case: spoofingCase() });
    expect(engine.openSurveillanceCases()).toEqual([spoofingCase()]);

    await engine.recover();

    const persisted = engine.openSurveillanceCases();
    expect(persisted).toEqual([spoofingCase()]);
    expect(persisted[0]!.status).toBe('open');
    expect(persisted[0]).not.toHaveProperty('closed');
  });

  it('spoofing/layering stay open; adjudicate refuses auto_adjudicate_forbidden', () => {
    const { engine } = build();
    recordOpenSurveillanceCase(engine, { accountId: 'desk', marketId: MARKET, reason: 'spoofing' });
    recordOpenSurveillanceCase(engine, { accountId: 'desk', marketId: MARKET, reason: 'layering' });

    const spoof = engine.adjudicateSurveillanceCase({ reason: 'spoofing' });
    const layer = engine.adjudicateSurveillanceCase({ reason: 'layering' });
    const self = engine.adjudicateSurveillanceCase({ reason: 'self_trade' });
    const direct = adjudicateSurveillanceCase({ reason: 'spoofing' });

    expect(spoof).toMatchObject({ ok: false, code: AUTO_ADJUDICATE_FORBIDDEN });
    expect(layer).toMatchObject({ ok: false, code: AUTO_ADJUDICATE_FORBIDDEN });
    expect(self).toMatchObject({ ok: false, code: AUTO_ADJUDICATE_FORBIDDEN });
    expect(direct).toMatchObject({ ok: false, code: AUTO_ADJUDICATE_FORBIDDEN });

    const open = engine.openSurveillanceCases();
    expect(open).toEqual([layeringCase(), spoofingCase()]);
    expect(open.every((row) => row.status === 'open')).toBe(true);
  });

  it('detectorStatus spoofing is disabled detector_gap with threshold null not 0; runDetector invents no case', () => {
    const { engine } = build();
    expect(spoofingThresholdUnset()).toBe(true);
    expect(layeringThresholdUnset()).toBe(true);

    const status = engine.detectorStatus('spoofing');
    const direct = detectorGap('spoofing');
    expect(status.enabled).toBe(false);
    expect(status.gap).toBe(DETECTOR_GAP);
    expect(status.threshold).toBeNull();
    expect(status.threshold).not.toBe(0);
    expect(direct.enabled).toBe(false);
    expect(direct.gap).toBe(DETECTOR_GAP);
    expect(direct.threshold).toBeNull();
    expect(direct.threshold).not.toBe(0);
    expect('threshold' in status && status.threshold === 0).toBe(false);

    const ran = engine.runDetector('spoofing');
    const ranDirect = runDetector('layering');
    expect(ran.ok).toBe(false);
    expect(ran.code).toBe(DETECTOR_GAP);
    expect(ran.gap).toBe(DETECTOR_GAP);
    expect(ran.threshold).toBeNull();
    expect(ran.threshold).not.toBe(0);
    expect('case' in ran).toBe(false);
    expect(ranDirect.ok).toBe(false);
    expect(ranDirect.code).toBe(DETECTOR_GAP);
    expect('case' in ranDirect).toBe(false);
    expect(engine.openSurveillanceCases()).toEqual([]);
  });

  it('self_trade mill still opens; closeSurveillanceCase still auto_close_forbidden', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: OWN, account: 'same', side: 'buy', qty: '1', price: '100' }));
    const take = await engine.submit(MARKET, order({ id: TAKE, account: 'same', side: 'sell', qty: '1', price: '100' }));

    const named: EngineSurveillanceCase = {
      accountId: 'same',
      marketId: MARKET,
      reason: 'self_trade',
      status: 'open',
    };
    expect(take.accepted).toBe(true);
    expect(take.surveillanceCases).toEqual([named]);
    expect(engine.openSurveillanceCases()).toEqual([named]);
    expect(engine.openSurveillanceCases()).toHaveLength(1);

    await engine.recover();
    expect(engine.openSurveillanceCases()).toEqual([named]);

    expect(closeSurveillanceCase()).toMatchObject({ ok: false, code: AUTO_CLOSE_FORBIDDEN });
    expect(engine.openSurveillanceCases()[0]!.status).toBe('open');
  });

  it('no MATCHING_SURVEILLANCE_ env invented', () => {
    expect(spoofingThresholdUnset()).toBe(true);
    expect(layeringThresholdUnset()).toBe(true);
    expect(Object.keys(process.env).filter((key) => key.startsWith('MATCHING_SURVEILLANCE_'))).toEqual([]);
  });

  it('FileJournal encode of open_surveillance keeps account, market, named reason — no fine', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'matching-h9-surv-')), 'engine.ndjson');
    const journal = new FileJournal(path);
    journal.append({
      kind: 'open_surveillance',
      marketId: MARKET,
      at: '2026-09-03T00:00:00.000Z',
      accountId: 'desk',
      reason: 'spoofing',
    });
    journal.close();

    const onDisk = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    expect(onDisk.kind).toBe('open_surveillance');
    expect(onDisk.accountId).toBe('desk');
    expect(onDisk.marketId).toBe(MARKET);
    expect(onDisk.reason).toBe('spoofing');
    expect(onDisk).not.toHaveProperty('fine');
    expect(onDisk).not.toHaveProperty('amount');
    expect(onDisk).not.toHaveProperty('orderId');
  });

  it('named spoofing/layering survive a new engine recover from FileJournal', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'matching-h9-surv-')), 'engine.ndjson');
    const j1 = new FileJournal(path);
    const live = new MatchingEngine({ journal: j1, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    recordOpenSurveillanceCase(live, { accountId: 'desk', marketId: MARKET, reason: 'spoofing' });
    recordOpenSurveillanceCase(live, { accountId: 'desk', marketId: MARKET, reason: 'layering' });
    j1.close();

    const j2 = new FileJournal(path);
    const recovered = new MatchingEngine({ journal: j2, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    await recovered.recover();

    const open = recovered.openSurveillanceCases();
    expect(open).toEqual([layeringCase(), spoofingCase()]);
    expect(open.every((row) => row.status === 'open')).toBe(true);
    expect(open[0]).not.toHaveProperty('fine');
    expect(j2.read().filter((row) => row.kind === 'open_surveillance')).toHaveLength(2);
    expect(replay(j2.read()).size).toBe(0);
    j2.close();
  });

  it('self_trade from FileJournal submit replay stays open; replay does not cancel from open_surveillance', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'matching-h9-surv-')), 'engine.ndjson');
    const j1 = new FileJournal(path);
    const live = new MatchingEngine({ journal: j1, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    await live.submit(MARKET, order({ id: OWN, account: 'same', side: 'buy', qty: '1', price: '100' }));
    await live.submit(MARKET, order({ id: TAKE, account: 'same', side: 'sell', qty: '1', price: '100' }));
    expect(live.openSurveillanceCases()).toEqual([{ accountId: 'same', marketId: MARKET, reason: 'self_trade', status: 'open' }]);
    j1.close();

    const j2 = new FileJournal(path);
    const recovered = new MatchingEngine({ journal: j2, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    await recovered.recover();
    expect(recovered.openSurveillanceCases()).toEqual([{ accountId: 'same', marketId: MARKET, reason: 'self_trade', status: 'open' }]);
    expect(j2.read().some((row) => row.kind === 'open_surveillance')).toBe(true);
    expect(j2.read().some((row) => row.kind === 'cancel')).toBe(false);
    j2.close();
  });

  it.each(['read', 'append'] as const)(
    'returns the accepted SubmitResult when the journal throws on %s after a matched submit',
    async (fault) => {
      const journal = new FaultAfterAcceptJournal(fault);
      const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
      await engine.submit(MARKET, order({ id: OWN, account: 'same', side: 'buy', qty: '1', price: '100' }));
      const take = await engine.submit(MARKET, order({ id: TAKE, account: 'same', side: 'sell', qty: '1', price: '100' }));

      expect(take.accepted).toBe(true);
      expect(take.rejected).toBeUndefined();
      expect(take.fills).toEqual([]);
      expect(take.resting?.orderId).toBe(TAKE);
      expect(take.resting?.remaining).toEqual(parseAmount('1'));
      expect(take.cancellations.map((row) => ({ orderId: row.orderId, reason: row.reason }))).toEqual([
        { orderId: OWN, reason: 'self_trade_prevention' },
      ]);
      expect(take.surveillanceCases).toEqual([{ accountId: 'same', marketId: MARKET, reason: 'self_trade', status: 'open' }]);
      expect(engine.book(MARKET).toState().asks[0]?.orders[0]).toMatchObject({ orderId: TAKE, remaining: '1' });
      expect(engine.book(MARKET).toState().bids).toEqual([]);
      expect(journal.recorded().map((row) => row.kind)).toEqual(['submit', 'submit']);
    },
  );
});
