import 'server-only';
import {
  decodeRead,
  decodeToggle,
  unavailable,
  unresolved,
  type ControlPlaneState,
  type ToggleInput,
  type ToggleResult,
} from './control-plane-contract';
export type {
  AuditEntry,
  ControlPlaneState,
  ControlPlaneStatus,
  KillSwitchSnapshot,
  ToggleInput,
  ToggleResult,
} from './control-plane-contract';
import type { ModuleId } from '@intafaced/config';
import { describeUnconfigured, readConsoleStatus, type Authority } from '@/lib/console-status';

/**
 * THE WIRE FROM THIS CONSOLE TO THE PLATFORM (§14.6).
 *
 * Until this file existed, this app's own README said it plainly: "Flag
 * overrides staged on `/` are held in the browser session only", and the board
 * printed "Staged changes are held in this browser session and have not been
 * sent anywhere." `src/lib/operator-commands.ts` was blunter still about the
 * ledger controls: "They do NOT call them." §14.6 asks for a kill-switch an
 * operator can reach, and nothing here reached anything.
 *
 * It was not only this app. `svc-protocol` and `svc-indexer` each export a
 * `set…Enabled(next)` function commented "the kill-switch surface `apps/admin`
 * reaches" — module-scope functions in a service entry point, callable from no
 * other process. `svc-trade`, `svc-ws`, `svc-protocol` and `svc-token` read
 * their switch from an environment variable once, at boot. And `svc-ledger`
 * built the whole thing correctly — a durable `posting_freeze` row, an actor
 * column, a check constraint, `admin:treasury` on the procedures — then never
 * mounted the router that exposed them, so the platform's emergency stop was
 * reachable only by redeploying with `LEDGER_POSTING_ENABLED=false`, which per
 * `service.ts` "can freeze, and can never thaw".
 *
 * The honest summary of the state before this change: every kill-switch in the
 * platform required a redeploy, and the one surface that was supposed to reach
 * them reached nothing.
 *
 * ── The credential ──────────────────────────────────────────────────────────
 *
 * `ADMIN_OPERATOR_TOKEN` — an access token held server-side and never sent to
 * the browser. `ADMIN_TREASURY_TOKEN` is separate and optional, because halting
 * one market and halting all value movement are different authorities:
 * `admin:write` reaches the module switches, `admin:treasury` reaches the
 * ledger freeze, and a console configured with only the first cannot stop the
 * money plane. `svc-edge` enforces that split independently — this is not the
 * place it is decided, only the place it is respected.
 *
 * That the token identifies the CONSOLE rather than the human at it is a real
 * limitation, stated rather than hidden: this app has no login of its own (its
 * README has said so from the start), so the edge's audit line names one
 * operator identity per deployment. When operator SSO lands — the same §13
 * socket the README already names — these functions carry the signed-in
 * operator's own token and the audit line names the person.
 *
 * What it must not become in the meantime is a static shared secret with no
 * subject at all, which is why the token goes through the same
 * `verifyAccessToken` + `requireScope` path as every other caller.
 */

/** How long the console waits before reporting the control plane as unreachable. */
const TIMEOUT_MS = 5_000;

/**
 * The edge address plus the token for ONE authority, or the reason there is not
 * one.
 *
 * `readConsoleStatus` is the single place that decides what "configured" means,
 * so the banner in the layout, the panel on the board and the 503 from a BFF
 * route cannot disagree about whether this console can halt anything. The
 * `reason` it returns names the variable that is actually missing rather than
 * both candidates — the old copy said "Set EDGE_URL and ADMIN_OPERATOR_TOKEN"
 * even when `EDGE_URL` was already right, which sends an operator to check a
 * setting that was never the problem.
 */
function config(authority: Authority): { edgeUrl: string; token: string } | { reason: string } {
  const status = readConsoleStatus();
  const state = status[authority];
  if (!state.configured || !status.edgeUrl) return { reason: describeUnconfigured(state) };
  return { edgeUrl: status.edgeUrl, token: (process.env[state.tokenVar] ?? '').trim() };
}

