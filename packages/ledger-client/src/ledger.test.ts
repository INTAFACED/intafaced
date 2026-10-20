import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryLedger, hashTx } from './memory-ledger.js';
import { crossShardAnchor, hashAssetTx } from './sharding.js';
import { runLedgerConformance } from './testing/conformance.js';

/**
 * The reference implementation runs the shared conformance suite — the same one
 * svc-ledger's Postgres engine runs. Everything below this line is additional
 * coverage specific to the in-memory implementation.
 */
let conformanceLedger = new MemoryLedger();
runLedgerConformance('MemoryLedger', async () => ({
  get ledger() {
    return conformanceLedger;
  },
  reset: async () => {
    conformanceLedger = new MemoryLedger();
  },
  journal: async () => conformanceLedger.journal(),
  reconcile: async () => conformanceLedger.reconcile(),
  verifyChain: async () => conformanceLedger.verifyChain(),
  totalsByAsset: async () => conformanceLedger.totalsByAsset(),
}));
import { formatAmount, parseAmount as amt, sum } from './money.js';
import { assertBalanced, assertPairedLocks, assertPurposedHolds, assertValidPost, LOCK_KINDS } from './client.js';
import { ACCOUNT_KINDS, ACCOUNT_KIND_CLASS } from './types.js';
import {
  futuresLossSink,
  houseFees,
  insuranceFund,
  marketMaker,
  marketMakerOrderHoldAccount,
  merchantClearing,
  merchantProceeds,
  orderHoldAccount,
  positionCollateralAccount,
  userAvailable,
  userEscrow,
  userHold,
  userStake,
  railBoundary,
} from './accounts.js';
import { InsufficientFundsError, InvalidEntryError, UnbalancedTransactionError } from './types.js';
import { recipes } from './recipes/index.js';

/**
 * THE LEDGER INVARIANT SUITE (§4.4 exit criteria).
 *
 * Every implementation of LedgerClient must pass this file unmodified. When
 * svc-ledger lands on Postgres, this suite is pointed at it too.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

async function fund(userId: string, assetId: string, amount: string): Promise<void> {
  await ledger.post(recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `${userId}:${assetId}:${amount}` }));
}

async function balanceOf(userId: string, assetId: string, kind: 'available' | 'hold' | 'escrow' | 'stake' = 'available', purpose = 'test') {
  const ref =
    kind === 'available'
      ? userAvailable(userId, assetId)
      : kind === 'hold'
        ? userHold(userId, assetId, purpose)
        : kind === 'escrow'
          ? userEscrow(userId, assetId, purpose)
          : userStake(userId, assetId, purpose);
  return formatAmount((await ledger.balance(ref)).amount);
}

/**
 * Total held for a user in an asset, across every purpose.
 *
 * The question "how much of this balance is locked up" is still meaningful
 * after P0-3 — it is just no longer one account. Anything asserting on a total
 * has to sum, which is the honest shape of the data.
 */
async function heldTotal(userId: string, assetId: string) {
  const all = await ledger.balances('user', userId);
  const total = all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n);
  return formatAmount(total);
}

describe('INVARIANT 1 — every transaction sums to zero per asset', () => {
  it('accepts a balanced transaction', () => {
    expect(() =>
      assertBalanced([
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('100') },
        { account: railBoundary('test', 'USDT'), direction: 'credit', amount: amt('100') },
      ]),
    ).not.toThrow();
  });

  it('rejects an unbalanced transaction and names the asset', () => {
    try {
      assertBalanced([
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('100') },
        { account: railBoundary('test', 'USDT'), direction: 'credit', amount: amt('99') },
      ]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnbalancedTransactionError);
      expect((e as UnbalancedTransactionError).perAsset.USDT).toBe('1');
    }
  });

  it('checks each asset independently — a multi-asset tx cannot net across assets', () => {
    expect(() =>
      assertBalanced([
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('100') },
        { account: userAvailable(USER_B, 'BTC'), direction: 'credit', amount: amt('100') },
      ]),
    ).toThrow(UnbalancedTransactionError);
  });

  it('rejects a single-entry transaction', () => {
    expect(() => assertBalanced([{ account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('100') }])).toThrow(
      InvalidEntryError,
    );
  });

  it('rejects zero and negative entry amounts', () => {
    expect(() =>
      assertBalanced([
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: 0n },
        { account: railBoundary('test', 'USDT'), direction: 'credit', amount: 0n },
      ]),
    ).toThrow(InvalidEntryError);

    expect(() =>
      assertBalanced([
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('-5') },
        { account: railBoundary('test', 'USDT'), direction: 'credit', amount: amt('-5') },
      ]),
    ).toThrow(InvalidEntryError);
  });
});

