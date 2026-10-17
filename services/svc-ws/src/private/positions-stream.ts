/**
 * Sequenced private positions stream.
 *
 * Folds svc-trade `positionUpdated` into a per-account journal and seeds the
 * first snapshot from the caller's open-positions read, so a restart does not
 * report an empty book that was never read. A subscriber sees that snapshot,
 * then deltas whose sequence numbers increase by one. Snapshot, delta, and
 * heartbeat frames carry this process's `streamId`. A reconnect names that id
 * next to the last sequence it applied: missed deltas go out only when the id
 * matches and the tail is still retained. A missing or different id is a
 * seeded snapshot with `resume: 'gap'`. Heartbeats repeat the current sequence
 * and the clock the caller passed, so the age of the stream is the age of that
 * clock, not a time this file invents.
 *
 * Money stays decimal strings. A JSON number is refused and does not advance
 * the sequence. Another account's rows are not readable without `admin:read`.
 * svc-trade's open-positions read is the caller's own account. An unseeded book
 * never snapshots: a failed read is not stored, and an operator may see another
 * account only after that account's own subscribe has seeded it.
 */
import { randomUUID } from 'node:crypto';
export const POSITIONS_CHANNEL = 'positions' as const;
export const POSITIONS_SOURCE_UNAVAILABLE = 'ws.positions_source_unavailable' as const;
export const POSITIONS_SNAPSHOT_UNAVAILABLE = 'ws.positions_snapshot_unavailable' as const;
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
  /** Signed decimal from a bus event. Null when the open-positions read did not publish it. Never a filled `"0"`. */
  readonly fundingPaid: string | null;
  readonly ts: string;
}

export interface PositionsSession {
  readonly userId: string;
  readonly scopes: readonly string[];
}

export type PositionsSnapshotFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'snapshot';
  readonly streamId: string;
  readonly sequence: number;
  readonly asOf: string;
  readonly resume: 'fresh' | 'gap';
  readonly positions: readonly PositionRow[];
};

export type PositionsDeltaFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'delta';
  readonly streamId: string;
  readonly sequence: number;
  readonly asOf: string;
  readonly position: PositionRow;
};

export type PositionsHeartbeatFrame = {
  readonly channel: typeof POSITIONS_CHANNEL;
  readonly type: 'heartbeat';
  readonly streamId: string;
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

/** Open positions for one account, read with that account's access token. */
export type PositionsSeed = (userId: string, accessToken: string) => Promise<readonly unknown[]>;

export interface PositionsStreamOptions {
  /** How many deltas per account are kept for a resume. Default 256. */
  readonly retain?: number;
  /** Process identity on every frame. Tests inject this; production draws a UUID. */
  readonly streamId?: string;
}

interface StoredDelta {
  readonly sequence: number;
  readonly asOf: string;
  readonly position: PositionRow;
}

interface Book {
  sequence: number;
  dataAsOf: string | null;
  /** True after a successful open-positions read. An unread book must not snapshot as empty. */
  seeded: boolean;
  seeding?: Promise<void>;
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

function bookText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function refuseBookNumber(value: unknown, field: string): void {
  if (typeof value === 'number') throw new Error(`${field} is a JSON number`);
}

function bookUnsigned(value: unknown, field: string): string {
  refuseBookNumber(value, field);
  if (typeof value !== 'string' || !UNSIGNED.test(value)) throw new Error(`${field} is not an unsigned decimal string`);
  return value;
}

function bookUnsignedOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return bookUnsigned(value, field);
}

function bookSignedOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  refuseBookNumber(value, field);
  if (typeof value !== 'string' || !SIGNED.test(value)) throw new Error(`${field} is not a decimal string`);
  return value;
}

/**
 * Map one open-positions REST row onto a snapshot row.
 * `userId` is the verified socket principal. A missing `fundingPaid` stays null.
 * A JSON number throws so the whole read is refused. Bus events keep using
 * {@link positionRowFromUnknown}, which still requires a signed `fundingPaid`.
 */
