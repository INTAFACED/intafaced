/**
 * The Fees and convert room's fee versions (J-cex-spot-17 #1-#5): svc-trade's stored owner fee schedule versions
 * (`admin.fees.get`), shown by pair group with their effective times and exact rates, and the proposal a founder edits
 * from the latest version. Bps are integer strings and stay strings; a percent is built with integer string maths, never a
 * float. A proposal is checked here before anything is sent: a blank rate refuses with svc-trade's own typed code
 * (`trade.fee_schedule_blank`) and no request leaves the page. No network and no clock of its own: safe in tests.
 */

export interface FeeVersionRow {
  readonly version: string;
  readonly schedule: Readonly<Record<string, unknown>>;
  readonly effectiveAt: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface FeeHistory {
  /** The latest stored version number ("0" when none is stored). */
  readonly version: string;
  /** Every stored version, oldest first. */
  readonly history: readonly FeeVersionRow[];
}

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const VERSION = /^(?:0|[1-9]\d*)$/;
const str = (v: unknown): v is string => typeof v === 'string';

function parseRow(v: unknown): FeeVersionRow | null {
  if (!rec(v) || !str(v.version) || !VERSION.test(v.version) || !rec(v.schedule) || !str(v.effectiveAt)) return null;
  if (!str(v.operatorId) || !str(v.approverId) || !str(v.reason) || !str(v.createdAt)) return null;
  if (Number.isNaN(Date.parse(v.effectiveAt))) return null;
  return {
    version: v.version,
    schedule: v.schedule,
    effectiveAt: v.effectiveAt,
    operatorId: v.operatorId,
    approverId: v.approverId,
    reason: v.reason,
    createdAt: v.createdAt,
  };
}

/** Parse `admin.fees.get`. A body that is not the expected shape returns null: the room refuses it, never half-shows it. */
export function parseFeeHistory(raw: unknown): FeeHistory | null {
  if (!rec(raw) || !str(raw.version) || !VERSION.test(raw.version) || !Array.isArray(raw.history)) return null;
  const history = raw.history.map(parseRow);
  return history.every((r): r is FeeVersionRow => r !== null) ? { version: raw.version, history } : null;
}

export type VersionState = 'scheduled' | 'current' | 'previous';
export const STATE_LABEL: Readonly<Record<VersionState, string>> = { scheduled: 'Scheduled', current: 'Current', previous: 'Previous' };

/**
 * Each version's state at `now`, as svc-trade's own lookup picks the one in force: the latest effective time at or before
 * `now` (the higher version on a tie) is current; one that starts after `now` is scheduled; the rest are previous.
 */
export function versionStates(history: readonly FeeVersionRow[], now: Date): ReadonlyMap<string, VersionState> {
  const at = now.getTime();
  const inForce = [...history]
    .filter((r) => Date.parse(r.effectiveAt) <= at)
    .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || Number(BigInt(b.version) - BigInt(a.version)))[0];
  return new Map(
    history.map((r) => [r.version, Date.parse(r.effectiveAt) > at ? 'scheduled' : r === inForce ? 'current' : 'previous'] as const),
  );
}

/** The version in force at `now`, or null when none stored has started (the boot schedule applies). */
export function versionInForce(history: readonly FeeVersionRow[], now: Date): FeeVersionRow | null {
  const states = versionStates(history, now);
  return history.find((r) => states.get(r.version) === 'current') ?? null;
}

/** The pseudo pair group of a flat schedule: one rate for every market. */
export const EVERY_MARKET = 'every market';

export interface RateRow {
  readonly pairGroup: string;
  readonly tierId: string;
  readonly zeroFee: boolean;
  readonly makerBps: string | null;
  readonly takerBps: string | null;
  readonly makerRebateBps: string | null;
  /** Null: no minimum, by the owner's explicit choice. */
  readonly minFee: string | null;
}

const bpsOrNull = (v: unknown): string | null => (str(v) && /^\d{1,4}$/.test(v) ? v : null);

