import { isPublishedConnectionCeiling } from './max-connections.js';

/**
 * THE PER-IP CONNECTION CAP AND THE STORM BAN on the public stream doors (DV-limits-03, J-developer-09 #6).
 *
 * Three owner values, each blank until the owner publishes it:
 *
 *   · `WS_PER_IP_MAX_CONNECTIONS`   open public sockets one address may hold. One over it is refused
 *     `ws.per_ip_cap`; the sockets already open stay. Blank refuses every public socket
 *     `ws.per_ip_cap_unset`: no ceiling is invented.
 *   · `WS_PER_IP_STORMS_BEFORE_BAN` how many over-cap refusals (storms) ban the address.
 *   · `WS_PER_IP_BAN_SECONDS`       how long a ban lasts. Blank, or a blank storm count, refuses to enable the ban:
 *     the cap still holds and no address is ever banned; `GET /policy` says `ban: "unset"`.
 *
 * A storm count is forgotten once the address has gone a whole ban time with no storm, so a client that hit the cap
 * once a day is never banned for it. While banned, an address gets `ws.ip_banned` and no seat.
 *
 * The address is the TCP peer: this process is not behind svc-edge, so a forwarded header here is the caller talking
 * (`private/caller-ip.ts`).
 */

export const PER_IP_CAP = 'ws.per_ip_cap' as const;
export const PER_IP_CAP_UNSET = 'ws.per_ip_cap_unset' as const;
export const IP_BANNED = 'ws.ip_banned' as const;

export type PerIpRefusal = typeof PER_IP_CAP | typeof PER_IP_CAP_UNSET | typeof IP_BANNED;

export interface PerIpPolicy {
  readonly maxConnections: number | undefined;
  readonly stormsBeforeBan: number | undefined;
  readonly banSeconds: number | undefined;
}

/** What `GET /policy` publishes: the owner values as set, `null` where blank. */
export interface PerIpPolicyView {
  readonly maxConnections: number | null;
  readonly stormsBeforeBan: number | null;
  readonly banSeconds: number | null;
  readonly cap: 'set' | 'unset';
  readonly ban: 'set' | 'unset';
}

export type PerIpAdmission = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly code: PerIpRefusal };

interface AddressState {
  open: number;
  storms: number;
  lastStormAt: number;
  bannedUntil: number;
}

export class PerIpGuard {
  readonly #policy: PerIpPolicy;
  readonly #clock: () => number;
  readonly #addresses = new Map<string, AddressState>();

  constructor(policy: PerIpPolicy, clock: () => number = Date.now) {
    this.#policy = policy;
    this.#clock = clock;
  }

  get banEnabled(): boolean {
    return isPublishedConnectionCeiling(this.#policy.stormsBeforeBan) && isPublishedConnectionCeiling(this.#policy.banSeconds);
  }

  view(): PerIpPolicyView {
    const { maxConnections, stormsBeforeBan, banSeconds } = this.#policy;
    const cap = isPublishedConnectionCeiling(maxConnections);
    return {
      maxConnections: cap ? maxConnections : null,
      stormsBeforeBan: isPublishedConnectionCeiling(stormsBeforeBan) ? stormsBeforeBan : null,
      banSeconds: isPublishedConnectionCeiling(banSeconds) ? banSeconds : null,
      cap: cap ? 'set' : 'unset',
      ban: this.banEnabled ? 'set' : 'unset',
    };
  }

  /** One new public socket from `address`. A null address (no TCP peer) counts as one shared unknown address. */
  admit(address: string | null): PerIpAdmission {
    const max = this.#policy.maxConnections;
    if (!isPublishedConnectionCeiling(max)) return { ok: false, code: PER_IP_CAP_UNSET };
    const key = address ?? 'unknown';
    const now = this.#clock();
    const state = this.#addresses.get(key) ?? { open: 0, storms: 0, lastStormAt: 0, bannedUntil: 0 };
    this.#addresses.set(key, state);

    if (state.bannedUntil > now) return { ok: false, code: IP_BANNED };
    if (state.open >= max) {
      this.#storm(state, now);
      return { ok: false, code: PER_IP_CAP };
    }
    state.open += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        state.open = Math.max(0, state.open - 1);
        this.#forgetIfIdle(key, state);
      },
    };
  }

  #storm(state: AddressState, now: number): void {
    if (!this.banEnabled) return;
    const banMs = (this.#policy.banSeconds as number) * 1000;
    if (state.storms > 0 && now - state.lastStormAt >= banMs) state.storms = 0;
    state.storms += 1;
    state.lastStormAt = now;
    if (state.storms >= (this.#policy.stormsBeforeBan as number)) {
      state.bannedUntil = now + banMs;
      state.storms = 0;
    }
    // Storm and ban records outlive their sockets for at most one ban time; drop the spent ones so many addresses
    // that stormed once cannot grow this map without bound.
    for (const [key, other] of this.#addresses) {
      if (other.open === 0 && other.bannedUntil <= now && now - other.lastStormAt >= banMs) this.#addresses.delete(key);
    }
  }

  /** Addresses currently tracked (open sockets, a storm count or a ban). For tests and health. */
  get tracked(): number {
    return this.#addresses.size;
  }

  #forgetIfIdle(key: string, state: AddressState): void {
    if (state.open > 0 || state.bannedUntil > this.#clock() || state.storms > 0) return;
    this.#addresses.delete(key);
  }
}
