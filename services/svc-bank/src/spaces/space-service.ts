import type { Sql } from 'postgres';
import {
  formatAmount,
  parseAmount,
  subAccountAvailable,
  userAvailable,
  type AccountRef,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { transaction } from '@intafaced/db';
import { BankError } from '../errors.js';
import { assertSpacesListLimit } from '../owner-list-limit.js';
import {
  RecipientStateUnavailableError,
  unconfiguredRecipientState,
  type RecipientStatePort,
  type RecipientStatus,
} from '../recipient-state.js';

/** Owner-set number of live named spaces one account may hold (BK-pots-01). */
export const BANK_SPACE_LIMIT_ENV = 'BANK_SPACE_LIMIT';

/** Unset, blank, zero or not a whole number refuses `bank.space_limit_unset`. No default. */
export function requireSpaceLimit(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9][0-9]{0,5}$/.test(trimmed)) {
    throw new BankError('The owner has not set how many spaces an account can hold, so no new space is made', 'bank.space_limit_unset');
  }
  return Number.parseInt(trimmed, 10);
}

export interface SpaceServiceOptions {
  /** The owner's space limit, read on each call so a change takes effect without a restart. */
  readonly spaceLimit?: () => string | undefined;
  /** The owner's early-unlock wait in hours (`BANK_SPACE_UNLOCK_WAIT_HOURS`), read on each ask. */
  readonly unlockWaitHours?: () => string | undefined;
}

/** One message for frozen, closed and unknown. Never says which. */
export const RECIPIENT_CANNOT_RECEIVE_MESSAGE = 'This recipient cannot receive payments';

/**
 * SPACES — named views over ledger accounts (§8.1).
 *
 * A space is a LABEL AND A POLICY. It is not a balance and it cannot become
 * one: nothing in this file writes a number that anyone would later read as
 * "how much is in here". `balanceOf()` asks the ledger, every time.
 *
 * The mapping is the whole design:
 *
 *   primary space  →  userAvailable(userId, assetId)          (ownerType 'user')
 *   named space    →  subAccountAvailable(spaceId, assetId)   (ownerType 'subaccount')
 *
 * Both are account kinds §4.2 already defines. svc-bank adds no account kind,
 * no owner type, and no storage — it adds names. That is what "views + rails"
 * means, and it is why "a space's balance equals the ledger's" is true by
 * construction rather than by a reconciliation job that could be switched off.
 */

export interface SpaceRecord {
  id: string;
  userId: string;
  assetId: string;
  kind: 'primary' | 'named';
  name: string;
  goalTarget: Amount | null;
  lockedUntil: Date | null;
  /** When the owner confirmed an early unlock (BK-pots-02); null when none is asked for. */
  unlockRequestedAt: Date | null;
  /** When that early unlock takes effect, never later than `lockedUntil`. Set together with `unlockRequestedAt`. */
  unlocksAt: Date | null;
  archivedAt: Date | null;
}

interface SpaceRow {
  id: string;
  user_id: string;
  asset_id: string;
  kind: 'primary' | 'named';
  name: string;
  goal_target: string | null;
  locked_until: Date | null;
  unlock_requested_at: Date | null;
  unlocks_at: Date | null;
  archived_at: Date | null;
}

function toRecord(row: SpaceRow): SpaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    kind: row.kind,
    name: row.name,
    goalTarget: row.goal_target === null ? null : parseAmount(row.goal_target),
    lockedUntil: row.locked_until,
    unlockRequestedAt: row.unlock_requested_at,
    unlocksAt: row.unlocks_at,
    archivedAt: row.archived_at,
  };
}

