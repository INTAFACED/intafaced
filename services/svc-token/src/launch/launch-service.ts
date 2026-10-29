import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { LaunchError } from './errors.js';

/**
 * Token launch events (J-more-catalogue-11): the catalogue, one event with its periods, issuer state, allocation rule
 * and terms, and the holdings snapshot an allocation by holdings is based on.
 *
 * Nothing here moves value. Allocation and distribution would move tokens, and no ledger recipe is wired for them, so
 * an event stops at `closed` and the next move refuses `launch.allocation_unwired`. A snapshot row is a measurement of
 * active stake taken in the move to `snapshot`, never a claim on anything.
 *
 * A blank price, cap, ticket size or weight stays null and the reader shows "not set". Nothing is defaulted.
 */

export const LAUNCH_TYPES = ['token_sale', 'whitelist_drop', 'primary_subscription'] as const;
export const LAUNCH_STATUSES = [
  'draft',
  'announced',
  'snapshot',
  'open',
  'closed',
  'allocated',
  'distributing',
  'complete',
  'cancelled',
] as const;
export const ISSUER_STATES = ['applied', 'reviewing', 'onboarded', 'suspended'] as const;
export const ALLOCATION_METHODS = ['pro_rata', 'tickets', 'tiered'] as const;
export const LAUNCH_STATES = ['upcoming', 'open', 'past'] as const;

export type LaunchType = (typeof LAUNCH_TYPES)[number];
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];
export type IssuerState = (typeof ISSUER_STATES)[number];
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];
export type LaunchState = (typeof LAUNCH_STATES)[number];

/** The catalogue's three states. A draft is in none of them: it is not published. */
export function stateOf(status: LaunchStatus): LaunchState | null {
  switch (status) {
    case 'draft':
      return null;
    case 'announced':
    case 'snapshot':
      return 'upcoming';
    case 'open':
      return 'open';
    default:
      return 'past';
  }
}

const STATUSES_OF: Record<LaunchState, LaunchStatus[]> = {
  upcoming: ['announced', 'snapshot'],
  open: ['open'],
  past: ['closed', 'allocated', 'distributing', 'complete', 'cancelled'],
};

/** The one forward step from each status. `cancelled` is reached from any status that is not finished. */
const NEXT: Partial<Record<LaunchStatus, LaunchStatus>> = {
  draft: 'announced',
  announced: 'snapshot',
  snapshot: 'open',
  open: 'closed',
  closed: 'allocated',
  allocated: 'distributing',
  distributing: 'complete',
};

/** Issuer review. `suspended` goes back through review before it can be onboarded again. */
const ISSUER_MOVES: Record<IssuerState, IssuerState[]> = {
  applied: ['reviewing'],
  reviewing: ['onboarded', 'applied'],
  onboarded: ['suspended'],
  suspended: ['reviewing'],
};

function issuerName(input: { id: string; name: string }): string {
  if (!ID_RE.test(input.id)) throw new LaunchError('Issuer id must be 3 to 63 lowercase letters, digits or dashes', 'launch.event_invalid');
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) throw new LaunchError('Issuer name must be 1 to 120 characters', 'launch.event_invalid');
  return name;
}

/** Every refusal of an issuer change, given the stored issuer and the move row at the next ordinal, if any. */
function refuseIssuerSet(
  current: { name: string; state: IssuerState; revision: number } | undefined,
  input: { id: string; name: string; state: IssuerState; expectedRevision: number },
  replayTo: string | undefined,
): 'replay' | 'set' {
  if (current && replayTo !== undefined) {
    if (replayTo === input.state && current.name === input.name) return 'replay';
    throw new LaunchError(`Issuer ${input.id} changed since revision ${input.expectedRevision}`, 'launch.issuer_stale');
  }
  if (!current) {
    if (input.expectedRevision !== 0) throw new LaunchError(`Issuer ${input.id} not found`, 'launch.issuer_not_found');
    if (input.state !== 'applied') throw new LaunchError('A new issuer starts as applied', 'launch.issuer_move_invalid');
    return 'set';
  }
  if (current.name !== input.name) throw new LaunchError(`Issuer ${input.id} has another name`, 'launch.issuer_conflict');
  if (current.revision !== input.expectedRevision) {
    throw new LaunchError(`Issuer ${input.id} is at revision ${current.revision}`, 'launch.issuer_stale');
  }
  if (!ISSUER_MOVES[current.state].includes(input.state)) {
    throw new LaunchError(`Issuer cannot move from ${current.state} to ${input.state}`, 'launch.issuer_move_invalid');
  }
  return 'set';
}

