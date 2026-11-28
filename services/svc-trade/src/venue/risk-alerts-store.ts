import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * Margin and liquidation-risk alerts on an isolated position on the person's own venue account (J-derivatives-06 #6 #7),
 * held in `trade.user_venue_risk_alert_*` (drizzle/20261123194332_user_venue_risk_alerts.sql). No balance, no post and
 * nothing sent to the venue: every figure here is what the person set or what the venue reported at a crossing.
 */

export type RiskAlertKind = 'margin' | 'margin_call' | 'liquidation';

/** One position's alerts: on or off, the person's two risk levels (either may be unset), and which kinds are armed. */
export interface RiskAlertSetting {
  readonly id: string;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
  readonly enabled: boolean;
  readonly marginLevel: Amount | null;
  /** In percent, below 100. */
  readonly ratioLevel: Amount | null;
  readonly armed: Readonly<Record<RiskAlertKind, boolean>>;
  readonly nextSequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One alert that went out (or is going out): one crossing of one kind's level, with the venue's figures at it. */
export interface RiskAlert {
  readonly settingId: string;
  readonly sequence: number;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
  readonly kind: RiskAlertKind;
  readonly alertKey: string;
  readonly asset: string;
  readonly level: Amount;
  readonly marginWithResult: Amount;
  readonly maintenance: Amount | null;
  readonly marginRatio: Amount | null;
  readonly asked: Amount | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface RiskAlertPosition {
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
}

export interface RiskAlertSave extends RiskAlertPosition {
  /** Used only when the position has no setting yet. */
  readonly id: string;
  readonly marginLevel: Amount | null;
  readonly ratioLevel: Amount | null;
  readonly at: Date;
}

/** One crossing the engine read; the store writes it only while its kind is armed on an enabled setting. */
export interface RiskAlertClaim {
  readonly settingId: string;
  readonly kind: RiskAlertKind;
  readonly asset: string;
  readonly level: Amount;
  readonly marginWithResult: Amount;
  readonly maintenance: Amount | null;
  readonly marginRatio: Amount | null;
  readonly asked: Amount | null;
  readonly alertKeyOf: (sequence: number) => string;
  readonly at: Date;
}

export interface RiskAlertStore {
  setting(position: RiskAlertPosition): Promise<RiskAlertSetting | null>;
  /** Every setting that is on, oldest first: the engine's work. */
  enabled(): Promise<readonly RiskAlertSetting[]>;
  /**
   * Turns the position's alerts on with these levels, or changes the levels of alerts that are on. Turning on arms every
   * kind; a changed level arms its kind; an unchanged one keeps its state, so editing one level never repeats another
   * kind's alert.
   */
  save(input: RiskAlertSave): Promise<RiskAlertSetting>;
  turnOff(id: string, at: Date): Promise<void>;
  setArmed(id: string, change: { readonly kind: RiskAlertKind; readonly armed: boolean }, at: Date): Promise<void>;
  /** The one alert of an armed kind's crossing, written with the kind disarmed, atomically; null when not armed or off. */
  claim(input: RiskAlertClaim): Promise<RiskAlert | null>;
  /** The alerts on one venue account of one person, newest first, at most `limit`. */
  alerts(account: Omit<RiskAlertPosition, 'symbol'>, limit: number): Promise<readonly RiskAlert[]>;
  unpublished(limit: number): Promise<readonly RiskAlert[]>;
  markPublished(alertKey: string, at: Date): Promise<void>;
}

const sameLevel = (a: Amount | null, b: Amount | null) => a === b;

/** The armed state a save leaves, the same in memory and in SQL. */
function armedAfterSave(had: RiskAlertSetting | null, input: RiskAlertSave): Record<RiskAlertKind, boolean> {
  if (!had || !had.enabled) return { margin: true, margin_call: true, liquidation: true };
  return {
    margin: sameLevel(had.marginLevel, input.marginLevel) ? had.armed.margin : true,
    margin_call: sameLevel(had.ratioLevel, input.ratioLevel) ? had.armed.margin_call : true,
    liquidation: had.armed.liquidation,
  };
}

export class InMemoryRiskAlertStore implements RiskAlertStore {
  readonly settings = new Map<string, RiskAlertSetting>();
  readonly rows: RiskAlert[] = [];

