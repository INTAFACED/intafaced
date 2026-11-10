import type { FastifyInstance } from 'fastify';
import { RECONCILE_ACTOR, RECONCILE_UNPROVEN_REASON } from './ledger/reconcile-config.js';

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

/**
 * Why the posting freeze is on, in the few words a reader of `/health` sorts by (project-state #1790; the money model's
 * change 4 item 4): `person` (an operator froze it, with their reason), `mismatch` (a proof found the book inconsistent),
 * `unfinished_proofs` (too many proofs in a row never reached a verdict, `reconcile_unproven`), `startup_setting`
 * (`LEDGER_POSTING_ENABLED=false` at boot). Null while posting is enabled. The reason text and actor stay beside it.
 */
export type FreezeCause = 'person' | 'mismatch' | 'unfinished_proofs' | 'startup_setting';

export function freezeCause(status: { postingEnabled: boolean; frozenReason: string | null; frozenBy: string | null }): FreezeCause | null {
  if (status.postingEnabled) return null;
  if (status.frozenBy === RECONCILE_ACTOR) return status.frozenReason === RECONCILE_UNPROVEN_REASON ? 'unfinished_proofs' : 'mismatch';
  if (status.frozenBy?.startsWith('env:')) return 'startup_setting';
  return 'person';
}

export function registerLedgerStatusHttp(app: FastifyInstance, ledger: LedgerStatusPort, serviceName: string): void {
  app.get('/health', async () => {
    const status = await ledger.status();
    return { ok: true, service: serviceName, ...status, frozenCause: freezeCause(status), ...(await lastVerifiedFields(ledger)) };
  });

  app.get('/ready', async (_req, reply) => {
    const status = await ledger.status();
    if (!status.postingEnabled) return reply.code(503).send({ ready: false, reason: status.frozenReason });
    return { ready: true };
  });
}
