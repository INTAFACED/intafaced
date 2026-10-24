/**
 * Chargebacks: open one, split and plan it, book the dispute outcome or reverse it, and the per-dispute outcome lock.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  InvalidEntryError,
  LedgerError,
  insuranceFund,
  parseAmount,
  userAvailable,
  type Amount,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { sandboxChargebackOpeningProbe, sandboxChargebackWonProbe } from '../sandbox-ledger-guard.js';
import {
  chargebackKeys,
  disputeOpeningKey,
  postDisputeOpening,
  postDisputeShortfall,
  postDisputeShortfallRecovered,
  postDisputeWon,
  type ChargebackPostInput,
  type ChargebackShortfallPostInput,
} from '../chargeback-ledger.js';
import { CHARGEBACK_LEDGER_EFFECT_EVENT, chargebackLedgerEffect, type ChargebackLedgerEffect } from '../chargeback-ledger-effect.js';
import { recordRailDisputeDeadline } from '../merchant-ops/dispute-deadlines.js';
import {
  refuseChargebackOpeningPostedShortfallUnfunded,
  refuseChargebackPlanConflict,
  refuseChargebackShortfallUnfunded,
  refuseChargebackUncovered,
  type ChargebackLedgerRefuse,
  type DisputeCaseStatus,
  type RailResolutionOutcome,
} from '../fraud/dispute-case.js';
import { recordDisputeOutcomeConflict } from '../fraud/dispute-outcome-conflict.js';
import type { ChargebackPlan, ChargebackSplit, PayService } from '../payment-service.js';
import { PayError, appendEvent, isInsufficientFunds, openingTxIdFromDetail, postgresErrorCode, readLivePlan } from '../payment-service.js';

/**
 * Post the opening debit: clearing first, then the settled merchant pot,
 * then `chargebackShortfall` for what those two cannot cover. The recipe
 * owns the legs. No fee is added.
 */
