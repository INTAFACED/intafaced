import { decodeFreezeState } from '@/lib/ledger-freeze-contract';
import type { ToggleResult } from '@/lib/control-plane-contract';
import { codeInText, explainRefusal, isKnownCode, type RefusalView } from './refusal-copy';

/**
 * What a service's answer to an approved command means. Pure, so each case is a test.
 *
 * The rule the whole desk follows: the console reports what the service SAID, then reads the state again and
 * shows that. It never advances a badge on its own. A 2xx only counts as "applied" when the body also shows the
 * state the command asked for; anything else is "outcome unknown", never "failed" and never "done".
 */

export type ExecuteDecoded = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly refusal: RefusalView };

/** The edge's `ToggleResult` (already decoded against the returned snapshot) as a desk reply. */
export function decodeKillExecute(result: ToggleResult): ExecuteDecoded {
  if (result.ok) {
    const module = result.intent?.module;
    const killed = module !== undefined && (result.snapshot.disabledModules as readonly string[]).includes(module);
    return {
      ok: true,
      detail: `svc-edge answered ${result.status} and its returned snapshot ${killed ? 'lists' : 'does not list'} ${module ?? 'the module'} as killed.`,
    };
  }
  const typed = codeInText(result.detail) ?? (isKnownCode(result.code) ? result.code : null);
  if (typed !== null) return { ok: false, refusal: explainRefusal(typed, result.status, false) };
  // `uncertain: false` is the edge/console saying nothing was dispatched or the edge refused before acting.
  return { ok: false, refusal: explainRefusal(result.code ?? null, result.status, result.uncertain !== false) };
}

export type RawFreezeAnswer =
  | { readonly reached: true; readonly status: number; readonly body: unknown }
  | { readonly reached: false; readonly sent: boolean; readonly detail: string };

function textField(body: unknown, keys: readonly string[]): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === 'string') return record[key];
  return null;
}

/**
 * The ledger's answer to a freeze (`frozen: true`) or unfreeze (`frozen: false`), relayed by the edge.
 * 2xx counts only when the returned record is a valid posting record in the state the command asked for.
 */
export function decodeFreezeExecute(answer: RawFreezeAnswer, frozen: boolean): ExecuteDecoded {
  if (!answer.reached) {
    return answer.sent
      ? { ok: false, refusal: explainRefusal(null, 0, true) }
      : { ok: false, refusal: explainRefusal('admin.ledger_unconfigured', 503, false) };
  }
  if (answer.status >= 200 && answer.status < 300) {
    const state = decodeFreezeState(answer.body);
    if (state && state.frozen === frozen) {
      return {
        ok: true,
        detail: `svc-ledger answered ${answer.status} and its returned record says posting is ${state.frozen ? 'frozen' : 'not frozen'}.`,
      };
    }
    return { ok: false, refusal: explainRefusal('admin.ledger_invalid_response', 502, true) };
  }
  const code = codeInText(textField(answer.body, ['message', 'error', 'detail'])) ?? textField(answer.body, ['code']);
  // A typed approval/edge refusal happens before the ledger changes anything; an untyped 5xx may not have.
  return { ok: false, refusal: explainRefusal(code, answer.status, isKnownCode(code) ? false : answer.status >= 500) };
}