/** Same order as the list SQL: asset, then primary before named, then name. */
function orderSpaces(spaces: readonly SpaceRecord[], groupByAsset: boolean): SpaceRecord[] {
  return [...spaces].sort((a, b) => {
    if (groupByAsset && a.assetId !== b.assetId) return a.assetId < b.assetId ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'primary' ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * THE MAPPING. One function, so "which ledger account is this space" has exactly
 * one answer and `grep` finds every caller.
 */
export function accountForSpace(space: Pick<SpaceRecord, 'id' | 'userId' | 'assetId' | 'kind'>): AccountRef {
  return space.kind === 'primary' ? userAvailable(space.userId, space.assetId) : subAccountAvailable(space.id, space.assetId);
}

/**
 * When a pot's lock ends, or null when it is not locked at `now`. A lock runs to `lockedUntil`; an early unlock the owner
 * asked for ends it at `unlocksAt` instead (BK-pots-02). Debits, the list and the pot page all read this one answer.
 */
export function lockEnd(space: Pick<SpaceRecord, 'lockedUntil' | 'unlocksAt'>, now: Date): Date | null {
  if (!space.lockedUntil || space.lockedUntil <= now) return null;
  if (space.unlocksAt && space.unlocksAt <= now) return null;
  return space.unlocksAt ?? space.lockedUntil;
}

/** Owner-set hours an early unlock waits before the pot opens (BK-pots-02). */
export const BANK_SPACE_UNLOCK_WAIT_HOURS_ENV = 'BANK_SPACE_UNLOCK_WAIT_HOURS';

/** Unset, blank or not a whole number of hours (0 to 8760) refuses `bank.space_unlock_rule_unset`. No default. */
export function requireUnlockWaitHours(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^[0-9]{1,4}$/.test(trimmed) || Number.parseInt(trimmed, 10) > 8760) {
    throw new BankError(
      'The owner has not set how long an early unlock waits, so the pot stays locked until its date',
      'bank.space_unlock_rule_unset',
    );
  }
  return Number.parseInt(trimmed, 10);
}

/** What the user holds in their main account: available balances above zero, optionally for one asset. */
function heldAvailable<B extends { account: { kind: string; assetId: string }; amount: bigint }>(
  balances: readonly B[],
  assetId?: string,
): B[] {
  return balances.filter(
    (b) => b.account.kind === 'available' && b.amount > 0n && (assetId === undefined || b.account.assetId === assetId),
  );
}

export interface SpaceView extends SpaceRecord {
  /** Decimal string, straight from the ledger. Never persisted anywhere. */
  balance: string;
}

export class SpaceService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'balance' | 'balances'>,
    /**
     * Who may be credited. Defaults to the refusing port, never to "everyone":
     * a deployment that was not given identity cannot tell a frozen recipient
     * from an active one, and must not pay either.
     */
    private readonly recipients: RecipientStatePort = unconfiguredRecipientState(),
    private readonly options: SpaceServiceOptions = {},
  ) {}

  /**
   * Refuse a credit to a user identity says cannot receive. Frozen, closed and
   * unknown all give `bank.recipient_cannot_receive` with one message; an outage
   * or a missing identity gives a different, retryable/operator code. Runs before
   * any ledger posting on every credit-by-id path.
   */
  async assertCanReceive(userId: string): Promise<void> {
    let status: RecipientStatus;
    try {
      status = await this.recipients.statusOf(userId);
    } catch (err) {
      if (err instanceof RecipientStateUnavailableError && err.reason === 'unset') {
        throw new BankError(err.message, 'bank.recipient_check_unset');
      }
      throw new BankError(
        'Could not check whether the recipient can receive payments; nothing was sent. Retry with the same id.',
        'bank.recipient_check_unavailable',
      );
    }
    if (status !== 'active') throw new BankError(RECIPIENT_CANNOT_RECEIVE_MESSAGE, 'bank.recipient_cannot_receive');
  }

  /**
   * The user's main balance in an asset, given a name.
   *
   * Created on demand rather than at registration: a user who has never held
   * EUR does not need an EUR space, and creating one for every listed asset
   * would fill the table with labels for nothing. The unique partial index
   * `spaces_one_primary_idx` makes the race safe — two concurrent calls produce
   * one row.
   */
  async ensurePrimary(userId: string, assetId: string, name = 'Main', db: Sql = this.sql): Promise<SpaceRecord> {
    const rows = await db<SpaceRow[]>`
      INSERT INTO bank.spaces (user_id, asset_id, kind, name)
      VALUES (${userId}, ${assetId}, 'primary', ${name})
      ON CONFLICT DO NOTHING
      RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
    `;

    const inserted = rows[0];
    if (inserted) return toRecord(inserted);

    const existing = await db<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
        FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND kind = 'primary'
    `;
    const row = existing[0];
    if (!row) throw new BankError(`Could not resolve the primary ${assetId} space for ${userId}`, 'bank.space_not_found');
    return toRecord(row);
  }

  /**
   * The main account of a member being paid by user id, for a credit.
   *
   * A member who has never held the asset has no primary row yet, but they do
   * have the ledger account the row names (`userAvailable`). The row is made
   * here, after identity says the user can receive, so an unknown, frozen or
   * closed id gets the one `bank.recipient_cannot_receive` and no row.
   */
  async primaryForCredit(userId: string, assetId: string): Promise<SpaceRecord | null> {
    const id = userId.trim();
    if (!id) return null;
    const known = await this.findPrimary(id, assetId);
    if (known) return known;
    await this.assertCanReceive(id);
    return this.ensurePrimary(id, assetId);
  }

  /** Lookup only. Does not invent a dest user or a primary space. */
  async findPrimary(userId: string, assetId: string, db: Sql = this.sql): Promise<SpaceRecord | null> {
    const id = userId.trim();
    if (!id) return null;
    const rows = await db<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
        FROM bank.spaces
       WHERE user_id = ${id} AND asset_id = ${assetId} AND kind = 'primary' AND archived_at IS NULL
    `;
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /** Show a removed currency on the account again. A label: nothing moves. */
  async restoreCurrency(userId: string, assetId: string, db: Sql = this.sql): Promise<void> {
    await db`
      UPDATE bank.spaces SET removed_at = NULL, updated_at = now()
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND kind = 'primary' AND removed_at IS NOT NULL
    `;
  }

  /**
   * A new named space for a customer, inside the owner's limit on live named spaces (BK-pots-01).
   *
   * The limit is the owner setting (`BANK_SPACE_LIMIT`), read on each call: blank refuses `bank.space_limit_unset`, and
   * at the limit the create refuses `bank.space_limit_reached` with the number. Creates and restores for one customer
   * are serialised by an advisory lock, so two racing for the last place make one space, not two. Archived spaces do
   * not count; restoring one does (`unarchiveWithinLimit`).
   */
  async createWithinLimit(input: {
    userId: string;
    assetId: string;
    name: string;
    goalTarget?: Amount | null;
    lockedUntil?: Date | null;
  }): Promise<SpaceRecord> {
    const max = requireSpaceLimit(this.options.spaceLimit?.());
    // A lock is made only where its owner can end it early: blank wait refuses before any row (BK-pots-02).
    if (input.lockedUntil) requireUnlockWaitHours(this.options.unlockWaitHours?.());
    return this.underSpaceLock(input.userId, async (tx) => {
      await this.assertRoomForSpace(tx, input.userId, max);
      // The primary must exist before a named one is useful (it is where value arrives from every other module), and a
      // named space puts its currency back on the account if the customer had removed it.
      await this.ensurePrimary(input.userId, input.assetId, 'Main', tx);
      await this.restoreCurrency(input.userId, input.assetId, tx);
      return this.create(input, tx);
    });
  }

  /**
   * One customer's space labels, changed one call at a time: creates, restores and currency removals for a customer
   * take the same advisory lock. Read committed, so each statement after the lock sees what the call before it committed.
   */
  async underSpaceLock<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`bank-spaces:${userId}`}))`;
        return fn(tx);
      },
      { isolation: 'read committed' },
    );
  }

  /** Restore an archived space, inside the same limit as a new one. A live space is a no-op that needs no room. */
  async unarchiveWithinLimit(spaceId: string): Promise<void> {
    const space = await this.get(spaceId);
    if (space.kind === 'named' && space.archivedAt) {
      const max = requireSpaceLimit(this.options.spaceLimit?.());
      await this.underSpaceLock(space.userId, async (tx) => {
        await this.assertRoomForSpace(tx, space.userId, max);
        await this.restoreCurrency(space.userId, space.assetId, tx);
        await tx`
          UPDATE bank.spaces SET archived_at = NULL, updated_at = now()
           WHERE id = ${spaceId} AND archived_at IS NOT NULL
        `;
      });
      return;
    }
    await this.unarchive(spaceId);
  }

  private async assertRoomForSpace(tx: Sql, userId: string, max: number): Promise<void> {
    const count = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bank.spaces WHERE user_id = ${userId} AND kind = 'named' AND archived_at IS NULL
    `;
    if ((count[0]?.n ?? 0) >= max) {
      throw new BankError(
        `This account already has ${max} spaces, the most it can hold. Archive one to make room.`,
        'bank.space_limit_reached',
      );
    }
  }

  async create(
    input: {
      userId: string;
      assetId: string;
      name: string;
      goalTarget?: Amount | null;
      lockedUntil?: Date | null;
    },
    db: Sql = this.sql,
  ): Promise<SpaceRecord> {
    let rows: SpaceRow[];
    try {
      rows = await db<SpaceRow[]>`
        INSERT INTO bank.spaces (user_id, asset_id, kind, name, goal_target, locked_until)
        VALUES (
          ${input.userId}, ${input.assetId}, 'named', ${input.name},
          ${input.goalTarget === undefined || input.goalTarget === null ? null : formatAmount(input.goalTarget)}::numeric,
          ${input.lockedUntil ?? null}
        )
        RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
      `;
    } catch (err) {
      // Same customer, currency and name: a typed conflict the customer can fix by renaming, not a raw 23505 as a 500.
      const e = err as { code?: string; constraint_name?: string };
      if (e?.code === '23505' && e.constraint_name === 'spaces_user_asset_name_idx') {
        throw new BankError(
          `A space named "${input.name}" already exists for ${input.assetId}, perhaps archived: pick another name`,
          'bank.space_name_taken',
        );
      }
      throw err;
    }
    return toRecord(rows[0]!);
  }

  /**
   * A space by id, or `null`. THE LOOKUP THAT DOES NOT THROW.
   *
   * `get` below is right for a caller that is entitled to the row: a missing
   * space is exceptional there, and the exception carries a message saying so.
   *
   * This one exists for the caller that has to decide whether it may say
   * ANYTHING about the row — the destination gate in `router.ts`. For that
   * caller "does not exist" cannot be an exception, because an exception is a
   * message, and whether a message was produced is itself the oracle the
   * refusal-shape ADR closes. It also does exactly one query in both cases, so
   * absent and not-yours cost the same work as well as saying the same thing.
   */
  /**
   * `db` is the connection to read on. A caller that already holds a
   * transaction passes it, so the read does not wait for a SECOND connection of
   * the same pool while holding the first (GitHub issue #4621). A read takes no
   * lock either way: the spaces row is read committed on whichever connection.
   */
  async find(spaceId: string, db: Sql = this.sql): Promise<SpaceRecord | null> {
    const rows = await db<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
        FROM bank.spaces WHERE id = ${spaceId}
    `;
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async get(spaceId: string, db: Sql = this.sql): Promise<SpaceRecord> {
    const space = await this.find(spaceId, db);
    if (!space) throw new BankError(`Space ${spaceId} not found`, 'bank.space_not_found');
    return space;
  }

  /**
   * Work set of every space that can still hold a visible balance.
   * unnamedAssets / spendSummary — not a list page. A page here would hide
   * named assets and invent unnamed ones.
   *
   * Live rows always. An archived named space stays only while its ledger
   * balance is greater than zero: the label is gone, the subaccount is not,
   * and a zero row is just a retired name.
   */
  async namedSpaces(userId: string, assetId?: string): Promise<SpaceRecord[]> {
    const rows = assetId
      ? await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND archived_at IS NULL
            ORDER BY kind DESC, name ASC
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND archived_at IS NULL
            ORDER BY asset_id ASC, kind DESC, name ASC
        `;
    const funded = await this.fundedArchived(userId, assetId);
    return orderSpaces([...rows.map(toRecord), ...funded], assetId === undefined);
  }

  /**
   * EVERY named space this user has ever owned, archived or not, funded or not.
   * For history reads (`bank.activity.list`), which must still see a closed
   * Space's postings: a move into one is a move between the user's own pots,
   * not a payment to a stranger. Filtered by `user_id`, so never another user's.
   */
  async allNamedSpaces(userId: string, assetId?: string): Promise<SpaceRecord[]> {
    const rows = assetId
      ? await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND kind = 'named'
            ORDER BY asset_id ASC, name ASC, id ASC
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND kind = 'named'
            ORDER BY asset_id ASC, name ASC, id ASC
        `;
    return rows.map(toRecord);
  }

  async list(userId: string, assetId?: string, limit?: number): Promise<SpaceRecord[]> {
    const page = assertSpacesListLimit(limit);
    const rows = assetId
      ? await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND archived_at IS NULL AND removed_at IS NULL
            ORDER BY kind DESC, name ASC
           LIMIT ${page}
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND archived_at IS NULL AND removed_at IS NULL
            ORDER BY asset_id ASC, kind DESC, name ASC
           LIMIT ${page}
        `;
    // Funded archived pots are added after the live page. A cap on labels must
    // not hide a subaccount that still holds value.
    const funded = await this.fundedArchived(userId, assetId);
    return orderSpaces([...rows.map(toRecord), ...funded], assetId === undefined);
  }

  /**
   * What is in this space.
   *
   * One ledger read. There is no cache, no snapshot, and no column this could
   * have come from instead — which is the point. If this method ever grows a
   * fallback to a local number, the doctrine test in `bank-service.test.ts`
   * will not catch it, but the code review must.
   */
  async balanceOf(space: Pick<SpaceRecord, 'id' | 'userId' | 'assetId' | 'kind'>): Promise<Amount> {
    return (await this.ledger.balance(accountForSpace(space))).amount;
  }

  /**
   * Paycheck deposit. Refuses until a paycheck rail exists.
   * An amount on the call is not a credit and is not posted.
   */
  directDeposit(): never {
    throw new BankError('Direct deposit is refused. The missing piece is an outside company, the paycheck rail.', 'bank.no_paycheck_rail');
  }

  /** Spaces with their ledger balances attached — the multi-currency overview (§8.1). */
  async overview(userId: string, assetId?: string, limit?: number): Promise<SpaceView[]> {
    assertSpacesListLimit(limit);
    await this.ensureHeldPrimaries(userId, assetId);
    const spaces = await this.list(userId, assetId, limit);
    const views: SpaceView[] = [];
    for (const space of spaces) {
      views.push({ ...space, balance: formatAmount(await this.balanceOf(space)) });
    }
    return views;
  }

  /**
   * Every asset the user holds in their main account gets its primary row, so a
   * list of spaces always shows the account itself. Money that lands from
   * outside the bank (a deposit, a fill) is posted by other services that do not
   * know about spaces, so the row is made the first time the owner reads the
   * list; before this, Pay and Bank showed "nothing to send" over a funded
   * account. Labels only: `ensurePrimary` is race-safe and a repeat is a no-op.
   * A currency the customer removed comes back the same way once money is in it
   * again, so a funded account is never hidden. A failed write never fails the
   * read; the next read tries again.
   */
  async ensureHeldPrimaries(userId: string, assetId?: string): Promise<void> {
    try {
      const held = heldAvailable(await this.ledger.balances('user', userId), assetId);
      if (held.length === 0) return;
      const rows = await this.sql<Array<{ asset_id: string; removed: boolean }>>`
        SELECT asset_id, removed_at IS NOT NULL AS removed FROM bank.spaces WHERE user_id = ${userId} AND kind = 'primary'
      `;
      const known = new Map(rows.map((r) => [r.asset_id, r.removed]));
      for (const b of held) {
        const removed = known.get(b.account.assetId);
        if (removed === undefined) await this.ensurePrimary(userId, b.account.assetId);
        else if (removed) await this.restoreCurrency(userId, b.account.assetId);
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'svc-bank',
          event: 'bank.held_primary_open_failed',
          userId,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /**
   * Assets the user holds that have no space yet.
   *
   * The ledger is the source of the asset list, not this table: a user who was
   * paid in an asset they have never named still has it, and an overview built
   * only from `spaces` would hide their own money from them.
   */
  async unnamedAssets(userId: string): Promise<Array<{ assetId: string; balance: string }>> {
    const balances = await this.ledger.balances('user', userId);
    const named = new Set((await this.namedSpaces(userId)).map((s) => s.assetId));
    return heldAvailable(balances)
      .filter((b) => !named.has(b.account.assetId))
      .map((b) => ({ assetId: b.account.assetId, balance: formatAmount(b.amount) }));
  }

  /** Resolve a space for a money path, refusing the states that must not move value. */
  async resolveForDebit(spaceId: string, now: Date, db: Sql = this.sql): Promise<SpaceRecord> {
    const space = await this.get(spaceId, db);
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
    const until = lockEnd(space, now);
    if (until) {
      // A self-imposed lock. Product policy, enforced here — the ledger has no
      // opinion about it, which is right: a user locking themselves out of their
      // own money is a rule about the product, not a property of the book.
      throw new BankError(`Space "${space.name}" is locked until ${until.toISOString()}`, 'bank.space_locked');
    }
    return space;
  }

  /**
   * Resolve a space for a money path that CREDITS it, refusing a recipient who
   * cannot receive.
   *
   * `actingUserId` is the user moving the value: crediting their own space needs
   * no identity call (a move between your own pots is not a payment to a
   * recipient, and the edge already gates the sender's own account).
   *
   * `alreadyBooked` is for RETRIES. When the recipient check refuses but this
   * very instruction already posted (same idempotency key) while the recipient
   * was active, the retry must see the original result, not a refusal telling
   * the caller a committed payment failed. The caller then still goes through
   * the idempotent ledger post, which returns the original and refuses a changed
   * body, so nothing new can move on this path.
   */
  async resolveForCredit(
    spaceId: string,
    opts: { actingUserId?: string; alreadyBooked?: () => Promise<boolean> } = {},
    db: Sql = this.sql,
  ): Promise<SpaceRecord> {
    const space = await this.get(spaceId, db);
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
    if (space.userId === opts.actingUserId) return space;
    try {
      await this.assertCanReceive(space.userId);
    } catch (err) {
      if (opts.alreadyBooked && err instanceof BankError && err.code.startsWith('bank.recipient_') && (await opts.alreadyBooked())) {
        return space;
      }
      throw err;
    }
    return space;
  }

  /**
   * Archive a space.
   *
   * Deliberately does NOT check that the space is empty and does NOT sweep it:
   * archiving is a labelling decision, and value in the underlying ledger
   * account is unaffected and still the user's. Sweeping on archive would make
   * a UI gesture move money, which is precisely the class of surprise a bank
   * must never produce.
   */
  async archive(spaceId: string): Promise<void> {
    const space = await this.get(spaceId);
    if (space.kind === 'primary') {
      throw new BankError('The primary space is the account itself and cannot be archived', 'bank.space_archived');
    }
    // An archived space pays no bills: the bills pot role ends in the same transaction, under the row lock that
    // `BillsPotService.set` takes, so a racing set either lands first and is ended here or finds the space archived.
    // Its linked card (BK-acct-09) is unlinked the same way, with a line in its log, so the card can be linked again.
    await this.underRowLock(async (tx) => {
      await tx`UPDATE bank.spaces SET archived_at = now(), updated_at = now() WHERE id = ${spaceId}`;
      await tx`DELETE FROM bank.bills_pots WHERE space_id = ${spaceId}::uuid`;
      const unlinked = await tx<Array<{ card_id: string }>>`
        DELETE FROM bank.shared_pot_cards WHERE space_id = ${spaceId}::uuid RETURNING card_id
      `;
      for (const { card_id } of unlinked) {
        await tx`
          INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, kind, card_id)
          VALUES (${spaceId}::uuid, ${space.userId}, 'card_unlinked', ${card_id}::uuid)
        `;
      }
    });
  }

  /**
   * Clear the archive label. Posts nothing: the subaccount was never swept,
   * so unarchive is the same kind of gesture as archive.
   *
   * A space that is already live is a no-op success. The primary space is
   * refused with the same code as archive — it is the account, not a pot.
   */
  async unarchive(spaceId: string): Promise<void> {
    const space = await this.get(spaceId);
    if (space.kind === 'primary') {
      throw new BankError('The primary space is the account itself and cannot be archived', 'bank.space_archived');
    }
    if (!space.archivedAt) return;
    await this.sql`
      UPDATE bank.spaces
         SET archived_at = NULL, updated_at = now()
       WHERE id = ${spaceId} AND archived_at IS NOT NULL
    `;
  }

  /**
   * Archived named spaces whose ledger balance is still greater than zero.
   * The comparison stays on the scaled bigint from `balanceOf`. Zero stays out.
   */
  private async fundedArchived(userId: string, assetId?: string): Promise<SpaceRecord[]> {
    const rows = assetId
      ? await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces
           WHERE user_id = ${userId} AND asset_id = ${assetId} AND kind = 'named' AND archived_at IS NOT NULL
           ORDER BY name ASC
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
            FROM bank.spaces
           WHERE user_id = ${userId} AND kind = 'named' AND archived_at IS NOT NULL
           ORDER BY asset_id ASC, name ASC
        `;
    const funded: SpaceRecord[] = [];
    for (const row of rows) {
      const space = toRecord(row);
      const balance = await this.balanceOf(space);
      if (balance > 0n) funded.push(space);
    }
    return funded;
  }

  /**
   * Read one named, live pot of this owner under a row lock for a change of its goal, lock or bills pot role. Refuses the
   * primary space (the account itself has no goal or lock), an archived pot and another owner's pot, the last as not found.
   */
  async ownPotForUpdate(tx: Sql, spaceId: string, userId: string): Promise<SpaceRecord> {
    const rows = await tx<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
        FROM bank.spaces
       WHERE id = ${spaceId}
       FOR UPDATE
    `;
    const row = rows[0];
    if (!row || row.user_id !== userId) throw new BankError(`Space ${spaceId} not found`, 'bank.space_not_found');
    const space = toRecord(row);
    if (space.kind === 'primary') {
      throw new BankError('The primary space is the account itself; goals and locks belong to pots', 'bank.space_change_invalid');
    }
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
    return space;
  }

  /** One pot change in a read-committed transaction: the row lock in `ownPotForUpdate` orders racing changes. */
  underRowLock<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return transaction(this.sql, fn, { isolation: 'read committed' });
  }

  /** Set, change or clear the savings target of one of the owner's pots. A goal, never a holding: nothing moves. */
  async setGoal(spaceId: string, userId: string, goalTarget: Amount | null): Promise<SpaceRecord> {
    if (goalTarget !== null && goalTarget <= 0n) {
      throw new BankError('A goal is an amount above zero; clear it to have none', 'bank.space_change_invalid');
    }
    return this.underRowLock(async (tx) => {
      await this.ownPotForUpdate(tx, spaceId, userId);
      const rows = await tx<SpaceRow[]>`
        UPDATE bank.spaces
           SET goal_target = ${goalTarget === null ? null : formatAmount(goalTarget)}::numeric, updated_at = now()
         WHERE id = ${spaceId}
        RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
      `;
      return toRecord(rows[0]!);
    });
  }

  /**
   * Lock one of the owner's pots until a later date, or keep a lock for longer (BK-pots-02). A lock never gets shorter
   * here: ending it sooner is an early unlock, which waits out the owner's window, and a lock is refused while that window
   * is blank. A new lock date replaces any early unlock still waiting, since the owner has chosen to keep the money in
   * (the app says so before it is sent). The same date again changes nothing.
   */
  async setLock(spaceId: string, userId: string, lockedUntil: Date, now: Date): Promise<SpaceRecord> {
    if (!(lockedUntil > now)) throw new BankError('A lock date must be in the future', 'bank.space_change_invalid');
    // No lock without a way out: with the owner's early-unlock wait blank, a mistyped far date would hold the money
    // with nothing the customer could do, so the lock itself refuses `bank.space_unlock_rule_unset` and writes nothing.
    requireUnlockWaitHours(this.options.unlockWaitHours?.());
    return this.underRowLock(async (tx) => {
      const space = await this.ownPotForUpdate(tx, spaceId, userId);
      const current = lockEnd(space, now);
      if (current && space.lockedUntil && lockedUntil < space.lockedUntil) {
        throw new BankError(
          `Space "${space.name}" is locked until ${space.lockedUntil.toISOString()}; to end the lock sooner, ask for an early unlock`,
          'bank.space_change_invalid',
        );
      }
      if (space.lockedUntil?.getTime() === lockedUntil.getTime() && space.unlocksAt === null) return space;
      const rows = await tx<SpaceRow[]>`
        UPDATE bank.spaces
           SET locked_until = ${lockedUntil}, unlock_requested_at = NULL, unlocks_at = NULL, updated_at = now()
         WHERE id = ${spaceId}
        RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
      `;
      return toRecord(rows[0]!);
    });
  }

  /**
   * The owner confirmed they want a locked pot opened before its date (BK-pots-02). The pot stays locked for the owner's
   * waiting window (`BANK_SPACE_UNLOCK_WAIT_HOURS`) and opens then, or at its own date if that comes first. A blank
   * window refuses `bank.space_unlock_rule_unset` and writes nothing: no waiting length is invented. Asking again while
   * one waits returns that one, so a repeated press never restarts the clock.
   */
  async requestUnlock(spaceId: string, userId: string, now: Date): Promise<SpaceRecord> {
    return this.underRowLock(async (tx) => {
      const space = await this.ownPotForUpdate(tx, spaceId, userId);
      if (!lockEnd(space, now)) throw new BankError(`Space "${space.name}" is not locked`, 'bank.space_not_locked');
      if (space.unlocksAt) return space;
      const hours = requireUnlockWaitHours(this.options.unlockWaitHours?.());
      const waited = new Date(now.getTime() + hours * 3_600_000);
      const unlocksAt = space.lockedUntil && space.lockedUntil < waited ? space.lockedUntil : waited;
      const rows = await tx<SpaceRow[]>`
        UPDATE bank.spaces
           SET unlock_requested_at = ${now}, unlocks_at = ${unlocksAt}, updated_at = now()
         WHERE id = ${spaceId}
        RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
      `;
      return toRecord(rows[0]!);
    });
  }

  /**
   * Withdraw an early unlock that is still waiting: the pot stays locked to its date. When none waits (never asked, or
   * already opened) nothing changes and the pot's state is the answer, so a retry after the opening time reads as open.
   */
  async cancelUnlock(spaceId: string, userId: string, now: Date): Promise<SpaceRecord> {
    return this.underRowLock(async (tx) => {
      const space = await this.ownPotForUpdate(tx, spaceId, userId);
      if (!space.unlocksAt || !lockEnd(space, now)) return space;
      const rows = await tx<SpaceRow[]>`
        UPDATE bank.spaces
           SET unlock_requested_at = NULL, unlocks_at = NULL, updated_at = now()
         WHERE id = ${spaceId}
        RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, unlock_requested_at, unlocks_at, archived_at
      `;
      return toRecord(rows[0]!);
    });
  }
}
