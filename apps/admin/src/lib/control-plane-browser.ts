/**
 * Browser-side hop to this app's own `/api/kill-switch` route.
 *
 * The edge token never leaves the server (`control-plane-client.ts`). The board
 * talks only to the Next route, which is the property §14.6 needs for
 * "reachable from apps/admin" without putting `admin:write` in devtools.
 */

import type { ModuleId } from '@intafaced/config';
import { founderMutationHeaders } from './founder-browser';

export type ControlPlaneStatus = 'reachable' | 'unconfigured' | 'unreachable';

export interface AuditEntry {
  readonly at: string;
  readonly module: string;
  readonly actor: string;
  readonly reason: string;
  readonly previous: boolean;
  readonly next: boolean;
  readonly changed: boolean;
}

export interface KillSwitchSnapshot {
  readonly disabledModules: readonly ModuleId[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly audit: readonly AuditEntry[];
}

export interface ControlPlaneState {
  readonly status: ControlPlaneStatus;
  readonly snapshot: KillSwitchSnapshot;
  readonly detail: string | null;
}

export interface ToggleResult {
  readonly ok: boolean;
  readonly status: number;
  readonly snapshot: KillSwitchSnapshot;
  readonly detail: string | null;
}

const EMPTY: KillSwitchSnapshot = { disabledModules: [], reasons: {}, audit: [] };

export async function fetchKillSwitches(): Promise<ControlPlaneState> {
  try {
    const res = await fetch('/api/kill-switch', { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as Partial<ControlPlaneState> & {
      error?: string;
      status?: ControlPlaneStatus;
      snapshot?: KillSwitchSnapshot;
      detail?: string | null;
    };

    if (body.status && body.snapshot) {
      return {
        status: body.status,
        snapshot: {
          disabledModules: body.snapshot.disabledModules ?? [],
          reasons: body.snapshot.reasons ?? {},
          audit: body.snapshot.audit ?? [],
        },
        detail: body.detail ?? null,
      };
    }

    return {
      status: res.ok ? 'reachable' : 'unreachable',
      snapshot: EMPTY,
      detail: body.error ?? body.detail ?? `console /api/kill-switch answered ${res.status}`,
    };
  } catch (err) {
    return { status: 'unreachable', snapshot: EMPTY, detail: (err as Error).message };
  }
}

export async function postKillSwitch(input: { module: ModuleId; disabled: boolean; reason: string }): Promise<ToggleResult> {
  try {
    const res = await fetch('/api/kill-switch', {
      method: 'POST',
      headers: await founderMutationHeaders(),
      body: JSON.stringify(input),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as Partial<ToggleResult> & { error?: string };
    if (typeof body.ok === 'boolean') {
      return {
        ok: body.ok,
        status: body.status ?? res.status,
        snapshot: body.snapshot ?? EMPTY,
        detail: body.detail ?? body.error ?? null,
      };
    }
    return {
      ok: false,
      status: res.status,
      snapshot: EMPTY,
      detail: body.error ?? `console /api/kill-switch answered ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: 502, snapshot: EMPTY, detail: (err as Error).message };
  }
}
