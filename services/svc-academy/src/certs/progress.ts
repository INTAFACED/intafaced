/**
 * Certifications Stage-1 — progress spine (enroll / complete / grant).
 *
 * Spec: docs/ops/trk/academy.certs.md Stage 1.
 *
 * · Schema pure functions + in-memory store shape for enroll / complete / grant.
 * · Re-complete is idempotent (no-op, not double grant).
 * · Incomplete item set cannot grant cert.
 * · XP emit on grant is Stage-2 shipped (`xp-publish.ts` / `grantCert` service).
 * · Perks remain svc-identity rank SoT — academy never maps cert → perk.
 */

import { assertCertGrantPathHonest } from './grant-ledger.js';

export type EnrollmentRecord = {
  userId: string;
  pathSlug: string;
  enrolledAt: Date;
};

export type ItemCompletionRecord = {
  userId: string;
  itemSlug: string;
  completedAt: Date;
};

export type CertPath = 'foundations' | 'markets' | 'builder' | 'sovereign';

export type CertDefinition = {
  /** Stable cert id, e.g. foundations-v1 */
  id: string;
  title: string;
  /**
   * Programme path this certificate belongs to. Required on a published
   * catalog row. In-memory fixtures that are not a path certificate may omit it.
   */
  path?: CertPath;
  /**
   * Curriculum item slugs, or `assessment:<slug>` for a passing attempt.
   * A lesson completion does not satisfy an assessment requirement.
   */
  requiredItemSlugs: readonly string[];
};

/** `assessment:<slug>` or null when the requirement is a lesson slug. */
export function assessmentRequirementSlug(requirement: string): string | null {
  if (!requirement.startsWith('assessment:')) return null;
  const slug = requirement.slice('assessment:'.length);
  if (!slug || slug.includes(':')) return null;
  return slug;
}

export function requirementMet(
  requirement: string,
  completedSlugs: ReadonlySet<string>,
  passedAssessmentSlugs: ReadonlySet<string>,
): boolean {
  const assessment = assessmentRequirementSlug(requirement);
  if (assessment !== null) return passedAssessmentSlugs.has(assessment);
  return completedSlugs.has(requirement);
}

export type CertGrantRecord = {
  userId: string;
  certId: string;
  grantedAt: Date;
  /** Idempotency key — same user+cert always same key Stage-1. */
  idempotencyKey: string;
};

export type CertErrorCode = 'academy.cert_not_found' | 'academy.cert_incomplete' | 'academy.cert_invalid' | 'academy.cert_already_granted';

export class CertError extends Error {
  constructor(
    message: string,
    readonly code: CertErrorCode,
  ) {
    super(message);
    this.name = 'CertError';
  }
}

export function certIdempotencyKey(userId: string, certId: string): string {
  return `cert:${userId}:${certId}`;
}

/**
 * Pure: every requirement is met. An `assessment:<slug>` requirement counts
 * only when that slug is in `passedAssessmentSlugs`. Lesson slugs ignore it,
 * so a catalog with no assessment requirements is unchanged.
 */
export function isComplete(
  required: readonly string[],
  completedSlugs: ReadonlySet<string>,
  passedAssessmentSlugs: ReadonlySet<string> = new Set(),
): boolean {
  return required.every((s) => requirementMet(s, completedSlugs, passedAssessmentSlugs));
}

/**
 * Grant decision: returns grant or throws. Re-grant with same key is returned
 * as alreadyGranted=true without inventing a second record.
 */
export function decideGrant(input: {
  userId: string;
  cert: CertDefinition | null;
  completedSlugs: ReadonlySet<string>;
  existing: CertGrantRecord | null;
  passedAssessmentSlugs?: ReadonlySet<string>;
  now?: Date;
}): { grant: CertGrantRecord; alreadyGranted: boolean } {
  const { userId, cert, completedSlugs, existing } = input;
  const passed = input.passedAssessmentSlugs ?? new Set<string>();
  if (!cert) {
    throw new CertError('Unknown certification', 'academy.cert_not_found');
  }
  if (cert.requiredItemSlugs.length === 0) {
    throw new CertError('Cert definition has no required items', 'academy.cert_invalid');
  }
  if (existing) {
    assertCertGrantPathHonest(existing);
    return { grant: existing, alreadyGranted: true };
  }
  if (!isComplete(cert.requiredItemSlugs, completedSlugs, passed)) {
    throw new CertError('Required curriculum items incomplete', 'academy.cert_incomplete');
  }
  const now = input.now ?? new Date();
  const grant: CertGrantRecord = {
    userId,
    certId: cert.id,
    grantedAt: now,
    idempotencyKey: certIdempotencyKey(userId, cert.id),
  };
  assertCertGrantPathHonest(grant);
  return {
    alreadyGranted: false,
    grant,
  };
}

