import { z } from 'zod';
import { setScopedBearer, type ApiClient, type ApiResult } from '../../../../shared/api';
import { MONEY_SCOPE, type MoneyKind } from './money-step';

/**
 * The "Confirm it's you" token for refunds and payouts, held in memory and nowhere else.
 *
 * The identity service mints a short token (ten minutes at most, not refreshable) that carries `pay:refund` or
 * `pay:payout` once the person proves a passkey or a six-digit authenticator code. This file holds it:
 *
 *  - in memory only: never storage, never a cookie, never a log line, never the page address;
 *  - for the money calls it was minted for and no others (`MONEY_CALLS`). Those calls name it as their own bearer
 *    for that one request (`api.mutate` asks `setScopedBearer`). Every other call keeps the normal session, and the
 *    normal session is never swapped, refreshed or mixed with it;
 *  - for one person in one business: it is dropped when the person signs out or the business changes, when it
 *    expires, when the service refuses it, and when the portal is left.
 *
 * Nothing technical reaches the screen: the page may say "Confirmed for the next N minutes" and nothing more.
 */

/** The only money calls that carry the token, and the scope each one needs. Anything not listed never sees it. */
const MONEY_CALLS: Readonly<Record<string, MoneyKind>> = {
  'payment.refund': 'refund',
  'settlement.payout': 'payout',
  'merchantControl.approvals.request': 'payout',
  'merchantControl.approvals.cancel': 'payout',
  'conversion.execute': 'payout',
};

/** A token with less than this left is not reused for a new action: the review and the send take a moment. */
export const REUSE_MARGIN_MS = 20_000;
/** The service caps a token at ten minutes; this holds it to that even if a reply said more. */
export const TOKEN_MAX_MS = 600_000;

const mintedSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().min(1),
  scopes: z.array(z.string()),
  refreshable: z.literal(false),
});

/** The token's own lifetime in ms (`exp - iat`), or null when it is not a readable token. It is only read, never trusted for more than ten minutes. */
function lifetimeOf(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    const { exp, iat } = (claims ?? {}) as { exp?: unknown; iat?: unknown };
    return typeof exp === 'number' && typeof iat === 'number' ? (exp - iat) * 1000 : null;
  } catch {
    return null;
  }
}

export type FactorProof = { totpCode: string } | { webauthn: unknown };

type Held = { token: string; expiresAt: number; timer: ReturnType<typeof setTimeout> | null };
type Ask = { id: number; kind: MoneyKind; expired: boolean; waiters: Array<(confirmed: boolean) => void> };
type Binding = { userId: string; merchantId: string };

export type StepUpSnapshot = { version: number; ask: { id: number; kind: MoneyKind; expired: boolean } | null };

