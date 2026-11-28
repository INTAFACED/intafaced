import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { EventBus } from '@intafaced/events';
import { add, compare, div, formatAmount, isNegative, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { riskAlertListSchema, riskAlertSchema, riskAlertsViewSchema } from '@intafaced/contracts/trade-risk-alerts-procedures';
import { isTestVenue, type UserVenue, type UserVenueAccount, type UserVenuePosition } from '@intafaced/venue-contracts';
import type { RiskAlert, RiskAlertKind, RiskAlertSetting, RiskAlertStore } from './risk-alerts-store.js';
import type { UserVenueDoor } from './user-venue-door.js';

/**
 * MARGIN AND LIQUIDATION-RISK ALERTS ON AN ISOLATED POSITION ON THE PERSON'S OWN VENUE ACCOUNT (J-derivatives-06 #6 #7;
 * D-account-03, D-margin-04).
 *
 * Nothing moves: no venue action is prepared or signed, and the ledger posts nothing. The person turns alerts on for a
 * position and may set two risk levels: a margin level (the position's margin with its unrealised result, as the venue
 * reports them) and a margin-ratio level in percent (the venue's maintenance requirement over that margin). Our engine
 * reads the venue's figures each pass and sends one alert per crossing:
 *   - a margin alert when the margin with its result falls to the person's margin level;
 *   - a margin call when the ratio rises to the person's ratio level, asking for the margin that brings it back there;
 *   - the liquidation alert when the ratio reaches 100%, the venue's own maintenance requirement, whether or not the
 *     person set levels, asking for the margin that brings it back to 100%.
 * A kind fires only while armed and re-arms when the figures are back on the safe side of its level, so a figure that
 * stays past a level sends nothing more. Where the venue publishes no maintenance requirement no ratio alert can go out,
 * and the view says so by giving no ratio.
 *
 * Crash points: the alert row is written in the same transaction that disarms its kind, before anything is published,
 * and published after under its business key `risk:<user>:<venue>:<owner>:<symbol>:<sequence>`. A worker that stops
 * between the two leaves it unpublished, and the next pass publishes it again; the consumer files it under its key, so
 * the person gets one alert per crossing.
 */

const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const HUNDRED = parseAmount('100');
/** The most alerts one read returns: a position's in its panel, an account's in the Margin calls tab. */
const ALERTS_SHOWN = 200;

export type RiskAlertErrorCode =
  | 'trade.risk_alerts_unavailable'
  | 'trade.risk_alerts_request_invalid'
  | 'trade.risk_alerts_field_invalid'
  | 'trade.risk_alerts_no_position';

export class RiskAlertError extends Error {
  constructor(
    message: string,
    readonly code: RiskAlertErrorCode,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'RiskAlertError';
  }
}

export type RiskAlertsView = z.input<typeof riskAlertsViewSchema>;
export type RiskAlertList = z.input<typeof riskAlertListSchema>;
type RiskAlertOut = z.input<typeof riskAlertSchema>;

/** The business key of one alert: the person, the venue account, the market and the alert's sequence, never a random id. */
export const riskAlertKey = (
  { userId, venueId, owner, symbol }: { userId: string; venueId: string; owner: string; symbol: string },
  sequence: number,
) => `risk:${userId}:${venueId}:${owner.toLowerCase()}:${symbol}:${sequence}`;

/** Where alerts are handed over; throws when the bus did not take one (it stays unpublished). */
export interface RiskAlertNotices {
  publish(alert: RiskAlert): Promise<void>;
}

export function busRiskAlertNotices(bus: Pick<EventBus, 'publish'>): RiskAlertNotices {
  return {
    async publish(a) {
      await bus.publish(
        'venueRiskAlerted',
        {
          alertKey: a.alertKey,
          userId: a.userId,
          symbol: a.symbol,
          kind: a.kind,
          asset: a.asset,
          level: formatAmount(a.level),
          marginWithResult: formatAmount(a.marginWithResult),
          marginRatio: a.marginRatio === null ? null : formatAmount(a.marginRatio),
          asked: a.asked === null ? null : formatAmount(a.asked),
          raisedAt: a.createdAt.toISOString(),
        },
        { idempotencyKey: a.alertKey },
      );
    },
  };
}

export interface RiskAlertDeps {
  readonly door: UserVenueDoor;
  readonly store: RiskAlertStore;
  readonly notices: RiskAlertNotices;
  readonly now: () => Date;
}

export interface RiskAlertSetInput {
  readonly owner: string;
  readonly symbol: string;
  readonly marginLevel?: string | null;
  readonly ratioLevel?: string | null;
}

/** A level the person may leave blank; anything typed must be a decimal above zero. */
function levelField(raw: string | null | undefined, field: string): Amount | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') return null;
  if (!DECIMAL_RE.test(v))
    throw new RiskAlertError(`${field} must be a number, like 100 or 62.5`, 'trade.risk_alerts_field_invalid', field);
  const amount = parseAmount(v);
  if (compare(amount, ZERO) <= 0) throw new RiskAlertError(`${field} must be above zero`, 'trade.risk_alerts_field_invalid', field);
  return amount;
}