/**
 * Wire honesty after INSERT into cert_grants.
 *
 * Concurrent grantCert callers can both pass the pre-check `existing=null`, then
 * only one INSERT succeeds. With ON CONFLICT DO NOTHING the loser gets zero rows
 * and must report `alreadyGranted: true` (not a second "you just earned this").
 * Returning false on every RETURNING path used to lie after a conflict DO UPDATE.
 */
export function alreadyGrantedAfterInsert(insertReturned: boolean): boolean {
  return !insertReturned;
}

/** Pure: mark item complete; re-complete returns same timestamp (idempotent). */
export function decideItemComplete(input: { userId: string; itemSlug: string; existing: ItemCompletionRecord | null; now?: Date }): {
  record: ItemCompletionRecord;
  alreadyComplete: boolean;
} {
  const slug = input.itemSlug.trim();
  if (!slug || slug.length > 120) {
    throw new CertError('Invalid item slug', 'academy.cert_invalid');
  }
  if (input.existing) {
    return { record: input.existing, alreadyComplete: true };
  }
  return {
    alreadyComplete: false,
    record: {
      userId: input.userId,
      itemSlug: slug,
      completedAt: input.now ?? new Date(),
    },
  };
}

/** Named refuse when a workbook slug is not a required item on any cert. */
export const PAPER_CERT_UNBOUND = 'academy.paper_cert_unbound' as const;

export type WorkbookCertBinding =
  | {
      readonly progress: 'bound';
      readonly certId: string;
      readonly itemSlug: string;
    }
  | {
      readonly progress: 'unbound';
      readonly itemSlug: string;
      readonly reason: typeof PAPER_CERT_UNBOUND;
    };

/**
 * Bind a workbook (curriculum item slug) to a cert that lists it as required.
 * Unbound → honest named refuse, never a fake grant.
 */
export function workbookCertBinding(itemSlug: string, certs: readonly CertDefinition[]): WorkbookCertBinding {
  const slug = itemSlug.trim();
  if (!slug || slug.length > 120) {
    throw new CertError('Invalid item slug', 'academy.cert_invalid');
  }
  const cert = certs.find((c) => c.requiredItemSlugs.includes(slug));
  if (!cert) {
    return { progress: 'unbound', itemSlug: slug, reason: PAPER_CERT_UNBOUND };
  }
  return { progress: 'bound', certId: cert.id, itemSlug: slug };
}

/** In-memory Stage-1 store for tests and early API. */
export class MemoryCertStore {
  private enrollments = new Map<string, EnrollmentRecord>();
  private completions = new Map<string, ItemCompletionRecord>();
  private grants = new Map<string, CertGrantRecord>();
  private certs = new Map<string, CertDefinition>();

  registerCert(def: CertDefinition): void {
    if (!def.id || def.requiredItemSlugs.length === 0) {
      throw new CertError('Invalid cert definition', 'academy.cert_invalid');
    }
    this.certs.set(def.id, def);
  }

  enroll(userId: string, pathSlug: string, now = new Date()): EnrollmentRecord {
    const key = `${userId}:${pathSlug}`;
    const existing = this.enrollments.get(key);
    if (existing) return existing;
    const row: EnrollmentRecord = { userId, pathSlug, enrolledAt: now };
    this.enrollments.set(key, row);
    return row;
  }

  markComplete(userId: string, itemSlug: string, now = new Date()): ItemCompletionRecord {
    const key = `${userId}:${itemSlug}`;
    const { record, alreadyComplete } = decideItemComplete({
      userId,
      itemSlug,
      existing: this.completions.get(key) ?? null,
      now,
    });
    if (!alreadyComplete) this.completions.set(key, record);
    return record;
  }

  completedSet(userId: string): Set<string> {
    const out = new Set<string>();
    for (const c of this.completions.values()) {
      if (c.userId === userId) out.add(c.itemSlug);
    }
    return out;
  }

  grant(userId: string, certId: string, now = new Date()): CertGrantRecord {
    const key = certIdempotencyKey(userId, certId);
    const { grant } = decideGrant({
      userId,
      cert: this.certs.get(certId) ?? null,
      completedSlugs: this.completedSet(userId),
      existing: this.grants.get(key) ?? null,
      now,
    });
    this.grants.set(key, grant);
    return grant;
  }