/** The rate rows of one stored schedule: its `rows`, or one row for a flat schedule. */
export function rowsOf(schedule: Readonly<Record<string, unknown>>): RateRow[] {
  if (Array.isArray(schedule.rows)) {
    return schedule.rows.filter(rec).map((row) => ({
      pairGroup: str(row.pairGroup) ? row.pairGroup : '',
      tierId: str(row.tierId) ? row.tierId : '',
      zeroFee: row.zeroFee === true,
      makerBps: bpsOrNull(row.makerBps),
      takerBps: bpsOrNull(row.takerBps),
      makerRebateBps: bpsOrNull(row.makerRebateBps),
      minFee: str(row.minFee) ? row.minFee : null,
    }));
  }
  return [
    {
      pairGroup: EVERY_MARKET,
      tierId: 'regular',
      zeroFee: false,
      makerBps: bpsOrNull(schedule.makerBps),
      takerBps: bpsOrNull(schedule.takerBps),
      makerRebateBps: bpsOrNull(schedule.makerRebateBps),
      minFee: null,
    },
  ];
}

/** Integer bps as an exact percent with its bps: "8" → "0.08% (8 bps)". Null is "not set". */
export function rateText(bps: string | null): string {
  if (bps === null) return 'not set';
  const n = BigInt(bps);
  return `${n / 100n}.${String(n % 100n).padStart(2, '0')}% (${bps} bps)`;
}

/** A time as the room writes it: "2026-11-06 10:31:05 UTC". */
export function shownTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export interface GroupRateLine {
  readonly version: string;
  readonly state: VersionState;
  readonly effectiveAt: string;
  readonly tierId: string;
  readonly maker: string;
  readonly taker: string;
  readonly rebate: string;
  readonly minFee: string;
}

export interface PairGroupView {
  readonly group: string;
  /** The markets the latest version shown names for this group; null for the default group (every other market). */
  readonly markets: readonly string[] | null;
  readonly lines: readonly GroupRateLine[];
}

/** How many versions before the current one the room shows. */
export const PREVIOUS_SHOWN = 5;

