import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TokenError } from './token-service.js';

/**
 * MC-token-03: who may vote, voting power fixed when a proposal is created,
 * and the code a signed vote that cannot be checked refuses with (vote-signature.ts).
 *
 * Power is a stored measurement of the stake pots taken inside the proposal's
 * creation transaction. Nothing here moves value or holds a balance.
 */

export const VOTE_RULE_UNSET = 'token.vote_rule_unset' as const;
export const SIGNED_VOTE_UNAVAILABLE = 'token.signed_vote_unavailable' as const;

export interface VoteRule {
  /** Least voting power, at the proposal's snapshot, that may vote. */
  minPower: Amount;
}

/**
 * `power:<decimal>`. Blank refuses `token.vote_rule_unset`; never a default.
 * `power:0` is a deliberate zero (any account with a snapshot row may vote).
 */
export function parseVoteRule(raw: string | undefined): VoteRule {
  const rule = raw?.trim() ?? '';
  if (rule === '') throw new TokenError('Who may vote is not set', VOTE_RULE_UNSET);
  const colon = rule.indexOf(':');
  const head = colon === -1 ? rule : rule.slice(0, colon);
  const tail = colon === -1 ? '' : rule.slice(colon + 1).trim();
  if (head !== 'power') throw new TokenError('Vote rule kind is not valid', 'token.params_invalid');
  if (tail === '') throw new TokenError('Who may vote is not set', VOTE_RULE_UNSET);
  let minPower: Amount;
  try {
    minPower = parseAmount(tail);
  } catch {
    throw new TokenError('Vote rule minimum is not a decimal string', 'token.params_invalid');
  }
  if (minPower < 0n) throw new TokenError('Vote rule minimum is negative', 'token.params_invalid');
  return { minPower };
}

