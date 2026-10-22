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

/**
 * THE MAPPING. One function, so "which ledger account is this space" has exactly
 * one answer and `grep` finds every caller.
 */
export function accountForSpace(space: Pick<SpaceRecord, 'id' | 'userId' | 'assetId' | 'kind'>): AccountRef {
  return space.kind === 'primary' ? userAvailable(space.userId, space.assetId) : subAccountAvailable(space.id, space.assetId);
}

export interface SpaceView extends SpaceRecord {
  /** Decimal string, straight from the ledger. Never persisted anywhere. */
  balance: string;
}

export class SpaceService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'balance' | 'balances'>,
  ) {}

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
  async find(spaceId: string): Promise<SpaceRecord | null> {
    const rows = await this.sql<SpaceRow[]>`
      SELECT id, user_id, asset_id, kind, name, goal_target, locked_until, archived_at
        FROM bank.spaces WHERE id = ${spaceId}
    `;
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async get(spaceId: string): Promise<SpaceRecord> {
    const space = await this.find(spaceId);
    if (!space) throw new BankError(`Space ${spaceId} not found`, 'bank.space_not_found');
    return space;
  }

  async list(userId: string, assetId?: string): Promise<SpaceRecord[]> {
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
    return rows.map(toRecord);
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

  /** Spaces with their ledger balances attached — the multi-currency overview (§8.1). */
  async overview(userId: string, assetId?: string): Promise<SpaceView[]> {
    const spaces = await this.list(userId, assetId);
    const views: SpaceView[] = [];
    for (const space of spaces) {
      views.push({ ...space, balance: formatAmount(await this.balanceOf(space)) });
    }
    return views;
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
    const named = new Set((await this.list(userId)).map((s) => s.assetId));
    return balances
      .filter((b) => b.account.kind === 'available' && b.amount > 0n && !named.has(b.account.assetId))
      .map((b) => ({ assetId: b.account.assetId, balance: formatAmount(b.amount) }));
  }

  /** Resolve a space for a money path, refusing the states that must not move value. */
  async resolveForDebit(spaceId: string, now: Date): Promise<SpaceRecord> {
    const space = await this.get(spaceId);
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
    if (space.lockedUntil && space.lockedUntil > now) {
      // A self-imposed lock. Product policy, enforced here — the ledger has no
      // opinion about it, which is right: a user locking themselves out of their
      // own money is a rule about the product, not a property of the book.
      throw new BankError(`Space "${space.name}" is locked until ${space.lockedUntil.toISOString()}`, 'bank.space_locked');
    }
    return space;
  }

  async resolveForCredit(spaceId: string): Promise<SpaceRecord> {
    const space = await this.get(spaceId);
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
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
