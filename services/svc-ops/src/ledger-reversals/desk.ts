import {
  OPS_LEDGER_REVERSE_ACTION,
  OPS_LEDGER_REVERSE_TARGET_SERVICE,
  opsReversalApprovalFields,
  opsReversalTargetId,
  type OpsLedgerReversal,
  type OpsReversalExecuteInput,
  type OpsReversalList,
  type OpsReversalRequestInput,
} from '@intafaced/contracts/ops-ledger-reversals';
import {
  OPS_REVERSAL_ALREADY_REVERSED,
  OPS_REVERSAL_LEDGER_UNCONFIGURED,
  OPS_REVERSAL_NOT_FOUND,
  OPS_REVERSAL_REQUESTER_ONLY,
  OPS_REVERSAL_SAME_PERSON,
  OPS_REVERSAL_STATE_ILLEGAL,
  OPS_REVERSAL_STORAGE_UNCONFIGURED,
  OpsError,
} from '../codes.js';
import { consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import type { ReversalLedger, ReverseOutcome } from './ledger.js';
import type { FirstReversal, ReversalPatch, ReversalRow, ReversalStore } from './store.js';

export interface LedgerReversalDeskDeps {
  readonly store: ReversalStore | undefined;
  readonly ledger: ReversalLedger | undefined;
  readonly approvals: ApprovalConsumer | undefined;
  readonly now: () => Date;
  /** Called when the worker fails on one request; it carries on with the next. */
  readonly onWorkerError?: (requestNo: string, err: unknown) => void;
}

/** A send still `posting` this long after it went out has no live caller: its process died, and the worker sends it again. */
const IN_FLIGHT_MS = 60_000;
/** The worker sends a `pending_retry` request again this long after its last send. */
const RETRY_AFTER_MS = 30_000;

const open = (row: ReversalRow) => row.state === 'posting' || row.state === 'pending_retry';

function view(row: ReversalRow): OpsLedgerReversal {
  return {
    requestNo: row.requestNo,
    originalTxId: row.originalTxId,
    ordinal: row.ordinal,
    reason: row.reason,
    caseRef: row.caseRef,
    state: row.state,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    approverId: row.approverId,
    approvedAt: row.approvedAt,
    ledgerKey: row.ledgerKey,
    reversingTxId: row.reversingTxId,
    code: row.code,
    reversedBy: row.reversedBy,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt,
    settledAt: row.settledAt,
  };
}

function alreadyReversed(original: string, first: FirstReversal): OpsError {
  return new OpsError(
    OPS_REVERSAL_ALREADY_REVERSED,
    `Transaction ${original} is already reversed by ${first.reversingTxId} (reversal request ${first.requestNo}); a transaction is reversed once.`,
  );
}

/**
 * An operator's corrective reversal of a posted ledger transaction (OPS-ledger-desk-02; ENGINE LC-1 to LC-6, LG-2, LG-3).
 *
 * `request` writes the intent row first and nothing else: the original, the next ordinal for it, the reason and the case
 * reference, under the requester's name. It refuses `ops.reversal_already_reversed` when a reversal of that original is
 * known, posted here or named by the ledger refusing one of ours. `execute` spends a different person's approval of
 * exactly that request (`ops.ledger.reverse`, target `reversal:<requestNo>`, signed over the original, the reason and the
 * case reference) under the row's lock, moves the row to `posting`, then asks svc-ledger's `operatorReverse` door once,
 * outside the lock, and records the answer. The ledger builds the compensating transaction from its own stored original
 * under `ops:reversal:<originalTxId>:<ordinal>`; svc-ops sends no leg.
 *
 * A lost or unreadable reply and the posting freeze leave the row `pending_retry`. The next send, from the requester asking
 * again with the same approval or from the worker, is the stored key and body: never a new ordinal, never a second approval.
 * The door answers a key it booked with that booking, so a send after a lost reply cannot book twice. A proven refusal is
 * stored and settles the row; a new request for the same original takes the next ordinal and a new key.
 *
 * Known limit, the same as every console-mode founder action here: if this process dies after identity spends the approval
 * and before the row commits, the approval is spent and the row is still `intent`. A retry is refused
 * `action_approval.not_founders` (identity's replay of a spent approval carries no founder attestation); nothing posted, and
 * the founders issue a fresh approval of the same request.
 */
export class LedgerReversalDesk {
  constructor(private readonly deps: LedgerReversalDeskDeps) {}

  private store(): ReversalStore {
    if (!this.deps.store)
      throw new OpsError(
        OPS_REVERSAL_STORAGE_UNCONFIGURED,
        'No durable storage is configured for ledger reversals, so none can be asked for or read.',
      );
    return this.deps.store;
  }

  private ledger(): ReversalLedger {
    if (!this.deps.ledger)
      throw new OpsError(
        OPS_REVERSAL_LEDGER_UNCONFIGURED,
        'The ledger is not wired to this service, so no reversal can be asked for or run. Nothing was written.',
      );
    return this.deps.ledger;
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }

  /** Whether the worker has anything to work with: storage and the ledger are both wired. */
  get active(): boolean {
    return this.deps.store !== undefined && this.deps.ledger !== undefined;
  }

  async request(requesterId: string, input: OpsReversalRequestInput): Promise<OpsLedgerReversal> {
    const store = this.store();
    this.ledger();
    const original = input.originalTxId.toLowerCase();
    const outcome = await store.request({
      originalTxId: original,
      reason: input.reason,
      caseRef: input.caseRef,
      requestedBy: requesterId,
      at: this.iso(),
    });
    if (outcome.kind === 'reversed') throw alreadyReversed(original, outcome.first);
    return view(outcome.row);
  }

  async get(requestNo: string): Promise<OpsLedgerReversal> {
    const row = await this.store().get(requestNo);
    if (!row) throw new OpsError(OPS_REVERSAL_NOT_FOUND, `No reversal request has number ${requestNo}.`);
    return view(row);
  }

  async list(originalTxId: string, limit: number): Promise<OpsReversalList> {
    const rows = await this.store().list(originalTxId.toLowerCase(), limit);
    return { reversals: rows.map(view), asOf: this.iso() };
  }

  async execute(callerId: string, input: OpsReversalExecuteInput): Promise<OpsLedgerReversal> {
    const store = this.store();
    this.ledger();
    const approvalId = input.approvalId.trim();
    const claimed = await store.update(input.requestNo, async (row, first) => {
      if (row.approvalId !== null) {
        // The same approval again is the requester asking again (a lost reply): answer from the row, send nothing new.
        if (row.approvalId !== approvalId)
          throw new OpsError(OPS_REVERSAL_STATE_ILLEGAL, `Reversal request ${row.requestNo} was already run with another approval.`);
        return { result: false };
      }
      if (callerId.trim().toLowerCase() !== row.requestedBy.trim().toLowerCase())
        throw new OpsError(
          OPS_REVERSAL_REQUESTER_ONLY,
          'Only the person who asked for this reversal runs it, with a different person’s approval.',
        );
      // Checked before the approval is spent, so a second reversal of the same original spends nothing.
      if (first) throw alreadyReversed(row.originalTxId, first);
      const consumed = await consumeFounderApproval(differentApprover(this.deps.approvals, row.requestedBy), {
        approvalId,
        operationId: input.operationId,
        requestId: `ops-reversal:${row.requestNo}`,
        actionType: OPS_LEDGER_REVERSE_ACTION,
        targetService: OPS_LEDGER_REVERSE_TARGET_SERVICE,
        targetId: opsReversalTargetId(row.requestNo),
        fields: opsReversalApprovalFields(row),
        requesterId: row.requestedBy,
      });
      const patch: ReversalPatch = {
        state: 'posting',
        approvalId: consumed.approvalId,
        approverId: consumed.approverId ?? null,
        approvedAt: this.iso(),
      };
      return { patch, result: true };
    });
    if (claimed === null) throw new OpsError(OPS_REVERSAL_NOT_FOUND, `No reversal request has number ${input.requestNo}.`);
    await this.send(input.requestNo, claimed.result ? 'claimed' : 'asked_again');
    return this.get(input.requestNo);
  }

  /** Send every open request again whose last send is old enough: the same key and body, never a new one. */
  async resolve(limit = 20): Promise<number> {
    const store = this.store();
    this.ledger();
    let sent = 0;
    for (const requestNo of await store.due(new Date(this.deps.now().getTime() - RETRY_AFTER_MS).toISOString(), limit)) {
      try {
        if (await this.send(requestNo, 'worker')) sent += 1;
      } catch (err) {
        this.deps.onWorkerError?.(requestNo, err);
      }
    }
    return sent;
  }

  /**
   * One send of the stored request under its key, its answer recorded. `claimed`: the approval was just spent. `asked_again`:
   * the requester asks again with the same approval: a `pending_retry` row is sent now. `worker`: sent when due. A row still
   * `posting` is sent again only once its last send is older than the in-flight bound (its sender died).
   */
  private async send(requestNo: string, why: 'claimed' | 'asked_again' | 'worker'): Promise<boolean> {
    const store = this.store();
    const ledger = this.ledger();
    const now = this.deps.now().getTime();
    const sending = await store.update(requestNo, async (row) => {
      if (!open(row)) return { result: null };
      const stale = row.lastAttemptAt === null || Date.parse(row.lastAttemptAt) + IN_FLIGHT_MS <= now;
      const go =
        row.state === 'posting'
          ? (why === 'claimed' && row.attempts === 0) || stale
          : why === 'asked_again' || row.lastAttemptAt === null || Date.parse(row.lastAttemptAt) + RETRY_AFTER_MS <= now;
      if (!go) return { result: null };
      return { patch: { state: 'posting', attempts: row.attempts + 1, lastAttemptAt: this.iso() }, result: row };
    });
    const row = sending?.result;
    if (!row) return false;
    const outcome: ReverseOutcome = await ledger
      .reverse({ originalTxId: row.originalTxId, ordinal: row.ordinal, reason: row.reason, caseRef: row.caseRef }, row.ledgerKey)
      .catch((): ReverseOutcome => ({ kind: 'retry', code: 'ledger.reply_lost' }));
    await store.update(requestNo, async (now) => {
      // Another send settled it first: the book has one answer for the key, and the first one recorded stands.
      if (!open(now)) return { result: null };
      const at = this.iso();
      if (outcome.kind === 'posted')
        return { patch: { state: 'posted', reversingTxId: outcome.txId, code: null, settledAt: at }, result: null };
      if (outcome.kind === 'refused')
        return { patch: { state: 'refused', code: outcome.code, reversedBy: outcome.reversedBy, settledAt: at }, result: null };
      return { patch: { state: 'pending_retry', code: outcome.code }, result: null };
    });
    return true;
  }
}

/** Identity refuses the requester approving their own request; svc-ops refuses it again on the approval it spends. */
function differentApprover(approvals: ApprovalConsumer | undefined, requesterId: string): ApprovalConsumer | undefined {
  if (!approvals) return undefined;
  return {
    async consume(input) {
      const row = await approvals.consume(input);
      const approver = row.approverId?.trim().toLowerCase() ?? '';
      if (approver === '' || approver === requesterId.trim().toLowerCase())
        throw new OpsError(
          OPS_REVERSAL_SAME_PERSON,
          'The approval was given by the person who asked for the reversal. Nothing was posted.',
        );
      return row;
    },
  };
}