  listCerts(userId: string): CertGrantRecord[] {
    return [...this.grants.values()].filter((g) => g.userId === userId);
  }

  /**
   * L3 — sorted cert ids granted to a user. Missing user → [] (never invent grant).
   */
  listGrantedCertIds(userId: string): readonly string[] {
    const id = userId.trim();
    if (!id) return [];
    return this.listCerts(id)
      .map((g) => g.certId)
      .sort();
  }

  /**
   * L3 — sorted completed item slugs for a user. Missing → [] (never invent).
   */
  listCompletedItemSlugs(userId: string): readonly string[] {
    return [...this.completedSet(userId)].sort();
  }

  /** L3 progress snapshot for one cert — missing items named, no invent grant. */
  progressOf(userId: string, certId: string): ProgressReport {
    return progressReport({
      userId,
      cert: this.certs.get(certId) ?? null,
      completedSlugs: this.completedSet(userId),
      existingGrant: this.grants.get(certIdempotencyKey(userId, certId)) ?? null,
    });
  }

  /**
   * L3 — defined cert ids (sorted). Empty registry → [] (never invent catalog).
   */
  listCertIds(): readonly string[] {
    return [...this.certs.keys()].sort();
  }
}

/**
 * Stage-2 L3 — pure progress report (no XP, no money).
 * completed/required are counts; ratio is decimal string 0…1 (not a percent invent UI).
 */
export type ProgressReport = {
  readonly userId: string;
  readonly certId: string;
  readonly title: string;
  readonly requiredCount: number;
  readonly completedCount: number;
  /** Decimal string fraction complete, e.g. "0.5000". Empty cert → refuse earlier. */
  readonly ratio: string;
  readonly missingItemSlugs: readonly string[];
  readonly complete: boolean;
  readonly granted: boolean;
  readonly grantIdempotencyKey: string | null;
};

export function progressReport(input: {
  userId: string;
  cert: CertDefinition | null;
  completedSlugs: ReadonlySet<string>;
  existingGrant: CertGrantRecord | null;
  passedAssessmentSlugs?: ReadonlySet<string>;
}): ProgressReport {
  if (!input.cert) {
    throw new CertError('Unknown certification', 'academy.cert_not_found');
  }
  if (input.cert.requiredItemSlugs.length === 0) {
    throw new CertError('Cert definition has no required items', 'academy.cert_invalid');
  }
  const required = input.cert.requiredItemSlugs;
  const passed = input.passedAssessmentSlugs ?? new Set<string>();
  const missing = required.filter((s) => !requirementMet(s, input.completedSlugs, passed));
  const completedCount = required.length - missing.length;
  const requiredCount = required.length;
  // Fixed 4dp ratio string — progress UI key, not money.
  const ratio = (completedCount / requiredCount).toFixed(4);
  const complete = missing.length === 0;
  return {
    userId: input.userId,
    certId: input.cert.id,
    title: input.cert.title,
    requiredCount,
    completedCount,
    ratio,
    missingItemSlugs: missing,
    complete,
    granted: input.existingGrant !== null,
    grantIdempotencyKey: input.existingGrant?.idempotencyKey ?? null,
  };
}

/** L3 — missing item count from a progress report (no invent). */
export function missingItemCount(report: ProgressReport): number {
  return report.missingItemSlugs.length;
}

/**
 * L3 — whether progress is grantable now (complete + not already granted).
 * Does not invent a grant — pure readiness check.
 */
export function isGrantReady(report: ProgressReport): boolean {
  return report.complete && !report.granted;
}

/**
 * L3 — already granted flag from report (no invent grant id).
 */
export function isAlreadyGranted(report: ProgressReport): boolean {
  return report.granted;
}

/** L3 — completed count from report. */
export function completedItemCount(report: ProgressReport): number {
  return report.completedCount;
}

/** L3 — required count from report. */
export function requiredItemCount(report: ProgressReport): number {
  return report.requiredCount;
}

/** L3 — ratio label from report. */
export function progressRatioLabel(report: ProgressReport): string {
  return report.ratio;
}

/** L3 — true when report is complete and not granted. Alias of isGrantReady. */
export function progressIsGrantable(report: ProgressReport): boolean {
  return isGrantReady(report);
}

/** L3 — missing slugs joined. Empty → "". */
export function missingItemSlugsJoined(report: ProgressReport): string {
  return report.missingItemSlugs.join(',');
}

