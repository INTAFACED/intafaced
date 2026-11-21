/**
 * Response targets (SP-sla-01): the desk's first-reply target and the clock each new request starts under it.
 *
 * The target is the desk's own setting, made by a lead with a reason from the revision they read. Nothing is seeded: the
 * target reads `null` and the policy is off until a lead saves one and turns it on, and turning it on with no target is
 * refused `support.sla_targets_unset`. While the policy is on, each new request starts one first-reply clock, keyed by
 * its ticket, whose due time is the request's creation time plus the stored target; a replay starts none. The queue shows
 * a request's due time only while the policy is on, so turning it off takes every due time off the queue again.
 *
 * Until a response target is active the queue's score is all there is, and it is not a promise (`sla-honesty.ts`).
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';

export const SLA_TARGETS_UNSET = 'support.sla_targets_unset' as const;
export const SLA_POLICY_STALE = 'support.sla_policy_revision_stale' as const;

export interface ResponseTargetPolicy {
  /** Minutes from a request's creation to its first public reply. Null: not set. */
  readonly firstReplyMinutes: number | null;
  readonly active: boolean;
  readonly revision: number;
  readonly updatedAt: string | null;
}

export interface ResponseTargetChange {
  /** A field left out is unchanged; null clears the target. */
  readonly firstReplyMinutes?: number | null;
  readonly active?: boolean;
  readonly expectedRevision: number;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

/** One request's first-reply clock. */
export interface ResponseClock {
  readonly ticketId: string;
  readonly targetMinutes: number;
  readonly startedAt: string;
  readonly dueAt: string;
  readonly policyRevision: number;
}

/** What the queue shows of a request's response target. */
export interface ResponseDue {
  readonly dueAt: string;
  readonly targetMinutes: number;
}

export class ResponseTargetError extends Error {
  constructor(readonly code: typeof SLA_TARGETS_UNSET | typeof SLA_POLICY_STALE) {
    super(code);
    this.name = 'ResponseTargetError';
  }
}

export interface ResponseTargetBook {
  policy(): Promise<ResponseTargetPolicy>;
  /** Writes and logs one row only when something changed. Refuses a stale revision and an active policy with no target. */
  save(change: ResponseTargetChange): Promise<ResponseTargetPolicy>;
  /** Starts the ticket's first-reply clock under the policy given; a second start for the same ticket keeps the first. */
  startClock(ticketId: string, createdAt: string, policy: ResponseTargetPolicy): Promise<void>;
  clocks(ticketIds: readonly string[]): Promise<ReadonlyMap<string, ResponseClock>>;
}

const blank = (): ResponseTargetPolicy => ({ firstReplyMinutes: null, active: false, revision: 0, updatedAt: null });

/** The policy a change leaves, or the refusal it meets. Pure: both books apply it under their own lock. */
function applyResponseTargetChange(prior: ResponseTargetPolicy, change: ResponseTargetChange): ResponseTargetPolicy | null {
  const firstReplyMinutes = change.firstReplyMinutes === undefined ? prior.firstReplyMinutes : change.firstReplyMinutes;
  const active = change.active === undefined ? prior.active : change.active;
  if (active && firstReplyMinutes === null) throw new ResponseTargetError(SLA_TARGETS_UNSET);
  if (firstReplyMinutes === prior.firstReplyMinutes && active === prior.active) return null;
  return { firstReplyMinutes, active, revision: prior.revision + 1, updatedAt: change.at };
}

/** The business key of the change made from `revision`. */
const responseTargetKey = (revision: number): string => `support.sla_policy:r${revision}`;

/** What identifies one change: the fields it sets and the reason. The actor and the time are not part of it. */
function responseTargetFingerprint(change: ResponseTargetChange): string {
  return createHash('sha256')
    .update(JSON.stringify([change.firstReplyMinutes ?? 'unchanged', change.active ?? 'unchanged', change.reason]))
    .digest('hex');
}

/** The clock a request created at `createdAt` starts under an active policy, or null when none starts. */
function clockFor(ticketId: string, createdAt: string, policy: ResponseTargetPolicy): ResponseClock | null {
  if (!policy.active || policy.firstReplyMinutes === null) return null;
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return null;
  return {
    ticketId,
    targetMinutes: policy.firstReplyMinutes,
    startedAt: new Date(started).toISOString(),
    dueAt: new Date(started + policy.firstReplyMinutes * 60_000).toISOString(),
    policyRevision: policy.revision,
  };
}

export class MemoryResponseTargetBook implements ResponseTargetBook {
  private state: ResponseTargetPolicy = blank();
  private readonly byKey = new Map<string, string>();
  private readonly clockRows = new Map<string, ResponseClock>();
  readonly log: { key: string; before: ResponseTargetPolicy; after: ResponseTargetPolicy; by: string; reason: string }[] = [];

  async policy(): Promise<ResponseTargetPolicy> {
    return this.state;
  }