export async function openChargeback(
  svc: PayService,
  input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
    /** A sandbox key cannot open a chargeback against live pots. */
    keyEnv?: 'sandbox';
  },
): Promise<{ txId: string; openingTxId: string | null; shortfallTxId: string | null }> {
  const payment = await svc.getPayment(input.paymentId);
  const merchant = await svc.getMerchant(input.merchantId);
  if (payment.merchantId !== input.merchantId) throw new PayError('Payment does not belong to merchant', 'pay.payment_not_found');
  if (payment.assetId !== input.assetId) throw new PayError('Chargeback asset does not match payment', 'pay.invalid_amount');
  const amount = parseAmount(input.amount);
  if (amount <= 0n) throw new PayError('Chargeback amount must be positive', 'pay.invalid_amount');
  if (input.keyEnv === 'sandbox' || (await svc.paymentIsSandbox(svc.sql, input.paymentId))) {
    // Opening, shortfall, won, and recovery all name a live pot. Refuse before any of them post.
    svc.refuseSandboxLive(
      true,
      sandboxChargebackOpeningProbe({
        disputeId: input.disputeId,
        paymentId: input.paymentId,
        merchantId: input.merchantId,
        merchantUserId: merchant.userId,
        assetId: input.assetId,
        rail: payment.railAdapter,
        fromClearing: amount,
        fromMerchantBalance: 0n,
      }),
    );
  }
  // A payment that never captured holds no funds to take back. Clearing is pooled per merchant, so charging it
  // back would debit other payments' money.
  if (payment.status === 'created' || payment.status === 'authorized' || payment.status === 'failed') {
    throw new PayError('Payment has no captured funds to charge back', 'pay.invalid_amount');
  }
  // The split is frozen per dispute the first time it is computed. It depends on LIVE clearing and merchant
  // balances, and the opening recipe's key is the dispute id: a redelivery after a crash (post committed, delivery
  // marker not yet written) would otherwise re-split from balances the first post already moved, and book the same key
  // with different amounts. Replays post the stored plan.
  const settledPot = await svc.chargebackSettledPot(payment.id, merchant.userId);
  const compute = async () => {
    const clearing = await svc.clearingBalance(input.merchantId, input.assetId);
    const available =
      settledPot === 'user'
        ? (await svc.ledger.balance(userAvailable(merchant.userId, input.assetId))).amount
        : await svc.merchantBalance(input.merchantId, input.assetId);
    const fromClearing = clearing < amount ? clearing : amount;
    const rest = amount - fromClearing;
    const fromMerchantBalance = rest < available ? rest : available;
    const shortfall = rest - fromMerchantBalance;
    if (shortfall > 0n) {
      const fund = (await svc.ledger.balance(insuranceFund(input.assetId))).amount;
      if (fund < shortfall) {
        throw new PayError('Insurance fund cannot cover the chargeback shortfall', 'pay.chargeback_shortfall_unfunded', {
          disputeId: input.disputeId,
          shortfall: formatAmount(shortfall),
          fund: formatAmount(fund),
        });
      }
    }
    return { fromClearing, fromMerchantBalance, shortfall };
  };
  // At most one re-plan: a STORED plan that the ledger refuses for funds is stale (money moved since it was planned and
  // nothing was booked under the key), so it is retired and the split recomputed from live balances once. A plan computed
  // in this very call that is still refused is a real shortfall: retire it and let the caller see the refusal.
  for (let attempt = 0; ; attempt += 1) {
    const plan = await svc.chargebackSplit(input.paymentId, input.disputeId, amount, settledPot, compute);
    const request: ChargebackPostInput = {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      merchantUserId: merchant.userId,
      assetId: input.assetId,
      rail: payment.railAdapter,
      fromClearing: plan.fromClearing,
      fromMerchantBalance: plan.fromMerchantBalance,
      ...(plan.settledPot === 'user' ? { settledPot: 'user' as const } : {}),
    };
    const shortfallRequest: ChargebackShortfallPostInput = {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      assetId: input.assetId,
      rail: payment.railAdapter,
      amount: plan.shortfall,
    };
    const covered = plan.fromClearing + plan.fromMerchantBalance;
    try {
      if (plan.shortfall > 0n) {
        const shortfallBooked = await svc.chargebackBookedTx(chargebackKeys(input.disputeId).shortfall);
        if (!shortfallBooked) {
          const fund = (await svc.ledger.balance(insuranceFund(input.assetId))).amount;
          if (fund < plan.shortfall) {
            const openingKey = covered > 0n ? disputeOpeningKey(request) : chargebackKeys(input.disputeId).open;
            const openingBooked = covered > 0n ? await svc.chargebackBookedTx(openingKey) : null;
            if (!openingBooked) {
              await svc.voidChargebackPlan(input.paymentId, input.disputeId, plan.planSeq, openingKey);
              if (plan.replayed && attempt === 0) continue;
            }
            await svc.throwUnfundedChargebackShortfall({
              paymentId: input.paymentId,
              disputeId: input.disputeId,
              openingTxId: openingBooked?.id ?? null,
              shortfall: formatAmount(plan.shortfall),
              fund: formatAmount(fund),
            });
          }
        }
      }
      let openingTxId: string | null = null;
      if (covered > 0n) {
        const posted = await postDisputeOpening(svc.ledger, request);
        openingTxId = posted.txId;
      }
      // A concurrent delivery whose post was refused for funds may have voided this plan just before this post landed.
      await svc.ensureChargebackPlanLive(input.paymentId, input.disputeId, plan);
      let shortfallTxId: string | null = null;
      if (plan.shortfall > 0n) {
        shortfallTxId = (await postDisputeShortfall(svc.ledger, shortfallRequest)).txId;
      }
      const txId = openingTxId ?? shortfallTxId;
      if (!txId) throw new PayError('Chargeback amount must be positive', 'pay.invalid_amount');
      await svc.recordChargebackLedgerEffect(input.paymentId, input.disputeId, {
        openingTxId,
        shortfallTxId,
        wonTxId: null,
        recoveredTxId: null,
      });
      return { txId, openingTxId, shortfallTxId };
    } catch (e) {
      // Insufficient funds proves the refused post did not commit under its key: both ledger engines resolve the
      // idempotency key before they validate the body, so a key that had committed would have returned its transaction.
      // An opening that did commit, with the shortfall still refused, is recorded above. Any other failure (a 5xx,
      // a timeout, an unknown outcome) may have committed: keep the plan and replay it.
      if (e instanceof PayError) throw e;
      if (!isInsufficientFunds(e)) throw e;
      const openingKey = covered > 0n ? disputeOpeningKey(request) : chargebackKeys(input.disputeId).open;
      const openingBooked = covered > 0n ? await svc.chargebackBookedTx(openingKey) : null;
      if (openingBooked && plan.shortfall > 0n) {
        await svc.throwUnfundedChargebackShortfall({
          paymentId: input.paymentId,
          disputeId: input.disputeId,
          openingTxId: openingBooked.id,
        });
      }
      const booked = await svc.voidChargebackPlan(input.paymentId, input.disputeId, plan.planSeq, openingKey);
      // Another delivery booked this very plan while ours was being refused: the book already has the opening.
      if (booked) {
        const shortfallTxId = plan.shortfall > 0n ? (await postDisputeShortfall(svc.ledger, shortfallRequest)).txId : null;
        await svc.recordChargebackLedgerEffect(input.paymentId, input.disputeId, {
          openingTxId: booked.id,
          shortfallTxId,
          wonTxId: null,
          recoveredTxId: null,
        });
        return { txId: booked.id, openingTxId: booked.id, shortfallTxId };
      }
      if (plan.replayed && attempt === 0) continue;
      throw e;
    }
  }
}