export function createStepUpStore(clock: () => number = Date.now) {
  let bound: Binding | null = null;
  let owner: Binding | null = null;
  const held: Partial<Record<MoneyKind, Held>> = {};
  let ask: Ask | null = null;
  let asks = 0;
  let version = 0;
  let snapshot: StepUpSnapshot = { version, ask: null };
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function publish() {
    version += 1;
    snapshot = { version, ask: ask ? { id: ask.id, kind: ask.kind, expired: ask.expired } : null };
    for (const listener of [...listeners]) listener();
  }
  function forget(kind: MoneyKind, notify = true) {
    const was = held[kind];
    if (!was) return;
    if (was.timer) clearTimeout(was.timer);
    delete held[kind];
    if (notify) publish();
  }
  function dropAll() {
    const had = Object.keys(held).length > 0;
    for (const kind of Object.keys(held) as MoneyKind[]) forget(kind, false);
    owner = null;
    if (had) publish();
  }
  function settle(confirmed: boolean) {
    const current = ask;
    if (!current) return;
    ask = null;
    publish();
    for (const waiter of current.waiters) waiter(confirmed);
  }
  /** The token for this kind if it is held for the bound person and business with at least `margin` left. */
  function valid(kind: MoneyKind, margin = 0): Held | null {
    const found = held[kind];
    if (!found || !bound || !owner || owner.userId !== bound.userId || owner.merchantId !== bound.merchantId) return null;
    if (found.expiresAt - clock() <= margin) {
      if (found.expiresAt <= clock()) forget(kind);
      return null;
    }
    return found;
  }

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => snapshot,

    /**
     * The portal tells the store who is signed in to which business. A different person or business, or no one,
     * drops everything held. `ask` can only be answered while a portal is bound to put the question on screen.
     */
    bind(next: { userId: string | null; merchantId: string | null }) {
      if (leaving) clearTimeout(leaving);
      leaving = null;
      if (!next.userId || !next.merchantId) {
        bound = null;
        dropAll();
        settle(false);
        return;
      }
      if (owner && (owner.userId !== next.userId || owner.merchantId !== next.merchantId)) {
        dropAll();
        settle(false);
      }
      bound = { userId: next.userId, merchantId: next.merchantId };
      setScopedBearer((module, procedure) => (module === 'pay' ? store.bearerFor(procedure) : undefined));
    },
    /** The portal went away. A page change unmounts and mounts again in the same turn, so only a lasting absence drops the token. */
    unbind() {
      settle(false);
      if (leaving) clearTimeout(leaving);
      leaving = setTimeout(() => {
        leaving = null;
        bound = null;
        dropAll();
        setScopedBearer(null);
      }, 0);
    },
    /** True while a portal is on screen to ask. */
    get canAsk() {
      return bound !== null;
    },

    /** The bearer for this one money call, or undefined: the call then uses the normal session and the service refuses it. */
    bearerFor(procedure: string): string | undefined {
      const kind = MONEY_CALLS[procedure];
      return kind ? (valid(kind)?.token ?? undefined) : undefined;
    },
    /** Whole minutes this confirmation still covers (at least 1), or null when none is held. */
    minutesLeft(kind: MoneyKind): number | null {
      const found = valid(kind);
      return found ? Math.max(1, Math.ceil((found.expiresAt - clock()) / 60_000)) : null;
    },
    holds: (kind: MoneyKind) => valid(kind, REUSE_MARGIN_MS) !== null,
    drop(kind: MoneyKind) {
      forget(kind);
    },
    dropAll,

    /**
     * Keeps a token the service just minted. Refused unless it names the scope asked for, cannot be renewed, and has
     * a real expiry; it is held no longer than ten minutes whatever the reply says.
     */
    remember(kind: MoneyKind, reply: unknown): boolean {
      const parsed = mintedSchema.safeParse(reply);
      if (!parsed.success || !bound) return false;
      if (!parsed.data.scopes.includes(MONEY_SCOPE[kind])) return false;
      // The reply must carry a real expiry, but this device's clock is not trusted to read it: the token is held for its
      // own lifetime (exp - iat, from the token itself) counted from now, and never more than ten minutes.
      if (!Number.isFinite(Date.parse(parsed.data.expiresAt))) return false;
      const lifetime = Math.min(TOKEN_MAX_MS, lifetimeOf(parsed.data.accessToken) ?? TOKEN_MAX_MS);
      if (lifetime <= 0) return false;
      const expiresAt = clock() + lifetime;
      forget(kind, false);
      owner = { ...bound };
      const timer = setTimeout(() => forget(kind), Math.max(0, expiresAt - clock()) + 50);
      held[kind] = { token: parsed.data.accessToken, expiresAt, timer };
      publish();
      return true;
    },

    /**
     * Resolves true when a confirmation for `kind` is held with time to spare, asking the person for one if not.
     * Resolves false when they decline, or when no portal is on screen to ask.
     */
    async ensure(kind: MoneyKind, expired = false): Promise<boolean> {
      if (store.holds(kind)) return true;
      if (!bound) return false;
      if (ask) {
        // Someone is being asked already. The same question shares its answer; a different one waits its turn once.
        const current = ask;
        const answer = await new Promise<boolean>((resolve) => current.waiters.push(resolve));
        if (current.kind === kind) return answer && store.holds(kind);
        if (store.holds(kind)) return true;
        if (!bound || ask) return false;
      }
      return new Promise<boolean>((resolve) => {
        asks += 1;
        ask = { id: asks, kind, expired, waiters: [resolve] };
        publish();
      });
    },
    /** The dialog's two answers. */
    confirmed() {
      settle(true);
    },
    declined() {
      settle(false);
    },

    /**
     * Sends a money call under a confirmation. Asks first if none is held. If the service says the token is no good
     * (it ran out between the review and the send), asks again and sends the same call once more: `send` is the
     * caller's own function, so the same request id and the same idempotency key go out both times.
     */
    async run<T>(kind: MoneyKind, send: () => Promise<ApiResult<T>>, words: StepUpWords): Promise<ApiResult<T>> {
      if (!(await store.ensure(kind))) return words.required();
      const first = await send();
      if (first.ok || !isTokenRefused(first)) return first;
      store.drop(kind);
      if (!(await store.ensure(kind, true))) return words.expired();
      return send();
    },
  };
  return store;
}

export type StepUpWords = {
  required: <T>() => ApiResult<T>;
  expired: <T>() => ApiResult<T>;
};

/** The service turned the confirmation token away: it expired, or it is not the one this call needs. */
export function isTokenRefused(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  return result.reason === 'unauthorized' || result.code === 'auth.step_up_expired' || result.code === 'auth.step_up_required';
}

/**
 * Asks identity to mint the token. The call travels with the normal session, and a wrong code (identity answers it
 * with a 401) is its own answer: it does not end the session.
 */
export async function mintPayStepUp(
  api: ApiClient,
  input: { merchantId: string; kind: MoneyKind; proof: FactorProof },
  signal?: AbortSignal,
): Promise<ApiResult<z.infer<typeof mintedSchema>>> {
  return api.mutate(
    'identity',
    'auth.stepUpPay',
    { merchantId: input.merchantId, scopes: [MONEY_SCOPE[input.kind]], factorProof: input.proof },
    mintedSchema,
    { signal, keepSessionFor: ['auth.mfa_invalid', 'auth.webauthn_invalid'] },
  );
}

/** The one store the portal uses. Tests make their own with `createStepUpStore`. */
export const payStepUp = createStepUpStore();