describe('INVARIANT 2 — available never goes negative', () => {
  it('refuses to overdraw a user', async () => {
    await fund(USER_A, 'USDT', '100');
    await expect(
      ledger.post(
        recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('100.000000000000000001'), rail: 'test', withdrawalId: 'w1' }),
      ),
    ).rejects.toThrow(InsufficientFundsError);
    expect(await balanceOf(USER_A, 'USDT')).toBe('100');
  });

  it('allows a withdrawal to exactly zero', async () => {
    await fund(USER_A, 'USDT', '100');
    await ledger.post(recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('100'), rail: 'test', withdrawalId: 'w1' }));
    expect(await balanceOf(USER_A, 'USDT')).toBe('0');
    expect(await heldTotal(USER_A, 'USDT')).toBe('100');
  });

  // ── P0-3 · a hold belongs to one purpose ────────────────────────────────────
  //
  // These are the tests the fix exists for. Every one of them PASSED before the
  // fix in the sense that the ledger accepted the posting and the books
  // balanced — which is exactly what made the bug dangerous. The assertion that
  // changed is not "does it balance" but "whose money moved".

  it('a withdrawal cannot settle out of an open order’s reservation', async () => {
    await fund(USER_A, 'USDT', '100');

    // 100 reserved for an open order. Available is now 0.
    await ledger.post(recipes.orderHold({ orderId: 'o-live', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
    expect(await balanceOf(USER_A, 'USDT')).toBe('0');

    // A withdrawal for the same user and asset that was never held. Before
    // P0-3 this found the order's hold — one account per (user, asset) — drew
    // it down to zero, balanced perfectly, and left the order unfunded with
    // nothing in the book recording that it had happened.
    await expect(
      ledger.post(recipes.withdrawSettle({ userId: USER_A, assetId: 'USDT', amount: amt('100'), rail: 'test', withdrawalId: 'w-raid' })),
    ).rejects.toThrow(InsufficientFundsError);

    // The order's reservation is untouched and still fully funded.
    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:o-live')).toBe('100');
    expect(await heldTotal(USER_A, 'USDT')).toBe('100');
  });

  it('an order fill cannot consume a withdrawal’s hold', async () => {
    await fund(USER_A, 'USDT', '900');
    await fund(USER_B, 'BTC', '1');

    // USER_A's funds are held for a WITHDRAWAL, not for an order.
    await ledger.post(recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('900'), rail: 'test', withdrawalId: 'w-live' }));
    await ledger.post(recipes.orderHold({ orderId: 'm-1', userId: USER_B, assetId: 'BTC', amount: amt('1') }));

    // A fill claiming an order hold that was never placed. Previously this
    // spent the withdrawal's money and paid the counterparty out of it.
    await expect(
      ledger.post(
        recipes.tradeFill({
          fillId: 'f-raid',
          makerId: USER_B,
          takerId: USER_A,
          makerOrderId: 'm-1',
          takerOrderId: 'never-placed',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          qty: amt('1'),
          quoteAmount: amt('900'),
          takerSide: 'buy',
          makerFeeBps: 0,
          takerFeeBps: 0,
        }),
      ),
    ).rejects.toThrow(InsufficientFundsError);

    expect(await balanceOf(USER_A, 'USDT', 'hold', 'withdraw:w-live')).toBe('900');
  });

  it('two orders for the same user and asset hold separately', async () => {
    await fund(USER_A, 'USDT', '300');
    await ledger.post(recipes.orderHold({ orderId: 'o-1', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(recipes.orderHold({ orderId: 'o-2', userId: USER_A, assetId: 'USDT', amount: amt('200') }));

    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:o-1')).toBe('100');
    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:o-2')).toBe('200');
    expect(await heldTotal(USER_A, 'USDT')).toBe('300');

    // Cancelling one returns exactly its own reservation — not a share of a pot.
    await ledger.post(recipes.orderHoldRelease({ orderId: 'o-1', userId: USER_A, assetId: 'USDT', amount: amt('100') }));

    expect(await balanceOf(USER_A, 'USDT')).toBe('100');
    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:o-1')).toBe('0');
    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:o-2')).toBe('200');
  });

  it('releasing one order cannot over-return by draining another’s hold', async () => {
    await fund(USER_A, 'USDT', '300');
    await ledger.post(recipes.orderHold({ orderId: 'o-1', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(recipes.orderHold({ orderId: 'o-2', userId: USER_A, assetId: 'USDT', amount: amt('200') }));

    // o-1 only ever held 100. Asking for 300 back must fail rather than reach
    // into o-2 — the release is bounded by its own account, by construction.
    await expect(
      ledger.post(recipes.orderHoldRelease({ orderId: 'o-1', userId: USER_A, assetId: 'USDT', amount: amt('300') })),
    ).rejects.toThrow(InsufficientFundsError);

    expect(await heldTotal(USER_A, 'USDT')).toBe('300');
  });

  it('refuses a hold entry with no purpose at all', () => {
    // The direct-assembly path. Recipes are the sanctioned route, not the only
    // physically possible one, so the invariant is checked at post time.
    expect(() =>
      assertValidPost({
        idempotencyKey: 'unpurposed-hold-test',
        module: 'test',
        reason: 'test',
        entries: [
          { account: userAvailable(USER_A, 'USDT'), direction: 'credit', amount: amt('1') },
          { account: { ownerType: 'user', ownerId: USER_A, assetId: 'USDT', kind: 'hold' }, direction: 'debit', amount: amt('1') },
        ],
      }),
    ).toThrow(/no purpose/);
  });

  it('refuses a lock purpose stamped legacy: — migration stamp is not a claim', () => {
    // DB 0008 refuses purpose LIKE 'legacy:%'. Pure guards must match so the
    // in-memory reference cannot accept what Postgres will reject.
    expect(() =>
      assertValidPost({
        idempotencyKey: 'legacy-purpose-test',
        module: 'test',
        reason: 'test',
        entries: [
          { account: userAvailable(USER_A, 'USDT'), direction: 'credit', amount: amt('1') },
          {
            account: { ownerType: 'user', ownerId: USER_A, assetId: 'USDT', kind: 'collateral', purpose: `legacy:${USER_A}` },
            direction: 'debit',
            amount: amt('1'),
          },
        ],
      }),
    ).toThrow(/legacy:/);
  });

  it('refuses a whitespace-only lock purpose — same failure class as empty', () => {
    // Spaces are truthy and length > 0, but they name no claim. Two holds with
    // purpose "   " share one identity and re-commingle (P0-3).
    expect(() =>
      assertValidPost({
        idempotencyKey: 'whitespace-purpose-test',
        module: 'test',
        reason: 'test',
        entries: [
          { account: userAvailable(USER_A, 'USDT'), direction: 'credit', amount: amt('1') },
          {
            account: { ownerType: 'user', ownerId: USER_A, assetId: 'USDT', kind: 'collateral', purpose: '   ' },
            direction: 'debit',
            amount: amt('1'),
          },
        ],
      }),
    ).toThrow(/no purpose/);
  });

  it('refuses purpose on available — available stays fungible', () => {
    // A purposed available opens a second pot beside the real one; recon still
    // greens while the user has two balances and can only see one.
    expect(() =>
      assertValidPost({
        idempotencyKey: 'available-purpose-test',
        module: 'test',
        reason: 'test',
        entries: [
          {
            account: { ownerType: 'user', ownerId: USER_A, assetId: 'USDT', kind: 'available', purpose: 'split' },
            direction: 'credit',
            amount: amt('1'),
          },
          {
            account: { ownerType: 'module', ownerId: 'treasury', assetId: 'USDT', kind: 'available' },
            direction: 'debit',
            amount: amt('1'),
          },
        ],
      }),
    ).toThrow(/must not carry purpose/);
  });

  it('normalises purpose so padded and bare claim strings share one pot', async () => {
    // accountPurpose trims. Without that, purpose "order:x " and "order:x" are
    // two accounts; adapters assembling AccountRef inline skip constructors.
    // Space pads were the 0011 class; tab/NBSP are the 0012 dual-book class
    // (DB bare btrim was space-only until 0012).
    const { accountKey } = await import('./client.js');
    const { accountPurpose } = await import('./types.js');
    const bare = { ownerType: 'user' as const, ownerId: USER_A, assetId: 'USDT', kind: 'hold' as const, purpose: 'order:x' };
    const padded = { ...bare, purpose: '  order:x  ' };
    const tabPadded = { ...bare, purpose: 'order:x\t' };
    const nbspPadded = { ...bare, purpose: 'order:x\u00a0' };
    expect(accountPurpose(padded)).toBe('order:x');
    expect(accountPurpose(tabPadded)).toBe('order:x');
    expect(accountPurpose(nbspPadded)).toBe('order:x');
    expect(accountKey(padded)).toBe(accountKey(bare));
    expect(accountKey(tabPadded)).toBe(accountKey(bare));
    expect(accountKey(nbspPadded)).toBe(accountKey(bare));

    // Whitespace-only purpose on available collapses to the real available pot
    // rather than opening a second balance recon cannot tell from a dual book.
    const spacesAvailable = {
      ownerType: 'user' as const,
      ownerId: USER_A,
      assetId: 'USDT',
      kind: 'available' as const,
      purpose: '   ',
    };
    const tabsAvailable = { ...spacesAvailable, purpose: '\t\t\t' };
    const realAvailable = { ownerType: 'user' as const, ownerId: USER_A, assetId: 'USDT', kind: 'available' as const };
    expect(accountPurpose(spacesAvailable)).toBe('');
    expect(accountPurpose(tabsAvailable)).toBe('');
    expect(accountKey(spacesAvailable)).toBe(accountKey(realAvailable));
    expect(accountKey(tabsAvailable)).toBe(accountKey(realAvailable));

    // Engine path: padded hold posts into the same pot as the bare purpose.
    await fund(USER_A, 'USDT', '10');
    await ledger.post({
      idempotencyKey: 'purpose-pad-hold-1',
      module: 'test',
      reason: 'test',
      entries: [
        { account: userAvailable(USER_A, 'USDT'), direction: 'credit', amount: amt('3') },
        { account: padded, direction: 'debit', amount: amt('3') },
      ],
    });
    await ledger.post({
      idempotencyKey: 'purpose-pad-release-1',
      module: 'test',
      reason: 'test',
      entries: [
        { account: bare, direction: 'credit', amount: amt('3') },
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('3') },
      ],
    });
    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:x')).toBe('0');
    expect(await balanceOf(USER_A, 'USDT')).toBe('10');
  });

  it('leaves the book untouched when a post is rejected', async () => {
    await fund(USER_A, 'USDT', '10');
    const before = ledger.journal().length;
    await expect(
      ledger.post(recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('999'), rail: 'test', withdrawalId: 'w2' })),
    ).rejects.toThrow(InsufficientFundsError);
    expect(ledger.journal().length).toBe(before);
    expect(await balanceOf(USER_A, 'USDT')).toBe('10');
  });

  it('a refused post does not leave an account or a staged balance on the book', async () => {
    const opened = '33333333-3333-4333-8333-333333333333';
    const refused = '44444444-4444-4444-8444-444444444444';
    await fund(USER_A, 'USDT', '10');

    // First entry would open `opened`. The later credit on `refused` is what
    // fails: the in-request debit has staged 3, and the book still holds nothing.
    const request = {
      idempotencyKey: 'refuse-does-not-stage-account',
      module: 'test',
      reason: 'test',
      entries: [
        { account: userAvailable(opened, 'USDT'), direction: 'debit' as const, amount: amt('7') },
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit' as const, amount: amt('4') },
        { account: userAvailable(refused, 'USDT'), direction: 'debit' as const, amount: amt('3') },
        { account: userAvailable(refused, 'USDT'), direction: 'credit' as const, amount: amt('8') },
        { account: railBoundary('test', 'USDT'), direction: 'credit' as const, amount: amt('6') },
      ],
    };

    let thrown: unknown;
    try {
      await ledger.post(request);
      expect.unreachable('should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InsufficientFundsError);
    const funds = thrown as InsufficientFundsError;
    expect(funds.requested).toBe('8');
    expect(funds.availableBalance).toBe('0');
    expect(funds.accountId).toBe('');

    expect(await ledger.getTxByKey(request.idempotencyKey)).toBeNull();
    expect(ledger.journal()).toHaveLength(1);
    expect(await balanceOf(USER_A, 'USDT')).toBe('10');
    expect(formatAmount((await ledger.balance(railBoundary('test', 'USDT'))).amount)).toBe('-10');

    for (const ownerId of [opened, refused]) {
      expect(await ledger.balances('user', ownerId)).toEqual([]);
      const read = await ledger.balance(userAvailable(ownerId, 'USDT'));
      expect(read.accountId).toBe('');
      expect(read.amount).toBe(0n);
    }

    const book = ledger as unknown as {
      accounts: Map<string, { id: string; ownerId: string }>;
      balancesByAccountId: Map<string, bigint>;
    };
    const liveIds = new Set<string>();
    for (const account of book.accounts.values()) {
      expect(account.ownerId).not.toBe(opened);
      expect(account.ownerId).not.toBe(refused);
      liveIds.add(account.id);
    }
    for (const [id, amount] of book.balancesByAccountId) {
      expect(liveIds.has(id)).toBe(true);
      expect(amount).not.toBe(0n);
    }

    await expect(ledger.post(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.getTxByKey(request.idempotencyKey)).toBeNull();

    // An account the book already holds keeps that balance. The error names it,
    // not the in-request amount (10 + 5) this throw discards.
    const overdraw = {
      idempotencyKey: 'refuse-reports-held-balance',
      module: 'test',
      reason: 'test',
      entries: [
        { account: userAvailable(USER_A, 'USDT'), direction: 'debit' as const, amount: amt('5') },
        { account: userAvailable(USER_A, 'USDT'), direction: 'credit' as const, amount: amt('20') },
        { account: railBoundary('test', 'USDT'), direction: 'debit' as const, amount: amt('15') },
      ],
    };
    const held = await ledger.balance(userAvailable(USER_A, 'USDT'));
    let overdrawn: unknown;
    try {
      await ledger.post(overdraw);
      expect.unreachable('should have thrown');
    } catch (err) {
      overdrawn = err;
    }
    expect(overdrawn).toBeInstanceOf(InsufficientFundsError);
    const heldFunds = overdrawn as InsufficientFundsError;
    expect(heldFunds.accountId).toBe(held.accountId);
    expect(heldFunds.availableBalance).toBe('10');
    expect(heldFunds.requested).toBe('20');
    expect(await balanceOf(USER_A, 'USDT')).toBe('10');
    expect(await ledger.getTxByKey(overdraw.idempotencyKey)).toBeNull();

    await ledger.post(recipes.deposit({ userId: opened, assetId: 'USDT', amount: amt('2'), rail: 'test', railRef: 'opened-after-refuse' }));
    const created = await ledger.balance(userAvailable(opened, 'USDT'));
    expect(created.accountId).not.toBe('');
    expect(created.amount).toBe(amt('2'));
    expect(await ledger.balances('user', refused)).toEqual([]);
  });

  it('lets only the treasury boundary run negative — that is the custody obligation', async () => {
    await fund(USER_A, 'USDT', '100');
    const boundary = await ledger.balance(railBoundary('test', 'USDT'));
    expect(formatAmount(boundary.amount)).toBe('-100');
  });
});

describe('INVARIANT 3 — locks are funded from the owner’s own available balance', () => {
  it('accepts a paired lock', () => {
    expect(() =>
      assertPairedLocks([
        { account: userAvailable(USER_A, 'BTC'), direction: 'credit', amount: amt('1') },
        { account: userHold(USER_A, 'BTC', 'order:test'), direction: 'debit', amount: amt('1') },
      ]),
    ).not.toThrow();
  });

  it('rejects collateral conjured without an available counter-entry', () => {
    expect(() =>
      assertPairedLocks([
        { account: houseFees('bank', 'BTC'), direction: 'credit', amount: amt('1') },
        { account: userHold(USER_A, 'BTC', 'order:test'), direction: 'debit', amount: amt('1') },
      ]),
    ).toThrow(InvalidEntryError);
  });

  it('rejects a lock larger than what the owner gave up', () => {
    expect(() =>
      assertPairedLocks([
        { account: userAvailable(USER_A, 'BTC'), direction: 'credit', amount: amt('1') },
        { account: userHold(USER_A, 'BTC', 'order:test'), direction: 'debit', amount: amt('2') },
      ]),
    ).toThrow(InvalidEntryError);
  });

  it('allows a lock plus a fee taken from the same available balance', () => {
    expect(() =>
      assertPairedLocks([
        { account: userAvailable(USER_A, 'BTC'), direction: 'credit', amount: amt('1.01') },
        { account: userHold(USER_A, 'BTC', 'order:test'), direction: 'debit', amount: amt('1') },
        { account: houseFees('trade', 'BTC'), direction: 'debit', amount: amt('0.01') },
      ]),
    ).not.toThrow();
  });

  it('does not constrain releasing a lock', () => {
    expect(() =>
      assertPairedLocks([
        { account: userHold(USER_A, 'BTC', 'order:test'), direction: 'credit', amount: amt('1') },
        { account: userAvailable(USER_B, 'BTC'), direction: 'debit', amount: amt('1') },
      ]),
    ).not.toThrow();
  });

  it('refuses a credit on an unknown kind as funding for a lock', () => {
    const unknown = {
      ...userAvailable(USER_A, 'BTC'),
      kind: 'receivable' as unknown as ReturnType<typeof userAvailable>['kind'],
    };
    const locks = [
      userHold(USER_A, 'BTC', 'order:test'),
      userEscrow(USER_A, 'BTC', 'trade:test'),
      userStake(USER_A, 'BTC', 'token:stake:test'),
      positionCollateralAccount(USER_A, 'BTC', 'test'),
    ];
    for (const lock of locks) {
      const wash = () =>
        assertPairedLocks([
          { account: unknown, direction: 'credit', amount: amt('1') },
          { account: lock, direction: 'debit', amount: amt('1') },
        ]);
      expect(wash).toThrow(InvalidEntryError);
      expect(wash).toThrow(/receivable/);
    }
  });

  /**
   * The invariant above is only as good as the list it tests `kind` against.
   *
   * That list used to be hand-written in two places, with ACCOUNT_KINDS as a
   * silent third, and nothing checked that they agreed. A kind present in the
   * enum but absent from the list is not rejected as unknown — `assertPairedLocks`
   * reads it as available balance, so a post that credits the house and debits
   * an unclassified lock pot is ACCEPTED. It sums to zero per asset, the hash
   * chain verifies, reconciliation replays clean: locked value funded by nobody,
   * invisible from every reading of the book.
   *
   * These are the three lines that would have caught it.
   */
  describe('the lock list agrees with the account-kind enum', () => {
    it('classifies every account kind — no kind is silently unclassified', () => {
      for (const kind of ACCOUNT_KINDS) {
        expect(ACCOUNT_KIND_CLASS[kind]).toBeDefined();
      }
    });

    it('locks are exactly the kinds that are not spendable', () => {
      const nonSpendable = ACCOUNT_KINDS.filter((kind) => kind !== 'available');
      expect([...LOCK_KINDS].sort()).toEqual([...nonSpendable].sort());
    });

    it('holds no kind the enum does not declare', () => {
      for (const kind of LOCK_KINDS) {
        expect(ACCOUNT_KINDS).toContain(kind);
      }
    });
  });
});

describe('INVARIANT 4 — idempotency', () => {
  it('returns the original transaction and does not double the money', async () => {
    const request = recipes.deposit({ userId: USER_A, assetId: 'USDT', amount: amt('50'), rail: 'crypto-native', railRef: '0xabc' });

    const first = await ledger.post(request);
    const second = await ledger.post(request);

    expect(second.id).toBe(first.id);
    expect(await balanceOf(USER_A, 'USDT')).toBe('50');
    expect(ledger.journal()).toHaveLength(1);
  });

  it('survives a burst of concurrent retries of the same post', async () => {
    const request = recipes.deposit({ userId: USER_A, assetId: 'USDT', amount: amt('50'), rail: 'crypto-native', railRef: '0xdef' });
    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.post(request)));

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await balanceOf(USER_A, 'USDT')).toBe('50');
  });

  it('requires a meaningful idempotency key', async () => {
    await expect(
      ledger.post({
        idempotencyKey: 'short',
        module: 'test',
        reason: 'test',
        entries: [
          { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('1') },
          { account: railBoundary('test', 'USDT'), direction: 'credit', amount: amt('1') },
        ],
      }),
    ).rejects.toThrow(InvalidEntryError);
  });
});

describe('INVARIANT 5 — hash chain', () => {
  it('chains every transaction to its predecessor', async () => {
    await fund(USER_A, 'USDT', '100');
    await fund(USER_B, 'USDT', '200');
    await ledger.post(recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('10'), rail: 'test', withdrawalId: 'w1' }));

    const journal = ledger.journal();
    expect(journal[0]?.previousHash).toBeNull();
    expect(journal[1]?.previousHash).toBe(journal[0]?.hash);
    expect(journal[2]?.previousHash).toBe(journal[1]?.hash);
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });

  it('detects tampering', async () => {
    await fund(USER_A, 'USDT', '100');
    await fund(USER_B, 'USDT', '200');

    const journal = ledger.journal();
    const target = journal[1]!;
    // Rewrite history: inflate an entry after the fact.
    (target.entries[1] as { amount: bigint }).amount = amt('999999');

    const result = ledger.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(target.id);
  });

  it('breaks when an asset hash names a forged parent instead of the prior tip', async () => {
    await fund(USER_A, 'USDT', '10');
    await fund(USER_A, 'USDT', '20');
    expect(ledger.verifyChain()).toEqual({ ok: true });

    const second = ledger.journal()[1]!;
    const assetId = second.entries[0]!.assetId;
    const forgedParent = 'f'.repeat(64);
    expect(second.previousAssetHashes?.[assetId]).not.toBe(forgedParent);

    const previousAssetHashes = { ...second.previousAssetHashes, [assetId]: forgedParent };
    const assetHashes = {
      ...second.assetHashes,
      [assetId]: hashAssetTx(second, assetId, forgedParent),
    };
    Object.assign(second, {
      previousAssetHashes,
      assetHashes,
      crossShardAnchor: crossShardAnchor(assetHashes),
    });

    expect(ledger.verifyChain()).toEqual({ ok: false, brokenAt: second.id });

    Object.assign(second, {
      hash: hashTx(
        {
          id: second.id,
          module: second.module,
          reason: second.reason,
          postedAt: second.postedAt,
          entries: second.entries,
          assetHashes: second.assetHashes,
          previousAssetHashes: second.previousAssetHashes,
          crossShardAnchor: second.crossShardAnchor,
        },
        second.previousHash,
      ),
    });
    expect(ledger.verifyChain()).toEqual({ ok: false, brokenAt: second.id });
  });

  it("keeps today's digest when a transaction omits the asset-chain fields", () => {
    const postedAt = new Date('2026-01-02T00:00:00.000Z');
    const tx = {
      id: 'tx-old',
      module: 'ledger',
      reason: 'deposit.credited',
      postedAt,
      entries: [
        {
          id: 'e1',
          txId: 'tx-old',
          accountId: 'acct',
          assetId: 'USDT',
          direction: 'debit' as const,
          amount: amt('1'),
          balanceAfter: amt('1'),
        },
      ],
    };
    const canonical = JSON.stringify({
      id: 'tx-old',
      module: 'ledger',
      reason: 'deposit.credited',
      postedAt: '2026-01-02T00:00:00.000Z',
      entries: [{ accountId: 'acct', assetId: 'USDT', direction: 'debit', amount: '1' }],
    });
    const digest = createHash('sha256').update('').update(' ').update(canonical).digest('hex');
    expect(hashTx(tx, null)).toBe(digest);

    const coveredCanonical = JSON.stringify({
      id: 'tx-old',
      module: 'ledger',
      reason: 'deposit.credited',
      postedAt: '2026-01-02T00:00:00.000Z',
      entries: [{ accountId: 'acct', assetId: 'USDT', direction: 'debit', amount: '1' }],
      assetHashes: { USDT: 'aa' },
      previousAssetHashes: { USDT: null },
      crossShardAnchor: 'bb',
    });
    const covered = createHash('sha256').update('').update(' ').update(coveredCanonical).digest('hex');
    expect(
      hashTx(
        {
          ...tx,
          assetHashes: { USDT: 'aa' },
          previousAssetHashes: { USDT: null },
          crossShardAnchor: 'bb',
        },
        null,
      ),
    ).toBe(covered);
  });
});

