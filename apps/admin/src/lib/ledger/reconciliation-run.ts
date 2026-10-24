import { codeInText, explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';
import { upstreamCodeOf } from '@/lib/founder-session';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { describeRun, parseControlRun } from './reconciliation';

/** What the treasury hop to svc-edge brought back (`sendTreasuryControl`). Pure, so each case is a test. */
export type RunAnswer =
  | { readonly reached: true; readonly status: number; readonly body: unknown }
  | { readonly reached: false; readonly sent: boolean; readonly detail: string };

/** svc-ledger's answer to a run. A 2xx counts only when it is a run of the control asked for. */
export function decodeRunExecute(answer: RunAnswer, controlId: string): ExecuteReply {
  if (!answer.reached) {
    return answer.sent
      ? { ok: false, refusal: explainRefusal(null, 0, true) }
      : { ok: false, refusal: explainRefusal('admin.ledger_unconfigured', 503, false) };
  }
  if (answer.status >= 200 && answer.status < 300) {
    const run = parseControlRun(answer.body);
    if (run && run.controlId === controlId) return { ok: true, detail: describeRun(run) };
    return { ok: false, refusal: explainRefusal(null, 502, true) };
  }
  // Identity's approval refusals travel inside svc-ledger's message; every other code is read the way the other ledger routes read it.
  const message = answer.body && typeof answer.body === 'object' ? (answer.body as Record<string, unknown>).message : null;
  const code = codeInText(typeof message === 'string' ? message : null) ?? upstreamCodeOf(answer.body);
  return { ok: false, refusal: explainRefusal(code, answer.status, isKnownCode(code) ? false : answer.status >= 500) };
}
