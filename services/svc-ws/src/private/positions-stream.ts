/**
 * Sequenced private positions stream.
 *
 * Folds svc-trade `positionUpdated` into a per-account journal. A subscriber
 * sees a snapshot, then deltas whose sequence numbers increase by one. A
 * reconnect names the last sequence it applied: the missed deltas go out when
 * they are still retained, otherwise a fresh snapshot with `resume: 'gap'`.
 * Heartbeats repeat the current sequence and the clock the caller passed, so
 * the age of the stream is the age of that clock, not a time this file invents.
 *
 * Money stays decimal strings. A JSON number is refused and does not advance
 * the sequence. Another account's rows are not readable without `admin:read`.
 */
export const POSITIONS_CHANNEL = 'positions' as const;
export const POSITIONS_SOURCE_UNAVAILABLE = 'ws.positions_source_unavailable' as const;
export const POSITIONS_UNAUTHENTICATED = 'ws.unauthenticated' as const;
export const POSITIONS_FOREIGN_ACCOUNT = 'ws.positions_foreign_account' as const;
/** Operator read of another account. A session without it is refused. */
export const POSITIONS_OPERATOR_SCOPE = 'admin:read' as const;

const UNSIGNED = /^\d+(\.\d{1,18})?$/;
const SIGNED = /^-?\d+(\.\d{1,18})?$/;
const DEFAULT_RETAIN = 256;

export interface PositionRow {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly symbol: string;
  readonly status: 'open' | 'closing' | 'closed' | 'liquidated';
  readonly side: 'long' | 'short';
  readonly contracts: string;
  readonly entryPrice: string;
  readonly markPrice: string | null;
  readonly notional: string;
  readonly leverage: string | null;
  readonly collateral: string | null;
  readonly unrealizedPnl: string | null;
  readonly realizedPnl: string | null;
  readonly liquidationPrice: string | null;
  readonly marginMode: 'cross' | 'isolated' | null;
  readonly fundingPaid: string;
  readonly ts: string;
}

export interface PositionsSession {
  readonly userId: string;
  readonly scopes: readonly string[];
}

export type PositionsSnapshotFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'snapshot';
  readonly sequence: number;
  readonly asOf: string;
  readonly resume: 'fresh' | 'gap';
  readonly positions: readonly PositionRow[];
};

export type PositionsDeltaFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'delta';
  readonly sequence: number;
  readonly asOf: string;
  readonly position: PositionRow;
};

export type PositionsHeartbeatFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'heartbeat';
  readonly sequence: number;
  readonly asOf: string;
  readonly dataAsOf: string | null;
};

export type PositionsErrorFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
  readonly key?: string;
};

export type PositionsFrame = PositionsSnapshotFrame | PositionsDeltaFrame | PositionsHeartbeatFrame | PositionsErrorFrame;

export interface PositionsStreamOptions {
  /** How many deltas per account are kept for a resume. Default 256. */
  readonly retain?: number;
}

interface StoredDelta {
  readonly sequence: number;
  readonly asOf: string;
  readonly position: PositionRow;
}

interface Book {
  sequence: number;
  dataAsOf: string | null;
  readonly rows: Map<string, PositionRow>;
  readonly deltas: StoredDelta[];
}

interface Sub {
  readonly userId: string;
  send(frame: PositionsFrame): void;
}

function errorFrame(code: string, message: string, key?: string): PositionsErrorFrame {
  return {
    channel: POSITIONS_CHANNEL,
    type: 'error',
    code,
    message,
    ...(key === undefined ? {} : { key }),
  };
}

function decimal(value: unknown, signed: boolean): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!(signed ? SIGNED : UNSIGNED).test(value)) return undefined;
  return value;
}