describe('reconciliation — snapshots must equal replay', () => {
  it('agrees after a long mixed run', async () => {
    await fund(USER_A, 'USDT', '10000');
    await fund(USER_B, 'BTC', '5');

    for (let i = 0; i < 200; i++) {
      await ledger.post(recipes.orderHold({ orderId: `o${i}`, userId: USER_A, assetId: 'USDT', amount: amt('10') }));
      await ledger.post(recipes.orderHoldRelease({ orderId: `o${i}`, userId: USER_A, assetId: 'USDT', amount: amt('10') }));
    }

    expect(ledger.reconcile()).toEqual({ ok: true });
    expect(await balanceOf(USER_A, 'USDT')).toBe('10000');
  });

  it('closes the books — every asset nets to zero across all accounts', async () => {
    await fund(USER_A, 'USDT', '1000');
    await fund(USER_B, 'BTC', '2');
    await ledger.post(recipes.orderHold({ orderId: 'h1', userId: USER_A, assetId: 'USDT', amount: amt('250') }));
    await ledger.post(recipes.escrowLock({ tradeId: 'e1', sellerId: USER_B, buyerId: USER_A, assetId: 'BTC', amount: amt('1') }));

    expect(ledger.totalsByAsset()).toEqual({ USDT: '0', BTC: '0' });
  });
});