/** The versions the room shows, newest first: every scheduled one, the current one, and up to `PREVIOUS_SHOWN` before. */
export function shownVersions(history: readonly FeeVersionRow[], now: Date): Array<{ row: FeeVersionRow; state: VersionState }> {
  const states = versionStates(history, now);
  const newestFirst = [...history].sort(
    (a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || Number(BigInt(b.version) - BigInt(a.version)),
  );
  let previous = 0;
  const out: Array<{ row: FeeVersionRow; state: VersionState }> = [];
  for (const row of newestFirst) {
    const state = states.get(row.version) ?? 'previous';
    if (state === 'previous' && previous++ >= PREVIOUS_SHOWN) continue;
    out.push({ row, state });
  }
  return out;
}

function cell(row: RateRow, which: 'maker' | 'taker'): string {
  if (row.zeroFee) return 'zero fee';
  return rateText(which === 'maker' ? row.makerBps : row.takerBps);
}

/** The shown versions regrouped by pair group: one table per group, one line per version and tier. */
export function pairGroupViews(history: readonly FeeVersionRow[], now: Date): PairGroupView[] {
  const shown = shownVersions(history, now);
  const groups = new Map<string, GroupRateLine[]>();
  for (const { row, state } of shown) {
    for (const rate of rowsOf(row.schedule)) {
      const lines = groups.get(rate.pairGroup) ?? [];
      lines.push({
        version: row.version,
        state,
        effectiveAt: row.effectiveAt,
        tierId: rate.tierId,
        maker: cell(rate, 'maker'),
        taker: cell(rate, 'taker'),
        rebate: rateText(rate.makerRebateBps),
        minFee: rate.minFee ?? 'none',
      });
      groups.set(rate.pairGroup, lines);
    }
  }
  const latest = shown[0]?.row.schedule ?? {};
  const defaultGroup = str(latest.defaultPairGroup) ? latest.defaultPairGroup : EVERY_MARKET;
  const named = rec(latest.pairGroups) ? latest.pairGroups : {};
  return [...groups.entries()]
    .sort(([a], [b]) => (a === defaultGroup ? -1 : b === defaultGroup ? 1 : a.localeCompare(b)))
    .map(([group, lines]) => ({
      group,
      markets:
        group === defaultGroup
          ? null
          : Object.entries(named)
              .filter(([, g]) => g === group)
              .map(([symbol]) => symbol)
              .sort(),
      lines,
    }));
}

/** The maker rebate tiers of the version in force (#5): every row, with its rebate or "not set". */
export function rebateTiers(row: FeeVersionRow | null): Array<{ pairGroup: string; tierId: string; maker: string; rebate: string }> {
  if (!row) return [];
  return rowsOf(row.schedule).map((r) => ({
    pairGroup: r.pairGroup,
    tierId: r.tierId,
    maker: cell(r, 'maker'),
    rebate: rateText(r.makerRebateBps),
  }));
}

export interface TierProgramView {
  readonly thresholds: ReadonlyArray<{ readonly tierId: string; readonly minVolume30d: string }>;
  readonly snapshotTimeUtc: string | null;
}

/** The VIP tier programme a schedule carries, or null when it has none ("Thresholds not set"). */
export function tierProgramOf(schedule: Readonly<Record<string, unknown>>): TierProgramView | null {
  const p = schedule.tierProgram;
  if (!rec(p) || !Array.isArray(p.thresholds)) return null;
  return {
    thresholds: p.thresholds
      .filter(rec)
      .map((t) => ({ tierId: str(t.tierId) ? t.tierId : '', minVolume30d: str(t.minVolume30d) ? t.minVolume30d : '' })),
    snapshotTimeUtc: str(p.snapshotTimeUtc) ? p.snapshotTimeUtc : null,
  };
}

/** One line for a programme: "test-vip-1 from 500 · snapshot 10:42 UTC". */
export function tierProgramText(p: TierProgramView): string {
  const tiers = p.thresholds.map((t) => `${t.tierId} from ${t.minVolume30d}`).join(', ');
  return `${tiers} · snapshot ${p.snapshotTimeUtc === null ? 'not set' : `${p.snapshotTimeUtc} UTC`}`;
}

// ── The proposal ──

export interface ProposalDraft {
  /** One editable line per (pair group, tier) of the base version that is not a zero-fee row. */
  readonly rates: ReadonlyArray<{
    readonly pairGroup: string;
    readonly tierId: string;
    readonly makerBps: string;
    readonly takerBps: string;
  }>;
  /** The programme's thresholds, or null when the base version has no programme. */
  readonly thresholds: ReadonlyArray<{ readonly tierId: string; readonly minVolume30d: string }> | null;
  readonly snapshotTimeUtc: string | null;
  /** "2026-11-06T10:30:00Z" as typed. */
  readonly effectiveAt: string;
}

/** The form a founder starts from: the latest stored version's rates and programme, and no time. */
export function draftFrom(base: FeeVersionRow): ProposalDraft {
  const program = tierProgramOf(base.schedule);
  return {
    rates: rowsOf(base.schedule)
      .filter((r) => !r.zeroFee)
      .map((r) => ({ pairGroup: r.pairGroup, tierId: r.tierId, makerBps: r.makerBps ?? '', takerBps: r.takerBps ?? '' })),
    thresholds: program ? program.thresholds.map((t) => ({ ...t })) : null,
    snapshotTimeUtc: program?.snapshotTimeUtc ?? null,
    effectiveAt: '',
  };
}

export type ProposalCheck =
  | { readonly ok: true; readonly schedule: Record<string, unknown>; readonly effectiveAt: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const BPS = /^(?:0|[1-9]\d{0,3})$/;
const VOLUME = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TYPED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
export const REASON_MIN = 12;
export const REASON_MAX = 500;

const refuse = (code: string, message: string): ProposalCheck => ({ ok: false, code, message });

/**
 * The schedule a draft proposes: the base version's schedule with the draft's rates, thresholds and snapshot time put in,
 * everything else kept exactly. Refuses, naming the field, before anything is sent: a blank or malformed rate or threshold
 * with svc-trade's own code (`trade.fee_schedule_blank`), a time that is not a UTC time or is not after `now`, and a
 * short reason. The same draft and base always give the same schedule, so the approval's hash can be worked out again.
 */
export function buildProposal(base: FeeVersionRow, draft: ProposalDraft, reason: string, now: Date): ProposalCheck {
  const schedule = JSON.parse(JSON.stringify(base.schedule)) as Record<string, unknown>;
  for (const line of draft.rates) {
    const where = `${line.pairGroup} / ${line.tierId}`;
    for (const [field, value] of [
      ['maker', line.makerBps],
      ['taker', line.takerBps],
    ] as const) {
      if (value.trim() === '')
        return refuse('trade.fee_schedule_blank', `The ${field} fee of ${where} is blank. Every rate needs a value.`);
      if (!BPS.test(value.trim()))
        return refuse('trade.fee_schedule_blank', `The ${field} fee of ${where} must be a whole number of bps from 0 to 9999.`);
    }
    if (Array.isArray(schedule.rows)) {
      const row = schedule.rows.find((r) => rec(r) && r.pairGroup === line.pairGroup && r.tierId === line.tierId);
      if (!rec(row)) return refuse('trade_ops.fee_row_unknown', `The base version has no row ${where}. Read the versions again.`);
      row.makerBps = line.makerBps.trim();
      row.takerBps = line.takerBps.trim();
    } else {
      schedule.makerBps = line.makerBps.trim();
      schedule.takerBps = line.takerBps.trim();
    }
  }
  if (draft.thresholds !== null) {
    const program = schedule.tierProgram;
    if (!rec(program) || !Array.isArray(program.thresholds))
      return refuse('trade_ops.fee_row_unknown', 'The base version has no VIP programme. Read the versions again.');
    for (const t of draft.thresholds) {
      if (t.minVolume30d.trim() === '')
        return refuse('trade.fee_schedule_blank', `The threshold of ${t.tierId} is blank. Every tier needs its 30-day volume.`);
      if (!VOLUME.test(t.minVolume30d.trim()))
        return refuse('trade.fee_schedule_blank', `The threshold of ${t.tierId} must be a decimal amount, such as 1000 or 2500.5.`);
      const row = program.thresholds.find((x) => rec(x) && x.tierId === t.tierId);
      if (!rec(row)) return refuse('trade_ops.fee_row_unknown', `The base version has no tier ${t.tierId}. Read the versions again.`);
      row.minVolume30d = t.minVolume30d.trim();
    }
    const at = (draft.snapshotTimeUtc ?? '').trim();
    if (at === '') return refuse('trade.fee_schedule_blank', 'The snapshot time is blank. Write it as HH:MM in UTC.');
    if (!HHMM.test(at)) return refuse('trade.fee_schedule_blank', 'The snapshot time must be HH:MM in UTC, such as 00:00 or 16:30.');
    program.snapshotTimeUtc = at;
  }
  const typed = draft.effectiveAt.trim();
  if (!TYPED_TIME.test(typed) || Number.isNaN(Date.parse(typed)))
    return refuse('trade_ops.fee_effective_invalid', 'Write when it takes effect as a UTC time, such as 2026-11-06T16:00:00Z.');
  const effectiveAt = new Date(typed).toISOString();
  if (Date.parse(effectiveAt) <= now.getTime())
    return refuse('fee_schedule_effective_in_past', 'A version takes effect after now, so no order already placed is re-priced.');
  if (Date.parse(effectiveAt) < Date.parse(base.effectiveAt))
    return refuse(
      'fee_schedule_effective_out_of_order',
      `It must take effect after the version it starts from (${shownTime(base.effectiveAt)}).`,
    );
  const why = reason.trim();
  if (why.length < REASON_MIN || why.length > REASON_MAX)
    return refuse('trade_ops.reason_required', `Write the reason (${REASON_MIN} to ${REASON_MAX} characters). It is kept in the audit.`);
  return { ok: true, schedule, effectiveAt };
}

/** The proposal as the browser sends it and the console's route reads it back. Null when the body is not that shape. */
export function parseDraft(raw: unknown): ProposalDraft | null {
  if (!rec(raw) || !Array.isArray(raw.rates) || !str(raw.effectiveAt)) return null;
  const rates = raw.rates.map((r) =>
    rec(r) && str(r.pairGroup) && str(r.tierId) && str(r.makerBps) && str(r.takerBps)
      ? { pairGroup: r.pairGroup, tierId: r.tierId, makerBps: r.makerBps, takerBps: r.takerBps }
      : null,
  );
  if (rates.some((r) => r === null) || rates.length > 200) return null;
  let thresholds: ProposalDraft['thresholds'] = null;
  if (raw.thresholds !== null) {
    if (!Array.isArray(raw.thresholds) || raw.thresholds.length > 50) return null;
    const parsed = raw.thresholds.map((t) =>
      rec(t) && str(t.tierId) && str(t.minVolume30d) ? { tierId: t.tierId, minVolume30d: t.minVolume30d } : null,
    );
    if (parsed.some((t) => t === null)) return null;
    thresholds = parsed as Array<{ tierId: string; minVolume30d: string }>;
  }
  if (raw.snapshotTimeUtc !== null && !str(raw.snapshotTimeUtc)) return null;
  return {
    rates: rates as Array<{ pairGroup: string; tierId: string; makerBps: string; takerBps: string }>,
    thresholds,
    snapshotTimeUtc: raw.snapshotTimeUtc as string | null,
    effectiveAt: raw.effectiveAt,
  };
}
