/**
 * COD / split-brain / dual-control fence. Wraps MatchingEngine after the class exists.
 * Partial mass-cancel and session-dead survive one throw. Declared split-brain refuses submit/amend.
 * halt/resume and haltAll/resumeAll require two distinct operator identities. Cancels stay.
 */
import { formatAmount } from '@intafaced/ledger-client/money';
import { MatchingEngine } from './engine.js';
import { dualControlRefuse, readConfirmOperatorId, readOperatorId } from './halt.js';
import {
  cancelFailureReason,
  cancelIdsIndependently,
  liveOwnedFromState,
  massCancelSessionRefuse,
  ownedOrderIds,
  readMassCancelSide,
  readSessionId,
  type CancelFailure,
} from './mass-cancel.js';
import { liveSessionFromState, missingSessionRefuse, sessionOrderIds } from './session.js';
import { refusedSplitBrain, replaySplitBrain, splitBrainAmendResult, splitBrainSubmitResult } from './split-brain.js';
import type {
  AmendResult,
  CancelledRef,
  EngineAmend,
  EngineOrder,
  MarketHaltResult,
  MarketId,
  MassCancelResult,
  OrderId,
  OrderSide,
  SessionDeadResult,
  SplitBrainResult,
  SubmitResult,
  VenueKillResult,
} from './types.js';

const FLAG = Symbol.for('intafaced.matching.cod-fence');
const SPLIT_BRAIN = Symbol.for('intafaced.matching.split-brain');

type DualCmd = { readonly operatorId?: string | null; readonly confirmOperatorId?: string | null };
type Host = {
  [SPLIT_BRAIN]?: boolean;
  journal?: { append(command: Record<string, unknown>): unknown; read(): readonly { readonly kind: string }[] };
  clock?: () => Date;
  deadSessions?: Set<string>;
  emit?(events: readonly unknown[]): Promise<void>;
  maybeSnapshot?(): Promise<void>;
  dropIfNeverTraded?(marketId: MarketId): void;
};

function asHost(engine: MatchingEngine): Host {
  return engine as unknown as Host;
}

type BookCancel = (orderId: OrderId, reason?: string) => { readonly cancellation: CancelledRef | null };

function cancelledEvent(marketId: MarketId, cancellation: CancelledRef) {
  return {
    sequence: cancellation.sequence,
    name: 'orderCancelled' as const,
    payload: {
      orderId: cancellation.orderId,
      marketId,
      remainingQty: formatAmount(cancellation.remainingQty),
      sequence: cancellation.sequence,
      reason: cancellation.reason,
    },
    key: `matching.order.cancelled:${marketId}:${cancellation.sequence}`,
  };
}

function readJournal(
  host: Host,
): { append(command: Record<string, unknown>): unknown; read(): readonly { readonly kind: string }[] } | null {
  const journal = host.journal;
  if (journal && typeof journal.read === 'function' && typeof journal.append === 'function') return journal;
  return null;
}

function atOf(host: Host): string {
  return (host.clock ?? (() => new Date()))().toISOString();
}

function splitBrainOn(host: Host): boolean {
  return host[SPLIT_BRAIN] === true;
}

function applySplitBrain(host: Host, declared: boolean): void {
  host[SPLIT_BRAIN] = declared;
}

async function declareOrClear(host: Host, cmd: DualCmd, kind: 'split_brain' | 'clear_split_brain'): Promise<SplitBrainResult> {
  const declared = kind === 'split_brain';
  const refused = refusedSplitBrain(cmd, splitBrainOn(host));
  if (refused) return refused;
  const operatorId = readOperatorId(cmd)!;
  const confirmOperatorId = readConfirmOperatorId(cmd)!;
  readJournal(host)?.append({ kind, at: atOf(host), operatorId, confirmOperatorId });
  applySplitBrain(host, declared);
  return { accepted: true, splitBrain: declared, operatorId, confirmOperatorId };
}

