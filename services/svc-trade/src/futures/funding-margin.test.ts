import { describe, expect, it } from 'vitest';
import { parseAmount as amt, formatAmount } from '@intafaced/ledger-client';
import {
  memoryFundingMarginApplier,
  memoryFundingPeriodStore,
  netFundingPaid,
  runFundingTick,
  type FundingMarginApplier,
  type FundingTickDeps,
} from './funding-tick.js';
import type { FundingLeg } from './funding-settlement.js';
import type { PostRequest } from '@intafaced/ledger-client';

/** Test-only magnitude bound — NOT product law (D2). */
const FIXTURE_FUNDING_MAX_ABS = '1';

/**
 * After funding posts, margin_current must move with the money (mega-audit #3).
 * Without this, close/liq over-release open-time margin_initial.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function longShort() {
  return [
    {
      positionId: 'plong',
      userId: A,
      side: 'long' as const,
      size: amt('1'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    },
    {
      positionId: 'pshort',
      userId: B,
      side: 'short' as const,
      size: amt('1'),
      entryPrice: amt('50000'),
      marginAsset: 'USDT',
    },
  ];
}

describe('netFundingPaid', () => {
  it('nets payer +amount and payee −amount across legs', () => {
    const legs = [
      {
        payerPositionId: 'plong',
        payeePositionId: 'pshort',
        amount: amt('5'),
        recipe: {} as PostRequest,
      },
    ] as FundingLeg[];
    const nets = netFundingPaid(legs);
    expect(nets).toEqual(
      expect.arrayContaining([
        { positionId: 'plong', paid: amt('5') },
        { positionId: 'pshort', paid: -amt('5') },
      ]),
    );
  });
});

/**
 * THE OMISSION IS THE DEFECT (STOP §4.1, second half).
 *
 * #1047 made `applyFundingNets` idempotent on `(position, period)` and closed the
 * double-debit. It closed it for a wire that PASSES an applier. `margins` was
 * `margins?` and the call was `if (deps.margins)`, so a wire that omitted it
 * settled funding in the ledger and moved no margin at all — and then close and
 * liquidation read open-time margin and over-released collateral, which is the
 * Tier-1 defect #1034 existed to close, back through a hole the compiler
 * approved of.
 *
 * The guarantee is now a compile-time one, so the test for it has to be too. A
 * runtime assertion cannot express "this cannot be built"; `@ts-expect-error`
 * can, and it fails the typecheck gate the moment `margins` becomes optional
 * again — which is the only way this regresses.
 */
describe('a funding wire cannot forget the margin move', () => {
  const enough = {
    rates: {
      async quote({ marketId }: { marketId: string }) {
        return { rate: '0.0001', periodId: 'm1:period-required', marketId };
      },
    },
    positions: {
      async listOpenForMarket() {
        return longShort();
      },
    },
    periods: memoryFundingPeriodStore(),
    ledger: {
      async post(req: PostRequest) {
        return { id: 'tx', idempotencyKey: req.idempotencyKey } as never;
      },
    },
    maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
  };

  it('does not typecheck without a margin applier', () => {
    // @ts-expect-error — `margins` is required. If this line ever stops being an
    // error, the silent-skip defect is reachable again and this test fails.
    const incomplete: FundingTickDeps = { ...enough };
    expect(incomplete).toBeDefined();
  });

  it('moves margin on every settled tick, with no branch to skip it', async () => {
    const margins = memoryFundingMarginApplier();
    const result = await runFundingTick({ ...enough, margins, maxAbsRate: FIXTURE_FUNDING_MAX_ABS }, 'm1');

    expect(result.status).toBe('settled');
    expect(margins.applied()).toHaveLength(2);
    expect(formatAmount(margins.paidByPosition('plong'))).toBe('5');
    expect(formatAmount(margins.paidByPosition('pshort'))).toBe('-5');
  });

  it('and the memory applier models the production claim, so a replay is a no-op', async () => {
    // Guards the helper the tests above lean on: if `memoryFundingMarginApplier`
    // were a plain accumulator, every test using it would assert the opposite of
    // what 0014's claim table does.
    const margins = memoryFundingMarginApplier();
    await margins.applyFundingNets([{ positionId: 'plong', paid: amt('5') }], 'p1');
    await margins.applyFundingNets([{ positionId: 'plong', paid: amt('5') }], 'p1');
    expect(formatAmount(margins.paidByPosition('plong'))).toBe('5');

    await margins.applyFundingNets([{ positionId: 'plong', paid: amt('5') }], 'p2');
    expect(formatAmount(margins.paidByPosition('plong'))).toBe('10');
  });
});

