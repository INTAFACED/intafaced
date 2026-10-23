/**
 * Per-asset pause of new borrow and new supply (BK-loan-07).
 *
 * The desk pauses an asset; `loans.open` and `earn.deposit` read that state
 * before anything else happens. Repay, top-up, release and withdraw never read
 * it, so a paused asset can still be wound down.
 *
 * This is a product pause owned by svc-bank. It sets neither the platform
 * posting freeze (svc-ledger) nor one account's freeze (svc-identity), and the
 * desk read names all three owners so nobody confuses them.
 *
 * No row means the asset has never been paused. A read that fails refuses the
 * operation (`bank.asset_pause_unreadable`): an unknown state is not "open".
 *
 * A change names the revision it was made against. The history row for
 * (asset, revision) carries the business key `ops-pause:<asset>:<revision>`, so
 * a retry of the same change replays and a different change on the same
 * revision refuses `bank.ops_revision_conflict`. A change also needs a second
 * person: an identity approval bound to the asset and the new state, consumed
 * before the write.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';

export interface AssetPauseState {
  assetId: string;
  borrowPaused: boolean;
  supplyPaused: boolean;
  /** 0 when the asset has never been paused. */
  revision: number;
  reason: string | null;
  approvedBy: string | null;
  updatedAt: string | null;
}

export interface AssetPauseChange {
  assetId: string;
  borrowPaused: boolean;
  supplyPaused: boolean;
  /** The revision the operator saw. The change becomes revision + 1. */
  expectedRevision: number;
  reason: string;
  /** Consumes the second person's approval; returns the approver id. */
  consume: () => Promise<string>;
}

interface PauseRow {
  asset_id: string;
  borrow_paused: boolean;
  supply_paused: boolean;
  revision: number;
  reason: string;
  approved_by: string;
  updated_at: Date;
}

interface HistoryRow {
  asset_id: string;
  revision: number;
  borrow_paused: boolean;
  supply_paused: boolean;
  reason: string;
  approved_by: string;
}

/** Owners of the three separate stops, as the desk shows them. */
export const PAUSE_OWNERS = {
  assetPause: 'svc-bank',
  postingFreeze: 'svc-ledger',
  accountFreeze: 'svc-identity',
} as const;

export function pauseChangeKey(assetId: string, revision: number): string {
  return `ops-pause:${assetId}:${revision}`;
}