describe('recipes — the money paths', () => {
  it('marketMakerSeedFund: rail boundary → house market-maker pot (mm-bot seed)', async () => {
    await ledger.post(
      recipes.marketMakerSeedFund({
        assetId: 'USDT',
        amount: amt('10000'),
        seedId: 'seed-1',
      }),
    );
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('10000');
    expect(formatAmount((await ledger.balance(railBoundary('mm-seed', 'USDT'))).amount)).toBe('-10000');
    // idempotent
    await ledger.post(
      recipes.marketMakerSeedFund({
        assetId: 'USDT',
        amount: amt('10000'),
        seedId: 'seed-1',
      }),
    );
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('10000');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('marketMakerOrderHold / release: inventory reserved per seed order', async () => {
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('1000'), seedId: 'seed-hold' }));
    const orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await ledger.post(recipes.marketMakerOrderHold({ orderId, assetId: 'USDT', amount: amt('100') }));
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('900');
    expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('USDT', orderId))).amount)).toBe('100');
    await ledger.post(recipes.marketMakerOrderHoldRelease({ orderId, assetId: 'USDT', amount: amt('100') }));
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('1000');
    expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('USDT', orderId))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('marketMakerMakerFill: user takes against MM seed (taker buy) — hold draw + pot receive', async () => {
    // MM seeds sell base: holds 1 BTC; user buys with 100 USDT hold.
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'mm-btc' }));
    const mmOrder = 'mm-seed-sell-1';
    await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrder, assetId: 'BTC', amount: amt('1') }));
    await fund(USER_A, 'USDT', '1000');
    const takerOrder = 'user-buy-1';
    await ledger.post(recipes.orderHold({ orderId: takerOrder, userId: USER_A, assetId: 'USDT', amount: amt('100') }));

    await ledger.post(
      recipes.marketMakerMakerFill({
        fillId: 'fill-mm-1',
        takerId: USER_A,
        makerOrderId: mmOrder,
        takerOrderId: takerOrder,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('100'),
        takerSide: 'buy',
        makerFeeBps: 0,
        takerFeeBps: 10, // 0.1% of base received
      }),
    );

    // User paid 100 USDT from hold; MM got 100 USDT into pot; MM spent 1 BTC hold;
    // user got 1 BTC - fee. 10 bps of 1 = 0.001 BTC fee → user 0.999 BTC.
    expect(formatAmount((await ledger.balance(orderHoldAccount(USER_A, 'USDT', takerOrder))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrder))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'BTC'))).amount)).toBe('0.999');
    // idempotent
    await ledger.post(
      recipes.marketMakerMakerFill({
        fillId: 'fill-mm-1',
        takerId: USER_A,
        makerOrderId: mmOrder,
        takerOrderId: takerOrder,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('100'),
        takerSide: 'buy',
        makerFeeBps: 0,
        takerFeeBps: 10,
      }),
    );
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('marketMakerMakerFill: user sells into MM bid (taker sell)', async () => {
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('1000'), seedId: 'mm-usdt' }));
    const mmOrder = 'mm-seed-buy-1';
    await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrder, assetId: 'USDT', amount: amt('100') }));
    await fund(USER_A, 'BTC', '5');
    const takerOrder = 'user-sell-1';
    await ledger.post(recipes.orderHold({ orderId: takerOrder, userId: USER_A, assetId: 'BTC', amount: amt('1') }));

    await ledger.post(
      recipes.marketMakerMakerFill({
        fillId: 'fill-mm-sell',
        takerId: USER_A,
        makerOrderId: mmOrder,
        takerOrderId: takerOrder,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('100'),
        takerSide: 'sell',
        makerFeeBps: 0,
        takerFeeBps: 10, // 0.1% of quote received = 0.1 USDT
      }),
    );

    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'USDT'))).amount)).toBe('99.9');
    expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('USDT', mmOrder))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futures margin: lock, add, release — purpose-keyed pots do not share', async () => {
    await fund(USER_A, 'USDT', '1000');

    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-a', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
    expect(await balanceOf(USER_A, 'USDT')).toBe('900');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-a'))).amount)).toBe('100');

    await ledger.post(
      recipes.futuresMarginAdd({
        positionId: 'pos-a',
        userId: USER_A,
        assetId: 'USDT',
        amount: amt('50'),
        sequence: 1,
      }),
    );
    expect(await balanceOf(USER_A, 'USDT')).toBe('850');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-a'))).amount)).toBe('150');

    // Second position uses its own pot — releasing A must not touch B.
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-b', userId: USER_A, assetId: 'USDT', amount: amt('200') }));
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-b'))).amount)).toBe('200');

    await ledger.post(
      recipes.futuresMarginRelease({
        positionId: 'pos-a',
        userId: USER_A,
        assetId: 'USDT',
        amount: amt('150'),
      }),
    );
    expect(await balanceOf(USER_A, 'USDT')).toBe('800');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-a'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-b'))).amount)).toBe('200');
    expect(ledger.totalsByAsset()).toEqual({ USDT: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futures realize loss: margin + insurance sink without inventing funds', async () => {
    await fund(USER_A, 'USDT', '100');
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-loss', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
    // Seed insurance from house fees path: deposit-like via reward reverse — use fee charge from another user
    await fund(USER_B, 'USDT', '50');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'ins-seed',
        userId: USER_B,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('50'),
      }),
    );
    // Move house fees → insurance via explicit post would need a recipe; fund insurance by realizing 0 insurance first path:
    // Post a balanced manual-equivalent: use deposit into boundary then... simpler: only test margin-only loss.
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos-loss',
        userId: USER_A,
        assetId: 'USDT',
        fromMargin: amt('100'),
        fromInsurance: amt('0'),
        lossId: 'loss-1',
      }),
    );
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-loss'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('50');
    expect(formatAmount((await ledger.balance(futuresLossSink('USDT'))).amount)).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futures insurance topup + realize loss draws fund (liq stack)', async () => {
    await fund(USER_A, 'USDT', '100');
    await fund(USER_B, 'USDT', '50');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'fee-for-ins',
        userId: USER_B,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('50'),
      }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: 'ins-1', assetId: 'USDT', amount: amt('50') }));
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('50');
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-liq', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos-liq',
        userId: USER_A,
        assetId: 'USDT',
        fromMargin: amt('100'),
        fromInsurance: amt('20'),
        lossId: 'liq-1',
      }),
    );
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('30');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futures funding: payer collateral → payee available (F5 recipe)', async () => {
    await fund(USER_A, 'USDT', '1000');
    await fund(USER_B, 'USDT', '1000');
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-long', userId: USER_A, assetId: 'USDT', amount: amt('500') }));
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-short', userId: USER_B, assetId: 'USDT', amount: amt('500') }));
    await ledger.post(
      recipes.futuresFundingPay({
        fundingId: 'mkt1:2026-07-31T00:00:00Z:pos-long',
        payerUserId: USER_A,
        payerPositionId: 'pos-long',
        payeeUserId: USER_B,
        payeePositionId: 'pos-short',
        assetId: 'USDT',
        amount: amt('10'),
      }),
    );
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-long'))).amount)).toBe('490');
    expect(await balanceOf(USER_B, 'USDT')).toBe('510'); // 500 free + 10 funding
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futures realize profit: the loser pays into the clearing pot and the winner is paid from it', async () => {
    await fund(USER_A, 'USDT', '1000');
    await fund(USER_B, 'USDT', '100');
    // Matched trade: B is the loser on the other side of A's win.
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-lose', userId: USER_B, assetId: 'USDT', amount: amt('50') }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos-lose',
        userId: USER_B,
        assetId: 'USDT',
        fromMargin: amt('40'),
        fromInsurance: 0n,
        lossId: 'close-lose-1',
      }),
    );
    expect(formatAmount((await ledger.balance(futuresLossSink('USDT'))).amount)).toBe('40');

    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-win', userId: USER_A, assetId: 'USDT', amount: amt('200') }));
    await ledger.post(
      recipes.futuresRealizeProfit({
        positionId: 'pos-win',
        userId: USER_A,
        assetId: 'USDT',
        amount: amt('40'),
        profitId: 'close-win-1',
      }),
    );
    // 1000 - 200 margin + 40 profit = 840 available
    expect(await balanceOf(USER_A, 'USDT')).toBe('840');
    expect(formatAmount((await ledger.balance(futuresLossSink('USDT'))).amount)).toBe('0');
    // House trade fees never pay a winner.
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0');
    // residual margin still locked until release
    expect(formatAmount((await ledger.balance(positionCollateralAccount(USER_A, 'USDT', 'pos-win'))).amount)).toBe('200');
    await ledger.post(
      recipes.futuresMarginRelease({
        positionId: 'pos-win',
        userId: USER_A,
        assetId: 'USDT',
        amount: amt('200'),
        sequence: 1,
      }),
    );
    expect(await balanceOf(USER_A, 'USDT')).toBe('1040');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futures realize profit: an empty clearing pot refuses even when house trade fees hold money', async () => {
    await fund(USER_A, 'USDT', '1000');
    await fund(USER_B, 'USDT', '100');
    await ledger.post(
      recipes.feeCharge({ chargeId: 'fees-only', userId: USER_B, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('100') }),
    );
    await expect(
      ledger.post(
        recipes.futuresRealizeProfit({
          positionId: 'pos-win',
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('40'),
          profitId: 'close-win-empty',
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balanceOf(USER_A, 'USDT')).toBe('1000');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('100');
    expect(await ledger.getTxByKey('futures.profit:close-win-empty')).toBeNull();
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('trade fill: six entries, fees to house, books closed', async () => {
    await fund(USER_A, 'USDT', '1000'); // taker, buying
    await fund(USER_B, 'BTC', '2'); // maker, selling

    await ledger.post(recipes.orderHold({ orderId: 'taker-1', userId: USER_A, assetId: 'USDT', amount: amt('900') }));
    await ledger.post(recipes.orderHold({ orderId: 'maker-1', userId: USER_B, assetId: 'BTC', amount: amt('1') }));

    const tx = await ledger.post(
      recipes.tradeFill({
        fillId: 'f1',
        makerId: USER_B,
        takerId: USER_A,
        makerOrderId: 'maker-1',
        takerOrderId: 'taker-1',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('900'),
        takerSide: 'buy',
        makerFeeBps: 10, // maker receives USDT, pays 0.10% => 0.9
        takerFeeBps: 20, // taker receives BTC,  pays 0.20% => 0.002
      }),
    );

    expect(tx.entries).toHaveLength(6);

    expect(await balanceOf(USER_B, 'USDT')).toBe('899.1');
    expect(await balanceOf(USER_A, 'BTC')).toBe('0.998');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0.9');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'BTC'))).amount)).toBe('0.002');

    // Holds fully consumed.
    expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:taker-1')).toBe('0');
    expect(await balanceOf(USER_B, 'BTC', 'hold', 'order:maker-1')).toBe('0');

    expect(ledger.totalsByAsset()).toEqual({ USDT: '0', BTC: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('trade fill: a taker selling is the exact mirror', async () => {
    await fund(USER_A, 'BTC', '1'); // taker, selling
    await fund(USER_B, 'USDT', '900'); // maker, buying

    await ledger.post(recipes.orderHold({ orderId: 't2', userId: USER_A, assetId: 'BTC', amount: amt('1') }));
    await ledger.post(recipes.orderHold({ orderId: 'm2', userId: USER_B, assetId: 'USDT', amount: amt('900') }));

    await ledger.post(
      recipes.tradeFill({
        fillId: 'f2',
        makerId: USER_B,
        takerId: USER_A,
        makerOrderId: 'm2',
        takerOrderId: 't2',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('900'),
        takerSide: 'sell',
        makerFeeBps: 10, // maker receives BTC
        takerFeeBps: 20, // taker receives USDT
      }),
    );

    expect(await balanceOf(USER_A, 'USDT')).toBe('898.2'); // 900 − 0.2%
    expect(await balanceOf(USER_B, 'BTC')).toBe('0.999'); // 1 − 0.1%
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
  });

  /**
   * A fee EXACTLY equal to the receivable — the case the old `< 0n` guard let
   * through.
   *
   * `mulBps` rounds `ceil` by design, so a 1-wei receivable with any non-zero
   * fee rate produces `fee === amount` and the recipe emitted a zero-amount
   * entry. `assertBalanced` then threw "a movement of nothing is not a
   * movement" — four layers below the actual cause, naming nothing an operator
   * could act on.
   *
   * Worse than a rejected post: `settleFill` inserts the fill rows into
   * `trade.fills` BEFORE posting, and the README documents that ordering as
   * safe because re-running heals it. For this class re-running throws every
   * time, so the fill is permanently unpostable and the table stays permanently
   * ahead of the ledger. `drizzle/0000_trade_init.sql:95` allows a market grid
   * whose `tick_size * lot_size` is exactly one wei, so the trigger is a legal
   * listing, not an exotic input.
   */
  it('trade fill: refuses a fee exactly equal to the receivable, and says why', () => {
    const oneWei = 1n;

    expect(() =>
      recipes.tradeFill({
        fillId: 'f-dust',
        makerId: USER_B,
        takerId: USER_A,
        makerOrderId: 'maker-dust',
        takerOrderId: 'taker-dust',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: oneWei,
        quoteAmount: oneWei,
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20, // ceil(1 wei × 0.20%) === 1 wei — the whole receivable
      }),
    ).toThrow(/Fee exceeds fill value/);
  });

  it('market-maker fill: the same guard, the same message', () => {
    expect(() =>
      recipes.marketMakerMakerFill({
        fillId: 'mm-dust',
        takerId: USER_A,
        makerOrderId: 'maker-mm-dust',
        takerOrderId: 'taker-mm-dust',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: 1n,
        quoteAmount: 1n,
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20,
      }),
    ).toThrow(/Fee exceeds fill value/);
  });

  it('p2p escrow: lock → release strands nothing', async () => {
    await fund(USER_A, 'USDT', '500');

    await ledger.post(recipes.escrowLock({ tradeId: 't1', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('500') }));
    expect(await balanceOf(USER_A, 'USDT')).toBe('0');
    expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:t1')).toBe('500');

    await ledger.post(
      recipes.escrowRelease({ tradeId: 't1', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('500'), feeBps: 20 }),
    );

    expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:t1')).toBe('0');
    expect(await balanceOf(USER_B, 'USDT')).toBe('499');
    expect(formatAmount((await ledger.balance(houseFees('p2p', 'USDT'))).amount)).toBe('1');
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('p2p escrowRelease refuses feeBps 10000 (buyer would receive nothing)', () => {
    expect(() =>
      recipes.escrowRelease({
        tradeId: 't-fee-100',
        sellerId: USER_A,
        buyerId: USER_B,
        assetId: 'USDT',
        amount: amt('500'),
        feeBps: 10_000,
      }),
    ).toThrow(/feeBps must be an integer in 0\.\.9999/);
  });

  it('p2p escrowRelease refuses feeBps 20000 (buyer leg would go negative)', () => {
    expect(() =>
      recipes.escrowRelease({
        tradeId: 't-fee-200',
        sellerId: USER_A,
        buyerId: USER_B,
        assetId: 'USDT',
        amount: amt('500'),
        feeBps: 20_000,
      }),
    ).toThrow(/feeBps must be an integer in 0\.\.9999/);
  });

  it('p2p escrowRelease refuses zero buyer leg at rounding floor even under 9999 bps', () => {
    // 1 wei amount + any positive fee ceil → fee == amount → buyer 0.
    expect(() =>
      recipes.escrowRelease({
        tradeId: 't-dust',
        sellerId: USER_A,
        buyerId: USER_B,
        assetId: 'USDT',
        amount: 1n,
        feeBps: 1,
      }),
    ).toThrow(/Fee exceeds escrow value/);
  });

  it('p2p escrow: refund returns the seller to whole', async () => {
    await fund(USER_A, 'USDT', '500');
    await ledger.post(recipes.escrowLock({ tradeId: 't2', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('500') }));
    await ledger.post(recipes.escrowRefund({ tradeId: 't2', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('500') }));

    expect(await balanceOf(USER_A, 'USDT')).toBe('500');
    expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:t2')).toBe('0');
  });

  it('L3-4: two escrows for one seller — over-release on A cannot drain B', async () => {
    await fund(USER_A, 'USDT', '150');
    await ledger.post(recipes.escrowLock({ tradeId: 'a', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(recipes.escrowLock({ tradeId: 'b', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('50') }));
    expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:a')).toBe('100');
    expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:b')).toBe('50');

    await expect(
      ledger.post(recipes.escrowRelease({ tradeId: 'a', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('150') })),
    ).rejects.toThrow();

    expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:b')).toBe('50');
  });

  it('fee charge: the IFC discount branch charges less, and the discount is not invented value', async () => {
    await fund(USER_A, 'IFC', '1000');

    await ledger.post(
      recipes.feeCharge({
        chargeId: 'c1',
        userId: USER_A,
        module: 'trade',
        mode: 'token',
        tokenAssetId: 'IFC',
        grossTokenAmount: amt('100'),
        discountBps: 2500, // 25% off
      }),
    );

    expect(await balanceOf(USER_A, 'IFC')).toBe('925');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('75');
    expect(ledger.totalsByAsset().IFC).toBe('0');
  });

  it('staking: stake then unstake round-trips exactly', async () => {
    await fund(USER_A, 'IFC', '10000');

    await ledger.post(recipes.stake({ stakeId: 's1', userId: USER_A, assetId: 'IFC', amount: amt('4000'), tier: 'm12' }));
    expect(await balanceOf(USER_A, 'IFC')).toBe('6000');
    expect(await balanceOf(USER_A, 'IFC', 'stake', 'token:stake:s1')).toBe('4000');

    await ledger.post(recipes.unstake({ stakeId: 's1', userId: USER_A, assetId: 'IFC', amount: amt('4000'), tier: 'm12' }));
    expect(await balanceOf(USER_A, 'IFC')).toBe('10000');
    expect(await balanceOf(USER_A, 'IFC', 'stake', 'token:stake:s1')).toBe('0');
  });

  it('L1/L3-5: unstake of s1 cannot drain s2', async () => {
    await fund(USER_A, 'IFC', '3000');
    await ledger.post(recipes.stake({ stakeId: 's1', userId: USER_A, assetId: 'IFC', amount: amt('1000'), tier: 'flex' }));
    await ledger.post(recipes.stake({ stakeId: 's2', userId: USER_A, assetId: 'IFC', amount: amt('2000'), tier: 'flex' }));
    await expect(
      ledger.post(recipes.unstake({ stakeId: 's1', userId: USER_A, assetId: 'IFC', amount: amt('2000'), tier: 'flex' })),
    ).rejects.toThrow();
    expect(await balanceOf(USER_A, 'IFC', 'stake', 'token:stake:s2')).toBe('2000');
  });

  it('withdrawal: hold → settle removes value only once', async () => {
    await fund(USER_A, 'BTC', '1');
    const w = { userId: USER_A, assetId: 'BTC', amount: amt('0.5'), rail: 'crypto-native', withdrawalId: 'wd-1' };

    await ledger.post(recipes.withdrawHold(w));
    await ledger.post(recipes.withdrawSettle(w));
    await ledger.post(recipes.withdrawSettle(w)); // retry

    expect(await balanceOf(USER_A, 'BTC')).toBe('0.5');
    expect(await heldTotal(USER_A, 'BTC')).toBe('0');
    expect(ledger.totalsByAsset().BTC).toBe('0');
  });

  it('withdrawal: a failed rail reverses the hold', async () => {
    await fund(USER_A, 'BTC', '1');
    const w = { userId: USER_A, assetId: 'BTC', amount: amt('0.5'), rail: 'crypto-native', withdrawalId: 'wd-2' };

    await ledger.post(recipes.withdrawHold(w));
    await ledger.post(recipes.withdrawReverse(w));

    expect(await balanceOf(USER_A, 'BTC')).toBe('1');
    expect(await heldTotal(USER_A, 'BTC')).toBe('0');
  });

  it('rewards are paid from the rewards engine, never minted at the edge', async () => {
    // Fund the rewards engine from the mint boundary first — the only minter.
    await ledger.post(
      recipes.mintEmission({
        epoch: 1,
        assetId: 'IFC',
        amount: amt('1000'),
        destination: { ownerType: 'house', ownerId: 'rewards-engine', assetId: 'IFC', kind: 'available' },
      }),
    );

    await ledger.post(recipes.rewardPay({ rewardId: 'r1', userId: USER_A, assetId: 'IFC', amount: amt('250'), reason: 'staking.yield' }));

    expect(await balanceOf(USER_A, 'IFC')).toBe('250');
    expect(ledger.totalsByAsset().IFC).toBe('0');
  });

  // ── Payments (§6.1) ────────────────────────────────────────────────────────

  it('payment capture: value enters the book and waits in merchant clearing', async () => {
    const tx = await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-1',
        merchantId: 'm-1',
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'card-sandbox',
        railRef: 'ch_1',
      }),
    );

    expect(tx.entries).toHaveLength(2);
    expect(formatAmount((await ledger.balance(merchantClearing('m-1', 'USDT'))).amount)).toBe('100');
    // The rail boundary is negative by exactly what we now owe the merchant.
    expect(formatAmount((await ledger.balance(railBoundary('card-sandbox', 'USDT'))).amount)).toBe('-100');
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('payment capture is keyed on the payment — a redelivered webhook cannot double it', async () => {
    const request = recipes.paymentCapture({
      paymentId: 'pay-dup',
      merchantId: 'm-1',
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: 'ch_dup',
    });

    const first = await ledger.post(request);
    const second = await ledger.post(request);

    expect(second.id).toBe(first.id);
    expect(formatAmount((await ledger.balance(merchantClearing('m-1', 'USDT'))).amount)).toBe('100');
  });

  it('settlement: net to the merchant, fee to the house, clearing emptied', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-2',
        merchantId: 'm-2',
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'crypto-native',
        railRef: '0xabc',
      }),
    );

    await ledger.post(
      recipes.merchantSettlement({
        merchantId: 'm-2',
        merchantUserId: USER_B,
        window: '2026-07-27',
        assetId: 'USDT',
        gross: amt('1000'),
        fee: amt('25'),
      }),
    );

    expect(formatAmount((await ledger.balance(merchantProceeds('m-2', 'USDT'))).amount)).toBe('975');
    expect(await balanceOf(USER_B, 'USDT')).toBe('0');
    expect(formatAmount((await ledger.balance(houseFees('pay', 'USDT'))).amount)).toBe('25');
    expect(formatAmount((await ledger.balance(merchantClearing('m-2', 'USDT'))).amount)).toBe('0');
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('settlement refuses a fee that swallows the whole window', () => {
    expect(() =>
      recipes.merchantSettlement({
        merchantId: 'm-3',
        merchantUserId: USER_B,
        window: 'w',
        assetId: 'USDT',
        gross: amt('100'),
        fee: amt('100'),
      }),
    ).toThrow(InvalidEntryError);
  });

  it('settlement keys on the asset as well as the window — two currencies, two settlements', () => {
    const usdt = recipes.merchantSettlement({
      merchantId: 'm-4',
      merchantUserId: USER_B,
      window: '2026-07-27',
      assetId: 'USDT',
      gross: amt('100'),
      fee: amt('1'),
    });
    const btc = recipes.merchantSettlement({
      merchantId: 'm-4',
      merchantUserId: USER_B,
      window: '2026-07-27',
      assetId: 'BTC',
      gross: amt('1'),
      fee: amt('0'),
    });

    expect(usdt.idempotencyKey).not.toBe(btc.idempotencyKey);
  });

  it('refund before settlement comes out of clearing, not the merchant', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-3',
        merchantId: 'm-5',
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'card-sandbox',
        railRef: 'ch_3',
      }),
    );

    await ledger.post(
      recipes.paymentRefund({
        refundId: 'pay-3:1',
        paymentId: 'pay-3',
        merchantId: 'm-5',
        merchantUserId: USER_B,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        source: 'clearing',
      }),
    );

    expect(formatAmount((await ledger.balance(merchantClearing('m-5', 'USDT'))).amount)).toBe('60');
    expect(formatAmount((await ledger.balance(railBoundary('card-sandbox', 'USDT'))).amount)).toBe('-60');
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('refund after settlement draws on the merchant, and fails when they cannot cover it', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-4',
        merchantId: 'm-6',
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'card-sandbox',
        railRef: 'ch_4',
      }),
    );
    await ledger.post(
      recipes.merchantSettlement({
        merchantId: 'm-6',
        merchantUserId: USER_A,
        window: 'w1',
        assetId: 'USDT',
        gross: amt('100'),
        fee: amt('10'),
      }),
    );

    // The merchant holds 90 net; a full 100 refund cannot be covered, and the
    // ledger refuses rather than inventing the missing 10 from somewhere.
    await expect(
      ledger.post(
        recipes.paymentRefund({
          refundId: 'pay-4:1',
          paymentId: 'pay-4',
          merchantId: 'm-6',
          merchantUserId: USER_A,
          assetId: 'USDT',
          amount: amt('100'),
          rail: 'card-sandbox',
          source: 'settled',
        }),
      ),
    ).rejects.toThrow(InsufficientFundsError);

    expect(formatAmount((await ledger.balance(merchantProceeds('m-6', 'USDT'))).amount)).toBe('90');
    expect(await balanceOf(USER_A, 'USDT')).toBe('0');
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('a full payment lifecycle leaves no residue anywhere', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-5',
        merchantId: 'm-7',
        assetId: 'USDT',
        amount: amt('250.5'),
        rail: 'crypto-native',
        railRef: '0xdef',
      }),
    );
    await ledger.post(
      recipes.paymentRefund({
        refundId: 'pay-5:1',
        paymentId: 'pay-5',
        merchantId: 'm-7',
        merchantUserId: USER_B,
        assetId: 'USDT',
        amount: amt('50.5'),
        rail: 'crypto-native',
        source: 'clearing',
      }),
    );
    await ledger.post(
      recipes.merchantSettlement({
        merchantId: 'm-7',
        merchantUserId: USER_B,
        window: '2026-07-28',
        assetId: 'USDT',
        gross: amt('200'),
        fee: amt('5'),
      }),
    );

    expect(formatAmount((await ledger.balance(merchantClearing('m-7', 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(merchantProceeds('m-7', 'USDT'))).amount)).toBe('195');
    expect(await balanceOf(USER_B, 'USDT')).toBe('0');
    expect(ledger.totalsByAsset().USDT).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});

/**
 * The reference ledger is single-threaded, so these establish that the *rules*
 * hold under load and that rejected posts leave no residue. The true
 * concurrency gate — 1k parallel posts under SERIALIZABLE with zero drift
 * (§4.4) — runs against svc-ledger's Postgres implementation.
 */
describe('torture — volume and drift', () => {
  it('holds zero drift across 1,000 interleaved posts', async () => {
    await fund(USER_A, 'USDT', '100000');
    await fund(USER_B, 'USDT', '100000');

    const posts: Array<Promise<unknown>> = [];
    for (let i = 0; i < 500; i++) {
      posts.push(ledger.post(recipes.orderHold({ orderId: `a${i}`, userId: USER_A, assetId: 'USDT', amount: amt('1') })));
      posts.push(ledger.post(recipes.orderHold({ orderId: `b${i}`, userId: USER_B, assetId: 'USDT', amount: amt('1') })));
    }
    await Promise.all(posts);

    expect(await balanceOf(USER_A, 'USDT')).toBe('99500');
    expect(await heldTotal(USER_A, 'USDT')).toBe('500');
    expect(ledger.reconcile()).toEqual({ ok: true });
    expect(ledger.verifyChain()).toEqual({ ok: true });
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('never lets parallel spending exceed the balance', async () => {
    await fund(USER_A, 'USDT', '100');

    const attempts = Array.from({ length: 20 }, (_, i) =>
      ledger
        .post(recipes.orderHold({ orderId: `race-${i}`, userId: USER_A, assetId: 'USDT', amount: amt('10') }))
        .then(() => 'ok' as const)
        .catch(() => 'rejected' as const),
    );
    const results = await Promise.all(attempts);

    expect(results.filter((r) => r === 'ok')).toHaveLength(10);
    expect(await balanceOf(USER_A, 'USDT')).toBe('0');
    expect(await heldTotal(USER_A, 'USDT')).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('sums every entry in the journal to zero per asset', async () => {
    await fund(USER_A, 'USDT', '1000');
    await ledger.post(recipes.orderHold({ orderId: 'x', userId: USER_A, assetId: 'USDT', amount: amt('100') }));

    for (const tx of ledger.journal()) {
      const perAsset = new Map<string, bigint>();
      for (const e of tx.entries) {
        const delta = e.direction === 'debit' ? e.amount : -e.amount;
        perAsset.set(e.assetId, (perAsset.get(e.assetId) ?? 0n) + delta);
      }
      for (const [asset, delta] of perAsset) {
        expect(delta, `${tx.reason} / ${asset}`).toBe(0n);
      }
    }
  });

  it('records a running balance on every entry that matches the final state', async () => {
    await fund(USER_A, 'USDT', '100');
    await ledger.post(recipes.orderHold({ orderId: 'y', userId: USER_A, assetId: 'USDT', amount: amt('30') }));

    const last = ledger.journal().at(-1)!;
    const availableEntry = last.entries.find((e) => e.direction === 'credit')!;
    expect(formatAmount(availableEntry.balanceAfter)).toBe('70');
  });
});

describe('helpers', () => {
  it('sums an empty list to zero', () => {
    expect(sum([])).toBe(0n);
  });
});
