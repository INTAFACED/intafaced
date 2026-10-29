import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { assertVotingType, type VotingType } from './ballot-tally.js';
import { sealFromRow, sealSnapshot } from './governance-vote.js';
import { TokenError, type ProposalKind, type ProposalRecord, type ProposalStatus } from './token-service.js';

/** The only governance space. Further spaces are not this slice. */
export const GOVERNANCE_SPACE_ID = 'ifc';

const HANDLE_MAX = 200;

export type ProposerKind = 'stake' | 'authors' | 'listed';

export type ProposalAccessCode =
  'token.proposer_rule_unset' | 'token.proposal_limit_unset' | 'token.proposal_not_allowed' | 'token.proposal_limit_reached';

export interface ProposerGate {
  readonly kind: ProposerKind;
  readonly minStake: Amount | null;
  readonly accounts: readonly string[] | null;
  readonly periodLimit: number;
  readonly periodMs: bigint;
}

export interface ProposalAccess {
  readonly code: ProposalAccessCode | null;
  readonly minStake: string | null;
}

interface GateRow {
  kind: string | null;
  min_stake: string | null;
  accounts: unknown;
  period_limit: number | string | null;
  period_ms: string | null;
}

interface ProposalSqlRow {
  id: string;
  kind: ProposalKind;
  body: Record<string, unknown> | null;
  status: ProposalStatus;
  opens_at: Date;
  closes_at: Date;
  created_at: Date;
  title?: string | null;
  body_md?: string | null;
  discussion_link?: string | null;
  business_key?: string | null;
  author_id?: string | null;
  revision?: number | string | null;
  votes?: number | string | null;
  for_n?: number | string | null;
  against_n?: number | string | null;
  abstain_n?: number | string | null;
  voting_type?: string | null;
  choices?: unknown;
  snapshot_count?: number | null;
  snapshot_total?: string | null;
  snapshot_hash?: string | null;
  ranking?: unknown;
}

const PROPOSAL_RETURNING = `
  id, kind, body, status, opens_at, closes_at, created_at,
  title, body_md, discussion_link, business_key, author_id, revision,
  voting_type, choices, snapshot_count, snapshot_total::text AS snapshot_total, snapshot_hash, ranking
`;

function accessError(code: ProposalAccessCode): TokenError {
  if (code === 'token.proposer_rule_unset') return new TokenError('Who may open a proposal is not set', code);
  if (code === 'token.proposal_limit_unset') return new TokenError('The proposal limit is not set', code);
  if (code === 'token.proposal_limit_reached') return new TokenError('The proposal limit for this period is reached', code);
  return new TokenError('You do not have access to this', code);
}

function invalid(message: string): TokenError {
  return new TokenError(message, 'token.params_invalid');
}

function asNonNegativeInt(value: number | string | null | undefined, label: string): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${label} is not a whole number`);
    return value;
  }
  if (!/^\d+$/.test(value)) throw invalid(`${label} is not a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalid(`${label} is not a whole number`);
  return parsed;
}

function asNonNegativeBig(value: string | null | undefined, label: string): bigint | null {
  if (value == null || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) throw invalid(`${label} is not a whole number`);
  return BigInt(value.trim());
}

function accountList(raw: unknown, label: string): readonly string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw invalid(`${label} is not a list of accounts`);
  }
  return raw.map((item) => item.trim());
}

function gateFromParts(input: {
  kind: string | null;
  minStake: Amount | null;
  accounts: readonly string[] | null;
  periodLimit: number | null;
  periodMs: bigint | null;
}): { ok: true; gate: ProposerGate } | { ok: false; code: 'token.proposer_rule_unset' | 'token.proposal_limit_unset' } {
  if (input.kind == null) return { ok: false, code: 'token.proposer_rule_unset' };
  if (input.kind !== 'stake' && input.kind !== 'authors' && input.kind !== 'listed') {
    throw invalid('Proposer rule kind is not valid');
  }
  if (input.kind === 'stake' && input.minStake == null) return { ok: false, code: 'token.proposer_rule_unset' };
  if (input.kind !== 'stake' && input.accounts == null) return { ok: false, code: 'token.proposer_rule_unset' };
  if (input.periodLimit == null || input.periodMs == null) return { ok: false, code: 'token.proposal_limit_unset' };
  if (input.minStake != null && input.minStake < 0n) throw invalid('Proposer minimum stake is negative');
  return {
    ok: true,
    gate: {
      kind: input.kind,
      minStake: input.kind === 'stake' ? input.minStake : null,
      accounts: input.kind === 'stake' ? null : input.accounts,
      periodLimit: input.periodLimit,
      periodMs: input.periodMs,
    },
  };
}

