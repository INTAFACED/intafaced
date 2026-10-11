/**
 * PX-S03 §11 / PTX-M03-R04 — dead-man / cancel-on-disconnect lease.
 *
 * Expiry is server receipt + ttl only. Client `expiresAt` / `clientNow` are ignored.
 * Owner lease range is required to arm (blank → typed refusal, no invented default).
 * Excluded order classes are an owner socket — non-empty list refuses rather than
 * silently dropping. Session-scoped fire never calls account-wide cancel-all.
 */

export const COD_CHANNEL = 'cod' as const;

export type CodScope = 'session' | 'account' | 'market';
export type CodOutcome = 'APPLIED' | 'REFUSED' | 'OUTCOME_UNKNOWN';
export type CodActivation = 'disconnect' | 'lease_expired';

export type CodRefuseCode =
  | 'cod.malformed'
  | 'cod.lease_range_unconfigured'
  | 'cod.write_required'
  | 'cod.excluded_classes_unconfigured'
  | 'cod.scope_unsupported'
  | 'cod.ttl_out_of_range'
  | 'cod.unarmed';

export const COD_REFUSE_CODES = [
  'cod.malformed',
  'cod.lease_range_unconfigured',
  'cod.write_required',
  'cod.excluded_classes_unconfigured',
  'cod.scope_unsupported',
  'cod.ttl_out_of_range',
  'cod.unarmed',
] as const satisfies readonly CodRefuseCode[];

export interface CodLeaseRange {
  readonly minTtlMs: number;
  readonly maxTtlMs: number;
}

export interface CodTargetResult {
  readonly selector: string;
  readonly outcome: CodOutcome;
  readonly reason?: string;
}

export interface TradeCancelPort {
  cancelAll(input: { accessToken: string; marketId?: string }): Promise<TradeCancelResult>;
}

export type TradeCancelResult =
  | { readonly reached: true; readonly status: number; readonly orders: readonly { readonly orderId: string }[] }
  | { readonly reached: false; readonly reason: string };

export interface CodArmCommand {
  readonly commandId: string;
  readonly ttlMs: number;
  readonly scope: CodScope;
  readonly marketId?: string;
  readonly excludedOrderClasses: readonly string[];
}

export type ParsedCodCommand =
  | { readonly kind: 'arm'; readonly command: CodArmCommand }
  | { readonly kind: 'renew'; readonly commandId: string }
  | { readonly kind: 'disarm'; readonly commandId: string }
  | { readonly kind: 'refuse'; readonly code: CodRefuseCode; readonly commandId: string | null }
  | { readonly kind: 'ignore' };

export interface CodLease {
  readonly commandId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly receivedAtMs: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
  readonly scope: CodScope;
  readonly marketId?: string;
  readonly cancelExecutable: boolean;
  fired: boolean;
}

export interface CodArmedView {
  readonly channel: typeof COD_CHANNEL;
  readonly type: 'cod.armed' | 'cod.renewed';
  readonly commandId: string;
  readonly leaseCommandId: string;
  readonly userId: string;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
  readonly scope: CodScope;
  readonly marketId: string | null;
  readonly excludedOrderClasses: readonly [];
  readonly recoveryPolicy: 'cod.replica_local';
  readonly cancelExecutable: boolean;
}

export interface CodRefusedView {
  readonly channel: typeof COD_CHANNEL;
  readonly type: 'cod.refused';
  readonly commandId: string | null;
  readonly code: CodRefuseCode;
}

export interface CodDisarmedView {
  readonly channel: typeof COD_CHANNEL;
  readonly type: 'cod.disarmed';
  readonly commandId: string;
  readonly leaseCommandId: string;
}

export interface CodFiredView {
  readonly channel: typeof COD_CHANNEL;
  readonly type: 'cod.fired';
  readonly commandId: string;
  readonly userId: string;
  readonly activation: CodActivation;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly firedAt: string;
  readonly scope: CodScope;
  readonly marketId: string | null;
  readonly tradeReached: boolean;
  readonly complete: boolean;
  readonly recoveryPolicy: 'cod.replica_local';
  readonly targets: readonly CodTargetResult[];
}