function decimalOrNull(value: unknown, signed: boolean): string | null | undefined {
  if (value === null) return null;
  return decimal(value, signed);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

/** Parse one position event. A number, a blank, or a bad decimal returns null — never coerced. */
export function positionRowFromUnknown(raw: unknown): PositionRow | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const positionId = text(row.positionId);
  const userId = text(row.userId);
  const marketId = text(row.marketId);
  const symbol = text(row.symbol);
  const status = row.status;
  const side = row.side;
  const contracts = decimal(row.contracts, false);
  const entryPrice = decimal(row.entryPrice, false);
  const markPrice = decimalOrNull(row.markPrice, false);
  const notional = decimal(row.notional, false);
  const leverage = decimalOrNull(row.leverage, false);
  const collateral = decimalOrNull(row.collateral, false);
  const unrealizedPnl = decimalOrNull(row.unrealizedPnl, true);
  const realizedPnl = decimalOrNull(row.realizedPnl, true);
  const liquidationPrice = decimalOrNull(row.liquidationPrice, false);
  const fundingPaid = decimal(row.fundingPaid, true);
  const ts = text(row.ts);
  const marginMode = row.marginMode === null || row.marginMode === 'cross' || row.marginMode === 'isolated' ? row.marginMode : undefined;
  if (
    positionId === undefined ||
    userId === undefined ||
    marketId === undefined ||
    symbol === undefined ||
    (status !== 'open' && status !== 'closing' && status !== 'closed' && status !== 'liquidated') ||
    (side !== 'long' && side !== 'short') ||
    contracts === undefined ||
    entryPrice === undefined ||
    markPrice === undefined ||
    notional === undefined ||
    leverage === undefined ||
    collateral === undefined ||
    unrealizedPnl === undefined ||
    realizedPnl === undefined ||
    liquidationPrice === undefined ||
    marginMode === undefined ||
    fundingPaid === undefined ||
    ts === undefined
  ) {
    return null;
  }
  return {
    positionId,
    userId,
    marketId,
    symbol,
    status,
    side,
    contracts,
    entryPrice,
    markPrice,
    notional,
    leverage,
    collateral,
    unrealizedPnl,
    realizedPnl,
    liquidationPrice,
    marginMode,
    fundingPaid,
    ts,
  };
}

function openRow(row: PositionRow): boolean {
  return row.status === 'open' || row.status === 'closing';
}

export class PositionsStream {
  readonly #retain: number;
  readonly #books = new Map<string, Book>();
  readonly #subs = new Set<Sub>();
  #attached = false;

  constructor(options: PositionsStreamOptions = {}) {
    const retain = options.retain ?? DEFAULT_RETAIN;
    this.#retain = Number.isInteger(retain) && retain >= 1 ? retain : DEFAULT_RETAIN;
  }

  get sourceAttached(): boolean {
    return this.#attached;
  }

  markSourceAttached(attached: boolean): void {
    this.#attached = attached;
  }

