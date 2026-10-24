/**
 * Durable waitlist + referral queue (drop 0 tease).
 *
 * Email capture, join order, the referral rank and released waves. No IFC, no token rewards, no ledger.
 * Distinct from `referral_edges` (account affiliate tree).
 *
 * Rank (RC-campaigns-03) is computed on read from the stored `referred_count` and join order, among the entries still
 * waiting, so a referral moves its referrer up at once and no job can drift. A wave releases the top N waiting entries:
 * one release row per entry, written with the wave row in one transaction.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';

export type WaitlistEntry = {
  readonly id: string;
  readonly email: string;
  readonly referralCode: string;
  readonly referredBy: string | null;
  readonly position: number;
  readonly referredCount: number;
  readonly createdAt: Date;
};

export type WaitlistEnrollResult = {
  readonly entry: WaitlistEntry;
  /**
   * false = this email was already on the list. Position does not move.
   * A referral may still be attached on that call when the row had none.
   */
  readonly created: boolean;
};

/**
 * What a repeat enroll does with a referral code.
 *
 * Returning the existing row and ignoring the code is a silent queue: the
 * caller thinks the code was accepted. Own-code is not an attribution (the
 * row already is that code). A different code on a row that already has one
 * refuses. A code on a row that has none attaches once.
 */
export function lateReferralDecision(
  existing: { readonly referralCode: string; readonly referredBy: string | null },
  referredBy: string | null,
):
  | { readonly kind: 'return' }
  | { readonly kind: 'attach' }
  | { readonly kind: 'refuse'; readonly code: 'waitlist.referral_locked'; readonly message: string } {
  if (!referredBy) return { kind: 'return' };
  if (referredBy === existing.referralCode) return { kind: 'return' };
  if (existing.referredBy === referredBy) return { kind: 'return' };
  if (existing.referredBy) {
    return {
      kind: 'refuse',
      code: 'waitlist.referral_locked',
      message: 'This email already has a referral code',
    };
  }
  return { kind: 'attach' };
}

/** One released wave. `size` is the owner's wave size at release; `releasedCount` may be lower when fewer were waiting. */
export type WaitlistWave = {
  readonly id: string;
  readonly waveNumber: number;
  readonly size: number;
  readonly releasedCount: number;
  readonly flagKey: string;
  readonly releasedBy: string;
  readonly approvedBy: string;
  readonly releasedAt: Date;
};

/** Where one entry stands: its rank among those still waiting (null once released) and the wave that released it. */
export type WaitlistStanding = {
  readonly rank: number | null;
  readonly waiting: number;
  readonly release: { readonly waveNumber: number; readonly releasedAt: Date } | null;
};

export type WaveReleaseInput = {
  readonly waveNumber: number;
  readonly size: number;
  readonly flagKey: string;
  readonly releasedBy: string;
  readonly approvedBy: string;
};

/** Queue order: more referrals first, ties by join order. */
export function byRank(a: Pick<WaitlistEntry, 'referredCount' | 'position'>, b: Pick<WaitlistEntry, 'referredCount' | 'position'>): number {
  return b.referredCount - a.referredCount || a.position - b.position;
}

/** The business key of one entry's release. */
export const releaseKey = (waveNumber: number, entryId: string) => `wave:${waveNumber}:${entryId}`;

export interface WaitlistStore {
  enroll(input: { email: string; referredBy?: string | null }): Promise<WaitlistEnrollResult>;
  getByCode(referralCode: string): Promise<WaitlistEntry | null>;
  getByEmail(email: string): Promise<WaitlistEntry | null>;
  list(input: { limit: number; offset: number }): Promise<{ total: number; entries: readonly WaitlistEntry[] }>;
  count(): Promise<number>;
  standing(entry: WaitlistEntry): Promise<WaitlistStanding>;
  waitingCount(): Promise<number>;
  waves(): Promise<readonly WaitlistWave[]>;
  /**
   * Releases wave `waveNumber`: the top `size` waiting entries, once. The same wave number again returns the stored wave
   * (`created: false`) and writes nothing. Refuses a number that is not the next one (`waitlist.wave_unknown`) and a
   * queue with nobody waiting (`waitlist.wave_empty`).
   */
  releaseWave(input: WaveReleaseInput): Promise<{ wave: WaitlistWave; created: boolean }>;
}

