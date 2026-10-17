/**
 * TEST SUPPORT. A fake svc-ledger service-to-service door over the in-memory
 * reference ledger, for tests that drive the real HTTP `createLedgerClient`.
 *
 * Why it exists: suites that hand a service a `MemoryLedger` never exercise the
 * HTTP client, so a client that drops the booked entries, mis-signs a body or
 * mishandles a refusal stays green. A test that goes through the HTTP client
 * against this door cannot make that mistake.
 *
 * The door is strict where svc-ledger is strict: it refuses any request whose
 * service signature does not verify against the exact bytes received
 * (`INTERNAL_SERVICE_BODY_BIND=require`). svc-mining-pool only posts, so only
 * `/trpc/post` is answered. The answer matches `postAcknowledgement` in
 * `services/svc-ledger/src/s2s-http.ts`, including the booked entries.
 */
import {
  formatAmount,
  InsufficientFundsError,
  LedgerError,
  parseAmount,
  type MemoryLedger,
  type PostRequest,
} from '@intafaced/ledger-client';
import { verifyServiceHeaders } from '@intafaced/contracts';

export interface DoorCall {
  readonly path: string;
  readonly service: string | null;
  readonly body: Record<string, unknown>;
}

/**
 * A refusal as `httpError` in `services/svc-ledger/src/s2s-http.ts` puts it on the wire: the funds refusal carries its
 * amounts (so a client can rebuild `InsufficientFundsError`), and the other named codes keep their own status, which is
 * what separates a retryable 5xx from a refusal that is the ledger's final answer.
 */
function ledgerRefusal(err: unknown): Response {
  const json = (value: unknown, status: number) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (err instanceof InsufficientFundsError) {
    return json(
      {
        message: err.message,
        code: err.code,
        accountId: err.accountId,
        assetId: err.assetId,
        requested: err.requested,
        availableBalance: err.availableBalance,
      },
      400,
    );
  }
  if (err instanceof LedgerError) {
    const status =
      err.code === 'ledger.idempotency_conflict'
        ? 409
        : err.code === 'ledger.frozen'
          ? 412
          : err.code === 'ledger.unauthenticated'
            ? 401
            : err.code === 'ledger.owner_identity_space'
              ? 400
              : 500;
    return json({ message: err.message, code: err.code }, status);
  }
  return json({ message: 'Ledger request failed' }, 500);
}

export function fakeLedgerDoor(ledger: MemoryLedger, secret: string, calls: DoorCall[] = []): typeof fetch {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const raw = typeof init?.body === 'string' ? init.body : '';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const verdict = verifyServiceHeaders(headers, secret, {
      rawBody: { retained: true as const, bytes: Buffer.from(raw, 'utf8') },
      mode: 'require',
    });
    if (verdict.rejected) return json({ message: `unauthenticated: ${verdict.rejected}`, code: 'ledger.unauthenticated' }, 401);
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    calls.push({ path, service: verdict.service, body });

    if (path === '/trpc/post') {
      const request = body as unknown as Omit<PostRequest, 'entries'> & {
        entries: Array<{ account: PostRequest['entries'][number]['account']; direction: 'debit' | 'credit'; amount: string }>;
      };
      try {
        const tx = await ledger.post({
          ...request,
          entries: request.entries.map((e) => ({ account: e.account, direction: e.direction, amount: parseAmount(e.amount) })),
        });
        // As `postAcknowledgement` in svc-ledger: the entries the ledger actually booked ride on the receipt.
        return json({
          txId: tx.id,
          hash: tx.hash,
          postedAt: tx.postedAt.toISOString(),
          entries: (tx.entries ?? []).map((e) => ({
            id: e.id,
            txId: e.txId,
            accountId: e.accountId,
            assetId: e.assetId,
            direction: e.direction,
            amount: formatAmount(e.amount),
            balanceAfter: formatAmount(e.balanceAfter),
          })),
        });
      } catch (err) {
        return ledgerRefusal(err);
      }
    }
    return json({ message: `no route ${path}` }, 404);
  }) as typeof fetch;
}
