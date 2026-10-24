import type { FounderCallFailure } from './founder-call';
import { explainRefusal, type RefusalView } from './refusal-copy';

/**
 * A refused or failed write as the console's reply: its HTTP status and the refusal map's words. A dropped or garbled answer
 * to a write is an unknown outcome, never "not changed".
 */
export function writeRefusalOf<T>(result: FounderCallFailure<T>): { status: number; reply: { ok: false } & RefusalView } {
  const status =
    result.kind === 'refused' ? result.refusal.status : result.kind === 'forbidden' ? 403 : result.kind === 'not_built' ? 501 : 503;
  const code =
    result.kind === 'refused' ? result.refusal.code : result.kind === 'forbidden' ? (result.refusal.code ?? 'operator.denied') : null;
  const uncertain = result.kind === 'unavailable' ? result.uncertain : result.kind === 'invalid';
  return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false, ...explainRefusal(code, status, uncertain) } };
}