/** Env is used only when the stored row has not been published. Blank is unset. */
export function proposerGateFromEnv(env: {
  TOKEN_PROPOSER_RULE?: string;
  TOKEN_PROPOSAL_LIMIT?: string;
}): { ok: true; gate: ProposerGate } | { ok: false; code: 'token.proposer_rule_unset' | 'token.proposal_limit_unset' } {
  const rule = env.TOKEN_PROPOSER_RULE?.trim() ?? '';
  const limit = env.TOKEN_PROPOSAL_LIMIT?.trim() ?? '';
  if (rule === '') return { ok: false, code: 'token.proposer_rule_unset' };

  let kind: string | null = null;
  let minStake: Amount | null = null;
  let accounts: readonly string[] | null = null;
  const colon = rule.indexOf(':');
  const head = colon === -1 ? rule : rule.slice(0, colon);
  const tail = colon === -1 ? '' : rule.slice(colon + 1).trim();
  if (head === 'stake') {
    if (tail === '') return { ok: false, code: 'token.proposer_rule_unset' };
    try {
      minStake = parseAmount(tail);
    } catch {
      throw invalid('Proposer minimum stake is not a decimal string');
    }
    kind = 'stake';
  } else if (head === 'authors' || head === 'listed') {
    if (tail === '') return { ok: false, code: 'token.proposer_rule_unset' };
    accounts = tail.split(',').map((item) => item.trim());
    if (accounts.some((item) => item === '')) throw invalid('Proposer account list is not valid');
    kind = head;
  } else {
    throw invalid('Proposer rule kind is not valid');
  }

  if (limit === '') return { ok: false, code: 'token.proposal_limit_unset' };
  const parts = limit.split(':');
  if (parts.length !== 2) throw invalid('Proposal limit is not valid');
  const periodLimit = asNonNegativeInt(parts[0]?.trim(), 'Proposal limit');
  const periodMs = asNonNegativeBig(parts[1]?.trim(), 'Proposal period');
  if (periodLimit == null || periodMs == null) return { ok: false, code: 'token.proposal_limit_unset' };
  return gateFromParts({ kind, minStake, accounts, periodLimit, periodMs });
}

function rowStarted(row: GateRow): boolean {
  return row.kind != null || row.min_stake != null || row.accounts != null || row.period_limit != null || row.period_ms != null;
}

function gateFromRow(
  row: GateRow,
): { ok: true; gate: ProposerGate } | { ok: false; code: 'token.proposer_rule_unset' | 'token.proposal_limit_unset' } {
  let minStake: Amount | null = null;
  if (row.min_stake != null && row.min_stake.trim() !== '') {
    try {
      minStake = parseAmount(row.min_stake.trim());
    } catch {
      throw invalid('Proposer minimum stake is not a decimal string');
    }
  }
  return gateFromParts({
    kind: row.kind,
    minStake,
    accounts: accountList(row.accounts, 'Proposer accounts'),
    periodLimit: asNonNegativeInt(row.period_limit, 'Proposal limit'),
    periodMs: asNonNegativeBig(row.period_ms, 'Proposal period'),
  });
}

async function loadGate(
  sql: Sql,
): Promise<{ ok: true; gate: ProposerGate } | { ok: false; code: 'token.proposer_rule_unset' | 'token.proposal_limit_unset' }> {
  const rows = await sql<GateRow[]>`
    SELECT kind, min_stake::text AS min_stake, accounts, period_limit, period_ms::text AS period_ms
      FROM token.governance_proposer
     WHERE id = true
  `;
  const row = rows[0];
  if (row && rowStarted(row)) return gateFromRow(row);
  return proposerGateFromEnv(process.env);
}

