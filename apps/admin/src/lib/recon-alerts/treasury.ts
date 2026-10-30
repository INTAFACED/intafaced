import 'server-only';
import { createHash } from 'node:crypto';
import {
  opsAlertDetailSchema,
  opsAlertEvidenceCanonical,
  type OpsAlert,
  type OpsAlertDetail,
  type OpsAlertResolveInput,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import { treasuryHolder } from '@/lib/accounts/holds-server';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { edgeCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { treasuryTransport } from '@/lib/ledger/reconciliation-server';
import { failureRefusal } from '@/lib/ops-desk/execute';

/**
 * The console's treasury hops for reconciliation alerts (OPS-reconciliation-04, J-ops-console-07 #9).
 *
 * Resolving with corrective transactions and accepting a discrepancy close a finance alert, so svc-ops asks for
 * `admin:treasury`, which a founder session never carries: they go on the treasury transport. svc-ops records the
 * credential's holder as the one who resolved or asked to accept, so this console sends them only while the signed-in
 * founder is that holder, and otherwise says so and sends nothing.
 */

/** SHA-256 hex of the evidence as the contract spells it: the hash an acceptance freezes and svc-ops recomputes. */
export function evidenceHash(alert: Pick<OpsAlert, 'evidence'>): string {
  return createHash('sha256').update(opsAlertEvidenceCanonical(alert.evidence)).digest('hex');
}

/** Why this founder cannot resolve or accept alerts from this console, or null when they can. */
export function alertWritesParked(ctx: FounderCallContext): RefusalView | null {
  const transport = treasuryTransport();
  if ('reason' in transport) return { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: transport.reason };
  const holder = treasuryHolder(transport.token);
  if (holder === null)
    return {
      title: 'This console cannot tell whose treasury credential it holds',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who resolved an alert or asked to accept it, and this console cannot read that founder from the credential. Nothing is sent rather than record it under a name nobody checked.',
      next: 'Issue the console a treasury credential that names its founder (a signed token with their id).',
      code: 'admin.treasury_holder_unreadable',
      changed: 'no',
    };
  if (holder !== ctx.session.userId.toLowerCase())
    return {
      title: 'Alerts are closed under the treasury credential, which is not yours',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who resolved an alert or asked to accept it. That is another founder on this console, so nothing is sent rather than record your action under their name.',
      next: 'Ask the founder who holds the treasury credential to do this step, or have it issued to you.',
      code: 'admin.treasury_holder_mismatch',
      changed: 'no',
    };
  return null;
}

async function treasuryOps<T>(procedure: string, input: unknown, parse: (raw: unknown) => T | null): Promise<FounderCallResult<T>> {
  const transport = treasuryTransport();
  if ('reason' in transport) return { kind: 'unavailable', uncertain: false, requestId: null };
  return edgeCall(transport, 'ops', procedure, 'POST', input, parse, { timeoutMs: 20_000 });
}

/** Link corrective ledger transactions and resolve the alert as fixed. svc-ops checks each id exists in the ledger first. */
export async function resolveAlert(input: OpsAlertResolveInput): Promise<FounderCallResult<OpsAlertDetail>> {
  return treasuryOps('alerts.resolve', input, parseWith(opsAlertDetailSchema));
}

/** Run an approved acceptance on the treasury transport; svc-ops spends the approval once and freezes the evidence. */
export function acceptExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'ops.reconciliation_alert.accept')
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const parked = alertWritesParked(ctx);
    if (parked) return { ok: false, refusal: parked };
    const result = await treasuryOps(
      'alerts.accept',
      {
        alertId: request.alertId,
        note: request.reason,
        evidenceHash: request.evidenceHash,
        approvalId: ids.approvalId,
        operationId: ids.operationId,
      },
      parseWith(opsAlertDetailSchema),
    );
    if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
    const { alert } = result.data;
    if (alert.id !== request.alertId || alert.state !== 'accepted' || alert.accepted?.evidenceHash !== request.evidenceHash)
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return {
      ok: true,
      detail: `Alert ${alert.id} is accepted: requested by ${alert.accepted.requestedBy}, approved by ${alert.accepted.approvedBy}, evidence frozen at ${alert.accepted.evidenceHash}.`,
    };
  };
}
