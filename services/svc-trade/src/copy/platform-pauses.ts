/**
 * The copy and bots kill switch by lead, bot type or symbol (CB-ops-03, J-copy-bots-otc-12).
 *
 * Two founders change a scope. The first files identity's action approval (`trade.copy_bots_pause` or
 * `trade.copy_bots_resume`), bound to the request, the operation and the scope, and records it here (`propose`); the
 * request waits. A second founder approves it there and confirms here (`confirm`), which consumes it once, applies the
 * change and writes one operator audit row. There is no one-founder door.
 *
 * While a scope is paused: a lead's next copy mirror is refused, a paused bot type refuses a new bot of that type, and
 * a halted symbol refuses copy mirrors and stops bot orders on it. A pause places, cancels and closes nothing: running
 * bots outside a halted symbol keep running and every open position stays as it is. Resuming closes the pause row.
 *
 * Nothing here holds or moves money.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  TradeOpsError,
  consumeApproval,
  payloadHash,
  requireOperator,
  requireOperatorWrite,
  writeOperatorAudit,
  type ApprovalBook,
} from '../admin/common.js';

export const COPY_BOTS_PAUSE_ACTION = 'trade.copy_bots_pause' as const;
export const COPY_BOTS_RESUME_ACTION = 'trade.copy_bots_resume' as const;

/** The bot types a founder may pause: the grid bot and each algo bot kind. */
export const PAUSABLE_BOT_TYPES = ['grid', 'twap', 'vwap', 'pov', 'chase'] as const;
export type PausableBotType = (typeof PAUSABLE_BOT_TYPES)[number];

export type PauseScopeKind = 'lead' | 'bot_type' | 'symbol';
export type PauseOp = 'pause' | 'resume';

/** The codes a refusal by a platform pause carries: one for copy mirrors, one for bots. */
export const COPY_PAUSED_BY_PLATFORM = 'trade.copy_paused_by_platform' as const;
export const BOTS_PAUSED_BY_PLATFORM = 'trade.bots_paused_by_platform' as const;

export interface PauseScopeInput {
  readonly kind: PauseScopeKind;
  readonly value: string;
}

export interface PauseRequestView {
  readonly id: string;
  readonly op: PauseOp;
  readonly scope: { readonly kind: PauseScopeKind; readonly value: string };
  readonly status: 'awaiting_second' | 'applied';
  readonly approvalId: string;
  readonly proposedBy: string;
  readonly approverId: string | null;
  readonly confirmedBy: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export interface PauseView {
  readonly id: string;
  readonly scope: { readonly kind: PauseScopeKind; readonly value: string };
  readonly pausedBy: string;
  readonly pauseApprover: string;
  readonly pausedAt: string;
}

/** What a customer may read: the scopes paused now, by kind. A lead is named by its public listing ref. */
export interface PublicPauses {
  readonly leads: readonly string[];
  readonly botTypes: readonly string[];
  readonly symbols: readonly string[];
}

/** The active pauses as the gates read them, once per operation or tick pass. */
export interface PauseSnapshot {
  readonly leaderUserIds: ReadonlySet<string>;
  readonly botTypes: ReadonlySet<string>;
  /** Paused symbols and the market ids they resolved to. */
  readonly symbols: ReadonlySet<string>;
  readonly marketIds: ReadonlySet<string>;
  /** The symbol each halted market id resolved from, so a refusal names the symbol. */
  readonly symbolOfMarket: ReadonlyMap<string, string>;
}

export const NO_PAUSES: PauseSnapshot = {
  leaderUserIds: new Set(),
  botTypes: new Set(),
  symbols: new Set(),
  marketIds: new Set(),
  symbolOfMarket: new Map(),
};

export interface PlatformPauseDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly now: () => Date;
  /** A lead's account by its listing ref, or null when no such lead exists. */
  readonly leaderUserIdByRef: (leaderRef: string) => Promise<string | null>;
  /** A market's id by its symbol, or null when no such market exists. */
  readonly marketIdBySymbol: (symbol: string) => Promise<string | null>;
}

interface RequestRow {
  id: string;
  op: PauseOp;
  scope_kind: PauseScopeKind;
  scope_value: string;
  scope_ref: string | null;
  status: 'awaiting_second' | 'applied';
  approval_id: string;
  proposed_by: string;
  approver_id: string | null;
  confirmed_by: string | null;
  created_at: Date;
  decided_at: Date | null;
}

interface PauseRow {
  id: string;
  scope_kind: PauseScopeKind;
  scope_value: string;
  scope_ref: string | null;
  paused_by: string;
  pause_approver: string;
  paused_at: Date;
}

const LIST_MAX = 200;
const SYMBOL = /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/;
const LEADER_REF = /^[A-Za-z0-9_-]{1,80}$/;

