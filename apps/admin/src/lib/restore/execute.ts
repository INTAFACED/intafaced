import 'server-only';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { finalizeKey, refusalWords } from './model';

/**
 * The last step of a two-founder restore request: svc-ops `restore.record` (one stamp) or `restore.finalize` (one run), as the
 * founder who proposed it, with the approval a different founder signed. svc-ops spends the approval once and re-checks the joint
 * watermark itself; this file only carries the call and reads back what it stored.
 */

/** One approval is one stamp: running the same approved request again returns the first row (svc-ops' key and fingerprint). */
export const stampKey = (approvalId: string) => `restore:stamp:${approvalId}`;

export interface StampAnswer {
  readonly service: string;
  readonly kind: string;
  readonly watermark: string;
  readonly recordedAt: string;
}

export function readStampAnswer(raw: unknown): StampAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const { service, kind, watermark, recordedAt } = raw as Record<string, unknown>;
  if (typeof service !== 'string' || typeof kind !== 'string' || typeof watermark !== 'string' || typeof recordedAt !== 'string') return null;
  return { service, kind, watermark, recordedAt };
}

export interface FinalizeAnswer {
  readonly restoreNo: string;
  readonly restored: boolean;
}

export function readFinalizeAnswer(raw: unknown): FinalizeAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const { run, restored } = raw as Record<string, unknown>;
  if (!run || typeof run !== 'object' || typeof restored !== 'boolean') return null;
  const restoreNo = (run as Record<string, unknown>).restoreNo;
  return typeof restoreNo === 'string' ? { restoreNo, restored } : null;
}

const WRONG_STATE: ExecuteReply = { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };

/** svc-ops' own sentence for a restore code, in the room's words where it has them. */
function inRoomWords(reply: ExecuteReply): ExecuteReply {
  if (reply.ok) return reply;
  const words = refusalWords(reply.refusal.code);
  return words ? { ok: false, refusal: { ...reply.refusal, title: words } } : reply;
}

export function restoreExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request: DeskRequest, ids: { approvalId: string; operationId: string }): Promise<ExecuteReply> => {
    if (request.kind === 'ops.restore.record') {
      const result = await founderCall(
        ctx,
        'ops',
        'restore.record',
        'POST',
        { service: request.service, kind: request.stampKind, watermark: request.watermark, idempotencyKey: stampKey(ids.approvalId), ...ids },
        readStampAnswer,
      );
      if (result.kind !== 'ok') return inRoomWords(failureRefusal('svc-ops', 'ops', result));
      const a = result.data;
      if (a.service !== request.service || a.kind !== request.stampKind || a.watermark !== request.watermark) return WRONG_STATE;
      return { ok: true, detail: `svc-ops answered and holds the svc-${a.service} stamp ${a.watermark}, recorded ${a.recordedAt}.` };
    }
    if (request.kind === 'ops.restore.finalize') {
      const result = await founderCall(
        ctx,
        'ops',
        'restore.finalize',
        'POST',
        { restoreNo: request.restoreNo, idempotencyKey: finalizeKey(request.restoreNo), ...ids },
        readFinalizeAnswer,
      );
      if (result.kind !== 'ok') return inRoomWords(failureRefusal('svc-ops', 'ops', result));
      const a = result.data;
      if (a.restoreNo !== request.restoreNo) return WRONG_STATE;
      return {
        ok: true,
        detail: a.restored
          ? `svc-ops answered: run ${a.restoreNo} is restored, with all four steps recorded.`
          : `svc-ops answered, but run ${a.restoreNo} is not marked restored. Reload to see which step is missing.`,
      };
    }
    return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
  };
}
