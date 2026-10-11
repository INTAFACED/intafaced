import { performance } from 'node:perf_hooks';
import { currentAuthorityInputSchema, currentAuthorityResultSchema, type CurrentAuthorityInput } from '@intafaced/contracts';
import type { CurrentAuthorityPort } from './authority.js';
import type { LiveCredentialInput } from './live-credential.js';

export const PRIVATE_AUTHORITY_MAX_MS = 5000;
export const PRIVATE_AUTHORITY_REQUEST_MS = 1000;
export interface AuthorityClock {
  monotonic(): number;
  wall(): number;
}
const clock: AuthorityClock = { monotonic: () => performance.now(), wall: () => Date.now() };
type LeaseOptions = {
  port: CurrentAuthorityPort;
  subject: CurrentAuthorityInput;
  jwtExpiresAtMs: number;
  policy?: LiveCredentialInput;
  additional?: () => Promise<unknown>;
  clock?: AuthorityClock;
};

/** An expired lease is terminal even if a pending read later reports eligible. */
export class PrivateAuthorityLease {
  private dead = false;
  private started = false;
  private expiry?: ReturnType<typeof setTimeout>;
  private renewal?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private onExpired: () => void = () => undefined;
  private readonly time: AuthorityClock;
  private constructor(
    private readonly options: LeaseOptions,
    private deadline: number,
  ) {
    this.time = options.clock ?? clock;
  }

  static async acquire(options: LeaseOptions): Promise<PrivateAuthorityLease> {
    const lease = new PrivateAuthorityLease(options, 0);
    lease.deadline = await lease.readDeadline();
    return lease;
  }

  isCurrent(): boolean {
    if (!this.dead && (this.time.monotonic() >= this.deadline || this.time.wall() >= this.options.jwtExpiresAtMs)) this.expire();
    return !this.dead;
  }

  start(onExpired: () => void): void {
    if (this.started) throw new Error('Private authority lease already started');
    this.started = true;
    this.onExpired = onExpired;
    const alreadyDead = this.dead;
    if (!this.isCurrent()) {
      if (alreadyDead) onExpired();
      return;
    }
    this.arm();
  }

  dispose(): void {
    this.dead = true;
    clearTimeout(this.expiry);
    clearTimeout(this.renewal);
    this.abort?.abort();
  }

  revoke(): void {
    this.expire();
  }

  private expire(): void {
    if (this.dead) return;
    this.dispose();
    this.onExpired();
  }

  private arm(): void {
    clearTimeout(this.expiry);
    clearTimeout(this.renewal);
    const remaining = this.deadline - this.time.monotonic();
    this.expiry = setTimeout(
      () => {
        if (this.isCurrent()) this.arm();
      },
      Math.max(0, remaining),
    );
    this.expiry.unref?.();
    this.renewal = setTimeout(
      () => {
        void this.renew();
      },
      Math.max(1, remaining / 2),
    );
    this.renewal.unref?.();
  }

  private async renew(): Promise<void> {
    if (!this.isCurrent()) return;
    try {
      const next = await this.readDeadline();
      // The old expiry timer remains armed throughout the request. A late
      // response cannot create a new lease on an expired/closed connection.
      if (!this.isCurrent()) return;
      this.deadline = next;
      this.arm();
    } catch {
      this.expire();
    }
  }

  private async readDeadline(): Promise<number> {
    const started = this.time.monotonic();
    const wallStarted = this.time.wall();
    const subject = currentAuthorityInputSchema.parse(this.options.subject);
    const controller = new AbortController();
    this.abort = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const read = Promise.all([this.options.port.read(subject, controller.signal, this.options.policy), this.options.additional?.()]).then(
        ([result]) => result,
      );
      const result = currentAuthorityResultSchema.parse(
        await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Private identity authority cancelled'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error('Private identity authority timed out'));
            }, PRIVATE_AUTHORITY_REQUEST_MS);
            timeout.unref?.();
          }),
        ]),
      );
      if (this.dead || result.status !== 'eligible' || JSON.stringify(result.subject) !== JSON.stringify(subject))
        throw new Error('Private identity authority denied');
      const now = this.time.monotonic();
      const wall = this.time.wall();
      const checked = Date.parse(result.checkedAt);
      const until = Date.parse(result.leaseExpiresAt);
      // Never trust eligibility from the future, including after a backward
      // local wall-clock jump. Request elapsed time is measured monotonically.
      if (checked > wall || checked > Math.ceil(wallStarted + (now - started))) throw new Error('Private identity clock mismatch');
      const deadline = Math.min(
        started + PRIVATE_AUTHORITY_MAX_MS,
        started + (until - checked),
        now + (until - wall),
        started + (this.options.jwtExpiresAtMs - wallStarted),
        now + (this.options.jwtExpiresAtMs - wall),
      );
      if (!Number.isFinite(deadline) || deadline <= now) throw new Error('Private identity authority expired');
      return deadline;
    } finally {
      clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
      if (this.abort === controller) this.abort = undefined;
    }
  }
}