/** L3 — progress board card from report. */
export function progressBoardCard(report: ProgressReport): {
  readonly userId: string;
  readonly certId: string;
  readonly title: string;
  readonly required: number;
  readonly completed: number;
  readonly missing: number;
  readonly ratio: string;
  readonly complete: boolean;
  readonly granted: boolean;
  readonly grantable: boolean;
} {
  return {
    userId: report.userId,
    certId: report.certId,
    title: report.title,
    required: report.requiredCount,
    completed: report.completedCount,
    missing: missingItemCount(report),
    ratio: report.ratio,
    complete: report.complete,
    granted: report.granted,
    grantable: isGrantReady(report),
  };
}

/** L3 — progress export line. */
export function progressExportLine(report: ProgressReport): string {
  return `${report.userId},${report.certId},${report.ratio},${report.complete ? '1' : '0'},${report.granted ? '1' : '0'}`;
}

/** L3 — progress export header. */
export function progressExportHeader(): string {
  return 'userId,certId,ratio,complete,granted';
}

/** L3 — full progress export text for one report. */
export function progressExportText(report: ProgressReport): string {
  return [progressExportHeader(), progressExportLine(report)].join('\n');
}

/** L3 — parse progress export line. Invalid → null. */
export function parseProgressExportLine(line: string): {
  readonly userId: string;
  readonly certId: string;
  readonly ratio: string;
  readonly complete: boolean;
  readonly granted: boolean;
} | null {
  const t = line.trim();
  if (!t || t === progressExportHeader()) return null;
  const parts = t.split(',');
  if (parts.length !== 5) return null;
  const userId = parts[0]!.trim();
  const certId = parts[1]!.trim();
  const ratio = parts[2]!.trim();
  const complete = parts[3]!.trim();
  const granted = parts[4]!.trim();
  if (!userId || !certId || !ratio) return null;
  if (complete !== '0' && complete !== '1') return null;
  if (granted !== '0' && granted !== '1') return null;
  return { userId, certId, ratio, complete: complete === '1', granted: granted === '1' };
}

/** L3 — data-line count excluding header. */
export function countProgressExportDataLines(text: string): number {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== progressExportHeader()).length;
}

/** L3 — true when export has header. */
export function progressExportHasHeader(text: string): boolean {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === progressExportHeader();
}

/** L3 — round-trip for progress export. */
export function progressExportRoundTripOk(report: ProgressReport): boolean {
  const text = progressExportText(report);
  return text.split('\n').filter(Boolean).length === 1 + countProgressExportDataLines(text);
}

/** L3 — progress status line completed=N required=M. */
export function progressStatusLine(report: ProgressReport): string {
  return `completed=${report.completedCount} required=${report.requiredCount} missing=${missingItemCount(report)}`;
}

/** L3 — true when completed is 0. */
export function progressStatusLineIsEmpty(report: ProgressReport): boolean {
  return report.completedCount === 0;
}

/** L3 — detailed progress status. */
export function progressStatusLineDetailed(report: ProgressReport): string {
  const c = progressBoardCard(report);
  return `completed=${c.completed} required=${c.required} missing=${c.missing} complete=${c.complete ? '1' : '0'} grantable=${c.grantable ? '1' : '0'}`;
}

/** L3 — token count detailed status. */
export function progressStatusLineTokenCount(report: ProgressReport): number {
  return progressStatusLineDetailed(report).split(/\s+/).filter(Boolean).length;
}

/** L3 — parse progress status. Invalid → null. */
export function parseProgressStatusLine(
  line: string,
): { readonly completed: number; readonly required: number; readonly missing: number } | null {
  const m = line.trim().match(/^completed=(\d+) required=(\d+) missing=(\d+)$/);
  if (!m) return null;
  return { completed: Number(m[1]), required: Number(m[2]), missing: Number(m[3]) };
}

/** L3 — true when status matches report. */
export function progressStatusLineMatches(report: ProgressReport): boolean {
  const p = parseProgressStatusLine(progressStatusLine(report));
  if (!p) return false;
  return p.completed === report.completedCount && p.required === report.requiredCount && p.missing === missingItemCount(report);
}

/** L3 — true when completed+missing equals required. */
export function progressStatusLineConsistent(line: string): boolean {
  const p = parseProgressStatusLine(line);
  if (!p) return false;
  return p.completed + p.missing === p.required;
}

/** L3 — true when completed is within [min,max]. Invalid → false. */
export function completedCountInRange(report: ProgressReport, min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  return report.completedCount >= min && report.completedCount <= max;
}

/** L3 — true when missing is at most n. */
export function missingCountAtMost(report: ProgressReport, n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return missingItemCount(report) <= n;
}
