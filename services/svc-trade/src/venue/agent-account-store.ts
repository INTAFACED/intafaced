import type { Sql } from 'postgres';
import { add, formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * The agent accounts' own records (J-agents-21; agent-account.ts): `trade.user_venue_agent_accounts` and
 * `trade.user_venue_agent_moves` (drizzle/20261109120000_user_venue_agent_accounts.sql).
 *
 * Nothing here is a balance: the venue is the record of what the sub-account holds. What is kept is the person's cap and
 * the moves they asked for, so the cap can be held to their moves in less their moves out before the wallet is asked to
 * sign another move in. A move is written here, under the account's row lock, before it is prepared, and it counts as
 * moved in until the venue's record says it was refused; so two moves asked at once can't both fit in the same room.
 */

export type AgentAccountStatus = 'opening' | 'open' | 'closed' | 'abandoned';
export type AgentMoveDirection = 'into_sub_account' | 'out_of_sub_account';
export type AgentMoveState = 'pending' | 'done' | 'refused';

export interface AgentAccountRecord {
  readonly userId: string;
  readonly accountId: string;
  readonly venueId: string;
  /** The person's wallet, lowercase: the venue account the sub-account sits under. */
  readonly owner: string;
  /** The venue's id for the sub-account, once the venue opened it. */
  readonly subAccount: string | null;
  /** The sub-account's name on the venue (unique per owner), so an open that was not answered can be read back. */
  readonly name: string;
  readonly asset: string;
  readonly cap: Amount;
  /** The address of the venue agent key INTAFACED holds for this account (agent-key.ts). */
  readonly agentAddress: string;
  /** The first funding the person confirmed with the account; its move id is the account id. */
  readonly fundAmount: Amount;
  readonly status: AgentAccountStatus;
  readonly createdAt: Date;
  readonly openedAt: Date | null;
  readonly closedAt: Date | null;
}

export interface AgentMoveRecord {
  readonly userId: string;
  readonly accountId: string;
  readonly moveId: string;
  readonly direction: AgentMoveDirection;
  readonly amount: Amount;
  readonly state: AgentMoveState;
  readonly createdAt: Date;
}

/** The person's moves in, less their moves out, as the cap counts them: a move in counts until it is refused. */
export function netFunding(moves: readonly AgentMoveRecord[]): { readonly movedIn: Amount; readonly movedOut: Amount } {
  let movedIn = ZERO;
  let movedOut = ZERO;
  for (const m of moves) {
    if (m.direction === 'into_sub_account' && m.state !== 'refused') movedIn = add(movedIn, m.amount);
    if (m.direction === 'out_of_sub_account' && m.state === 'done') movedOut = add(movedOut, m.amount);
  }
  return { movedIn, movedOut };
}

export type AccountPatch = Partial<Pick<AgentAccountRecord, 'subAccount' | 'status' | 'openedAt' | 'closedAt' | 'cap'>>;

export interface AgentAccountStore {
  find(userId: string, accountId: string): Promise<AgentAccountRecord | null>;
  list(userId: string): Promise<readonly AgentAccountRecord[]>;
  /** Store the account and its first move (move id = account id) unless the account is there; returns what is stored. */
  insertOnce(account: AgentAccountRecord, firstMove: AgentMoveRecord): Promise<AgentAccountRecord>;
  update(userId: string, accountId: string, patch: AccountPatch): Promise<AgentAccountRecord>;
  moves(userId: string, accountId: string): Promise<readonly AgentMoveRecord[]>;
  /**
   * Under the account's row lock: return the move if its id is stored, else run `check` on the account and its moves
   * (it throws to refuse) and store the move. The lock is held from the read to the write, so the room `check` judged is
   * the room the move takes.
   */
  reserveMove(
    move: AgentMoveRecord,
    check: (account: AgentAccountRecord, moves: readonly AgentMoveRecord[]) => void,
  ): Promise<{ readonly move: AgentMoveRecord; readonly created: boolean }>;
  /** A pending move becomes done or refused, once; a settled move never changes. */
  settleMove(userId: string, moveId: string, state: 'done' | 'refused'): Promise<void>;
}

export class InMemoryAgentAccountStore implements AgentAccountStore {
  private readonly accounts = new Map<string, AgentAccountRecord>();
  private readonly moveRows = new Map<string, AgentMoveRecord>();
  private lock: Promise<unknown> = Promise.resolve();

  private id(userId: string, key: string) {
    return `${userId}\u0000${key}`;
  }

  async find(userId: string, accountId: string) {
    return this.accounts.get(this.id(userId, accountId)) ?? null;
  }

  async list(userId: string) {
    return [...this.accounts.values()].filter((a) => a.userId === userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async insertOnce(account: AgentAccountRecord, firstMove: AgentMoveRecord) {
    const id = this.id(account.userId, account.accountId);
    const existing = this.accounts.get(id);
    if (existing) return existing;
    this.accounts.set(id, account);
    this.moveRows.set(this.id(firstMove.userId, firstMove.moveId), firstMove);
    return account;
  }

  async update(userId: string, accountId: string, patch: AccountPatch) {
    const id = this.id(userId, accountId);
    const row = this.accounts.get(id);
    if (!row) throw new Error(`no agent account ${accountId}`);
    const next = { ...row, ...patch };
    this.accounts.set(id, next);
    return next;
  }

  async moves(userId: string, accountId: string) {
    return [...this.moveRows.values()]
      .filter((m) => m.userId === userId && m.accountId === accountId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  reserveMove(move: AgentMoveRecord, check: (account: AgentAccountRecord, moves: readonly AgentMoveRecord[]) => void) {
    const run = this.lock.then(async () => {
      const existing = this.moveRows.get(this.id(move.userId, move.moveId));
      if (existing) return { move: existing, created: false };
      const account = await this.find(move.userId, move.accountId);
      if (!account) throw new Error(`no agent account ${move.accountId}`);
      check(account, await this.moves(move.userId, move.accountId));
      this.moveRows.set(this.id(move.userId, move.moveId), move);
      return { move, created: true };
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async settleMove(userId: string, moveId: string, state: 'done' | 'refused') {
    const id = this.id(userId, moveId);
    const row = this.moveRows.get(id);
    if (row && row.state === 'pending') this.moveRows.set(id, { ...row, state });
  }
}

interface AccountRow {
  user_id: string;
  account_id: string;
  venue_id: string;
  owner: string;
  sub_account: string | null;
  name: string;
  asset: string;
  cap: string;
  agent_address: string;
  fund_amount: string;
  status: AgentAccountStatus;
  created_at: Date;
  opened_at: Date | null;
  closed_at: Date | null;
}

interface MoveRow {
  user_id: string;
  account_id: string;
  move_id: string;
  direction: AgentMoveDirection;
  amount: string;
  state: AgentMoveState;
  created_at: Date;
}

const accountOf = (r: AccountRow): AgentAccountRecord => ({
  userId: r.user_id,
  accountId: r.account_id,
  venueId: r.venue_id,
  owner: r.owner,
  subAccount: r.sub_account,
  name: r.name,
  asset: r.asset,
  cap: parseAmount(r.cap),
  agentAddress: r.agent_address,
  fundAmount: parseAmount(r.fund_amount),
  status: r.status,
  createdAt: r.created_at,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
});

const moveOf = (r: MoveRow): AgentMoveRecord => ({
  userId: r.user_id,
  accountId: r.account_id,
  moveId: r.move_id,
  direction: r.direction,
  amount: parseAmount(r.amount),
  state: r.state,
  createdAt: r.created_at,
});

const ACCOUNT_COLUMNS =
  'user_id, account_id, venue_id, owner, sub_account, name, asset, cap, agent_address, fund_amount, status, created_at, opened_at, closed_at';
const MOVE_COLUMNS = 'user_id, account_id, move_id, direction, amount, state, created_at';

export class SqlAgentAccountStore implements AgentAccountStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, accountId: string) {
    const rows = await this.sql<AccountRow[]>`
      SELECT ${this.sql.unsafe(ACCOUNT_COLUMNS)} FROM trade.user_venue_agent_accounts
      WHERE user_id = ${userId} AND account_id = ${accountId}`;
    return rows[0] ? accountOf(rows[0]) : null;
  }

  async list(userId: string) {
    const rows = await this.sql<AccountRow[]>`
      SELECT ${this.sql.unsafe(ACCOUNT_COLUMNS)} FROM trade.user_venue_agent_accounts
      WHERE user_id = ${userId} ORDER BY created_at, account_id`;
    return rows.map(accountOf);
  }

  async insertOnce(a: AgentAccountRecord, m: AgentMoveRecord) {
    await this.sql.begin(async (tx) => {
      const inserted = await tx<{ account_id: string }[]>`
        INSERT INTO trade.user_venue_agent_accounts
          (user_id, account_id, venue_id, owner, sub_account, name, asset, cap, agent_address, fund_amount, status, created_at)
        VALUES (${a.userId}, ${a.accountId}, ${a.venueId}, ${a.owner}, ${a.subAccount}, ${a.name}, ${a.asset},
          ${formatAmount(a.cap)}, ${a.agentAddress}, ${formatAmount(a.fundAmount)}, ${a.status}, ${a.createdAt})
        ON CONFLICT (user_id, account_id) DO NOTHING
        RETURNING account_id`;
      if (inserted.length === 0) return;
      await tx`
        INSERT INTO trade.user_venue_agent_moves (user_id, account_id, move_id, direction, amount, state, created_at)
        VALUES (${m.userId}, ${m.accountId}, ${m.moveId}, ${m.direction}, ${formatAmount(m.amount)}, ${m.state}, ${m.createdAt})`;
    });
    const stored = await this.find(a.userId, a.accountId);
    if (!stored) throw new Error(`the agent account ${a.accountId} was not stored`);
    return stored;
  }

  async update(userId: string, accountId: string, patch: AccountPatch) {
    const row = await this.find(userId, accountId);
    if (!row) throw new Error(`no agent account ${accountId}`);
    const next = { ...row, ...patch };
    await this.sql`
      UPDATE trade.user_venue_agent_accounts
      SET sub_account = ${next.subAccount}, status = ${next.status}, opened_at = ${next.openedAt}, closed_at = ${next.closedAt},
        cap = ${formatAmount(next.cap)}
      WHERE user_id = ${userId} AND account_id = ${accountId}`;
    return next;
  }

  async moves(userId: string, accountId: string) {
    const rows = await this.sql<MoveRow[]>`
      SELECT ${this.sql.unsafe(MOVE_COLUMNS)} FROM trade.user_venue_agent_moves
      WHERE user_id = ${userId} AND account_id = ${accountId} ORDER BY created_at, move_id`;
    return rows.map(moveOf);
  }

  async reserveMove(move: AgentMoveRecord, check: (account: AgentAccountRecord, moves: readonly AgentMoveRecord[]) => void) {
    return this.sql.begin(async (tx) => {
      const locked = await tx<AccountRow[]>`
        SELECT ${tx.unsafe(ACCOUNT_COLUMNS)} FROM trade.user_venue_agent_accounts
        WHERE user_id = ${move.userId} AND account_id = ${move.accountId} FOR UPDATE`;
      if (!locked[0]) throw new Error(`no agent account ${move.accountId}`);
      const existing = await tx<MoveRow[]>`
        SELECT ${tx.unsafe(MOVE_COLUMNS)} FROM trade.user_venue_agent_moves
        WHERE user_id = ${move.userId} AND move_id = ${move.moveId}`;
      if (existing[0]) return { move: moveOf(existing[0]), created: false };
      const rows = await tx<MoveRow[]>`
        SELECT ${tx.unsafe(MOVE_COLUMNS)} FROM trade.user_venue_agent_moves
        WHERE user_id = ${move.userId} AND account_id = ${move.accountId}`;
      check(accountOf(locked[0]), rows.map(moveOf));
      await tx`
        INSERT INTO trade.user_venue_agent_moves (user_id, account_id, move_id, direction, amount, state, created_at)
        VALUES (${move.userId}, ${move.accountId}, ${move.moveId}, ${move.direction}, ${formatAmount(move.amount)}, ${move.state}, ${move.createdAt})`;
      return { move, created: true };
    });
  }

  async settleMove(userId: string, moveId: string, state: 'done' | 'refused') {
    await this.sql`
      UPDATE trade.user_venue_agent_moves SET state = ${state}
      WHERE user_id = ${userId} AND move_id = ${moveId} AND state = 'pending'`;
  }
}
