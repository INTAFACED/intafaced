import {
  LedgerError,
  classifyPostOutcome,
  createHttpLedgerClient,
  parseAmount,
  recipes,
  type HttpLedgerOptions,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * J-academy-07 — svc-academy's only ledger writes, both INTAFACED's own money (the launch money model):
 *
 *   `academyPurchase`        a buyer's wallet payment the chain confirmed, now at our receiving address, as Academy revenue,
 *                            keyed `academy:purchase:<course>:<learner>:<n>`;
 *   `academyPurchaseRefund`  our own send back to that wallet, the exact reverse, keyed `academy:refund:<course>:<learner>:<n>`.
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

/** The posts, through any ledger client (the HTTP one in the service, the in-memory one in tests). */
export function purchaseLedger(ledger: Pick<LedgerClient, 'post'>): PurchaseLedger {
  return {
    postPurchase: (input) =>
      answer(() =>
        ledger.post(
          recipes.academyPurchase({
            course: input.course,
            userId: input.userId,
            n: BigInt(input.n),
            assetId: input.asset,
            amount: parseAmount(input.amount),
            to: place(input.receiver),
            paymentId: input.txHash,
          }),
        ),
      ),
    postRefund: (input) =>
      answer(() =>
        ledger.post(
          recipes.academyPurchaseRefund({
            course: input.course,
            userId: input.userId,
            n: BigInt(input.n),
            assetId: input.asset,
            amount: parseAmount(input.amount),
            from: place(input.receiver),
            paymentId: input.txHash,
          }),
        ),
      ),
  };
}

/** 10s per attempt, 2 retries, 25s in all: a retry is the same key and body, so it never books twice. */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
/** No post is still waiting on the ledger after this long: a `posting` row older than it is taken again. */
export const POST_DEADLINE_SECONDS = Math.ceil(POST_BUDGET.deadlineMs / 1000) + 5;

/** svc-academy's HTTP client for svc-ledger, signed as `svc-academy`. */
export function createAcademyLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): Pick<LedgerClient, 'post'> {
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-academy', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    fetch: (input, init) => globalThis.fetch(input, init),
  };
  const writer = createHttpLedgerClient({ ...shared, ...POST_BUDGET });
  return { post: (request) => writer.post(request) };
}
