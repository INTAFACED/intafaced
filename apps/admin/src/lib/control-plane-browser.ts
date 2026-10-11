/** Browser talks only to the same-origin BFF; deployment credentials stay server-side. */
import { founderMutationHeaders } from './founder-browser';
import {
  decodeRead,
  decodeToggle,
  unavailable,
  unresolved,
  type ControlPlaneState,
  type ToggleInput,
  type ToggleResult,
} from './control-plane-contract';
export type { AuditEntry, ControlPlaneState, ControlPlaneStatus, KillSwitchSnapshot, ToggleResult } from './control-plane-contract';

export async function fetchKillSwitches(options: { signal?: AbortSignal } = {}): Promise<ControlPlaneState> {
  try {
    const res = await fetch('/api/kill-switch', { cache: 'no-store', signal: options.signal });
    return decodeRead(await res.json().catch(() => null), res.status, true);
  } catch {
    return unavailable(
      'unreachable',
      options.signal?.aborted ? 'The original module read was cancelled.' : 'The module state service could not be reached.',
      options.signal?.aborted ? 'admin.kill_read_aborted' : 'admin.kill_read_unreachable',
    );
  }
}
/** Retained transport helper. The new inspector never calls this mutation. */
export async function postKillSwitch(input: ToggleInput): Promise<ToggleResult> {
  const intent = Object.freeze({ module: input.module, disabled: input.disabled, reason: input.reason });
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      snapshot: { disabledModules: [], reasons: {}, audit: [] },
      detail: error instanceof Error ? error.message : 'Founder session could not be confirmed. Nothing was sent.',
      code: 'admin.session_unconfirmed',
      uncertain: false,
      intent,
    };
  }
  try {
    const res = await fetch('/api/kill-switch', {
      method: 'POST',
      headers,
      body: JSON.stringify(intent),
      cache: 'no-store',
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 503 && body && typeof body === 'object' && 'code' in body && body.code === 'admin.kill_unconfigured')
      return {
        ok: false,
        status: 503,
        snapshot: { disabledModules: [], reasons: {}, audit: [] },
        detail: 'Module command was not dispatched because this console is unconfigured.',
        code: 'admin.kill_unconfigured',
        uncertain: false,
        intent,
      };
    return decodeToggle(body, res.status, intent, true);
  } catch {
    return unresolved(intent, 'The connection ended before the original module command outcome could be confirmed.');
  }
}
