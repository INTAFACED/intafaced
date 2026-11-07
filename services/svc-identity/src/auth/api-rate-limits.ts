/**
 * API rate limits for keys, identity's half (DV-limits-01 to 03, J-developer-06).
 *
 * Identity owns the tiers (the owner value `IDENTITY_API_RATE_LIMITS`), each key's granted refill, the requests for a
 * higher limit and the one audit entry per decision. The key exchange hands the edge the key's limit
 * (`installApiKeyRateExchange`); the edge keeps the bucket and the per-route costs. Blank tiers mean no limit applies,
 * so the edge refuses every key call and every request here refuses `identity.rate_limits_unset`: nothing defaults.
 */
import type { Sql } from 'postgres';
import {
  RATE_PER_MINUTE_MAX,
  grantStatus,
  rateTierSchema,
  type KeyRateLimit,
  type LimitAuditEntry,
  type LimitDeskOutput,
  type LimitRequest,
  type LimitRequestCreateInput,
  type LimitRequestListOutput,
  type LimitRequestQueueRow,
  type LimitReviewInput,
  type RateTier,
  type RateTiersOutput,
} from '@intafaced/contracts/api-rate-limits';
import { z } from 'zod';
import type { AuthService } from './auth-service.js';
import { hashToken } from './passwords.js';

export type RateLimitCode =
  | 'identity.rate_limits_unset'
  | 'identity.key_not_found'
  | 'identity.key_not_live'
  | 'identity.limit_not_higher'
  | 'identity.limit_spike_invalid'
  | 'identity.limit_request_open'
  | 'identity.limit_request_not_found'
  | 'identity.limit_request_decided'
  | 'identity.limit_grant_invalid'
  | 'identity.limit_review_own'
  | 'identity.rate_grant_ceiling_unset'
  | 'identity.rate_grant_above_ceiling';

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly code: RateLimitCode,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** The owner's rate policy: the tiers that are set, and the most one key may be granted (null: not set). */
export interface RatePolicy {
  readonly tiers: readonly RateTier[];
  readonly grantCeilingPerMinute: number | null;
}

const policySchema = z
  .object({
    tiers: z.array(rateTierSchema).min(1),
    grantCeilingPerMinute: z.number().int().positive().max(RATE_PER_MINUTE_MAX).nullable().optional(),
  })
  .strict();

/**
 * `IDENTITY_API_RATE_LIMITS`: JSON `{"tiers":[{"id":"base","burst":60,"refillPerMinute":600}, …],
 * "grantCeilingPerMinute":6000}`. Blank: null (no tier set). A value that does not parse, names a tier twice, or puts
 * the sandbox tier above the base tier stops the service at boot rather than limiting with a guess.
 */
export function parseRatePolicy(raw: string | undefined): RatePolicy | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  let parsed: z.infer<typeof policySchema>;
  try {
    parsed = policySchema.parse(JSON.parse(text));
  } catch {
    throw new Error(
      'IDENTITY_API_RATE_LIMITS must be JSON {"tiers":[{"id":"base"|"sandbox","burst":n,"refillPerMinute":n}],"grantCeilingPerMinute":n|null}',
    );
  }
  const ids = parsed.tiers.map((tier) => tier.id);
  if (new Set(ids).size !== ids.length) throw new Error('IDENTITY_API_RATE_LIMITS names a tier twice');
  const base = parsed.tiers.find((tier) => tier.id === 'base');
  const sandbox = parsed.tiers.find((tier) => tier.id === 'sandbox');
  if (base && sandbox && (sandbox.burst > base.burst || sandbox.refillPerMinute > base.refillPerMinute)) {
    throw new Error('IDENTITY_API_RATE_LIMITS puts the sandbox tier above the base tier');
  }
  const ceiling = parsed.grantCeilingPerMinute ?? null;
  if (ceiling !== null && base && ceiling <= base.refillPerMinute) {
    throw new Error('IDENTITY_API_RATE_LIMITS grantCeilingPerMinute must be above the base tier refill');
  }
  return { tiers: parsed.tiers, grantCeilingPerMinute: ceiling };
}

/** The published tiers (an empty list while the owner has set none). */
export function publishedTiers(policy: RatePolicy | null, now: Date = new Date()): RateTiersOutput {
  return {
    asOf: now.toISOString(),
    tiers: policy ? [...policy.tiers] : [],
    grantCeilingPerMinute: policy?.grantCeilingPerMinute ?? null,
  };
}