export function decideProposer(
  gate: ProposerGate,
  input: { userId: string; staked: Amount; asAdmin: boolean; existing: number },
): ProposalAccess {
  const minStake = gate.kind === 'stake' && gate.minStake != null ? formatAmount(gate.minStake) : null;
  if (!input.asAdmin) {
    if (gate.kind === 'stake') {
      if (gate.minStake == null || input.staked < gate.minStake) {
        return { code: 'token.proposal_not_allowed', minStake };
      }
    } else if (!(gate.accounts ?? []).includes(input.userId)) {
      return { code: 'token.proposal_not_allowed', minStake: null };
    }
  }
  if (input.existing >= gate.periodLimit) return { code: 'token.proposal_limit_reached', minStake };
  return { code: null, minStake };
}

async function countRecent(sql: Sql, authorId: string, now: Date, periodMs: bigint): Promise<number> {
  const rows = await sql<Array<{ n: string }>>`
    SELECT COUNT(*)::text AS n
      FROM token.proposals
     WHERE author_id = ${authorId}
       AND space_id = ${GOVERNANCE_SPACE_ID}
       AND created_at >= ${now}::timestamptz - (interval '1 millisecond' * ${periodMs.toString()}::bigint)
  `;
  const n = asNonNegativeInt(rows[0]?.n, 'Proposal count');
  if (n == null) throw invalid('Proposal count is missing');
  return n;
}

export async function assessProposalAccess(
  sql: Sql,
  input: { userId: string; asAdmin: boolean; staked: Amount; now: Date },
): Promise<ProposalAccess> {
  const loaded = await loadGate(sql);
  if (!loaded.ok) return { code: loaded.code, minStake: null };
  const existing = await countRecent(sql, input.userId, input.now, loaded.gate.periodMs);
  return decideProposer(loaded.gate, { ...input, existing });
}

function asCount(value: number | string | null | undefined): number {
  const n = asNonNegativeInt(value ?? 0, 'Vote count');
  if (n == null) throw invalid('Vote count is missing');
  return n;
}

function storedChoices(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) throw invalid('Stored choices are not readable');
  return raw as string[];
}

function storedRanking(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw) || !raw.every((item) => Number.isInteger(item))) throw invalid('Stored ranking is not readable');
  return raw as number[];
}

export function proposalCard(row: ProposalSqlRow): ProposalRecord {
  const revision = asNonNegativeInt(row.revision ?? 1, 'Proposal revision');
  if (revision == null) throw invalid('Proposal revision is missing');
  return {
    id: row.id,
    kind: row.kind,
    body: (row.body ?? {}) as Record<string, unknown>,
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    createdAt: row.created_at,
    title: row.title ?? null,
    bodyMd: row.body_md ?? null,
    discussionLink: row.discussion_link ?? null,
    businessKey: row.business_key ?? null,
    authorId: row.author_id ?? null,
    revision,
    votingType: assertVotingType(row.voting_type ?? 'basic'),
    choices: storedChoices(row.choices),
    snapshot: sealFromRow({
      snapshot_count: row.snapshot_count ?? null,
      snapshot_total: row.snapshot_total ?? null,
      snapshot_hash: row.snapshot_hash ?? null,
    }),
    ranking: storedRanking(row.ranking),
    counts: {
      votes: asCount(row.votes),
      for: asCount(row.for_n),
      against: asCount(row.against_n),
      abstain: asCount(row.abstain_n),
    },
  };
}

const COUNTS_JOIN = `
  LEFT JOIN (
    SELECT proposal_id,
           COUNT(*)::int AS votes,
           COUNT(*) FILTER (WHERE choice = 'for')::int AS for_n,
           COUNT(*) FILTER (WHERE choice = 'against')::int AS against_n,
           COUNT(*) FILTER (WHERE choice = 'abstain' OR ballot->>'kind' = 'abstain')::int AS abstain_n
      FROM token.governance_votes
     GROUP BY proposal_id
  ) c ON c.proposal_id = p.id
`;

