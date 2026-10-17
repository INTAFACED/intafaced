/**
 * Live compliance state from svc-edge `/admin/status` and `/admin/compliance/queue`, read strictly.
 *
 * Every reader returns null for anything that is not exactly the shape the edge sends, and the page then says the
 * section is unreadable. Nothing here fills a gap: an absent section is "not returned", never "clear", and an empty
 * queue is only "empty" when the edge said `empty: true`.
 *
 * What the numbers are NOT: the geo-block verdict is the edge's decision for the region it resolved for the console's
 * OWN request, not a verdict for any customer region; the queue is held in svc-edge process memory and is gone when
 * the edge restarts (filed in admin-BACKEND-NEEDS.md).
 */

export type QueueKind = 'screening_hit' | 'kyc_review' | 'network_flag' | 'manual';
const KINDS: readonly string[] = ['screening_hit', 'kyc_review', 'network_flag', 'manual'];

export interface QueueItem {
  readonly id: string;
  readonly kind: QueueKind;
  readonly subjectId: string;
  readonly openedAt: string;
}

export interface QueueAuditEntry {
  readonly at: string;
  readonly itemId: string;
  readonly ok: boolean;
  readonly status: string | null;
  readonly actor: string | null;
  readonly code: string | null;
  readonly reason: string | null;
}

export interface QueueSnapshot {
  readonly items: readonly QueueItem[];
  readonly partnerConfigured: boolean;
  readonly empty: boolean;
  readonly summary: string;
  readonly recentAudit: readonly QueueAuditEntry[];
}

export interface EdgeComplianceStatus {
  readonly region: { code: string; regionResolved: boolean; source: string; statusLine: string };
  readonly geoBlock: {
    allowed: boolean;
    code: string;
    reason: string;
    screeningDeclaration: string;
    screeningConfigured: boolean;
    listHitCount: number | null;
    regionResolved: boolean;
  };
  readonly networkSignal: {
    declaration: string;
    partnerConfigured: boolean;
    statusLine: string;
    accessAllowed: boolean;
    accessCode: string;
    summary: string;
  };
  readonly freezeAuthority: { soleKey: string; note: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const str = (v: unknown): v is string => typeof v === 'string';
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const nstr = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function readQueue(raw: unknown): QueueSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !bool(raw.partnerConfigured) || !bool(raw.empty) || !str(raw.summary)) return null;
  const items: QueueItem[] = [];
  for (const row of raw.items) {
    if (!isRecord(row) || !str(row.id) || !str(row.kind) || !KINDS.includes(row.kind) || !str(row.subjectId) || !str(row.openedAt))
      return null;
    items.push({ id: row.id, kind: row.kind as QueueKind, subjectId: row.subjectId, openedAt: row.openedAt });
  }
  if (raw.empty !== (items.length === 0)) return null;
  const audit: QueueAuditEntry[] = [];
  if (!Array.isArray(raw.recentAudit)) return null;
  for (const row of raw.recentAudit) {
    if (!isRecord(row) || !str(row.at) || !str(row.itemId) || !bool(row.ok)) return null;
    audit.push({
      at: row.at,
      itemId: row.itemId,
      ok: row.ok,
      status: nstr(row.status) ? (row.status ?? null) : null,
      actor: nstr(row.actor) ? (row.actor ?? null) : null,
      code: str(row.code) ? row.code : null,
      reason: str(row.reason) ? row.reason : null,
    });
  }
  return { items, partnerConfigured: raw.partnerConfigured, empty: raw.empty, summary: raw.summary, recentAudit: audit };
}

export function readStatus(raw: unknown): EdgeComplianceStatus | null {
  if (!isRecord(raw)) return null;
  const { region, geoBlock, networkSignal, freezeAuthority } = raw;
  if (!isRecord(region) || !str(region.code) || !bool(region.regionResolved) || !str(region.source) || !str(region.statusLine)) return null;
  if (
    !isRecord(geoBlock) ||
    !bool(geoBlock.allowed) ||
    !str(geoBlock.code) ||
    !str(geoBlock.reason) ||
    !str(geoBlock.screeningDeclaration) ||
    !bool(geoBlock.screeningConfigured) ||
    !bool(geoBlock.regionResolved)
  )
    return null;
  if (
    !isRecord(networkSignal) ||
    !str(networkSignal.declaration) ||
    !bool(networkSignal.partnerConfigured) ||
    !str(networkSignal.statusLine) ||
    !bool(networkSignal.accessAllowed) ||
    !str(networkSignal.accessCode) ||
    !str(networkSignal.summary)
  )
    return null;
  if (!isRecord(freezeAuthority) || !str(freezeAuthority.soleKey) || !str(freezeAuthority.note)) return null;
  const hits = geoBlock.listHitCount;
  return {
    region: { code: region.code, regionResolved: region.regionResolved, source: region.source, statusLine: region.statusLine },
    geoBlock: {
      allowed: geoBlock.allowed,
      code: geoBlock.code,
      reason: geoBlock.reason,
      screeningDeclaration: geoBlock.screeningDeclaration,
      screeningConfigured: geoBlock.screeningConfigured,
      listHitCount: typeof hits === 'number' && Number.isFinite(hits) ? hits : null,
      regionResolved: geoBlock.regionResolved,
    },
    networkSignal: {
      declaration: networkSignal.declaration,
      partnerConfigured: networkSignal.partnerConfigured,
      statusLine: networkSignal.statusLine,
      accessAllowed: networkSignal.accessAllowed,
      accessCode: networkSignal.accessCode,
      summary: networkSignal.summary,
    },
    freezeAuthority: { soleKey: freezeAuthority.soleKey, note: freezeAuthority.note },
  };
}

export type Disposition = 'cleared' | 'rejected';
export const DISPOSITION_REASON_MIN = 12;
export const DISPOSITION_REASON_MAX = 500;

/** The exact phrase to type. It carries the case id, so a click on a neighbouring row does not pass. */
export function dispositionPhrase(status: Disposition, itemId: string): string {
  return `${status === 'cleared' ? 'CLEAR' : 'REJECT'} ${itemId}`;
}

export type Gate = { readonly ok: true } | { readonly ok: false; readonly why: string };

export function dispositionGate(input: { status: Disposition; itemId: string; reason: string; confirm: string; busy: boolean }): Gate {
  if (input.busy) return { ok: false, why: 'A step is already in progress.' };
  const reason = input.reason.trim();
  if (reason.length < DISPOSITION_REASON_MIN)
    return { ok: false, why: `Write the reason first (at least ${DISPOSITION_REASON_MIN} characters).` };
  if (reason.length > DISPOSITION_REASON_MAX)
    return { ok: false, why: `The reason is too long (at most ${DISPOSITION_REASON_MAX} characters).` };
  const phrase = dispositionPhrase(input.status, input.itemId);
  if (input.confirm !== phrase) return { ok: false, why: `Type ${phrase} exactly to confirm.` };
  return { ok: true };
}

export type ComplianceSection<T> =
  { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'failed'; readonly message: string; readonly code: string | null };

export interface ComplianceRead {
  readonly asOf: string;
  readonly status: ComplianceSection<EdgeComplianceStatus>;
  readonly queue: ComplianceSection<QueueSnapshot>;
}