const sameUser = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A scope as typed, made canonical, or refused by `trade_ops.copy_bots_scope_invalid`. */
export function canonicalScope(input: PauseScopeInput): { kind: PauseScopeKind; value: string } {
  const raw = (input.value ?? '').trim();
  if (input.kind === 'lead') {
    if (!LEADER_REF.test(raw)) throw new TradeOpsError('copy_bots_scope_invalid', 'Type the lead’s listing reference.');
    return { kind: 'lead', value: raw };
  }
  if (input.kind === 'bot_type') {
    const value = raw.toLowerCase();
    if (!(PAUSABLE_BOT_TYPES as readonly string[]).includes(value)) {
      throw new TradeOpsError('copy_bots_scope_invalid', `Bot type must be one of ${PAUSABLE_BOT_TYPES.join(', ')}.`);
    }
    return { kind: 'bot_type', value };
  }
  if (input.kind === 'symbol') {
    const value = raw.toUpperCase();
    if (!SYMBOL.test(value)) throw new TradeOpsError('copy_bots_scope_invalid', 'Type a symbol such as ETH/USDT.');
    return { kind: 'symbol', value };
  }
  throw new TradeOpsError('copy_bots_scope_invalid', 'Scope must be a lead, a bot type or a symbol.');
}

/** What an approval binds: the request, the operation and the scope. The console hashes the same canonical form. */
export function pauseApprovalPayload(input: {
  requestId: string;
  op: PauseOp;
  kind: PauseScopeKind;
  value: string;
}): Record<string, unknown> {
  return {
    actionType: input.op === 'pause' ? COPY_BOTS_PAUSE_ACTION : COPY_BOTS_RESUME_ACTION,
    requestId: input.requestId,
    op: input.op,
    scopeKind: input.kind,
    scopeValue: input.value,
  };
}

/** The audit row's object: the scope, as `<kind>:<value>`. */
export const pauseAuditObject = (kind: PauseScopeKind, value: string) => `${kind}:${value}`;