const isOpenIsolated = (p: UserVenuePosition, symbol: string) =>
  p.symbol === symbol && p.marginMode === 'isolated' && compare(p.size, ZERO) !== 0;

/** The venue's figures one pass judges: the margin with its result, and its maintenance requirement where published. */
export interface RiskFigures {
  readonly marginWithResult: Amount;
  readonly maintenance: Amount | null;
}

function figuresOf(p: UserVenuePosition): RiskFigures {
  const m = p.maintenanceMargin;
  return { marginWithResult: add(p.margin, p.unrealisedPnl), maintenance: m && m.known ? m.value : null };
}

/** The margin ratio in percent (maintenance over margin with its result), floored; null with no maintenance or no margin left. */
function marginRatio(f: RiskFigures): Amount | null {
  if (f.maintenance === null || compare(f.marginWithResult, ZERO) <= 0) return null;
  return div(mul(f.maintenance, HUNDRED), f.marginWithResult, 'floor');
}

/** Whether the ratio is at or above `level` percent: maintenance × 100 ≥ margin × level, exact, with no margin left counting. */
function ratioAtOrAbove(f: RiskFigures, level: Amount): boolean | null {
  if (f.maintenance === null) return null;
  if (compare(f.marginWithResult, ZERO) <= 0) return true;
  // Both sides at the same double scale, so no digit is rounded away.
  return f.maintenance * HUNDRED >= f.marginWithResult * level;
}

/** What a margin call asks: the margin to add so the ratio comes back to `level` percent, rounded up; never below zero. */
function askedFor(f: RiskFigures, level: Amount): Amount | null {
  if (f.maintenance === null) return null;
  const needed = div(mul(f.maintenance, HUNDRED), level, 'ceil');
  const short = sub(needed, f.marginWithResult);
  return isNegative(short) ? ZERO : short;
}

/** Each kind's level, and whether the figures are past it now; a kind with no level, or no figure to judge, is skipped. */
function crossings(s: RiskAlertSetting, f: RiskFigures): { kind: RiskAlertKind; level: Amount; past: boolean }[] {
  const out: { kind: RiskAlertKind; level: Amount; past: boolean }[] = [];
  if (s.marginLevel !== null) out.push({ kind: 'margin', level: s.marginLevel, past: compare(f.marginWithResult, s.marginLevel) <= 0 });
  if (s.ratioLevel !== null) {
    const past = ratioAtOrAbove(f, s.ratioLevel);
    if (past !== null) out.push({ kind: 'margin_call', level: s.ratioLevel, past });
  }
  const liquidation = ratioAtOrAbove(f, HUNDRED);
  if (liquidation !== null) out.push({ kind: 'liquidation', level: HUNDRED, past: liquidation });
  return out;
}