export function proposalSearchPattern(q: string | undefined): string | null {
  if (q === undefined) return null;
  const trimmed = q.trim();
  if (trimmed === '') return null;
  return `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function normalizeProposalTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  const trimmed = title.trim();
  if (trimmed === '') throw new TokenError('Proposal title is empty', 'token.proposal_title_invalid');
  return trimmed;
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requestHandle(handle: string | undefined): string {
  if (handle === undefined) {
    throw new TokenError('That proposal request is not valid', 'token.proposal_handle_invalid');
  }
  const trimmed = handle.trim();
  if (trimmed === '' || trimmed.length > HANDLE_MAX || /[\u0000-\u001f]/.test(trimmed)) {
    throw new TokenError('That proposal request is not valid', 'token.proposal_handle_invalid');
  }
  return trimmed;
}

export async function listGovernanceProposals(
  sql: Sql,
  input: { status?: ProposalStatus; kind?: ProposalKind; q?: string; limit: number },
): Promise<ProposalRecord[]> {
  const pattern = proposalSearchPattern(input.q);
  const rows = await sql<ProposalSqlRow[]>`
    SELECT p.id, p.kind, p.body, p.status, p.opens_at, p.closes_at, p.created_at,
           p.title, p.body_md, p.discussion_link, p.business_key, p.author_id, p.revision,
           p.voting_type, p.choices, p.snapshot_count, p.snapshot_total::text AS snapshot_total, p.snapshot_hash, p.ranking,
           COALESCE(c.votes, 0) AS votes,
           COALESCE(c.for_n, 0) AS for_n,
           COALESCE(c.against_n, 0) AS against_n,
           COALESCE(c.abstain_n, 0) AS abstain_n
      FROM token.proposals p
      ${sql.unsafe(COUNTS_JOIN)}
     WHERE (${input.status ?? null}::text IS NULL OR p.status = ${input.status ?? null})
       AND (${input.kind ?? null}::text IS NULL OR p.kind = ${input.kind ?? null})
       AND (
         ${pattern}::text IS NULL
         OR p.title ILIKE ${pattern} ESCAPE '\\'
         OR p.body_md ILIKE ${pattern} ESCAPE '\\'
         OR COALESCE(p.body->>'title', '') ILIKE ${pattern} ESCAPE '\\'
       )
     ORDER BY p.created_at DESC
     LIMIT ${input.limit}
  `;
  return rows.map(proposalCard);
}

export async function loadProposalRow(sql: Sql, proposalId: string): Promise<ProposalRecord | null> {
  const rows = await sql<ProposalSqlRow[]>`
    SELECT p.id, p.kind, p.body, p.status, p.opens_at, p.closes_at, p.created_at,
           p.title, p.body_md, p.discussion_link, p.business_key, p.author_id, p.revision,
           p.voting_type, p.choices, p.snapshot_count, p.snapshot_total::text AS snapshot_total, p.snapshot_hash, p.ranking,
           COALESCE(c.votes, 0) AS votes,
           COALESCE(c.for_n, 0) AS for_n,
           COALESCE(c.against_n, 0) AS against_n,
           COALESCE(c.abstain_n, 0) AS abstain_n
      FROM token.proposals p
      ${sql.unsafe(COUNTS_JOIN)}
     WHERE p.id = ${proposalId}
  `;
  const row = rows[0];
  return row ? proposalCard(row) : null;
}

export async function readGovernanceSpace(sql: Sql, accountId: string): Promise<{ spaceId: string; following: boolean }> {
  const rows = await sql<Array<{ id: string; following: boolean | null }>>`
    SELECT s.id, f.following
      FROM token.governance_spaces s
      LEFT JOIN token.governance_follows f
        ON f.space_id = s.id AND f.account_id = ${accountId}
     WHERE s.id = ${GOVERNANCE_SPACE_ID}
  `;
  const row = rows[0];
  if (!row) throw new TokenError('Governance space is not installed', 'token.params_missing');
  return { spaceId: row.id, following: row.following === true };
}

export async function setGovernanceFollow(
  sql: Sql,
  accountId: string,
  following: boolean,
): Promise<{ spaceId: string; following: boolean }> {
  await readGovernanceSpace(sql, accountId);
  const written = await sql<Array<{ following: boolean }>>`
    INSERT INTO token.governance_follows (space_id, account_id, following)
    VALUES (${GOVERNANCE_SPACE_ID}, ${accountId}, ${following})
    ON CONFLICT (space_id, account_id) DO UPDATE
      SET following = EXCLUDED.following,
          updated_at = clock_timestamp()
      WHERE token.governance_follows.following IS DISTINCT FROM EXCLUDED.following
    RETURNING following
  `;
  if (written[0]) return { spaceId: GOVERNANCE_SPACE_ID, following: written[0].following };
  const current = await sql<Array<{ following: boolean }>>`
    SELECT following
      FROM token.governance_follows
     WHERE space_id = ${GOVERNANCE_SPACE_ID} AND account_id = ${accountId}
  `;
  return { spaceId: GOVERNANCE_SPACE_ID, following: current[0]?.following === true };
}

export async function openDueDrafts(sql: Sql, now: Date): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE token.proposals
       SET status = 'open'
     WHERE status = 'draft'
       AND opens_at <= ${now}
       AND closes_at > ${now}
    RETURNING id
  `;
  return rows.length;
}

