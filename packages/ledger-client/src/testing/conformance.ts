import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { formatAmount, parseAmount as amt } from '../money.js';
import { houseFees, railBoundary, rewardsEngine, userAvailable, userCollateral, userEscrow, userHold, userStake } from '../accounts.js';
import { InsufficientFundsError, InvalidEntryError, type AccountKind, type LedgerTx } from '../types.js';
import { campaignLockAccount, recipes } from '../recipes/index.js';
import type { LedgerClient } from '../client.js';

/**
 * THE LEDGER CONFORMANCE SUITE.
 *
 * §4.4 exit criteria. Every implementation of `LedgerClient` runs this file
 * unmodified — the in-memory reference and svc-ledger's Postgres engine alike.
 * If the two disagree about anything in here, one of them is wrong, and the
 * suite says which behaviour is correct.
 *
 * Optional capabilities (journal, reconcile, verifyChain, totalsByAsset) are
 * skipped when a harness does not provide them, so a partial implementation can
 * still prove the parts it does support.
 */

export interface LedgerHarness {
  readonly ledger: LedgerClient;
  /** Return the book to empty between tests. */
  reset(): Promise<void>;
  /** Commit order. Enables the hash-chain and reconciliation sections. */
  journal?(): Promise<LedgerTx[]>;
  reconcile?(): Promise<{ ok: boolean }>;
  verifyChain?(): Promise<{ ok: boolean }>;
  totalsByAsset?(): Promise<Record<string, string>>;
  /** Called once when the suite finishes. */
  teardown?(): Promise<void>;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

export function runLedgerConformance(name: string, createHarness: () => Promise<LedgerHarness>): void {
  describe(`ledger conformance — ${name}`, () => {
    let harness: LedgerHarness | undefined;
    let ledger: LedgerClient;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      ledger = harness.ledger;
    });

    // Once, when this suite finishes. reset stays in beforeEach.
    // A harness that omits teardown is left alone.
    afterAll(async () => {
      await harness?.teardown?.();
    });

    const fund = (userId: string, assetId: string, amount: string) =>
      ledger.post(
        recipes.deposit({
          userId,
          assetId,
          amount: amt(amount),
          rail: 'test',
          railRef: `${userId}:${assetId}:${amount}`,
        }),
      );

    // `purpose` is required for a lock pot (P0-3) — there is no such thing as "the"
    // hold or collateral balance, only the balance held for a named reason.
    const balanceOf = async (userId: string, assetId: string, kind: AccountKind = 'available', purpose = 'test') => {
      const ref = (() => {
        switch (kind) {
          case 'available':
            return userAvailable(userId, assetId);
          case 'hold':
            return userHold(userId, assetId, purpose);
          case 'escrow':
            return userEscrow(userId, assetId, purpose);
          case 'stake':
            return userStake(userId, assetId, purpose);
          case 'collateral':
            return userCollateral(userId, assetId, purpose);
        }
      })();
      return formatAmount((await ledger.balance(ref)).amount);
    };

    /**
     * Total held for a user in an asset, summed across purposes (P0-3).
     *
     * Part of the conformance contract: an implementation that ignores
     * `purpose` and keeps one hold row per (user, asset) still passes the
     * per-purpose reads, but fails here the moment two purposes coexist.
     */
    const heldTotal = async (userId: string, assetId: string) => {
      const all = await ledger.balances('user', userId);
      const total = all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n);
      return formatAmount(total);
    };

    // ── INVARIANT 1 · sum to zero ─────────────────────────────────────────────

    describe('sum-to-zero per asset', () => {
      it('refuses an unbalanced transaction', async () => {
        await expect(
          ledger.post({
            idempotencyKey: 'unbalanced-test-1',
            module: 'test',
            reason: 'test',
            entries: [
              { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('100') },
              { account: railBoundary('test', 'USDT'), direction: 'credit', amount: amt('99') },
            ],
          }),
        ).rejects.toThrow();
      });

      it('refuses a single-entry transaction', async () => {
        await expect(
          ledger.post({
            idempotencyKey: 'single-entry-test',
            module: 'test',
            reason: 'test',
            entries: [{ account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('1') }],
          }),
        ).rejects.toThrow(InvalidEntryError);
      });

      it('refuses to net one asset against another', async () => {
        await expect(
          ledger.post({
            idempotencyKey: 'cross-asset-net-test',
            module: 'test',
            reason: 'test',
            entries: [
              { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('100') },
              { account: userAvailable(USER_B, 'BTC'), direction: 'credit', amount: amt('100') },
            ],
          }),
        ).rejects.toThrow();
      });
    });