/**
 * The clearing-first split for one dispute, computed once and stored as a `chargeback.opening_planned` event (append-only,
 * no money moves). A plan that already exists wins: same amount replays it, a different amount is a conflict.
 * `replayed` says the plan was already stored, not computed by this call.
 * The balance reads (network) happen outside any transaction; only the insert-once is serialised, per dispute.
 */
export async function chargebackSplit(
  svc: PayService,
  paymentId: string,
  disputeId: string,
  amount: Amount,
  settledPot: 'proceeds' | 'user',
  compute: () => Promise<{ fromClearing: Amount; fromMerchantBalance: Amount; shortfall: Amount }>,
): Promise<ChargebackSplit> {
  const decode = (planned: ChargebackPlan, replayed: boolean): ChargebackSplit => {
    if (parseAmount(planned.amount) !== amount) {
      throw new PayError(`Dispute ${disputeId} already planned its opening for a different amount`, 'pay.chargeback_plan_conflict', {
        disputeId,
      });
    }
    const pot = planned.settledPot === 'user' || planned.settledPot === 'proceeds' ? planned.settledPot : settledPot;
    return {
      fromClearing: parseAmount(planned.fromClearing),
      fromMerchantBalance: parseAmount(planned.fromMerchantBalance),
      shortfall: planned.shortfall === undefined ? 0n : parseAmount(planned.shortfall),
      settledPot: pot,
      planSeq: planned.seq,
      amount: planned.amount,
      replayed,
    };
  };

  const existing = await readLivePlan(svc.sql, paymentId, disputeId);
  if (existing) return decode(existing, true);

  // Pot reads sit outside the lock. Another delivery can commit the plan and post before
  // `compute` runs, so the pots this split would use are already empty. That is the booked
  // opening, not a shortfall: replay the stored plan. A real shortfall has no plan to replay.
  let split: { fromClearing: Amount; fromMerchantBalance: Amount; shortfall: Amount };
  try {
    split = await compute();
  } catch (e) {
    // Empty pots after another delivery already posted are not a shortfall.
    // A real unfunded shortfall has no plan to replay.
    const racedCode = e instanceof PayError && (e.code === 'pay.invalid_amount' || e.code === 'pay.chargeback_shortfall_unfunded');
    if (!racedCode) throw e;
    const raced = await readLivePlan(svc.sql, paymentId, disputeId);
    if (raced) return decode(raced, true);
    throw e;
  }
  const { plan, created } = await transaction(svc.sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.chargeback.plan:${disputeId}`}))`;
    const winner = await readLivePlan(tx, paymentId, disputeId);
    if (winner) return { plan: winner, created: false };
    const payload = {
      amount: formatAmount(amount),
      fromClearing: formatAmount(split.fromClearing),
      fromMerchantBalance: formatAmount(split.fromMerchantBalance),
      shortfall: formatAmount(split.shortfall),
      settledPot,
    };
    const [row] = await tx<Array<{ seq: string }>>`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${paymentId}, 'chargeback.opening_planned', ${tx.json({ disputeId, ...payload } as never)})
      RETURNING seq
    `;
    return { plan: { ...payload, seq: String(row!.seq) }, created: true };
  });
  return decode(plan, !created);
}

