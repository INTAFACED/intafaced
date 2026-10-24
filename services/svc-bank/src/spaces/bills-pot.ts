import type { Sql } from 'postgres';
import { BankError } from '../errors.js';
import type { SpaceService } from './space-service.js';

/**
 * BILLS POT (BK-pots-03, J-bank-07 #4).
 *
 * One of the person's own live named spaces per asset pays their bills. A standing order from it that finds too little
 * money is refused like any other (`ledger.insufficient_funds`), unless the person turned the fallback on: then the
 * shortfall moves from the main account into the pot first, and the order pays once (`TransferService`). The fallback is
 * off until the person turns it on. This is a role on a space, never a balance: the pot's money is its ledger account.
 *
 * Making another space the bills pot moves the role there. Archiving the pot ends the role (`SpaceService.archive`).
 */

export interface BillsPot {
  spaceId: string;
  assetId: string;
  /** Top the pot up from the main account when a standing order from it finds too little. */
  fallback: boolean;
  setAt: Date;
}

interface BillsPotRow {
  user_id: string;
  asset_id: string;
  space_id: string;
  fallback: boolean;
  set_at: Date;
}

const toBillsPot = (row: BillsPotRow): BillsPot => ({
  spaceId: row.space_id,
  assetId: row.asset_id,
  fallback: row.fallback,
  setAt: row.set_at,
});

export class BillsPotService {
  constructor(
    private readonly sql: Sql,
    private readonly spaces: SpaceService,
  ) {}

  /**
   * Make one of the person's own live named spaces their bills pot for its asset, with the fallback on or off. Any other
   * bills pot of that asset gives the role up.
   */
  async set(userId: string, spaceId: string, fallback: boolean): Promise<BillsPot> {
    // The space's row lock orders this against archiving it, which ends the role in its own transaction.
    return this.spaces.underRowLock(async (tx) => {
      const space = await this.spaces.ownPotForUpdate(tx, spaceId, userId);
      const [row] = await tx<BillsPotRow[]>`
        INSERT INTO bank.bills_pots (user_id, asset_id, space_id, fallback)
        VALUES (${userId}, ${space.assetId}, ${spaceId}::uuid, ${fallback})
        ON CONFLICT (user_id, asset_id) DO UPDATE SET space_id = EXCLUDED.space_id, fallback = EXCLUDED.fallback, set_at = now()
        RETURNING user_id, asset_id, space_id, fallback, set_at
      `;
      return toBillsPot(row!);
    });
  }

  /** The space stops being a bills pot; its money stays where it is. Not a bills pot changes nothing. */
  async clear(userId: string, spaceId: string): Promise<void> {
    const space = await this.spaces.get(spaceId);
    if (space.userId !== userId) throw new BankError(`Space ${spaceId} not found`, 'bank.space_not_found');
    await this.sql`DELETE FROM bank.bills_pots WHERE user_id = ${userId} AND space_id = ${spaceId}::uuid`;
  }

  /** The person's bills pots, one per asset at most. */
  async list(userId: string): Promise<BillsPot[]> {
    const rows = await this.sql<BillsPotRow[]>`
      SELECT b.user_id, b.asset_id, b.space_id, b.fallback, b.set_at
        FROM bank.bills_pots b JOIN bank.spaces s ON s.id = b.space_id
       WHERE b.user_id = ${userId} AND s.archived_at IS NULL
       ORDER BY b.asset_id
    `;
    return rows.map(toBillsPot);
  }

  /** The bills pot role of one space, or null. Read on the caller's connection so a standing order sees its own claim. */
  async forSpace(spaceId: string, db: Sql = this.sql): Promise<BillsPot | null> {
    const rows = await db<BillsPotRow[]>`
      SELECT b.user_id, b.asset_id, b.space_id, b.fallback, b.set_at
        FROM bank.bills_pots b JOIN bank.spaces s ON s.id = b.space_id
       WHERE b.space_id = ${spaceId}::uuid AND s.archived_at IS NULL
    `;
    return rows[0] ? toBillsPot(rows[0]) : null;
  }
}
