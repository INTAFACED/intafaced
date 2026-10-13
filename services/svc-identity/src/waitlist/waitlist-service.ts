/**
 * Waitlist capture + referral queue — drop 0 tease surface.
 *
 * Gates on `assertEnabled` from `@intafaced/config` (the #1590 product door).
 * Flag OFF → named FlagDisabledError, no silent enroll.
 * Store missing is the request-path "unbuilt" refuse (wired in index.ts).
 *
 * FLAG_REGISTRY marks both keys `request-path` on this service so OFF reads
 * as a built control (`overridden` / `killed`), not unbuilt plan.
 *
 * No IFC, no token rewards, no ledger. Position is FIFO join order;
 * a referral records attribution + referred_count only.
 */

import { assertEnabled, type FlagContext } from '@intafaced/config';
import { WaitlistStoreError, type WaitlistEnrollResult, type WaitlistEntry, type WaitlistStore } from './waitlist-store.js';

export class WaitlistError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'waitlist.unbuilt'
      | 'waitlist.invalid'
      | 'waitlist.unknown_referrer'
      | 'waitlist.self_referral'
      | 'waitlist.not_found'
      | 'waitlist.referral_locked',
  ) {
    super(message);
    this.name = 'WaitlistError';
  }
}

export type WaitlistPosition = {
  readonly position: number;
  readonly referralCode: string;
  readonly referredCount: number;
  readonly queueLength: number;
};

export type WaitlistList = {
  readonly total: number;
  readonly entries: readonly WaitlistEntry[];
};

export class WaitlistService {
  constructor(
    private readonly store: WaitlistStore,
    private readonly flags: FlagContext,
  ) {}

  /**
   * Public enroll. `referralCode` requires `referral.queue` as well as
   * `waitlist.enabled` — a code must not be silently discarded.
   * A repeat enroll with a code attaches it when the row has none, and
   * refuses when the row already has a different one.
   */
  async enroll(input: { email: string; referralCode?: string }): Promise<WaitlistEnrollResult> {
    this.assertWaitlist();
    const trimmed = input.referralCode?.trim();
    const referredBy = trimmed ? trimmed : null;
    if (referredBy) this.assertReferralQueue();
    try {
      return await this.store.enroll({ email: input.email, referredBy });
    } catch (err) {
      throw mapStoreError(err);
    }
  }

  /** Public place-in-line by the code returned at enroll. */
  async position(referralCode: string): Promise<WaitlistPosition> {
    this.assertReferralQueue();
    let entry: WaitlistEntry | null;
    try {
      entry = await this.store.getByCode(referralCode);
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!entry) throw new WaitlistError('Referral code is not on the waitlist', 'waitlist.not_found');
    return {
      position: entry.position,
      referralCode: entry.referralCode,
      referredCount: entry.referredCount,
      queueLength: await this.store.count(),
    };
  }

  /** Operator FIFO list. Includes email (PII) — admin:read only at the router. */
  async list(input: { limit: number; offset: number }): Promise<WaitlistList> {
    this.assertWaitlist();
    return this.store.list(input);
  }

  private assertWaitlist(): void {
    assertEnabled('waitlist.enabled', this.flags);
  }

  private assertReferralQueue(): void {
    assertEnabled('referral.queue', this.flags);
  }
}

function mapStoreError(err: unknown): WaitlistError {
  if (err instanceof WaitlistError) return err;
  if (err instanceof WaitlistStoreError) {
    return new WaitlistError(err.message, err.code);
  }
  throw err;
}
