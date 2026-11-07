import { createHash } from 'node:crypto';
import { canonicalJson } from './fees-hash';

/**
 * The internal book seeding configuration in the console (J-cex-spot-20 #5, RC-cex-spot-17). svc-trade
 * (`services/svc-trade/src/admin/seed-config.ts`) owns the rule; this mirrors it so a blank value is refused here, by name
 * and with svc-trade's own code, before anything is filed, and so the approval is bound to the same canonical body
 * svc-trade hashes when it writes the version.
 */

export const MM_SEED_UNSET = 'mm.seed_unset';
export const MM_SEED_ACTION_TYPE = 'trade.mm_seed';
export const MM_SEED_TARGET_SERVICE = 'svc-trade';
export const MM_SEED_POLICY_VERSION = 'trade-mm-seed-config-v1';

export type MidSource = 'configured' | 'venue';

export interface SeedConfigDraft {
  readonly enabled: boolean;
  readonly halfSpreadBps: string | null;
  readonly stepBps: string | null;
  readonly levels: string | null;
  readonly qtyPerLevel: string | null;
  readonly midSource: MidSource | null;
  readonly configuredMid: string | null;
}

export interface SeedConfigRow extends SeedConfigDraft {
  readonly market: string;
  readonly symbol: string;
  readonly version: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly approvalId: string;
  readonly writtenAt: string;
}

const blank = (v: string | null | undefined): boolean => v == null || v.trim() === '';

/** The first blank value of an enabled configuration, as svc-trade names it; null when none. */
export function firstUnset(c: SeedConfigDraft): string | null {
  if (!c.enabled) return null;
  if (blank(c.halfSpreadBps)) return 'half spread';
  if (blank(c.stepBps)) return 'step';
  if (blank(c.levels)) return 'levels';
  if (blank(c.qtyPerLevel)) return 'quantity per level';
  if (c.midSource == null) return 'mid source';
  if (c.midSource === 'configured' && blank(c.configuredMid)) return 'configured mid';
  return null;
}

const POSITIVE_INT = /^[1-9]\d{0,5}$/;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;

export type SeedCheck = { ok: true; config: SeedConfigDraft } | { ok: false; code: string; message: string };

/** The configuration as svc-trade will store and bind it, or the refusal it would give. */
export function checkSeedConfig(c: SeedConfigDraft): SeedCheck {
  const unset = firstUnset(c);
  if (unset) return { ok: false, code: MM_SEED_UNSET, message: `${unset} is not set; the seed places nothing until it is.` };
  const t = (v: string | null) => (blank(v) ? null : v!.trim());
  const config: SeedConfigDraft = {
    enabled: c.enabled,
    halfSpreadBps: t(c.halfSpreadBps),
    stepBps: t(c.stepBps),
    levels: t(c.levels),
    qtyPerLevel: t(c.qtyPerLevel),
    midSource: c.midSource,
    configuredMid: c.midSource === 'configured' ? t(c.configuredMid) : null,
  };
  const bad = (message: string): SeedCheck => ({ ok: false, code: 'mm.seed_invalid', message });
  if (config.halfSpreadBps !== null && !POSITIVE_INT.test(config.halfSpreadBps))
    return bad('half spread is a whole number of bps above 0.');
  if (config.stepBps !== null && !POSITIVE_INT.test(config.stepBps)) return bad('step is a whole number of bps above 0.');
  if (config.levels !== null && (!POSITIVE_INT.test(config.levels) || Number(config.levels) > 20))
    return bad('levels is a whole number from 1 to 20.');
  for (const [label, v] of [
    ['quantity per level', config.qtyPerLevel],
    ['configured mid', config.configuredMid],
  ] as const) {
    if (v !== null && (!POSITIVE_DECIMAL.test(v) || /^0(?:\.0+)?$/.test(v))) return bad(`${label} is a decimal above 0.`);
  }
  return { ok: true, config };
}

export interface SeedConfigBody {
  readonly market: string;
  readonly expectedVersion: string;
  readonly config: SeedConfigDraft;
}

/** sha256 of the canonical approval body svc-trade recomputes (`seedConfigApprovalBody`). */
export function seedConfigPayloadHash(body: SeedConfigBody): string {
  const payload = { actionType: MM_SEED_ACTION_TYPE, market: body.market, expectedVersion: body.expectedVersion, config: body.config };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function parseSeedConfigRow(v: unknown): SeedConfigRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!str(r.market) || !str(r.symbol) || !str(r.version) || typeof r.enabled !== 'boolean') return null;
  if (![r.halfSpreadBps, r.stepBps, r.levels, r.qtyPerLevel, r.configuredMid].every(strOrNull)) return null;
  if (!(r.midSource === null || r.midSource === 'configured' || r.midSource === 'venue')) return null;
  if (!str(r.operatorId) || !str(r.approverId) || !str(r.approvalId) || !str(r.writtenAt)) return null;
  return r as unknown as SeedConfigRow;
}

export function parseSeedConfigs(v: unknown): readonly SeedConfigRow[] | null {
  const list = v && typeof v === 'object' ? (v as { configs?: unknown }).configs : null;
  if (!Array.isArray(list)) return null;
  const rows = list.map(parseSeedConfigRow);
  return rows.every((r): r is SeedConfigRow => r !== null) ? rows : null;
}