/**
 * One key's limit: its tier by environment (live keys on `base`, sandbox keys on `sandbox`), with a granted refill on a
 * live key in place of the tier's. Null when the owner set no tier for it: the edge then refuses the call.
 */
export function keyRateLimit(
  policy: RatePolicy | null,
  key: { mode: string; rate_refill_per_minute_granted: number | null },
): KeyRateLimit | null {
  if (!policy) return null;
  const tierId = key.mode === 'sandbox' ? 'sandbox' : 'base';
  const tier = policy.tiers.find((candidate) => candidate.id === tierId);
  if (!tier) return null;
  const granted = key.rate_refill_per_minute_granted;
  if (tierId === 'base' && granted !== null && granted > tier.refillPerMinute) {
    return { tier: 'granted', burst: tier.burst, refillPerMinute: granted };
  }
  return { tier: tier.id, burst: tier.burst, refillPerMinute: tier.refillPerMinute };
}

/** Every exchange answer carries the key's limit (null: none set), read from the same live row the exchange opened. */
export function installApiKeyRateExchange(auth: AuthService, sql: Sql, policy: RatePolicy | null): void {
  const orig = auth.exchangeApiKey.bind(auth);
  auth.exchangeApiKey = async (key: string, requestOrigin?: string | null) => {
    const issued = await orig(key, requestOrigin);
    const rows = await sql<Array<{ mode: string; rate_refill_per_minute_granted: number | null }>>`
      SELECT mode, rate_refill_per_minute_granted FROM api_keys WHERE id = ${issued.keyId} AND key_hash = ${hashToken(key)}
    `;
    const row = rows[0];
    return { ...issued, rateLimit: row ? keyRateLimit(policy, row) : null };
  };
}

interface KeyRow {
  id: string;
  name: string;
  mode: string;
  revoked: boolean;
  expires_at: Date | null;
  rate_refill_per_minute_granted: number | null;
}

interface RequestRow {
  id: string;
  user_id: string;
  key_id: string;
  key_name: string;
  key_prefix: string;
  asked_per_minute: number;
  current_per_minute: number;
  spike_starts_on: string | null;
  spike_ends_on: string | null;
  note: string;
  status: LimitRequest['status'];
  granted_per_minute: number | null;
  created_at: Date;
  reviewed_at: Date | null;
}

const live = (key: { revoked: boolean; expires_at: Date | null }, now: Date) => !key.revoked && (key.expires_at === null || key.expires_at.getTime() > now.getTime());

function toRequest(row: RequestRow): LimitRequest {
  return {
    id: row.id,
    keyId: row.key_id,
    keyName: row.key_name,
    askedPerMinute: row.asked_per_minute,
    currentPerMinute: row.current_per_minute,
    spikeStartsOn: row.spike_starts_on,
    spikeEndsOn: row.spike_ends_on,
    note: row.note,
    status: row.status,
    grantedPerMinute: row.granted_per_minute,
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
  };
}

const REQUEST_COLUMNS = (sql: Sql) => sql`
  r.id, r.user_id, r.key_id, k.name AS key_name, k.key_prefix, r.asked_per_minute, r.current_per_minute,
  to_char(r.spike_starts_on, 'YYYY-MM-DD') AS spike_starts_on, to_char(r.spike_ends_on, 'YYYY-MM-DD') AS spike_ends_on,
  r.note, r.status, r.granted_per_minute, r.created_at, r.reviewed_at
`;

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Both spike dates or neither, real calendar days, the first on or before the last, the last not before today (UTC). */
function checkSpike(starts: string | null, ends: string | null, now: Date): void {
  if (starts === null && ends === null) return;
  const real = (day: string | null) => day !== null && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;
  if (!real(starts) || !real(ends) || starts! > ends! || ends! < utcDay(now)) {
    throw new RateLimitError('Give both spike dates, the first on or before the last, and the last not in the past', 'identity.limit_spike_invalid');
  }
}

/**
 * A request for a higher refill on one of the caller's live keys. Refused while the tiers are blank, for a key that is
 * not the caller's or not live, for an ask not above what the key has, and while another request on the key waits. A
 * repeat of the same request id returns the first record.
 */