export function installCodFence(ctor: typeof MatchingEngine = MatchingEngine): void {
  if (!ctor) return;
  const proto = ctor.prototype as unknown as {
    submit: (marketId: MarketId, order: EngineOrder, proof?: unknown) => Promise<SubmitResult>;
    amend: (marketId: MarketId, cmd: EngineAmend, proof?: unknown) => Promise<AmendResult>;
    halt: (marketId: MarketId, cmd: DualCmd) => Promise<MarketHaltResult>;
    resume: (marketId: MarketId, cmd: DualCmd) => Promise<MarketHaltResult>;
    haltAll: (cmd: DualCmd) => Promise<VenueKillResult>;
    resumeAll: (cmd: DualCmd) => Promise<VenueKillResult>;
    massCancel: (
      marketId: MarketId,
      cmd: { readonly accountId: string; readonly sessionId?: string | null; readonly side?: OrderSide | null },
    ) => Promise<MassCancelResult>;
    sessionDead: (cmd: { readonly sessionId?: string | null }) => Promise<SessionDeadResult>;
    recover: () => Promise<{ records: number; markets: number }>;
    cancel: (marketId: MarketId, orderId: OrderId) => Promise<{ cancellation: CancelledRef | null; rejected?: { message: string } }>;
    declareSplitBrain?: (cmd: DualCmd) => Promise<SplitBrainResult>;
    clearSplitBrain?: (cmd: DualCmd) => Promise<SplitBrainResult>;
    isSplitBrain?: boolean;
    [FLAG]?: boolean;
  };
  Object.defineProperty(proto, 'isSplitBrain', {
    get(this: MatchingEngine) {
      return splitBrainOn(asHost(this));
    },
    configurable: true,
  });
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origSubmit = proto.submit;
  const origAmend = proto.amend;
  const origHalt = proto.halt;
  const origResume = proto.resume;
  const origHaltAll = proto.haltAll;
  const origResumeAll = proto.resumeAll;
  const origRecover = proto.recover;

  proto.submit = async function (this: MatchingEngine, marketId, order, proof) {
    if (splitBrainOn(asHost(this))) return splitBrainSubmitResult(order.orderId);
    return origSubmit.call(this, marketId, order, proof);
  };

  proto.amend = async function (this: MatchingEngine, marketId, cmd, proof) {
    if (splitBrainOn(asHost(this))) return splitBrainAmendResult(cmd.orderId);
    return origAmend.call(this, marketId, cmd, proof);
  };

  proto.halt = async function (this: MatchingEngine, marketId, cmd) {
    const refuse = dualControlRefuse(readOperatorId(cmd), readConfirmOperatorId(cmd));
    if (refuse) {
      return {
        accepted: false,
        marketId,
        halted: this.isHalted(marketId),
        operatorId: readOperatorId(cmd),
        confirmOperatorId: readConfirmOperatorId(cmd),
        rejected: refuse,
      };
    }
    const result = await origHalt.call(this, marketId, cmd);
    return { ...result, confirmOperatorId: readConfirmOperatorId(cmd) };
  };

  proto.resume = async function (this: MatchingEngine, marketId, cmd) {
    const refuse = dualControlRefuse(readOperatorId(cmd), readConfirmOperatorId(cmd));
    if (refuse) {
      return {
        accepted: false,
        marketId,
        halted: this.isHalted(marketId),
        operatorId: readOperatorId(cmd),
        confirmOperatorId: readConfirmOperatorId(cmd),
        rejected: refuse,
      };
    }
    const result = await origResume.call(this, marketId, cmd);
    return { ...result, confirmOperatorId: readConfirmOperatorId(cmd) };
  };

  proto.haltAll = async function (this: MatchingEngine, cmd) {
    const refuse = dualControlRefuse(readOperatorId(cmd), readConfirmOperatorId(cmd));
    if (refuse) {
      return {
        accepted: false,
        halted: this.isVenueHalted,
        operatorId: readOperatorId(cmd),
        confirmOperatorId: readConfirmOperatorId(cmd),
        rejected: refuse,
      };
    }
    const result = await origHaltAll.call(this, cmd);
    return { ...result, confirmOperatorId: readConfirmOperatorId(cmd) };
  };

  proto.resumeAll = async function (this: MatchingEngine, cmd) {
    const refuse = dualControlRefuse(readOperatorId(cmd), readConfirmOperatorId(cmd));
    if (refuse) {
      return {
        accepted: false,
        halted: this.isVenueHalted,
        operatorId: readOperatorId(cmd),
        confirmOperatorId: readConfirmOperatorId(cmd),
        rejected: refuse,
      };
    }
    const result = await origResumeAll.call(this, cmd);
    return { ...result, confirmOperatorId: readConfirmOperatorId(cmd) };
  };

  proto.massCancel = async function (this: MatchingEngine, marketId, cmd) {
    const sessionRefuse = massCancelSessionRefuse(readSessionId(cmd));
    if (sessionRefuse) {
      return {
        accepted: false,
        accountId: cmd.accountId,
        cancellations: [],
        failed: [],
        rejected: { code: sessionRefuse.code, message: sessionRefuse.message },
      };
    }
    const existing = this.existingBook(marketId);
    if (!existing) return { accepted: true, accountId: cmd.accountId, cancellations: [], failed: [] };
    const side = readMassCancelSide(cmd);
    const ids = ownedOrderIds(cmd.accountId, liveOwnedFromState(existing.toState()), side);
    const host = asHost(this);
    readJournal(host)?.append({
      kind: 'mass_cancel',
      marketId,
      at: atOf(host),
      accountId: cmd.accountId,
      ...(side ? { side } : {}),
    });
    const cancellations: CancelledRef[] = [];
    const failed: CancelFailure[] = [];
    for (const orderId of ids) {
      try {
        const result = await this.cancel(marketId, orderId);
        if (result.cancellation) cancellations.push(result.cancellation);
        else failed.push({ orderId, reason: result.rejected?.message ?? 'cancel_failed' });
      } catch (err) {
        failed.push({ orderId, reason: cancelFailureReason(err) });
      }
    }
    host.dropIfNeverTraded?.(marketId);
    return { accepted: true, accountId: cmd.accountId, cancellations, failed };
  };

  proto.sessionDead = async function (this: MatchingEngine, cmd) {
    const sessionId = readSessionId(cmd);
    if (sessionId === null) {
      return { accepted: false, sessionId: null, cancellations: [], failed: [], rejected: missingSessionRefuse() };
    }
    const host = asHost(this);
    readJournal(host)?.append({ kind: 'session_dead', at: atOf(host), sessionId });
    host.deadSessions?.add(sessionId);
    const cancellations: CancelledRef[] = [];
    const failed: CancelFailure[] = [];
    const events: ReturnType<typeof cancelledEvent>[] = [];
    for (const marketId of this.markets) {
      const book = this.existingBook(marketId);
      if (!book) continue;
      try {
        const ids = sessionOrderIds(sessionId, liveSessionFromState(book.toState()));
        const cancel = book.cancel.bind(book) as BookCancel;
        const pulled = cancelIdsIndependently((orderId) => cancel(orderId, 'session_dead'), ids);
        for (const cancellation of pulled.cancellations) {
          cancellations.push(cancellation);
          events.push(cancelledEvent(marketId, cancellation));
        }
        failed.push(...pulled.failed);
        host.dropIfNeverTraded?.(marketId);
      } catch {
        // one book throwing must not abort the others
      }
    }
    if (events.length > 0) await host.emit?.(events);
    await host.maybeSnapshot?.();
    return { accepted: true, sessionId, cancellations, failed };
  };

  proto.recover = async function (this: MatchingEngine) {
    const result = await origRecover.call(this);
    const journal = readJournal(asHost(this));
    if (journal) applySplitBrain(asHost(this), replaySplitBrain(journal.read()));
    return result;
  };

  proto.declareSplitBrain = function (this: MatchingEngine, cmd: DualCmd) {
    return declareOrClear(asHost(this), cmd, 'split_brain');
  };

  proto.clearSplitBrain = function (this: MatchingEngine, cmd: DualCmd) {
    return declareOrClear(asHost(this), cmd, 'clear_split_brain');
  };
}

try {
  installCodFence();
} catch {
  queueMicrotask(() => installCodFence());
}
