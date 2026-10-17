import { PayError } from './payment-service.js';

/**
 * pay.public-api step 4 — sandbox keys (ADR 2026-08-07 §2.5).
 *
 * Sandbox is a rail posture, not a second deployment. A sandbox principal
 * routes to the sandbox rail; a live principal may not name one.
 * The same key stamps an immutable sandbox flag on the payment.
 * `sandbox-ledger-guard.ts` then refuses that flag on any live account.
 * `assertRailMayMoveValue` remains the second gate for value-leaving
 * capabilities — this helper is the REST translation that picks the rail
 * before PayService runs.
 *
 * No invent rates. No live acquirer. No parallel sandbox stack.
 */

export type KeyEnv = 'live' | 'sandbox';

/** Known sandbox rail id used by the card sandbox adapter. */
export const DEFAULT_SANDBOX_RAIL_ID = 'card-sandbox';

/**
 * Heuristic for "this rail id is a sandbox simulation".
 *
 * Prefer exact id match; also catch the `*-sandbox` naming convention used
 * by fixtures. Live adapters must never use that suffix.
 */
export function isSandboxRailId(railId: string): boolean {
  if (railId === DEFAULT_SANDBOX_RAIL_ID) return true;
  return railId.endsWith('-sandbox');
}

/**
 * Disclose sandbox vs live from the rail id. Missing rail is NOT live —
 * that default is how a sandbox payment looks live on the wire.
 */
export function paymentModeFromRail(railAdapter: string | null | undefined): 'live' | 'sandbox' {
  if (!railAdapter || !railAdapter.trim()) {
    throw new PayError(
      'Payment rail is missing so mode cannot be disclosed. Refusing rather than reporting live. NOTHING WAS ATTEMPTED.',
      'pay.rail_mode_undisclosed',
    );
  }
  return isSandboxRailId(railAdapter) ? 'sandbox' : 'live';
}

/**
 * Sandbox keys must not observe live payments. Apply on GET / mutate / create
 * responses. List filters instead of throwing the whole page.
 */
export function assertSandboxKeyDoesNotLookLive(keyEnv: KeyEnv | undefined, railAdapter: string | null | undefined): void {
  if (keyEnv !== 'sandbox') return;
  if (paymentModeFromRail(railAdapter) === 'live') {
    throw new PayError(
      'A sandbox API key must not observe a live payment. Mint a live key for live rails. NOTHING WAS ATTEMPTED.',
      'pay.sandbox_looks_live',
    );
  }
}

/**
 * Resolve which rail a merchant REST createPayment may use, given the
 * principal's key environment and the rail the body named.
 *
 * - `sandbox` key → always the sandbox rail (body cannot escalate to live).
 * - `live` key (or missing key_env — treated as live) → body rail, but
 *   sandbox rails are refused. Absence is never upgraded to sandbox.
 */
export function resolveMerchantRail(input: { keyEnv: KeyEnv | undefined; requestedRail: string; sandboxRailId?: string }): string {
  const sandboxRail = input.sandboxRailId ?? DEFAULT_SANDBOX_RAIL_ID;
  const env: KeyEnv = input.keyEnv === 'sandbox' ? 'sandbox' : 'live';

  if (!input.requestedRail || !input.requestedRail.trim()) {
    throw new PayError('railAdapter is required', 'pay.validation_failed');
  }
  const requested = input.requestedRail.trim();

  if (env === 'sandbox') {
    // Sandbox key: force the sandbox rail. Caller may name it or something
    // else; they do not get a live rail under a sandbox credential.
    return sandboxRail;
  }

  // Live key (or session without key_env): may not use a sandbox rail.
  if (isSandboxRailId(requested)) {
    throw new PayError(
      `Rail "${requested}" is a SANDBOX and a live API key may not use it. ` +
        `Mint a sandbox key (mode=sandbox) to exercise the sandbox rail, or name a live rail. ` +
        `NOTHING WAS ATTEMPTED.`,
      'pay.sandbox_rail_refused',
    );
  }

  return requested;
}