/**
 * Retire one plan (append-only: a `chargeback.opening_plan_voided` event, nothing is deleted). Only the plan the caller
 * posted is voided, and only if it is still the live one: a plan another delivery made after an earlier void is left alone.
 * Under the lock the ledger is asked whether the dispute key is booked after all (another delivery posted the same plan while
 * ours was refused); if so nothing is voided and that transaction is returned.
 */
export async function voidChargebackPlan(
  svc: PayService,
  paymentId: string,
  disputeId: string,
  planSeq: string,
  idempotencyKey: string,
): Promise<{ id: string } | null> {
  return transaction(svc.sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.chargeback.plan:${disputeId}`}))`;
    // The lookup only detects ANOTHER delivery's booking of this same plan. It goes over svc-ledger's txByKey door in
    // production (#4696), and a failed lookup must not stop the void: our own refusal for funds already proves our post
    // booked nothing, and a plan wrongly voided here is restored by `ensureChargebackPlanLive` once the other post returns.
    const booked = await svc.ledger.getTxByKey(idempotencyKey).catch(() => null);
    if (booked) return booked;
    const live = await readLivePlan(tx, paymentId, disputeId);
    if (!live || live.seq !== planSeq) return null;
    await appendEvent(tx, paymentId, 'chargeback.opening_plan_voided', { disputeId, planSeq });
    return null;
  });
}

/**
 * After a successful post: if the plan that was just booked is no longer the live one (a concurrent void landed between the
 * ledger commit and now), append it again so the stored plan matches the book. Takes the same per-dispute lock as the void.
 */
export async function ensureChargebackPlanLive(
  svc: PayService,
  paymentId: string,
  disputeId: string,
  plan: ChargebackSplit,
): Promise<void> {
  await transaction(svc.sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.chargeback.plan:${disputeId}`}))`;
    const live = await readLivePlan(tx, paymentId, disputeId);
    if (live?.seq === plan.planSeq) return;
    await appendEvent(tx, paymentId, 'chargeback.opening_planned', {
      disputeId,
      amount: plan.amount,
      fromClearing: formatAmount(plan.fromClearing),
      fromMerchantBalance: formatAmount(plan.fromMerchantBalance),
      shortfall: formatAmount(plan.shortfall),
      settledPot: plan.settledPot,
    });
  });
}

/**
 * Lost and closed finalise the opening debit. Won reverses only a debit
 * that is already on the book. A ledger error is a typed refusal and does
 * not move the dispute row (the caller posts the case after this returns).
 */
export async function bookDisputeResolution(
  svc: PayService,
  input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
    outcome: 'won' | 'lost' | 'closed';
    /** True when the rail event named an amount. Absent means return the stored plan in full. */
    amountExplicit?: boolean;
  },
): Promise<ChargebackLedgerEffect> {
  try {
    if (input.outcome === 'won') return await svc.reverseChargeback(input);
    const posted = await svc.openChargeback(input);
    return chargebackLedgerEffect({
      openingTxId: posted.openingTxId,
      shortfallTxId: posted.shortfallTxId,
      wonTxId: null,
      recoveredTxId: null,
    });
  } catch (e) {
    throw svc.chargebackLedgerRefusal(e);
  }
}

