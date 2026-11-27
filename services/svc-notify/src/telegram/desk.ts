import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { TradeDeskSnapshot, TradeDeskSnapshotPort } from '@intafaced/contracts/trade-desk-snapshot';
import type { NotifyTelegramStatus } from '@intafaced/contracts/notify-telegram-procedures';
import { compareDecimalStrings, parseDecimalString } from '../alerts/decimal.js';
import { NotifyVerifyTtlUnsetError, publishedVerifyTtlMinutes } from '../notify-service.js';
import type { TelegramStore } from './store.js';

/**
 * THE LAUNCH DESK'S READ-ONLY TELEGRAM ALERTS.
 *
 * A person links one chat with a one-time code the account settings API issues (`issueLinkCode`), by sending
 * `/start <code>` to the bot from that chat. From then on a sweep pushes, for their own venue accounts, each fill once, the
 * 80% and 90% margin-use warnings once per crossing, and a profit-lock alert once a week when the week's realised profit
 * reaches their target. The bot answers `/positions` and `/pnl` and refuses everything else.
 *
 * READ-ONLY BY CONSTRUCTION. The desk's only way to the venue is `TradeDeskSnapshotPort.read`, svc-trade's read of the
 * venue's own figures. It holds no signer, no session key and no door that writes: there is nothing a command could call
 * to trade, cancel or move money, whatever text arrives.
 *
 * ONCE AT ITS THRESHOLD. Every alert is raised under a business key (`fill:<fillId>`,
 * `margin:<account>:<level>:<crossing>`, `profit-lock:<weekStart>`) in the store's outbox, so a sweep that sees it again,
 * or a crash between raising and sending, never raises it twice. A margin level is armed below it and disarmed when it
 * fires, so it warns again only after margin use falls back below it. An alert the transport did not take stays in the
 * outbox and is sent on the next sweep.
 *
 * With no bot token the channel is off (`notify.telegram_token_unset`): status says so, no code is issued, nothing sweeps.
 */

export const TELEGRAM_OFF_TOKEN_UNSET = 'notify.telegram_token_unset' as const;
const TELEGRAM_OFF_OUT_OF_APP = 'notify.out_of_app_off' as const;
export type TelegramOffReason = typeof TELEGRAM_OFF_TOKEN_UNSET | typeof TELEGRAM_OFF_OUT_OF_APP;
const TELEGRAM_TARGET_INVALID = 'notify.telegram_target_invalid' as const;

/** The two margin-use levels, in percent, lowest first. */
const MARGIN_USE_LEVELS = ['80', '90'] as const;

const PRIVATE_ONLY_REPLY = 'This bot works only in a private chat with you, so no one else sees your figures.';

const READ_ONLY_REPLY = 'This bot is read-only: it answers /positions and /pnl. It never trades, cancels or moves money.';

/** The address-confirmation lifetime the owner sets (`NOTIFY_VERIFY_TTL_MINUTES`) also bounds a link code. */
export { NotifyVerifyTtlUnsetError as TelegramLinkTtlUnsetError };

export class TelegramDeskOffError extends Error {
  constructor(readonly code: TelegramOffReason = TELEGRAM_OFF_TOKEN_UNSET) {
    super(
      code === TELEGRAM_OFF_TOKEN_UNSET
        ? 'Telegram alerts are off on this deployment: no bot token is set'
        : 'Telegram alerts are off on this deployment: messages that leave the platform are switched off',
    );
    this.name = 'TelegramDeskOffError';
  }
}

export class TelegramTargetInvalidError extends Error {
  readonly code = TELEGRAM_TARGET_INVALID;
  constructor(raw: string) {
    super(`The profit target must be a positive decimal like 250 or 250.5, not ${JSON.stringify(raw.slice(0, 40))}`);
    this.name = 'TelegramTargetInvalidError';
  }
}

/** Sends one message to one chat; throws when the transport did not take it. */
export interface TelegramTransport {
  send(chatId: string, text: string): Promise<void>;
}

export interface TelegramDeskDeps {
  readonly store: TelegramStore;
  /** `null` when no bot token is set: the channel is off. */
  readonly transport: TelegramTransport | null;
  /** The operator's switch for everything that leaves the platform; absent means on. Off, the channel is off. */
  readonly outOfAppEnabled?: boolean;
  readonly reader: TradeDeskSnapshotPort;
  readonly now?: () => Date;
  /** `NOTIFY_VERIFY_TTL_MINUTES`; blank refuses a link code. */
  readonly linkCodeTtlMinutes: number | undefined;
  /** A new link code; 32 random bytes, hex, unless a test supplies its own. */
  readonly newCode?: () => string;
}

export interface TelegramSweepReport {
  readonly linked: number;
  readonly unread: number;
  readonly raised: number;
  readonly sent: number;
}

