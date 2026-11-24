import 'server-only';
import { type ExecuteReply, explainRefusal, failureRefusal, type FounderCallContext, founderRecordRead } from '@/lib/desk';
import type { EscalateRequest } from './direct-model';
import { isRecord } from '@intafaced/contracts/guards';
import { P2P_DISPUTES_ESCALATE } from '@intafaced/contracts/p2p-disputes-procedures';

/** Run a one-operator desk action as the signed-in founder. The service checks the permission and the moderator list itself. */

interface EscalateAnswer {
  readonly disputeId: string;
  readonly escalations: number;
  readonly replay: boolean;
}

export function readEscalateAnswer(raw: unknown): EscalateAnswer | null {
  if (!isRecord(raw) || typeof raw.disputeId !== 'string' || typeof raw.replay !== 'boolean') return null;
  if (typeof raw.escalations !== 'number' || !Number.isInteger(raw.escalations)) return null;
  return { disputeId: raw.disputeId, escalations: raw.escalations, replay: raw.replay };
}

export async function runDirect(ctx: FounderCallContext, request: EscalateRequest): Promise<ExecuteReply> {
  const result = await founderRecordRead(
    ctx,
    P2P_DISPUTES_ESCALATE,
    { disputeId: request.disputeId, reason: request.reason, clientRequestId: request.clientRequestId },
    readEscalateAnswer,
  );
  if (result.kind !== 'ok') return failureRefusal('svc-p2p', 'p2p', result);
  const a = result.data;
  if (a.disputeId !== request.disputeId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  const count = `${a.escalations} ${a.escalations === 1 ? 'escalation' : 'escalations'} in all`;
  return {
    ok: true,
    detail: `svc-p2p answered: the dispute is escalated (${count}).${a.replay ? ' This repeated an earlier request, so nothing more was recorded.' : ''}`,
  };
}