/** An id derived from a business key, so a retried write lands on the same row. */
function idFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function requestView(row: RequestRow): PauseRequestView {
  return {
    id: row.id,
    op: row.op,
    scope: { kind: row.scope_kind, value: row.scope_value },
    status: row.status,
    approvalId: row.approval_id,
    proposedBy: row.proposed_by,
    approverId: row.approver_id,
    confirmedBy: row.confirmed_by,
    requestedAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function pauseView(row: PauseRow): PauseView {
  return {
    id: row.id,
    scope: { kind: row.scope_kind, value: row.scope_value },
    pausedBy: row.paused_by,
    pauseApprover: row.pause_approver,
    pausedAt: row.paused_at.toISOString(),
  };
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export class PlatformPauseDesk {
  constructor(private readonly deps: PlatformPauseDeps) {}

  /** The scopes paused now and the requests waiting for a second founder, oldest first. */
  async desk(principal: Principal): Promise<{ paused: PauseView[]; waiting: PauseRequestView[] }> {
    requireOperator(principal);
    const paused = await this.deps.sql<PauseRow[]>`
      SELECT * FROM trade.copy_bots_pauses WHERE resumed_at IS NULL ORDER BY paused_at ASC, id ASC LIMIT ${LIST_MAX}`;
    const waiting = await this.deps.sql<RequestRow[]>`
      SELECT * FROM trade.copy_bots_pause_requests WHERE status = 'awaiting_second' ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`;
    return { paused: paused.map(pauseView), waiting: waiting.map(requestView) };
  }

  /** One request, for the console to check what an approval is bound to before a second founder approves it. */
  async request(principal: Principal, requestId: string): Promise<PauseRequestView> {
    requireOperator(principal);
    return requestView(await this.requestRow(this.deps.sql, requestId, false));
  }

  /** The scopes paused now, for customers. */
  async publicPauses(): Promise<PublicPauses> {
    const rows = await this.deps.sql<Array<{ scope_kind: PauseScopeKind; scope_value: string }>>`
      SELECT scope_kind, scope_value FROM trade.copy_bots_pauses WHERE resumed_at IS NULL ORDER BY scope_kind, scope_value`;
    const of = (kind: PauseScopeKind) => rows.filter((r) => r.scope_kind === kind).map((r) => r.scope_value);
    return { leads: of('lead'), botTypes: of('bot_type'), symbols: of('symbol') };
  }

  /** Every active pause, as the gates read it. */
  async snapshot(): Promise<PauseSnapshot> {
    const rows = await this.deps.sql<Array<{ scope_kind: PauseScopeKind; scope_value: string; scope_ref: string | null }>>`
      SELECT scope_kind, scope_value, scope_ref FROM trade.copy_bots_pauses WHERE resumed_at IS NULL`;
    const leaderUserIds = new Set<string>();
    const botTypes = new Set<string>();
    const symbols = new Set<string>();
    const marketIds = new Set<string>();
    const symbolOfMarket = new Map<string, string>();
    for (const row of rows) {
      if (row.scope_kind === 'lead' && row.scope_ref) leaderUserIds.add(row.scope_ref);
      if (row.scope_kind === 'bot_type') botTypes.add(row.scope_value);
      if (row.scope_kind === 'symbol') {
        symbols.add(row.scope_value);
        if (row.scope_ref) {
          marketIds.add(row.scope_ref);
          symbolOfMarket.set(row.scope_ref, row.scope_value);
        }
      }
    }
    return { leaderUserIds, botTypes, symbols, marketIds, symbolOfMarket };
  }

  /**
   * The first founder: record the identity approval they filed for this request. The scope must exist (a listed lead, a
   * known market) and be in the state the operation changes: a pause needs it running, a resume needs it paused.
   */
  async propose(
    principal: Principal,
    input: { requestId: string; op: PauseOp; scope: PauseScopeInput; approvalId: string },
  ): Promise<PauseRequestView> {
    requireOperatorWrite(principal);
    if (!isUuid(input.requestId)) throw new TradeOpsError('copy_bots_request_invalid', 'request id must be a uuid');
    const approvalId = input.approvalId.trim();
    if (!approvalId) throw new TradeOpsError('approval_missing', 'approval is missing');
    const scope = canonicalScope(input.scope);
    const ref = await this.resolve(scope);
    const now = this.deps.now();
    return this.deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`copy-bots-pause:${scope.kind}:${scope.value}`}))`;
      const [existing] = await tx<RequestRow[]>`SELECT * FROM trade.copy_bots_pause_requests WHERE id = ${input.requestId}`;
      if (existing) {
        if (
          existing.approval_id === approvalId &&
          existing.op === input.op &&
          existing.scope_kind === scope.kind &&
          existing.scope_value === scope.value
        ) {
          return requestView(existing);
        }
        throw new TradeOpsError('copy_bots_request_conflict', 'This request id was already used for another request.');
      }
      await this.requireState(tx, input.op, scope);
      const [row] = await tx<RequestRow[]>`
        INSERT INTO trade.copy_bots_pause_requests
          (id, op, scope_kind, scope_value, scope_ref, status, approval_id, proposed_by, created_at)
        VALUES (${input.requestId}, ${input.op}, ${scope.kind}, ${scope.value}, ${ref}, 'awaiting_second', ${approvalId},
          ${principal.userId}, ${now.toISOString()})
        RETURNING *`;
      return requestView(row!);
    });
  }

  /**
   * The second founder: consume the approval once (bound to this request, operation and scope; identity refuses the
   * proposer as approver), apply the change and write its audit row, all in one transaction. The founder who filed the
   * request cannot confirm it. The same confirm again answers the applied request.
   */
  async confirm(principal: Principal, input: { requestId: string; operationId: string }): Promise<PauseRequestView> {
    requireOperatorWrite(principal);
    if (!isUuid(input.requestId)) throw new TradeOpsError('copy_bots_request_invalid', 'request id must be a uuid');
    return this.deps.sql.begin(async (tx) => {
      const row = await this.requestRow(tx, input.requestId, true);
      if (row.status === 'applied') {
        if (sameUser(row.confirmed_by, principal.userId)) return requestView(row);
        throw new TradeOpsError('copy_bots_request_decided', 'This request was already confirmed.');
      }
      if (sameUser(row.proposed_by, principal.userId)) {
        throw new TradeOpsError('approval_mismatch', 'The founder who asked cannot confirm. A second founder must.');
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`copy-bots-pause:${row.scope_kind}:${row.scope_value}`}))`;
      const scope = { kind: row.scope_kind, value: row.scope_value };
      await this.requireState(tx, row.op, scope);
      const { approverId } = await consumeApproval(this.deps.approvals, {
        approvalId: row.approval_id,
        actionType: row.op === 'pause' ? COPY_BOTS_PAUSE_ACTION : COPY_BOTS_RESUME_ACTION,
        targetId: row.id,
        expectedVersion: row.op === 'pause' ? 'running' : 'paused',
        payloadHash: payloadHash(pauseApprovalPayload({ requestId: row.id, op: row.op, kind: row.scope_kind, value: row.scope_value })),
        operationId: input.operationId,
      });
      if (sameUser(row.proposed_by, approverId)) {
        throw new TradeOpsError('approval_mismatch', 'The founder who asked also approved it. A second founder must approve.');
      }
      const now = this.deps.now();
      if (row.op === 'pause') {
        await tx`
          INSERT INTO trade.copy_bots_pauses
            (id, scope_kind, scope_value, scope_ref, pause_request_id, paused_by, pause_approver, paused_at)
          VALUES (${idFor(`copy-bots-pause:${row.id}`)}, ${row.scope_kind}, ${row.scope_value}, ${row.scope_ref}, ${row.id},
            ${row.proposed_by}, ${approverId}, ${now.toISOString()})`;
      } else {
        const closed = await tx`
          UPDATE trade.copy_bots_pauses
          SET resume_request_id = ${row.id}, resumed_by = ${row.proposed_by}, resume_approver = ${approverId}, resumed_at = ${now.toISOString()}
          WHERE scope_kind = ${row.scope_kind} AND scope_value = ${row.scope_value} AND resumed_at IS NULL`;
        if (closed.count !== 1) throw new TradeOpsError('copy_bots_scope_not_paused', 'This scope is not paused.');
      }
      const [next] = await tx<RequestRow[]>`
        UPDATE trade.copy_bots_pause_requests
        SET status = 'applied', approver_id = ${approverId}, confirmed_by = ${principal.userId}, decided_at = ${now.toISOString()}
        WHERE id = ${row.id} RETURNING *`;
      await writeOperatorAudit(
        tx as unknown as Sql,
        {
          id: idFor(`copy-bots-${row.op}-audit:${row.id}`),
          kind: `copy_bots.${row.op}`,
          operatorId: row.proposed_by,
          accountId: row.scope_kind === 'lead' ? row.scope_ref : null,
          objectId: pauseAuditObject(row.scope_kind, row.scope_value),
          approverId,
          reason: null,
          detail: { requestId: row.id, confirmedBy: principal.userId, approvalId: row.approval_id },
        },
        now,
      );
      return requestView(next!);
    });
  }

  private async resolve(scope: { kind: PauseScopeKind; value: string }): Promise<string | null> {
    if (scope.kind === 'lead') {
      const id = await this.deps.leaderUserIdByRef(scope.value);
      if (!id) throw new TradeOpsError('copy_bots_lead_not_found', 'No lead has this listing reference.');
      return id;
    }
    if (scope.kind === 'symbol') {
      const id = await this.deps.marketIdBySymbol(scope.value);
      if (!id) throw new TradeOpsError('copy_bots_symbol_not_found', `No market ${scope.value} exists.`);
      return id;
    }
    return null;
  }

  private async requireState(tx: Sql | TransactionSql, op: PauseOp, scope: { kind: PauseScopeKind; value: string }): Promise<void> {
    const [active] = await tx<Array<{ id: string }>>`
      SELECT id FROM trade.copy_bots_pauses WHERE scope_kind = ${scope.kind} AND scope_value = ${scope.value} AND resumed_at IS NULL`;
    if (op === 'pause' && active) throw new TradeOpsError('copy_bots_scope_already_paused', 'This scope is already paused.');
    if (op === 'resume' && !active) throw new TradeOpsError('copy_bots_scope_not_paused', 'This scope is not paused.');
  }

  private async requestRow(tx: Sql | TransactionSql, requestId: string, lock: boolean): Promise<RequestRow> {
    const [row] = lock
      ? await tx<RequestRow[]>`SELECT * FROM trade.copy_bots_pause_requests WHERE id = ${requestId} FOR UPDATE`
      : await tx<RequestRow[]>`SELECT * FROM trade.copy_bots_pause_requests WHERE id = ${requestId}`;
    if (!row) throw new TradeOpsError('copy_bots_request_not_found', 'No such request.');
    return row;
  }
}

