import 'server-only';
import type { CustomerDetailsResult } from '@intafaced/contracts';
import type { FounderCallResult } from '@/lib/desk/founder-call';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { detailsReply } from './details';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Identity's answer to an edit or a decision, in words, or why it could not be had. */
export function detailsAnswer(result: FounderCallResult<CustomerDetailsResult>, userId: string): Response {
  if (result.kind !== 'ok') {
    const failed = failureRefusal('svc-identity', 'identity', result);
    const refusal = failed.ok ? null : failed.refusal;
    return Response.json(
      {
        ok: false,
        text: refusal ? `${refusal.title}. ${refusal.body}${refusal.code ? ` (${refusal.code})` : ''}` : 'Identity did not answer.',
      },
      { status: 502, headers: NO_STORE },
    );
  }
  if (result.data.userId !== userId)
    return Response.json(
      { ok: false, text: 'Identity answered for another customer. Read the account again.' },
      { status: 502, headers: NO_STORE },
    );
  const reply = detailsReply(result.data);
  return Response.json({ ...reply, outcome: result.data.outcome }, { status: reply.ok ? 200 : 409, headers: NO_STORE });
}