/** What a webhook update carries that the desk reads: the chat and its text. Anything else is ignored. */
const TelegramUpdate = z.object({
  message: z.object({
    chat: z.object({ id: z.union([z.number().int(), z.string().min(1).max(64)]), type: z.string().max(32).optional() }),
    text: z.string().max(4096),
  }),
});

const OUTBOX_BATCH = 100;

/** How often the sweep reads each linked desk: a fill or a crossing is pushed within about this long. */
export const TELEGRAM_SWEEP_INTERVAL_MS = 15_000;

const digestOf = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

export class TelegramDesk {
  private readonly now: () => Date;
  private readonly newCode: () => string;

  constructor(private readonly deps: TelegramDeskDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newCode = deps.newCode ?? (() => randomBytes(32).toString('hex'));
  }

  /** Why the channel is off, or null when it is on. */
  get offReason(): TelegramOffReason | null {
    if (this.deps.transport === null) return TELEGRAM_OFF_TOKEN_UNSET;
    if (this.deps.outOfAppEnabled === false) return TELEGRAM_OFF_OUT_OF_APP;
    return null;
  }

  get on(): boolean {
    return this.offReason === null;
  }

  async status(userId: string): Promise<NotifyTelegramStatus> {
    const off = this.offReason;
    if (off) return { state: 'off', reason: off };
    const [link, profitTarget] = await Promise.all([this.deps.store.linkByUser(userId), this.deps.store.profitTarget(userId)]);
    return link ? { state: 'linked', linkedAt: link.linkedAt.toISOString(), profitTarget } : { state: 'unlinked', profitTarget };
  }

  async issueLinkCode(userId: string): Promise<{ code: string; command: string; expiresAt: string }> {
    const off = this.offReason;
    if (off) throw new TelegramDeskOffError(off);
    const ttl = publishedVerifyTtlMinutes(this.deps.linkCodeTtlMinutes);
    const code = this.newCode();
    const expiresAt = new Date(this.now().getTime() + ttl * 60_000);
    await this.deps.store.putCode(userId, digestOf(code), expiresAt);
    return { code, command: `/start ${code}`, expiresAt: expiresAt.toISOString() };
  }

  async unlink(userId: string): Promise<{ unlinked: boolean }> {
    return { unlinked: await this.deps.store.unlink(userId) };
  }

  async setProfitTarget(userId: string, raw: string | null): Promise<{ profitTarget: string | null }> {
    if (raw === null) {
      await this.deps.store.setProfitTarget(userId, null);
      return { profitTarget: null };
    }
    const p = parseDecimalString(raw);
    if (!p.ok || p.negative || !/^\d+(\.\d+)?$/.test(raw.trim()) || (p.int === '0' && p.frac === ''))
      throw new TelegramTargetInvalidError(raw);
    const target = p.frac ? `${p.int}.${p.frac}` : p.int;
    await this.deps.store.setProfitTarget(userId, target);
    return { profitTarget: target };
  }

  /** One webhook update: the reply goes back to the chat it came from. */
  async handleUpdate(update: unknown): Promise<void> {
    const transport = this.deps.transport;
    const parsed = TelegramUpdate.safeParse(update);
    if (!transport || !this.on || !parsed.success) return;
    const { chat, text } = parsed.data.message;
    const chatId = String(chat.id);
    // Figures go only to the person: a group or channel chat is never linked and is never answered with figures.
    if (chat.type !== 'private') return transport.send(chatId, PRIVATE_ONLY_REPLY);
    await transport.send(chatId, await this.reply(chatId, text));
  }

  private async reply(chatId: string, text: string): Promise<string> {
    const [head = '', ...rest] = text.trim().split(/\s+/);
    const command = head.toLowerCase().replace(/@[a-z0-9_]+$/, '');
    if (command === '/start') return this.link(chatId, rest[0]);
    if (command !== '/positions' && command !== '/pnl') return READ_ONLY_REPLY;
    const link = await this.deps.store.linkByChat(chatId);
    if (!link) return 'This chat is not linked. Get a one-time code in the app under Account settings, then send /start <code> here.';
    const read = await this.deps.reader.read({ userId: link.userId, since: link.linkedAt.toISOString() });
    if (read.state === 'off') return 'No venue is connected on this deployment, so there are no figures to show.';
    if (read.state !== 'read') return 'Your venue account could not be read just now. Try again in a moment.';
    return command === '/positions' ? positionsText(read) : pnlText(read);
  }

  private async link(chatId: string, code: string | undefined): Promise<string> {
    if (!code) return 'Send /start followed by the one-time code from Account settings in the app.';
    const out = await this.deps.store.redeemCode(digestOf(code), chatId, this.now());
    if (!out.ok)
      return out.reason === 'chat_taken'
        ? 'This chat is already linked to another account. Unlink it there first.'
        : 'That code is not valid: it is wrong, used or expired. Get a new one in Account settings.';
    return `Linked. ${READ_ONLY_REPLY} Alerts: your fills, margin use at 80% and 90%, and your weekly profit target.`;
  }

