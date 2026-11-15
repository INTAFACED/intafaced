import type { MemberInput, MemberStatus, PlanInput, TermsInput, Typed } from './maker-programme-model';

/**
 * A draft as the browser sent it, read into the model's input shape, or null when it is not that shape. Every value is
 * a string or null; a blank stays blank so the model refuses it by name. Nothing is filled in.
 */

type R = Record<string, unknown>;
const obj = (v: unknown): R | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : null);
const typed = (v: unknown): Typed | undefined => (v === null || v === undefined ? null : typeof v === 'string' ? v : undefined);

function fields<K extends string>(r: R, keys: readonly K[]): Record<K, Typed> | null {
  const out = {} as Record<K, Typed>;
  for (const k of keys) {
    const v = typed(r[k]);
    if (v === undefined) return null;
    out[k] = v;
  }
  return out;
}

export function termsDraft(v: unknown): TermsInput | null {
  const r = obj(v);
  if (!r || !Array.isArray(r.tiers) || r.tiers.length > 10) return null;
  const tiers = r.tiers.map((t) => {
    const o = obj(t);
    return o ? fields(o, ['name', 'minMakerVolume30d', 'minUptimePct', 'maxSpreadAtDepthBps', 'rebateBps'] as const) : null;
  });
  if (tiers.some((t) => t === null)) return null;
  const rest = fields(r, [
    'maxSpreadBps',
    'minDepth',
    'minUptimePct',
    'cancelToFillCeiling',
    'clawbackWindowDays',
    'equalAccessCriteria',
  ] as const);
  return rest ? { tiers: tiers as TermsInput['tiers'], ...rest } : null;
}

export function memberDraft(v: unknown): MemberInput | null {
  const r = obj(v);
  if (!r) return null;
  const f = fields(r, ['accountId', 'tier', 'conflictDeclaration'] as const);
  const status = r.status === 'active' || r.status === 'suspended' || r.status === 'exited' ? (r.status as MemberStatus) : null;
  return f ? { ...f, status } : null;
}

export function planDraft(v: unknown): PlanInput | null {
  const r = obj(v);
  if (!r || !Array.isArray(r.makers) || r.makers.length > 20) return null;
  const makers = r.makers.map((m) => {
    const o = obj(m);
    return o ? fields(o, ['accountId', 'capital', 'asset'] as const) : null;
  });
  if (makers.some((m) => m === null)) return null;
  const rest = fields(r, [
    'maxSpreadBps',
    'minDepth',
    'depthBandBps',
    'minUptimePct',
    'inventoryMin',
    'inventoryMax',
    'exitReviewDate',
    'exitUptimeBelowPct',
    'exitSpreadAboveBps',
  ] as const);
  return rest ? { makers: makers as PlanInput['makers'], ...rest } : null;
}
