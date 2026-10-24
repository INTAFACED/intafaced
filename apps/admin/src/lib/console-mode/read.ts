import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { isStorageUnconfigured, readConsoleMode, type ConsoleModeView } from './model';

export interface ConsoleModeRead {
  readonly asOf: string;
  readonly view: ConsoleModeView;
}

/**
 * How long the console waits for svc-ops' answer. The read sits in front of every page (the banner) and every write (the
 * hold), so a hung svc-ops costs each of them this much at most, and then the mode reads as not known.
 */
export const CONSOLE_MODE_READ_TIMEOUT_MS = 2_000;

/**
 * svc-ops `consoleMode.get` as the signed-in founder (`admin:read`): the one reader of the mode, used by the banner, the
 * desk and the write hold, so they cannot disagree about the same moment. Never throws; a failure is `unknown`, never "off".
 */
export async function loadConsoleMode(ctx: FounderCallContext): Promise<ConsoleModeRead> {
  const result = await founderCall(ctx, 'ops', 'consoleMode.get', 'GET', undefined, readConsoleMode, {
    timeoutMs: CONSOLE_MODE_READ_TIMEOUT_MS,
  });
  const asOf = new Date().toISOString();
  if (result.kind === 'ok') return { asOf, view: { kind: 'read', mode: result.data } };
  if (result.kind === 'refused' && isStorageUnconfigured(result.refusal.code)) return { asOf, view: { kind: 'unconfigured' } };
  const code = result.kind === 'refused' || result.kind === 'forbidden' ? result.refusal.code : null;
  const message =
    result.kind === 'forbidden'
      ? 'svc-ops did not accept your founder session for this read (it needs admin:read).'
      : result.kind === 'unavailable'
        ? 'svc-ops did not answer.'
        : result.kind === 'invalid'
          ? 'svc-ops answered in a shape this console does not understand.'
          : result.kind === 'not_built'
            ? 'svc-ops has no console mode on this deployment.'
            : 'svc-ops refused this read.';
  return { asOf, view: { kind: 'unknown', message, code } };
}
