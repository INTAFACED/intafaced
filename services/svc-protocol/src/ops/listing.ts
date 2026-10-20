import type { ListingState, ProtocolOpsAction } from '@intafaced/contracts';

/** A pool or a market. A hide is a LISTING decision: it never pauses a contract and never touches a balance. */
export type ListingKind = 'pool' | 'market';

export interface ListingRow {
  readonly kind: ListingKind;
  readonly targetId: string;
  readonly state: ListingState;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly approvalId: string;
  readonly policyVersion: string;
  readonly updatedAt: Date;
}

export interface ListingDecision {
  readonly idempotencyKey: string;
  readonly action: ProtocolOpsAction;
  readonly kind: ListingKind;
  readonly targetId: string;
  readonly outcome: 'applied' | 'noop';
  readonly note: string | null;
  readonly state: ListingState;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly approvalId: string;
  readonly requesterId: string;
  readonly approverId: string;
  readonly policyVersion: string;
}

export interface ListingStore {
  state(kind: ListingKind, targetId: string): Promise<ListingRow | null>;
  decision(idempotencyKey: string): Promise<ListingDecision | null>;
  list(kind: ListingKind): Promise<ListingRow[]>;
  /**
   * One transaction: append the decision and, when it applied, set the state. A decision whose key already exists is
   * not written twice: the stored one comes back.
   */
  record(decision: ListingDecision, row: Omit<ListingRow, 'updatedAt'> | null): Promise<ListingDecision>;
}

export class InMemoryListingStore implements ListingStore {
  private readonly rows = new Map<string, ListingRow>();
  private readonly decisions = new Map<string, ListingDecision>();
  private readonly key = (kind: ListingKind, targetId: string) => `${kind}:${targetId}`;

  async state(kind: ListingKind, targetId: string) {
    return this.rows.get(this.key(kind, targetId)) ?? null;
  }
  async decision(idempotencyKey: string) {
    return this.decisions.get(idempotencyKey) ?? null;
  }
  async list(kind: ListingKind) {
    return [...this.rows.values()].filter((row) => row.kind === kind);
  }
  async record(decision: ListingDecision, row: Omit<ListingRow, 'updatedAt'> | null) {
    const stored = this.decisions.get(decision.idempotencyKey);
    if (stored) return stored;
    this.decisions.set(decision.idempotencyKey, decision);
    if (row) this.rows.set(this.key(row.kind, row.targetId), { ...row, updatedAt: new Date() });
    return decision;
  }
}
