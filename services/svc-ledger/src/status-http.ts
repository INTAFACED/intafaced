import type { FastifyInstance } from 'fastify';

/**
 * Liveness vs readiness — the freeze must be visible on the port, not only
 * inside `index.ts` handlers that no unit can import without booting Postgres.
 *
 * `/health` stays 200 while frozen (the process is alive). `/ready` returns 503
 * so a frozen replica leaves the load-balancer rotation instead of answering
 * every post with 412 one by one.
 */
export interface LedgerStatusPort {
  status(): Promise<{ postingEnabled: boolean; frozenReason: string | null; frozenBy: string | null }>;
  /** Latest `ok` reconciliation run. Optional so a port without a book (tests) still serves `/health`. */
  lastVerified?(): Promise<{ at: Date | null; seq: string | null }>;
}

/**
 * When the book was last PROVED consistent, and through which chain seq.
 *
 * `/health` is how an operator (and, until an alert subscriber exists, the only
 * place anyone) sees that reconciliation has stopped completing. Nulls mean no
 * `ok` run is on file, or that the read failed: a failed read must not take
 * liveness down with it, and it must not look like a recent proof either.
 */
export async function lastVerifiedFields(
  ledger: LedgerStatusPort,
): Promise<{ lastVerifiedAt: string | null; lastVerifiedSeq: string | null }> {
  if (!ledger.lastVerified) return { lastVerifiedAt: null, lastVerifiedSeq: null };
  try {
    const last = await ledger.lastVerified();
    return { lastVerifiedAt: last.at?.toISOString() ?? null, lastVerifiedSeq: last.seq };
  } catch {
    return { lastVerifiedAt: null, lastVerifiedSeq: null };
  }
}

export function registerLedgerStatusHttp(app: FastifyInstance, ledger: LedgerStatusPort, serviceName: string): void {
  app.get('/health', async () => ({ ok: true, service: serviceName, ...(await ledger.status()), ...(await lastVerifiedFields(ledger)) }));

  app.get('/ready', async (_req, reply) => {
    const status = await ledger.status();
    if (!status.postingEnabled) return reply.code(503).send({ ready: false, reason: status.frozenReason });
    return { ready: true };
  });
}