/** Return booked chargeback value. A missing opening is not a credit. */
export async function reverseChargeback(
  svc: PayService,
  input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
    amountExplicit?: boolean;
  },
): Promise<ChargebackLedgerEffect> {
  if (await svc.paymentIsSandbox(svc.sql, input.paymentId)) {
    const flagged = await svc.getPayment(input.paymentId);
    svc.refuseSandboxLive(
      true,
      sandboxChargebackWonProbe({
        disputeId: input.disputeId,
        paymentId: input.paymentId,
        merchantId: input.merchantId,
        merchantUserId: input.merchantId,
        assetId: input.assetId,
        rail: flagged.railAdapter,
        fromClearing: 1n,
        fromMerchantBalance: 0n,
      }),
    );
  }
  const payment = await svc.getPayment(input.paymentId);
  const merchant = await svc.getMerchant(input.merchantId);
  const plan = await readLivePlan(svc.sql, input.paymentId, input.disputeId);
  if (input.amountExplicit && plan && parseAmount(input.amount) !== parseAmount(plan.amount)) {
    throw new PayError(`Dispute ${input.disputeId} won for a different amount than its opening plan`, 'pay.chargeback_plan_conflict', {
      disputeId: input.disputeId,
    });
  }
  const keys = chargebackKeys(input.disputeId);
  const openingTx = await svc.chargebackBookedTx(keys.open);
  const shortfallTx = await svc.chargebackBookedTx(keys.shortfall);
  if (!plan || (!openingTx && !shortfallTx)) {
    const none = chargebackLedgerEffect({ openingTxId: null, shortfallTxId: null, wonTxId: null, recoveredTxId: null });
    await svc.recordChargebackLedgerEffect(input.paymentId, input.disputeId, none);
    return none;
  }
  const settledPot =
    plan.settledPot === 'user' || plan.settledPot === 'proceeds'
      ? plan.settledPot
      : await svc.chargebackSettledPot(payment.id, merchant.userId);
  const fromClearing = parseAmount(plan.fromClearing);
  const fromMerchantBalance = parseAmount(plan.fromMerchantBalance);
  const shortfall = plan.shortfall === undefined ? 0n : parseAmount(plan.shortfall);
  const legs: ChargebackPostInput = {
    disputeId: input.disputeId,
    paymentId: input.paymentId,
    merchantId: input.merchantId,
    merchantUserId: merchant.userId,
    assetId: input.assetId,
    rail: payment.railAdapter,
    fromClearing,
    fromMerchantBalance,
    ...(settledPot === 'user' ? { settledPot: 'user' as const } : {}),
  };
  const shortfallLeg: ChargebackShortfallPostInput = {
    disputeId: input.disputeId,
    paymentId: input.paymentId,
    merchantId: input.merchantId,
    assetId: input.assetId,
    rail: payment.railAdapter,
    amount: shortfall,
  };
  // The fund is repaid before the merchant is. Each key replays the original.
  let recoveredTxId: string | null = null;
  if (shortfall > 0n && shortfallTx) {
    recoveredTxId = (await postDisputeShortfallRecovered(svc.ledger, shortfallLeg)).txId;
  }
  let wonTxId: string | null = null;
  if (fromClearing + fromMerchantBalance > 0n && openingTx) {
    wonTxId = (await postDisputeWon(svc.ledger, legs)).txId;
  }
  const effect = chargebackLedgerEffect({
    openingTxId: openingTx?.id ?? null,
    shortfallTxId: shortfallTx?.id ?? null,
    wonTxId,
    recoveredTxId,
  });
  await svc.recordChargebackLedgerEffect(input.paymentId, input.disputeId, effect);
  return effect;
}

export function chargebackLedgerRefusal(svc: PayService, e: unknown): PayError {
  if (e instanceof PayError) return e;
  const ledgerCode = e instanceof LedgerError ? e.code : undefined;
  const message = e instanceof Error ? e.message : 'Chargeback ledger post failed';
  return new PayError(message, 'pay.chargeback_ledger_failed', ledgerCode ? { ledgerCode } : undefined);
}