export function leaseRangeFromEnv(min: number | undefined, max: number | undefined): CodLeaseRange | null {
  if (min === undefined || max === undefined) return null;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max < min) return null;
  return { minTtlMs: min, maxTtlMs: max };
}

export function computeExpiryMs(receivedAtMs: number, ttlMs: number): number {
  return receivedAtMs + ttlMs;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function commandIdOf(rec: Record<string, unknown>): string | null {
  return typeof rec.commandId === 'string' && rec.commandId.length > 0 && rec.commandId.length <= 128 ? rec.commandId : null;
}

const SCOPES: readonly CodScope[] = ['session', 'account', 'market'];

function isScope(value: unknown): value is CodScope {
  return value === 'session' || value === 'account' || value === 'market';
}

/**
 * Unknown types stay ignored (private stream is still push-only except COD).
 * Client clock fields are accepted and discarded.
 */
export function parseCodCommand(raw: unknown): ParsedCodCommand {
  const rec = asRecord(raw);
  if (!rec) return { kind: 'ignore' };
  const type = rec.type;
  if (type !== 'cod.arm' && type !== 'cod.renew' && type !== 'cod.heartbeat' && type !== 'cod.disarm') {
    return { kind: 'ignore' };
  }
  const commandId = commandIdOf(rec);
  if (commandId === null) return { kind: 'refuse', code: 'cod.malformed', commandId: null };

  if (type === 'cod.renew' || type === 'cod.heartbeat') return { kind: 'renew', commandId };
  if (type === 'cod.disarm') return { kind: 'disarm', commandId };

  const ttlMs = rec.ttlMs;
  if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs)) {
    return { kind: 'refuse', code: 'cod.malformed', commandId };
  }
  if (!isScope(rec.scope)) return { kind: 'refuse', code: 'cod.scope_unsupported', commandId };
  const marketId = typeof rec.marketId === 'string' && rec.marketId.length > 0 ? rec.marketId : undefined;
  if (rec.scope === 'market' && marketId === undefined) {
    return { kind: 'refuse', code: 'cod.scope_unsupported', commandId };
  }
  let excluded: string[] = [];
  if (rec.excludedOrderClasses !== undefined) {
    if (!Array.isArray(rec.excludedOrderClasses) || rec.excludedOrderClasses.some((c) => typeof c !== 'string')) {
      return { kind: 'refuse', code: 'cod.malformed', commandId };
    }
    excluded = rec.excludedOrderClasses as string[];
  }
  return {
    kind: 'arm',
    command: {
      commandId,
      ttlMs,
      scope: rec.scope,
      marketId,
      excludedOrderClasses: excluded,
    },
  };
}

export function parseCodCommandText(text: string): ParsedCodCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'ignore' };
  }
  return parseCodCommand(raw);
}

export type ArmDecision =
  | { readonly ok: true; readonly lease: Omit<CodLease, 'fired' | 'userId' | 'accessToken'> & { readonly cancelExecutable: boolean } }
  | { readonly ok: false; readonly code: CodRefuseCode };

export function decideArm(input: {
  readonly command: CodArmCommand;
  readonly range: CodLeaseRange | null;
  readonly nowMs: number;
  readonly hasWrite: boolean;
  readonly cancelPortAttached: boolean;
}): ArmDecision {
  const { command, range, nowMs, hasWrite, cancelPortAttached } = input;
  if (range === null) return { ok: false, code: 'cod.lease_range_unconfigured' };
  if (!hasWrite) return { ok: false, code: 'cod.write_required' };
  if (command.excludedOrderClasses.length > 0) return { ok: false, code: 'cod.excluded_classes_unconfigured' };
  if (!SCOPES.includes(command.scope)) return { ok: false, code: 'cod.scope_unsupported' };
  if (command.ttlMs < range.minTtlMs || command.ttlMs > range.maxTtlMs) return { ok: false, code: 'cod.ttl_out_of_range' };
  const cancelExecutable = command.scope !== 'session' && cancelPortAttached;
  return {
    ok: true,
    lease: {
      commandId: command.commandId,
      receivedAtMs: nowMs,
      expiresAtMs: computeExpiryMs(nowMs, command.ttlMs),
      ttlMs: command.ttlMs,
      scope: command.scope,
      marketId: command.marketId,
      cancelExecutable,
    },
  };
}