function sameBody(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function editGovernanceDraft(
  sql: Sql,
  input: {
    proposalId: string;
    authorId: string;
    title?: string;
    bodyMd?: string;
    discussionLink?: string;
    body?: Record<string, unknown>;
    opensAt?: Date;
    closesAt?: Date;
  },
): Promise<ProposalRecord> {
  const title = input.title === undefined ? undefined : normalizeProposalTitle(input.title);
  const bodyMd = input.bodyMd === undefined ? undefined : optionalText(input.bodyMd);
  const discussionLink = input.discussionLink === undefined ? undefined : optionalText(input.discussionLink);

  return transaction(
    sql,
    async (tx) => {
      const rows = await tx<ProposalSqlRow[]>`
        SELECT ${tx.unsafe(PROPOSAL_RETURNING)}
          FROM token.proposals
         WHERE id = ${input.proposalId}
         FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
      if (row.author_id !== input.authorId) throw new TokenError('You do not have access to this', 'token.proposal_not_allowed');
      if (row.status !== 'draft') throw new TokenError('That proposal can no longer be edited', 'token.proposal_not_editable');

      const nextTitle = title === undefined ? (row.title ?? null) : title;
      const nextMd = bodyMd === undefined ? (row.body_md ?? null) : bodyMd;
      const nextLink = discussionLink === undefined ? (row.discussion_link ?? null) : discussionLink;
      const nextBody = input.body ?? ((row.body ?? {}) as Record<string, unknown>);
      const opensAt = input.opensAt ?? row.opens_at;
      const closesAt = input.closesAt ?? row.closes_at;
      if (!(closesAt.getTime() > opensAt.getTime())) {
        throw new TokenError('Proposal window must close after it opens', 'token.proposal_window');
      }
      const unchanged =
        nextTitle === (row.title ?? null) &&
        nextMd === (row.body_md ?? null) &&
        nextLink === (row.discussion_link ?? null) &&
        sameBody(nextBody, (row.body ?? {}) as Record<string, unknown>) &&
        opensAt.getTime() === row.opens_at.getTime() &&
        closesAt.getTime() === row.closes_at.getTime();
      if (unchanged) {
        const loaded = await loadProposalRow(tx, row.id);
        if (!loaded) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
        return loaded;
      }

      const updated = await tx<ProposalSqlRow[]>`
        UPDATE token.proposals
           SET title = ${nextTitle},
               body_md = ${nextMd},
               discussion_link = ${nextLink},
               body = ${tx.json(nextBody as never)},
               opens_at = ${opensAt},
               closes_at = ${closesAt},
               revision = revision + 1
         WHERE id = ${row.id}
        RETURNING ${tx.unsafe(PROPOSAL_RETURNING)}
      `;
      const saved = updated[0];
      if (!saved) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
      const loaded = await loadProposalRow(tx, saved.id);
      if (!loaded) throw new TokenError(`Proposal ${input.proposalId} not found`, 'token.proposal_not_found');
      return loaded;
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}

export async function insertGovernanceProposal(
  sql: Sql,
  input: {
    kind: ProposalKind;
    body: Record<string, unknown>;
    authorId: string;
    asAdmin: boolean;
    opensAt: Date;
    closesAt: Date;
    now: Date;
    handle?: string;
    title?: string;
    bodyMd?: string;
    discussionLink?: string;
    /**
     * Author's active stake, read on this transaction after the author lock.
     * `unstake` locks the same `token.stakes` rows. A total from before the
     * lock is not this figure.
     */
    lockedStake: (tx: Sql) => Promise<Amount>;
    /** `basic` unless the author picks another type (MC-token-03). */
    votingType: VotingType;
    /** Normalised choice list; null on `basic`. */
    choices: string[] | null;
    /**
     * Every account's active stake, locked and checked against its ledger pot
     * on this transaction. Stored as the proposal's voting power.
     */
    snapshot: (tx: Sql) => Promise<ReadonlyMap<string, Amount>>;
  },
): Promise<ProposalRecord> {
  const title = normalizeProposalTitle(input.title);
  const bodyMd = optionalText(input.bodyMd);
  const discussionLink = optionalText(input.discussionLink);
  const handle = requestHandle(input.handle);

  return transaction(
    sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`gov:proposal:${GOVERNANCE_SPACE_ID}:${input.authorId}`}))`;

      const existing = await tx<ProposalSqlRow[]>`
        SELECT ${tx.unsafe(PROPOSAL_RETURNING)}
          FROM token.proposals
         WHERE space_id = ${GOVERNANCE_SPACE_ID}
           AND author_id = ${input.authorId}
           AND request_handle = ${handle}
         LIMIT 1
      `;
      if (existing[0]) {
        const loaded = await loadProposalRow(tx, existing[0].id);
        if (!loaded) throw new TokenError('Proposal could not be reloaded', 'token.proposal_not_found');
        return loaded;
      }

      const loaded = await loadGate(tx);
      if (!loaded.ok) throw accessError(loaded.code);
      const existingCount = await countRecent(tx, input.authorId, input.now, loaded.gate.periodMs);
      const staked = input.asAdmin || loaded.gate.kind !== 'stake' ? 0n : await input.lockedStake(tx);
      const access = decideProposer(loaded.gate, {
        userId: input.authorId,
        staked,
        asAdmin: input.asAdmin,
        existing: existingCount,
      });
      if (access.code) throw accessError(access.code);

      const ordinalRows = await tx<Array<{ n: string | null }>>`
        SELECT (COALESCE(MAX(ordinal), 0) + 1)::text AS n
          FROM token.proposals
         WHERE space_id = ${GOVERNANCE_SPACE_ID} AND author_id = ${input.authorId}
      `;
      const ordinal = asNonNegativeInt(ordinalRows[0]?.n, 'Proposal ordinal');
      if (ordinal == null || ordinal < 1) throw invalid('Proposal ordinal is missing');
      const id = `gov:proposal:${GOVERNANCE_SPACE_ID}:${input.authorId}:${ordinal}`;
      const status: ProposalStatus =
        input.opensAt.getTime() <= input.now.getTime() && input.closesAt.getTime() > input.now.getTime() ? 'open' : 'draft';

      const inserted = await tx<ProposalSqlRow[]>`
        INSERT INTO token.proposals (
          id, kind, body, status, opens_at, closes_at,
          author_id, title, body_md, discussion_link, business_key, request_handle, revision, ordinal, space_id,
          voting_type, choices
        )
        VALUES (
          ${id}, ${input.kind}, ${tx.json(input.body as never)}, ${status}, ${input.opensAt}, ${input.closesAt},
          ${input.authorId}, ${title}, ${bodyMd}, ${discussionLink}, ${id}, ${handle}, 1, ${ordinal}, ${GOVERNANCE_SPACE_ID},
          ${input.votingType}, ${input.choices === null ? null : tx.json(input.choices as never)}
        )
        RETURNING ${tx.unsafe(PROPOSAL_RETURNING)}
      `;
      const saved = inserted[0];
      if (!saved) throw new TokenError('Proposal could not be stored', 'token.proposal_not_found');
      // Voting power is fixed here, in the same transaction as the proposal:
      // a crash leaves neither, and stake moved later cannot change it.
      await sealSnapshot(tx, { proposalId: saved.id, takenAt: input.now, byUser: await input.snapshot(tx) });
      const card = await loadProposalRow(tx, saved.id);
      if (!card) throw new TokenError('Proposal could not be reloaded', 'token.proposal_not_found');
      return card;
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}