/**
 * The fund cannot cover the shortfall. When the opening is already booked, record that
 * transaction before throwing so the case is not told that nothing moved.
 */
export async function throwUnfundedChargebackShortfall(
  svc: PayService,
  input: {
    paymentId: string;
    disputeId: string;
    openingTxId: string | null;
    shortfall?: string;
    fund?: string;
  },
): Promise<never> {
  const detail: Record<string, unknown> = { disputeId: input.disputeId };
  if (input.shortfall !== undefined) detail.shortfall = input.shortfall;
  if (input.fund !== undefined) detail.fund = input.fund;
  if (input.openingTxId) {
    await svc.recordChargebackLedgerEffect(input.paymentId, input.disputeId, {
      openingTxId: input.openingTxId,
      shortfallTxId: null,
      wonTxId: null,
      recoveredTxId: null,
    });
    detail.openingTxId = input.openingTxId;
  }
  throw new PayError('Insurance fund cannot cover the chargeback shortfall', 'pay.chargeback_shortfall_unfunded', detail);
}

export async function recordChargebackLedgerEffect(
  svc: PayService,
  paymentId: string,
  disputeId: string,
  effect: Parameters<typeof chargebackLedgerEffect>[0],
): Promise<void> {
  await appendEvent(svc.sql, paymentId, CHARGEBACK_LEDGER_EFFECT_EVENT, {
    disputeId,
    ...chargebackLedgerEffect(effect),
  });
}

/**
 * One outcome at a time per dispute. A second delivery of the same dispute waits in this
 * process and holds no connection. Distinct disputes share a slot count that stays below
 * the pool, so the lock connection is never the last one. The Postgres advisory lock still
 * serialises other processes. Taken before `pay.chargeback.plan:<disputeId>`, which the
 * booking transactions acquire on their own connection. Those transactions never take this key.
 */
export async function withChargebackOutcomeLock<T>(svc: PayService, disputeId: string, fn: () => Promise<T>): Promise<T> {
  return svc.enqueueChargebackOutcome(disputeId, () => svc.withChargebackOutcomeSlot(() => svc.lockChargebackOutcome(disputeId, fn)));
}

/** Same-dispute deliveries queue here. The tail is dropped once it settles and nothing newer replaced it. */
export function enqueueChargebackOutcome<T>(svc: PayService, disputeId: string, run: () => Promise<T>): Promise<T> {
  const previous = svc.chargebackOutcomeTails.get(disputeId) ?? Promise.resolve();
  const gate = previous.then(
    () => undefined,
    () => undefined,
  );
  const result = gate.then(run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  svc.chargebackOutcomeTails.set(disputeId, tail);
  void tail.finally(() => {
    if (svc.chargebackOutcomeTails.get(disputeId) === tail) svc.chargebackOutcomeTails.delete(disputeId);
  });
  return result;
}

/** Waiting for a slot holds no connection. */
export async function withChargebackOutcomeSlot<T>(svc: PayService, run: () => Promise<T>): Promise<T> {
  await svc.acquireChargebackOutcomeSlot();
  try {
    return await run();
  } finally {
    svc.releaseChargebackOutcomeSlot();
  }
}

export function acquireChargebackOutcomeSlot(svc: PayService): Promise<void> {
  if (svc.chargebackOutcomeHeld < svc.chargebackOutcomeSlots) {
    svc.chargebackOutcomeHeld += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    svc.chargebackOutcomeWaiters.push(() => resolve());
  });
}

export function releaseChargebackOutcomeSlot(svc: PayService): void {
  const next = svc.chargebackOutcomeWaiters.shift();
  if (next) {
    next();
    return;
  }
  svc.chargebackOutcomeHeld -= 1;
}

