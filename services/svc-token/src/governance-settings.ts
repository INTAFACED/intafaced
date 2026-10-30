import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { TokenError } from './token-service.js';

/**
 * Governance settings and roles (J-more-catalogue-10, MC-token-02). The voting delay and period are owner values that two
 * founders write; blank means the proposal's author gives the time. Roles say who may cancel: `controller`, `admin` and
 * `moderator` cancel a draft or open proposal with a reason, `author` only creates. No value moves here.
 */

export const GOVERNANCE_ROLES = ['controller', 'admin', 'moderator', 'author'] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];
/** The roles that may cancel a proposal. */
const CANCELLERS: readonly GovernanceRole[] = ['controller', 'admin', 'moderator'];
/** The longest delay or period this door stores: one year. A setting is a whole number of milliseconds. */
const MAX_MS = 365n * 86_400_000n;
const REASON_MIN = 12;
const REASON_MAX = 500;

export interface GovernanceSettings {
  /** Null when not set: the author gives the opening time. */
  votingDelayMs: bigint | null;
  /** Null when not set: the author gives the closing time. */
  votingPeriodMs: bigint | null;
  /** The number of changes written; 0 before anything was ever set. */
  revision: number;
}

export interface GovernanceMove {
  ordinal: number;
  actorId: string;
  approverId: string;
  at: Date;
}

export async function readGovernanceSettings(sql: Sql): Promise<GovernanceSettings> {
  const rows = await sql<Array<{ voting_delay_ms: string | null; voting_period_ms: string | null; revision: number }>>`
    SELECT voting_delay_ms::text, voting_period_ms::text, revision FROM token.governance_settings WHERE id = 1
  `;
  const row = rows[0];
  if (!row) return { votingDelayMs: null, votingPeriodMs: null, revision: 0 };
  return {
    votingDelayMs: row.voting_delay_ms === null ? null : BigInt(row.voting_delay_ms),
    votingPeriodMs: row.voting_period_ms === null ? null : BigInt(row.voting_period_ms),
    revision: row.revision,
  };
}

export async function governanceSettingsHistory(
  sql: Sql,
): Promise<Array<GovernanceMove & { votingDelayMs: bigint | null; votingPeriodMs: bigint | null }>> {
  const rows = await sql<
    Array<{
      ordinal: number;
      voting_delay_ms: string | null;
      voting_period_ms: string | null;
      actor_id: string;
      approver_id: string;
      at: Date;
    }>
  >`
    SELECT ordinal, voting_delay_ms::text, voting_period_ms::text, actor_id, approver_id, at
      FROM token.governance_settings_moves ORDER BY ordinal
  `;
  return rows.map((r) => ({
    ordinal: r.ordinal,
    votingDelayMs: r.voting_delay_ms === null ? null : BigInt(r.voting_delay_ms),
    votingPeriodMs: r.voting_period_ms === null ? null : BigInt(r.voting_period_ms),
    actorId: r.actor_id,
    approverId: r.approver_id,
    at: r.at,
  }));
}

/** A delay of 0 is a deliberate zero; a period is more than zero. Null clears it. */
export function checkGovernanceSettings(input: { votingDelayMs: bigint | null; votingPeriodMs: bigint | null }): void {
  const { votingDelayMs: d, votingPeriodMs: p } = input;
  if (d !== null && (d < 0n || d > MAX_MS)) throw new TokenError('The voting delay must be 0 to 365 days', 'token.settings_invalid');
  if (p !== null && (p <= 0n || p > MAX_MS))
    throw new TokenError('The voting period must be more than 0 and at most 365 days', 'token.settings_invalid');
}

/**
 * Writes the settings over the revision read, with one numbered audit row naming who asked and who approved. A retry
 * of the same change at the same revision answers the stored settings; any other change at a stale revision refuses.
 */
