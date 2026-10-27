import 'server-only';
import { consoleModeSetOutputSchema } from '@intafaced/contracts/ops-console-mode';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
export { loadConsoleMode, type ConsoleModeRead } from './read';

const WRONG_STATE: ExecuteReply = { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };

/** Run an approved maintenance-mode change. Done only when svc-ops returns the mode the approval asked for. */
export function consoleModeExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'ops.console_mode.on' && request.kind !== 'ops.console_mode.off') {
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    }
    const input =
      request.kind === 'ops.console_mode.on' ? { action: request.kind, reason: request.reason, ...ids } : { action: request.kind, ...ids };
    const result = await founderCall(ctx, 'ops', 'consoleMode.set', 'POST', input, (raw) => {
      const parsed = consoleModeSetOutputSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    });
    if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
    const { mode, outcome } = result.data;
    // A replay answers with the mode in force now, which a later change may have moved on; a change or no-op must match.
    if (outcome !== 'replayed' && mode.readOnly !== (request.kind === 'ops.console_mode.on')) return WRONG_STATE;
    const now = mode.readOnly ? 'on: this console is read-only' : 'off: this console takes writes';
    return {
      ok: true,
      detail:
        outcome === 'changed'
          ? `svc-ops answered: maintenance mode is ${now}.`
          : outcome === 'noop'
            ? `svc-ops answered: maintenance mode was already ${now}.`
            : `svc-ops answered: this approved change was already stored; maintenance mode is ${now}.`,
    };
  };
}