    // ── INVARIANT 2 · available never negative ────────────────────────────────

    describe('available never goes negative', () => {
      it('refuses to overdraw', async () => {
        await fund(USER_A, 'USDT', '100');
        await expect(
          ledger.post(
            recipes.withdrawHold({
              userId: USER_A,
              assetId: 'USDT',
              amount: amt('100.000000000000000001'),
              rail: 'test',
              withdrawalId: 'overdraw-1',
            }),
          ),
        ).rejects.toThrow(InsufficientFundsError);
        expect(await balanceOf(USER_A, 'USDT')).toBe('100');
      });

      it('allows spending to exactly zero', async () => {
        await fund(USER_A, 'USDT', '100');
        await ledger.post(
          recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('100'), rail: 'test', withdrawalId: 'exact-1' }),
        );
        expect(await balanceOf(USER_A, 'USDT')).toBe('0');
        expect(await heldTotal(USER_A, 'USDT')).toBe('100');
      });

      it('leaves the book untouched when a post is rejected', async () => {
        await fund(USER_A, 'USDT', '10');
        await expect(
          ledger.post(
            recipes.withdrawHold({ userId: USER_A, assetId: 'USDT', amount: amt('999'), rail: 'test', withdrawalId: 'reject-1' }),
          ),
        ).rejects.toThrow(InsufficientFundsError);
        expect(await balanceOf(USER_A, 'USDT')).toBe('10');
      });

