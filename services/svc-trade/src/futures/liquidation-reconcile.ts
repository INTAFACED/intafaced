/**
 * RECONCILING APPLIED RUNGS TO THE LEDGER — read-only, pure.
 *
 * A rung's `plan` says what the rung meant to book (`marginTaken`, `fromInsurance`). The LEDGER says
 * what was booked: the loss transaction `futures.loss:<liquidationId>:rung:<rungId>:loss` carries
 * `meta.fromMargin` and `meta.fromInsurance`, and the insurance fund's credit entries (reason
 * `futures.loss.realized`) are the money that actually left it. The books agree only if both agree, and
 * a check of plan against plan (`marginTaken + fromInsurance + lossShort = plannedLoss`) can pass while
 * the ledger holds something else, so the ledger is the side this compares to.
 *
 * WHY A PURE FUNCTION AND NOT A QUERY. svc-trade has no ledger query surface (the production ledger
 * client cannot list transactions) and this must not add one. The ledger's rows are fetched by the
 * operator queries in `docs/runbooks/liquidation-rung-ops.md` section 5.1 and handed to this function
 * (or compared by the SQL there). Nothing here posts, reads a balance or writes a row.
 *
 * UNITS. Every amount is the ledger's integer scale (1e18), the same figure `meta.fromMargin` and
 * `plan.marginTaken` hold as a decimal-integer string. Compare like with like.
 */
import type { Amount } from '@intafaced/ledger-client';
import type { RungRecord } from './liquidation-rungs.js';

/** The reason every `futuresRealizeLoss` carries — the liquidation loss AND a voluntary close's shortfall. */
export const REALIZED_LOSS_REASON = 'futures.loss.realized';

/** The ledger key of a rung's loss transaction. */
export function rungLossKey(rung: Pick<RungRecord, 'liquidationId' | 'rungId'>): string {
  return `futures.loss:${rung.liquidationId}:rung:${rung.rungId}:loss`;
}

/** One ledger transaction, as the ledger's `ledger_tx` row presents it. */
export interface LedgerLossTx {
  idempotencyKey: string;
  /** `meta` as stored: `fromMargin` / `fromInsurance` are decimal-integer strings. */
  meta: Record<string, unknown> | null;
}

/** One credit entry on the insurance fund account (value that left it), with the tx it belongs to. */
export interface InsuranceCredit {
  idempotencyKey: string;
  reason: string;
  amount: Amount;
}

export type RungMismatchKind =
  /** The plan books a loss and the ledger has no such transaction. */
  | 'loss_missing'
  /** The plan books nothing (an empty pot) and the ledger has a loss transaction. */
  | 'loss_unexpected'
  | 'from_margin'
  | 'from_insurance'
  /** The ledger tx exists but its `meta` does not hold readable `fromMargin` / `fromInsurance`. */
  | 'meta_unreadable';

export interface RungMismatch {
  rungId: string;
  positionId: string;
  kind: RungMismatchKind;
  /** What the rung's plan says (null when the plan says nothing is booked). */
  expected: Amount | null;
  /** What the ledger says (null when the ledger has no transaction or no readable meta). */
  ledger: Amount | null;
}

export interface RungLedgerReconciliation {
  /** Applied rungs examined. Rungs in any other state are not compared: they have not finished booking. */
  checked: number;
  mismatches: RungMismatch[];
  insurance: {
    /** Σ insurance-fund credits (reason `futures.loss.realized`) whose key is an APPLIED rung's loss key. */
    ledgerRungKeyed: Amount;
    /** Σ `plan.fromInsurance` over the applied rungs. */
    plans: Amount;
    /** `ledgerRungKeyed - plans`. Non-zero: the fund moved by a different amount than the rungs say. */
    difference: Amount;
    /**
     * Σ credits with the same reason under any OTHER key: voluntary-close shortfalls, liquidations from
     * before rung ids, and rungs not yet applied. Informational — not part of `clean`.
     */
    ledgerOther: Amount;
  };
  /** No mismatch and no insurance difference. */
  clean: boolean;
}

function readAmount(value: unknown): Amount | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Compare every APPLIED rung with the ledger transaction it booked, and the insurance fund's total
 * outflow with what the rungs say they drew.
 */
export function reconcileRungsToLedger(input: {
  rungs: readonly RungRecord[];
  ledgerLossTxs: readonly LedgerLossTx[];
  insuranceCredits: readonly InsuranceCredit[];
}): RungLedgerReconciliation {
  const txByKey = new Map(input.ledgerLossTxs.map((t) => [t.idempotencyKey, t]));
  const applied = input.rungs.filter((r) => r.state === 'applied');
  const appliedKeys = new Set(applied.map(rungLossKey));
  const mismatches: RungMismatch[] = [];

  for (const rung of applied) {
    const { marginTaken, fromInsurance } = rung.plan;
    const booked = marginTaken + fromInsurance > 0n;
    const tx = txByKey.get(rungLossKey(rung));
    const base = { rungId: rung.rungId, positionId: rung.positionId };

    if (!tx) {
      if (booked) mismatches.push({ ...base, kind: 'loss_missing', expected: marginTaken + fromInsurance, ledger: null });
      continue;
    }
    if (!booked) {
      mismatches.push({ ...base, kind: 'loss_unexpected', expected: null, ledger: null });
      continue;
    }
    const fromMargin = readAmount(tx.meta?.fromMargin);
    const ledgerInsurance = readAmount(tx.meta?.fromInsurance);
    if (fromMargin === null || ledgerInsurance === null) {
      mismatches.push({ ...base, kind: 'meta_unreadable', expected: marginTaken + fromInsurance, ledger: null });
      continue;
    }
    if (fromMargin !== marginTaken) mismatches.push({ ...base, kind: 'from_margin', expected: marginTaken, ledger: fromMargin });
    if (ledgerInsurance !== fromInsurance) {
      mismatches.push({ ...base, kind: 'from_insurance', expected: fromInsurance, ledger: ledgerInsurance });
    }
  }

  let ledgerRungKeyed = 0n;
  let ledgerOther = 0n;
  for (const credit of input.insuranceCredits) {
    if (credit.reason !== REALIZED_LOSS_REASON) continue;
    if (appliedKeys.has(credit.idempotencyKey)) ledgerRungKeyed += credit.amount;
    else ledgerOther += credit.amount;
  }
  const plans = applied.reduce((sum, r) => sum + r.plan.fromInsurance, 0n);
  const difference = ledgerRungKeyed - plans;

  return {
    checked: applied.length,
    mismatches,
    insurance: { ledgerRungKeyed, plans, difference, ledgerOther },
    clean: mismatches.length === 0 && difference === 0n,
  };
}
