import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { createHttpLedgerClient, type LedgerClient } from '@intafaced/ledger-client';

/** svc-matching's reads of svc-ledger (replay hold lookup), signed as `svc-matching`: with a key the ledger names the caller from it. */
export function createReplayLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchImpl?: typeof fetch,
): LedgerClient {
  return createHttpLedgerClient({
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-matching', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    timeoutMs: 4_000,
    retries: 1,
    retryBaseDelayMs: 200,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
