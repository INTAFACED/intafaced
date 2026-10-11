/** Browser transport to the gated BFF. No deployment credential enters this module. */
import { founderMutationHeaders } from './founder-browser';
import {
  decodeFreezeRead,
  decodeFreezeCommand,
  freezeUnavailable,
  freezeUnresolved,
  type FreezeResult,
  type FreezeIntent,
  type FreezeCommandResult,
} from './ledger-freeze-contract';
export type { FreezeState, FreezeResult, FreezeIntent, FreezeCommandResult } from './ledger-freeze-contract';

export async function fetchFreeze(signal?: AbortSignal): Promise<FreezeResult> {
  try {
    const res = await fetch('/api/ledger-freeze', {
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    });
    return decodeFreezeRead(await res.json().catch(() => null), res.status, true);
  } catch {
    return freezeUnavailable(
      'unreachable',
      'The connection ended before the ledger posting read completed.',
      'admin.ledger_read_unreachable',
      502,
    );
  }
}

// Retained-helper guard only; no new UI caller. No actor identity is invented and
// no private input is persisted. A reload loses this scope; it is not durable recovery.
let original: FreezeCommandResult | null = null;
let pending: FreezeIntent | null = null;
export async function postFreeze(input: FreezeIntent): Promise<FreezeCommandResult> {
  if (original) return original;
  if (pending) return freezeUnresolved(pending, 'The earlier ledger request is still unresolved. No second request was sent.');
  const intent = Object.freeze(
    input.frozen ? { frozen: true, ...(input.reason === undefined ? {} : { reason: input.reason }) } : { frozen: false },
  );
  pending = intent;
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    pending = null;
    return {
      ok: false,
      status: 502,
      state: null,
      detail: error instanceof Error ? error.message : 'Founder session could not be confirmed. Nothing was sent.',
      code: 'admin.session_unconfirmed',
      uncertain: false,
      intent,
    };
  }
  let result: FreezeCommandResult;
  try {
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers,
      body: JSON.stringify(intent),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    result = decodeFreezeCommand(await res.json().catch(() => null), res.status, intent, true);
  } catch {
    result = freezeUnresolved(intent, 'The connection ended before the original ledger command outcome was verified.');
  }
  if (result.uncertain) original = result;
  pending = null;
  return result;
}
