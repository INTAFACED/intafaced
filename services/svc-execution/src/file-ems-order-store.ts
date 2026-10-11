/**
 * File-backed EMS order-ack journal — survives process restart (D29).
 *
 * JSONL append-only log. Missing file is an honest empty journal, not invented acks.
 * A blank or whitespace clientOrderId refuses. The ack is not written and not kept.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { EmsOrderEvidence, EmsOrderStore, EmsListFilter } from './oms-ems-store.js';

export const EXECUTION_EMS_CLIENT_ORDER_ID_REQUIRED = 'execution.ems_client_order_id_required' as const;

/** Blank clientOrderId — the venue ack is not stored, and the caller can see the refusal. */
export class EmsClientOrderIdRequiredError extends Error {
  readonly code = EXECUTION_EMS_CLIENT_ORDER_ID_REQUIRED;

  constructor() {
    super('clientOrderId is blank — refusing to journal the venue ack');
    this.name = 'EmsClientOrderIdRequiredError';
  }
}

type StoredLine = {
  readonly clientOrderId: string;
  readonly requestFingerprint?: string;
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly childOrderId?: string;
  readonly legIndex?: number;
  readonly account?: string;
  readonly session?: string;
  readonly venueId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly execution: {
    readonly venueId: string;
    readonly venueOrderId: string;
    readonly filledAmount: string;
    readonly remainingAmount?: string;
    readonly averagePrice: string | null;
    readonly feeAmount: string;
    readonly feeAsset: string;
    readonly status: 'filled' | 'partial' | 'rejected';
    readonly executedAt: string;
  } | null;
  readonly state?: EmsOrderEvidence['state'];
  readonly drainedRemaining?: string;
  readonly commandOutcome?: EmsOrderEvidence['commandOutcome'];
  readonly reconciliationKey?: string | null;
  readonly recordedAtMs: number;
};

function toStoredLine(ack: EmsOrderEvidence): StoredLine {
  return {
    clientOrderId: ack.clientOrderId,
    ...(ack.requestFingerprint !== undefined ? { requestFingerprint: ack.requestFingerprint } : {}),
    ...(ack.parentClientOrderId !== undefined ? { parentClientOrderId: ack.parentClientOrderId } : {}),
    ...(ack.executionGroupId !== undefined ? { executionGroupId: ack.executionGroupId } : {}),
    ...(ack.childOrderId !== undefined ? { childOrderId: ack.childOrderId } : {}),
    ...(ack.legIndex !== undefined ? { legIndex: ack.legIndex } : {}),
    ...(ack.account !== undefined ? { account: ack.account } : {}),
    ...(ack.session !== undefined ? { session: ack.session } : {}),
    venueId: ack.venueId,
    symbol: ack.symbol,
    side: ack.side,
    execution: ack.execution
      ? {
          venueId: ack.execution.venueId,
          venueOrderId: ack.execution.venueOrderId,
          filledAmount: formatAmount(ack.execution.filledAmount),
          ...(ack.execution.remainingAmount !== undefined ? { remainingAmount: formatAmount(ack.execution.remainingAmount) } : {}),
          averagePrice: ack.execution.averagePrice === null ? null : formatAmount(ack.execution.averagePrice),
          feeAmount: formatAmount(ack.execution.feeAmount),
          feeAsset: ack.execution.feeAsset,
          status: ack.execution.status,
          executedAt: ack.execution.executedAt instanceof Date ? ack.execution.executedAt.toISOString() : String(ack.execution.executedAt),
        }
      : null,
    ...(ack.state !== undefined ? { state: ack.state } : {}),
    ...(ack.drainedRemaining !== undefined ? { drainedRemaining: formatAmount(ack.drainedRemaining) } : {}),
    ...(ack.commandOutcome !== undefined ? { commandOutcome: ack.commandOutcome } : {}),
    reconciliationKey: ack.reconciliationKey ?? null,
    recordedAtMs: ack.recordedAtMs,
  };
}

function fromStoredLine(line: StoredLine): EmsOrderEvidence {
  return {
    clientOrderId: line.clientOrderId,
    requestFingerprint: line.requestFingerprint,
    parentClientOrderId: line.parentClientOrderId,
    executionGroupId: line.executionGroupId,
    childOrderId: line.childOrderId,
    legIndex: line.legIndex,
    account: line.account,
    session: line.session,
    venueId: line.venueId,
    symbol: line.symbol,
    side: line.side,
    execution: line.execution
      ? {
          venueId: line.execution.venueId,
          venueOrderId: line.execution.venueOrderId,
          filledAmount: parseAmount(line.execution.filledAmount),
          ...(line.execution.remainingAmount !== undefined ? { remainingAmount: parseAmount(line.execution.remainingAmount) } : {}),
          averagePrice: line.execution.averagePrice === null ? null : parseAmount(line.execution.averagePrice),
          feeAmount: parseAmount(line.execution.feeAmount),
          feeAsset: line.execution.feeAsset,
          status: line.execution.status,
          executedAt: new Date(line.execution.executedAt),
        }
      : null,
    state: line.state,
    drainedRemaining: line.drainedRemaining === undefined ? undefined : parseAmount(line.drainedRemaining),
    commandOutcome: line.commandOutcome,
    reconciliationKey: line.reconciliationKey ?? null,
    recordedAtMs: line.recordedAtMs,
  };
}

function normalizeAck(input: Omit<EmsOrderEvidence, 'recordedAtMs'> & { readonly recordedAtMs?: number }): EmsOrderEvidence {
  const clientOrderId = input.clientOrderId.trim();
  if (!clientOrderId) throw new EmsClientOrderIdRequiredError();
  return {
    clientOrderId,
    requestFingerprint: input.requestFingerprint,
    parentClientOrderId: input.parentClientOrderId,
    executionGroupId: input.executionGroupId,
    childOrderId: input.childOrderId,
    legIndex: input.legIndex,
    account: input.account,
    session: input.session,
    venueId: input.venueId,
    symbol: input.symbol,
    side: input.side,
    execution: input.execution,
    state: input.state,
    drainedRemaining: input.drainedRemaining,
    commandOutcome: input.commandOutcome,
    reconciliationKey: input.reconciliationKey ?? null,
    recordedAtMs: input.recordedAtMs ?? Date.now(),
  };
}

export class FileEmsOrderStore implements EmsOrderStore {
  private readonly byClientOrderId = new Map<string, EmsOrderEvidence>();

  constructor(private readonly filePath: string) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed) as StoredLine;
        const ack = fromStoredLine(parsed);
        this.byClientOrderId.set(ack.clientOrderId, ack);
      }
    }
  }

  record(input: Omit<EmsOrderEvidence, 'recordedAtMs'> & { readonly recordedAtMs?: number }): void {
    const ack = normalizeAck(input);
    appendFileSync(this.filePath, `${JSON.stringify(toStoredLine(ack))}\n`, 'utf8');
    this.byClientOrderId.set(ack.clientOrderId, ack);
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