const log = (msg: string, fields: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg, ...fields })}\n`);

export class VenueRiskAlerts {
  /** Settings this process is judging now, so two passes never judge one position at once in this process. */
  private readonly driving = new Set<string>();

  constructor(private readonly deps: RiskAlertDeps) {}

  private async read(owner: string, symbol: string | null) {
    const account = await this.deps.door.account(owner);
    const venue = await this.deps.door.venue();
    if (symbol === null) return { account, venue, asset: null };
    const market = (await venue.markets(account)).value.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'perpetual') {
      throw new RiskAlertError(`${symbol} is not a perpetual on ${venue.venue.displayName}`, 'trade.risk_alerts_request_invalid', 'Market');
    }
    const asset = market.marginAccount?.known ? market.marginAccount.value.collateralAsset : market.quoteAsset;
    return { account, venue, asset };
  }

  async get(principal: Principal, owner: string, symbol: string): Promise<RiskAlertsView> {
    const { account, venue, asset } = await this.read(owner, symbol);
    return this.view(principal, { venue, account, asset: asset ?? '' }, symbol);
  }

  /** Turn the position's alerts on, or change its levels. Either level may be blank; the liquidation alert needs neither. */
  async set(principal: Principal, input: RiskAlertSetInput): Promise<RiskAlertsView> {
    const { account, venue, asset } = await this.read(input.owner, input.symbol);
    const marginLevel = levelField(input.marginLevel, 'Margin level');
    const ratioLevel = levelField(input.ratioLevel, 'Margin ratio level');
    if (ratioLevel !== null && compare(ratioLevel, HUNDRED) >= 0) {
      throw new RiskAlertError(
        'Margin ratio level must be below 100%: at 100% the venue liquidates the position, and the liquidation alert goes out there anyway',
        'trade.risk_alerts_field_invalid',
        'Margin ratio level',
      );
    }
    const position = (await venue.positions(account)).value.find((p) => isOpenIsolated(p, input.symbol));
    if (!position) {
      throw new RiskAlertError(
        `You have no isolated position on ${input.symbol} on ${venue.venue.displayName}, so there is nothing to watch`,
        'trade.risk_alerts_no_position',
      );
    }
    await this.deps.store.save({
      id: randomUUID(),
      userId: principal.userId,
      venueId: account.venueId,
      owner: account.owner,
      symbol: input.symbol,
      marginLevel,
      ratioLevel,
      at: this.deps.now(),
    });
    return this.view(principal, { venue, account, asset: asset ?? '' }, input.symbol);
  }

  async off(principal: Principal, owner: string, symbol: string): Promise<RiskAlertsView> {
    const { account, venue, asset } = await this.read(owner, symbol);
    const setting = await this.deps.store.setting({ userId: principal.userId, venueId: account.venueId, owner: account.owner, symbol });
    if (setting?.enabled) await this.deps.store.turnOff(setting.id, this.deps.now());
    return this.view(principal, { venue, account, asset: asset ?? '' }, symbol);
  }

  /** Every alert on the venue account, newest first: the Margin calls tab. */
  async list(principal: Principal, owner: string): Promise<RiskAlertList> {
    const { account, venue } = await this.read(owner, null);
    const alerts = await this.deps.store.alerts({ userId: principal.userId, venueId: account.venueId, owner: account.owner }, ALERTS_SHOWN);
    return {
      venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
      owner: account.owner,
      alerts: alerts.map(alertOut),
    };
  }

  // ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** One pass: every setting that is on, judged once against the venue's figures; then every alert not yet handed over. */
  async tick(): Promise<{ readonly raised: number; readonly published: number }> {
    let raised = 0;
    for (const s of await this.deps.store.enabled()) {
      if (this.driving.has(s.id)) continue;
      this.driving.add(s.id);
      try {
        raised += await this.pass(s);
      } catch (err) {
        log('trade.risk_alerts.pass_failed', { setting: s.id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        this.driving.delete(s.id);
      }
    }
    return { raised, published: await this.publishPending() };
  }

  private async pass(s: RiskAlertSetting): Promise<number> {
    const venue = await this.deps.door.venue();
    if (venue.venue.id !== s.venueId) return 0;
    const account: UserVenueAccount = { venueId: s.venueId, owner: s.owner, subAccount: null };
    const position = (await venue.positions(account)).value.find((p) => isOpenIsolated(p, s.symbol));
    if (!position) return 0;
    const market = (await venue.markets(account)).value.find((m) => m.symbol === s.symbol);
    const asset = market?.marginAccount?.known ? market.marginAccount.value.collateralAsset : (market?.quoteAsset ?? '');
    const f = figuresOf(position);
    const at = this.deps.now();
    let raised = 0;
    for (const c of crossings(s, f)) {
      if (!c.past) {
        if (!s.armed[c.kind]) await this.deps.store.setArmed(s.id, { kind: c.kind, armed: true }, at);
        continue;
      }
      if (!s.armed[c.kind]) continue;
      const alert = await this.deps.store.claim({
        settingId: s.id,
        kind: c.kind,
        asset,
        level: c.level,
        marginWithResult: f.marginWithResult,
        maintenance: f.maintenance,
        marginRatio: marginRatio(f),
        asked: c.kind === 'margin' ? null : askedFor(f, c.level),
        alertKeyOf: (sequence) => riskAlertKey(s, sequence),
        at,
      });
      if (alert) raised += 1;
    }
    return raised;
  }

  /** Hand every unpublished alert to the bus, oldest first; one the bus did not take stays for the next pass. */
  async publishPending(): Promise<number> {
    let sent = 0;
    for (const a of await this.deps.store.unpublished(100)) {
      try {
        await this.deps.notices.publish(a);
      } catch (err) {
        log('trade.risk_alerts.notice_unsent', { alertKey: a.alertKey, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      await this.deps.store.markPublished(a.alertKey, this.deps.now());
      sent += 1;
    }
    return sent;
  }

  // ── the view ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async view(
    principal: Principal,
    at: { venue: UserVenue; account: UserVenueAccount; asset: string },
    symbol: string,
  ): Promise<RiskAlertsView> {
    const { venue, account, asset } = at;
    const [positions, setting, alerts] = await Promise.all([
      venue.positions(account),
      this.deps.store.setting({ userId: principal.userId, venueId: account.venueId, owner: account.owner, symbol }),
      this.deps.store.alerts({ userId: principal.userId, venueId: account.venueId, owner: account.owner }, ALERTS_SHOWN),
    ]);
    const position = positions.value.find((p) => isOpenIsolated(p, symbol)) ?? null;
    const f = position ? figuresOf(position) : null;
    const ratio = f ? marginRatio(f) : null;
    return {
      venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
      owner: account.owner,
      symbol,
      asset,
      position: f
        ? {
            marginWithResult: formatAmount(f.marginWithResult),
            maintenance: f.maintenance === null ? null : formatAmount(f.maintenance),
            marginRatio: ratio === null ? null : formatAmount(ratio),
            asOf: positions.asOf.toISOString(),
          }
        : null,
      setting: setting
        ? {
            on: setting.enabled,
            marginLevel: setting.marginLevel === null ? null : formatAmount(setting.marginLevel),
            ratioLevel: setting.ratioLevel === null ? null : formatAmount(setting.ratioLevel),
            armed: { margin: setting.armed.margin, marginCall: setting.armed.margin_call, liquidation: setting.armed.liquidation },
          }
        : null,
      alerts: alerts.filter((a) => a.symbol === symbol).map(alertOut),
    };
  }
}

function alertOut(a: RiskAlert): RiskAlertOut {
  return {
    sequence: a.sequence,
    alertKey: a.alertKey,
    symbol: a.symbol,
    kind: a.kind,
    asset: a.asset,
    level: formatAmount(a.level),
    marginWithResult: formatAmount(a.marginWithResult),
    maintenance: a.maintenance === null ? null : formatAmount(a.maintenance),
    marginRatio: a.marginRatio === null ? null : formatAmount(a.marginRatio),
    asked: a.asked === null ? null : formatAmount(a.asked),
    at: a.createdAt.toISOString(),
  };
}
