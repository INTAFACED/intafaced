/**
 * COPY TRADING ON THE VENUE (J-copy-bots-otc-03 #3 #4; the venue form of CB-copy-09/10, OWNER 226).
 *
 * A venue follow is a follow bound, before it is saved, to one of the follower's own open agent accounts
 * (venue/agent-account.ts): a venue sub-account under the follower's own wallet, with the agent permission their wallet
 * signed for the key INTAFACED holds for it, which can place and cancel orders there and can never withdraw. From then
 * on everything the copy desk does for that follow happens on the venue:
 *
 *   · the leader's fills are the venue's own fills on the leader's own venue account (an account the leader signed for
 *     through our door), read from the venue, never from our book;
 *   · each copy is one venue order on the follower's agent sub-account, placed by the agent permission through
 *     `AgentOrders.placeOnAccount`, held to the follower's caps before the agent key signs, and sent once under
 *     `copy-mirror:<followId>:<clientOrderId>`;
 *   · a copied position is what the venue reports that copy's fills left on the sub-account, less what the venue
 *     reports the closes of it sold;
 *   · a close of one position is one venue order placed by the agent permission and sent once under
 *     `copy.close:<followId>:<leaderFillId>` (copy-close.ts `copyCloseKey`); a close-all, after the person's step-up
 *     (copy-service.ts `flatten`), sends one such order per open position under `copy.flatten:<followId>:<leaderFillId>`.
 *
 * Money: INTAFACED holds and moves nothing, and the ledger posts nothing here. What a close frees stays on the
 * follower's own venue sub-account, as the venue reports it. A follow that is not bound keeps the existing paths.
 *
 * Crash points (whose funds are stranded?): none. Each order's bytes are stored under its business key before they are
 * sent (the user-venue door), a retry of the key reads the venue's record by its client order id first, and every
 * order can only rest or fill on the follower's own sub-account, which their wallet controls.
 */
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { mul } from '@intafaced/ledger-client/money';
import { isTestVenue, type UserVenue, type UserVenueAccount, type UserVenueFill, type UserVenueOrder } from '@intafaced/venue-contracts';
import type { Sql } from 'postgres';
import type { AgentAccountRecord, AgentAccountStore } from '../venue/agent-account-store.js';
import type { AgentOrders } from '../venue/agent-orders.js';
import type { PreparedActionStore, StoredVenueAction } from '../venue/prepared-action-store.js';
import type { PlaceFollowerOrderInput } from './auto-mirror-place.js';
import { CopyCloseError } from './copy-close-errors.js';
import type { CopyCloseLatest, CopyClosePlaceInput, CopyClosePort, CopyCloseRecord } from './copy-close.js';
import type { FlattenCopyPositionInput, FlattenCopyPositionResult } from './copy-flatten.js';
import { allocateCopiedPositions, type CopiedPosition, type CopiedSell } from './copied-positions.js';
import { CopyError } from './errors.js';
import type { CopyFollowStore } from './follow-store.js';
import { fenceNewIntent } from './follower-flatten-port.js';
import type { CopyCursor } from './follows.js';

// ── the binding ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface VenueFollowBinding {
  readonly followId: string;
  readonly followerId: string;
  /** The follower's own agent account (venue/agent-account.ts) every copy of this follow is placed on. */
  readonly accountId: string;
  readonly createdAt: Date;
}

export interface VenueFollowStore {
  get(followId: string): Promise<VenueFollowBinding | null>;
  /** Stores `binding` unless the follow already has one; returns the one stored (the caller refuses a different one). */
  bindOnce(binding: VenueFollowBinding): Promise<VenueFollowBinding>;
}

export class InMemoryVenueFollowStore implements VenueFollowStore {
  private readonly rows = new Map<string, VenueFollowBinding>();
  async get(followId: string) {
    return this.rows.get(followId) ?? null;
  }
  async bindOnce(binding: VenueFollowBinding) {
    const had = this.rows.get(binding.followId);
    if (had) return had;
    this.rows.set(binding.followId, binding);
    return binding;
  }
}

type BindingRow = { follow_id: string; follower_id: string; account_id: string; created_at: Date };
const bindingOf = (r: BindingRow): VenueFollowBinding => ({
  followId: r.follow_id,
  followerId: r.follower_id,
  accountId: r.account_id,
  createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
});

