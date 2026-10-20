import type { Sql } from 'postgres';
import type { OutOfAppChannel } from './channels/channel.js';
import type { ChannelTarget } from './channel-store.js';

/**
 * Recipient health: which addresses keep failing, and the quarantine that follows.
 *
 * A TERMINAL failure is the unit: a send that ended `abandoned` (the gateway
 * rejected it for good, or the attempt budget was spent). A `failed` attempt that
 * will be retried is not counted, so a short provider outage retried on the bus
 * does not quarantine anybody. Consecutive terminal failures to one address,
 * reaching the OWNER-SET threshold, quarantine it. A blank threshold quarantines
 * nobody: the page says so and the dispatcher never consults the table.
 *
 * What quarantine does: a non-critical send to the address is refused
 * `channel.recipient_quarantined` with the stored reason, and a release (reason
 * required, audited, keyed by a request id) lets sends resume. Critical messages
 * are still attempted: the one state where a margin call is not tried must not be
 * a bookkeeping state. If a provider outage abandons many sends at once, many
 * recipients can be quarantined; the release action and the threshold are the
 * owner's lever for that.
 *
 * No money moves. This holds no balance.
 */

export type RecipientState = 'active' | 'unconfirmed' | 'quarantined';
export const RECIPIENT_STATES: readonly RecipientState[] = ['active', 'unconfirmed', 'quarantined'];

export const QUARANTINE_THRESHOLD_UNSET = 'notify.quarantine_threshold_unset' as const;
export const RECIPIENT_UNKNOWN = 'notify.recipient_unknown' as const;
export const RECIPIENT_NOT_QUARANTINED = 'notify.recipient_not_quarantined' as const;
export const RELEASE_REASON_REQUIRED = 'notify.release_reason_required' as const;

export class RecipientHealthError extends Error {
  constructor(
    readonly code: typeof RECIPIENT_UNKNOWN | typeof RECIPIENT_NOT_QUARANTINED | typeof RELEASE_REASON_REQUIRED,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RecipientHealthError';
  }
}

export interface Quarantine {
  readonly reason: string;
  readonly since: Date;
}

export interface RecipientRow {
  readonly userId: string;
  readonly channel: OutOfAppChannel;
  /** Always masked: an operator list never carries a full address. */
  readonly address: string;
  readonly state: RecipientState;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: Date | null;
  readonly lastFailureCode: string | null;
  readonly quarantinedAt: Date | null;
  readonly quarantineReason: string | null;
}

export type ReleaseResult = { readonly released: true; readonly replayed: boolean };

export interface RecipientHealthStore {
  /** The quarantine on this exact address, or null. A different address is not quarantined. */
  quarantineOf(userId: string, channel: OutOfAppChannel, address: string): Promise<Quarantine | null>;
  /**
   * One terminal outcome. Success resets the count. A failure adds one and, when
   * `threshold` is set and reached, quarantines. A null threshold never quarantines.
   */
  record(input: {
    userId: string;
    channel: OutOfAppChannel;
    address: string;
    ok: boolean;
    code?: string;
    threshold: number | null;
    now: Date;
  }): Promise<{ quarantined: boolean }>;
  list(state: RecipientState, limit: number): Promise<readonly RecipientRow[]>;
  /** Idempotent on (userId, channel, reasonId). */
  release(input: {
    userId: string;
    channel: OutOfAppChannel;
    actorId: string;
    reason: string;
    reasonId: string;
    now: Date;
  }): Promise<ReleaseResult>;
}

/** `a***@example.com`, `+44*****0000`: enough to recognise, not enough to use. */
export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at > 0) return `${address.slice(0, 1)}***${address.slice(at)}`;
  if (address.length <= 6) return '***';
  return `${address.slice(0, 3)}***${address.slice(-4)}`;
}

export function assertReleaseReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw new RecipientHealthError(RELEASE_REASON_REQUIRED);
  return trimmed;
}

type HealthRow = {
  address: string;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  quarantinedAt: Date | null;
  quarantineReason: string | null;
};

type AuditRow = { userId: string; channel: OutOfAppChannel; reasonId: string };

const k = (userId: string, channel: string): string => `${userId}\0${channel}`;

/** Memory engine. `targets` lists every registered address so the operator list can show them. */
export class MemoryRecipientHealthStore implements RecipientHealthStore {
  private readonly rows = new Map<string, HealthRow>();
  private readonly audit: AuditRow[] = [];

  constructor(private readonly targets: () => readonly ChannelTarget[]) {}

  async quarantineOf(userId: string, channel: OutOfAppChannel, address: string): Promise<Quarantine | null> {
    const row = this.rows.get(k(userId, channel));
    if (!row || row.address !== address || !row.quarantinedAt || !row.quarantineReason) return null;
    return { reason: row.quarantineReason, since: row.quarantinedAt };
  }

