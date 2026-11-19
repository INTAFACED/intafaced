/**
 * J-academy-07 — the refund signer: the owner's signer that holds INTAFACED's receiving address's key and sends one token
 * transfer back to a buyer's wallet. svc-academy holds no key; it asks the signer for one send per refund key, and the
 * signer answers the same transaction for the same key, so a retry after a lost answer is read back, never sent twice.
 *
 *   POST <ACADEMY_REFUND_SIGNER_URL>  {"key","chainId","token","to","amount"}  →  {"hash"}
 */
import { isTxHash } from './chain.js';

export interface RefundSend {
  readonly key: string;
  readonly chainId: number;
  readonly token: string;
  readonly to: string;
  /** In the token's smallest unit. */
  readonly amount: bigint;
}

/** The transaction the signer sent for the key, or null when its answer was lost or unclear (asked again later). */
export interface RefundSender {
  send(input: RefundSend): Promise<string | null>;
}

export function httpRefundSender(url: string, fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 15_000): RefundSender {
  return {
    async send(input) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, amount: input.amount.toString() }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const body = (await res.json().catch(() => null)) as { hash?: unknown } | null;
        const hash = typeof body?.hash === 'string' ? body.hash.toLowerCase() : null;
        return hash && isTxHash(hash) ? hash : null;
      } catch {
        return null;
      }
    },
  };
}