/** Why a copy mirror is refused now (its lead or its market is paused by the platform), or null. */
export function mirrorPausedReason(snapshot: PauseSnapshot, leaderUserId: string, marketId: string, symbol?: string | null): string | null {
  if (snapshot.leaderUserIds.has(leaderUserId)) return 'Copying this lead is paused by the platform';
  if (snapshot.marketIds.has(marketId) || (symbol && snapshot.symbols.has(symbol))) {
    return `Copying on ${symbol ?? snapshot.symbolOfMarket.get(marketId) ?? marketId} is paused by the platform`;
  }
  return null;
}

/** Why a new bot is refused now (its type or its market is paused by the platform), or null. */
export function newBotPausedReason(snapshot: PauseSnapshot, botType: string, symbol: string, marketId?: string | null): string | null {
  if (snapshot.botTypes.has(botType)) return `New ${botType} bots are paused by the platform`;
  if (botOrdersHalted(snapshot, symbol, marketId)) return `Bots on ${symbol} are paused by the platform`;
  return null;
}

/** Whether bot orders on this market stop now: its symbol is halted. A paused bot type never stops a running bot. */
export function botOrdersHalted(snapshot: PauseSnapshot, symbol: string, marketId?: string | null): boolean {
  return snapshot.symbols.has(symbol) || (!!marketId && snapshot.marketIds.has(marketId));
}