  /** Fold one `positionUpdated` payload. Returns false when the row is not a decimal-string position. */
  ingest(raw: unknown): boolean {
    if (!this.#attached) return false;
    const row = positionRowFromUnknown(raw);
    if (row === null) return false;
    const book = this.#book(row.userId);
    book.sequence += 1;
    book.dataAsOf = row.ts;
    if (openRow(row)) book.rows.set(row.positionId, row);
    else book.rows.delete(row.positionId);
    const stored: StoredDelta = { sequence: book.sequence, asOf: row.ts, position: row };
    book.deltas.push(stored);
    while (book.deltas.length > this.#retain) book.deltas.shift();
    const frame: PositionsDeltaFrame = {
      channel: POSITIONS_CHANNEL,
      type: 'delta',
      sequence: book.sequence,
      asOf: row.ts,
      position: row,
    };
    for (const sub of this.#subs) {
      if (sub.userId === row.userId) sub.send(frame);
    }
    return true;
  }

  subscribe(input: {
    readonly session: PositionsSession | null;
    readonly requestedUserId?: string;
    readonly lastSequence?: number;
    readonly asOf: string;
    send(frame: PositionsFrame): void;
  }): { readonly ok: true; detach(): void } | { readonly ok: false; readonly frame: PositionsErrorFrame } {
    const refuse = (frame: PositionsErrorFrame) => {
      input.send(frame);
      return { ok: false as const, frame };
    };
    if (input.session === null) {
      return refuse(errorFrame(POSITIONS_UNAUTHENTICATED, 'a positions subscription needs an authenticated session'));
    }
    const target = input.requestedUserId ?? input.session.userId;
    if (target !== input.session.userId && !input.session.scopes.includes(POSITIONS_OPERATOR_SCOPE)) {
      return refuse(
        errorFrame(
          POSITIONS_FOREIGN_ACCOUNT,
          `reading another account's positions needs ${POSITIONS_OPERATOR_SCOPE}`,
          POSITIONS_OPERATOR_SCOPE,
        ),
      );
    }
    if (!this.#attached) {
      return refuse(errorFrame(POSITIONS_SOURCE_UNAVAILABLE, 'svc-trade positionUpdated is not attached on this process'));
    }
    const book = this.#book(target);
    if (input.lastSequence !== undefined && (!Number.isInteger(input.lastSequence) || input.lastSequence < 0)) {
      return refuse(errorFrame('ws.positions_bad_sequence', 'lastSequence must be a non-negative integer'));
    }
    const sub: Sub = { userId: target, send: input.send };
    this.#subs.add(sub);
    this.#resume(book, input.lastSequence, input.asOf, input.send);
    return {
      ok: true,
      detach: () => {
        this.#subs.delete(sub);
      },
    };
  }

  heartbeat(asOf: string): void {
    for (const sub of this.#subs) {
      const book = this.#book(sub.userId);
      const frame: PositionsHeartbeatFrame = {
        channel: POSITIONS_CHANNEL,
        type: 'heartbeat',
        sequence: book.sequence,
        asOf,
        dataAsOf: book.dataAsOf,
      };
      sub.send(frame);
    }
  }

  #book(userId: string): Book {
    const existing = this.#books.get(userId);
    if (existing) return existing;
    const created: Book = {
      sequence: 0,
      dataAsOf: null,
      rows: new Map(),
      deltas: [],
    };
    this.#books.set(userId, created);
    return created;
  }

  #resume(book: Book, lastSequence: number | undefined, asOf: string, send: (frame: PositionsFrame) => void): void {
    if (lastSequence === undefined) {
      send(this.#snapshot(book, asOf, 'fresh'));
      return;
    }
    if (lastSequence === book.sequence) {
      send({
        channel: POSITIONS_CHANNEL,
        type: 'heartbeat',
        sequence: book.sequence,
        asOf,
        dataAsOf: book.dataAsOf,
      });
      return;
    }
    if (lastSequence > book.sequence) {
      send(this.#snapshot(book, asOf, 'gap'));
      return;
    }
    const missed = book.deltas.filter((delta) => delta.sequence > lastSequence).sort((a, b) => a.sequence - b.sequence);
    const need = book.sequence - lastSequence;
    const contiguous = missed.length === need && missed.every((delta, index) => delta.sequence === lastSequence + 1 + index);
    if (!contiguous) {
      send(this.#snapshot(book, asOf, 'gap'));
      return;
    }
    for (const delta of missed) {
      send({
        channel: POSITIONS_CHANNEL,
        type: 'delta',
        sequence: delta.sequence,
        asOf: delta.asOf,
        position: delta.position,
      });
    }
  }

  #snapshot(book: Book, asOf: string, resume: 'fresh' | 'gap'): PositionsSnapshotFrame {
    const positions = [...book.rows.values()].sort((a, b) => (a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0));
    return {
      channel: POSITIONS_CHANNEL,
      type: 'snapshot',
      sequence: book.sequence,
      asOf,
      resume,
      positions,
    };
  }
}

export interface PositionsSubscribeContext {
  readonly stream: PositionsStream | null;
  readonly session: PositionsSession | null;
  readonly nowIso: string;
  send(frame: string): void;
  onDetach(detach: () => void): void;
}

/**
 * Private subscription router for `{ "op": "subscribe", "channel": "positions" }`.
 * Any other text returns false so cancel-on-disconnect still sees it.
 */
export async function handlePositionsSubscribeText(text: string, input: PositionsSubscribeContext): Promise<boolean> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  if (rec.op !== 'subscribe' || rec.channel !== POSITIONS_CHANNEL) return false;

  const sendFrame = (frame: PositionsFrame) => {
    input.send(JSON.stringify(frame));
  };

  if (input.stream === null) {
    sendFrame(errorFrame(POSITIONS_SOURCE_UNAVAILABLE, 'svc-trade positionUpdated is not attached on this process'));
    return true;
  }
  if (input.session === null) {
    sendFrame(errorFrame(POSITIONS_UNAUTHENTICATED, 'a positions subscription needs an authenticated session'));
    return true;
  }

  const requestedUserId = typeof rec.userId === 'string' && rec.userId.length > 0 ? rec.userId : undefined;
  const lastSequence = rec.lastSequence;
  const result = input.stream.subscribe({
    session: input.session,
    requestedUserId,
    lastSequence: typeof lastSequence === 'number' ? lastSequence : undefined,
    asOf: input.nowIso,
    send: sendFrame,
  });
  if (result.ok) input.onDetach(result.detach);
  return true;
}
