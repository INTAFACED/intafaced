import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { ledgerTransactionsExistSchema } from '@intafaced/contracts/ledger-reconciliation';

/** Which asked ids the ledger has booked, or why it could not be asked. Never "none found" in place of a failure. */
export type CorrectiveTxRead = { ok: true; found: readonly string[] } | { ok: false; message: string };

export interface CorrectiveTxPort {
  readonly configured: boolean;
  exist(txIds: readonly string[]): Promise<CorrectiveTxRead>;
}

const TIMEOUT_MS = 5000;

/**
 * Asks svc-ledger's `transactionsExist` door (svc-ops alone may call it) whether each corrective transaction an operator
 * links is booked. A missing URL, a refusal, a timeout, a malformed body and an answer naming an id that was not asked
 * each come back as a failure, so a fix is refused rather than linked to a transaction nobody checked.
 */
export function createCorrectiveTxClient(options: {
  ledgerUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): CorrectiveTxPort {
  let base: string | null = null;
  try {
    const url = new URL(options.ledgerUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing transport is explicitly unconfigured. */
  }
  const sign = serviceCallSigner({ service: 'svc-ops', audience: 'svc-ledger', legacySecret: options.secret ?? '', s2s: options.s2s });
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  const configured = base !== null && credentialed;
  const unavailable = (message: string): CorrectiveTxRead => ({ ok: false, message });

  return {
    configured,
    async exist(txIds) {
      if (!configured) return unavailable('The ledger is not wired to this service, so no transaction could be checked.');
      const body = JSON.stringify({ txIds });
      const target = `${base}/trpc/transactionsExist`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body,
        });
        if (!response.ok) return unavailable(`The ledger refused the transaction check (${response.status}).`);
        const parsed = ledgerTransactionsExistSchema.safeParse(await response.json());
        if (!parsed.success) return unavailable('The ledger answered the transaction check in a shape this service does not read.');
        const asked = new Set(txIds.map((id) => id.toLowerCase()));
        if (parsed.data.found.some((id) => !asked.has(id.toLowerCase()))) {
          return unavailable('The ledger answered a transaction that was not asked.');
        }
        return { ok: true, found: parsed.data.found };
      } catch {
        return unavailable('The ledger did not answer the transaction check.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