      it('lets only the treasury boundary run negative', async () => {
        await fund(USER_A, 'USDT', '100');
        const boundary = await ledger.balance(railBoundary('test', 'USDT'));
        expect(formatAmount(boundary.amount)).toBe('-100');
      });
    });

    // ── INVARIANT 3 · locks are funded ────────────────────────────────────────

    describe('locks are funded from the owner’s own available balance', () => {
      it('refuses collateral conjured from elsewhere', async () => {
        // USER_B can pay. The credit is theirs; the collateral pot is USER_A's.
        // An engine that accepts the post funds that pot, and the read is then '1'.
        await fund(USER_B, 'BTC', '1');
        const pot = userCollateral(USER_A, 'BTC', 'loan:elsewhere');
        await expect(
          ledger.post({
            idempotencyKey: 'unfunded-lock-test',
            module: 'test',
            reason: 'test',
            entries: [
              { account: userAvailable(USER_B, 'BTC'), direction: 'credit', amount: amt('1') },
              { account: pot, direction: 'debit', amount: amt('1') },
            ],
          }),
        ).rejects.toThrow(InvalidEntryError);
        expect(await balanceOf(USER_A, 'BTC', 'collateral', 'loan:elsewhere')).toBe('0');
        expect(formatAmount((await ledger.balance(pot)).amount)).toBe('0');
        expect(await balanceOf(USER_B, 'BTC')).toBe('1');
      });

      /**
       * ONE CLAIM CANNOT SPEND ANOTHER CLAIM'S RESERVATION.
       *
       * This is the bug purposed holds exist to prevent, and until now the suite
       * only asserted half of it. `two purposes in one asset are two distinct
       * accounts` proves the two pots READ separately. Nothing proved you cannot
       * DRAW ONE DOWN PAST ITS OWN BALANCE — which is the half where the money
       * goes.
       *
       * `client.ts` states the consequence: "`withdrawSettle` could draw down value
       * an open order was relying on: both postings balance, the journal
       * reconciles, and the order is quietly unfunded. Nothing in the books could
       * tell you it had happened."
       *
       * An implementation that stored `purpose` as a label beside one shared row
       * per (user, asset) passes every existing case in this file — the reads look
       * right because the label round-trips — and fails here on the first
       * over-release. That is the whole point of putting it in the conformance
       * suite rather than in one engine's tests.
       */
      it('refuses to release more from one purpose than that purpose holds', async () => {
        await fund(USER_A, 'USDT', '200');
        await ledger.post(recipes.orderHold({ orderId: 'x-one', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
        await ledger.post(recipes.orderHold({ orderId: 'x-two', userId: USER_A, assetId: 'USDT', amount: amt('100') }));

        // 200 is available across the two pots combined, and 100 in this one.
        await expect(
          ledger.post(recipes.orderHoldRelease({ orderId: 'x-one', userId: USER_A, assetId: 'USDT', amount: amt('200') })),
        ).rejects.toThrow(InsufficientFundsError);

        // Both reservations intact, and nothing landed in available.
        expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:x-one')).toBe('100');
        expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:x-two')).toBe('100');
        expect(await balanceOf(USER_A, 'USDT')).toBe('0');
      });

      /**
       * A LOCK RELEASED TWICE.
       *
       * `assertPairedLocks` constrains locks on the way IN and deliberately leaves
       * release unconstrained, on the stated grounds that sum-to-zero already
       * governs where released value lands. That is true and it is not sufficient
       * on its own: a second release of the same lock balances perfectly and
       * would hand the user their reservation a second time. What stops it is the
       * non-negative rule on the lock pot, one layer down.
       *
       * So the invariant holds by composition, across two guards that live in
       * different functions — which is exactly the kind of property that survives
       * a refactor by luck. Two distinct `sequence` values, so the idempotency key
       * differs and this is a genuine second post rather than a deduplicated retry.
       */
      it('refuses a second release of a lock already returned', async () => {
        await fund(USER_A, 'USDT', '100');
        await ledger.post(recipes.orderHold({ orderId: 'twice', userId: USER_A, assetId: 'USDT', amount: amt('100') }));
        await ledger.post(recipes.orderHoldRelease({ orderId: 'twice', userId: USER_A, assetId: 'USDT', amount: amt('100'), sequence: 0 }));

        await expect(
          ledger.post(recipes.orderHoldRelease({ orderId: 'twice', userId: USER_A, assetId: 'USDT', amount: amt('100'), sequence: 1 })),
        ).rejects.toThrow(InsufficientFundsError);

        // Released once, not twice — and the pot is empty rather than negative.
        expect(await balanceOf(USER_A, 'USDT')).toBe('100');
        expect(await balanceOf(USER_A, 'USDT', 'hold', 'order:twice')).toBe('0');
      });

      /**
       * A PARTIAL FAILURE LEAVES NOTHING APPLIED.
       *
       * `leaves the book untouched when a post is rejected` already exists, and it
       * rejects on a TWO-entry recipe whose only debit is the one that fails —
       * which an implementation that applied entries one at a time would also
       * pass, because there is nothing to have applied first.
       *
       * This one fails on the THIRD of four entries, after two that are
       * individually legal and would have moved value. `MemoryLedger` stages into
       * a map and commits at the end; `PostgresLedger` relies on the transaction.
       * Those are different mechanisms for one contract, and this is the case that
       * tells them apart.
       */
      it('applies nothing when a later entry in the same post is refused', async () => {
        await fund(USER_A, 'USDT', '100');

        await expect(
          ledger.post({
            idempotencyKey: 'partial-failure-test',
            module: 'test',
            reason: 'third entry overdraws an empty account',
            entries: [
              // Legal on its own: A has 100.
              { account: userAvailable(USER_A, 'USDT'), direction: 'credit', amount: amt('50') },
              { account: houseFees('test', 'USDT'), direction: 'debit', amount: amt('50') },
              // B has nothing. This is the one that must refuse the whole post.
              { account: userAvailable(USER_B, 'USDT'), direction: 'credit', amount: amt('50') },
              { account: houseFees('test', 'USDT'), direction: 'debit', amount: amt('50') },
            ],
          }),
        ).rejects.toThrow(InsufficientFundsError);

        // Every account exactly as it was, including the two the earlier entries
        // would have moved.
        expect(await balanceOf(USER_A, 'USDT')).toBe('100');
        expect(await balanceOf(USER_B, 'USDT')).toBe('0');
        expect(formatAmount((await ledger.balance(houseFees('test', 'USDT'))).amount)).toBe('0');

        // And the failed key is not recorded, so a corrected retry can reuse it.
        expect(await ledger.getTxByKey('partial-failure-test')).toBeNull();
      });
    });

    // ── INVARIANT 4 · idempotency ─────────────────────────────────────────────

    describe('idempotency', () => {
      it('returns the original transaction and does not double the money', async () => {
        const request = recipes.deposit({
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('50'),
          rail: 'crypto-native',
          railRef: '0xidem',
        });

        const first = await ledger.post(request);
        const second = await ledger.post(request);

        expect(second.id).toBe(first.id);
        expect(await balanceOf(USER_A, 'USDT')).toBe('50');
      });

      it('survives a burst of concurrent retries of the same post', async () => {
        const request = recipes.deposit({
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('50'),
          rail: 'crypto-native',
          railRef: '0xburst',
        });

        const results = await Promise.all(Array.from({ length: 25 }, () => ledger.post(request)));

        expect(new Set(results.map((r) => r.id)).size).toBe(1);
        expect(await balanceOf(USER_A, 'USDT')).toBe('50');
      });

      /**
       * A REUSED KEY WITH A DIFFERENT BODY IS A CONFLICT, NOT A RETRY.
       *
       * This case used to assert the opposite: a key that had already committed,
       * replayed with a body that validation refuses, returned the original
       * transaction ("the value moved; a caller told 'invalid' about a completed
       * movement retries forever"). That reasoning holds for the SAME body that
       * validation later tightened, and it still does: the same-body replay above
       * keeps returning the transaction in both engines. What it wrongly covered
       * was a DIFFERENT body, which is not a retry at all. Answering it with the
       * old booking told the caller its new movement had happened (#4414: a key
       * collision silently dropped a movement while the caller recorded success).
       *
       * Both engines must refuse it with `ledger.idempotency_conflict`, before
       * validation, and the book must be untouched.
       */
      it('refuses a reused key whose body moves different money, and the book is untouched', async () => {
        const request = recipes.deposit({
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('50'),
          rail: 'crypto-native',
          railRef: '0xidem-conflict',
        });
        const first = await ledger.post(request);

        // Same key, different amount.
        const bigger = recipes.deposit({
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('500'),
          rail: 'crypto-native',
          railRef: '0xidem-conflict',
        });
        expect(bigger.idempotencyKey).toBe(request.idempotencyKey);
        await expect(ledger.post(bigger)).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });

        // Same key, a body that cannot even validate (one leg).
        await expect(
          ledger.post({
            idempotencyKey: request.idempotencyKey,
            module: 'test',
            reason: 'a different body under a booked key',
            entries: [{ account: userAvailable(USER_A, 'USDT'), direction: 'credit', amount: amt('50') }],
          }),
        ).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });

        // Same key, a different account.
        const elsewhere = recipes.deposit({
          userId: USER_B,
          assetId: 'USDT',
          amount: amt('50'),
          rail: 'crypto-native',
          railRef: '0xidem-conflict',
        });
        await expect(ledger.post(elsewhere)).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });

        // The original, once.
        expect((await ledger.getTxByKey(request.idempotencyKey))?.id).toBe(first.id);
        expect(await balanceOf(USER_A, 'USDT')).toBe('50');
        expect(await balanceOf(USER_B, 'USDT')).toBe('0');
      });

      it('still returns the original for a retry: same movement, entries in any order, any meta or trace id', async () => {
        const request = recipes.deposit({
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('50'),
          rail: 'crypto-native',
          railRef: '0xidem-retry-shape',
        });
        const first = await ledger.post(request);
        const retry = await ledger.post({
          ...request,
          entries: [...request.entries].reverse(),
          meta: { ...(request.meta ?? {}), retriedAt: 'later' },
          correlationId: 'a-fresh-trace-id',
        });
        expect(retry.id).toBe(first.id);
        expect(await balanceOf(USER_A, 'USDT')).toBe('50');
      });

      /**
       * The other half of the same order: a key that is not a key is refused
       * BEFORE anything is looked up by it, in both engines. Without this,
       * "validate the key first" is an unasserted comment.
       */
      it('refuses an unusable key even when no transaction could match it', async () => {
        await expect(
          ledger.post({
            idempotencyKey: '',
            module: 'test',
            reason: 'no key at all',
            entries: [
              { account: userAvailable(USER_A, 'USDT'), direction: 'debit', amount: amt('1') },
              { account: railBoundary('test', 'USDT'), direction: 'credit', amount: amt('1') },
            ],
          }),
        ).rejects.toThrow(InvalidEntryError);
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

      it('finds a posted transaction by its key', async () => {
        const tx = await fund(USER_A, 'USDT', '25');
        const found = await ledger.getTxByKey(tx.idempotencyKey);
        expect(found?.id).toBe(tx.id);
      });
    });

    // ── Money paths ───────────────────────────────────────────────────────────

    describe('recipes', () => {
      it('trade fill: six entries, fees to house, books closed', async () => {
        await fund(USER_A, 'USDT', '1000');
        await fund(USER_B, 'BTC', '2');
        await ledger.post(recipes.orderHold({ orderId: 'taker-1', userId: USER_A, assetId: 'USDT', amount: amt('900') }));
        await ledger.post(recipes.orderHold({ orderId: 'maker-1', userId: USER_B, assetId: 'BTC', amount: amt('1') }));

        const tx = await ledger.post(
          recipes.tradeFill({
            fillId: 'conformance-f1',
            makerId: USER_B,
            takerId: USER_A,
            makerOrderId: 'maker-1',
            takerOrderId: 'taker-1',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            qty: amt('1'),
            quoteAmount: amt('900'),
            takerSide: 'buy',
            makerFeeBps: 10,
            takerFeeBps: 20,
          }),
        );

        expect(tx.entries).toHaveLength(6);
        expect(await balanceOf(USER_B, 'USDT')).toBe('899.1');
        expect(await balanceOf(USER_A, 'BTC')).toBe('0.998');
        expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0.9');
        expect(formatAmount((await ledger.balance(houseFees('trade', 'BTC'))).amount)).toBe('0.002');
        expect(await heldTotal(USER_A, 'USDT')).toBe('0');
        expect(await heldTotal(USER_B, 'BTC')).toBe('0');
      });

      it('maker rebate: its own post after the fill, out of that fill taker fee, once', async () => {
        await fund(USER_A, 'USDT', '1000');
        await fund(USER_B, 'BTC', '2');
        await ledger.post(recipes.orderHold({ orderId: 'taker-r1', userId: USER_A, assetId: 'USDT', amount: amt('900') }));
        await ledger.post(recipes.orderHold({ orderId: 'maker-r1', userId: USER_B, assetId: 'BTC', amount: amt('1') }));
        const input = {
          fillId: 'conformance-r1',
          makerId: USER_B,
          takerId: USER_A,
          makerOrderId: 'maker-r1',
          takerOrderId: 'taker-r1',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          qty: amt('1'),
          quoteAmount: amt('900'),
          takerSide: 'buy' as const,
          makerFeeBps: 0,
          takerFeeBps: 10,
          makerRebateBps: 5,
        };

        // Before the fill there is no taker fee to pay it from.
        await expect(ledger.post(recipes.tradeFillMakerRebate(input))).rejects.toBeInstanceOf(InsufficientFundsError);
        await ledger.post(recipes.tradeFill(input));
        const rebate = await ledger.post(recipes.tradeFillMakerRebate(input));
        const again = await ledger.post(recipes.tradeFillMakerRebate(input));

        expect(again.id).toBe(rebate.id);
        expect(await balanceOf(USER_B, 'USDT')).toBe('900');
        expect(await balanceOf(USER_B, 'BTC')).toBe('1.0005');
        expect(await balanceOf(USER_A, 'BTC')).toBe('0.999');
        expect(formatAmount((await ledger.balance(houseFees('trade', 'BTC'))).amount)).toBe('0.0005');
        expect(await heldTotal(USER_B, 'BTC')).toBe('0');
      });

      it('locked campaign reward: lock from the rewards engine into its own pot, then one outcome', async () => {
        await fund(USER_B, 'USDT', '500');
        await ledger.post(
          recipes.feeCharge({
            chargeId: 'c-lock-fee',
            userId: USER_B,
            module: 'campaigns',
            mode: 'asset',
            assetId: 'USDT',
            amount: amt('500'),
          }),
        );
        await ledger.post(
          recipes.sweepFeesToRewards({ windowId: 'c-lock-w', sourceModule: 'campaigns', assetId: 'USDT', amount: amt('500') }),
        );
        const reward = (n: number) => ({
          rewardKey: `task:conformance-${n}:${USER_A}:once`,
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('100'),
        });
        const pot = async (n: number) => formatAmount((await ledger.balance(campaignLockAccount(reward(n).rewardKey, 'USDT'))).amount);

        await ledger.post(recipes.campaignRewardLock(reward(1)));
        await ledger.post(recipes.campaignRewardLock(reward(1)));
        await ledger.post(recipes.campaignRewardLock(reward(2)));
        expect(await balanceOf(USER_A, 'USDT')).toBe('0');
        expect(await pot(1)).toBe('100');
        expect(await pot(2)).toBe('100');

        await ledger.post(recipes.campaignRewardUnlock(reward(1)));
        await expect(ledger.post(recipes.campaignRewardForfeit(reward(1)))).rejects.toBeInstanceOf(InsufficientFundsError);
        await ledger.post(recipes.campaignRewardForfeit(reward(2)));
        await expect(ledger.post(recipes.campaignRewardUnlock(reward(2)))).rejects.toBeInstanceOf(InsufficientFundsError);

        expect(await balanceOf(USER_A, 'USDT')).toBe('100');
        expect(await pot(1)).toBe('0');
        expect(await pot(2)).toBe('0');
        expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('400');
      });

      it('p2p escrow: lock → release strands nothing', async () => {
        await fund(USER_A, 'USDT', '500');
        await ledger.post(recipes.escrowLock({ tradeId: 'c-t1', sellerId: USER_A, buyerId: USER_B, assetId: 'USDT', amount: amt('500') }));
        expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:c-t1')).toBe('500');

        await ledger.post(
          recipes.escrowRelease({
            tradeId: 'c-t1',
            sellerId: USER_A,
            buyerId: USER_B,
            assetId: 'USDT',
            amount: amt('500'),
            feeBps: 20,
          }),
        );

        expect(await balanceOf(USER_A, 'USDT', 'escrow', 'trade:c-t1')).toBe('0');
        expect(await balanceOf(USER_B, 'USDT')).toBe('499');
        expect(formatAmount((await ledger.balance(houseFees('p2p', 'USDT'))).amount)).toBe('1');
      });

      it('withdrawal: hold → settle removes value only once', async () => {
        await fund(USER_A, 'BTC', '1');
        const w = { userId: USER_A, assetId: 'BTC', amount: amt('0.5'), rail: 'crypto-native', withdrawalId: 'c-wd-1' };

        await ledger.post(recipes.withdrawHold(w));
        await ledger.post(recipes.withdrawSettle(w));
        await ledger.post(recipes.withdrawSettle(w)); // retry

        expect(await balanceOf(USER_A, 'BTC')).toBe('0.5');
        expect(await heldTotal(USER_A, 'BTC')).toBe('0');
      });

      it('withdrawal: a settled one that came back credits available once', async () => {
        await fund(USER_A, 'BTC', '1');
        const w = { userId: USER_A, assetId: 'BTC', amount: amt('0.5'), rail: 'crypto-native', withdrawalId: 'c-wd-ret:0' };

        await ledger.post(recipes.withdrawHold(w));
        await ledger.post(recipes.withdrawSettle(w));
        await ledger.post(recipes.withdrawReturned({ ...w, amount: amt('0.2') }));
        await ledger.post(recipes.withdrawReturned({ ...w, amount: amt('0.2') })); // retry

        expect(await balanceOf(USER_A, 'BTC')).toBe('0.7');
        expect(await heldTotal(USER_A, 'BTC')).toBe('0');
      });

      it('fee charge: the IFC discount branch charges less', async () => {
        await fund(USER_A, 'IFC', '1000');
        await ledger.post(
          recipes.feeCharge({
            chargeId: 'c-c1',
            userId: USER_A,
            module: 'trade',
            mode: 'token',
            tokenAssetId: 'IFC',
            grossTokenAmount: amt('100'),
            discountBps: 2500,
          }),
        );
        expect(await balanceOf(USER_A, 'IFC')).toBe('925');
        expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('75');
      });

      it('staking round-trips exactly', async () => {
        await fund(USER_A, 'IFC', '10000');
        await ledger.post(recipes.stake({ stakeId: 'c-s1', userId: USER_A, assetId: 'IFC', amount: amt('4000'), tier: 'm12' }));
        expect(await balanceOf(USER_A, 'IFC', 'stake', 'token:stake:c-s1')).toBe('4000');
        await ledger.post(recipes.unstake({ stakeId: 'c-s1', userId: USER_A, assetId: 'IFC', amount: amt('4000'), tier: 'm12' }));
        expect(await balanceOf(USER_A, 'IFC')).toBe('10000');
      });
    });

    // ── Balance projection ────────────────────────────────────────────────────

    describe('balances', () => {
      it('lists every balance an owner holds', async () => {
        await fund(USER_A, 'USDT', '100');
        await fund(USER_A, 'BTC', '1');
        await ledger.post(recipes.orderHold({ orderId: 'c-o1', userId: USER_A, assetId: 'USDT', amount: amt('40') }));

        const balances = await ledger.balances('user', USER_A);
        const view = Object.fromEntries(balances.map((b) => [`${b.account.assetId}:${b.account.kind}`, formatAmount(b.amount)]));

        expect(view['USDT:available']).toBe('60');
        expect(view['USDT:hold']).toBe('40');
        expect(view['BTC:available']).toBe('1');
      });

      it('reports zero for an account that has never been touched', async () => {
        expect(await balanceOf(USER_B, 'DOGE')).toBe('0');
      });

      /**
       * READS DO NOT WRITE.
       *
       * This suite already asked "does an untouched account read as zero?", and
       * both engines said yes — while one of them was creating the account in
       * order to answer. `MemoryLedger.balance` called `ensureAccount`, so a
       * read minted a row; `PostgresLedger.balance` was a plain SELECT. The two
       * engines disagreed about whether a read is a write, in the one direction
       * the assertion above cannot see, and the suite whose entire job is to
       * forbid that divergence never asked. Fixed in #415; asked here.
       *
       * It is not a tidiness point. "Does this owner already have an account?"
       * is the question that decides whether an adapter is about to open a
       * second book for one human (0005). An engine that answers by creating the
       * account makes the answer yes, permanently, for everyone who asked.
       */
      it('reading a balance creates nothing', async () => {
        const before = (await ledger.balances('user', USER_B)).length;

        const read = await ledger.balance(userAvailable(USER_B, 'DOGE'));
        expect(formatAmount(read.amount)).toBe('0');
        // No row exists, so there is no id to report. An engine that minted one
        // would have a uuid to hand back here.
        expect(read.accountId).toBe('');

        await ledger.balance(userHold(USER_B, 'DOGE', 'order:never-placed'));
        await ledger.balance(userEscrow(USER_B, 'DOGE', 'trade:never-opened'));

        // The projection is what an operator and the reconciliation job read.
        // If any read above created something, it surfaces here.
        expect(await ledger.balances('user', USER_B)).toHaveLength(before);
      });

      /**
       * The same property for the transaction lookups: a miss is a miss, and
       * `getTx` / `getTxByKey` must agree on `null` rather than one throwing and
       * the other returning. Idempotency is built on this answer — a caller that
       * gets an exception where it expected `null` retries a post it should not.
       */
      it('looking up a transaction that does not exist returns null', async () => {
        expect(await ledger.getTx('00000000-0000-4000-8000-000000000000')).toBeNull();
        expect(await ledger.getTxByKey('no-such-idempotency-key-conformance')).toBeNull();
      });

      /**
       * `purpose` is part of identity, not a label on a shared row (P0-3). Two
       * holds in one asset must be two accounts with two ids — an engine that
       * kept one bucket per (user, asset) and stored the purpose beside it would
       * pass every per-purpose read in this file by handing back the same row
       * twice, and would be exactly the commingled-hold bug 0001 exists to kill.
       */
      it('two purposes in one asset are two distinct accounts', async () => {
        await fund(USER_A, 'USDT', '100');
        await ledger.post(recipes.orderHold({ orderId: 'c-id-1', userId: USER_A, assetId: 'USDT', amount: amt('30') }));
        await ledger.post(recipes.orderHold({ orderId: 'c-id-2', userId: USER_A, assetId: 'USDT', amount: amt('20') }));

        const one = await ledger.balance(userHold(USER_A, 'USDT', 'order:c-id-1'));
        const two = await ledger.balance(userHold(USER_A, 'USDT', 'order:c-id-2'));

        expect(formatAmount(one.amount)).toBe('30');
        expect(formatAmount(two.amount)).toBe('20');
        expect(one.accountId).not.toBe(two.accountId);
        expect(one.accountId).not.toBe('');

        // And the purpose survives the round trip, so a caller listing balances
        // can tell an order's reservation from a withdrawal's.
        const holds = (await ledger.balances('user', USER_A)).filter((b) => b.account.kind === 'hold');
        expect(new Set(holds.map((b) => b.account.purpose))).toEqual(new Set(['order:c-id-1', 'order:c-id-2']));
      });
    });

    // ── Optional capabilities ─────────────────────────────────────────────────

    describe('journal and hash chain', () => {
      it('chains every transaction to its predecessor', async () => {
        if (!harness || !harness.journal || !harness.verifyChain) return;

        await fund(USER_A, 'USDT', '100');
        await fund(USER_B, 'USDT', '200');

        const journal = await harness.journal();
        expect(journal[0]?.previousHash).toBeNull();
        expect(journal[1]?.previousHash).toBe(journal[0]?.hash);
        expect(await harness.verifyChain()).toMatchObject({ ok: true });
      });
    });

    describe('reconciliation', () => {
      it('agrees with a full replay after a mixed run', async () => {
        if (!harness || !harness.reconcile) return;

        await fund(USER_A, 'USDT', '10000');
        for (let i = 0; i < 25; i++) {
          await ledger.post(recipes.orderHold({ orderId: `c-r${i}`, userId: USER_A, assetId: 'USDT', amount: amt('10') }));
          await ledger.post(recipes.orderHoldRelease({ orderId: `c-r${i}`, userId: USER_A, assetId: 'USDT', amount: amt('10') }));
        }

        expect(await harness.reconcile()).toMatchObject({ ok: true });
        expect(await balanceOf(USER_A, 'USDT')).toBe('10000');
      }, 30_000);

      it('closes the books — every asset nets to zero', async () => {
        if (!harness || !harness.totalsByAsset) return;

        await fund(USER_A, 'USDT', '1000');
        await fund(USER_B, 'BTC', '2');
        await ledger.post(recipes.orderHold({ orderId: 'c-h1', userId: USER_A, assetId: 'USDT', amount: amt('250') }));

        const totals = await harness.totalsByAsset();
        expect(totals.USDT).toBe('0');
        expect(totals.BTC).toBe('0');
      });
    });

    // ── Concurrency ───────────────────────────────────────────────────────────

    describe('concurrency', () => {
      it('never lets parallel spending exceed the balance', async () => {
        await fund(USER_A, 'USDT', '100');

        const attempts = Array.from({ length: 20 }, (_, i) =>
          ledger
            .post(recipes.orderHold({ orderId: `c-race-${i}`, userId: USER_A, assetId: 'USDT', amount: amt('10') }))
            .then(() => 'ok' as const)
            .catch(() => 'rejected' as const),
        );
        const results = await Promise.all(attempts);

        expect(results.filter((r) => r === 'ok')).toHaveLength(10);
        expect(await balanceOf(USER_A, 'USDT')).toBe('0');
        expect(await heldTotal(USER_A, 'USDT')).toBe('100');
      }, 30_000);
    });
  });
}
