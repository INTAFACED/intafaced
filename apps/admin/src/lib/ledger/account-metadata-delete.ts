import { codeInText, explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';
import { upstreamCodeOf } from '@/lib/founder-session';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import type { RunAnswer } from './reconciliation-run';
import { parseMetadataWrite } from './account-metadata';

/** svc-ledger's answer to an approved delete. A 2xx counts only when it is the delete of the key asked for. Pure. */
export function decodeMetadataDelete(answer: RunAnswer, accountId: string, key: string): ExecuteReply {
  if (!answer.reached) {
    return answer.sent
      ? { ok: false, refusal: explainRefusal(null, 0, true) }
      : { ok: false, refusal: explainRefusal('admin.ledger_unconfigured', 503, false) };
  }
  if (answer.status >= 200 && answer.status < 300) {
    const change = parseMetadataWrite(answer.body, accountId);
    if (change && change.action === 'delete' && change.key === key) {
      return {
        ok: true,
        detail: `Deleted ${key} (it was "${change.before ?? ''}"), asked by ${change.requesterId} and approved by ${change.approverId ?? 'nobody'}, at revision ${change.revision}.`,
      };
    }
    return { ok: false, refusal: explainRefusal(null, 502, true) };
  }
  // Identity's approval refusals travel inside svc-ledger's message; every other code is the ledger's own.
  const message = answer.body && typeof answer.body === 'object' ? (answer.body as Record<string, unknown>).message : null;
  const code = codeInText(typeof message === 'string' ? message : null) ?? upstreamCodeOf(answer.body);
  return { ok: false, refusal: explainRefusal(code, answer.status, isKnownCode(code) ? false : answer.status >= 500) };
}
