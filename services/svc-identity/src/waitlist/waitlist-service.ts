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
 * No IFC, no token rewards, no ledger. `position` is FIFO join order; `rank` (RC-campaigns-03) is the place among the
 * entries still waiting, by referred_count descending then join order, so each referral moves its referrer up.
 * A wave release (operator, second person) releases the top N waiting entries once; N is the owner's wave size, and a
 * blank size refuses `drop.wave_unset` before anything is spent or written. A release is a record, never an account.
 */

import { assertEnabled, type FlagContext } from '@intafaced/config';
import {
  WaitlistStoreError,
  type WaitlistEnrollResult,
  type WaitlistEntry,
  type WaitlistStore,
  type WaitlistWave,
} from './waitlist-store.js';

/** The flag a wave release is gated by, recorded on the wave row. */
export const WAVE_FLAG_KEY = 'waitlist.enabled';

/** Owner setting: how many waiting entries one wave releases. NO DEFAULT; blank stays undefined and refuses every release. */
export function parseWaveSize(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 100_000) {
    throw new Error('IDENTITY_WAITLIST_WAVE_SIZE must be a whole number from 1 to 100000');
  }
  return Number(value);
}

export class WaitlistError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'waitlist.unbuilt'
      | 'waitlist.invalid'
      | 'waitlist.unknown_referrer'
      | 'waitlist.self_referral'
      | 'waitlist.not_found'
      | 'waitlist.referral_locked'
      | 'waitlist.wave_unknown'
      | 'waitlist.wave_empty'
      | 'drop.wave_unset',
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
  /** Place among the entries still waiting; null once released. */
  readonly rank: number | null;
  readonly waiting: number;
  readonly release: { readonly waveNumber: number; readonly releasedAt: Date } | null;
};

export type WaitlistWaves = {
  /** The owner's wave size; null while unset (every release refuses `drop.wave_unset`). */
  readonly waveSize: number | null;
  readonly nextWave: number;
  readonly waiting: number;
  readonly waves: readonly WaitlistWave[];
};

export type WaitlistList = {
  readonly total: number;
  readonly entries: readonly WaitlistEntry[];
};

export class WaitlistService {
  constructor(
    private readonly store: WaitlistStore,
    private readonly flags: FlagContext,
    private readonly waveSize?: number,
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
    const [standing, queueLength] = await Promise.all([this.store.standing(entry), this.store.count()]);
    return {
      position: entry.position,
      referralCode: entry.referralCode,
      referredCount: entry.referredCount,
      queueLength,
      ...standing,
    };
  }

  /** Operator view of the waves: the owner's size, the next wave number and every released wave. */
  async waves(): Promise<WaitlistWaves> {
    this.assertWaitlist();
    const [waves, waiting] = await Promise.all([this.store.waves(), this.store.waitingCount()]);
    return { waveSize: this.waveSize ?? null, nextWave: waves.length + 1, waiting, waves };
  }

  /**
   * Releases wave `waveNumber` (J-campaigns-20 #3). Refusals come before `authorize` spends the second person's
   * approval: flag off, blank size, a number that is not the next wave, nobody waiting. The same wave number again
   * returns the stored wave and spends nothing. `authorize` receives the size it binds the approval to.
   */
  async release(
    input: { waveNumber: number; releasedBy: string },
    authorize: (size: number) => Promise<{ approverId: string }>,
  ): Promise<{ wave: WaitlistWave; created: boolean }> {
    this.assertWaitlist();
    const size = this.waveSize;
    if (!size) throw new WaitlistError('The wave size is not set; no wave is released', 'drop.wave_unset');
    const [waves, waiting] = await Promise.all([this.store.waves(), this.store.waitingCount()]);
    const existing = waves.find((w) => w.waveNumber === input.waveNumber);
    if (existing) return { wave: existing, created: false };
    if (input.waveNumber !== waves.length + 1) {
      throw new WaitlistError(`The next wave is ${waves.length + 1}`, 'waitlist.wave_unknown');
    }
    if (waiting === 0) throw new WaitlistError('Nobody is waiting to be released', 'waitlist.wave_empty');
    const { approverId } = await authorize(size);
    try {
      return await this.store.releaseWave({
        waveNumber: input.waveNumber,
        size,
        flagKey: WAVE_FLAG_KEY,
        releasedBy: input.releasedBy,
        approvedBy: approverId,
      });
    } catch (err) {
      throw mapStoreError(err);
    }
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