  async setting({ userId, venueId, owner, symbol }: RiskAlertPosition) {
    for (const s of this.settings.values())
      if (s.userId === userId && s.venueId === venueId && s.owner === owner && s.symbol === symbol) return s;
    return null;
  }
  async enabled() {
    return [...this.settings.values()].filter((s) => s.enabled);
  }
  async save(input: RiskAlertSave) {
    const had = await this.setting(input);
    const armed = armedAfterSave(had, input);
    const next: RiskAlertSetting = had
      ? { ...had, enabled: true, marginLevel: input.marginLevel, ratioLevel: input.ratioLevel, armed, updatedAt: input.at }
      : {
          id: input.id,
          userId: input.userId,
          venueId: input.venueId,
          owner: input.owner,
          symbol: input.symbol,
          enabled: true,
          marginLevel: input.marginLevel,
          ratioLevel: input.ratioLevel,
          armed,
          nextSequence: 1,
          createdAt: input.at,
          updatedAt: input.at,
        };
    this.settings.set(next.id, next);
    return next;
  }
  async turnOff(id: string, at: Date) {
    const s = this.settings.get(id);
    if (s) this.settings.set(id, { ...s, enabled: false, updatedAt: at });
  }
  async setArmed(id: string, { kind, armed }: { readonly kind: RiskAlertKind; readonly armed: boolean }, at: Date) {
    const s = this.settings.get(id);
    if (s && s.enabled) this.settings.set(id, { ...s, armed: { ...s.armed, [kind]: armed }, updatedAt: at });
  }
  async claim(input: RiskAlertClaim) {
    // No await between the read and the writes: one claim at a time, as the SQL lock makes it.
    const s = this.settings.get(input.settingId);
    if (!s || !s.enabled || !s.armed[input.kind]) return null;
    const row: RiskAlert = {
      settingId: s.id,
      sequence: s.nextSequence,
      userId: s.userId,
      venueId: s.venueId,
      owner: s.owner,
      symbol: s.symbol,
      kind: input.kind,
      alertKey: input.alertKeyOf(s.nextSequence),
      asset: input.asset,
      level: input.level,
      marginWithResult: input.marginWithResult,
      maintenance: input.maintenance,
      marginRatio: input.marginRatio,
      asked: input.asked,
      createdAt: input.at,
      publishedAt: null,
    };
    this.rows.push(row);
    this.settings.set(s.id, { ...s, armed: { ...s.armed, [input.kind]: false }, nextSequence: s.nextSequence + 1, updatedAt: input.at });
    return row;
  }
  async alerts({ userId, venueId, owner }: Omit<RiskAlertPosition, 'symbol'>, limit: number) {
    return this.rows
      .filter((a) => a.userId === userId && a.venueId === venueId && a.owner === owner)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.sequence - a.sequence)
      .slice(0, limit);
  }
  async unpublished(limit: number) {
    return this.rows.filter((a) => a.publishedAt === null).slice(0, limit);
  }
  async markPublished(alertKey: string, at: Date) {
    const i = this.rows.findIndex((a) => a.alertKey === alertKey && a.publishedAt === null);
    const row = this.rows[i];
    if (row) this.rows[i] = { ...row, publishedAt: at };
  }
}

const SettingRow = z.object({
  id: z.string(),
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  symbol: z.string(),
  enabled: z.boolean(),
  margin_level: z.string().nullable(),
  ratio_level: z.string().nullable(),
  armed_margin: z.boolean(),
  armed_margin_call: z.boolean(),
  armed_liquidation: z.boolean(),
  next_sequence: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});
type SettingRow = z.infer<typeof SettingRow>;
const AlertRow = z.object({
  setting_id: z.string(),
  sequence: z.number().int(),
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  symbol: z.string(),
  kind: z.enum(['margin', 'margin_call', 'liquidation']),
  alert_key: z.string(),
  asset: z.string(),
  level: z.string(),
  margin_with_result: z.string(),
  maintenance: z.string().nullable(),
  margin_ratio: z.string().nullable(),
  asked: z.string().nullable(),
  created_at: z.date(),
  published_at: z.date().nullable(),
});
type AlertRow = z.infer<typeof AlertRow>;

const maybe = (v: string | null) => (v === null ? null : parseAmount(v));
const text = (v: Amount | null) => (v === null ? null : formatAmount(v));

const settingOf = (r: SettingRow): RiskAlertSetting => ({
  id: r.id,
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  symbol: r.symbol,
  enabled: r.enabled,
  marginLevel: maybe(r.margin_level),
  ratioLevel: maybe(r.ratio_level),
  armed: { margin: r.armed_margin, margin_call: r.armed_margin_call, liquidation: r.armed_liquidation },
  nextSequence: r.next_sequence,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const alertOf = (r: AlertRow): RiskAlert => ({
  settingId: r.setting_id,
  sequence: r.sequence,
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  symbol: r.symbol,
  kind: r.kind,
  alertKey: r.alert_key,
  asset: r.asset,
  level: parseAmount(r.level),
  marginWithResult: parseAmount(r.margin_with_result),
  maintenance: maybe(r.maintenance),
  marginRatio: maybe(r.margin_ratio),
  asked: maybe(r.asked),
  createdAt: r.created_at,
  publishedAt: r.published_at,
});

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`trade.user_venue_risk_alerts: ${what} returned no row`);
  return row;
}

export class SqlRiskAlertStore implements RiskAlertStore {
  constructor(private readonly sql: Sql) {}