export function refusedFrame(commandId: string | null, code: CodRefuseCode): string {
  const body: CodRefusedView = { channel: COD_CHANNEL, type: 'cod.refused', commandId, code };
  return JSON.stringify(body);
}

export function armedFrame(input: {
  readonly type: 'cod.armed' | 'cod.renewed';
  readonly commandId: string;
  readonly lease: CodLease;
}): string {
  const { type, commandId, lease } = input;
  const body: CodArmedView = {
    channel: COD_CHANNEL,
    type,
    commandId,
    leaseCommandId: lease.commandId,
    userId: lease.userId,
    receivedAt: new Date(lease.receivedAtMs).toISOString(),
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
    ttlMs: lease.ttlMs,
    scope: lease.scope,
    marketId: lease.marketId ?? null,
    excludedOrderClasses: [],
    recoveryPolicy: 'cod.replica_local',
    cancelExecutable: lease.cancelExecutable,
  };
  return JSON.stringify(body);
}

export function disarmedFrame(commandId: string, leaseCommandId: string): string {
  const body: CodDisarmedView = { channel: COD_CHANNEL, type: 'cod.disarmed', commandId, leaseCommandId };
  return JSON.stringify(body);
}

export function selectorFor(scope: CodScope, marketId?: string): string {
  if (scope === 'market') return `market:${marketId ?? ''}`;
  return scope;
}

export function targetsFromCancel(input: {
  readonly scope: CodScope;
  readonly marketId?: string;
  readonly result: TradeCancelResult | null;
}): { readonly tradeReached: boolean; readonly complete: boolean; readonly targets: readonly CodTargetResult[] } {
  const selector = selectorFor(input.scope, input.marketId);
  if (input.scope === 'session' || input.result === null) {
    return {
      tradeReached: false,
      complete: false,
      targets: [
        {
          selector,
          outcome: 'OUTCOME_UNKNOWN',
          reason: input.scope === 'session' ? 'cod.session_scope_not_mapped' : 'cod.trade_not_reached',
        },
      ],
    };
  }
  if (!input.result.reached) {
    return {
      tradeReached: false,
      complete: false,
      targets: [{ selector, outcome: 'OUTCOME_UNKNOWN', reason: input.result.reason }],
    };
  }
  if (input.result.status === 401 || input.result.status === 403) {
    return {
      tradeReached: true,
      complete: true,
      targets: [{ selector, outcome: 'REFUSED', reason: 'cod.trade_refused' }],
    };
  }
  if (input.result.status !== 200) {
    return {
      tradeReached: false,
      complete: false,
      targets: [{ selector, outcome: 'OUTCOME_UNKNOWN', reason: `cod.trade_http_${input.result.status}` }],
    };
  }
  const applied = input.result.orders.map((o) => ({ selector: o.orderId, outcome: 'APPLIED' as const }));
  return {
    tradeReached: true,
    complete: applied.length > 0,
    targets: applied,
  };
}

export function firedFrame(input: {
  readonly lease: CodLease;
  readonly activation: CodActivation;
  readonly firedAtMs: number;
  readonly tradeReached: boolean;
  readonly complete: boolean;
  readonly targets: readonly CodTargetResult[];
}): string {
  const body: CodFiredView = {
    channel: COD_CHANNEL,
    type: 'cod.fired',
    commandId: input.lease.commandId,
    userId: input.lease.userId,
    activation: input.activation,
    receivedAt: new Date(input.lease.receivedAtMs).toISOString(),
    expiresAt: new Date(input.lease.expiresAtMs).toISOString(),
    firedAt: new Date(input.firedAtMs).toISOString(),
    scope: input.lease.scope,
    marketId: input.lease.marketId ?? null,
    tradeReached: input.tradeReached,
    complete: input.complete,
    recoveryPolicy: 'cod.replica_local',
    targets: input.targets,
  };
  return JSON.stringify(body);
}

