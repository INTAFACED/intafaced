/**
 * Identity consume for publishing a notice. Blank IDENTITY_URL or
 * INTERNAL_SERVICE_SECRET leaves this unwired; publish then refuses
 * `notify.notice_publish_approval_unavailable` rather than inventing a second person.
 */

import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  serviceAuthHeadersForBody,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import type { NoticeApprovalConsumer } from './board.js';

export function noticeApprovalConsumerFromProcessEnv(): NoticeApprovalConsumer | null {
  const url = process.env.IDENTITY_URL?.trim() ?? '';
  const secret = process.env.INTERNAL_SERVICE_SECRET?.trim() ?? '';
  if (!url || secret.length < 32) return null;
  try {
    void new URL(url);
  } catch {
    return null;
  }
  return createNoticeApprovalClient(url, secret);
}

function unwrapTrpcJson(body: unknown): unknown {
  const envelope = body as { result?: { data?: unknown } };
  const data = envelope.result?.data ?? body;
  return data && typeof data === 'object' && 'json' in (data as object) ? (data as { json: unknown }).json : data;
}

export function createNoticeApprovalClient(baseUrl: string, internalSecret: string): NoticeApprovalConsumer {
  const url = baseUrl.replace(/\/$/, '');
  return {
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const res = await fetch(`${url}/trpc/actionApproval.consume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody('svc-notify', internalSecret, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) {
        throw new Error(`identity refused consume (${res.status})`);
      }
      return actionApprovalSchema.parse(unwrapTrpcJson(await res.json()));
    },
  };
}
