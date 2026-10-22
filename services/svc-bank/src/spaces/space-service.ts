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
import { BankError } from '../errors.js';
import { assertSpacesListLimit } from '../owner-list-limit.js';
import {
  RecipientStateUnavailableError,
  unconfiguredRecipientState,
  type RecipientStatePort,
  type RecipientStatus,
} from '../recipient-state.js';

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
  async ensurePrimary(userId: string, assetId: string, name = 'Main'): Promise<SpaceRecord> {
    const rows = await this.sql<SpaceRow[]>`
      INSERT INTO bank.spaces (user_id, asset_id, kind, name)
      VALUES (${userId}, ${assetId}, 'primary', ${name})
      ON CONFLICT DO NOTHING
      RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
    `;

    const inserted = rows[0];
    if (inserted) return toRecord(inserted);

    const existing = await this.sql<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
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
  async findPrimary(userId: string, assetId: string): Promise<SpaceRecord | null> {
    const id = userId.trim();
    if (!id) return null;
    const rows = await this.sql<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
        FROM bank.spaces
       WHERE user_id = ${id} AND asset_id = ${assetId} AND kind = 'primary' AND archived_at IS NULL
    `;
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async create(input: {
    userId: string;
    assetId: string;
    name: string;
    goalTarget?: Amount | null;
    lockedUntil?: Date | null;
  }): Promise<SpaceRecord> {
    const rows = await this.sql<SpaceRow[]>`
      INSERT INTO bank.spaces (user_id, asset_id, kind, name, goal_target, locked_until)
      VALUES (
        ${input.userId}, ${input.assetId}, 'named', ${input.name},
        ${input.goalTarget === undefined || input.goalTarget === null ? null : formatAmount(input.goalTarget)}::numeric,
        ${input.lockedUntil ?? null}
      )
      RETURNING id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
    `;
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
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
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
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND archived_at IS NULL
            ORDER BY kind DESC, name ASC
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
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
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND kind = 'named'
            ORDER BY asset_id ASC, name ASC, id ASC
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND kind = 'named'
            ORDER BY asset_id ASC, name ASC, id ASC
        `;
    return rows.map(toRecord);
  }

  async list(userId: string, assetId?: string, limit?: number): Promise<SpaceRecord[]> {
    const page = assertSpacesListLimit(limit);
    const rows = assetId
      ? await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${assetId} AND archived_at IS NULL
            ORDER BY kind DESC, name ASC
           LIMIT ${page}
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
            FROM bank.spaces WHERE user_id = ${userId} AND archived_at IS NULL
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
   * A failed write never fails the read; the next read tries again.
   */
  private async ensureHeldPrimaries(userId: string, assetId?: string): Promise<void> {
    try {
      const held = heldAvailable(await this.ledger.balances('user', userId), assetId);
      if (held.length === 0) return;
      const rows = await this.sql<Array<{ asset_id: string }>>`
        SELECT asset_id FROM bank.spaces WHERE user_id = ${userId} AND kind = 'primary'
      `;
      const open = new Set(rows.map((r) => r.asset_id));
      for (const b of held) if (!open.has(b.account.assetId)) await this.ensurePrimary(userId, b.account.assetId);
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
    if (space.lockedUntil && space.lockedUntil > now) {
      // A self-imposed lock. Product policy, enforced here — the ledger has no
      // opinion about it, which is right: a user locking themselves out of their
      // own money is a rule about the product, not a property of the book.
      throw new BankError(`Space "${space.name}" is locked until ${space.lockedUntil.toISOString()}`, 'bank.space_locked');
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
    await this.sql`UPDATE bank.spaces SET archived_at = now(), updated_at = now() WHERE id = ${spaceId}`;
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
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
            FROM bank.spaces
           WHERE user_id = ${userId} AND asset_id = ${assetId} AND kind = 'named' AND archived_at IS NOT NULL
           ORDER BY name ASC
        `
      : await this.sql<SpaceRow[]>`
          SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
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

  /** Set or clear the savings target. A goal, never a holding. */
  async setGoal(spaceId: string, goalTarget: Amount | null): Promise<SpaceRecord> {
    await this.sql`
      UPDATE bank.spaces
         SET goal_target = ${goalTarget === null ? null : formatAmount(goalTarget)}::numeric, updated_at = now()
       WHERE id = ${spaceId}
    `;
    return this.get(spaceId);
  }
}