/** Every refusal of an event move, given the stored event and the move row at the next ordinal, if any. */
function refuseMove(
  event: LaunchEvent,
  input: { id: string; to: LaunchStatus; expectedRevision: number; now: Date },
  replayTo: string | undefined,
): 'replay' | 'move' {
  if (replayTo !== undefined) {
    if (replayTo === input.to) return 'replay';
    throw new LaunchError(`Launch ${input.id} changed since revision ${input.expectedRevision}`, 'launch.event_stale');
  }
  if (event.revision !== input.expectedRevision) {
    throw new LaunchError(`Launch ${input.id} is at revision ${event.revision}`, 'launch.event_stale');
  }
  if (input.to === 'cancelled') {
    if (event.status === 'complete' || event.status === 'cancelled') {
      throw new LaunchError(`A ${event.status} launch cannot be cancelled`, 'launch.event_move_invalid');
    }
    return 'move';
  }
  if (NEXT[event.status] !== input.to) {
    throw new LaunchError(`Launch cannot move from ${event.status} to ${input.to}`, 'launch.event_move_invalid');
  }
  if (input.to === 'allocated' || input.to === 'distributing' || input.to === 'complete') {
    throw new LaunchError('Allocation and distribution have no ledger recipe wired', 'launch.allocation_unwired');
  }
  if ((input.to === 'announced' || input.to === 'snapshot' || input.to === 'open') && event.issuer.state !== 'onboarded') {
    throw new LaunchError(`Issuer ${event.issuer.id} is ${event.issuer.state}`, 'launch.issuer_not_onboarded');
  }
  const p = event.periods;
  const due = { announced: p.announceAt, snapshot: p.snapshotAt, open: p.openAt, closed: p.closeAt }[
    input.to as 'announced' | 'snapshot' | 'open' | 'closed'
  ];
  if (input.now < due) throw new LaunchError(`The ${input.to} period starts at ${due.toISOString()}`, 'launch.period_not_due');
  if (input.to === 'open' && input.now >= p.closeAt) throw new LaunchError('The launch window has already closed', 'launch.period_passed');
  return 'move';
}

export interface TierWeight {
  minBasis: Amount;
  weight: number;
}

export interface LaunchEvent {
  id: string;
  issuer: { id: string; name: string; state: IssuerState };
  type: LaunchType;
  projectName: string;
  symbol: string;
  periods: { announceAt: Date; snapshotAt: Date; openAt: Date; closeAt: Date; distributionAt: Date };
  status: LaunchStatus;
  state: LaunchState | null;
  allocation: { method: AllocationMethod | null; perUserCap: Amount | null; ticketSize: Amount | null; tierWeights: TierWeight[] | null };
  terms: { price: Amount | null; paymentAsset: string | null; rateSource: string | null };
  snapshot: { count: number; total: Amount; hash: string; takenAt: Date } | null;
  revision: number;
}

export interface LaunchIssuer {
  id: string;
  name: string;
  state: IssuerState;
  revision: number;
}

