import type { Sql } from 'postgres';
import { z } from 'zod';

/**
 * What the Telegram desk keeps: one-time link codes (their digest only), chat links, profit targets, margin crossings and
 * the alert outbox. `MemoryTelegramStore` and `PostgresTelegramStore` answer the same way; the desk test drives the first,
 * `store.pg.test.ts` proves the second.
 */

export interface TelegramLink {
  readonly userId: string;
  readonly chatId: string;
  readonly linkedAt: Date;
}

/** A margin-use level's state for one account: which crossing it is on, and whether that crossing may still fire. */
export interface TelegramMark {
  readonly episode: number;
  readonly armed: boolean;
}

export interface TelegramAlertRow {
  readonly userId: string;
  readonly alertKey: string;
  readonly text: string;
}

export interface NewTelegramAlert extends TelegramAlertRow {
  readonly at: Date;
}

export type RedeemOutcome =
  { readonly ok: true; readonly link: TelegramLink } | { readonly ok: false; readonly reason: 'invalid' | 'chat_taken' };

export interface TelegramStore {
  /** Stores a code's digest for the person, replacing any code of theirs not yet used. */
  putCode(userId: string, digest: string, expiresAt: Date): Promise<void>;
  /** Uses a code once: a code that is unknown, expired or already used is `invalid`; a chat linked to someone else is `chat_taken`. */
  redeemCode(digest: string, chatId: string, now: Date): Promise<RedeemOutcome>;
  linkByChat(chatId: string): Promise<TelegramLink | null>;
  linkByUser(userId: string): Promise<TelegramLink | null>;
  links(): Promise<readonly TelegramLink[]>;
  /** Removes the link and every alert not yet sent to it. */
  unlink(userId: string): Promise<boolean>;
  profitTarget(userId: string): Promise<string | null>;
  setProfitTarget(userId: string, target: string | null): Promise<void>;
  mark(userId: string, mark: string): Promise<TelegramMark>;
  setMark(userId: string, mark: string, state: TelegramMark): Promise<void>;
  /** Raises an alert under its business key: false when that key was raised before. */
  claimAlert(alert: NewTelegramAlert): Promise<boolean>;
  unsent(limit: number): Promise<readonly TelegramAlertRow[]>;
  markSent(userId: string, alertKey: string, at: Date): Promise<void>;
}

const FRESH: TelegramMark = { episode: 0, armed: true };

export class MemoryTelegramStore implements TelegramStore {
  private readonly codes = new Map<string, { userId: string; expiresAt: Date }>();
  private readonly byUser = new Map<string, TelegramLink>();
  private readonly targets = new Map<string, string>();
  private readonly marks = new Map<string, TelegramMark>();
  private readonly alerts = new Map<string, TelegramAlertRow & { createdAt: Date; sentAt: Date | null }>();

  async putCode(userId: string, digest: string, expiresAt: Date): Promise<void> {
    for (const [d, c] of this.codes) if (c.userId === userId) this.codes.delete(d);
    this.codes.set(digest, { userId, expiresAt });
  }

  async redeemCode(digest: string, chatId: string, now: Date): Promise<RedeemOutcome> {
    const code = this.codes.get(digest);
    if (!code || code.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'invalid' };
    const holder = await this.linkByChat(chatId);
    if (holder && holder.userId !== code.userId) return { ok: false, reason: 'chat_taken' };
    this.codes.delete(digest);
    const link = { userId: code.userId, chatId, linkedAt: now };
    this.byUser.set(code.userId, link);
    return { ok: true, link };
  }

  async linkByChat(chatId: string): Promise<TelegramLink | null> {
    for (const l of this.byUser.values()) if (l.chatId === chatId) return l;
    return null;
  }

  async linkByUser(userId: string): Promise<TelegramLink | null> {
    return this.byUser.get(userId) ?? null;
  }

