import type { ModuleId } from '@intafaced/config';
import { isEdgePerimeterModule } from '@/lib/flag-state';
import { describeUnconfigured, type ConsoleStatus } from '@/lib/console-status';

/**
 * Which modules this console will arm a kill for, and when the whole control is switched off.
 *
 * Three refusals, each naming the failure it prevents:
 *   - A module the edge cannot enforce: the edge itself refuses to arm it, because a halt that returns 200 and
 *     refuses nothing is worse than no halt. Refused here too so no approval is spent on it.
 *   - `identity`: the approval and sign-in path runs ON identity. A killed identity refuses new mutations, including
 *     the approvals needed to turn it back on and every founder sign-in, so this console would strand itself.
 *     Identity incidents are handled with account freezes or an edge restart, not from here.
 *   - A deployment with no edge address or operator credential: nothing can be sent, so nothing is requested.
 */

export const SELF_LOCKOUT_MODULES: ReadonlySet<ModuleId> = new Set(['identity']);

export type KillRefusal = { readonly code: 'admin.kill_not_enforceable' | 'admin.kill_self_lockout'; readonly reason: string };

export function killRefusalFor(module: ModuleId): KillRefusal | null {
  if (SELF_LOCKOUT_MODULES.has(module)) {
    return {
      code: 'admin.kill_self_lockout',
      reason:
        'Identity carries founder sign-in and the approvals this console needs. Killing it would stop you from approving the re-enable, so this console will not arm it. Freeze accounts from Account controls, or have engineering restart the edge.',
    };
  }
  if (!isEdgePerimeterModule(module)) {
    return {
      code: 'admin.kill_not_enforceable',
      reason: 'No route on this edge forwards to this module, so a kill would be recorded but would refuse nothing. It is not offered.',
    };
  }
  return null;
}

/** Why the module kill desk is switched off for this deployment, or null when it can send. */
export function moduleKillBlockedReason(status: ConsoleStatus): string | null {
  return status.module.configured ? null : describeUnconfigured(status.module);
}

/** Modules the kill desk offers, in a stable order. */
export function killableModules(all: readonly ModuleId[]): readonly ModuleId[] {
  return all.filter((id) => killRefusalFor(id) === null);
}

export interface KillBadge {
  readonly state: 'stopped' | 'running' | 'unknown';
  readonly title: string;
  readonly reason: string | null;
  /** The newest audit entry the edge returned for this module, if any. Historical, not a receipt. */
  readonly lastChange: { readonly at: string; readonly actor: string; readonly confirmedBy: string | null; readonly reason: string } | null;
  readonly asOf: string | null;
}

/**
 * The current-state badge for one module. It reads only what the edge last returned; with no usable read it says
 * "unknown", never "running". `asOf` is when THIS console received that read, not when the edge last changed.
 */
export function killBadge(input: {
  module: ModuleId;
  snapshot: KillSwitchSnapshotLike | null;
  readAt: string | null;
  loading: boolean;
}): KillBadge {
  const { module, snapshot, readAt, loading } = input;
  if (!snapshot) {
    return {
      state: 'unknown',
      title: loading ? 'Reading the edge…' : 'Current state unknown: the edge read did not return a usable answer',
      reason: null,
      lastChange: null,
      asOf: null,
    };
  }
  const killed = snapshot.disabledModules.includes(module);
  const entry = snapshot.audit.find((a) => a.module === module) ?? null;
  return {
    state: killed ? 'stopped' : 'running',
    title: killed ? `${module} is KILLED at the edge: new commitments are refused` : `${module} is not listed as killed at the edge`,
    reason: killed ? (snapshot.reasons[module] ?? null) || null : null,
    lastChange: entry ? { at: entry.at, actor: entry.actor, confirmedBy: entry.confirmOperatorId ?? null, reason: entry.reason } : null,
    asOf: readAt,
  };
}

/** Structural subset of the edge snapshot the badge needs, so this file stays free of client-only imports. */
export interface KillSwitchSnapshotLike {
  readonly disabledModules: readonly ModuleId[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly audit: readonly {
    readonly at: string;
    readonly module: ModuleId;
    readonly actor: string;
    readonly confirmOperatorId?: string | null | undefined;
    readonly reason: string;
  }[];
}