  async record(input: Parameters<RecipientHealthStore['record']>[0]): Promise<{ quarantined: boolean }> {
    const key = k(input.userId, input.channel);
    let row = this.rows.get(key);
    // A success with nothing recorded changes nothing: no row is created for a healthy recipient.
    if (input.ok && (!row || row.address !== input.address)) return { quarantined: false };
    if (!row || row.address !== input.address) {
      row = {
        address: input.address,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureCode: null,
        quarantinedAt: null,
        quarantineReason: null,
      };
      this.rows.set(key, row);
    }
    if (input.ok) {
      row.consecutiveFailures = 0;
      return { quarantined: row.quarantinedAt !== null };
    }
    row.consecutiveFailures += 1;
    row.lastFailureAt = input.now;
    row.lastFailureCode = input.code ?? null;
    if (input.threshold !== null && row.quarantinedAt === null && row.consecutiveFailures >= input.threshold) {
      row.quarantinedAt = input.now;
      row.quarantineReason = `consecutive_failures:${row.consecutiveFailures}:${input.code ?? 'unknown'}`;
    }
    return { quarantined: row.quarantinedAt !== null };
  }

  async list(state: RecipientState, limit: number): Promise<readonly RecipientRow[]> {
    const out: RecipientRow[] = [];
    for (const t of this.targets()) {
      if (t.channel === 'inapp') continue;
      const h = this.rows.get(k(t.userId, t.channel));
      const quarantined = !!h && h.address === t.address && h.quarantinedAt !== null;
      const rowState: RecipientState = quarantined ? 'quarantined' : t.verifiedAt ? 'active' : 'unconfirmed';
      if (rowState !== state) continue;
      const own = h && h.address === t.address ? h : null;
      out.push({
        userId: t.userId,
        channel: t.channel,
        address: maskAddress(t.address),
        state: rowState,
        consecutiveFailures: own?.consecutiveFailures ?? 0,
        lastFailureAt: own?.lastFailureAt ?? null,
        lastFailureCode: own?.lastFailureCode ?? null,
        quarantinedAt: own?.quarantinedAt ?? null,
        quarantineReason: own?.quarantineReason ?? null,
      });
    }
    out.sort((a, b) => (b.quarantinedAt?.getTime() ?? 0) - (a.quarantinedAt?.getTime() ?? 0) || (a.userId < b.userId ? -1 : 1));
    return out.slice(0, limit);
  }

  async release(input: Parameters<RecipientHealthStore['release']>[0]): Promise<ReleaseResult> {
    if (this.audit.some((a) => a.userId === input.userId && a.channel === input.channel && a.reasonId === input.reasonId)) {
      return { released: true, replayed: true };
    }
    const row = this.rows.get(k(input.userId, input.channel));
    if (!row) throw new RecipientHealthError(RECIPIENT_UNKNOWN);
    if (!row.quarantinedAt) throw new RecipientHealthError(RECIPIENT_NOT_QUARANTINED);
    this.audit.push({ userId: input.userId, channel: input.channel, reasonId: input.reasonId });
    row.quarantinedAt = null;
    row.quarantineReason = null;
    row.consecutiveFailures = 0;
    return { released: true, replayed: false };
  }
}

type PgHealth = {
  user_id: string;
  channel: OutOfAppChannel;
  address: string;
  verified_at: Date | null;
  consecutive_failures: number | null;
  last_failure_at: Date | null;
  last_failure_code: string | null;
  quarantined_at: Date | null;
  quarantine_reason: string | null;
  health_address: string | null;
};

export class PostgresRecipientHealthStore implements RecipientHealthStore {
  constructor(private readonly sql: Sql) {}

  async quarantineOf(userId: string, channel: OutOfAppChannel, address: string): Promise<Quarantine | null> {
    const rows = await this.sql<Array<{ quarantined_at: Date; quarantine_reason: string }>>`
      SELECT quarantined_at, quarantine_reason FROM notify.recipient_health
       WHERE user_id = ${userId} AND channel = ${channel} AND address = ${address} AND quarantined_at IS NOT NULL
    `;
    return rows[0] ? { reason: rows[0].quarantine_reason, since: rows[0].quarantined_at } : null;
  }

