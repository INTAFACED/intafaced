/**
 * TAX-EFFECT MAP (RC-portfolio-02) — which ledger posting is a P2P sale, a P2P purchase, a card spend, a mining
 * payout or a staking reward, and whether that is a disposal, an acquisition or income.
 *
 * LABELS ONLY. The map says what the ledger's own `module/reason` (and, for a card spend, the rail on the post)
 * already records. Tax rates, thresholds and country rules stay with PF-tax-01 and PF-cost-basis-05 and are never
 * invented here. A posting with no row is `portfolio.tax_effect_unmapped`: never shown as taxable, never shown as
 * non-taxable.
 *
 * DIRECTION. The feed reads the user's own accounts with the book's "debit increases" convention
 * (activity-kind.ts), so a debit is value IN and a credit is value OUT.
 *
 * SOURCES (packages/ledger-client/src/recipes/index.ts on origin/main 600fdc54d):
 *   p2p_sale / p2p_purchase  `p2p/p2p.escrow.release` (escrowRelease): the seller's escrow leg is credited (value
 *                            out, the disposal); the buyer's available leg is debited (value in, the acquisition).
 *                            The lock and the refund move the seller's own value and are not mapped.
 *   card_spend               `ledger/withdraw.held` on a card issuer rail (card-service.ts commitHold posts
 *                            withdrawHold with rail = the card's issuer). Same reason on any other rail is a
 *                            withdrawal, not a spend, and is not mapped.
 *   staking_reward           `token/token.yield.distributed` (rewardPay from svc-token), received as a debit.
 *   mining_payout            BLOCKED: no mining product posts a ledger reason on this platform. Listed with its
 *                            blocker and classifies nothing.
 */

export const TAX_EFFECT_TYPES = ['p2p_sale', 'p2p_purchase', 'card_spend', 'mining_payout', 'staking_reward'] as const;
export type TaxEffectType = (typeof TAX_EFFECT_TYPES)[number];

export const TAX_EFFECTS = ['disposal', 'acquisition', 'income'] as const;
export type TaxEffect = (typeof TAX_EFFECTS)[number];

export type TaxEffectDirection = 'debit' | 'credit';

export interface TaxEffectRow {
  readonly type: TaxEffectType;
  readonly effect: TaxEffect;
  /** The ledger `module/reason` this row reads, or null while no product posts one. */
  readonly sourceEvent: string | null;
  /** The leg that carries the effect on the user's own account; null when there is no source. */
  readonly direction: TaxEffectDirection | null;
  /** Rails the row is limited to; null = any rail. */
  readonly rails: ReadonlyArray<string> | null;
  /** Why the row classifies nothing yet; null when it is live. */
  readonly blocker: string | null;
}

/** Rails a card issuer posts a spend on. The ledger page allow-lists the rail it returns (activity-kind.ts). */
export const CARD_SPEND_RAILS: ReadonlyArray<string> = ['card-sandbox'];

export const TAX_EFFECT_MAP: ReadonlyArray<TaxEffectRow> = [
  { type: 'p2p_sale', effect: 'disposal', sourceEvent: 'p2p/p2p.escrow.release', direction: 'credit', rails: null, blocker: null },
  { type: 'p2p_purchase', effect: 'acquisition', sourceEvent: 'p2p/p2p.escrow.release', direction: 'debit', rails: null, blocker: null },
  {
    type: 'card_spend',
    effect: 'disposal',
    sourceEvent: 'ledger/withdraw.held',
    direction: 'credit',
    rails: CARD_SPEND_RAILS,
    blocker: null,
  },
  {
    type: 'mining_payout',
    effect: 'income',
    sourceEvent: null,
    direction: null,
    rails: null,
    blocker: 'No mining product posts a ledger reason on this platform yet',
  },
  {
    type: 'staking_reward',
    effect: 'income',
    sourceEvent: 'token/token.yield.distributed',
    direction: 'debit',
    rails: null,
    blocker: null,
  },
];

export interface TaxEffectInput {
  readonly module: string;
  readonly reason: string;
  readonly direction: TaxEffectDirection;
  readonly rail?: string | null;
}

export type TaxEffectClassification =
  | { readonly mapped: true; readonly type: TaxEffectType; readonly effect: TaxEffect; readonly sourceEvent: string }
  | { readonly mapped: false; readonly code: 'portfolio.tax_effect_unmapped' };

const UNMAPPED: TaxEffectClassification = { mapped: false, code: 'portfolio.tax_effect_unmapped' };

/** Pure: the same posting always gets the same answer. An unknown posting is unmapped, never a guess. */
export function classifyTaxEffect(input: TaxEffectInput): TaxEffectClassification {
  const event = `${input.module}/${input.reason}`;
  const row = TAX_EFFECT_MAP.find(
    (candidate) =>
      candidate.blocker === null &&
      candidate.sourceEvent === event &&
      candidate.direction === input.direction &&
      (candidate.rails === null || (input.rail != null && candidate.rails.includes(input.rail))),
  );
  if (row === undefined || row.sourceEvent === null) return UNMAPPED;
  return { mapped: true, type: row.type, effect: row.effect, sourceEvent: row.sourceEvent };
}
