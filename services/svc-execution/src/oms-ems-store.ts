/**
 * In-memory EMS order-ack journal — clientOrderId → venue execution state.
 *
 * Records venue acks from the execute path only. Does not invent fills or
 * statuses. Missing entry is an honest miss, not a synthetic ack.
 */
import type { VenueExecution } from '@intafaced/venue-adapter';
import type { ExecutionCommandOutcome } from '@intafaced/exchange-contract';
import type { Amount } from '@intafaced/ledger-client';

export type EmsOrderState =
  | 'ACKNOWLEDGED'
  | 'REJECTED'
  | 'UNWIRED'
  | 'SUBMIT_UNKNOWN'
  | 'OUTCOME_UNKNOWN'
  /** Venue confirmed cancel — not a failed hedge. */
  | 'CANCELED';

export type EmsOrderAck = {
  readonly clientOrderId: string;
  /** Fingerprint of the caller command (symbol/side/amount/route), not an identity generator. */
  readonly requestFingerprint?: string;
  /** Stable parent/execution-group lineage, retained for recovery and audit. */
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly childOrderId?: string;
  readonly legIndex?: number;
  /** Operator-kill scope. Copied from execute tenantId when present. Never invented. */
  readonly account?: string;
  /** Operator-kill scope. Copied from executionGroupId. Never invented. */
  readonly session?: string;
  readonly venueId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly execution: VenueExecution;
  readonly state?: EmsOrderState;
  /** Remaining quantity observed on a confirmed terminal cancel response. Legacy rows stay unknown. */
  readonly drainedRemaining?: Amount;
  readonly commandOutcome?: ExecutionCommandOutcome;
  /** Durable lookup key for SUBMIT_UNKNOWN/OUTCOME_UNKNOWN children. */
  readonly reconciliationKey?: string | null;
  readonly recordedAtMs: number;
};

/** EMS evidence may intentionally have no VenueExecution for unknown/unwired children. */
export type EmsOrderEvidence = Omit<EmsOrderAck, 'execution'> & { readonly execution: VenueExecution | null };

export type EmsListFilter = {
  readonly venueId?: string;
  readonly symbol?: string;
  readonly executionGroupId?: string;
  readonly parentClientOrderId?: string;
  readonly state?: EmsOrderState;
  readonly reconciliationKey?: string;
  readonly account?: string;
  readonly session?: string;
};

export interface EmsOrderStore {
  record(input: Omit<EmsOrderEvidence, 'recordedAtMs'> & { readonly recordedAtMs?: number }): void;
  /** Full evidence lookup, including an unresolved child with no execution. */
  get(clientOrderId: string): EmsOrderEvidence | null;
  getByReconciliationKey(reconciliationKey: string): EmsOrderEvidence | null;
  list(filter?: EmsListFilter): readonly EmsOrderEvidence[];
}

export class InMemoryEmsOrderStore implements EmsOrderStore {
  private readonly byClientOrderId = new Map<string, EmsOrderEvidence>();

  record(input: Omit<EmsOrderEvidence, 'recordedAtMs'> & { readonly recordedAtMs?: number }): void {
    const clientOrderId = input.clientOrderId.trim();
    if (!clientOrderId) return;
    this.byClientOrderId.set(clientOrderId, {
      clientOrderId,
      requestFingerprint: input.requestFingerprint,
      parentClientOrderId: input.parentClientOrderId,
      executionGroupId: input.executionGroupId,
      childOrderId: input.childOrderId,
      legIndex: input.legIndex,
      account: input.account,
      session: input.session ?? input.executionGroupId,
      venueId: input.venueId,
      symbol: input.symbol,
      side: input.side,
      execution: input.execution,
      state: input.state,
      drainedRemaining: input.drainedRemaining,
      commandOutcome: input.commandOutcome,
      reconciliationKey: input.reconciliationKey ?? null,
      recordedAtMs: input.recordedAtMs ?? Date.now(),
    });
  }

  get(clientOrderId: string): EmsOrderEvidence | null {
    const id = clientOrderId.trim();
    if (!id) return null;
    return this.byClientOrderId.get(id) ?? null;
  }

  getByReconciliationKey(reconciliationKey: string): EmsOrderEvidence | null {
    const key = reconciliationKey.trim();
    if (!key) return null;
    return [...this.byClientOrderId.values()].find((row) => row.reconciliationKey === key) ?? null;
  }

  list(filter: EmsListFilter = {}): readonly EmsOrderEvidence[] {
    let rows = [...this.byClientOrderId.values()];
    const venueId = filter.venueId?.trim();
    const symbol = filter.symbol?.trim();
    const executionGroupId = filter.executionGroupId?.trim();
    const parentClientOrderId = filter.parentClientOrderId?.trim();
    const reconciliationKey = filter.reconciliationKey?.trim();
    const account = filter.account?.trim();
    const session = filter.session?.trim();
    if (venueId) rows = rows.filter((row) => row.venueId === venueId);
    if (symbol) rows = rows.filter((row) => row.symbol === symbol);
    if (executionGroupId) rows = rows.filter((row) => row.executionGroupId === executionGroupId);
    if (parentClientOrderId) rows = rows.filter((row) => row.parentClientOrderId === parentClientOrderId);
    if (filter.state) rows = rows.filter((row) => row.state === filter.state);
    if (reconciliationKey) rows = rows.filter((row) => row.reconciliationKey === reconciliationKey);
    if (account) rows = rows.filter((row) => row.account === account);
    if (session) rows = rows.filter((row) => row.session === session || row.executionGroupId === session);
    return rows;
  }
}