/** Mass-success without reaching trade — the lie this lease must not tell. */
export function wouldInventCodMassSuccess(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.channel === COD_CHANNEL && rec.type === 'cod.fired') {
    if (rec.complete === true && rec.tradeReached !== true) return true;
    if (rec.complete === true && rec.tradeReached === true && Array.isArray(rec.targets)) {
      const invented = rec.targets.some(
        (t) => t !== null && typeof t === 'object' && (t as { outcome?: unknown }).outcome === 'APPLIED' && rec.tradeReached !== true,
      );
      if (invented) return true;
    }
  }
  if (rec.type === 'snapshot' && rec.channel === 'orders' && rec.codComplete === true) return true;
  return false;
}

export function wouldInventCodMassSuccessFrame(frame: string): boolean {
  try {
    return wouldInventCodMassSuccess(JSON.parse(frame) as unknown);
  } catch {
    return false;
  }
}

export interface CodSchedule {
  (fn: () => void, delayMs: number): () => void;
}

export interface CodControllerOptions {
  readonly range: CodLeaseRange | null;
  readonly now: () => number;
  readonly schedule: CodSchedule;
  readonly cancel: TradeCancelPort | null;
}

interface Seat {
  lease: CodLease;
  cancelTimer: () => void;
  send: (frame: string) => void;
}

/**
 * One lease per private socket. Replica-local last-fire is replayed once on
 * reconnect — not a durable drop-copy.
 */
export class CodController {
  readonly #options: CodControllerOptions;
  readonly #seats = new Map<object, Seat>();
  readonly #lastFire = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(frame: string) => void>>();
  /** Latest arm or fire for a user. A stale #fire must not publish after cancelAll. */
  readonly #fireGeneration = new Map<string, number>();

  constructor(options: CodControllerOptions) {
    this.#options = options;
  }

  get armedCount(): number {
    return this.#seats.size;
  }

  /** Users that still have a listener set. The last unsubscribe removes the key. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  listen(userId: string, send: (frame: string) => void): () => void {
    let set = this.#listeners.get(userId);
    if (!set) {
      set = new Set();
      this.#listeners.set(userId, set);
    }
    set.add(send);
    return () => {
      set.delete(send);
      if (set.size === 0 && this.#listeners.get(userId) === set) this.#listeners.delete(userId);
    };
  }

  replayLastFire(userId: string, send: (frame: string) => void): void {
    const frame = this.#lastFire.get(userId);
    if (!frame) return;
    this.#lastFire.delete(userId);
    try {
      send(frame);
    } catch {
      this.#lastFire.set(userId, frame);
    }
  }

  handleText(
    conn: object,
    text: string,
    ctx: {
      userId: string;
      accessToken: string;
      hasWrite: boolean;
      send: (frame: string) => void;
    },
  ): void {
    const parsed = parseCodCommandText(text);
    if (parsed.kind === 'ignore') return;
    if (parsed.kind === 'refuse') {
      ctx.send(refusedFrame(parsed.commandId, parsed.code));
      return;
    }
    if (parsed.kind === 'arm') {
      this.#arm(conn, parsed.command, ctx);
      return;
    }
    if (parsed.kind === 'renew') {
      this.#renew(conn, parsed.commandId, ctx);
      return;
    }
    this.#disarm(conn, parsed.commandId, ctx);
  }

  /** Client/socket death. Not used for operator drain. */
  async disconnect(conn: object): Promise<void> {
    await this.#fire(conn, 'disconnect');
  }

  /** Graceful replica drain — drop the lease, do not cancel the book. */
  drop(conn: object): void {
    const seat = this.#seats.get(conn);
    if (!seat) return;
    seat.cancelTimer();
    this.#seats.delete(conn);
  }