/** `trade.copy_venue_follows` (drizzle/20261112150000_copy_venue_follows.sql). */
export class SqlVenueFollowStore implements VenueFollowStore {
  constructor(private readonly sql: Sql) {}
  async get(followId: string) {
    const [row] = await this.sql<BindingRow[]>`
      SELECT follow_id, follower_id, account_id::text AS account_id, created_at FROM trade.copy_venue_follows WHERE follow_id = ${followId}`;
    return row ? bindingOf(row) : null;
  }
  async bindOnce(b: VenueFollowBinding) {
    await this.sql`
      INSERT INTO trade.copy_venue_follows (follow_id, follower_id, account_id, created_at)
      VALUES (${b.followId}, ${b.followerId}, ${b.accountId}::uuid, ${b.createdAt})
      ON CONFLICT (follow_id) DO NOTHING`;
    return (await this.get(b.followId))!;
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A leader's venue fill as the copy desk names it: the leader's venue account, the fill's time and the venue's id. */
export function venueLeaderFillId(owner: string, filledAt: Date, venueFillId: string): string {
  return `venue:${owner.toLowerCase()}:${filledAt.getTime()}:${venueFillId}`;
}

export function parseVenueLeaderFillId(id: string): { owner: string; at: Date; venueFillId: string } | null {
  const m = /^venue:(0x[0-9a-f]{40}):(\d{1,15}):(.+)$/.exec(id.trim());
  if (!m) return null;
  return { owner: m[1]!, at: new Date(Number(m[2])), venueFillId: m[3]! };
}

export const isVenueLeaderFillId = (id: string) => parseVenueLeaderFillId(id) !== null;

/** The business key a copy of one leader fill is sent once under, on the venue. */
export const venueMirrorKey = (followId: string, clientOrderId: string) => `copy-mirror:${followId}:${clientOrderId}`;
/** The key of a close-all's close of one copied position. */
export const venueFlattenKey = (followId: string, leaderFillId: string) => `copy.flatten:${followId}:${leaderFillId}`;

/** Stored keys of `prefix`, each its own close of `leaderFillId`: the key itself, a part (`:<qty>`) or a later try (`#n`). */
function closesOf(rows: readonly StoredVenueAction[], prefix: string): StoredVenueAction[] {
  return rows.filter((r) => r.businessKey === prefix || r.businessKey.startsWith(`${prefix}:`) || r.businessKey.startsWith(`${prefix}#`));
}

const FINAL = new Set(['filled', 'cancelled', 'expired', 'rejected']);

// ── the desk ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VenueCopyDeps {
  readonly venue: () => Promise<UserVenue>;
  readonly orders: Pick<AgentOrders, 'placeOnAccount'>;
  readonly accounts: Pick<AgentAccountStore, 'find'>;
  readonly actions: Pick<PreparedActionStore, 'find' | 'listByPrefix' | 'ownerSignedAccounts'>;
  readonly bindings: VenueFollowStore;
  readonly copyStore: Pick<CopyFollowStore, 'getFollow' | 'saveFollow'>;
  /** The follow's copies: `copy_placed_mirrors` with each one's plan from `copy_mirrored_fills`. */
  readonly placedMirrors: (followId: string) => Promise<readonly VenueMirrorRow[]>;
  /** The owner's protection floor for a close: the most below the best bid a close may sell (blank refuses). */
  readonly slippageCapBps: number | null;
}

export interface VenueMirrorRow {
  readonly leaderFillId: string;
  /** The business key the copy was sent under. */
  readonly orderKey: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly qty: Amount;
  readonly placedAt: Date;
}

export function sqlPlacedMirrors(sql: Sql): VenueCopyDeps['placedMirrors'] {
  return async (followId) => {
    const rows = await sql<Array<{ fill_id: string; order_id: string; market_id: string; side: string; qty: string; created_at: Date }>>`
      SELECT pm.fill_id, pm.order_id, mf.market_id, mf.side, mf.qty::text AS qty, pm.created_at
        FROM trade.copy_placed_mirrors pm
        INNER JOIN trade.copy_mirrored_fills mf ON mf.follow_id = pm.follow_id AND mf.fill_id = pm.fill_id
       WHERE pm.follow_id = ${followId}
       ORDER BY pm.created_at ASC, pm.fill_id ASC`;
    return rows.map((r) => ({
      leaderFillId: r.fill_id,
      orderKey: r.order_id,
      symbol: r.market_id,
      side: r.side === 'sell' ? 'sell' : 'buy',
      qty: parseAmount(r.qty),
      placedAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));
  };
}

type Bound = { binding: VenueFollowBinding; account: AgentAccountRecord & { subAccount: string }; sub: UserVenueAccount; venue: UserVenue };

/** What one order key comes to on the venue: what it filled, what may still fill, and whether it is final. */
type KeyState = { filled: Amount; feeInBase: Amount; pending: Amount; final: boolean; order: UserVenueOrder | null };

export class VenueCopy {
  constructor(private readonly deps: VenueCopyDeps) {}

  async isVenueFollow(followId: string): Promise<boolean> {
    return (await this.deps.bindings.get(followId)) !== null;
  }

  /**
   * Binds a new follow to the follower's own open agent account, before the follow is saved. The account's asset must
   * be the follow's quote asset. The same follow asked again with another account is refused.
   */
  async bind(followerId: string, followId: string, accountId: string, quoteAsset: string, at: Date): Promise<void> {
    const a = await this.deps.accounts.find(followerId, accountId);
    if (!a || a.status !== 'open' || a.subAccount === null) {
      throw new CopyError('Copy on the venue needs one of your own open agent accounts', 'trade.copy_venue_account_not_open');
    }
    if (a.asset !== quoteAsset) {
      throw new CopyError(
        `This agent account holds ${a.asset}; these markets settle in ${quoteAsset}`,
        'trade.copy_venue_account_not_open',
      );
    }
    const kept = await this.deps.bindings.bindOnce({ followId, followerId, accountId: a.accountId, createdAt: at });
    if (kept.accountId !== a.accountId || kept.followerId !== followerId) {
      throw new CopyError('This follow already copies onto another agent account', 'trade.copy_venue_account_not_open');
    }
  }

  private async bound(followId: string): Promise<Bound | null> {
    const binding = await this.deps.bindings.get(followId);
    if (!binding) return null;
    const a = await this.deps.accounts.find(binding.followerId, binding.accountId);
    if (!a || a.subAccount === null)
      throw new CopyCloseError('The agent account this follow copies onto is gone', 'trade.copy_close_unavailable');
    const venue = await this.deps.venue();
    return {
      binding,
      account: a as AgentAccountRecord & { subAccount: string },
      sub: { venueId: venue.venue.id, owner: a.owner, subAccount: a.subAccount },
      venue,
    };
  }

  // ── the leader's fills ─────────────────────────────────────────────────────────────────────────────────────────

  /** The leader's own venue accounts: main accounts the leader signed for through our door. */
  private async leaderAccounts(leaderId: string, venue: UserVenue): Promise<UserVenueAccount[]> {
    const signed = await this.deps.actions.ownerSignedAccounts(leaderId, venue.venue.id);
    const owners = [...new Set(signed.filter((s) => s.subAccount === null).map((s) => s.owner.toLowerCase()))];
    return owners.map((owner) => ({ venueId: venue.venue.id, owner, subAccount: null }));
  }

  /** The leader's spot fills on the venue after `after`, oldest first, as the copy driver reads them. */
  async leaderFillsSince(leaderId: string, after: CopyCursor, limit: number) {
    const venue = await this.deps.venue();
    const spot = new Set((await venue.markets(null)).value.filter((m) => m.kind === 'spot').map((m) => m.symbol));
    const out: Array<{ fillId: string; marketId: string; at: Date }> = [];
    for (const account of await this.leaderAccounts(leaderId, venue)) {
      for (const f of (await venue.fills(account, after.at)).value) {
        if (!spot.has(f.symbol)) continue;
        out.push({ fillId: venueLeaderFillId(account.owner, f.filledAt, f.fillId), marketId: f.symbol, at: f.filledAt });
      }
    }
    const afterMs = after.at.getTime();
    return out
      .filter((f) => f.at.getTime() > afterMs || (f.at.getTime() === afterMs && f.fillId > (after.fillId ?? '')))
      .sort((x, y) => x.at.getTime() - y.at.getTime() || (x.fillId < y.fillId ? -1 : x.fillId > y.fillId ? 1 : 0))
      .slice(0, limit);
  }

  /** One leader fill, read again from the venue: only on a venue account the leader signed for. */
  async leaderFill(fillId: string, leaderId: string) {
    const parsed = parseVenueLeaderFillId(fillId);
    if (!parsed) return null;
    const venue = await this.deps.venue();
    const account = (await this.leaderAccounts(leaderId, venue)).find((a) => a.owner === parsed.owner);
    if (!account) return null;
    const fill = (await venue.fills(account, parsed.at)).value.find((f) => f.fillId === parsed.venueFillId);
    if (!fill) return null;
    return {
      fillId,
      userId: leaderId,
      marketId: fill.symbol,
      side: fill.side,
      qty: fill.amount,
      notional: mulDown(fill.amount, fill.price),
      price: fill.price,
    };
  }

  async inspectMarket(symbol: string) {
    const venue = await this.deps.venue();
    const m = (await venue.markets(null)).value.find((x) => x.symbol === symbol);
    return m ? { paper: false, lotSize: m.lotSize } : null;
  }

  // ── a copy ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** One copy: a limit at the plan's price on the follower's agent sub-account, placed by the agent permission, sent once. */
  async placeMirror(principal: Principal, input: PlaceFollowerOrderInput): Promise<{ orderId: string }> {
    const b = input.followId ? await this.bound(input.followId) : null;
    if (!b || b.binding.followerId !== principal.userId) throw new CopyError('Follow not found', 'trade.copy_not_following');
    const key = venueMirrorKey(b.binding.followId, input.clientOrderId);
    await this.deps.orders.placeOnAccount(principal, b.binding.accountId, key, {
      symbol: input.symbol ?? input.marketId ?? '',
      side: input.side,
      amount: input.qty,
      price: input.price,
      timeInForce: 'GTC',
    });
    return { orderId: key };
  }

  // ── what the venue reports ─────────────────────────────────────────────────────────────────────────────────────

  private async keyState(b: Bound, row: StoredVenueAction | null, fills: readonly UserVenueFill[], baseAsset: string): Promise<KeyState> {
    const empty: KeyState = { filled: 0n, feeInBase: 0n, pending: 0n, final: true, order: null };
    if (!row || row.prepared.intent.kind !== 'place_order') return empty;
    const intent = row.prepared.intent;
    const cloid = row.prepared.venueClientOrderId ?? null;
    if (!row.signature || !cloid) return { ...empty, final: true };
    let filled = 0n;
    let feeInBase = 0n;
    for (const f of fills) {
      if (f.venueClientOrderId !== cloid) continue;
      filled += f.amount;
      if (f.feeAsset === baseAsset) feeInBase += f.venueFee + f.builderFee;
    }
    const outcome = row.lastOutcome;
    if (outcome?.definite && !outcome.accepted) return { filled, feeInBase, pending: 0n, final: true, order: null };
    const order = (await b.venue.orderByClientId(b.sub, cloid)).value;
    if (!order) {
      // Signed and not on the venue's record yet: its outcome is not known, so all of it may still sell.
      return { filled, feeInBase, pending: intent.amount - filled > 0n ? intent.amount - filled : 0n, final: false, order: null };
    }
    const final = FINAL.has(order.status);
    return { filled, feeInBase, pending: final ? 0n : order.remaining, final, order };
  }

  /** The follow's copied positions, from the venue's own record of the sub-account: every figure as the venue reports it. */
  async positions(input: { followId: string; followerId: string }): Promise<CopiedPosition[] | null> {
    const b = await this.bound(input.followId);
    if (!b) return null;
    if (b.binding.followerId !== input.followerId) return [];
    const markets = new Map((await b.venue.markets(b.sub)).value.map((m) => [m.symbol, m]));
    const fills = (await b.venue.fills(b.sub, b.binding.createdAt)).value;
    const asOf = new Date();
    const mirrors = await this.deps.placedMirrors(input.followId);
    const closeRows = await this.deps.actions.listByPrefix(input.followerId, `copy.close:${input.followId}:`);
    const flattenRows = await this.deps.actions.listByPrefix(input.followerId, `copy.flatten:${input.followId}:`);

    const buys = [];
    const targeted = new Map<string, CopiedSell[]>();
    const untargeted = new Map<string, CopiedSell[]>();
    for (const m of mirrors) {
      const market = markets.get(m.symbol);
      if (!market) continue;
      const state = await this.keyState(b, await this.deps.actions.find(input.followerId, m.orderKey), fills, market.baseAsset);
      if (m.side === 'sell') {
        const list = untargeted.get(m.symbol) ?? [];
        list.push({ sold: state.filled, pending: state.pending });
        untargeted.set(m.symbol, list);
        continue;
      }
      buys.push({
        orderId: m.orderKey,
        leaderFillId: m.leaderFillId,
        symbol: m.symbol,
        marketId: m.symbol,
        baseAsset: market.baseAsset,
        lotSize: market.lotSize,
        received: state.filled - state.feeInBase > 0n ? state.filled - state.feeInBase : 0n,
        live: !state.final,
        placedAt: m.placedAt,
      });
      const sells: CopiedSell[] = [];
      for (const row of [
        ...closesOf(closeRows, `copy.close:${input.followId}:${m.leaderFillId}`),
        ...closesOf(flattenRows, venueFlattenKey(input.followId, m.leaderFillId)),
      ]) {
        const s = await this.keyState(b, row, fills, market.baseAsset);
        sells.push({ sold: s.filled, pending: s.pending });
      }
      targeted.set(m.leaderFillId, sells);
    }
    const reportedBy = { venue: b.venue.venue.displayName, test: isTestVenue(b.venue.venue), asOf };
    return allocateCopiedPositions({ buys, targeted, untargeted }).map((p) => ({ ...p, reportedBy }));
  }

  /** The copies of one follow as the follower sees them: each one's venue order, as the venue reports it. */
  async copiedOrders(followId: string, followerId: string) {
    const b = await this.bound(followId);
    if (!b) return null;
    const out = [];
    for (const m of [...(await this.deps.placedMirrors(followId))].reverse()) {
      const row = await this.deps.actions.find(followerId, m.orderKey);
      const cloid = row?.prepared.venueClientOrderId ?? null;
      const order = cloid ? (await b.venue.orderByClientId(b.sub, cloid)).value : null;
      const intent = row?.prepared.intent.kind === 'place_order' ? row.prepared.intent : null;
      out.push({
        orderId: m.orderKey,
        market: m.symbol,
        side: m.side,
        qty: formatAmount(order?.amount ?? intent?.amount ?? m.qty),
        filledQty: formatAmount(order?.filled ?? 0n),
        price: formatAmount(order?.price ?? intent?.price ?? 0n),
        status: order?.status ?? (row?.signature ? 'unknown' : 'pending'),
        placedAt: m.placedAt.toISOString(),
      });
    }
    return out;
  }

  // ── closes ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The owner's floor below the venue's best bid, on the market's tick: a close sells at that price or better. */
  private async closePrice(b: Bound, symbol: string): Promise<Amount> {
    const cap = this.deps.slippageCapBps;
    if (cap === null || !Number.isInteger(cap) || cap < 1 || cap > 5000) {
      throw new CopyCloseError(
        'The owner has not set the close protection floor (TRADE_MARKET_SLIPPAGE_CAP_BPS); nothing is sent',
        'trade.copy_close_unavailable',
      );
    }
    const market = (await b.venue.markets(b.sub)).value.find((m) => m.symbol === symbol);
    const bid = (await b.venue.book(symbol, 1)).value.bids[0]?.price ?? null;
    if (!market || bid === null || bid <= 0n) {
      throw new CopyCloseError(
        `${symbol} has no bid on ${b.venue.venue.displayName} to price a close against; nothing is sent`,
        'trade.copy_close_unavailable',
      );
    }
    const slipped = bid - (bid * BigInt(cap)) / 10_000n;
    const remainder = slipped % market.tickSize;
    const price = remainder === 0n ? slipped : slipped + (market.tickSize - remainder);
    if (price <= 0n) throw new CopyCloseError(`${symbol} close floor is not above zero; nothing is sent`, 'trade.copy_close_unavailable');
    return price;
  }

  private async sendClose(principal: Principal, b: Bound, key: string, symbol: string, qty: Amount): Promise<string> {
    const stored = await this.deps.actions.find(principal.userId, key);
    if (stored?.prepared.intent.kind === 'place_order') {
      const i = stored.prepared.intent;
      await this.deps.orders.placeOnAccount(principal, b.binding.accountId, key, {
        symbol: i.symbol,
        side: i.side,
        amount: i.amount,
        price: i.price,
        timeInForce: i.timeInForce === 'GTC' ? 'GTC' : 'IOC',
      });
      return key;
    }
    const price = await this.closePrice(b, symbol);
    await this.deps.orders.placeOnAccount(principal, b.binding.accountId, key, {
      symbol,
      side: 'sell',
      amount: qty,
      price,
      timeInForce: 'IOC',
    });
    return key;
  }

  /** copy-close.ts's port, on the venue: the close's record is the door's stored action under its key. */
  closePort(): CopyClosePort {
    return {
      latest: async (followId, closeKey) => {
        const b = await this.bound(followId);
        if (!b) return null;
        const rows = (await this.deps.actions.listByPrefix(b.binding.followerId, closeKey)).filter(
          (r) => r.businessKey === closeKey || /^#\d+$/.test(r.businessKey.slice(closeKey.length)),
        );
        if (rows.length === 0) return null;
        const attempt = (k: string) => (k === closeKey ? 1 : Number(k.slice(closeKey.length + 1)));
        const last = rows.reduce((x, y) => (attempt(y.businessKey) > attempt(x.businessKey) ? y : x));
        const intent = last.prepared.intent;
        if (intent.kind !== 'place_order')
          throw new CopyCloseError('The close key holds something other than a close', 'trade.copy_close_conflict');
        const fills = (await b.venue.fills(b.sub, b.binding.createdAt)).value;
        const state = await this.keyState(b, last, fills, '');
        const record: CopyCloseRecord = {
          closeKey: last.businessKey,
          followId,
          leaderFillId: closeKey,
          followerOrderId: last.businessKey,
          clientOrderId: last.prepared.venueClientOrderId ?? last.businessKey,
          symbol: intent.symbol,
          marketId: intent.symbol,
          qty: intent.amount,
          price: intent.price,
        };
        const latest: CopyCloseLatest = { record, attempts: Math.max(...rows.map((r) => attempt(r.businessKey))), settled: state.final };
        return latest;
      },
      resume: async (principal, record) => {
        const b = await this.bound(record.followId);
        if (!b) throw new CopyCloseError('This follow does not copy on the venue', 'trade.copy_close_conflict');
        return { orderId: await this.sendClose(principal, b, record.closeKey, record.symbol, record.qty) };
      },
      place: async (principal, input: CopyClosePlaceInput) => {
        const b = await this.bound(input.followId);
        if (!b || b.binding.followerId !== principal.userId)
          throw new CopyCloseError('This follow does not copy on the venue', 'trade.copy_close_conflict');
        return { orderId: await this.sendClose(principal, b, input.closeKey, input.symbol, input.qty) };
      },
    };
  }

  /**
   * The close-all, after the person's step-up (copy-service.ts `flatten`): new copies are fenced first, then each open
   * copied position is closed by one venue order under `copy.flatten:<followId>:<leaderFillId>`. A replay
   * (`lookupOnly`) only finds the closes already sent under those keys and never sends one.
   */
  async flatten(principal: Principal, input: FlattenCopyPositionInput): Promise<FlattenCopyPositionResult | null> {
    const b = await this.bound(input.followId);
    if (!b) return null;
    const positions = (await this.positions({ followId: input.followId, followerId: input.followerId })) ?? [];
    if (input.lookupOnly) {
      const sent = await this.deps.actions.listByPrefix(input.followerId, `copy.flatten:${input.followId}:`);
      const keys = sent.filter((r) => r.signature).map((r) => r.businessKey);
      const unplaced = positions.some((p) => p.open > 0n && !keys.includes(venueFlattenKey(input.followId, p.leaderFillId)));
      return { orderIds: keys, ...(unplaced ? { unplaced: true } : {}) };
    }
    const open = positions.filter((p) => p.open > 0n);
    const placed: string[] = [];
    let fenced = false;
    for (const p of open) {
      let price: Amount;
      try {
        price = await this.closePrice(b, p.symbol);
      } catch (err) {
        if (!(err instanceof CopyCloseError)) throw err;
        return placed.length === 0 ? { orderIds: [], refuse: 'unavailable' } : { orderIds: placed, refuse: 'partial' };
      }
      if (!fenced) {
        await fenceNewIntent(this.deps.copyStore as CopyFollowStore, input.followId);
        fenced = true;
      }
      const key = venueFlattenKey(input.followId, p.leaderFillId);
      try {
        await this.deps.orders.placeOnAccount(principal, b.binding.accountId, key, {
          symbol: p.symbol,
          side: 'sell',
          amount: p.open,
          price,
          timeInForce: 'IOC',
        });
      } catch (err) {
        if (placed.length === 0) throw err;
        return { orderIds: placed, refuse: 'partial' };
      }
      placed.push(key);
    }
    return { orderIds: placed };
  }
}

const mulDown = (a: Amount, b: Amount): Amount => mul(a, b, 'floor');
