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
  /**
   * The mandate as the partner reports it now. A mandate it never heard of is active. Asked for one collection
   * (`forCollection`, the scheme's collection id), a blocked answer is the partner refusing that collection, and the
   * partner keeps that refusal on its own record (J-bank-28 #4).
   */
  mandate(userId: string, mandateId: string, forCollection?: string): Promise<PartnerMandate>;
  /** The scheme set this mandate up against the person's account at the partner: the partner now knows it. */
  setUp?(userId: string, mandateId: string): Promise<void>;
}

/** One mandate on the partner's own record (J-bank-28 #4). */
export interface PartnerMandateLine {
  readonly userId: string;
  readonly mandateId: string;
  readonly state: 'active' | 'blocked';
  readonly blockedAt: Date | null;
  readonly knownAt: Date;
}

/** One collection the partner refused, with its own reason code. */
export interface PartnerDirectDebitFailure {
  readonly userId: string;
  readonly mandateId: string;
  readonly collectionId: string;
  readonly code: string;
  readonly at: Date;
}

/** One collected debit the partner gave back to the person, once (the scheme's refund guarantee). */
export interface PartnerDirectDebitRefund {
  readonly userId: string;
  readonly mandateId: string;
  readonly collectionId: string;
  readonly assetId: string;
  readonly amount: bigint;
  readonly moveId: string;
  readonly refundedAt: Date;
}

/** Everything the partner reports of the direct debits it answers for, as it keeps them. */
export interface PartnerDirectDebitReport {
  readonly label: string;
  readonly asOf: Date;
  readonly mandates: readonly PartnerMandateLine[];
  readonly failures: readonly PartnerDirectDebitFailure[];
  readonly refunds: readonly PartnerDirectDebitRefund[];
}

/** The partner's report of every direct debit it answers for, or null when no partner answers for any (J-bank-28 #4). */
export interface PartnerDirectDebitsReporter {
  report(): Promise<PartnerDirectDebitReport> | null;
}

/** Which partner, if any, answers for a person's direct debits: the one that holds their money. */
export interface PartnerDirectDebitsCustody {
  directDebitsFor(userId: string): PartnerDirectDebits | null;
}

/** No one's direct debits are at a partner: the custodial layer, as before. */
export const noPartnerDirectDebits: PartnerDirectDebitsCustody = Object.freeze({ directDebitsFor: () => null });