export class WaitlistStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'waitlist.invalid'
      | 'waitlist.unknown_referrer'
      | 'waitlist.self_referral'
      | 'waitlist.referral_locked'
      | 'waitlist.wave_unknown'
      | 'waitlist.wave_empty',
  ) {
    super(message);
    this.name = 'WaitlistStoreError';
  }
}

const CODE_RE = /^[a-f0-9]{12}$/;

export function normalizeWaitlistEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 320) {
    throw new WaitlistStoreError('Waitlist email is invalid', 'waitlist.invalid');
  }
  return email;
}

export function normalizeReferralCode(raw: string): string {
  const code = raw.trim().toLowerCase();
  if (!CODE_RE.test(code)) {
    throw new WaitlistStoreError('Referral code is invalid', 'waitlist.invalid');
  }
  return code;
}

export function newReferralCode(): string {
  return randomBytes(6).toString('hex');
}

function toEntry(row: {
  id: string;
  email: string;
  referral_code: string;
  referred_by: string | null;
  position: string | number | bigint;
  referred_count: number;
  created_at: Date;
}): WaitlistEntry {
  return {
    id: row.id,
    email: row.email,
    referralCode: row.referral_code,
    referredBy: row.referred_by,
    position: Number(row.position),
    referredCount: row.referred_count,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

/** In-memory store for unit / router tests. */
export class MemoryWaitlistStore implements WaitlistStore {
  private readonly byEmail = new Map<string, WaitlistEntry>();
  private readonly byCode = new Map<string, WaitlistEntry>();
  private readonly releases = new Map<string, { waveNumber: number; releasedAt: Date }>();
  private readonly waveRows: WaitlistWave[] = [];
  private nextPosition = 1;

  async enroll(input: { email: string; referredBy?: string | null }): Promise<WaitlistEnrollResult> {
    const email = normalizeWaitlistEmail(input.email);
    const referredBy = input.referredBy ? normalizeReferralCode(input.referredBy) : null;
    const existing = this.byEmail.get(email);
    if (existing) return this.attachIfOpen(existing, referredBy);

    if (referredBy) {
      const referrer = this.byCode.get(referredBy);
      if (!referrer) throw new WaitlistStoreError('Referral code is not on the waitlist', 'waitlist.unknown_referrer');
      if (referrer.email === email) {
        throw new WaitlistStoreError('Self-referral is refused', 'waitlist.self_referral');
      }
    }

    let code = newReferralCode();
    while (this.byCode.has(code)) code = newReferralCode();

    const entry: WaitlistEntry = {
      id: randomUUID(),
      email,
      referralCode: code,
      referredBy,
      position: this.nextPosition++,
      referredCount: 0,
      createdAt: new Date(),
    };
    this.byEmail.set(email, entry);
    this.byCode.set(code, entry);

    if (referredBy) {
      const referrer = this.byCode.get(referredBy);
      if (referrer) {
        const bumped: WaitlistEntry = { ...referrer, referredCount: referrer.referredCount + 1 };
        this.byCode.set(referrer.referralCode, bumped);
        this.byEmail.set(referrer.email, bumped);
      }
    }

    return { entry, created: true };
  }

  /** Repeat enroll. A new code on an unattributed row attaches once. */
  private attachIfOpen(existing: WaitlistEntry, referredBy: string | null): WaitlistEnrollResult {
    const decision = lateReferralDecision(existing, referredBy);
    if (decision.kind === 'return') return { entry: existing, created: false };
    if (decision.kind === 'refuse') throw new WaitlistStoreError(decision.message, decision.code);
    const code = referredBy;
    if (!code) return { entry: existing, created: false };
    const referrer = this.byCode.get(code);
    if (!referrer) throw new WaitlistStoreError('Referral code is not on the waitlist', 'waitlist.unknown_referrer');
    if (referrer.email === existing.email) {
      throw new WaitlistStoreError('Self-referral is refused', 'waitlist.self_referral');
    }
    const updated: WaitlistEntry = { ...existing, referredBy: code };
    this.byEmail.set(existing.email, updated);
    this.byCode.set(existing.referralCode, updated);
    const bumped: WaitlistEntry = { ...referrer, referredCount: referrer.referredCount + 1 };
    this.byCode.set(referrer.referralCode, bumped);
    this.byEmail.set(referrer.email, bumped);
    return { entry: updated, created: false };
  }

  async getByCode(referralCode: string): Promise<WaitlistEntry | null> {
    return this.byCode.get(normalizeReferralCode(referralCode)) ?? null;
  }

  async getByEmail(email: string): Promise<WaitlistEntry | null> {
    return this.byEmail.get(normalizeWaitlistEmail(email)) ?? null;
  }

  async list(input: { limit: number; offset: number }): Promise<{ total: number; entries: readonly WaitlistEntry[] }> {
    const all = [...this.byEmail.values()].sort((a, b) => a.position - b.position);
    const limit = Math.min(Math.max(input.limit, 1), 200);
    const offset = Math.max(input.offset, 0);
    return { total: all.length, entries: all.slice(offset, offset + limit) };
  }

  async count(): Promise<number> {
    return this.byEmail.size;
  }

  private waitingEntries(): WaitlistEntry[] {
    return [...this.byEmail.values()].filter((e) => !this.releases.has(e.id)).sort(byRank);
  }

  async standing(entry: WaitlistEntry): Promise<WaitlistStanding> {
    const current = this.byEmail.get(entry.email) ?? entry;
    const waiting = this.waitingEntries();
    const release = this.releases.get(current.id) ?? null;
    return { rank: release ? null : waiting.findIndex((e) => e.id === current.id) + 1, waiting: waiting.length, release };
  }

  async waitingCount(): Promise<number> {
    return this.waitingEntries().length;
  }

  async waves(): Promise<readonly WaitlistWave[]> {
    return [...this.waveRows];
  }

  async releaseWave(input: WaveReleaseInput): Promise<{ wave: WaitlistWave; created: boolean }> {
    const existing = this.waveRows.find((w) => w.waveNumber === input.waveNumber);
    if (existing) return { wave: existing, created: false };
    if (input.waveNumber !== this.waveRows.length + 1) {
      throw new WaitlistStoreError(`The next wave is ${this.waveRows.length + 1}`, 'waitlist.wave_unknown');
    }
    const picks = this.waitingEntries().slice(0, input.size);
    if (picks.length === 0) throw new WaitlistStoreError('Nobody is waiting to be released', 'waitlist.wave_empty');
    const releasedAt = new Date();
    const wave: WaitlistWave = { id: randomUUID(), ...input, releasedCount: picks.length, releasedAt };
    this.waveRows.push(wave);
    for (const e of picks) this.releases.set(e.id, { waveNumber: input.waveNumber, releasedAt });
    return { wave, created: true };
  }
}

type WaveRow = {
  id: string;
  wave_number: number;
  size: number;
  released_count: number;
  flag_key: string;
  released_by: string;
  approved_by: string;
  released_at: Date;
};

function toWave(row: WaveRow): WaitlistWave {
  return {
    id: row.id,
    waveNumber: row.wave_number,
    size: row.size,
    releasedCount: row.released_count,
    flagKey: row.flag_key,
    releasedBy: row.released_by,
    approvedBy: row.approved_by,
    releasedAt: row.released_at instanceof Date ? row.released_at : new Date(row.released_at),
  };
}

export class SqlWaitlistStore implements WaitlistStore {
  constructor(private readonly sql: Sql) {}

  async enroll(input: { email: string; referredBy?: string | null }): Promise<WaitlistEnrollResult> {
    const email = normalizeWaitlistEmail(input.email);
    const referredBy = input.referredBy ? normalizeReferralCode(input.referredBy) : null;

    return transaction(this.sql, async (tx) => {
      const settleExisting = async (row: Parameters<typeof toEntry>[0]): Promise<WaitlistEnrollResult> => {
        const entry = toEntry(row);
        const decision = lateReferralDecision(entry, referredBy);
        if (decision.kind === 'return') return { entry, created: false };
        if (decision.kind === 'refuse') throw new WaitlistStoreError(decision.message, decision.code);
        const code = referredBy;
        if (!code) return { entry, created: false };
        const referrer = await tx<Array<{ email: string }>>`
          SELECT email FROM waitlist_entries WHERE referral_code = ${code} LIMIT 1
        `;
        if (!referrer[0]) {
          throw new WaitlistStoreError('Referral code is not on the waitlist', 'waitlist.unknown_referrer');
        }
        if (referrer[0].email.toLowerCase() === email) {
          throw new WaitlistStoreError('Self-referral is refused', 'waitlist.self_referral');
        }
        const updated = await tx<Array<Parameters<typeof toEntry>[0]>>`
          UPDATE waitlist_entries
          SET referred_by = ${code}
          WHERE email = ${email} AND referred_by IS NULL
          RETURNING id, email, referral_code, referred_by, position, referred_count, created_at
        `;
        if (!updated[0]) {
          const again = await tx<Array<Parameters<typeof toEntry>[0]>>`
            SELECT id, email, referral_code, referred_by, position, referred_count, created_at
            FROM waitlist_entries
            WHERE email = ${email}
            LIMIT 1
          `;
          const current = again[0] ? toEntry(again[0]) : entry;
          if (current.referredBy === code) return { entry: current, created: false };
          throw new WaitlistStoreError('This email already has a referral code', 'waitlist.referral_locked');
        }
        await tx`
          UPDATE waitlist_entries
          SET referred_count = referred_count + 1
          WHERE referral_code = ${code}
        `;
        return { entry: toEntry(updated[0]), created: false };
      };

      const existing = await tx<Array<Parameters<typeof toEntry>[0]>>`
        SELECT id, email, referral_code, referred_by, position, referred_count, created_at
        FROM waitlist_entries
        WHERE email = ${email}
        LIMIT 1
      `;
      if (existing[0]) return settleExisting(existing[0]);

      if (referredBy) {
        const referrer = await tx<Array<{ email: string }>>`
          SELECT email FROM waitlist_entries WHERE referral_code = ${referredBy} LIMIT 1
        `;
        if (!referrer[0]) {
          throw new WaitlistStoreError('Referral code is not on the waitlist', 'waitlist.unknown_referrer');
        }
        if (referrer[0].email.toLowerCase() === email) {
          throw new WaitlistStoreError('Self-referral is refused', 'waitlist.self_referral');
        }
      }

      let inserted: Parameters<typeof toEntry>[0] | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newReferralCode();
        try {
          const rows = await tx<Array<Parameters<typeof toEntry>[0]>>`
            INSERT INTO waitlist_entries (email, referral_code, referred_by)
            VALUES (${email}, ${code}, ${referredBy})
            RETURNING id, email, referral_code, referred_by, position, referred_count, created_at
          `;
          inserted = rows[0];
          break;
        } catch (err) {
          if ((err as { code?: string } | null)?.code !== '23505') throw err;
          const raced = await tx<Array<Parameters<typeof toEntry>[0]>>`
            SELECT id, email, referral_code, referred_by, position, referred_count, created_at
            FROM waitlist_entries
            WHERE email = ${email}
            LIMIT 1
          `;
          if (raced[0]) return settleExisting(raced[0]);
          // Unique on referral_code — retry a new code.
        }
      }
      if (!inserted) throw new WaitlistStoreError('Could not allocate a referral code', 'waitlist.invalid');

      if (referredBy) {
        await tx`
          UPDATE waitlist_entries
          SET referred_count = referred_count + 1
          WHERE referral_code = ${referredBy}
        `;
      }

      return { entry: toEntry(inserted), created: true };
    });
  }

  async getByCode(referralCode: string): Promise<WaitlistEntry | null> {
    const code = normalizeReferralCode(referralCode);
    const rows = await this.sql<Array<Parameters<typeof toEntry>[0]>>`
      SELECT id, email, referral_code, referred_by, position, referred_count, created_at
      FROM waitlist_entries
      WHERE referral_code = ${code}
      LIMIT 1
    `;
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async getByEmail(email: string): Promise<WaitlistEntry | null> {
    const normalised = normalizeWaitlistEmail(email);
    const rows = await this.sql<Array<Parameters<typeof toEntry>[0]>>`
      SELECT id, email, referral_code, referred_by, position, referred_count, created_at
      FROM waitlist_entries
      WHERE email = ${normalised}
      LIMIT 1
    `;
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async list(input: { limit: number; offset: number }): Promise<{ total: number; entries: readonly WaitlistEntry[] }> {
    const limit = Math.min(Math.max(input.limit, 1), 200);
    const offset = Math.max(input.offset, 0);
    const totalRows = await this.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM waitlist_entries`;
    const rows = await this.sql<Array<Parameters<typeof toEntry>[0]>>`
      SELECT id, email, referral_code, referred_by, position, referred_count, created_at
      FROM waitlist_entries
      ORDER BY position ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return { total: Number(totalRows[0]?.n ?? 0), entries: rows.map(toEntry) };
  }

  async count(): Promise<number> {
    const rows = await this.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM waitlist_entries`;
    return Number(rows[0]?.n ?? 0);
  }

  async standing(entry: WaitlistEntry): Promise<WaitlistStanding> {
    const rows = await this.sql<Array<{ released_wave: number | null; released_at: Date | null; ahead: number; waiting: number }>>`
      SELECT
        (SELECT w.wave_number FROM waitlist_releases r JOIN waitlist_waves w ON w.id = r.wave_id WHERE r.entry_id = me.id) AS released_wave,
        (SELECT r.released_at FROM waitlist_releases r WHERE r.entry_id = me.id) AS released_at,
        (SELECT count(*)::int FROM waitlist_entries e
          WHERE NOT EXISTS (SELECT 1 FROM waitlist_releases r WHERE r.entry_id = e.id)
            AND (e.referred_count > me.referred_count OR (e.referred_count = me.referred_count AND e.position < me.position))) AS ahead,
        (SELECT count(*)::int FROM waitlist_entries e
          WHERE NOT EXISTS (SELECT 1 FROM waitlist_releases r WHERE r.entry_id = e.id)) AS waiting
      FROM waitlist_entries me
      WHERE me.id = ${entry.id}
    `;
    const row = rows[0];
    if (!row) return { rank: null, waiting: await this.waitingCount(), release: null };
    if (row.released_wave !== null && row.released_at) {
      const releasedAt = row.released_at instanceof Date ? row.released_at : new Date(row.released_at);
      return { rank: null, waiting: row.waiting, release: { waveNumber: row.released_wave, releasedAt } };
    }
    return { rank: row.ahead + 1, waiting: row.waiting, release: null };
  }

  async waitingCount(): Promise<number> {
    const rows = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM waitlist_entries e
      WHERE NOT EXISTS (SELECT 1 FROM waitlist_releases r WHERE r.entry_id = e.id)
    `;
    return rows[0]?.n ?? 0;
  }

  async waves(): Promise<readonly WaitlistWave[]> {
    const rows = await this.sql<WaveRow[]>`
      SELECT id, wave_number, size, released_count, flag_key, released_by, approved_by, released_at
      FROM waitlist_waves
      ORDER BY wave_number ASC
    `;
    return rows.map(toWave);
  }

  async releaseWave(input: WaveReleaseInput): Promise<{ wave: WaitlistWave; created: boolean }> {
    return transaction(
      this.sql,
      async (tx) => {
        // One release at a time, so two operators pressing at once cannot both pick the same top N. Read committed, so
        // the second one, once it holds the lock, sees the wave the first one wrote and returns it.
        await tx`SELECT pg_advisory_xact_lock(hashtext('identity.waitlist_waves'))`;
        const existing = await tx<WaveRow[]>`
        SELECT id, wave_number, size, released_count, flag_key, released_by, approved_by, released_at
        FROM waitlist_waves WHERE wave_number = ${input.waveNumber}
      `;
        if (existing[0]) return { wave: toWave(existing[0]), created: false };
        const last = await tx<Array<{ n: number }>>`SELECT coalesce(max(wave_number), 0)::int AS n FROM waitlist_waves`;
        const next = (last[0]?.n ?? 0) + 1;
        if (input.waveNumber !== next) throw new WaitlistStoreError(`The next wave is ${next}`, 'waitlist.wave_unknown');
        // Rows locked so a referral landing now cannot reorder the pick under us.
        const picks = await tx<Array<{ id: string }>>`
        SELECT e.id FROM waitlist_entries e
        WHERE NOT EXISTS (SELECT 1 FROM waitlist_releases r WHERE r.entry_id = e.id)
        ORDER BY e.referred_count DESC, e.position ASC
        LIMIT ${input.size}
        FOR UPDATE OF e
      `;
        if (picks.length === 0) throw new WaitlistStoreError('Nobody is waiting to be released', 'waitlist.wave_empty');
        const waves = await tx<WaveRow[]>`
        INSERT INTO waitlist_waves (wave_number, size, released_count, flag_key, released_by, approved_by)
        VALUES (${input.waveNumber}, ${input.size}, ${picks.length}, ${input.flagKey}, ${input.releasedBy}, ${input.approvedBy})
        RETURNING id, wave_number, size, released_count, flag_key, released_by, approved_by, released_at
      `;
        const wave = toWave(waves[0]!);
        const rows = picks.map((p) => ({
          entry_id: p.id,
          wave_id: wave.id,
          release_key: releaseKey(wave.waveNumber, p.id),
          released_at: wave.releasedAt,
        }));
        await tx`INSERT INTO waitlist_releases ${tx(rows, 'entry_id', 'wave_id', 'release_key', 'released_at')}`;
        return { wave, created: true };
      },
      { isolation: 'read committed' },
    );
  }
}