  async record(input: Parameters<RecipientHealthStore['record']>[0]): Promise<{ quarantined: boolean }> {
    const code = input.code ?? null;
    if (input.ok) {
      // A success with nothing recorded changes nothing: no row is created for a healthy recipient.
      const ok = await this.sql<Array<{ quarantined_at: Date | null }>>`
        UPDATE notify.recipient_health SET consecutive_failures = 0, updated_at = now()
         WHERE user_id = ${input.userId} AND channel = ${input.channel} AND address = ${input.address} AND consecutive_failures > 0
        RETURNING quarantined_at
      `;
      return { quarantined: ok[0]?.quarantined_at != null };
    }
    return this.sql.begin(async (tx) => {
      // The row is created or reset (new address) first, then changed under its own lock.
      await tx`
        INSERT INTO notify.recipient_health (user_id, channel, address)
        VALUES (${input.userId}, ${input.channel}, ${input.address})
        ON CONFLICT (user_id, channel) DO UPDATE
          SET address = EXCLUDED.address, consecutive_failures = 0, last_failure_at = NULL, last_failure_code = NULL,
              quarantined_at = NULL, quarantine_reason = NULL, updated_at = now()
          WHERE notify.recipient_health.address <> EXCLUDED.address
      `;
      const rows = await tx<Array<{ quarantined_at: Date | null }>>`
        UPDATE notify.recipient_health
           SET consecutive_failures = consecutive_failures + 1,
               last_failure_at = ${input.now},
               last_failure_code = ${code},
               quarantined_at = CASE
                 WHEN quarantined_at IS NULL AND ${input.threshold}::int IS NOT NULL AND consecutive_failures + 1 >= ${input.threshold}::int
                 THEN ${input.now} ELSE quarantined_at END,
               quarantine_reason = CASE
                 WHEN quarantined_at IS NULL AND ${input.threshold}::int IS NOT NULL AND consecutive_failures + 1 >= ${input.threshold}::int
                 THEN 'consecutive_failures:' || (consecutive_failures + 1)::text || ':' || ${code ?? 'unknown'}::text ELSE quarantine_reason END,
               updated_at = now()
         WHERE user_id = ${input.userId} AND channel = ${input.channel}
        RETURNING quarantined_at
      `;
      return { quarantined: rows[0]?.quarantined_at != null };
    });
  }

  async list(state: RecipientState, limit: number): Promise<readonly RecipientRow[]> {
    const cond =
      state === 'quarantined'
        ? this.sql`h.quarantined_at IS NOT NULL`
        : state === 'active'
          ? this.sql`h.quarantined_at IS NULL AND t.verified_at IS NOT NULL`
          : this.sql`h.quarantined_at IS NULL AND t.verified_at IS NULL`;
    const rows = await this.sql<PgHealth[]>`
      SELECT t.user_id, t.channel, t.address, t.verified_at, h.consecutive_failures, h.last_failure_at, h.last_failure_code,
             h.quarantined_at, h.quarantine_reason, h.address AS health_address
        FROM notify.channel_targets t
        LEFT JOIN notify.recipient_health h
          ON h.user_id = t.user_id AND h.channel = t.channel AND h.address = t.address
       WHERE ${cond}
       ORDER BY h.quarantined_at DESC NULLS LAST, t.user_id ASC, t.channel ASC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      channel: r.channel,
      address: maskAddress(r.address),
      state: r.quarantined_at ? 'quarantined' : r.verified_at ? 'active' : 'unconfirmed',
      consecutiveFailures: r.consecutive_failures ?? 0,
      lastFailureAt: r.last_failure_at,
      lastFailureCode: r.last_failure_code,
      quarantinedAt: r.quarantined_at,
      quarantineReason: r.quarantine_reason,
    }));
  }

  async release(input: Parameters<RecipientHealthStore['release']>[0]): Promise<ReleaseResult> {
    return this.sql.begin(async (tx) => {
      const prior = await tx<Array<{ id: string }>>`
        SELECT id FROM notify.recipient_release_audit
         WHERE user_id = ${input.userId} AND channel = ${input.channel} AND reason_id = ${input.reasonId}
      `;
      if (prior.length > 0) return { released: true as const, replayed: true };
      const row = await tx<Array<{ quarantined_at: Date | null; quarantine_reason: string | null }>>`
        SELECT quarantined_at, quarantine_reason FROM notify.recipient_health
         WHERE user_id = ${input.userId} AND channel = ${input.channel}
         FOR UPDATE
      `;
      if (row.length === 0) throw new RecipientHealthError(RECIPIENT_UNKNOWN);
      if (!row[0]!.quarantined_at || !row[0]!.quarantine_reason) throw new RecipientHealthError(RECIPIENT_NOT_QUARANTINED);
      await tx`
        INSERT INTO notify.recipient_release_audit (user_id, channel, actor_id, reason, reason_id, quarantine_reason, released_at)
        VALUES (${input.userId}, ${input.channel}, ${input.actorId}, ${input.reason}, ${input.reasonId}, ${row[0]!.quarantine_reason}, ${input.now})
      `;
      await tx`
        UPDATE notify.recipient_health
           SET quarantined_at = NULL, quarantine_reason = NULL, consecutive_failures = 0, updated_at = now()
         WHERE user_id = ${input.userId} AND channel = ${input.channel}
      `;
      return { released: true as const, replayed: false };
    });
  }
}
