import { z } from 'zod';
import { createHttpLedgerClient, createLedgerTransport, type PostRequest } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { StaffHoldLedger, StaffHoldLedgerKey } from './desk.js';

/** `/trpc/txByKey`: the identifying fields of the post booked under a key, never its entries. */
const txByKeyWire = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), txId: z.string().min(1), module: z.string(), reason: z.string() }),
]);

/**
 * svc-ledger, signed as `svc-ops`, for the staff hold posts. A post is ONE attempt with no transport retry: the desk
 * counts every post it sends under a key, and only an answer to a single attempt can prove nothing committed
 * (`classifyPostOutcome`). The read by key may retry: it is idempotent. It calls `txByKey` alone: svc-ops may read that
 * door and no other (ADR 2026-10-22 service-access-calls 3.7 rule 5), so it learns whether a key is booked and by which
 * module and reason, never the entries (the client's `getTxByKey` would follow on to `txById`, which svc-ops is refused).
 * Without a URL or a credential there is no ledger, and every hold action refuses `ops.hold_ledger_unconfigured`.
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
  const read = createLedgerTransport({ ...shared, timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 });
  return {
    post: (request: PostRequest) => writer.post(request),
    findByKey: async (idempotencyKey: string): Promise<StaffHoldLedgerKey | null> => {
      const parsed = txByKeyWire.safeParse(await read<unknown>('/trpc/txByKey', { idempotencyKey }));
      // Unreadable is never "not booked": a missing key would let the desk declare a post lost.
      if (!parsed.success) throw new Error('svc-ledger answered a key lookup malformed (/trpc/txByKey)');
      if (!parsed.data.found) return null;
      return { txId: parsed.data.txId, module: parsed.data.module, reason: parsed.data.reason };
    },
  };
}
