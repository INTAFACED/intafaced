/**
 * SIGNAL BOTS (CB-bots-api-signal-04, J-copy-bots-otc-21 #1 #2 #3).
 *
 * A person runs a signal bot from a signal listing they bought access to in svc-market. Before anything is written,
 * the create checks, in order:
 *   - the owner's signal bot cap (TRADE_SIGNAL_BOT_CAP; blank refuses `trade.signal_bot_cap_unset`): the most one bot
 *     may commit, stored on the bot. A limit, never money: INTAFACED holds nothing here.
 *   - the person's access, read from svc-market's internal door (market-access.ts) on every create, fail closed: an
 *     unreadable answer refuses `trade.signal_access_unavailable`, an unknown listing `trade.signal_listing_not_found`,
 *     and a listing not bought `market.access_required`.
 * The same client bot id again returns the bot it made, and writes nothing. A new bot waits for its first signal
 * (`awaiting_signal`).
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { SignalError } from './signal-desk.js';

export const SIGNAL_BOTS_LIST_MAX = 100;
/** The asset a signal bot's cap is in. */
export const SIGNAL_BOT_CAP_ASSET = 'USDC';

export interface SignalAccessSource {
  /** svc-market's answer for this person and listing; null when the listing is unknown. Throws when unreadable. */
  access(listingId: string, userId: string): Promise<{ access: boolean; title: string } | null>;
}

export interface SignalBotView {
  readonly botId: string;
  readonly clientBotId: string;
  readonly listingId: string;
  readonly title: string;
  readonly state: 'awaiting_signal' | 'active' | 'stopped';
  readonly cap: { readonly amount: string; readonly asset: string };
  readonly createdAt: string;
}

interface BotRow {
  id: string;
  client_bot_id: string;
  listing_id: string;
  title: string;
  state: SignalBotView['state'];
  cap: string;
  cap_asset: string;
  created_at: Date;
}

const view = (r: BotRow): SignalBotView => ({
  botId: r.id,
  clientBotId: r.client_bot_id,
  listingId: r.listing_id,
  title: r.title,
  state: r.state,
  cap: { amount: r.cap, asset: r.cap_asset },
  createdAt: r.created_at.toISOString(),
});

function idFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The owner's signal bot cap: a decimal above zero, or null when blank. Anything else stops the boot. */
export function parseSignalBotCap(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value) || parseAmount(value) <= 0n) {
    throw new Error('TRADE_SIGNAL_BOT_CAP must be an amount above zero, or blank');
  }
  return formatAmount(parseAmount(value));
}

export class SignalBots {
  constructor(
    private readonly sql: Sql,
    private readonly market: SignalAccessSource,
    /** The owner's cap per bot; null refuses every create. */
    private readonly cap: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(principal: Principal, input: { listingId: string; clientBotId: string }): Promise<SignalBotView> {
    const userId = principal.userId;
    const [existing] = await this.sql<BotRow[]>`
      SELECT * FROM trade.signal_bots WHERE user_id = ${userId} AND client_bot_id = ${input.clientBotId}`;
    if (existing) {
      if (existing.listing_id !== input.listingId) {
        throw new SignalError('That bot key already made a bot from another listing', 'trade.signal_bot_key_conflict', 409);
      }
      return view(existing);
    }
    if (this.cap === null) {
      throw new SignalError('The platform has not set a signal bot cap, so no signal bot can be made', 'trade.signal_bot_cap_unset', 412);
    }
    let answer;
    try {
      answer = await this.market.access(input.listingId, userId);
    } catch (err) {
      throw new SignalError(`signal access unreadable: ${(err as Error).message}`, 'trade.signal_access_unavailable', 503);
    }
    if (!answer) throw new SignalError('No signal listing has that id', 'trade.signal_listing_not_found', 404);
    if (!answer.access) throw new SignalError('Buy access to this signal first', 'market.access_required', 403);
    const at = this.now();
    await this.sql`
      INSERT INTO trade.signal_bots (id, user_id, client_bot_id, listing_id, title, state, cap, cap_asset, created_at, updated_at)
      VALUES (${idFor(`signal-bot:${userId}:${input.clientBotId}`)}, ${userId}, ${input.clientBotId}, ${input.listingId},
              ${answer.title}, 'awaiting_signal', ${this.cap}, ${SIGNAL_BOT_CAP_ASSET}, ${at}, ${at})
      ON CONFLICT (user_id, client_bot_id) DO NOTHING`;
    const [row] = await this.sql<BotRow[]>`
      SELECT * FROM trade.signal_bots WHERE user_id = ${userId} AND client_bot_id = ${input.clientBotId}`;
    if (row!.listing_id !== input.listingId) {
      throw new SignalError('That bot key already made a bot from another listing', 'trade.signal_bot_key_conflict', 409);
    }
    return view(row!);
  }

  async list(principal: Principal): Promise<SignalBotView[]> {
    const rows = await this.sql<BotRow[]>`
      SELECT * FROM trade.signal_bots WHERE user_id = ${principal.userId}
       ORDER BY created_at DESC, id LIMIT ${SIGNAL_BOTS_LIST_MAX}`;
    return rows.map(view);
  }
}
