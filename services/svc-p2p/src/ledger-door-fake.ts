/**
 * TEST SUPPORT. A fake svc-ledger service-to-service door over the in-memory
 * reference ledger, for tests that drive the real HTTP `createLedgerClient`.
 *
 * Why it exists: the in-memory ledger implements `getTx` and `getTxByKey`, the
 * HTTP client used to throw on both, so every suite that handed a service a
 * `MemoryLedger` stayed green while the same code failed on a real deployment
 * (#4694). A test that goes through the HTTP client against this door cannot
 * make that mistake.
 *
 * The door is strict where svc-ledger is strict: it refuses any request whose
 * service signature does not verify against the exact bytes received
 * (`INTERNAL_SERVICE_BODY_BIND=require`), and `/trpc/txById` refuses a non-uuid
 * id. Answers match `services/svc-ledger/src/s2s-http.ts`, including the booked entries on a post receipt and the
 * structured fields of a funds refusal.
 */
import { formatAmount, InsufficientFundsError, parseAmount, type MemoryLedger, type PostRequest } from '@intafaced/ledger-client';
import { verifyServiceHeaders } from '@intafaced/contracts';

export interface DoorCall {
  readonly path: string;
  readonly service: string | null;
  readonly body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    if (path === '/trpc/txByKey') {
      const tx = await ledger.getTxByKey(String(body.idempotencyKey));
      return json(
        tx
          ? { found: true, txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString(), module: tx.module, reason: tx.reason }
          : { found: false },
      );
    }
    if (path === '/trpc/txById') {
      if (typeof body.txId !== 'string' || !UUID.test(body.txId)) return json({ message: 'txId must be a uuid', code: 'BAD_REQUEST' }, 400);
      const tx = await ledger.getTx(body.txId);
      if (!tx) return json({ found: false });
      return json({
        found: true,
        txId: tx.id,
        idempotencyKey: tx.idempotencyKey,
        hash: tx.hash,
        postedAt: tx.postedAt.toISOString(),
        module: tx.module,
        reason: tx.reason,
        entries: tx.entries.map((e) => ({
          accountId: e.accountId,
          assetId: e.assetId,
          direction: e.direction,
          amount: formatAmount(e.amount),
        })),
      });
    }
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
        // As `httpError` in svc-ledger: a funds refusal is a 400 carrying the structured fields, which is what lets a
        // caller rebuild (and, for svc-p2p, verify) the typed refusal.
        if (err instanceof InsufficientFundsError) {
          return json(
            {
              message: 'Insufficient funds',
              code: err.code,
              accountId: err.accountId,
              assetId: err.assetId,
              requested: err.requested,
              availableBalance: err.availableBalance,
            },
            400,
          );
        }
        return json({ message: (err as Error).message, code: (err as { code?: string }).code }, 400);
      }
    }
    if (path === '/trpc/balance') {
      const balance = await ledger.balance(body as unknown as Parameters<MemoryLedger['balance']>[0]);
      return json({ accountId: balance.accountId, amount: formatAmount(balance.amount) });
    }
    if (path === '/trpc/balances') {
      const list = await ledger.balances(body.ownerType as 'user', String(body.ownerId));
      return json(
        list.map((b) => ({
          accountId: b.accountId,
          assetId: b.account.assetId,
          kind: b.account.kind,
          purpose: b.account.purpose ?? '',
          amount: formatAmount(b.amount),
        })),
      );
    }
    return json({ message: `no route ${path}` }, 404);
  }) as typeof fetch;
}
