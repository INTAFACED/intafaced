/**
 * A market's trading mode, set by two operators (SP-developer-status-01; J-cex-spot-14 #3 #4). Real Postgres via
 * TEST_DATABASE_URL. The write appends one APPLIED transition to the lifecycle evidence, the record order admission
 * reads; a retry of the approved change writes nothing new; a mode change under someone else's refuses as stale.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { AuthError } from '@intafaced/auth';
import { marketStateSnapshotSchema } from '@intafaced/exchange-contract';
import { TradeService } from '../controls/test-admission.js';
import { decideMarketAction } from '../market-lifecycle.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { MemoryApprovalBook, TradeOpsError } from './common.js';
import { MARKET_MODE_SET_ACTION, MarketModeAdmin, marketModePayloadHash } from './market-mode.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);
const reader = () => principalFor(OP, ['admin:read']);
const REASON = 'TEST: limit-only for the journey';

describe('market trading mode (two-person)', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let modes: MarketModeAdmin;
  let now: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_audit, trade.market_lifecycle_evidence, trade.fills, trade.orders, trade.markets
      RESTART IDENTITY CASCADE`;
    const trade = new TradeService(db.sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    await trade.listMarket({
      symbol: 'ETH/USDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: null,
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    book = new MemoryApprovalBook();
    now = new Date('2026-11-06T08:00:00.000Z');
    modes = new MarketModeAdmin({ sql: db.sql, approvals: book, now: () => now });
  });

  function approve(approvalId: string, mode: string, expectedMode: string, expectedVersion: string, approverId = APPROVER) {
    book.put({
      approvalId,
      actionType: MARKET_MODE_SET_ACTION,
      targetService: 'svc-trade',
      targetId: 'market-mode:ETH/USDT',
      expectedVersion,
      payloadHash: marketModePayloadHash({ symbol: 'ETH/USDT', mode, expectedMode, reason: REASON }),
      requesterId: OP,
      approverId,
      operationId: `op-${approvalId}`,
    });
  }
  const set = (approvalId: string, mode: 'OPEN' | 'LIMIT_ONLY' | 'CANCEL_ONLY' | 'POST_ONLY', expectedMode: string) =>
    modes.set(writer(), { symbol: 'ETH/USDT', mode, expectedMode, reason: REASON, approvalId, operationId: `op-${approvalId}` });

  async function transitions() {
    return db.sql<Array<{ transition: { resolvedState: string; reasonCode: string; approvalRefs: string[] } }>>`
      SELECT transition FROM trade.market_lifecycle_evidence WHERE evidence_kind = 'TRANSITION' ORDER BY observed_at`;
  }

  it('reads OPEN when no mode was ever set', async () => {
    const view = await modes.get(reader(), 'ETH/USDT');
    expect(view).toMatchObject({ symbol: 'ETH/USDT', mode: 'OPEN', transitionId: null, effectiveAt: null });
  });

  it('sets limit-only with a second operator, appends one applied transition and an audit row', async () => {
    approve('a1', 'LIMIT_ONLY', 'OPEN', 'none');
    const view = await set('a1', 'LIMIT_ONLY', 'OPEN');
    expect(view.mode).toBe('LIMIT_ONLY');
    expect(view.effectiveAt).toBe(now.toISOString());
    const rows = await transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transition).toMatchObject({
      resolvedState: 'LIMIT_ONLY',
      reasonCode: 'trade.mode_limit_only',
      approvalRefs: ['approval:a1', `approver:${APPROVER}`],
    });
    const audit = await db.sql`SELECT kind, approver_id, reason FROM trade.operator_audit WHERE kind = 'market_mode'`;
    expect(audit).toEqual([{ kind: 'market_mode', approver_id: APPROVER, reason: REASON }]);
  });

  it('a retry of the approved change answers its own first record and writes nothing new, even after a later change', async () => {
    approve('a1', 'LIMIT_ONLY', 'OPEN', 'none');
    const first = await set('a1', 'LIMIT_ONLY', 'OPEN');
    const again = await set('a1', 'LIMIT_ONLY', 'OPEN');
    expect(again).toEqual(first);
    approve('a2', 'OPEN', 'LIMIT_ONLY', first.transitionId!);
    await set('a2', 'OPEN', 'LIMIT_ONLY');
    expect((await set('a1', 'LIMIT_ONLY', 'OPEN')).mode).toBe('LIMIT_ONLY');
    expect(await transitions()).toHaveLength(2);
  });

  it('a later change is never timed before the one it follows, so the lifecycle read takes it as latest', async () => {
    approve('a1', 'LIMIT_ONLY', 'OPEN', 'none');
    const first = await set('a1', 'LIMIT_ONLY', 'OPEN');
    now = new Date('2026-11-06T07:59:00.000Z'); // this writer's clock is behind the first
    approve('a2', 'CANCEL_ONLY', 'LIMIT_ONLY', first.transitionId!);
    const second = await set('a2', 'CANCEL_ONLY', 'LIMIT_ONLY');
    expect(Date.parse(second.effectiveAt!)).toBeGreaterThan(Date.parse(first.effectiveAt!));
    expect((await modes.get(reader(), 'ETH/USDT')).mode).toBe('CANCEL_ONLY');
  });

  it('refuses on a listing that is not active: its halt, delist or pending state wins over any mode', async () => {
    await db.sql`UPDATE trade.markets SET status = 'halted' WHERE symbol = 'ETH/USDT'`;
    approve('a1', 'LIMIT_ONLY', 'OPEN', 'none');
    await expect(set('a1', 'LIMIT_ONLY', 'OPEN')).rejects.toMatchObject({ code: 'trade.market_mode_listing_not_active' });
    expect((await modes.get(reader(), 'ETH/USDT')).listingStatus).toBe('halted');
    expect(await transitions()).toHaveLength(0);
  });

  it('refuses a futures market: this door sets spot modes only', async () => {
    await db.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        '55555555-5555-4555-8555-555555555555', 'SOL-PERP', 'SOL', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1',
        10, 20, 'active', 'SOL perpetual', now()
      )`;
    await expect(
      modes.set(writer(), {
        symbol: 'SOL-PERP',
        mode: 'LIMIT_ONLY',
        expectedMode: 'OPEN',
        reason: REASON,
        approvalId: 'f1',
        operationId: 'op-f1',
      }),
    ).rejects.toMatchObject({ code: 'trade.market_mode_unsupported' });
    expect(await transitions()).toHaveLength(0);
  });

  /** A transition another door wrote (matching's halt, a partial apply), stored as the lifecycle read stores it. */
  async function foreign(state: string, outcome: Record<string, unknown>, resolvedState: string | null = state) {
    const [market] = await db.sql<Array<{ id: string }>>`SELECT id FROM trade.markets WHERE symbol = 'ETH/USDT'`;
    const record = {
      transitionId: `foreign-${state}`,
      idempotencyKey: `foreign:${state}`,
      marketId: market!.id,
      expectedState: 'OPEN',
      expectedRuleVersion: '1',
      requestedState: state,
      resolvedState,
      reasonCategory: 'OPERATOR',
      reasonCode: 'trade.market_halted',
      actorId: OP,
      authorityRef: 'authority:matching',
      approvalRefs: [],
      requestedAt: '2026-11-06T07:00:00.000Z',
      effectiveAt: '2026-11-06T07:00:00.000Z',
      expiresAt: null,
      recoveryEvidenceRefs: [],
      outcome,
    };
    await db.sql`INSERT INTO trade.market_lifecycle_evidence (evidence_id, market_id, evidence_kind, transition, observed_at)
      VALUES (${record.transitionId}, ${market!.id}, 'TRANSITION', ${JSON.stringify(record)}::text::jsonb, ${record.requestedAt}::timestamptz)`;
    return record.transitionId;
  }

  it('never overwrites a partial or unknown transition: it needs recovery evidence first', async () => {
    // The contract keeps a partial transition's resolved state null; before this door refused it, null read as OPEN.
    const id = await foreign('LIMIT_ONLY', { outcome: 'PARTIAL', appliedTargets: ['market-1'], unresolvedTargets: ['engine-1'] }, null);
    approve('a1', 'LIMIT_ONLY', 'OPEN', id);
    await expect(set('a1', 'LIMIT_ONLY', 'OPEN')).rejects.toMatchObject({ code: 'trade.market_mode_recovery_required' });
    await expect(modes.get(reader(), 'ETH/USDT')).rejects.toMatchObject({ code: 'trade.market_mode_recovery_required' });
    expect(await transitions()).toHaveLength(1);
  });

  it('never lifts a state another door owns (a stored halt)', async () => {
    const id = await foreign('HALTED', { outcome: 'APPLIED', appliedTargets: ['market-1'], unresolvedTargets: [] });
    approve('a1', 'OPEN', 'HALTED', id);
    await expect(set('a1', 'OPEN', 'HALTED')).rejects.toMatchObject({ code: 'trade.market_mode_not_settable' });
    expect(await transitions()).toHaveLength(1);
  });

  it('a last transition that does not parse is not read as open', async () => {
    await db.sql`INSERT INTO trade.market_lifecycle_evidence (evidence_id, market_id, evidence_kind, transition, observed_at)
      SELECT 'broken', id, 'TRANSITION', '{"not":"a transition"}'::jsonb, now() FROM trade.markets WHERE symbol = 'ETH/USDT'`;
    await expect(modes.get(reader(), 'ETH/USDT')).rejects.toMatchObject({ code: 'trade.market_mode_recovery_required' });
  });

  it('cancel-only refuses a new order with trade.mode_cancel_only and admits a cancel', async () => {
    approve('a1', 'CANCEL_ONLY', 'OPEN', 'none');
    const view = await set('a1', 'CANCEL_ONLY', 'OPEN');
    const [row] = await transitions();
    expect(row!.transition.reasonCode).toBe('trade.mode_cancel_only');
    // The snapshot order admission derives from this transition names the state and its reason.
    const snapshot = marketStateSnapshotSchema.parse({
      ...READY_MARKET_LIFECYCLE.snapshot({ id: view.marketId } as never, { now: now.toISOString() }),
      state: 'CANCEL_ONLY',
      reasonCode: row!.transition.reasonCode,
      allowedActions: ['CANCEL'],
    });
    expect(decideMarketAction(snapshot, 'PLACE')).toMatchObject({ decision: 'REFUSED', reasonCode: 'trade.mode_cancel_only' });
    expect(decideMarketAction(snapshot, 'CANCEL').decision).toBe('ELIGIBLE');
  });

  it('back to open from limit-only binds the last transition as the approval version', async () => {
    approve('a1', 'LIMIT_ONLY', 'OPEN', 'none');
    const limited = await set('a1', 'LIMIT_ONLY', 'OPEN');
    now = new Date('2026-11-06T08:01:00.000Z');
    approve('a2', 'OPEN', 'LIMIT_ONLY', limited.transitionId!);
    expect((await set('a2', 'OPEN', 'LIMIT_ONLY')).mode).toBe('OPEN');
    expect((await transitions()).map((r) => r.transition.resolvedState)).toEqual(['LIMIT_ONLY', 'OPEN']);
  });

  it('refuses a stale expected mode, an unchanged mode, a missing or reused approval, one person, and a reader', async () => {
    await expect(set('x', 'LIMIT_ONLY', 'CANCEL_ONLY')).rejects.toMatchObject({ code: 'trade.market_mode_stale' });
    await expect(set('x', 'OPEN', 'OPEN')).rejects.toMatchObject({ code: 'trade.market_mode_unchanged' });
    await expect(set('missing', 'LIMIT_ONLY', 'OPEN')).rejects.toMatchObject({ code: 'approval_missing' });
    approve('same', 'LIMIT_ONLY', 'OPEN', 'none', OP);
    await expect(set('same', 'LIMIT_ONLY', 'OPEN')).rejects.toMatchObject({ code: 'approval_mismatch' });
    approve('wrong', 'CANCEL_ONLY', 'OPEN', 'none');
    await expect(set('wrong', 'LIMIT_ONLY', 'OPEN')).rejects.toBeInstanceOf(TradeOpsError);
    await expect(
      modes.set(reader(), {
        symbol: 'ETH/USDT',
        mode: 'LIMIT_ONLY',
        expectedMode: 'OPEN',
        reason: REASON,
        approvalId: 'z',
        operationId: 'z',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(modes.get(reader(), 'NOPE/USDT')).rejects.toMatchObject({ code: 'trade.market_not_found' });
    expect(await transitions()).toHaveLength(0);
  });
});