describe('runFundingTick applies margin nets after ledger post', () => {
  it('calls margins.applyFundingNets with payer/payee nets', async () => {
    const applied: { positionId: string; paid: bigint }[] = [];
    const margins: FundingMarginApplier = {
      async applyFundingNets(nets) {
        for (const n of nets) applied.push({ positionId: n.positionId, paid: n.paid });
      },
    };
    const posts: PostRequest[] = [];
    const result = await runFundingTick(
      {
        rates: {
          async quote({ marketId }) {
            return { rate: '0.0001', periodId: 'm1:period-margin', marketId };
          },
        },
        positions: {
          async listOpenForMarket() {
            return longShort();
          },
        },
        periods: memoryFundingPeriodStore(),
        ledger: {
          async post(req) {
            posts.push(req);
            return { id: 'tx', idempotencyKey: req.idempotencyKey } as never;
          },
        },
        margins,
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
      },
      'm1',
    );
    expect(result.status).toBe('settled');
    expect(posts.length).toBeGreaterThan(0);
    expect(applied.length).toBe(2);
    const longNet = applied.find((a) => a.positionId === 'plong')!;
    const shortNet = applied.find((a) => a.positionId === 'pshort')!;
    // Positive rate: long pays short.
    expect(longNet.paid > 0n).toBe(true);
    expect(shortNet.paid < 0n).toBe(true);
    expect(longNet.paid + shortNet.paid).toBe(0n);
    // amount is rate * notional = 0.0001 * 50000 = 5
    expect(formatAmount(longNet.paid)).toBe('5');
  });

  it('hands the applier the period id — the key its idempotency turns on', async () => {
    // The applier runs between an idempotent ledger post and the settle marker,
    // so a restart in that gap replays it. It cannot be idempotent on a key it
    // was never given.
    const seen: string[] = [];
    const margins: FundingMarginApplier = {
      async applyFundingNets(_nets, periodId) {
        seen.push(periodId);
      },
    };
    await runFundingTick(
      {
        rates: {
          async quote({ marketId }) {
            return { rate: '0.0001', periodId: 'm1:period-key', marketId };
          },
        },
        positions: {
          async listOpenForMarket() {
            return longShort();
          },
        },
        periods: memoryFundingPeriodStore(),
        ledger: {
          async post() {
            return undefined as never;
          },
        },
        margins,
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
      },
      'm1',
    );
    expect(seen).toEqual(['m1:period-key']);
  });

  it('skips margin apply when no legs (zero rate)', async () => {
    let called = 0;
    const margins: FundingMarginApplier = {
      async applyFundingNets() {
        called += 1;
      },
    };
    await runFundingTick(
      {
        rates: {
          async quote({ marketId }) {
            return { rate: '0', periodId: 'm1:zero', marketId };
          },
        },
        positions: {
          async listOpenForMarket() {
            return longShort();
          },
        },
        periods: memoryFundingPeriodStore(),
        ledger: {
          async post() {
            throw new Error('must not post');
          },
        },
        margins,
        maxAbsRate: FIXTURE_FUNDING_MAX_ABS,
      },
      'm1',
    );
    expect(called).toBe(0);
  });
});