function toState(row: PauseRow): AssetPauseState {
  return {
    assetId: row.asset_id,
    borrowPaused: row.borrow_paused,
    supplyPaused: row.supply_paused,
    revision: Number(row.revision),
    reason: row.reason,
    approvedBy: row.approved_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function neverPaused(assetId: string): AssetPauseState {
  return { assetId, borrowPaused: false, supplyPaused: false, revision: 0, reason: null, approvedBy: null, updatedAt: null };
}

export class AssetPauseService {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<AssetPauseState[]> {
    const rows = await this.sql<PauseRow[]>`
      SELECT asset_id, borrow_paused, supply_paused, revision, reason, approved_by, updated_at
        FROM bank.asset_pauses ORDER BY asset_id
    `;
    return rows.map(toState);
  }

  async state(assetId: string): Promise<AssetPauseState> {
    const rows = await this.sql<PauseRow[]>`
      SELECT asset_id, borrow_paused, supply_paused, revision, reason, approved_by, updated_at
        FROM bank.asset_pauses WHERE asset_id = ${assetId}
    `;
    return rows[0] ? toState(rows[0]) : neverPaused(assetId);
  }

  /** Pre-flight for a new loan. Every asset the loan touches must be open for borrow. */
  async assertBorrowOpen(assetIds: readonly string[]): Promise<void> {
    const paused = await this.pausedAmong(assetIds, 'borrow');
    if (paused.length > 0) {
      throw new BankError(`New borrowing is paused for ${paused.join(', ')}`, 'bank.asset_paused');
    }
  }

  /** Pre-flight for a new earn deposit. */
  async assertSupplyOpen(assetId: string): Promise<void> {
    const paused = await this.pausedAmong([assetId], 'supply');
    if (paused.length > 0) {
      throw new BankError(`New deposits are paused for ${assetId}`, 'bank.asset_paused');
    }
  }

  private async pausedAmong(assetIds: readonly string[], side: 'borrow' | 'supply'): Promise<string[]> {
    const unique = [...new Set(assetIds)];
    let rows: Array<{ asset_id: string; borrow_paused: boolean; supply_paused: boolean }>;
    try {
      rows = await this.sql<Array<{ asset_id: string; borrow_paused: boolean; supply_paused: boolean }>>`
        SELECT asset_id, borrow_paused, supply_paused FROM bank.asset_pauses WHERE asset_id = ANY(${unique})
      `;
    } catch {
      // The database detail is not a customer message; the code says enough to retry later.
      throw new BankError('The asset pause state could not be read, so the operation was refused', 'bank.asset_pause_unreadable');
    }
    return rows
      .filter((r) => (side === 'borrow' ? r.borrow_paused : r.supply_paused))
      .map((r) => r.asset_id)
      .sort();
  }

  async set(change: AssetPauseChange): Promise<AssetPauseState & { replayed: boolean }> {
    const reason = change.reason.trim();
    if (reason.length < 10) {
      throw new BankError(
        'An asset pause change needs a reason of at least 10 characters (bank.ops_reason_too_short)',
        'bank.ops_reason_too_short',
      );
    }
    if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0) {
      throw new BankError('expectedRevision must be the revision the desk read (0 for never paused)', 'bank.validation_failed');
    }
    const revision = change.expectedRevision + 1;

    const prior = await this.history(this.sql, change.assetId, revision);
    if (prior) return this.replay(prior, change, reason);

    const current = await this.state(change.assetId);
    if (current.revision !== change.expectedRevision) throw this.conflict(change.assetId, change.expectedRevision, current.revision);

    const approvedBy = await change.consume();

    return transaction(this.sql, async (tx) => {
      const locked = await tx<Array<{ revision: number }>>`
        SELECT revision FROM bank.asset_pauses WHERE asset_id = ${change.assetId} FOR UPDATE
      `;
      const now = locked[0] ? Number(locked[0].revision) : 0;
      if (now !== change.expectedRevision) {
        const raced = await this.history(tx, change.assetId, revision);
        if (raced) return this.replay(raced, change, reason);
        throw this.conflict(change.assetId, change.expectedRevision, now);
      }
      const inserted = await tx<HistoryRow[]>`
        INSERT INTO bank.asset_pause_history (asset_id, revision, change_key, borrow_paused, supply_paused, reason, approved_by)
        VALUES (${change.assetId}, ${revision}, ${pauseChangeKey(change.assetId, revision)}, ${change.borrowPaused},
                ${change.supplyPaused}, ${reason}, ${approvedBy})
        ON CONFLICT DO NOTHING
        RETURNING asset_id
      `;
      if (inserted.length === 0) {
        // A first-revision race: no row to lock, and the other change won the key.
        const raced = await this.history(tx, change.assetId, revision);
        if (raced) return this.replay(raced, change, reason);
        throw this.conflict(change.assetId, change.expectedRevision, revision);
      }
      const rows = await tx<PauseRow[]>`
        INSERT INTO bank.asset_pauses (asset_id, borrow_paused, supply_paused, revision, reason, approved_by, updated_at)
        VALUES (${change.assetId}, ${change.borrowPaused}, ${change.supplyPaused}, ${revision}, ${reason}, ${approvedBy}, now())
        ON CONFLICT (asset_id) DO UPDATE
          SET borrow_paused = EXCLUDED.borrow_paused, supply_paused = EXCLUDED.supply_paused, revision = EXCLUDED.revision,
              reason = EXCLUDED.reason, approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at
        RETURNING asset_id, borrow_paused, supply_paused, revision, reason, approved_by, updated_at
      `;
      return { ...toState(rows[0]!), replayed: false };
    });
  }

  /** Newest first. */
  async historyOf(assetId: string, limit: number): Promise<Array<Omit<AssetPauseState, 'updatedAt'> & { changeKey: string; at: string }>> {
    const rows = await this.sql<Array<HistoryRow & { change_key: string; created_at: Date }>>`
      SELECT asset_id, revision, change_key, borrow_paused, supply_paused, reason, approved_by, created_at
        FROM bank.asset_pause_history WHERE asset_id = ${assetId}
       ORDER BY revision DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      assetId: r.asset_id,
      revision: Number(r.revision),
      changeKey: r.change_key,
      borrowPaused: r.borrow_paused,
      supplyPaused: r.supply_paused,
      reason: r.reason,
      approvedBy: r.approved_by,
      at: r.created_at.toISOString(),
    }));
  }

  private async history(sql: Sql, assetId: string, revision: number): Promise<HistoryRow | null> {
    const rows = await sql<HistoryRow[]>`
      SELECT asset_id, revision, borrow_paused, supply_paused, reason, approved_by
        FROM bank.asset_pause_history WHERE change_key = ${pauseChangeKey(assetId, revision)}
    `;
    return rows[0] ?? null;
  }

  private async replay(prior: HistoryRow, change: AssetPauseChange, reason: string): Promise<AssetPauseState & { replayed: boolean }> {
    if (prior.borrow_paused !== change.borrowPaused || prior.supply_paused !== change.supplyPaused || prior.reason !== reason) {
      throw this.conflict(change.assetId, change.expectedRevision, Number(prior.revision));
    }
    return {
      assetId: prior.asset_id,
      borrowPaused: prior.borrow_paused,
      supplyPaused: prior.supply_paused,
      revision: Number(prior.revision),
      reason: prior.reason,
      approvedBy: prior.approved_by,
      updatedAt: null,
      replayed: true,
    };
  }

  private conflict(assetId: string, expected: number, actual: number): BankError {
    return new BankError(
      `Asset ${assetId} pause changed underneath this request (expected revision ${expected}, found ${actual}); read it again`,
      'bank.ops_revision_conflict',
    );
  }
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const pauseState = z.object({
  assetId: z.string(),
  borrowPaused: z.boolean(),
  supplyPaused: z.boolean(),
  revision: z.number().int(),
  reason: z.string().nullable(),
  approvedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** Desk read. Lists every asset that has ever been paused and names the owner of each stop. */
export function assetPausesProcedure(pauses: () => AssetPauseService, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(
      z.object({ historyFor: z.string().min(1).max(32).optional(), historyLimit: z.number().int().min(1).max(200).optional() }).optional(),
    )
    .output(
      z.object({
        owners: z.object({
          assetPause: z.literal('svc-bank'),
          postingFreeze: z.literal('svc-ledger'),
          accountFreeze: z.literal('svc-identity'),
        }),
        assets: z.array(pauseState),
        history: z.array(pauseState.omit({ updatedAt: true }).extend({ changeKey: z.string(), at: z.string() })),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        if (input?.historyFor !== undefined && input.historyLimit === undefined) {
          throw new BankError('historyLimit is required with historyFor; blank is not 50', 'bank.validation_failed');
        }
        const service = pauses();
        const assets = await service.list();
        const history = input?.historyFor !== undefined ? await service.historyOf(input.historyFor, input.historyLimit!) : [];
        return { owners: PAUSE_OWNERS, assets, history };
      }),
    );
}

export function setAssetPauseProcedure(
  pauses: () => AssetPauseService,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:treasury')
    .input(
      z.object({
        assetId: z.string().min(1).max(32),
        borrowPaused: z.boolean(),
        supplyPaused: z.boolean(),
        expectedRevision: z.number().int().min(0),
        reason: z.string(),
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
      }),
    )
    .output(pauseState.extend({ replayed: z.boolean() }))
    .mutation(({ input }) =>
      guard(() =>
        pauses().set({
          assetId: input.assetId,
          borrowPaused: input.borrowPaused,
          supplyPaused: input.supplyPaused,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          consume: () =>
            consumeOpsApproval(input, 'bank.ops.setAssetPause', {
              assetId: input.assetId,
              borrowPaused: String(input.borrowPaused),
              supplyPaused: String(input.supplyPaused),
              revision: String(input.expectedRevision + 1),
            }),
        }),
      ),
    );
}
