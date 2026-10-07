import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedDropCopyRecentLimit } from '../drop-copy-recent-limit.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import { isPublishedConnectionCeiling } from '../max-connections.js';
import { isPublishedMaxLagTicks } from '../max-lag-ticks.js';
import { DROP_COPY_COMMON_UPSTREAM_FAILURE, DROP_COPY_GAP, DROP_COPY_RECOVERY_REQUIRED } from '../gateway-policy.js';

export { DROP_COPY_COMMON_UPSTREAM_FAILURE, DROP_COPY_GAP, DROP_COPY_RECOVERY_REQUIRED };

/**
 * Independent drop-copy evidence stream (PX-S04 / PTX-M05-R03 bounded slice).
 *
 * Not the trading `/private/stream` orders/fills channel under a new name.
 * This hub never places or cancels. It assigns its own sequence domain.
 * Replay is not durable — connect always watermarks incompleteness instead of
 * pretending an empty session ring is a complete historical tape.
 */

export type DropCopySink = DepthSink;

export const DROP_COPY_CHANNEL = 'drop_copy' as const;

/** How complete this replica can honestly claim the tape is. Never `complete`. */
export type DropCopyCompleteness = 'SESSION' | 'RECOVERY_REQUIRED' | 'COMMON_UPSTREAM_FAILURE';

export interface DropCopyExecutionInput {
  readonly fillId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: string;
  readonly liquidity: string;
  readonly price: string;
  readonly qty: string;
  readonly quoteAmount: string;
  readonly feeAsset: string;
  readonly feeAmount: string;
  /** Matching/book sequence from `fillSettled` — provenance, not drop-copy seq. */
  readonly engineSequence: number;
  readonly ts: string;
}

export interface DropCopyExecution extends DropCopyExecutionInput {
  readonly dropCopySeq: number;
}

export interface DropCopyHubOptions {
  /** Owner-published lag buffer bound. Unset = unpublished; attach refuses. Never invent 1048576. */
  readonly highWaterBytes: number | undefined;
  /** Owner-published lag ticks. Unset = unpublished; attach refuses. Never invent 20. */
  readonly maxLagTicks: number | undefined;
  readonly maxConnections: number | undefined;
  readonly maxConnectionsPerUser?: number;
  /** Owner-published session-window replay. Unset = unpublished; attach refuses. Not durable history. */
  readonly recentLimit: number | undefined;
}

export interface DropCopyConnectHonesty {
  readonly bus: boolean;
  readonly completeness: DropCopyCompleteness;
  readonly replayDurable: false;
  readonly lastSeq: number;
}

const NO_LOG: HubLogger = { info: () => undefined, warn: () => undefined };

interface Subscription {
  readonly userId: string;
  readonly sink: DropCopySink;
  lagTicks: number;
  closed: boolean;
  hydrated: boolean;
  pending: string[];
  gapped: boolean;
}

export function dropCopyCompleteness(input: { readonly bus: boolean; readonly sessionExecutions: number }): DropCopyCompleteness {
  if (!input.bus) return 'COMMON_UPSTREAM_FAILURE';
  if (input.sessionExecutions > 0) return 'SESSION';
  return 'RECOVERY_REQUIRED';
}

export function isInventedCompleteEmptyDropCopy(frame: string): boolean {
  try {
    const rec = JSON.parse(frame) as Record<string, unknown>;
    if (rec.channel !== DROP_COPY_CHANNEL) return false;
    const empty = (Array.isArray(rec.executions) && rec.executions.length === 0) || (rec.type === 'execution' && rec.fillId == null);
    const claimsComplete = rec.completeness === 'complete' || rec.complete === true;
    return empty && claimsComplete;
  } catch {
    return false;
  }
}

/** Fill money on the wire: optional sign, digits, at most 18 fractional places. A JSON number is not money. */
const WIRE_DECIMAL = /^-?\d+(\.\d{1,18})?$/;

function isWireDecimal(value: unknown): value is string {
  return typeof value === 'string' && WIRE_DECIMAL.test(value);
}

export function encodeDropCopyExecutionFrame(execution: DropCopyExecution): string {
  return JSON.stringify({
    channel: DROP_COPY_CHANNEL,
    type: 'execution',
    fillId: execution.fillId,
    orderId: execution.orderId,
    userId: execution.userId,
    marketId: execution.marketId,
    side: execution.side,
    liquidity: execution.liquidity,
    price: execution.price,
    qty: execution.qty,
    quoteAmount: execution.quoteAmount,
    feeAsset: execution.feeAsset,
    feeAmount: execution.feeAmount,
    engineSequence: execution.engineSequence,
    dropCopySeq: execution.dropCopySeq,
    ts: execution.ts,
  });
}

export class DropCopyHub {
  readonly #options: DropCopyHubOptions;
  readonly #log: HubLogger;
  readonly #subscriptions = new Set<Subscription>();
  readonly #recent = new Map<string, DropCopyExecution[]>();
  readonly #seq = new Map<string, number>();
  readonly #seenFill = new Map<string, Set<string>>();

  #droppedFrames = 0;
  #evictions = 0;
  #executions = 0;
  #bus = false;

