import { createHttpLedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { StaffHoldLedger } from './desk.js';

/**
 * svc-ledger, signed as `svc-ops`, for the staff hold posts. A post is ONE attempt with no transport retry: the desk
 * counts every post it sends under a key, and only an answer to a single attempt can prove nothing committed
 * (`classifyPostOutcome`). The read by key may retry: it is idempotent. Without a URL or a credential there is no ledger,
 * and every hold action refuses `ops.hold_ledger_unconfigured`.
 */
export function createStaffHoldLedger(options: {
  ledgerUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}): StaffHoldLedger | undefined {
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  if (!options.ledgerUrl || !credentialed) return undefined;
  const shared = {
    baseUrl: options.ledgerUrl,
    sign: serviceCallSigner({ service: 'svc-ops', audience: 'svc-ledger', legacySecret: options.secret ?? '', s2s: options.s2s }),
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(input, init),
  };
  const writer = createHttpLedgerClient({ ...shared, timeoutMs: 15_000, retries: 0 });
  const reader = createHttpLedgerClient({ ...shared, timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 });
  return { post: (request: PostRequest) => writer.post(request), getTxByKey: (key: string) => reader.getTxByKey(key) };
}
