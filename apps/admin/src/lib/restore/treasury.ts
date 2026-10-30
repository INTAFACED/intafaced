import 'server-only';
import { treasuryHolder } from '@/lib/accounts/holds-server';
import { edgeCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { treasuryTransport } from '@/lib/ledger/reconciliation-server';

/**
 * The restore desk's treasury hops (OPS-ledger-desk-05, J-ops-console-08 #5-#7).
 *
 * Start, step, stamp and finalize write svc-ops' restore record, so svc-ops asks for `admin:treasury`, which a founder session
 * never carries: they go on the treasury transport, as holds and reconciliation alerts do. svc-ops records the credential's
 * holder as the one who ran the step, so this console sends them only while the signed-in founder is that holder, and
 * otherwise says so and sends nothing. The reads stay on the founder's own session (`admin:read`).
 */

/** Why this founder cannot write the restore record from this console, or null when they can. */
export function restoreWritesParked(ctx: FounderCallContext): RefusalView | null {
  const transport = treasuryTransport();
  if ('reason' in transport) return { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: transport.reason };
  const holder = treasuryHolder(transport.token);
  if (holder === null)
    return {
      title: 'This console cannot tell whose treasury credential it holds',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who ran a restore step, and this console cannot read that founder from the credential. Nothing is sent rather than record it under a name nobody checked.',
      next: 'Issue the console a treasury credential that names its founder (a signed token with their id).',
      code: 'admin.treasury_holder_unreadable',
      changed: 'no',
    };
  if (holder !== ctx.session.userId.toLowerCase())
    return {
      title: 'Restore steps go out under the treasury credential, which is not yours',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who ran a restore step. That is another founder on this console, so nothing is sent rather than record your step under their name.',
      next: 'Ask the founder who holds the treasury credential to do this step, or have it issued to you.',
      code: 'admin.treasury_holder_mismatch',
      changed: 'no',
    };
  return null;
}

/** One svc-ops restore write on the treasury transport. Call `restoreWritesParked` first. */
export async function restoreTreasuryCall<T>(
  procedure: string,
  input: unknown,
  parse: (raw: unknown) => T | null,
): Promise<FounderCallResult<T>> {
  const transport = treasuryTransport();
  if ('reason' in transport) return { kind: 'unavailable', uncertain: false, requestId: null };
  return edgeCall(transport, 'ops', procedure, 'POST', input, parse, { timeoutMs: 20_000 });
}