  dispose(): void {
    for (const seat of this.#seats.values()) seat.cancelTimer();
    this.#seats.clear();
  }

  #arm(
    conn: object,
    command: CodArmCommand,
    ctx: {
      userId: string;
      accessToken: string;
      hasWrite: boolean;
      send: (frame: string) => void;
    },
  ): void {
    const decided = decideArm({
      command,
      range: this.#options.range,
      nowMs: this.#options.now(),
      hasWrite: ctx.hasWrite,
      cancelPortAttached: this.#options.cancel !== null,
    });
    if (!decided.ok) {
      ctx.send(refusedFrame(command.commandId, decided.code));
      return;
    }
    this.#advanceGeneration(ctx.userId);
    this.drop(conn);
    const lease: CodLease = {
      ...decided.lease,
      userId: ctx.userId,
      accessToken: ctx.accessToken,
      fired: false,
    };
    this.#seats.set(conn, {
      lease,
      send: ctx.send,
      cancelTimer: this.#armTimer(conn, lease),
    });
    ctx.send(armedFrame({ type: 'cod.armed', commandId: command.commandId, lease }));
  }

  #renew(conn: object, commandId: string, ctx: { send: (frame: string) => void }): void {
    const seat = this.#seats.get(conn);
    if (!seat || seat.lease.fired) {
      ctx.send(refusedFrame(commandId, 'cod.unarmed'));
      return;
    }
    const nowMs = this.#options.now();
    const lease: CodLease = {
      ...seat.lease,
      receivedAtMs: nowMs,
      expiresAtMs: computeExpiryMs(nowMs, seat.lease.ttlMs),
    };
    seat.cancelTimer();
    seat.lease = lease;
    seat.cancelTimer = this.#armTimer(conn, lease);
    ctx.send(armedFrame({ type: 'cod.renewed', commandId, lease }));
  }

  #disarm(conn: object, commandId: string, ctx: { send: (frame: string) => void }): void {
    const seat = this.#seats.get(conn);
    if (!seat || seat.lease.fired) {
      ctx.send(refusedFrame(commandId, 'cod.unarmed'));
      return;
    }
    const leaseCommandId = seat.lease.commandId;
    this.drop(conn);
    ctx.send(disarmedFrame(commandId, leaseCommandId));
  }

  #advanceGeneration(userId: string): number {
    const next = (this.#fireGeneration.get(userId) ?? 0) + 1;
    this.#fireGeneration.set(userId, next);
    return next;
  }

  #armTimer(conn: object, lease: CodLease): () => void {
    const delay = Math.max(0, lease.expiresAtMs - this.#options.now());
    return this.#options.schedule(() => {
      void this.#fire(conn, 'lease_expired');
    }, delay);
  }

  async #fire(conn: object, activation: CodActivation): Promise<void> {
    const seat = this.#seats.get(conn);
    if (!seat || seat.lease.fired) {
      this.drop(conn);
      return;
    }
    seat.lease.fired = true;
    seat.cancelTimer();
    const lease = seat.lease;
    this.#seats.delete(conn);
    const generation = this.#advanceGeneration(lease.userId);

    let result: TradeCancelResult | null = null;
    if (lease.cancelExecutable && this.#options.cancel && (lease.scope === 'account' || lease.scope === 'market')) {
      try {
        result = await this.#options.cancel.cancelAll({
          accessToken: lease.accessToken,
          marketId: lease.scope === 'market' ? lease.marketId : undefined,
        });
      } catch {
        result = { reached: false, reason: 'cod.trade_not_reached' };
      }
    }
    const mapped = targetsFromCancel({ scope: lease.scope, marketId: lease.marketId, result });
    const frame = firedFrame({
      lease,
      activation,
      firedAtMs: this.#options.now(),
      tradeReached: mapped.tradeReached,
      complete: mapped.complete,
      targets: mapped.targets,
    });
    if (this.#fireGeneration.get(lease.userId) !== generation) return;
    this.#lastFire.set(lease.userId, frame);
    try {
      seat.send(frame);
    } catch {
      /* socket already gone — siblings / reconnect hold the frame */
    }
    for (const send of this.#listeners.get(lease.userId) ?? []) {
      if (send === seat.send) continue;
      try {
        send(frame);
      } catch {
        /* ignore */
      }
    }
  }
}
