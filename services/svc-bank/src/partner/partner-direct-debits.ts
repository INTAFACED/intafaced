/**
 * THE PARTNER BANK'S SIDE OF A DIRECT DEBIT (J-bank-06 #4, OWNER 226).
 *
 * When the partner bank holds a person's money, the partner is the bank the scheme collects from: a block is an
 * instruction to the partner, and whether a collection on a mandate is refused is the partner's answer, with its own
 * reason code. svc-bank keeps its mandate and collection rows as the person's view of them, and records what the
 * partner said; it never decides a block on its own for partner-held money.
 *
 * The collection itself is one partner bank move under the collection's business key (`PartnerBank.move`), so it is
 * asked of the posting freeze and the partner stop like every other partner move, and nothing posts on the ledger.
 */

/** A mandate as the partner reports it. */
export interface PartnerMandate {
  readonly mandateId: string;
  /** True while the partner refuses every collection on this mandate. */
  readonly blocked: boolean;
  /** The partner's own time for the block; null when not blocked. */
  readonly blockedAt: Date | null;
  /** The partner's reason code for refusing a collection on this mandate; null when not blocked. */
  readonly refusalCode: string | null;
  readonly label: string;
}

export interface PartnerDirectDebits {
  readonly label: string;
  /**
   * Send the block to the partner. Blocking a blocked mandate answers the first block. Refuses
   * `bank.partner_unavailable` when the partner is not answering: then nothing is blocked there.
   */
  block(userId: string, mandateId: string): Promise<PartnerMandate>;
  /** Lift the block at the partner. Unblocking an active mandate changes nothing. */
  unblock(userId: string, mandateId: string): Promise<PartnerMandate>;
  /** The mandate as the partner reports it now. A mandate it never heard of is active. */
  mandate(userId: string, mandateId: string): Promise<PartnerMandate>;
}

/** Which partner, if any, answers for a person's direct debits: the one that holds their money. */
export interface PartnerDirectDebitsCustody {
  directDebitsFor(userId: string): PartnerDirectDebits | null;
}

/** No one's direct debits are at a partner: the custodial layer, as before. */
export const noPartnerDirectDebits: PartnerDirectDebitsCustody = Object.freeze({ directDebitsFor: () => null });