export async function createLimitRequest(
  sql: Sql,
  policy: RatePolicy | null,
  userId: string,
  input: LimitRequestCreateInput,
  now: Date = new Date(),
): Promise<LimitRequest> {
  if (!policy) throw new RateLimitError('API rate limits are not set', 'identity.rate_limits_unset');
  const repeat = await sql<RequestRow[]>`
    SELECT ${REQUEST_COLUMNS(sql)} FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id
    WHERE r.user_id = ${userId} AND r.request_id = ${input.requestId}
  `;
  if (repeat[0]) return toRequest(repeat[0]);
  const keys = await sql<KeyRow[]>`
    SELECT id, name, mode, revoked, expires_at, rate_refill_per_minute_granted FROM api_keys
    WHERE id = ${input.keyId} AND user_id = ${userId}
  `;
  const key = keys[0];
  if (!key) throw new RateLimitError('API key not found', 'identity.key_not_found');
  if (!live(key, now)) throw new RateLimitError('This key is not live', 'identity.key_not_live');
  const limit = keyRateLimit(policy, key);
  if (!limit) throw new RateLimitError('No rate limit is set for this key', 'identity.rate_limits_unset');
  if (input.askedPerMinute <= limit.refillPerMinute) {
    throw new RateLimitError('Ask for more than the key has now', 'identity.limit_not_higher');
  }
  checkSpike(input.spikeStartsOn, input.spikeEndsOn, now);
  try {
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO api_limit_requests (user_id, key_id, request_id, asked_per_minute, current_per_minute, spike_starts_on, spike_ends_on, note)
      VALUES (${userId}, ${key.id}, ${input.requestId}, ${input.askedPerMinute}, ${limit.refillPerMinute},
              ${input.spikeStartsOn}, ${input.spikeEndsOn}, ${input.note.trim()})
      RETURNING id
    `;
    const rows = await sql<RequestRow[]>`
      SELECT ${REQUEST_COLUMNS(sql)} FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id WHERE r.id = ${inserted[0]!.id}
    `;
    return toRequest(rows[0]!);
  } catch (err) {
    const constraint = (err as { constraint_name?: string }).constraint_name;
    if (constraint === 'api_limit_requests_waiting_uq') {
      throw new RateLimitError('This key already has a request waiting for review', 'identity.limit_request_open');
    }
    if (constraint === 'api_limit_requests_request_uq') {
      const again = await sql<RequestRow[]>`
        SELECT ${REQUEST_COLUMNS(sql)} FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id
        WHERE r.user_id = ${userId} AND r.request_id = ${input.requestId}
      `;
      if (again[0]) return toRequest(again[0]);
    }
    throw err;
  }
}

/** The caller's own requests, newest first. */
export async function listMyLimitRequests(sql: Sql, userId: string, now: Date = new Date()): Promise<LimitRequestListOutput> {
  const rows = await sql<RequestRow[]>`
    SELECT ${REQUEST_COLUMNS(sql)} FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id
    WHERE r.user_id = ${userId} ORDER BY r.created_at DESC LIMIT 50
  `;
  return { asOf: now.toISOString(), requests: rows.map(toRequest) };
}

interface AuditRow {
  id: string;
  request_id: string;
  key_id: string;
  key_name: string | null;
  actor_id: string;
  decision: LimitAuditEntry['decision'];
  asked_per_minute: number;
  previous_per_minute: number;
  granted_per_minute: number | null;
  reason: string;
  created_at: Date;
}

/** The support desk: waiting requests first (oldest first), then the latest decided ones, and the latest audit entries. */
export async function limitDesk(sql: Sql, policy: RatePolicy | null, now: Date = new Date()): Promise<LimitDeskOutput> {
  const rows = await sql<RequestRow[]>`
    SELECT ${REQUEST_COLUMNS(sql)} FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id
    ORDER BY (r.status = 'waiting') DESC, CASE WHEN r.status = 'waiting' THEN r.created_at END ASC, r.reviewed_at DESC NULLS LAST
    LIMIT 100
  `;
  const audit = await sql<AuditRow[]>`
    SELECT a.id, a.request_id, a.key_id, k.name AS key_name, a.actor_id, a.decision, a.asked_per_minute,
           a.previous_per_minute, a.granted_per_minute, a.reason, a.created_at
    FROM api_limit_audit a LEFT JOIN api_keys k ON k.id = a.key_id
    ORDER BY a.created_at DESC LIMIT 100
  `;
  return {
    asOf: now.toISOString(),
    requests: rows.map((row): LimitRequestQueueRow => ({ ...toRequest(row), userId: row.user_id, keyPrefix: row.key_prefix })),
    audit: audit.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      keyId: row.key_id,
      keyName: row.key_name ?? '',
      actorId: row.actor_id,
      decision: row.decision,
      askedPerMinute: row.asked_per_minute,
      previousPerMinute: row.previous_per_minute,
      grantedPerMinute: row.granted_per_minute,
      reason: row.reason,
      at: row.created_at.toISOString(),
    })),
    grantCeilingPerMinute: policy?.grantCeilingPerMinute ?? null,
  };
}

/**
 * A reviewer's decision on one waiting request, in one transaction: the request row, the key's granted refill (on a
 * grant) and exactly one audit entry change together, or nothing does. A grant must be above what the key has now, no
 * more than was asked, and no more than the owner's ceiling (blank ceiling refuses every grant). A reviewer never
 * decides a request on their own key.
 */
export async function reviewLimitRequest(
  sql: Sql,
  policy: RatePolicy | null,
  actorId: string,
  input: LimitReviewInput,
  now: Date = new Date(),
): Promise<LimitRequest> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const found = await t<Array<RequestRow & { revoked: boolean; expires_at: Date | null; mode: string; rate_refill_per_minute_granted: number | null }>>`
      SELECT ${REQUEST_COLUMNS(t)}, k.revoked, k.expires_at, k.mode, k.rate_refill_per_minute_granted
      FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id
      WHERE r.id = ${input.id}
      FOR UPDATE OF r, k
    `;
    const row = found[0];
    if (!row) throw new RateLimitError('That limit request does not exist', 'identity.limit_request_not_found');
    if (row.user_id === actorId) throw new RateLimitError('A reviewer cannot decide a request on their own key', 'identity.limit_review_own');
    if (row.status !== 'waiting') throw new RateLimitError('That limit request was already decided', 'identity.limit_request_decided');
    const reason = input.reason.trim();
    const current = keyRateLimit(policy, row);

    if (input.decision === 'refuse') {
      await t`
        UPDATE api_limit_requests SET status = 'refused', reviewer_id = ${actorId}, review_reason = ${reason}, reviewed_at = ${now},
               updated_at = ${now}
        WHERE id = ${row.id}
      `;
      await t`
        INSERT INTO api_limit_audit (request_id, key_id, actor_id, decision, asked_per_minute, previous_per_minute, granted_per_minute, reason, created_at)
        VALUES (${row.id}, ${row.key_id}, ${actorId}, 'refused', ${row.asked_per_minute},
                ${current?.refillPerMinute ?? row.current_per_minute}, ${null}, ${reason}, ${now})
      `;
    } else {
      if (!policy || !current) throw new RateLimitError('API rate limits are not set', 'identity.rate_limits_unset');
      if (policy.grantCeilingPerMinute === null) {
        throw new RateLimitError('The most a key may be granted is not set', 'identity.rate_grant_ceiling_unset');
      }
      if (!live(row, now)) throw new RateLimitError('This key is not live', 'identity.key_not_live');
      if (input.grantedPerMinute > policy.grantCeilingPerMinute) {
        throw new RateLimitError('That is more than the most a key may be granted', 'identity.rate_grant_above_ceiling');
      }
      if (input.grantedPerMinute <= current.refillPerMinute || input.grantedPerMinute > row.asked_per_minute) {
        throw new RateLimitError('Grant more than the key has now and no more than was asked for', 'identity.limit_grant_invalid');
      }
      const status = grantStatus(row.asked_per_minute, input.grantedPerMinute);
      await t`UPDATE api_keys SET rate_refill_per_minute_granted = ${input.grantedPerMinute} WHERE id = ${row.key_id}`;
      await t`
        UPDATE api_limit_requests SET status = ${status}, granted_per_minute = ${input.grantedPerMinute}, reviewer_id = ${actorId},
               review_reason = ${reason}, reviewed_at = ${now}, updated_at = ${now}
        WHERE id = ${row.id}
      `;
      await t`
        INSERT INTO api_limit_audit (request_id, key_id, actor_id, decision, asked_per_minute, previous_per_minute, granted_per_minute, reason, created_at)
        VALUES (${row.id}, ${row.key_id}, ${actorId}, ${status}, ${row.asked_per_minute}, ${current.refillPerMinute},
                ${input.grantedPerMinute}, ${reason}, ${now})
      `;
    }
    const after = await t<RequestRow[]>`
      SELECT ${REQUEST_COLUMNS(t)} FROM api_limit_requests r JOIN api_keys k ON k.id = r.key_id WHERE r.id = ${row.id}
    `;
    return toRequest(after[0]!);
  }) as Promise<LimitRequest>;
}