export async function setGovernanceSettings(
  sql: Sql,
  input: { votingDelayMs: bigint | null; votingPeriodMs: bigint | null; expectedRevision: number; actorId: string; approverId: string },
): Promise<GovernanceSettings> {
  checkGovernanceSettings(input);
  const delay = input.votingDelayMs?.toString() ?? null;
  const period = input.votingPeriodMs?.toString() ?? null;
  return transaction(sql, async (tx) => {
    await tx`INSERT INTO token.governance_settings (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
    const rows = await tx<Array<{ revision: number }>>`SELECT revision FROM token.governance_settings WHERE id = 1 FOR UPDATE`;
    const current = rows[0]!.revision;
    const ordinal = input.expectedRevision + 1;
    const replay = await tx<Array<{ voting_delay_ms: string | null; voting_period_ms: string | null }>>`
      SELECT voting_delay_ms::text, voting_period_ms::text FROM token.governance_settings_moves WHERE ordinal = ${ordinal}
    `;
    if (replay[0]) {
      if (replay[0].voting_delay_ms === delay && replay[0].voting_period_ms === period) return readGovernanceSettings(tx);
      throw new TokenError(`The settings changed since revision ${input.expectedRevision}`, 'token.settings_stale');
    }
    if (current !== input.expectedRevision) throw new TokenError(`The settings are at revision ${current}`, 'token.settings_stale');
    await tx`
      UPDATE token.governance_settings
         SET voting_delay_ms = ${delay}::bigint, voting_period_ms = ${period}::bigint, revision = ${ordinal}
       WHERE id = 1
    `;
    await tx`
      INSERT INTO token.governance_settings_moves (ordinal, voting_delay_ms, voting_period_ms, actor_id, approver_id)
      VALUES (${ordinal}, ${delay}::bigint, ${period}::bigint, ${input.actorId}, ${input.approverId})
    `;
    return readGovernanceSettings(tx);
  });
}

/**
 * The window of a new proposal. A time the author gives is kept. Without one, the opening time is now plus the stored
 * delay and the closing time is the opening time plus the stored period; a blank setting and no time from the author
 * refuses `token.proposal_window_unset`.
 */
export function proposalWindow(
  settings: Pick<GovernanceSettings, 'votingDelayMs' | 'votingPeriodMs'>,
  input: { opensAt?: Date; closesAt?: Date; now: Date },
): { opensAt: Date; closesAt: Date } {
  let opensAt = input.opensAt;
  if (!opensAt) {
    if (settings.votingDelayMs === null)
      throw new TokenError('The voting delay is not set, so a proposal must give its opening time', 'token.proposal_window_unset');
    opensAt = new Date(input.now.getTime() + Number(settings.votingDelayMs));
  }
  let closesAt = input.closesAt;
  if (!closesAt) {
    if (settings.votingPeriodMs === null)
      throw new TokenError('The voting period is not set, so a proposal must give its closing time', 'token.proposal_window_unset');
    closesAt = new Date(opensAt.getTime() + Number(settings.votingPeriodMs));
  }
  return { opensAt, closesAt };
}

export interface GovernanceRoleRow {
  userId: string;
  role: GovernanceRole | null;
  revision: number;
}

/** Every account that ever had a role; a revoked one reads role null and keeps its revision. */
export async function governanceRoles(sql: Sql, limit: number): Promise<GovernanceRoleRow[]> {
  return sql<GovernanceRoleRow[]>`
    SELECT user_id AS "userId", role, revision FROM token.governance_roles ORDER BY user_id LIMIT ${limit}
  `;
}

export async function governanceRoleOf(sql: Sql, userId: string): Promise<GovernanceRole | null> {
  const rows = await sql<Array<{ role: GovernanceRole | null }>>`SELECT role FROM token.governance_roles WHERE user_id = ${userId}`;
  return rows[0]?.role ?? null;
}

/**
 * Grants, changes or revokes (`role` null) one account's role over the revision read, with a numbered audit row. The
 * account that receives a role never asks for or approves it; a retry of the same move at the same revision answers the stored row.
 */
export async function setGovernanceRole(
  sql: Sql,
  input: { userId: string; role: GovernanceRole | null; expectedRevision: number; actorId: string; approverId: string },
): Promise<GovernanceRoleRow> {
  if (input.role !== null && !(GOVERNANCE_ROLES as readonly string[]).includes(input.role))
    throw new TokenError('That is not a governance role', 'token.role_invalid');
  if (input.actorId === input.userId || input.approverId === input.userId)
    throw new TokenError('A role is never asked for or approved by the account that receives it', 'token.role_invalid');
  return transaction(sql, async (tx) => {
    const rows = await tx<Array<{ role: GovernanceRole | null; revision: number }>>`
      SELECT role, revision FROM token.governance_roles WHERE user_id = ${input.userId} FOR UPDATE
    `;
    const current = rows[0] ?? { role: null, revision: 0 };
    const ordinal = input.expectedRevision + 1;
    const replay = await tx<Array<{ to_role: string | null }>>`
      SELECT to_role FROM token.governance_role_moves WHERE user_id = ${input.userId} AND ordinal = ${ordinal}
    `;
    if (replay[0]) {
      if (replay[0].to_role === input.role) return { userId: input.userId, role: current.role, revision: current.revision };
      throw new TokenError(`The role changed since revision ${input.expectedRevision}`, 'token.role_stale');
    }
    if (current.revision !== input.expectedRevision)
      throw new TokenError(`The role is at revision ${current.revision}`, 'token.role_stale');
    if (current.role === input.role) throw new TokenError('The account already has that role', 'token.role_invalid');
    await tx`
      INSERT INTO token.governance_roles (user_id, role, revision) VALUES (${input.userId}, ${input.role}, ${ordinal})
      ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, revision = EXCLUDED.revision
    `;
    await tx`
      INSERT INTO token.governance_role_moves (user_id, ordinal, from_role, to_role, actor_id, approver_id)
      VALUES (${input.userId}, ${ordinal}, ${current.role}, ${input.role}, ${input.actorId}, ${input.approverId})
    `;
    return { userId: input.userId, role: input.role, revision: ordinal };
  });
}

/**
 * Cancels a draft or open proposal with a reason. Only a controller, admin or moderator may; its votes stay, and votes
 * after it are refused because it is no longer open. A second cancel by anyone is refused as not cancellable.
 */
export async function cancelGovernanceProposal(
  sql: Sql,
  input: { proposalId: string; reason: string; actorId: string; now: Date },
): Promise<{ id: string; status: 'cancelled'; cancelReason: string; cancelledBy: string; cancelledAt: Date }> {
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    throw new TokenError(`A cancel needs a reason of ${REASON_MIN} to ${REASON_MAX} characters`, 'token.cancel_reason_invalid');
  const role = await governanceRoleOf(sql, input.actorId);
  if (role === null || !CANCELLERS.includes(role))
    throw new TokenError('Only a governance moderator, admin or controller can cancel a proposal', 'token.permission_denied');
  return transaction(sql, async (tx) => {
    const rows = await tx<Array<{ status: string }>>`SELECT status FROM token.proposals WHERE id = ${input.proposalId} FOR UPDATE`;
    if (!rows[0]) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
    if (rows[0].status !== 'draft' && rows[0].status !== 'open')
      throw new TokenError(`A ${rows[0].status} proposal cannot be cancelled`, 'token.proposal_not_cancellable');
    await tx`
      UPDATE token.proposals
         SET status = 'cancelled', cancel_reason = ${reason}, cancelled_by = ${input.actorId}, cancelled_at = ${input.now}
       WHERE id = ${input.proposalId}
    `;
    return { id: input.proposalId, status: 'cancelled' as const, cancelReason: reason, cancelledBy: input.actorId, cancelledAt: input.now };
  });
}
