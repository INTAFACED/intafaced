/**
 * Browser-side hop to this app's own `/api/ledger-freeze` route.
 *
 * The mirror of `control-plane-browser.ts`, and it exists for the same reason:
 * `ADMIN_TREASURY_TOKEN` stays on the server. A board that called svc-edge
 * directly would have to ship a token carrying `admin:treasury` — the authority
 * to halt ALL value movement — into a bundle.
 *
 * ── Why this file is new and the route is not ───────────────────────────────
 *
 * `src/app/api/ledger-freeze/route.ts` has been a complete, correct BFF since
 * #186: it validates, it forwards, and it passes svc-ledger's failures through
 * with their own status instead of flattening them to 200. It had ZERO callers.
 * `/ledger` rendered `src/lib/operator-commands.ts` instead — stubs whose own
 * header said "They do NOT call them" — so the console had two freeze paths, one
 * real and unreachable, one reachable and fake, and the screen an operator opens
 * during an incident was the fake one.
 *
 * There is now one path.
 */

import { founderMutationHeaders } from './founder-browser';

export interface FreezeState {
  readonly frozen: boolean;
  readonly reason: string | null;
  /** Written by svc-ledger from its OWN token verification, never by this app. */
  readonly actor: string | null;
  readonly changedAt: string | null;
}

export interface FreezeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly state: FreezeState | null;
  /** One sentence an operator can act on. Null only when `ok`. */
  readonly detail: string | null;
}

/**
 * Read whatever the route answered, WITHOUT inventing a success.
 *
 * The route's own body already carries `ok`. When it does not — a proxy served
 * an error page, the app is behind a gate that answered HTML — the result is a
 * failure carrying the status, not a `frozen: false` that would tell an operator
 * the book is accepting writes when nobody has checked.
 */
function interpret(res: Response, body: Partial<FreezeResult> & { error?: string }): FreezeResult {
  if (typeof body.ok === 'boolean') {
    return {
      ok: body.ok,
      status: body.status ?? res.status,
      state: body.state ?? null,
      detail: body.detail ?? body.error ?? null,
    };
  }
  return {
    ok: false,
    status: res.status,
    state: null,
    detail: body.error ?? `console /api/ledger-freeze answered ${res.status}`,
  };
}

export async function fetchFreeze(): Promise<FreezeResult> {
  try {
    const res = await fetch('/api/ledger-freeze', { cache: 'no-store' });
    return interpret(res, (await res.json().catch(() => ({}))) as Partial<FreezeResult> & { error?: string });
  } catch (err) {
    // A network failure is not "not frozen". 502 with the reason.
    return { ok: false, status: 502, state: null, detail: (err as Error).message };
  }
}

/**
 * Freeze or thaw ledger posting.
 *
 * A thaw carries no reason: svc-ledger clears the column, because "why it is
 * frozen" is meaningless once it is not.
 */
export async function postFreeze(input: { frozen: boolean; reason?: string }): Promise<FreezeResult> {
  try {
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: await founderMutationHeaders(),
      body: JSON.stringify(input.frozen ? { frozen: true, reason: input.reason } : { frozen: false }),
      cache: 'no-store',
    });
    return interpret(res, (await res.json().catch(() => ({}))) as Partial<FreezeResult> & { error?: string });
  } catch (err) {
    return { ok: false, status: 502, state: null, detail: (err as Error).message };
  }
}
