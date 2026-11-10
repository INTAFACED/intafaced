import { z } from 'zod';
import { serviceCallSigner, type ServiceCallSignerOptions } from './service-auth-http.js';
import type { ServiceName } from './service-keys.js';
import { bankTransferIdSchema } from './bank-transfer-id.js';

/**
 * Is this transfer one the person sent? Asked by svc-support when someone reports a scam naming a transfer (BK-safe-02,
 * J-bank-18 #3), answered by svc-bank, which owns its customers' transfers; svc-support never reads bank tables.
 *
 * THE ANSWER IS ONE BOOLEAN. A missing id, a transfer someone else sent and a transfer the person only received all
 * answer `sent: false`, the same way: no amount, no status and no owner tells them apart, so the door cannot be used to
 * learn whether an id exists or whose it is. Only svc-support may call it, as a service, never under a customer's scope.
 *
 * It changes nothing, but it is a POST to a tRPC mutation (the same shape as `ramps.destinations.sendable`), because the
 * signed body is what the caller proves. A caller that cannot get an answer gets `unavailable` and must not take the
 * report as checked.
 */

/** The tRPC path on svc-bank's root router. */
export const BANK_SCAM_TRANSFER_PROCEDURE = 'safety.transferSent' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const BANK_SCAM_TRANSFER_CALLERS: readonly ServiceName[] = ['svc-support'];

/** svc-bank's own transfer id (`bank-transfer-id.ts`, browser-safe), re-exported for the door's callers. */
export { bankTransferIdSchema };

export const bankScamTransferInputSchema = z
  .object({
    /** The reporter, taken off the signed-in caller by svc-support, never from the report's own fields. */
    userId: z.string().min(1).max(128),
    transferId: bankTransferIdSchema,
  })
  .strict();
export type BankScamTransferInput = z.infer<typeof bankScamTransferInputSchema>;

export const bankScamTransferSchema = z.object({ sent: z.boolean() }).strict();
export type BankScamTransfer = z.infer<typeof bankScamTransferSchema>;

/** `sent` when svc-bank answered; `unavailable` when it could not be asked or did not answer in shape. */
export type BankScamTransferResult = { state: 'answered'; sent: boolean } | { state: 'unavailable' };

export interface BankScamTransferPort {
  check(input: BankScamTransferInput): Promise<BankScamTransferResult>;
}

const UNAVAILABLE: BankScamTransferResult = { state: 'unavailable' };

/**
 * svc-support's client for `safety.transferSent`. One bounded request signed over its body, with svc-support's own key
 * once it has one (`s2s`), else the shared service secret. A missing or malformed URL, a short secret, an input that does
 * not parse, a non-2xx reply, a reply that does not parse, a timeout and a thrown fetch all answer `unavailable`.
 */
export function createBankScamTransferClient(options: {
  bankUrl?: string;
  secret?: string;
  s2s?: ServiceCallSignerOptions['s2s'];
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): BankScamTransferPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.bankUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/${BANK_SCAM_TRANSFER_PROCEDURE}`;
  } catch {
    /* Missing or invalid transport cannot say a transfer was sent. */
  }
  return {
    async check(raw) {
      if (endpoint === null || !options.secret || options.secret.length < 32) return UNAVAILABLE;
      const parsed = bankScamTransferInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const body = JSON.stringify(parsed.data);
      const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-bank', legacySecret: options.secret, s2s: options.s2s });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
      try {
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...sign(body, { method: 'POST', url: new URL(endpoint), contentType: 'application/json' }),
          },
          body,
        });
        if (!response.ok) return UNAVAILABLE;
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return UNAVAILABLE;
        const answer = bankScamTransferSchema.safeParse((envelope as { result?: { data?: unknown } }).result?.data);
        return answer.success ? { state: 'answered', sent: answer.data.sent } : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