  /** One pass: read each linked person's desk, raise what crossed, then send everything raised and not yet sent. */
  async sweep(): Promise<TelegramSweepReport> {
    if (!this.on) return { linked: 0, unread: 0, raised: 0, sent: 0 };
    const links = await this.deps.store.links();
    let raised = 0;
    let unread = 0;
    for (const link of links) {
      const read = await this.deps.reader.read({ userId: link.userId, since: link.linkedAt.toISOString() });
      if (read.state !== 'read') {
        unread += 1;
        continue;
      }
      raised += await this.raise(link.userId, read);
    }
    return { linked: links.length, unread, raised, sent: await this.flush() };
  }

  private async raise(userId: string, desk: TradeDeskSnapshot): Promise<number> {
    const { store } = this.deps;
    const at = this.now();
    const label = desk.test ? 'TEST · ' : '';
    let raised = 0;
    const claim = async (key: string, text: string) => {
      if (await store.claimAlert({ userId, alertKey: key, text: `${label}${text}`, at })) raised += 1;
    };

    for (const f of desk.fills) {
      const realised = f.realisedPnl === null ? '' : `, realised ${f.realisedPnl}`;
      await claim(`fill:${f.fillId}`, `Fill: ${f.symbol} ${f.side} ${f.amount} at ${f.price}${realised}, fee ${f.fee} ${f.feeAsset}.`);
    }

    for (const a of desk.accounts) {
      // A margin use the venue does not report is unknown: it neither fires nor re-arms a level.
      if (a.marginUse === null) continue;
      const account = `${a.owner}${a.subAccount ? `/${a.subAccount}` : ''}`;
      for (const level of MARGIN_USE_LEVELS) {
        const name = `margin:${account}:${level}`;
        const mark = await store.mark(userId, name);
        const past = compareDecimalStrings(a.marginUse, level) >= 0;
        if (!past) {
          if (!mark.armed) await store.setMark(userId, name, { episode: mark.episode + 1, armed: true });
          continue;
        }
        if (!mark.armed) continue;
        await claim(
          `${name}:${mark.episode}`,
          `Margin use ${level}%: account ${short(a.owner)} is at ${a.marginUse}% (margin ${a.marginUsed} of ${a.accountValue ?? '?'}).`,
        );
        await store.setMark(userId, name, { episode: mark.episode, armed: false });
      }
    }

    const target = await store.profitTarget(userId);
    if (target !== null && compareDecimalStrings(desk.week.profit, target) >= 0) {
      await claim(
        `profit-lock:${desk.weekStart}`,
        `Profit lock: this week's realised profit is ${desk.week.profit} ${desk.week.asset}, at or past your target of ${target} ${desk.week.asset}.`,
      );
    }
    return raised;
  }

  private async flush(): Promise<number> {
    const transport = this.deps.transport;
    if (!transport || !this.on) return 0;
    let sent = 0;
    for (const row of await this.deps.store.unsent(OUTBOX_BATCH)) {
      const link = await this.deps.store.linkByUser(row.userId);
      if (!link) continue;
      try {
        await transport.send(link.chatId, row.text);
      } catch {
        continue;
      }
      await this.deps.store.markSent(row.userId, row.alertKey, this.now());
      sent += 1;
    }
    return sent;
  }
}

const short = (owner: string) => (owner.length > 12 ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : owner);

function positionsText(desk: TradeDeskSnapshot): string {
  const lines = [`${desk.test ? 'TEST · ' : ''}Positions as of ${desk.asOf}`];
  let any = false;
  for (const a of desk.accounts) {
    const use = a.marginUse === null ? 'margin use not reported' : `margin use ${a.marginUse}%`;
    lines.push(`Account ${short(a.owner)}${a.subAccount ? `/${a.subAccount}` : ''}: ${use}`);
    for (const p of a.positions) {
      any = true;
      lines.push(`${p.symbol} ${p.side} ${p.size} · entry ${p.entryPrice} · mark ${p.markPrice} · unrealised ${p.unrealisedPnl}`);
    }
  }
  if (!any) lines.push('No open positions.');
  return lines.join('\n');
}

function pnlText(desk: TradeDeskSnapshot): string {
  const { week } = desk;
  return [
    `${desk.test ? 'TEST · ' : ''}This week from ${desk.weekStart}:`,
    `realised ${week.realisedPnl}, fees ${week.fees}, profit ${week.profit} ${week.asset}`,
    ...desk.accounts.map((a) => `Account ${short(a.owner)} open positions: unrealised ${a.unrealisedPnl} ${week.asset}`),
  ].join('\n');
}