  async save(change: ResponseTargetChange): Promise<ResponseTargetPolicy> {
    const key = responseTargetKey(change.expectedRevision);
    const fingerprint = responseTargetFingerprint(change);
    if (change.expectedRevision !== this.state.revision) {
      if (this.byKey.get(key) === fingerprint) return this.state;
      throw new ResponseTargetError(SLA_POLICY_STALE);
    }
    const after = applyResponseTargetChange(this.state, change);
    if (after === null) return this.state;
    this.log.push({ key, before: this.state, after, by: change.by, reason: change.reason });
    this.byKey.set(key, fingerprint);
    this.state = after;
    return after;
  }

  async startClock(ticketId: string, createdAt: string, policy: ResponseTargetPolicy): Promise<void> {
    const clock = clockFor(ticketId, createdAt, policy);
    if (clock && !this.clockRows.has(ticketId)) this.clockRows.set(ticketId, clock);
  }

  async clocks(ticketIds: readonly string[]): Promise<ReadonlyMap<string, ResponseClock>> {
    const found = new Map<string, ResponseClock>();
    for (const id of ticketIds) {
      const clock = this.clockRows.get(id);
      if (clock) found.set(id, clock);
    }
    return found;
  }
}

const when = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());
const PolicyRow = z.object({
  first_reply_minutes: z.number().int().nullable(),
  active: z.boolean(),
  revision: z.number().int(),
  updated_at: when.nullable(),
});
const ClockRow = z.object({
  ticket_id: z.string(),
  target_minutes: z.number().int(),
  started_at: when,
  due_at: when,
  policy_revision: z.number().int(),
});
const FingerprintRow = z.object({ fingerprint: z.string() });

const policyOf = (raw: unknown): ResponseTargetPolicy => {
  if (raw === undefined) return blank();
  const row = PolicyRow.parse(raw);
  return { firstReplyMinutes: row.first_reply_minutes, active: row.active, revision: row.revision, updatedAt: row.updated_at };
};

export class SqlResponseTargetBook implements ResponseTargetBook {
  constructor(private readonly sql: Sql) {}

  async policy(): Promise<ResponseTargetPolicy> {
    const rows = await this.sql`SELECT first_reply_minutes, active, revision, updated_at FROM support.sla_policy`;
    return policyOf(rows[0]);
  }

  async save(change: ResponseTargetChange): Promise<ResponseTargetPolicy> {
    const key = responseTargetKey(change.expectedRevision);
    const fingerprint = responseTargetFingerprint(change);
    return this.sql.begin(async (tx) => {
      // The single row is the lock: every writer serialises on it.
      await tx`INSERT INTO support.sla_policy (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`;
      const [locked] = await tx`
        SELECT first_reply_minutes, active, revision, updated_at FROM support.sla_policy WHERE singleton FOR UPDATE
      `;
      const prior = policyOf(locked);
      if (change.expectedRevision !== prior.revision) {
        const [logged] = await tx`SELECT fingerprint FROM support.sla_policy_log WHERE key = ${key}`;
        if (logged !== undefined && FingerprintRow.parse(logged).fingerprint === fingerprint) return prior;
        throw new ResponseTargetError(SLA_POLICY_STALE);
      }
      const after = applyResponseTargetChange(prior, change);
      if (after === null) return prior;
      await tx`
        UPDATE support.sla_policy
        SET first_reply_minutes = ${after.firstReplyMinutes}, active = ${after.active}, revision = ${after.revision},
            updated_by = ${change.by}, updated_at = ${change.at}
        WHERE singleton
      `;
      await tx`
        INSERT INTO support.sla_policy_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (${key}, ${fingerprint}, ${after.revision}, ${JSON.stringify(prior)}::jsonb, ${JSON.stringify(after)}::jsonb, ${change.by},
                ${change.reason}, ${change.at})
      `;
      return after;
    });
  }

  async startClock(ticketId: string, createdAt: string, policy: ResponseTargetPolicy): Promise<void> {
    const clock = clockFor(ticketId, createdAt, policy);
    if (!clock) return;
    await this.sql`
      INSERT INTO support.sla_clocks (ticket_id, metric, target_minutes, started_at, due_at, policy_revision)
      VALUES (${clock.ticketId}, 'first_reply', ${clock.targetMinutes}, ${clock.startedAt}, ${clock.dueAt}, ${clock.policyRevision})
      ON CONFLICT (ticket_id, metric) DO NOTHING
    `;
  }

  async clocks(ticketIds: readonly string[]): Promise<ReadonlyMap<string, ResponseClock>> {
    if (ticketIds.length === 0) return new Map();
    const rows = ClockRow.array().parse(
      await this.sql`
        SELECT ticket_id, target_minutes, started_at, due_at, policy_revision FROM support.sla_clocks
        WHERE metric = 'first_reply' AND ticket_id = ANY(${[...ticketIds]}::uuid[])
      `,
    );
    return new Map(
      rows.map((row) => [
        row.ticket_id,
        {
          ticketId: row.ticket_id,
          targetMinutes: row.target_minutes,
          startedAt: row.started_at,
          dueAt: row.due_at,
          policyRevision: row.policy_revision,
        },
      ]),
    );
  }
}
