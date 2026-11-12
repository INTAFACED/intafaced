import type { Amount } from '@intafaced/ledger-client';

/**
 * A PURCHASE THROUGH THE PARTNER, AND WHAT IT HOLDS BACK (J-wallet-01 #3; OWNER 226).
 *
 * At launch a person's bank money is held by the partner, under its licence. When they buy with a card or a pull from
 * their bank account through the partner's ramp (Add money), it is the partner that takes the payment and credits the
 * person's main balance with it, at the partner. A partner may hold some of that back until the payment can no longer be
 * reversed: the part held is not withdrawable until its release time. Both figures are the partner's; INTAFACED posts
 * nothing to its ledger for either, and is never authoritative over them.
 *
 *   - A credit is one partner pay-in under the purchase's business key: the same key is the same credit, once, however
 *     many times the partner's "paid" arrives; another amount under the same key is refused.
 *   - What is held back is what the partner reports: each hold with its amount and its release time. A partner that does
 *     not report its holds says so (`reported: false`), and the app reads that as "not reported by the partner", never as
 *     nothing held. A released hold is listed once, with when the partner released it.
 */
export interface PartnerPurchase {
  /** The business key of the purchase: one key is one credit at the partner. */
  readonly key: string;
  readonly assetId: string;
  readonly amount: Amount;
  /** How it was paid: `card` (a card or wallet pay) or `bank_pull` (a pull from the person's own bank account). */
  readonly paidBy: PartnerPaidBy;
}

export type PartnerPaidBy = 'card' | 'bank_pull';

export interface PartnerPurchaseHold {
  /** The partner's own reference for the hold. */
  readonly id: string;
  /** The purchase it holds back part of. */
  readonly purchaseKey: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly paidBy: PartnerPaidBy;
  /** When the partner says it releases the amount. */
  readonly releaseAt: Date;
}

export interface PartnerPurchaseRelease extends PartnerPurchaseHold {
  /** When the partner released it. */
  readonly releasedAt: Date;
}

export type PartnerPurchaseHolds =
  | { readonly label: string; readonly reported: false }
  | {
      readonly label: string;
      readonly reported: true;
      /** The partner's own time for the report. */
      readonly asOf: Date;
      /** What it still holds back, oldest first. */
      readonly holds: readonly PartnerPurchaseHold[];
      /** What it has released, each once, oldest first. */
      readonly released: readonly PartnerPurchaseRelease[];
    };

export interface PartnerCredit {
  /** The partner's own reference for the pay-in. */
  readonly id: string;
  readonly key: string;
  readonly amount: Amount;
  /** What it holds back of this purchase, or null when it holds nothing back or does not say. */
  readonly hold: PartnerPurchaseHold | null;
}

export interface PartnerReturn {
  /** The partner's own reference for the return. */
  readonly id: string;
  readonly key: string;
  readonly amount: Amount;
  readonly returnedAt: Date;
}

export interface PartnerPurchases {
  readonly label: string;
  /**
   * The partner says a purchase was paid: it credits the person's main balance once under the purchase's key. Refuses
   * before anything is credited: `bank.partner_unavailable` (not answering), `bank.partner_move_conflict` (another
   * purchase under this key), `bank.partner_amount_invalid` (not above zero).
   */
  credit(userId: string, purchase: PartnerPurchase): Promise<PartnerCredit>;
  /** What the partner holds back of the person's purchases, and what it has released, as it reports them. */
  holds(userId: string): Promise<PartnerPurchaseHolds>;
  /**
   * The partner says a purchase it credited was sent back (J-bank-02 #7): it takes the amount out of the person's main
   * balance once, under the purchase's key, and holds nothing back of it any more. The same key again answers the same
   * return. Refuses before anything moves: `bank.partner_unavailable` (not answering), `bank.partner_move_conflict` (no
   * purchase credited under this key, or one on other terms), `bank.partner_insufficient_funds` (the balance no longer
   * holds it).
   */
  returned(userId: string, purchase: PartnerPurchase): Promise<PartnerReturn>;
}

/** Which partner, if any, a person's purchases are credited at: the one that holds their money, or none. */
export interface PartnerPurchaseCustody {
  purchasesFor(userId: string): PartnerPurchases | null;
}

/** How a way to pay through the ramp is paid, as the partner sees it. A bank transfer is pushed, not pulled. */
export function paidByFor(method: 'card' | 'bank_transfer' | 'pay_by_bank' | 'wallet_pay'): PartnerPaidBy | null {
  if (method === 'card' || method === 'wallet_pay') return 'card';
  if (method === 'pay_by_bank') return 'bank_pull';
  return null;
}
