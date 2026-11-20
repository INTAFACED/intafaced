import { LedgerError, classifyPostOutcome, type HttpLedgerOptions } from '@intafaced/ledger-client';
import { createHttpRecipePoster, type RecipePoster } from '@intafaced/ledger-client/post-recipe';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * J-academy-07 — svc-academy's only ledger writes, both INTAFACED's own money (the launch money model):
 *
 *   `academyPurchase`        a buyer's wallet payment the chain confirmed, now at our receiving address, as Academy revenue,
 *                            keyed `academy:purchase:<course>:<learner>:<n>`;
 *   `academyPurchaseRefund`  our own send back to that wallet, the exact reverse, keyed `academy:refund:<course>:<learner>:<n>`.
 *
 * svc-academy names the recipe and its inputs on svc-ledger's `postRecipe` door, and the ledger runs the recipe from
 * ledger-client itself: this service never builds ledger entries, and its Rust port will call the same door with the
 * same body. The key is still the recipe's business key, built by the ledger from the same inputs.
 *
 * Neither touches a customer account. A post is made only after the chain shows the money moved, with the key stored on
 * the purchase row first, so a retry after a crash or a lost answer is the same key and the ledger answers it with the
 * original transaction: the same payment is recorded once.
 */

export interface PurchasePost {
  readonly course: string;
  readonly userId: string;
  readonly n: number;
  readonly asset: string;
  /** The price as stored, a decimal string. */
  readonly amount: string;
  /** INTAFACED's receiving address, lower case: the own-funds place the money is at. */
  readonly receiver: string;
  /** The chain transaction that moved it. */
  readonly txHash: string;
}

/** What one post came to: booked, refused by the ledger for certain (nothing booked), or not known yet. */
export type PostAnswer = { state: 'posted'; txId: string } | { state: 'refused' | 'unknown'; reason: string };

export interface PurchaseLedger {
  postPurchase(input: PurchasePost): Promise<PostAnswer>;
  postRefund(input: PurchasePost): Promise<PostAnswer>;
}

const place = (receiver: string) => ({ kind: 'treasury-wallet' as const, walletId: receiver.toLowerCase() });

async function answer(post: () => Promise<{ id: string }>): Promise<PostAnswer> {
  try {
    const tx = await post();
    return { state: 'posted', txId: tx.id };
  } catch (err) {
    const reason = err instanceof LedgerError ? err.code : 'ledger.answer_lost';
    // Only a definite refusal proves nothing was booked; anything else is posted again on the same key later.
    return classifyPostOutcome(err) === 'refused' ? { state: 'refused', reason } : { state: 'unknown', reason };
  }
}

/** The wire inputs both recipes share: amounts and the purchase number as decimal strings, the place by its kind. */
const inputs = (input: PurchasePost) => ({
  course: input.course,
  userId: input.userId,
  n: String(input.n),
  assetId: input.asset,
  amount: input.amount,
  paymentId: input.txHash,
});

/** The posts, through any recipe poster (the HTTP door in the service, the in-process one over a test ledger). */
export function purchaseLedger(ledger: RecipePoster): PurchaseLedger {
  return {
    postPurchase: (input) =>
      answer(() => ledger.postRecipe({ recipe: 'academyPurchase', input: { ...inputs(input), to: place(input.receiver) } })),
    postRefund: (input) =>
      answer(() => ledger.postRecipe({ recipe: 'academyPurchaseRefund', input: { ...inputs(input), from: place(input.receiver) } })),
  };
}

/** 10s per attempt, 2 retries, 25s in all: a retry is the same key and body, so it never books twice. */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
/** No post is still waiting on the ledger after this long: a `posting` row older than it is taken again. */
export const POST_DEADLINE_SECONDS = Math.ceil(POST_BUDGET.deadlineMs / 1000) + 5;

/** svc-academy's HTTP client for svc-ledger's `postRecipe` door, signed as `svc-academy`. */
export function createAcademyLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): RecipePoster {
  const options: HttpLedgerOptions = {
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-academy', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    fetch: (input, init) => globalThis.fetch(input, init),
    ...POST_BUDGET,
  };
  return createHttpRecipePoster(options);
}