  async links(): Promise<readonly TelegramLink[]> {
    return [...this.byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async unlink(userId: string): Promise<boolean> {
    for (const [k, a] of this.alerts) if (a.userId === userId && a.sentAt === null) this.alerts.delete(k);
    return this.byUser.delete(userId);
  }

  async profitTarget(userId: string): Promise<string | null> {
    return this.targets.get(userId) ?? null;
  }

  async setProfitTarget(userId: string, target: string | null): Promise<void> {
    if (target === null) this.targets.delete(userId);
    else this.targets.set(userId, target);
  }

  async mark(userId: string, mark: string): Promise<TelegramMark> {
    return this.marks.get(`${userId}\u0000${mark}`) ?? FRESH;
  }

  async setMark(userId: string, mark: string, state: TelegramMark): Promise<void> {
    this.marks.set(`${userId}\u0000${mark}`, state);
  }

  async claimAlert({ userId, alertKey, text, at }: NewTelegramAlert): Promise<boolean> {
    const key = `${userId}\u0000${alertKey}`;
    if (this.alerts.has(key)) return false;
    this.alerts.set(key, { userId, alertKey, text, createdAt: at, sentAt: null });
    return true;
  }

  async unsent(limit: number): Promise<readonly TelegramAlertRow[]> {
    return [...this.alerts.values()]
      .filter((a) => a.sentAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map(({ userId, alertKey, text }) => ({ userId, alertKey, text }));
  }

  async markSent(userId: string, alertKey: string, at: Date): Promise<void> {
    const a = this.alerts.get(`${userId}\u0000${alertKey}`);
    if (a && a.sentAt === null) a.sentAt = at;
  }

  /** Everything held, for a test to prove what is not stored. */
  dump(): unknown {
    return {
      codes: [...this.codes.entries()].map(([digest, c]) => ({ digest, userId: c.userId, expiresAt: c.expiresAt.toISOString() })),
      links: [...this.byUser.values()],
      targets: [...this.targets.entries()],
    };
  }
}

const LinkRow = z.object({ user_id: z.string(), chat_id: z.string(), linked_at: z.coerce.date() });
const UserRow = z.object({ user_id: z.string() });
const TargetRow = z.object({ profit_target: z.string() });
const MarkRow = z.object({ episode: z.number().int(), armed: z.boolean() });
const AlertRow = z.object({ user_id: z.string(), alert_key: z.string(), text: z.string() });
const linkOf = (r: z.infer<typeof LinkRow>): TelegramLink => ({ userId: r.user_id, chatId: r.chat_id, linkedAt: r.linked_at });
const firstLink = (rows: unknown): TelegramLink | null => {
  const [row] = LinkRow.array().parse(rows);
  return row ? linkOf(row) : null;
};

/** Another person linked the chat in the same moment: thrown to roll the redeem back. */
class ChatTakenRace extends Error {}

export class PostgresTelegramStore implements TelegramStore {
  constructor(private readonly sql: Sql) {}

  async putCode(userId: string, digest: string, expiresAt: Date): Promise<void> {
    await this.sql`
      INSERT INTO notify.telegram_link_codes (digest, user_id, expires_at) VALUES (${digest}, ${userId}, ${expiresAt})
      ON CONFLICT (user_id) DO UPDATE SET digest = EXCLUDED.digest, expires_at = EXCLUDED.expires_at, created_at = now()`;
  }

  async redeemCode(digest: string, chatId: string, now: Date): Promise<RedeemOutcome> {
    const out: RedeemOutcome = await this.sql
      .begin(async (tx): Promise<RedeemOutcome> => {
        const [code] = UserRow.array().parse(
          await tx`SELECT user_id FROM notify.telegram_link_codes WHERE digest = ${digest} AND expires_at > ${now} FOR UPDATE`,
        );
        if (!code) return { ok: false, reason: 'invalid' };
        const [holder] = UserRow.array().parse(await tx`SELECT user_id FROM notify.telegram_links WHERE chat_id = ${chatId}`);
        if (holder && holder.user_id !== code.user_id) return { ok: false, reason: 'chat_taken' };
        await tx`DELETE FROM notify.telegram_link_codes WHERE user_id = ${code.user_id} AND digest = ${digest}`;
        // The person's old chat, if any, is replaced. A chat another person linked in the same moment wins the race: the
        // insert absorbs the clash on either key and this code links nothing.
        await tx`DELETE FROM notify.telegram_links WHERE user_id = ${code.user_id}`;
        const link = firstLink(
          await tx`
          INSERT INTO notify.telegram_links (user_id, chat_id, linked_at) VALUES (${code.user_id}, ${chatId}, ${now})
          ON CONFLICT DO NOTHING
          RETURNING user_id, chat_id, linked_at`,
        );
        if (!link) throw new ChatTakenRace();
        return { ok: true, link };
      })
      .catch((err: unknown): RedeemOutcome => {
        // Rolled back: the person keeps their code and their old chat.
        if (err instanceof ChatTakenRace) return { ok: false, reason: 'chat_taken' };
        throw err;
      });
    return out;
  }

  async linkByChat(chatId: string): Promise<TelegramLink | null> {
    return firstLink(await this.sql`SELECT user_id, chat_id, linked_at FROM notify.telegram_links WHERE chat_id = ${chatId}`);
  }

  async linkByUser(userId: string): Promise<TelegramLink | null> {
    return firstLink(await this.sql`SELECT user_id, chat_id, linked_at FROM notify.telegram_links WHERE user_id = ${userId}`);
  }

  async links(): Promise<readonly TelegramLink[]> {
    return LinkRow.array()
      .parse(await this.sql`SELECT user_id, chat_id, linked_at FROM notify.telegram_links ORDER BY user_id`)
      .map(linkOf);
  }

  async unlink(userId: string): Promise<boolean> {
    const gone: boolean = await this.sql.begin(async (tx): Promise<boolean> => {
      await tx`DELETE FROM notify.telegram_alerts WHERE user_id = ${userId} AND sent_at IS NULL`;
      const rows = await tx`DELETE FROM notify.telegram_links WHERE user_id = ${userId}`;
      return rows.count > 0;
    });
    return gone;
  }

  async profitTarget(userId: string): Promise<string | null> {
    const [row] = TargetRow.array().parse(await this.sql`SELECT profit_target FROM notify.telegram_targets WHERE user_id = ${userId}`);
    return row?.profit_target ?? null;
  }

  async setProfitTarget(userId: string, target: string | null): Promise<void> {
    if (target === null) await this.sql`DELETE FROM notify.telegram_targets WHERE user_id = ${userId}`;
    else
      await this.sql`
        INSERT INTO notify.telegram_targets (user_id, profit_target) VALUES (${userId}, ${target})
        ON CONFLICT (user_id) DO UPDATE SET profit_target = EXCLUDED.profit_target, updated_at = now()`;
  }

  async mark(userId: string, mark: string): Promise<TelegramMark> {
    const [row] = MarkRow.array().parse(
      await this.sql`SELECT episode, armed FROM notify.telegram_marks WHERE user_id = ${userId} AND mark = ${mark}`,
    );
    return row ?? FRESH;
  }

  async setMark(userId: string, mark: string, state: TelegramMark): Promise<void> {
    await this.sql`
      INSERT INTO notify.telegram_marks (user_id, mark, episode, armed) VALUES (${userId}, ${mark}, ${state.episode}, ${state.armed})
      ON CONFLICT (user_id, mark) DO UPDATE SET episode = EXCLUDED.episode, armed = EXCLUDED.armed`;
  }

  async claimAlert({ userId, alertKey, text, at }: NewTelegramAlert): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO notify.telegram_alerts (user_id, alert_key, text, created_at) VALUES (${userId}, ${alertKey}, ${text}, ${at})
      ON CONFLICT (user_id, alert_key) DO NOTHING`;
    return rows.count > 0;
  }

  async unsent(limit: number): Promise<readonly TelegramAlertRow[]> {
    return AlertRow.array()
      .parse(
        await this.sql`
          SELECT user_id, alert_key, text FROM notify.telegram_alerts WHERE sent_at IS NULL ORDER BY created_at, alert_key LIMIT ${limit}`,
      )
      .map((r) => ({ userId: r.user_id, alertKey: r.alert_key, text: r.text }));
  }

  async markSent(userId: string, alertKey: string, at: Date): Promise<void> {
    await this.sql`
      UPDATE notify.telegram_alerts SET sent_at = ${at} WHERE user_id = ${userId} AND alert_key = ${alertKey} AND sent_at IS NULL`;
  }
}
