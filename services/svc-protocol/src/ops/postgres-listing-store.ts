import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ListingState, ProtocolOpsAction } from '@intafaced/contracts';
import { listingDecisions, listingOverrides } from '../db/schema.js';
import type { ListingDecision, ListingKind, ListingRow, ListingStore } from './listing.js';

type Schema = { listingOverrides: typeof listingOverrides; listingDecisions: typeof listingDecisions };

const toRow = (row: typeof listingOverrides.$inferSelect): ListingRow => ({
  kind: row.kind as ListingKind,
  targetId: row.targetId,
  state: row.state as ListingState,
  reasonCode: row.reasonCode,
  reason: row.reason,
  approvalId: row.approvalId,
  policyVersion: row.policyVersion,
  updatedAt: row.updatedAt,
});

/** `state` is not stored on a decision row: it is the state the target was in after the decision. */
const stateOf = (action: ProtocolOpsAction): ListingState =>
  action === 'protocol.pool.hide' || action === 'protocol.market.delist' ? 'hidden' : 'visible';

const toDecision = (row: typeof listingDecisions.$inferSelect): ListingDecision => ({
  idempotencyKey: row.idempotencyKey,
  action: row.action as ProtocolOpsAction,
  kind: row.kind as ListingKind,
  targetId: row.targetId,
  outcome: row.outcome as 'applied' | 'noop',
  note: row.note,
  state: stateOf(row.action as ProtocolOpsAction),
  reasonCode: row.reasonCode,
  reason: row.reason,
  approvalId: row.approvalId,
  requesterId: row.requesterId,
  approverId: row.approverId,
  policyVersion: row.policyVersion,
});

export class PostgresListingStore implements ListingStore {
  constructor(private readonly db: PostgresJsDatabase<Schema>) {}

  async state(kind: ListingKind, targetId: string) {
    const [row] = await this.db
      .select()
      .from(listingOverrides)
      .where(and(eq(listingOverrides.kind, kind), eq(listingOverrides.targetId, targetId)))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async decision(idempotencyKey: string) {
    const [row] = await this.db.select().from(listingDecisions).where(eq(listingDecisions.idempotencyKey, idempotencyKey)).limit(1);
    return row ? toDecision(row) : null;
  }

  async list(kind: ListingKind) {
    const rows = await this.db.select().from(listingOverrides).where(eq(listingOverrides.kind, kind));
    return rows.map(toRow);
  }

  async record(decision: ListingDecision, row: Omit<ListingRow, 'updatedAt'> | null) {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(listingDecisions)
        .values({
          idempotencyKey: decision.idempotencyKey,
          action: decision.action,
          kind: decision.kind,
          targetId: decision.targetId,
          outcome: decision.outcome,
          note: decision.note,
          reasonCode: decision.reasonCode,
          reason: decision.reason,
          approvalId: decision.approvalId,
          requesterId: decision.requesterId,
          approverId: decision.approverId,
          policyVersion: decision.policyVersion,
        })
        .onConflictDoNothing({ target: listingDecisions.idempotencyKey })
        .returning();
      if (inserted.length === 0) {
        const [stored] = await tx
          .select()
          .from(listingDecisions)
          .where(eq(listingDecisions.idempotencyKey, decision.idempotencyKey))
          .limit(1);
        if (!stored) throw new Error('protocol.listing_decisions: conflict without a stored row');
        return toDecision(stored);
      }
      if (row) {
        await tx
          .insert(listingOverrides)
          .values({ ...row, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [listingOverrides.kind, listingOverrides.targetId],
            set: {
              state: row.state,
              reasonCode: row.reasonCode,
              reason: row.reason,
              approvalId: row.approvalId,
              policyVersion: row.policyVersion,
              updatedAt: new Date(),
            },
          });
      }
      return decision;
    });
  }
}