export function positionRowFromBook(raw: unknown, userId: string): PositionRow {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('positions seed row is not an object');
  }
  if (userId.length === 0) throw new Error('positions seed row is not this account');
  const row = raw as Record<string, unknown>;
  const positionId = bookText(row.positionId) ?? bookText(row.id);
  const symbol = bookText(row.symbol);
  const marketId = bookText(row.marketId) ?? symbol;
  const status = row.status;
  const side = row.side;
  const contracts = bookUnsigned(row.contracts, 'contracts');
  const entryPrice = bookUnsigned(row.entryPrice, 'entryPrice');
  const markPrice = bookUnsignedOrNull(row.markPrice, 'markPrice');
  const notional = bookUnsigned(row.notional, 'notional');
  const leverage = bookUnsignedOrNull(row.leverage, 'leverage');
  const collateral = bookUnsignedOrNull(row.collateral, 'collateral');
  const unrealizedPnl = bookSignedOrNull(row.unrealizedPnl, 'unrealizedPnl');
  const realizedPnl = bookSignedOrNull(row.realizedPnl, 'realizedPnl');
  const liquidationPrice = bookUnsignedOrNull(row.liquidationPrice, 'liquidationPrice');
  const fundingPaid = row.fundingPaid === undefined || row.fundingPaid === null ? null : bookSignedOrNull(row.fundingPaid, 'fundingPaid');
  const ts = bookText(row.ts) ?? bookText(row.datetime) ?? new Date(0).toISOString();
  const marginMode = row.marginMode === 'isolated' || row.marginMode === 'cross' ? row.marginMode : null;
  if (
    positionId === undefined ||
    symbol === undefined ||
    marketId === undefined ||
    (status !== 'open' && status !== 'closing' && status !== 'closed' && status !== 'liquidated') ||
    (side !== 'long' && side !== 'short')
  ) {
    throw new Error('positions seed row is not this account');
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
  readonly #streamId: string;
  readonly #books = new Map<string, Book>();
  readonly #subs = new Set<Sub>();
  #attached = false;

  constructor(options: PositionsStreamOptions = {}) {
    const retain = options.retain ?? DEFAULT_RETAIN;
    this.#retain = Number.isInteger(retain) && retain >= 1 ? retain : DEFAULT_RETAIN;
    this.#streamId = options.streamId !== undefined && options.streamId.length > 0 ? options.streamId : randomUUID();
  }

  get streamId(): string {
    return this.#streamId;
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
      streamId: this.#streamId,
      sequence: book.sequence,
      asOf: row.ts,
      position: row,
    };
    for (const sub of this.#subs) {
      if (sub.userId === row.userId) sub.send(frame);
    }
    return true;
  }

  async subscribe(input: {
    readonly session: PositionsSession | null;
    readonly requestedUserId?: string;
    readonly lastSequence?: number;
    readonly streamId?: string;
    readonly asOf: string;
    readonly accessToken?: string;
    readonly seed?: PositionsSeed;
    send(frame: PositionsFrame): void;
  }): Promise<{ readonly ok: true; detach(): void } | { readonly ok: false; readonly frame: PositionsErrorFrame }> {
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
    if (input.lastSequence !== undefined && (!Number.isInteger(input.lastSequence) || input.lastSequence < 0)) {
      return refuse(errorFrame('ws.positions_bad_sequence', 'lastSequence must be a non-negative integer'));
    }
    const book = this.#book(target);
    if (this.#needsSnapshot(book, input.lastSequence, input.streamId) && !book.seeded) {
      const ready = await this.#ensureSeeded(book, target, input.session.userId, input.accessToken, input.seed);
      if (!ready.ok) return refuse(ready.frame);
    }
    const sub: Sub = { userId: target, send: input.send };
    this.#subs.add(sub);
    this.#resume(book, input.lastSequence, input.streamId, input.asOf, input.send);
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
        streamId: this.#streamId,
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
      seeded: false,
      rows: new Map(),
      deltas: [],
    };
    this.#books.set(userId, created);
    return created;
  }

  /**
   * A snapshot is required when the caller has no cursor, names another
   * process, or the retained tail cannot continue `lastSequence`. Delta replay
   * is only the matching-id contiguous case. An equal cursor on this process
   * is a heartbeat.
   */
  #needsSnapshot(book: Book, lastSequence: number | undefined, clientStreamId: string | undefined): boolean {
    if (lastSequence === undefined) return true;
    if (clientStreamId !== this.#streamId) return true;
    if (lastSequence === book.sequence) return false;
    if (lastSequence > book.sequence) return true;
    return !this.#contiguous(book, lastSequence);
  }

  #contiguous(book: Book, lastSequence: number): boolean {
    const missed = this.#missed(book, lastSequence);
    const need = book.sequence - lastSequence;
    return missed.length === need && missed.every((delta, index) => delta.sequence === lastSequence + 1 + index);
  }

  #missed(book: Book, lastSequence: number): StoredDelta[] {
    return book.deltas.filter((delta) => delta.sequence > lastSequence).sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * A snapshot needs a successful open-positions read for this book.
   * Events already folded do not count: the retained tail is not the account's
   * book. Another account has no svc-trade read on the caller's token, so an
   * unseeded operator subscribe is refused and `seed` is not called.
   * A thrown read leaves `seeded` false, so the next subscribe reads again.
   */
  async #ensureSeeded(
    book: Book,
    targetUserId: string,
    sessionUserId: string,
    accessToken: string | undefined,
    seed: PositionsSeed | undefined,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly frame: PositionsErrorFrame }> {
    if (book.seeded) return { ok: true };
    if (targetUserId !== sessionUserId) {
      return {
        ok: false,
        frame: errorFrame(POSITIONS_SNAPSHOT_UNAVAILABLE, "another account's open positions cannot be read on this stream"),
      };
    }
    if (seed === undefined || accessToken === undefined || accessToken.length === 0) {
      return { ok: false, frame: errorFrame(POSITIONS_SNAPSHOT_UNAVAILABLE, 'open positions snapshot is not wired') };
    }
    try {
      await this.#seedBook(book, targetUserId, accessToken, seed);
      return { ok: true };
    } catch {
      return { ok: false, frame: errorFrame(POSITIONS_SNAPSHOT_UNAVAILABLE, 'open positions could not be read') };
    }
  }

  async #seedBook(book: Book, userId: string, accessToken: string, seed: PositionsSeed): Promise<void> {
    if (book.seeded) return;
    const inflight = book.seeding;
    if (inflight) {
      await inflight;
      if (!book.seeded) throw new Error('positions seed failed');
      return;
    }
    const run = this.#readSeed(book, userId, accessToken, seed);
    book.seeding = run;
    try {
      await run;
    } finally {
      if (book.seeding === run) book.seeding = undefined;
    }
  }

  async #readSeed(book: Book, userId: string, accessToken: string, seed: PositionsSeed): Promise<void> {
    const watermark = book.sequence;
    const raw = await seed(userId, accessToken);
    const parsed: PositionRow[] = [];
    for (const item of raw) {
      parsed.push(positionRowFromBook(item, userId));
    }
    book.rows.clear();
    for (const row of parsed) {
      if (openRow(row)) book.rows.set(row.positionId, row);
    }
    for (const delta of this.#missed(book, watermark)) {
      if (openRow(delta.position)) book.rows.set(delta.position.positionId, delta.position);
      else book.rows.delete(delta.position.positionId);
    }
    book.seeded = true;
  }

  #resume(
    book: Book,
    lastSequence: number | undefined,
    clientStreamId: string | undefined,
    asOf: string,
    send: (frame: PositionsFrame) => void,
  ): void {
    if (this.#needsSnapshot(book, lastSequence, clientStreamId)) {
      send(this.#snapshot(book, asOf, lastSequence === undefined ? 'fresh' : 'gap'));
      return;
    }
    if (lastSequence === book.sequence) {
      send({
        channel: POSITIONS_CHANNEL,
        type: 'heartbeat',
        streamId: this.#streamId,
        sequence: book.sequence,
        asOf,
        dataAsOf: book.dataAsOf,
      });
      return;
    }
    for (const delta of this.#missed(book, lastSequence ?? 0)) {
      send({
        channel: POSITIONS_CHANNEL,
        type: 'delta',
        streamId: this.#streamId,
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
      streamId: this.#streamId,
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
  /** Socket access token. The seed read is this caller's own svc-trade request. */
  readonly accessToken?: string;
  /** Omitted when no book port is wired. A cold subscribe then refuses instead of sending `positions: []`. */
  readonly seed?: PositionsSeed;
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
  const streamId = typeof rec.streamId === 'string' && rec.streamId.length > 0 ? rec.streamId : undefined;
  const result = await input.stream.subscribe({
    session: input.session,
    requestedUserId,
    lastSequence: typeof lastSequence === 'number' ? lastSequence : undefined,
    streamId,
    asOf: input.nowIso,
    accessToken: input.accessToken,
    seed: input.seed,
    send: sendFrame,
  });
  if (result.ok) input.onDetach(result.detach);
  return true;
}