  async setting({ userId, venueId, owner, symbol }: RiskAlertPosition) {
    const rows = SettingRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_risk_alert_settings
      WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner} AND symbol = ${symbol}`,
    );
    return rows[0] ? settingOf(rows[0]) : null;
  }

  async enabled() {
    const rows = SettingRow.array().parse(
      await this.sql`SELECT * FROM trade.user_venue_risk_alert_settings WHERE enabled ORDER BY created_at, id`,
    );
    return rows.map(settingOf);
  }

  async save(input: RiskAlertSave) {
    return this.sql.begin(async (tx) => {
      const locked = SettingRow.array().parse(
        await tx`
        SELECT * FROM trade.user_venue_risk_alert_settings
        WHERE user_id = ${input.userId} AND venue_id = ${input.venueId} AND owner = ${input.owner} AND symbol = ${input.symbol}
        FOR UPDATE`,
      );
      const had = locked[0] ? settingOf(locked[0]) : null;
      const armed = armedAfterSave(had, input);
      const rows = SettingRow.array().parse(
        await tx`
        -- conflict-keys-ok: user_venue_risk_alert_settings_pkey — the id is a fresh random uuid made for each save (risk-alerts.ts), so two saves never share one; the row is named by (user_id, venue_id, owner, symbol), the key this statement absorbs
        INSERT INTO trade.user_venue_risk_alert_settings
          (id, user_id, venue_id, owner, symbol, enabled, margin_level, ratio_level, armed_margin, armed_margin_call,
           armed_liquidation, next_sequence, created_at, updated_at)
        VALUES (${input.id}, ${input.userId}, ${input.venueId}, ${input.owner}, ${input.symbol}, true, ${text(input.marginLevel)},
          ${text(input.ratioLevel)}, ${armed.margin}, ${armed.margin_call}, ${armed.liquidation}, 1, ${input.at}, ${input.at})
        ON CONFLICT (user_id, venue_id, owner, symbol) DO UPDATE SET
          enabled = true,
          margin_level = EXCLUDED.margin_level,
          ratio_level = EXCLUDED.ratio_level,
          armed_margin = EXCLUDED.armed_margin,
          armed_margin_call = EXCLUDED.armed_margin_call,
          armed_liquidation = EXCLUDED.armed_liquidation,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
      );
      return settingOf(one(rows, 'save'));
    });
  }

  async turnOff(id: string, at: Date) {
    await this.sql`UPDATE trade.user_venue_risk_alert_settings SET enabled = false, updated_at = ${at} WHERE id = ${id}`;
  }

  async setArmed(id: string, { kind, armed }: { readonly kind: RiskAlertKind; readonly armed: boolean }, at: Date) {
    const column = { margin: 'armed_margin', margin_call: 'armed_margin_call', liquidation: 'armed_liquidation' }[kind];
    await this.sql`
      UPDATE trade.user_venue_risk_alert_settings SET ${this.sql(column)} = ${armed}, updated_at = ${at} WHERE id = ${id} AND enabled`;
  }

  async claim(input: RiskAlertClaim) {
    return this.sql.begin(async (tx): Promise<RiskAlert | null> => {
      const locked = SettingRow.array().parse(
        await tx`SELECT * FROM trade.user_venue_risk_alert_settings WHERE id = ${input.settingId} FOR UPDATE`,
      );
      const s = locked[0] ? settingOf(locked[0]) : null;
      if (!s || !s.enabled || !s.armed[input.kind]) return null;
      const inserted = AlertRow.array().parse(
        await tx`
        INSERT INTO trade.user_venue_risk_alerts
          (setting_id, sequence, user_id, venue_id, owner, symbol, kind, alert_key, asset, level, margin_with_result,
           maintenance, margin_ratio, asked, created_at)
        VALUES (${s.id}, ${s.nextSequence}, ${s.userId}, ${s.venueId}, ${s.owner}, ${s.symbol}, ${input.kind},
          ${input.alertKeyOf(s.nextSequence)}, ${input.asset}, ${formatAmount(input.level)}, ${formatAmount(input.marginWithResult)},
          ${text(input.maintenance)}, ${text(input.marginRatio)}, ${text(input.asked)}, ${input.at})
        RETURNING *`,
      );
      const column = { margin: 'armed_margin', margin_call: 'armed_margin_call', liquidation: 'armed_liquidation' }[input.kind];
      await tx`
        UPDATE trade.user_venue_risk_alert_settings
        SET ${tx(column)} = false, next_sequence = ${s.nextSequence + 1}, updated_at = ${input.at}
        WHERE id = ${s.id}`;
      return alertOf(one(inserted, 'the alert insert'));
    });
  }

  async alerts({ userId, venueId, owner }: Omit<RiskAlertPosition, 'symbol'>, limit: number) {
    const rows = AlertRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_risk_alerts
      WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner}
      ORDER BY created_at DESC, sequence DESC LIMIT ${limit}`,
    );
    return rows.map(alertOf);
  }

  async unpublished(limit: number) {
    const rows = AlertRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_risk_alerts WHERE published_at IS NULL ORDER BY created_at, alert_key LIMIT ${limit}`,
    );
    return rows.map(alertOf);
  }

  async markPublished(alertKey: string, at: Date) {
    await this.sql`
      UPDATE trade.user_venue_risk_alerts SET published_at = ${at} WHERE alert_key = ${alertKey} AND published_at IS NULL`;
  }
}