export async function lockChargebackOutcome<T>(svc: PayService, disputeId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await transaction(
      svc.sql,
      async (tx) => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.chargeback.outcome:${disputeId}`}))`;
        return fn();
      },
      { isolation: 'read committed', maxAttempts: 1 },
    );
  } catch (err) {
    if (postgresErrorCode(err) === '55P03') {
      throw new PayError('Chargeback outcome lock is busy; nothing was posted', 'pay.chargeback_outcome_busy', { disputeId });
    }
    throw err;
  }
}

/**
 * Not-found is null. A transport or validation error is `pay.chargeback_ledger_failed`,
 * never "not booked", so a plan is not voided and a won credit is not skipped.
 */
export async function chargebackBookedTx(svc: PayService, key: string): Promise<LedgerTx | null> {
  try {
    return await svc.ledger.getTxByKey(key);
  } catch (e) {
    throw svc.chargebackLedgerRefusal(e);
  }
}

/**
 * The rail named an amount the stored plan does not match. Post nothing, leave the case
 * where it is, and record the conflict so this delivery is not retried forever.
 */
export async function recordChargebackPlanConflict(
  svc: PayService,
  input: {
    merchantId: string;
    disputeId: string;
    paymentId: string;
    amount: string;
    assetId: string;
    reasonCode: string | null;
    railEventId: string;
    railId: string;
    storedStatus: DisputeCaseStatus;
    outcome: RailResolutionOutcome;
    evidenceDueBy: Date | null;
  },
): Promise<void> {
  await recordDisputeOutcomeConflict(svc.sql, {
    merchantId: input.merchantId,
    disputeId: input.disputeId,
    railEventId: input.railEventId,
    railId: input.railId,
    storedStatus: input.storedStatus,
    outcome: input.outcome,
    reason: 'the rail amount does not match the opening already planned for this dispute; no value moved',
  });
  const current = await svc.disputeCases.get(input.disputeId);
  if (!current) {
    await svc.disputeCases.open({
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      amount: input.amount,
      assetId: input.assetId,
      reasonCode: input.reasonCode,
      paymentMarkedDisputed: false,
      ledgerRefuse: refuseChargebackPlanConflict({ disputeId: input.disputeId, paymentId: input.paymentId }),
    });
  }
  await recordRailDisputeDeadline(svc.sql, {
    merchantId: input.merchantId,
    disputeId: input.disputeId,
    evidenceDueBy: input.evidenceDueBy,
    railEventId: input.railEventId,
  });
}

/**
 * Webhook door: post the opening recipe or named refuse. An unfunded shortfall
 * is a named refuse so the dispute is recorded; a later lost or closed delivery
 * books it once the fund can cover. A funds refusal of the opening post itself
 * is still the named uncovered refuse.
 */
export async function postChargebackOpenOrRefuse(
  svc: PayService,
  input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
  },
): Promise<{ ledgerPost?: { txId: string }; ledgerRefuse?: ChargebackLedgerRefuse }> {
  try {
    return { ledgerPost: await svc.openChargeback(input) };
  } catch (e) {
    if ((e instanceof PayError && e.code === 'pay.invalid_amount') || e instanceof InvalidEntryError || isInsufficientFunds(e)) {
      return { ledgerRefuse: refuseChargebackUncovered({ disputeId: input.disputeId, paymentId: input.paymentId }) };
    }
    // A redelivery that names another amount cannot be fixed by redelivering: record the case and name the conflict.
    if (e instanceof PayError && e.code === 'pay.chargeback_plan_conflict') {
      return { ledgerRefuse: refuseChargebackPlanConflict({ disputeId: input.disputeId, paymentId: input.paymentId }) };
    }
    if (e instanceof PayError && e.code === 'pay.chargeback_shortfall_unfunded') {
      const openingTxId = openingTxIdFromDetail(e.detail);
      if (openingTxId) {
        return {
          ledgerPost: { txId: openingTxId },
          ledgerRefuse: refuseChargebackOpeningPostedShortfallUnfunded({
            disputeId: input.disputeId,
            paymentId: input.paymentId,
          }),
        };
      }
      return { ledgerRefuse: refuseChargebackShortfallUnfunded({ disputeId: input.disputeId, paymentId: input.paymentId }) };
    }
    throw e;
  }
}