const isConfigured = (cfg: ReturnType<typeof config>): cfg is { edgeUrl: string; token: string } => 'token' in cfg;

export async function readKillSwitches(): Promise<ControlPlaneState> {
  const cfg = config('module');
  if (!isConfigured(cfg)) return unavailable('unconfigured', cfg.reason, 'admin.kill_unconfigured', 503);
  try {
    const res = await fetch(`${cfg.edgeUrl}/admin/kill-switches`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return decodeRead(await res.json().catch(() => null), res.status, false);
  } catch {
    return unavailable('unreachable', 'svc-edge did not answer the original module state read.', 'admin.kill_read_unreachable', 502);
  }
}

/** Retained transport; the read-only inspector cannot arm it. No approval fields are invented. */
export async function setKillSwitch(input: ToggleInput): Promise<ToggleResult> {
  const intent = Object.freeze({ module: input.module, disabled: input.disabled, reason: input.reason });
  const cfg = config('module');
  if (!isConfigured(cfg))
    return {
      ok: false,
      status: 503,
      snapshot: { disabledModules: [], reasons: {}, audit: [] },
      detail: cfg.reason,
      code: 'admin.kill_unconfigured',
      uncertain: false,
      intent,
    };
  try {
    const res = await fetch(`${cfg.edgeUrl}/admin/kill-switches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(intent),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return decodeToggle(await res.json().catch(() => null), res.status, intent, false);
  } catch {
    return unresolved(intent, 'The connection ended before svc-edge confirmed the original module command outcome.');
  }
}

// ── The money plane ─────────────────────────────────────────────────────────

export interface FreezeState {
  readonly frozen: boolean;
  readonly reason: string | null;
  /** Who last moved it. Written by svc-ledger from its own token verification. */
  readonly actor: string | null;
  readonly changedAt: string | null;
}

export interface FreezeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly state: FreezeState | null;
  readonly detail: string | null;
}

export async function readFreeze(): Promise<FreezeResult> {
  const cfg = config('treasury');
  if (!isConfigured(cfg)) return { ok: false, status: 503, state: null, detail: cfg.reason };

  try {
    const res = await fetch(`${cfg.edgeUrl}/admin/ledger/freeze`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<FreezeState> & { error?: string; message?: string };
    if (!res.ok)
      return { ok: false, status: res.status, state: null, detail: body.error ?? body.message ?? `svc-edge answered ${res.status}` };

    return {
      ok: true,
      status: res.status,
      state: { frozen: body.frozen ?? false, reason: body.reason ?? null, actor: body.actor ?? null, changedAt: body.changedAt ?? null },
      detail: null,
    };
  } catch (err) {
    return { ok: false, status: 502, state: null, detail: `svc-edge did not answer: ${(err as Error).message}` };
  }
}

/**
 * Freeze or thaw ledger posting.
 *
 * A failure is never reported as a success. An operator who is told the platform
 * is halted when it is not is worse off than one who is told nothing — they walk
 * away from a book that is still accepting writes.
 */
export async function setFreeze(frozen: boolean, reason?: string): Promise<FreezeResult> {
  const cfg = config('treasury');
  if (!isConfigured(cfg)) return { ok: false, status: 503, state: null, detail: cfg.reason };

  try {
    const res = await fetch(`${cfg.edgeUrl}/admin/ledger/${frozen ? 'freeze' : 'unfreeze'}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      // A thaw carries no reason — svc-ledger clears the column, because "why it
      // is frozen" is meaningless once it is not.
      body: JSON.stringify(frozen ? { reason } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<FreezeState> & { error?: string; message?: string };
    if (!res.ok)
      return { ok: false, status: res.status, state: null, detail: body.error ?? body.message ?? `svc-edge answered ${res.status}` };

    return {
      ok: true,
      status: res.status,
      state: { frozen: body.frozen ?? frozen, reason: body.reason ?? null, actor: body.actor ?? null, changedAt: body.changedAt ?? null },
      detail: null,
    };
  } catch (err) {
    return { ok: false, status: 502, state: null, detail: `svc-edge did not answer: ${(err as Error).message}` };
  }
}