/** sha256 over `user:power` lines in user order. The seal a resumed or audited snapshot is checked against. */
export function snapshotHash(rows: ReadonlyArray<{ userId: string; power: Amount }>): string {
  const lines = [...rows]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((row) => `${row.userId}:${formatAmount(row.power)}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

/** Rows per snapshot INSERT: 4 bind parameters each, far below Postgres's limit of 65535 per statement. */
export const SNAPSHOT_INSERT_CHUNK = 5000;

/**
 * Writes one row per account with active stake and seals the proposal.
 * Runs on the creation transaction, so a crash leaves neither the proposal
 * nor a half snapshot. Each account row is written once (primary key).
 */
export async function sealSnapshot(
  tx: Sql,
  input: { proposalId: string; takenAt: Date; byUser: ReadonlyMap<string, Amount> },
): Promise<{ count: number; total: Amount; hash: string }> {
  const rows = [...input.byUser.entries()].filter(([, power]) => power > 0n).map(([userId, power]) => ({ userId, power }));
  if (rows.length > 0) {
    // Few statements on the creation transaction; each chunk stays under Postgres's 65535 bind parameters (4 per row).
    for (let start = 0; start < rows.length; start += SNAPSHOT_INSERT_CHUNK) {
      const values = rows.slice(start, start + SNAPSHOT_INSERT_CHUNK).map((row) => ({
        proposal_id: input.proposalId,
        user_id: row.userId,
        power: formatAmount(row.power),
        taken_at: input.takenAt,
      }));
      await tx`
        INSERT INTO token.governance_snapshots ${tx(values, 'proposal_id', 'user_id', 'power', 'taken_at')}
      `;
    }
  }
  const total = rows.reduce((sum, row) => sum + row.power, 0n);
  const hash = snapshotHash(rows);
  await tx`
    UPDATE token.proposals
       SET snapshot_count = ${rows.length},
           snapshot_total = ${formatAmount(total)}::numeric,
           snapshot_hash = ${hash}
     WHERE id = ${input.proposalId}
  `;
  return { count: rows.length, total, hash };
}

export interface SnapshotSeal {
  count: number;
  total: Amount;
  hash: string;
}

export function sealFromRow(row: {
  snapshot_count: number | null;
  snapshot_total: string | null;
  snapshot_hash: string | null;
}): SnapshotSeal | null {
  if (row.snapshot_count == null || row.snapshot_total == null || row.snapshot_hash == null) return null;
  return { count: row.snapshot_count, total: parseAmount(row.snapshot_total), hash: row.snapshot_hash };
}

/**
 * Reads a proposal's stored snapshot and checks it against its seal. A count,
 * total or hash that disagrees refuses `token.governance_snapshot_missing`:
 * a ballot is never weighed against rows that are not the sealed ones.
 */
export async function readSealedSnapshot(tx: Sql, proposalId: string, seal: SnapshotSeal): Promise<Map<string, Amount>> {
  const rows = await tx<Array<{ user_id: string; power: string }>>`
    SELECT user_id, power::text AS power
      FROM token.governance_snapshots
     WHERE proposal_id = ${proposalId}
  `;
  const parsed = rows.map((row) => ({ userId: row.user_id, power: parseAmount(row.power) }));
  const total = parsed.reduce((sum, row) => sum + row.power, 0n);
  if (parsed.length !== seal.count || total !== seal.total || snapshotHash(parsed) !== seal.hash) {
    throw new TokenError('The stored voting power does not match its seal', 'token.governance_snapshot_missing');
  }
  return new Map(parsed.map((row) => [row.userId, row.power]));
}

export type PowerReason = 'no_stake_at_creation' | 'not_measured';

export interface ProposalPower {
  proposalId: string;
  /** Voting power fixed when the proposal was created. Zero with a reason when there is none. */
  power: Amount;
  reason: PowerReason | null;
  takenAt: Date | null;
}

/** The signed account's power on one proposal. `not_measured`: a proposal from before snapshots. */
export async function readProposalPower(sql: Sql, proposalId: string, userId: string): Promise<ProposalPower> {
  const proposals = await sql<Array<{ snapshot_count: number | null; snapshot_total: string | null; snapshot_hash: string | null }>>`
    SELECT snapshot_count, snapshot_total::text AS snapshot_total, snapshot_hash
      FROM token.proposals
     WHERE id = ${proposalId}
  `;
  const proposal = proposals[0];
  if (!proposal) throw new TokenError(`Proposal ${proposalId} not found`, 'token.proposal_not_found');
  if (!sealFromRow(proposal)) return { proposalId, power: 0n, reason: 'not_measured', takenAt: null };
  const rows = await sql<Array<{ power: string; taken_at: Date }>>`
    SELECT power::text AS power, taken_at
      FROM token.governance_snapshots
     WHERE proposal_id = ${proposalId} AND user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) return { proposalId, power: 0n, reason: 'no_stake_at_creation', takenAt: null };
  return { proposalId, power: parseAmount(row.power), reason: null, takenAt: row.taken_at };
}

export interface PowerHistoryEntry {
  proposalId: string;
  title: string | null;
  takenAt: Date;
  power: Amount;
}

/** Stored snapshots of the signed account, newest first. Never a live read and never an invented row. */
export async function readPowerHistory(sql: Sql, userId: string, limit: number | undefined): Promise<PowerHistoryEntry[]> {
  if (limit === undefined) throw new TokenError('A page size is required', 'token.history_list_limit_unset');
  const rows = await sql<Array<{ proposal_id: string; title: string | null; taken_at: Date; power: string }>>`
    SELECT s.proposal_id, p.title, s.taken_at, s.power::text AS power
      FROM token.governance_snapshots s
      JOIN token.proposals p ON p.id = s.proposal_id
     WHERE s.user_id = ${userId}
     ORDER BY s.taken_at DESC, s.proposal_id DESC
     LIMIT ${limit}
  `;
  return rows.map((row) => ({ proposalId: row.proposal_id, title: row.title, takenAt: row.taken_at, power: parseAmount(row.power) }));
}
