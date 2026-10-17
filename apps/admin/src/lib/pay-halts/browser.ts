/** Browser hop for the pay halts desk. Same-origin BFF only; no credential is held here. */
import type { PayHaltScope, PayHaltTarget } from '@intafaced/contracts';
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { Outcome } from './model';
import type { PayHaltsRead } from './types';

export interface HaltRequest {
  readonly action: 'halt' | 'clear' | 'confirm_clear';
  readonly requestId: string;
  readonly scope: PayHaltScope;
  readonly target: PayHaltTarget;
  readonly reason: string;
  readonly expectedVersion: string;
  readonly confirm: string;
}

export type HaltReply =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly outcome: Outcome;
      readonly action: HaltRequest['action'];
      readonly state: { readonly scope: string; readonly target: PayHaltTarget; readonly halted: boolean; readonly version: string };
    }
  | { readonly ok: false; readonly refusal: RefusalView };

const OUTCOMES: readonly string[] = ['changed', 'noop', 'conflict', 'pending_confirmation'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const UNKNOWN: HaltReply = {
  ok: false,
  refusal: {
    title: 'The console got an answer it could not read',
    body: 'It is not known whether the change went through.',
    next: 'Read the current state before doing anything again.',
    code: null,
    changed: 'unknown',
  },
};

/** Strict: anything that is not exactly a known answer is "outcome unknown", never a success. */
export function readHaltReply(raw: unknown): HaltReply {
  if (!isRecord(raw)) return UNKNOWN;
  if (raw.ok === false && isRecord(raw.refusal)) {
    const r = raw.refusal;
    if (
      typeof r.title === 'string' &&
      typeof r.body === 'string' &&
      typeof r.next === 'string' &&
      (r.changed === 'no' || r.changed === 'unknown')
    ) {
      return {
        ok: false,
        refusal: { title: r.title, body: r.body, next: r.next, code: typeof r.code === 'string' ? r.code : null, changed: r.changed },
      };
    }
    return UNKNOWN;
  }
  if (
    raw.ok === true &&
    typeof raw.requestId === 'string' &&
    typeof raw.outcome === 'string' &&
    OUTCOMES.includes(raw.outcome) &&
    isRecord(raw.state)
  ) {
    const st = raw.state;
    if (
      typeof st.scope === 'string' &&
      typeof st.halted === 'boolean' &&
      typeof st.version === 'string' &&
      isRecord(st.target) &&
      typeof st.target.level === 'string'
    ) {
      const action = raw.action === 'halt' || raw.action === 'clear' || raw.action === 'confirm_clear' ? raw.action : null;
      if (action) {
        return {
          ok: true,
          requestId: raw.requestId,
          outcome: raw.outcome as Outcome,
          action,
          state: { scope: st.scope, target: st.target as unknown as PayHaltTarget, halted: st.halted, version: st.version },
        };
      }
    }
  }
  return UNKNOWN;
}

export async function fetchPayHalts(signal?: AbortSignal): Promise<PayHaltsRead | null> {
  try {
    const res = await fetch('/api/pay-halts', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.status) && isRecord(body.pending) && isRecord(body.history)
      ? (body as unknown as PayHaltsRead)
      : null;
  } catch {
    return null;
  }
}

export async function postHalt(request: HaltRequest): Promise<HaltReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        title: 'Nothing was sent',
        body: error instanceof Error ? error.message : 'Your founder session could not be confirmed.',
        next: 'Sign in again, then repeat the step.',
        code: null,
        changed: 'no',
      },
    };
  }
  try {
    const res = await fetch('/api/pay-halts', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readHaltReply(await res.json().catch(() => null));
  } catch {
    return {
      ok: false,
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether this went through.',
        next: 'Read the current state before doing anything again. Repeating the same request is safe.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}

/** A fresh request reference for one change. Repeating a request with the SAME one is safe: svc-pay returns the same outcome. */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}