export interface CreateEventInput {
  id: string;
  issuerId: string;
  type: LaunchType;
  projectName: string;
  symbol: string;
  periods: { announceAt: Date; snapshotAt: Date; openAt: Date; closeAt: Date; distributionAt: Date };
  allocation: {
    method: AllocationMethod | null;
    perUserCap: string | null;
    ticketSize: string | null;
    tierWeights: Array<{ minBasis: string; weight: number }> | null;
  };
  terms: { price: string | null; paymentAsset: string | null; rateSource: string | null };
}

export interface Basis {
  eventId: string;
  method: AllocationMethod | null;
  perUserCap: Amount | null;
  ticketSize: Amount | null;
  tierWeights: TierWeight[] | null;
  /** The stored snapshot row for this account, or null with the reason. */
  basis: Amount | null;
  reason: 'snapshot_not_taken' | 'no_holdings_at_snapshot' | null;
  takenAt: Date | null;
  /** Whole tickets (a count, not an amount), derived from the basis and the stored rule; null when either is missing. */
  tickets: bigint | null;
  tierWeight: number | null;
}

/** Rows per snapshot INSERT: 4 bind parameters each, far below Postgres's 65535 per statement. */
export const LAUNCH_SNAPSHOT_CHUNK = 5000;

/** sha256 over `user:basis` lines in user order: the seal a stored snapshot is checked against. */
export function launchSnapshotHash(rows: ReadonlyArray<{ userId: string; basis: Amount }>): string {
  const lines = [...rows]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((row) => `${row.userId}:${formatAmount(row.basis)}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

/** Whole tickets an account's basis buys under a ticket rule, as a count. Floor: a part ticket is no ticket. */
export function ticketsFor(basis: Amount, ticketSize: Amount): bigint {
  return basis / ticketSize;
}

/** The weight of the highest tier whose minimum the basis reaches, or 0 below every tier. */
export function tierWeightFor(basis: Amount, tiers: readonly TierWeight[]): number {
  let weight = 0;
  for (const tier of tiers) if (basis >= tier.minBasis) weight = tier.weight;
  return weight;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,12}$/;
const ASSET_RE = /^[A-Z0-9]{2,12}$/;

function positiveAmount(raw: string | null, field: string): Amount | null {
  if (raw === null) return null;
  let value: Amount;
  try {
    value = parseAmount(raw);
  } catch {
    throw new LaunchError(`${field} is not a decimal string`, 'launch.event_invalid');
  }
  if (value <= 0n) throw new LaunchError(`${field} must be above zero`, 'launch.event_invalid');
  return value;
}

/** Checks a new event and returns its canonical stored fields. Refuses `launch.event_invalid` with the field named. */
export function canonicalEvent(input: CreateEventInput) {
  if (!ID_RE.test(input.id)) throw new LaunchError('Launch id must be 3 to 63 lowercase letters, digits or dashes', 'launch.event_invalid');
  if (!ID_RE.test(input.issuerId)) throw new LaunchError('Issuer id is not valid', 'launch.event_invalid');
  if (!(LAUNCH_TYPES as readonly string[]).includes(input.type)) throw new LaunchError('Launch type is not valid', 'launch.event_invalid');
  const projectName = input.projectName.trim();
  if (projectName.length < 1 || projectName.length > 120)
    throw new LaunchError('Project name must be 1 to 120 characters', 'launch.event_invalid');
  if (!SYMBOL_RE.test(input.symbol)) throw new LaunchError('Symbol must be 2 to 12 capital letters or digits', 'launch.event_invalid');
  const p = input.periods;
  for (const [name, at] of Object.entries(p)) {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new LaunchError(`${name} is not a time`, 'launch.event_invalid');
  }
  if (!(p.announceAt <= p.snapshotAt && p.snapshotAt <= p.openAt && p.openAt < p.closeAt && p.closeAt <= p.distributionAt)) {
    throw new LaunchError('Periods must run announce, snapshot, open, close, distribution in that order', 'launch.event_invalid');
  }
  const a = input.allocation;
  if (a.method !== null && !(ALLOCATION_METHODS as readonly string[]).includes(a.method)) {
    throw new LaunchError('Allocation method is not valid', 'launch.event_invalid');
  }
  const perUserCap = positiveAmount(a.perUserCap, 'Cap');
  const ticketSize = positiveAmount(a.ticketSize, 'Ticket size');
  let tierWeights: TierWeight[] | null = null;
  if (a.tierWeights !== null) {
    if (a.tierWeights.length < 1 || a.tierWeights.length > 16)
      throw new LaunchError('Tier weights need 1 to 16 tiers', 'launch.event_invalid');
    tierWeights = a.tierWeights.map((tier) => {
      if (!Number.isInteger(tier.weight) || tier.weight < 1 || tier.weight > 1000) {
        throw new LaunchError('A tier weight is a whole number from 1 to 1000', 'launch.event_invalid');
      }
      let minBasis: Amount;
      try {
        minBasis = parseAmount(tier.minBasis);
      } catch {
        throw new LaunchError('A tier minimum is not a decimal string', 'launch.event_invalid');
      }
      if (minBasis < 0n) throw new LaunchError('A tier minimum is negative', 'launch.event_invalid');
      return { minBasis, weight: tier.weight };
    });
    for (let i = 1; i < tierWeights.length; i++) {
      if (tierWeights[i]!.minBasis <= tierWeights[i - 1]!.minBasis) {
        throw new LaunchError('Tier minimums must rise from one tier to the next', 'launch.event_invalid');
      }
    }
  }
  const t = input.terms;
  const price = positiveAmount(t.price, 'Price');
  if ((price === null) !== (t.paymentAsset === null))
    throw new LaunchError('A price needs the asset it is paid in', 'launch.event_invalid');
  if (t.paymentAsset !== null && !ASSET_RE.test(t.paymentAsset))
    throw new LaunchError('Payment asset is not valid', 'launch.event_invalid');
  const rateSource = t.rateSource === null ? null : t.rateSource.trim();
  if (rateSource !== null && (rateSource.length < 1 || rateSource.length > 120)) {
    throw new LaunchError('Rate source must be 1 to 120 characters', 'launch.event_invalid');
  }
  if (rateSource !== null && price === null) throw new LaunchError('A rate source needs a price', 'launch.event_invalid');
  return {
    id: input.id,
    issuerId: input.issuerId,
    type: input.type,
    projectName,
    symbol: input.symbol,
    periods: p,
    method: a.method,
    perUserCap,
    ticketSize,
    tierWeights,
    price,
    paymentAsset: t.paymentAsset,
    rateSource,
  };
}

interface EventRow {
  id: string;
  issuer_id: string;
  issuer_name: string;
  issuer_state: IssuerState;
  type: LaunchType;
  project_name: string;
  symbol: string;
  announce_at: Date;
  snapshot_at: Date;
  open_at: Date;
  close_at: Date;
  distribution_at: Date;
  status: LaunchStatus;
  allocation_method: AllocationMethod | null;
  per_user_cap: string | null;
  ticket_size: string | null;
  tier_weights: Array<{ minBasis: string; weight: number }> | null;
  price: string | null;
  payment_asset: string | null;
  rate_source: string | null;
  snapshot_count: number | null;
  snapshot_total: string | null;
  snapshot_hash: string | null;
  snapshot_taken_at: Date | null;
  revision: number;
}

const amountOrNull = (raw: string | null): Amount | null => (raw === null ? null : parseAmount(raw));

function eventFromRow(row: EventRow): LaunchEvent {
  return {
    id: row.id,
    issuer: { id: row.issuer_id, name: row.issuer_name, state: row.issuer_state },
    type: row.type,
    projectName: row.project_name,
    symbol: row.symbol,
    periods: {
      announceAt: row.announce_at,
      snapshotAt: row.snapshot_at,
      openAt: row.open_at,
      closeAt: row.close_at,
      distributionAt: row.distribution_at,
    },
    status: row.status,
    state: stateOf(row.status),
    allocation: {
      method: row.allocation_method,
      perUserCap: amountOrNull(row.per_user_cap),
      ticketSize: amountOrNull(row.ticket_size),
      tierWeights:
        row.tier_weights === null ? null : row.tier_weights.map((t) => ({ minBasis: parseAmount(t.minBasis), weight: t.weight })),
    },
    terms: { price: amountOrNull(row.price), paymentAsset: row.payment_asset, rateSource: row.rate_source },
    snapshot:
      row.snapshot_count === null || row.snapshot_total === null || row.snapshot_hash === null || row.snapshot_taken_at === null
        ? null
        : { count: row.snapshot_count, total: parseAmount(row.snapshot_total), hash: row.snapshot_hash, takenAt: row.snapshot_taken_at },
    revision: row.revision,
  };
}

const sameTime = (a: Date, b: Date) => a.getTime() === b.getTime();
const sameAmount = (a: Amount | null, b: Amount | null) => a === b;

export class LaunchService {
  constructor(private readonly sql: Sql) {}

  private async selectEvents(
    db: Sql,
    where: { id?: string; statuses?: LaunchStatus[]; type?: LaunchType; limit?: number; forUpdate?: boolean },
  ) {
    return db<EventRow[]>`
      SELECT e.id, e.issuer_id, i.name AS issuer_name, i.state AS issuer_state, e.type, e.project_name, e.symbol,
             e.announce_at, e.snapshot_at, e.open_at, e.close_at, e.distribution_at, e.status,
             e.allocation_method, e.per_user_cap::text AS per_user_cap, e.ticket_size::text AS ticket_size, e.tier_weights,
             e.price::text AS price, e.payment_asset, e.rate_source,
             e.snapshot_count, e.snapshot_total::text AS snapshot_total, e.snapshot_hash, e.snapshot_taken_at, e.revision
        FROM token.launch_events e
        JOIN token.launch_issuers i ON i.id = e.issuer_id
       WHERE true
         ${where.id === undefined ? db`` : db`AND e.id = ${where.id}`}
         ${where.statuses === undefined ? db`` : db`AND e.status IN ${db(where.statuses)}`}
         ${where.type === undefined ? db`` : db`AND e.type = ${where.type}`}
       ORDER BY e.open_at DESC, e.id
       ${where.limit === undefined ? db`` : db`LIMIT ${where.limit}`}
       ${where.forUpdate ? db`FOR UPDATE OF e` : db``}
    `;
  }

  /** The published catalogue: every event that is not a draft, newest opening first. A missing page size refuses. */
  async listEvents(input: { type?: LaunchType; state?: LaunchState; limit?: number }): Promise<LaunchEvent[]> {
    if (input.limit === undefined) throw new LaunchError('A page size is required', 'launch.events_list_limit_unset');
    const statuses = input.state === undefined ? LAUNCH_STATUSES.filter((s) => s !== 'draft') : STATUSES_OF[input.state];
    const rows = await this.selectEvents(this.sql, { statuses, ...(input.type ? { type: input.type } : {}), limit: input.limit });
    return rows.map(eventFromRow);
  }

  /** One published event. A draft reads as not found: it is not published. */
  async getEvent(id: string): Promise<LaunchEvent> {
    const row = (await this.selectEvents(this.sql, { id }))[0];
    if (!row || row.status === 'draft') throw new LaunchError(`Launch ${id} not found`, 'launch.event_not_found');
    return eventFromRow(row);
  }

  async getIssuer(id: string): Promise<LaunchIssuer | null> {
    const rows = await this.sql<Array<{ id: string; name: string; state: IssuerState; revision: number }>>`
      SELECT id, name, state, revision FROM token.launch_issuers WHERE id = ${id}
    `;
    return rows[0] ?? null;
  }

  /**
   * Refuses an issuer change that setIssuer would refuse, without writing or locking, so a refused change never spends
   * the founders' approval. setIssuer checks again under its lock: this only moves the refusal ahead of the approval.
   */
  async checkIssuerSet(input: { id: string; name: string; state: IssuerState; expectedRevision: number }): Promise<void> {
    const name = issuerName(input);
    const rows = await this.sql<Array<{ id: string; name: string; state: IssuerState; revision: number }>>`
      SELECT id, name, state, revision FROM token.launch_issuers WHERE id = ${input.id}
    `;
    const replay = await this.sql<Array<{ to_state: string }>>`
      SELECT to_state FROM token.launch_issuer_moves WHERE issuer_id = ${input.id} AND ordinal = ${input.expectedRevision + 1}
    `;
    refuseIssuerSet(rows[0], { ...input, name }, replay[0]?.to_state);
  }

  /** As checkIssuerSet, for moveEvent: the same refusals, read-only, before the approval is spent. */
  async checkMove(input: { id: string; to: LaunchStatus; expectedRevision: number; now: Date }): Promise<void> {
    const row = (await this.selectEvents(this.sql, { id: input.id }))[0];
    if (!row) throw new LaunchError(`Launch ${input.id} not found`, 'launch.event_not_found');
    const replay = await this.sql<Array<{ to_status: string }>>`
      SELECT to_status FROM token.launch_event_moves WHERE event_id = ${input.id} AND ordinal = ${input.expectedRevision + 1}
    `;
    refuseMove(eventFromRow(row), input, replay[0]?.to_status);
  }

  /**
   * Adds an issuer (`expectedRevision` 0, state `applied`) or moves it one review step. The move row's ordinal is the
   * revision after the move, so a retried move with the same expected revision and target replays instead of failing.
   */
  async setIssuer(input: {
    id: string;
    name: string;
    state: IssuerState;
    expectedRevision: number;
    actorId: string;
    approverId: string;
  }): Promise<LaunchIssuer> {
    const name = issuerName(input);
    return transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ id: string; name: string; state: IssuerState; revision: number }>>`
        SELECT id, name, state, revision FROM token.launch_issuers WHERE id = ${input.id} FOR UPDATE
      `;
      const current = rows[0];
      const ordinal = input.expectedRevision + 1;
      const replay = await tx<Array<{ to_state: string }>>`
        SELECT to_state FROM token.launch_issuer_moves WHERE issuer_id = ${input.id} AND ordinal = ${ordinal}
      `;
      const verdict = refuseIssuerSet(current, { ...input, name }, replay[0]?.to_state);
      if (verdict === 'replay') return current!;
      if (!current) {
        await tx`
          INSERT INTO token.launch_issuers (id, name, state, revision) VALUES (${input.id}, ${name}, 'applied', 1)
        `;
        await tx`
          INSERT INTO token.launch_issuer_moves (issuer_id, ordinal, from_state, to_state, actor_id, approver_id)
          VALUES (${input.id}, 1, NULL, 'applied', ${input.actorId}, ${input.approverId})
        `;
        return { id: input.id, name, state: 'applied', revision: 1 };
      }
      await tx`
        UPDATE token.launch_issuers SET state = ${input.state}, revision = ${ordinal}, updated_at = now() WHERE id = ${input.id}
      `;
      await tx`
        INSERT INTO token.launch_issuer_moves (issuer_id, ordinal, from_state, to_state, actor_id, approver_id)
        VALUES (${input.id}, ${ordinal}, ${current.state}, ${input.state}, ${input.actorId}, ${input.approverId})
      `;
      return { ...current, state: input.state, revision: ordinal };
    });
  }

  /**
   * Creates a draft. The launch id is the business key: the same id with the same fields returns the stored draft
   * (a retry), and the same id with any other field refuses `launch.event_conflict`.
   */
  async createEvent(input: CreateEventInput): Promise<{ id: string; status: LaunchStatus; revision: number }> {
    const e = canonicalEvent(input);
    return transaction(this.sql, async (tx) => {
      const issuer = await tx<Array<{ id: string }>>`SELECT id FROM token.launch_issuers WHERE id = ${e.issuerId}`;
      if (!issuer[0]) throw new LaunchError(`Issuer ${e.issuerId} not found`, 'launch.issuer_not_found');
      const existing = (await this.selectEvents(tx, { id: e.id, forUpdate: true }))[0];
      if (existing) {
        const stored = eventFromRow(existing);
        const same =
          stored.issuer.id === e.issuerId &&
          stored.type === e.type &&
          stored.projectName === e.projectName &&
          stored.symbol === e.symbol &&
          sameTime(stored.periods.announceAt, e.periods.announceAt) &&
          sameTime(stored.periods.snapshotAt, e.periods.snapshotAt) &&
          sameTime(stored.periods.openAt, e.periods.openAt) &&
          sameTime(stored.periods.closeAt, e.periods.closeAt) &&
          sameTime(stored.periods.distributionAt, e.periods.distributionAt) &&
          stored.allocation.method === e.method &&
          sameAmount(stored.allocation.perUserCap, e.perUserCap) &&
          sameAmount(stored.allocation.ticketSize, e.ticketSize) &&
          JSON.stringify(stored.allocation.tierWeights?.map((t) => [formatAmount(t.minBasis), t.weight]) ?? null) ===
            JSON.stringify(e.tierWeights?.map((t) => [formatAmount(t.minBasis), t.weight]) ?? null) &&
          sameAmount(stored.terms.price, e.price) &&
          stored.terms.paymentAsset === e.paymentAsset &&
          stored.terms.rateSource === e.rateSource;
        if (!same) throw new LaunchError(`Launch ${e.id} already exists with other details`, 'launch.event_conflict');
        return { id: stored.id, status: stored.status, revision: stored.revision };
      }
      const fmt = (v: Amount | null) => (v === null ? null : formatAmount(v));
      const weights =
        e.tierWeights === null ? null : tx.json(e.tierWeights.map((t) => ({ minBasis: formatAmount(t.minBasis), weight: t.weight })));
      await tx`
        INSERT INTO token.launch_events (
          id, issuer_id, type, project_name, symbol, announce_at, snapshot_at, open_at, close_at, distribution_at,
          allocation_method, per_user_cap, ticket_size, tier_weights, price, payment_asset, rate_source
        ) VALUES (
          ${e.id}, ${e.issuerId}, ${e.type}, ${e.projectName}, ${e.symbol},
          ${e.periods.announceAt}, ${e.periods.snapshotAt}, ${e.periods.openAt}, ${e.periods.closeAt}, ${e.periods.distributionAt},
          ${e.method}, ${fmt(e.perUserCap)}::numeric, ${fmt(e.ticketSize)}::numeric, ${weights},
          ${fmt(e.price)}::numeric, ${e.paymentAsset}, ${e.rateSource}
        )
      `;
      return { id: e.id, status: 'draft' as const, revision: 0 };
    });
  }

  /**
   * Moves an event one step forward, or to `cancelled`. Each step waits for its own period, and the steps that
   * publish or take part (announced, snapshot, open) need an onboarded issuer. The move to `snapshot` seals the
   * holdings in the same transaction, so a crash leaves neither the status nor a half snapshot.
   * Past `closed`, allocation and distribution would move tokens and refuse `launch.allocation_unwired`.
   */
  async moveEvent(input: {
    id: string;
    to: LaunchStatus;
    expectedRevision: number;
    actorId: string;
    approverId: string;
    now: Date;
  }): Promise<LaunchEvent> {
    return transaction(this.sql, async (tx) => {
      const row = (await this.selectEvents(tx, { id: input.id, forUpdate: true }))[0];
      if (!row) throw new LaunchError(`Launch ${input.id} not found`, 'launch.event_not_found');
      const event = eventFromRow(row);
      const ordinal = input.expectedRevision + 1;
      const replay = await tx<Array<{ to_status: string }>>`
        SELECT to_status FROM token.launch_event_moves WHERE event_id = ${input.id} AND ordinal = ${ordinal}
      `;
      if (refuseMove(event, input, replay[0]?.to_status) === 'replay') return event;
      const now = input.now;
      if (input.to === 'snapshot') await this.sealSnapshot(tx, event.id, now);
      await tx`
        UPDATE token.launch_events SET status = ${input.to}, revision = ${ordinal} WHERE id = ${input.id}
      `;
      await tx`
        INSERT INTO token.launch_event_moves (event_id, ordinal, from_status, to_status, actor_id, approver_id, at)
        VALUES (${input.id}, ${ordinal}, ${event.status}, ${input.to}, ${input.actorId}, ${input.approverId}, ${now})
      `;
      return eventFromRow((await this.selectEvents(tx, { id: input.id }))[0]!);
    });
  }

  /** One row per account with active stake at `takenAt`, then the seal: count, total and hash. */
  private async sealSnapshot(tx: Sql, eventId: string, takenAt: Date): Promise<void> {
    const holdings = await tx<Array<{ user_id: string; basis: string }>>`
      SELECT user_id, sum(amount)::text AS basis
        FROM token.stakes
       WHERE status = 'active' AND started_at <= ${takenAt}
       GROUP BY user_id
      HAVING sum(amount) > 0
    `;
    const rows = holdings.map((h) => ({ userId: h.user_id, basis: parseAmount(h.basis) }));
    for (let start = 0; start < rows.length; start += LAUNCH_SNAPSHOT_CHUNK) {
      const values = rows.slice(start, start + LAUNCH_SNAPSHOT_CHUNK).map((r) => ({
        event_id: eventId,
        user_id: r.userId,
        basis: formatAmount(r.basis),
        taken_at: takenAt,
      }));
      await tx`INSERT INTO token.launch_snapshots ${tx(values, 'event_id', 'user_id', 'basis', 'taken_at')}`;
    }
    const total = rows.reduce((sum, r) => sum + r.basis, 0n);
    await tx`
      UPDATE token.launch_events
         SET snapshot_count = ${rows.length},
             snapshot_total = ${formatAmount(total)}::numeric,
             snapshot_hash = ${launchSnapshotHash(rows)},
             snapshot_taken_at = ${takenAt}
       WHERE id = ${eventId}
    `;
  }

  /**
   * The signed account's basis for an allocation by holdings: its stored snapshot row, with the event's rule. Before
   * the snapshot, or with no row for this account, the basis is null with its reason; never today's stake.
   */
  async readBasis(eventId: string, userId: string): Promise<Basis> {
    const event = await this.getEvent(eventId);
    const a = event.allocation;
    const base = {
      eventId,
      method: a.method,
      perUserCap: a.perUserCap,
      ticketSize: a.ticketSize,
      tierWeights: a.tierWeights,
    };
    if (!event.snapshot) return { ...base, basis: null, reason: 'snapshot_not_taken', takenAt: null, tickets: null, tierWeight: null };
    const rows = await this.sql<Array<{ basis: string; taken_at: Date }>>`
      SELECT basis::text AS basis, taken_at FROM token.launch_snapshots WHERE event_id = ${eventId} AND user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) {
      return { ...base, basis: null, reason: 'no_holdings_at_snapshot', takenAt: event.snapshot.takenAt, tickets: null, tierWeight: null };
    }
    const basis = parseAmount(row.basis);
    return {
      ...base,
      basis,
      reason: null,
      takenAt: row.taken_at,
      tickets: a.method === 'tickets' && a.ticketSize !== null ? ticketsFor(basis, a.ticketSize) : null,
      tierWeight: a.method === 'tiered' && a.tierWeights !== null ? tierWeightFor(basis, a.tierWeights) : null,
    };
  }
}
