/**
 * The published trading rulebook (RC-cex-spot-08) as the founder console reads and drafts it. Plain data, safe in server
 * and browser code. svc-matching owns the versions; svc-trade's public `GET /api/v1/rulebook(/versions)` passes them on.
 */

/** The fixed sections, in reading order. A draft missing any one is refused by svc-matching (`matching.rulebook_section_unset`). */
export const RULEBOOK_SECTIONS = [
  { id: 'participation', title: 'participation' },
  { id: 'matching', title: 'matching' },
  { id: 'cancellation', title: 'cancellation' },
  { id: 'settlement', title: 'settlement' },
  { id: 'liquidation', title: 'liquidation' },
  { id: 'fees', title: 'fees' },
  { id: 'market_data', title: 'market data' },
] as const;

export type RulebookSectionId = (typeof RULEBOOK_SECTIONS)[number]['id'];

export interface RulebookDraft {
  readonly version: string;
  /** ISO time, or '' for "when published". */
  readonly effectiveAt: string;
  readonly sections: Readonly<Record<string, string>>;
}

export interface RulebookSection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface RulebookVersionRow {
  readonly version: string;
  readonly status: 'current' | 'upcoming' | 'superseded';
  readonly effectiveAt: string;
  readonly publishedAt: string;
  readonly supersedes: string | null;
  readonly changedSections: readonly string[];
  readonly sections: readonly RulebookSection[];
}

export interface RulebookHistory {
  readonly current: string | null;
  readonly versions: readonly RulebookVersionRow[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A draft from the page's body, or null. Text is kept as typed; svc-matching trims and checks it. */
export function parseRulebookDraft(raw: unknown): RulebookDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = r.sections && typeof r.sections === 'object' ? (r.sections as Record<string, unknown>) : {};
  const sections: Record<string, string> = {};
  for (const sec of RULEBOOK_SECTIONS) sections[sec.id] = str(s[sec.id]);
  return { version: str(r.version), effectiveAt: str(r.effectiveAt), sections };
}

function parseSection(raw: unknown): RulebookSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.title === 'string' && typeof r.body === 'string'
    ? { id: r.id, title: r.title, body: r.body }
    : null;
}

export function parseRulebookHistory(raw: unknown): RulebookHistory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!(r.current === null || typeof r.current === 'string') || !Array.isArray(r.versions)) return null;
  const versions: RulebookVersionRow[] = [];
  for (const v of r.versions) {
    if (!v || typeof v !== 'object') return null;
    const x = v as Record<string, unknown>;
    if (
      typeof x.version !== 'string' ||
      (x.status !== 'current' && x.status !== 'upcoming' && x.status !== 'superseded') ||
      typeof x.effectiveAt !== 'string' ||
      typeof x.publishedAt !== 'string' ||
      !(x.supersedes === null || typeof x.supersedes === 'string') ||
      !Array.isArray(x.changedSections) ||
      !Array.isArray(x.sections)
    )
      return null;
    const sections = x.sections.map(parseSection);
    if (sections.some((s) => s === null)) return null;
    versions.push({
      version: x.version,
      status: x.status,
      effectiveAt: x.effectiveAt,
      publishedAt: x.publishedAt,
      supersedes: x.supersedes,
      changedSections: x.changedSections.filter((c): c is string => typeof c === 'string'),
      sections: sections as RulebookSection[],
    });
  }
  return { current: r.current, versions };
}

/** What svc-matching answers for a draft it accepts: the exact approval it will check at publish. */
export interface RulebookCheck {
  readonly version: string;
  readonly digest: string;
  readonly actionType: string;
  readonly targetId: string;
  readonly payloadHash: string;
}

/** svc-matching answers 200 with `accepted: false` and its own code for a draft it refuses. */
export type MatchingAnswer<T> =
  { readonly accepted: true; readonly data: T } | { readonly accepted: false; readonly code: string; readonly message: string };

export function parseRulebookCheck(raw: unknown): MatchingAnswer<RulebookCheck> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.accepted === false) return refusedAnswer(r);
  if (
    r.accepted !== true ||
    typeof r.version !== 'string' ||
    typeof r.digest !== 'string' ||
    typeof r.actionType !== 'string' ||
    typeof r.targetId !== 'string' ||
    typeof r.payloadHash !== 'string'
  )
    return null;
  return {
    accepted: true,
    data: { version: r.version, digest: r.digest, actionType: r.actionType, targetId: r.targetId, payloadHash: r.payloadHash },
  };
}

export interface RulebookPublished {
  readonly version: string;
  readonly alreadyPublished: boolean;
}

export function parseRulebookPublish(raw: unknown): MatchingAnswer<RulebookPublished> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.accepted === false) return refusedAnswer(r);
  if (r.accepted !== true || typeof r.version !== 'string') return null;
  return { accepted: true, data: { version: r.version, alreadyPublished: r.alreadyPublished === true } };
}

function refusedAnswer(r: Record<string, unknown>): MatchingAnswer<never> | null {
  const rej = r.rejected && typeof r.rejected === 'object' ? (r.rejected as Record<string, unknown>) : null;
  if (!rej || typeof rej.code !== 'string') return null;
  return { accepted: false, code: rej.code, message: typeof rej.message === 'string' ? rej.message : rej.code };
}

/** "6 Nov 2026, 12:00 UTC": every founder reads the same moment. */
export function rulebookTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}