  constructor(options: DropCopyHubOptions, log: HubLogger = NO_LOG) {
    this.#options = options;
    this.#log = log;
  }

  get connections(): number {
    return this.#subscriptions.size;
  }

  get maxConnections(): number | undefined {
    return this.#options.maxConnections;
  }

  get maxConnectionsPerUser(): number | undefined {
    return this.#options.maxConnectionsPerUser;
  }

  /** Session replay length attach enforces. Unset = unpublished. */
  get recentLimit(): number | undefined {
    return this.#options.recentLimit;
  }

  get busAttached(): boolean {
    return this.#bus;
  }

  get stats(): {
    connections: number;
    executions: number;
    droppedFrames: number;
    evictions: number;
    bus: boolean;
    replayDurable: false;
  } {
    return {
      connections: this.#subscriptions.size,
      executions: this.#executions,
      droppedFrames: this.#droppedFrames,
      evictions: this.#evictions,
      bus: this.#bus,
      replayDurable: false,
    };
  }

  lastSeq(userId: string): number {
    return this.#seq.get(userId) ?? 0;
  }

  recentFor(userId: string): readonly DropCopyExecution[] {
    return this.#recent.get(userId) ?? [];
  }

  honesty(userId: string): DropCopyConnectHonesty {
    const recent = this.#recent.get(userId) ?? [];
    return {
      bus: this.#bus,
      completeness: dropCopyCompleteness({ bus: this.#bus, sessionExecutions: recent.length }),
      replayDurable: false,
      lastSeq: this.lastSeq(userId),
    };
  }

  /**
   * Drop-copy consumer attached (independent durable, not the private orders half).
   * Re-announces ready so seats that connected with bus:false see the truth.
   */
  announceBus(bus: boolean): void {
    this.#bus = bus;
    for (const sub of this.#subscriptions) {
      if (sub.closed) continue;
      this.#write(sub, this.#readyFrame(sub.userId));
      if (!bus) this.#write(sub, this.#statusFrame(sub.userId, DROP_COPY_COMMON_UPSTREAM_FAILURE));
    }
  }

  attach(userId: string, sink: DropCopySink): (() => void) | null {
    if (!isPublishedDropCopyRecentLimit(this.#options.recentLimit)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.dropCopyRecentLimitUnset));
      return null;
    }
    if (!isPublishedHighWaterBytes(this.#options.highWaterBytes)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.highWaterBytesUnset));
      return null;
    }
    if (!isPublishedMaxLagTicks(this.#options.maxLagTicks)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxLagTicksUnset));
      return null;
    }
    const max = this.#options.maxConnections;
    if (!isPublishedConnectionCeiling(max)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.maxConnectionsUnset));
      return null;
    }
    if (this.#subscriptions.size >= max) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.privateAtCapacity));
      return null;
    }

    const maxPerUser = this.#options.maxConnectionsPerUser;
    if (!isPublishedConnectionCeiling(maxPerUser)) {
      sink.close(CLOSE_POLICY, resolveWsCopy(WS_COPY.privateMaxConnectionsPerUserUnset));
      return null;
    }
    let forUser = 0;
    for (const existing of this.#subscriptions) {
      if (!existing.closed && existing.userId === userId) forUser++;
    }
    if (forUser >= maxPerUser) {
      sink.close(CLOSE_TRY_LATER, resolveWsCopy(WS_COPY.privateUserLimit));
      return null;
    }

    const sub: Subscription = {
      userId,
      sink,
      lagTicks: 0,
      closed: false,
      hydrated: false,
      pending: [],
      gapped: false,
    };
    this.#subscriptions.add(sub);
    this.#write(sub, this.#readyFrame(userId));
    this.#write(sub, this.#snapshotFrame(userId));
    if (!this.#bus) {
      this.#write(sub, this.#statusFrame(userId, DROP_COPY_COMMON_UPSTREAM_FAILURE));
    } else {
      this.#write(sub, this.#statusFrame(userId, DROP_COPY_RECOVERY_REQUIRED));
    }
    sub.hydrated = true;
    const queued = sub.pending;
    sub.pending = [];
    for (const frame of queued) this.#write(sub, frame);

    return () => {
      sub.closed = true;
      this.#subscriptions.delete(sub);
      this.#forgetIdleUser(userId);
    };
  }

  /**
   * Fan one settled fill. Invents nothing: no fillId → refused.
   * Blank or non-decimal price, qty, fee, or quote is refused before sequence,
   * snapshot, and fan-out. A JSON number is not copied onto the execution.
   * Sequence is this hub's domain, independent of matching `fill.sequence`
   * and of the private fills channel.
   */
  publishExecution(input: DropCopyExecutionInput): DropCopyExecution | null {
    if (!isPublishedDropCopyRecentLimit(this.#options.recentLimit)) return null;
    if (!input.fillId || !input.userId) {
      this.#log.warn({ userId: input.userId }, 'ws-drop-copy: refused execution without fillId');
      return null;
    }
    const price = input.price;
    const qty = input.qty;
    const quoteAmount = input.quoteAmount;
    const feeAmount = input.feeAmount;
    if (!isWireDecimal(price) || !isWireDecimal(qty) || !isWireDecimal(quoteAmount) || !isWireDecimal(feeAmount)) {
      this.#log.warn({ userId: input.userId, fillId: input.fillId }, 'ws-drop-copy: refused non-decimal money fields');
      return null;
    }

    let seen = this.#seenFill.get(input.userId);
    if (!seen) {
      seen = new Set();
      this.#seenFill.set(input.userId, seen);
    }
    if (seen.has(input.fillId)) return null;
    seen.add(input.fillId);

    const dropCopySeq = (this.#seq.get(input.userId) ?? 0) + 1;
    this.#seq.set(input.userId, dropCopySeq);
    const execution: DropCopyExecution = { ...input, price, qty, quoteAmount, feeAmount, dropCopySeq };
    this.#remember(execution);
    this.#executions++;

    const frame = encodeDropCopyExecutionFrame(execution);
    for (const sub of this.#subscriptions) {
      if (sub.closed || sub.userId !== input.userId) continue;
      if (!sub.hydrated) {
        sub.pending.push(frame);
        continue;
      }
      if (isPublishedHighWaterBytes(this.#options.highWaterBytes) && sub.sink.bufferedBytes > this.#options.highWaterBytes) {
        sub.gapped = true;
        this.#noteLag(sub);
        continue;
      }
      if (sub.gapped) {
        sub.gapped = false;
        this.#write(sub, this.#statusFrame(sub.userId, DROP_COPY_GAP));
      }
      sub.lagTicks = 0;
      this.#write(sub, frame);
    }
    return execution;
  }

  sweepLag(): void {
    for (const sub of [...this.#subscriptions]) {
      if (sub.closed) continue;
      if (isPublishedHighWaterBytes(this.#options.highWaterBytes) && sub.sink.bufferedBytes > this.#options.highWaterBytes) {
        this.#noteLag(sub);
        continue;
      }
      if (sub.gapped) {
        sub.gapped = false;
        this.#write(sub, this.#statusFrame(sub.userId, DROP_COPY_GAP));
      }
      sub.lagTicks = 0;
    }
  }

  async close(reason: string): Promise<void> {
    for (const sub of [...this.#subscriptions]) {
      sub.closed = true;
      try {
        sub.sink.close(1001, reason);
      } catch {
        /* ignore */
      }
    }
    this.#subscriptions.clear();
  }

  #readyFrame(userId: string): string {
    const h = this.honesty(userId);
    return JSON.stringify({
      channel: DROP_COPY_CHANNEL,
      type: 'ready',
      userId,
      bus: h.bus,
      completeness: h.completeness,
      replayDurable: false,
      lastSeq: h.lastSeq,
    });
  }

  #snapshotFrame(userId: string): string {
    const h = this.honesty(userId);
    return JSON.stringify({
      channel: DROP_COPY_CHANNEL,
      type: 'snapshot',
      userId,
      completeness: h.completeness,
      replayDurable: false,
      lastSeq: h.lastSeq,
      executions: this.#recent.get(userId) ?? [],
    });
  }

  #statusFrame(userId: string, code: string): string {
    const h = this.honesty(userId);
    return JSON.stringify({
      channel: DROP_COPY_CHANNEL,
      type: 'status',
      code,
      userId,
      completeness: h.completeness,
      replayDurable: false,
      lastSeq: h.lastSeq,
    });
  }

  #remember(execution: DropCopyExecution): void {
    const limit = this.#options.recentLimit;
    if (!isPublishedDropCopyRecentLimit(limit) || limit <= 0) return;
    const ring = this.#recent.get(execution.userId) ?? [];
    ring.push(execution);
    if (ring.length > limit) ring.splice(0, ring.length - limit);
    this.#recent.set(execution.userId, ring);
  }

  #forgetIdleUser(userId: string): void {
    for (const s of this.#subscriptions) {
      if (!s.closed && s.userId === userId) return;
    }
    this.#recent.delete(userId);
    this.#seenFill.delete(userId);
  }

  #write(sub: Subscription, frame: string): void {
    if (sub.closed) return;
    if (isInventedCompleteEmptyDropCopy(frame)) {
      this.#log.warn({ userId: sub.userId }, 'ws-drop-copy: refused complete-empty tape frame');
      return;
    }
    try {
      sub.sink.send(frame);
    } catch {
      sub.closed = true;
      this.#subscriptions.delete(sub);
    }
  }

  #noteLag(sub: Subscription): void {
    sub.lagTicks++;
    this.#droppedFrames++;
    if (!isPublishedMaxLagTicks(this.#options.maxLagTicks) || sub.lagTicks < this.#options.maxLagTicks) return;
    this.#evictions++;
    sub.closed = true;
    this.#subscriptions.delete(sub);
    try {
      sub.sink.close(
        CLOSE_TRY_LATER,
        `slow consumer: outbound buffer over ${this.#options.highWaterBytes} bytes for ${sub.lagTicks} ticks`,
      );
    } catch {
      /* already gone */
    }
    this.#log.warn({ userId: sub.userId }, 'ws-drop-copy: evicted lagging client');
  }
}
