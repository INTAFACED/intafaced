/**
 * Consumes an identity action approval. A blank IDENTITY_URL refuses;
 * this service does not invent a second operator.
 */
import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  serviceAuthHeadersForBody,
  type ActionApproval,
} from '@intafaced/contracts';
import type { ApprovalBook, ApprovalConsumeInput, ApprovalConsumeResult } from './common.js';

function unwrap(body: unknown): unknown {
  const envelope = body as { result?: { data?: unknown } };
  const data = envelope.result?.data ?? body;
  return data && typeof data === 'object' && 'json' in (data as object) ? (data as { json: unknown }).json : data;
}

export function identityApprovalBook(identityUrl: string | undefined, internalSecret: string): ApprovalBook {
  const url = identityUrl?.trim() ?? '';
  if (!url) {
    return {
      async consume(): Promise<ApprovalConsumeResult> {
        return { ok: false, code: 'approval_mismatch' };
      },
    };
  }
  return {
    async consume(input: ApprovalConsumeInput): Promise<ApprovalConsumeResult> {
      const body = actionApprovalConsumeInputSchema.parse({
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: input.payloadHash,
        targetService: 'svc-trade',
        targetId: input.targetId,
        expectedVersion: input.expectedVersion,
        requestId: input.operationId,
      });
      const payload = JSON.stringify(body);
      let row: ActionApproval;
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/trpc/actionApproval.consume`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...serviceAuthHeadersForBody('svc-trade', internalSecret, payload),
          },
          body: payload,
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (text.includes('consumed')) return { ok: false, code: 'approval_reused' };
          if (res.status === 404) return { ok: false, code: 'approval_missing' };
          return { ok: false, code: 'approval_mismatch' };
        }
        row = actionApprovalSchema.parse(unwrap(await res.json()));
      } catch {
        return { ok: false, code: 'approval_mismatch' };
      }
      if (row.actionType !== input.actionType || !row.approverId) return { ok: false, code: 'approval_mismatch' };
      if (row.approverId.trim().toLowerCase() === row.requesterId.trim().toLowerCase()) {
        return { ok: false, code: 'approval_mismatch' };
      }
      return { ok: true, approverId: row.approverId, requesterId: row.requesterId };
    },
  };
}
