/**
 * Ambassador Stage-2 — residency application (non-money).
 *
 * Spec: docs/ops/trk/academy.ambassadors.md Stage 2 pay is Class M — NOT here.
 * This slice: apply / review / accept|reject residency interest only.
 * No IFC pay, no revenue share, no ledger.
 */

export type ResidencyStatus = 'applied' | 'accepted' | 'rejected' | 'withdrawn';

export type ResidencyApplication = {
  readonly id: string;
  readonly userId: string;
  readonly cohortSlug: string;
  readonly statement: string;
  readonly status: ResidencyStatus;
  readonly appliedAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
};

export type ResidencyErrorCode =
  | 'academy.residency_invalid'
  | 'academy.residency_not_found'
  | 'academy.residency_already_open'
  | 'academy.residency_not_pending'
  | 'academy.residency_list_limit_unset';

export class ResidencyError extends Error {
  constructor(
    message: string,
    readonly code: ResidencyErrorCode,
  ) {
    super(message);
    this.name = 'ResidencyError';
  }
}

/** Owner-published page size. Blank / non-finite / <1 refuses. Never invent all.length. */
export function assertResidencyPageLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new ResidencyError('Residency list limit is unset — pass limit (never invent all.length)', 'academy.residency_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new ResidencyError('Residency list limit is unset — pass limit (never invent all.length)', 'academy.residency_list_limit_unset');
  }
  return Math.min(200, n);
}

export function assertCohortSlug(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(s)) {
    throw new ResidencyError('Cohort slug must be 3–48 lowercase alphanumeric + hyphen', 'academy.residency_invalid');
  }
  return s;
}

export function assertStatement(statement: string): string {
  const t = statement.trim();
  if (t.length < 20) {
    throw new ResidencyError('Statement min 20 characters after trim', 'academy.residency_invalid');
  }
  if (t.length > 2000) {
    throw new ResidencyError('Statement max 2000 characters', 'academy.residency_invalid');
  }
  return t;
}

/** In-memory Stage-2 store for tests / early API. */
export class MemoryResidencyDesk {
  private rows = new Map<string, ResidencyApplication>();
  private seq = 0;

  apply(input: { userId: string; cohortSlug: string; statement: string; now?: Date }): ResidencyApplication {
    const cohortSlug = assertCohortSlug(input.cohortSlug);
    const statement = assertStatement(input.statement);
    const userId = input.userId.trim();
    if (!userId) throw new ResidencyError('userId required', 'academy.residency_invalid');
    for (const r of this.rows.values()) {
      if (r.userId === userId && r.cohortSlug === cohortSlug && r.status === 'applied') {
        throw new ResidencyError('Open application already exists for this cohort', 'academy.residency_already_open');
      }
    }
    this.seq += 1;
    const row: ResidencyApplication = {
      id: `res-${this.seq}`,
      userId,
      cohortSlug,
      statement,
      status: 'applied',
      appliedAt: input.now ?? new Date(),
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  decide(input: { id: string; operatorId: string; decision: 'accepted' | 'rejected'; note?: string; now?: Date }): ResidencyApplication {
    const row = this.rows.get(input.id);
    if (!row) throw new ResidencyError('Application not found', 'academy.residency_not_found');
    if (row.status !== 'applied') {
      throw new ResidencyError(`Application is ${row.status}`, 'academy.residency_not_pending');
    }
    const operatorId = input.operatorId.trim();
    if (!operatorId) {
      throw new ResidencyError('operatorId required', 'academy.residency_invalid');
    }
    const next: ResidencyApplication = {
      ...row,
      status: input.decision,
      decidedAt: input.now ?? new Date(),
      decidedBy: operatorId,
      decisionNote: (input.note ?? '').trim().slice(0, 500) || null,
    };
    this.rows.set(next.id, next);
    return next;
  }

  listByUser(userId: string): ResidencyApplication[] {
    return [...this.rows.values()].filter((r) => r.userId === userId);
  }

  listOpen(cohortSlug?: string): ResidencyApplication[] {
    return [...this.rows.values()].filter((r) => r.status === 'applied' && (cohortSlug ? r.cohortSlug === cohortSlug : true));
  }

  listAccepted(cohortSlug?: string): ResidencyApplication[] {
    return [...this.rows.values()].filter((r) => r.status === 'accepted' && (cohortSlug ? r.cohortSlug === cohortSlug : true));
  }

  /**
   * L3 — cohort counts by status. Empty cohort → zeros (not invent applicants).
   */
  cohortSummary(cohortSlug: string): {
    readonly cohortSlug: string;
    readonly applied: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly withdrawn: number;
    readonly total: number;
  } {
    const slug = assertCohortSlug(cohortSlug);
    let applied = 0;
    let accepted = 0;
    let rejected = 0;
    let withdrawn = 0;
    for (const r of this.rows.values()) {
      if (r.cohortSlug !== slug) continue;
      if (r.status === 'applied') applied += 1;
      else if (r.status === 'accepted') accepted += 1;
      else if (r.status === 'rejected') rejected += 1;
      else if (r.status === 'withdrawn') withdrawn += 1;
    }
    return {
      cohortSlug: slug,
      applied,
      accepted,
      rejected,
      withdrawn,
      total: applied + accepted + rejected + withdrawn,
    };
  }

  /**
   * L3 — open (applied) applications for one user. Missing user → empty list.
   */
  openForUser(userId: string): readonly ResidencyApplication[] {
    const id = userId.trim();
    if (!id) return [];
    return [...this.rows.values()].filter((r) => r.userId === id && r.status === 'applied');
  }

  /** Applicant withdraws while still applied — no invent accept. */
  withdraw(input: { id: string; userId: string; now?: Date }): ResidencyApplication {
    const row = this.rows.get(input.id);
    if (!row) throw new ResidencyError('Application not found', 'academy.residency_not_found');
    if (row.userId !== input.userId.trim()) {
      throw new ResidencyError('Application not found', 'academy.residency_not_found');
    }
    if (row.status !== 'applied') {
      throw new ResidencyError(`Application is ${row.status}`, 'academy.residency_not_pending');
    }
    const next: ResidencyApplication = {
      ...row,
      status: 'withdrawn',
      decidedAt: input.now ?? new Date(),
      decidedBy: input.userId.trim(),
      decisionNote: 'withdrawn by applicant',
    };
    this.rows.set(next.id, next);
    return next;
  }

  /**
   * L3 — distinct cohort slugs that have any application (any status).
   * Empty desk → [] (never invent cohorts).
   */
  knownCohortSlugs(): readonly string[] {
    const set = new Set<string>();
    for (const r of this.rows.values()) set.add(r.cohortSlug);
    return [...set].sort();
  }

  /** L3 — open (applied) count across all cohorts — operator queue depth. */
  openCount(): number {
    return this.listOpen().length;
  }

  /** L3 — accepted count across all cohorts. Empty → 0. */
  acceptedCount(): number {
    return [...this.rows.values()].filter((r) => r.status === 'accepted').length;
  }

  /**
   * L3 — sorted open application ids. Empty desk → [] (never invent).
   */
  openApplicationIds(): readonly string[] {
    return this.listOpen()
      .map((r) => r.id)
      .sort();
  }

  /** L3 — rejected count across all cohorts. Empty → 0. */
  rejectedCount(): number {
    return [...this.rows.values()].filter((r) => r.status === 'rejected').length;
  }

  /** L3 — withdrawn count across all cohorts. Empty → 0. */
  withdrawnCount(): number {
    return [...this.rows.values()].filter((r) => r.status === 'withdrawn').length;
  }

  /**
   * L3 — sorted rejected application ids. Empty → [] (never invent).
   */
  rejectedApplicationIds(): readonly string[] {
    return [...this.rows.values()]
      .filter((r) => r.status === 'rejected')
      .map((r) => r.id)
      .sort();
  }

  /**
   * L3 — sorted accepted application ids. Empty → [] (never invent).
   */
  acceptedApplicationIds(): readonly string[] {
    return [...this.rows.values()]
      .filter((r) => r.status === 'accepted')
      .map((r) => r.id)
      .sort();
  }

  /**
   * L3 — sorted withdrawn application ids. Empty → [] (never invent).
   */
  withdrawnApplicationIds(): readonly string[] {
    return [...this.rows.values()]
      .filter((r) => r.status === 'withdrawn')
      .map((r) => r.id)
      .sort();
  }

  /** L3 — total applications any status. Empty → 0. */
  applicationCount(): number {
    return this.rows.size;
  }

  /**
   * L3 — true when user has at least one applied application. Missing → false.
   */
  hasOpenApplication(userId: string): boolean {
    return this.openForUser(userId).length > 0;
  }

  /** L3 — open application count for one user. Missing → 0. */
  openApplicationCount(userId: string): number {
    return this.openForUser(userId).length;
  }

  /** L3 — alias of rejectedCount. */
  rejectedApplicationCount(): number {
    return this.rejectedCount();
  }

  /** L3 — alias of acceptedCount. */
  acceptedApplicationCount(): number {
    return this.acceptedCount();
  }

  /** L3 — alias of withdrawnCount. */
  withdrawnApplicationCount(): number {
    return this.withdrawnCount();
  }
  /**
   * L3 — applied (open queue) count. Empty → 0.
   */
  appliedApplicationCount(): number {
    return this.openCount();
  }

  /**
   * L3 — sorted applied application ids. Empty → [].
   */
  appliedApplicationIds(): readonly string[] {
    return this.openApplicationIds();
  }

  /**
   * L3 — open/total as fixed 4dp string. Empty desk → null (never invent 0 queue).
   */
  openApplicationRatio(): string | null {
    const total = this.rows.size;
    if (total === 0) return null;
    return (this.openCount() / total).toFixed(4);
  }

  /**
   * L3 — true when desk has any application row. Empty → false.
   */
  hasAnyApplication(): boolean {
    return this.rows.size > 0;
  }

  /**
   * L3 — true when desk has zero open (applied) apps. Empty → true.
   */
  hasNoOpenApplications(): boolean {
    return this.openCount() === 0;
  }

  /**
   * L3 — accepted/total as fixed 4dp. Empty desk → null (never invent 0 accept).
   */
  acceptedApplicationRatio(): string | null {
    const total = this.rows.size;
    if (total === 0) return null;
    return (this.acceptedCount() / total).toFixed(4);
  }

  /**
   * L3 — rejected/total as fixed 4dp. Empty → null.
   */
  rejectedApplicationRatio(): string | null {
    const total = this.rows.size;
    if (total === 0) return null;
    return (this.rejectedCount() / total).toFixed(4);
  }

  /**
   * L3 — sorted cohort slugs that appear in any application. Empty → [].
   */
  knownCohortSlugsSorted(): readonly string[] {
    const set = new Set<string>();
    for (const r of this.rows.values()) set.add(r.cohortSlug);
    return [...set].sort();
  }

  /** L3 — true when any application is accepted. Empty → false. */
  hasAcceptedApplication(): boolean {
    return this.acceptedCount() > 0;
  }

  /** L3 — true when any application is rejected. Empty → false. */
  hasRejectedApplication(): boolean {
    return this.rejectedCount() > 0;
  }

  /**
   * L3 — withdrawn/total as fixed 4dp. Empty → null.
   */
  withdrawnApplicationRatio(): string | null {
    const total = this.rows.size;
    if (total === 0) return null;
    return (this.withdrawnCount() / total).toFixed(4);
  }

  /**
   * L3 — decided count (accepted+rejected+withdrawn). Empty → 0.
   */
  decidedApplicationCount(): number {
    return this.acceptedCount() + this.rejectedCount() + this.withdrawnCount();
  }

  /** L3 — true when any application is withdrawn. Empty → false. */
  hasWithdrawnApplication(): boolean {
    return this.withdrawnCount() > 0;
  }

  /**
   * L3 — decided/total as fixed 4dp. Empty → null.
   */
  decidedApplicationRatio(): string | null {
    const total = this.rows.size;
    if (total === 0) return null;
    return (this.decidedApplicationCount() / total).toFixed(4);
  }

  /** L3 — true when desk has only applied (no decisions yet). Empty → false. */
  isAllOpen(): boolean {
    return this.rows.size > 0 && this.openCount() === this.rows.size;
  }

  /** L3 — first open application id (sorted). None → null. */
  firstOpenApplicationId(): string | null {
    const ids = this.openApplicationIds();
    return ids[0] ?? null;
  }

  /** L3 — true when desk has only decided apps (no open). Empty → false. */
  isAllDecided(): boolean {
    return this.rows.size > 0 && this.openCount() === 0;
  }

  /** L3 — first accepted application id (sorted). None → null. */
  firstAcceptedApplicationId(): string | null {
    const ids = this.acceptedApplicationIds();
    return ids[0] ?? null;
  }

  /** L3 — first rejected application id (sorted). None → null. */
  firstRejectedApplicationId(): string | null {
    const ids = this.rejectedApplicationIds();
    return ids[0] ?? null;
  }

  /** L3 — cohort count with any application. Empty → 0. */
  cohortCount(): number {
    return this.knownCohortSlugsSorted().length;
  }

  /** L3 — last open application id (sorted last). None → null. */
  lastOpenApplicationId(): string | null {
    const ids = this.openApplicationIds();
    return ids.length ? ids[ids.length - 1]! : null;
  }

  /** L3 — last accepted application id. None → null. */
  lastAcceptedApplicationId(): string | null {
    const ids = this.acceptedApplicationIds();
    return ids.length ? ids[ids.length - 1]! : null;
  }

  /** L3 — true when application count is at least n. */
  hasAtLeastApplications(n: number): boolean {
    if (!Number.isFinite(n) || n < 0) return false;
    return this.applicationCount() >= Math.floor(n);
  }

  /** L3 — open minus decided as signed int. Empty → 0. */
  openMinusDecided(): number {
    return this.openCount() - this.decidedApplicationCount();
  }

  /** L3 — application count label. */
  applicationCountLabel(): string {
    return String(this.applicationCount());
  }

  /** L3 — open count label. */
  openCountLabel(): string {
    return String(this.openCount());
  }

  /** L3 — true when open ratio is at least half. Empty → false. */
  isMajorityOpenOrTie(): boolean {
    const r = this.openApplicationRatio();
    if (r === null) return false;
    return Number(r) >= 0.5;
  }

  /** L3 — comma-joined open application ids. Empty → "". */
  openApplicationIdsJoined(): string {
    return this.openApplicationIds().join(',');
  }

  /** L3 — accepted ids joined. Empty → "". */
  acceptedApplicationIdsJoined(): string {
    return this.acceptedApplicationIds().join(',');
  }

  /** L3 — rejected ids joined. Empty → "". */
  rejectedApplicationIdsJoined(): string {
    return this.rejectedApplicationIds().join(',');
  }

  /** L3 — withdrawn ids joined. Empty → "". */
  withdrawnApplicationIdsJoined(): string {
    return this.withdrawnApplicationIds().join(',');
  }

  /** L3 — known cohorts joined. Empty → "". */
  knownCohortsJoined(): string {
    return this.knownCohortSlugsSorted().join(',');
  }

  /** L3 — open ratio label or empty. */
  openApplicationRatioLabel(): string {
    return this.openApplicationRatio() ?? '';
  }

  /** L3 — accepted ratio label or empty. */
  acceptedApplicationRatioLabel(): string {
    return this.acceptedApplicationRatio() ?? '';
  }

  /** L3 — rejected ratio label or empty. */
  rejectedApplicationRatioLabel(): string {
    return this.rejectedApplicationRatio() ?? '';
  }

  /** L3 — withdrawn ratio label or empty. */
  withdrawnApplicationRatioLabel(): string {
    return this.withdrawnApplicationRatio() ?? '';
  }

  /** L3 — status count snapshot. Empty zeros. */
  applicationStatusSnapshot(): {
    readonly open: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly withdrawn: number;
    readonly total: number;
  } {
    return {
      open: this.openCount(),
      accepted: this.acceptedCount(),
      rejected: this.rejectedCount(),
      withdrawn: this.withdrawnCount(),
      total: this.applicationCount(),
    };
  }

  /** L3 — true when snapshot parts sum to total. */
  applicationCountsConsistent(): boolean {
    const s = this.applicationStatusSnapshot();
    return s.total === s.open + s.accepted + s.rejected + s.withdrawn;
  }

  /** L3 — open share percent. Empty → null. */
  openSharePercent(): number | null {
    const r = this.openApplicationRatio();
    if (r === null) return null;
    return Math.round(Number(r) * 100);
  }

  /** L3 — decided share percent. Empty → null. */
  decidedSharePercent(): number | null {
    const r = this.decidedApplicationRatio();
    if (r === null) return null;
    return Math.round(Number(r) * 100);
  }

  /** L3 — operator queue headline. */
  residencyQueueHeadline(): {
    readonly total: number;
    readonly open: number;
    readonly decided: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly withdrawn: number;
    readonly empty: boolean;
  } {
    return {
      total: this.applicationCount(),
      open: this.openCount(),
      decided: this.decidedApplicationCount(),
      accepted: this.acceptedCount(),
      rejected: this.rejectedCount(),
      withdrawn: this.withdrawnCount(),
      empty: this.applicationCount() === 0,
    };
  }

  /** L3 — one application status for operator row (null if missing). */
  applicationStatusOf(id: string): 'applied' | 'accepted' | 'rejected' | 'withdrawn' | null {
    const row = this.rows.get(id);
    return row?.status ?? null;
  }

  /** L3 — true when application id is open. Missing → false. */
  isApplicationOpen(id: string): boolean {
    return this.applicationStatusOf(id) === 'applied';
  }

  /** L3 — true when application id is decided (not open). Missing → false. */
  isApplicationDecided(id: string): boolean {
    const s = this.applicationStatusOf(id);
    return s !== null && s !== 'applied';
  }

  /** L3 — filter application ids by status. Empty → []. */
  filterApplicationIdsByStatus(status: ResidencyStatus): readonly string[] {
    return [...this.rows.values()]
      .filter((r) => r.status === status)
      .map((r) => r.id)
      .sort();
  }

  /** L3 — search application ids by substring. Empty needle → []. */
  searchApplicationIds(needle: string): readonly string[] {
    const n = needle.trim();
    if (!n) return [];
    return [...this.rows.keys()].filter((id) => id.includes(n)).sort();
  }

  /** L3 — applications for cohort (all statuses). Empty → []. */
  listApplicationIdsForCohort(cohortSlug: string): readonly string[] {
    const slug = cohortSlug.trim().toLowerCase();
    if (!slug) return [];
    return [...this.rows.values()]
      .filter((r) => r.cohortSlug === slug)
      .map((r) => r.id)
      .sort();
  }

  /** L3 — open queue depth for cohort. Missing cohort → 0. */
  openCountForCohort(cohortSlug: string): number {
    const slug = cohortSlug.trim().toLowerCase();
    if (!slug) return 0;
    return this.listOpen(slug).length;
  }

  /** L3 — page open application ids. Limit must be published. Empty → []. */
  pageOpenApplicationIds(options: { offset?: number; limit?: number } = {}): readonly string[] {
    const all = this.openApplicationIds();
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = assertResidencyPageLimit(options.limit);
    return all.slice(offset, offset + limit);
  }

  /** L3 — page accepted application ids. Limit must be published. Empty → []. */
  pageAcceptedApplicationIds(options: { offset?: number; limit?: number } = {}): readonly string[] {
    const all = this.acceptedApplicationIds();
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = assertResidencyPageLimit(options.limit);
    return all.slice(offset, offset + limit);
  }

  /** L3 — page all application ids (sorted). Limit must be published. Empty → []. */
  pageAllApplicationIds(options: { offset?: number; limit?: number } = {}): readonly string[] {
    const all = [...this.rows.keys()].sort();
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = assertResidencyPageLimit(options.limit);
    return all.slice(offset, offset + limit);
  }

  /** L3 — open queue page count at pageSize. */
  openQueuePageCount(pageSize: number): number {
    if (!Number.isFinite(pageSize) || pageSize < 1) return 0;
    const n = this.openCount();
    if (n === 0) return 0;
    return Math.ceil(n / Math.floor(pageSize));
  }

  /** L3 — application ids only here vs other id list. */
  applicationIdsOnlyHere(otherIds: readonly string[]): readonly string[] {
    const other = new Set(otherIds);
    return [...this.rows.keys()].filter((id) => !other.has(id)).sort();
  }

  /** L3 — open ids only here vs other open list. */
  openIdsOnlyHere(otherOpenIds: readonly string[]): readonly string[] {
    const other = new Set(otherOpenIds);
    return this.openApplicationIds().filter((id) => !other.has(id));
  }

  /** L3 — true when open counts equal. */
  openCountEquals(otherOpenCount: number): boolean {
    return this.openCount() === otherOpenCount;
  }

  /** L3 — cohort set only here vs other cohorts. */
  cohortsOnlyHere(otherCohorts: readonly string[]): readonly string[] {
    const other = new Set(otherCohorts);
    return this.knownCohortSlugsSorted().filter((c) => !other.has(c));
  }

  /** L3 — safe page of open ids with clamped bounds. */
  safePageOpenApplicationIds(offset: number, limit: number): readonly string[] {
    if (!Number.isFinite(offset) || !Number.isFinite(limit)) return [];
    const all = this.openApplicationIds();
    const o = Math.max(0, Math.min(all.length, Math.floor(offset)));
    const l = Math.max(0, Math.min(all.length - o, Math.floor(limit)));
    return all.slice(o, o + l);
  }

  /** L3 — clamp open-queue page index. */
  clampOpenQueuePageIndex(pageIndex: number, pageSize: number): number {
    const pages = this.openQueuePageCount(pageSize);
    if (pages === 0) return 0;
    if (!Number.isFinite(pageIndex)) return 0;
    return Math.max(0, Math.min(pages - 1, Math.floor(pageIndex)));
  }

  /** L3 — open ids at clamped page. */
  openApplicationIdsAtPage(pageIndex: number, pageSize: number): readonly string[] {
    if (!Number.isFinite(pageSize) || pageSize < 1) return [];
    const idx = this.clampOpenQueuePageIndex(pageIndex, pageSize);
    const size = Math.floor(pageSize);
    return this.safePageOpenApplicationIds(idx * size, size);
  }

  /** L3 — true when open-queue page is valid. */
  isValidOpenQueuePage(pageIndex: number, pageSize: number): boolean {
    const pages = this.openQueuePageCount(pageSize);
    if (pages === 0) return false;
    if (!Number.isFinite(pageIndex)) return false;
    const i = Math.floor(pageIndex);
    return i >= 0 && i < pages;
  }

  /** L3 — export lines: id,status,cohort (sorted by id). Empty → []. */
  residencyExportLines(): readonly string[] {
    return [...this.rows.values()].map((r) => `${r.id},${r.status},${r.cohortSlug}`).sort();
  }

  /** L3 — residency export header. */
  residencyExportHeader(): string {
    return 'id,status,cohortSlug';
  }

  /** L3 — full residency export text. */
  residencyExportText(): string {
    return [this.residencyExportHeader(), ...this.residencyExportLines()].join('\n');
  }

  /** L3 — export line count including header. */
  residencyExportLineCount(): number {
    return 1 + this.applicationCount();
  }

  /**
   * L3 — parse "id,status,cohortSlug". Invalid → null.
   */
  parseResidencyExportLine(line: string): { readonly id: string; readonly status: ResidencyStatus; readonly cohortSlug: string } | null {
    const t = line.trim();
    if (!t || t === this.residencyExportHeader()) return null;
    const parts = t.split(',');
    if (parts.length !== 3) return null;
    const id = parts[0]!.trim();
    const status = parts[1]!.trim();
    const cohortSlug = parts[2]!.trim();
    if (!id || !cohortSlug) return null;
    if (status !== 'applied' && status !== 'accepted' && status !== 'rejected' && status !== 'withdrawn') return null;
    return { id, status, cohortSlug };
  }

  /** L3 — count valid residency export data lines. */
  countResidencyExportDataLines(text: string): number {
    return text
      .split('\n')
      .map((l) => this.parseResidencyExportLine(l))
      .filter((r) => r !== null).length;
  }

  /** L3 — true when export text has correct header first line. */
  residencyExportHasHeader(text: string): boolean {
    const first = text.split('\n')[0]?.trim() ?? '';
    return first === this.residencyExportHeader();
  }

  /** L3 — round-trip line count check. */
  residencyExportRoundTripOk(): boolean {
    return this.residencyExportLineCount() === 1 + this.countResidencyExportDataLines(this.residencyExportText());
  }

  /** L3 — one-line queue status. */
  residencyStatusLine(): string {
    const h = this.residencyQueueHeadline();
    return `open=${h.open} decided=${h.decided} total=${h.total}`;
  }

  /** L3 — true when queue status is empty. */
  residencyStatusLineIsEmpty(): boolean {
    return this.residencyStatusLine().endsWith('total=0');
  }

  /** L3 — status with accepted/rejected/withdrawn. */
  residencyStatusLineDetailed(): string {
    const h = this.residencyQueueHeadline();
    return `open=${h.open} accepted=${h.accepted} rejected=${h.rejected} withdrawn=${h.withdrawn} total=${h.total}`;
  }

  /** L3 — token count on detailed status line. */
  residencyStatusLineTokenCount(): number {
    return this.residencyStatusLineDetailed().split(/\s+/).filter(Boolean).length;
  }

  /** L3 — parse "open=N decided=M total=T". Invalid → null. */
  parseResidencyStatusLine(line: string): { readonly open: number; readonly decided: number; readonly total: number } | null {
    const m = line.trim().match(/^open=(\d+) decided=(\d+) total=(\d+)$/);
    if (!m) return null;
    return { open: Number(m[1]), decided: Number(m[2]), total: Number(m[3]) };
  }

  /** L3 — true when status line matches store. */
  residencyStatusLineMatchesStore(): boolean {
    const p = this.parseResidencyStatusLine(this.residencyStatusLine());
    if (!p) return false;
    return p.open === this.openCount() && p.decided === this.decidedApplicationCount() && p.total === this.applicationCount();
  }

  /** L3 — parse detailed residency status line. Invalid → null. */
  parseResidencyStatusLineDetailed(line: string): {
    readonly open: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly withdrawn: number;
    readonly total: number;
  } | null {
    const m = line.trim().match(/^open=(\d+) accepted=(\d+) rejected=(\d+) withdrawn=(\d+) total=(\d+)$/);
    if (!m) return null;
    return {
      open: Number(m[1]),
      accepted: Number(m[2]),
      rejected: Number(m[3]),
      withdrawn: Number(m[4]),
      total: Number(m[5]),
    };
  }

  /** L3 — true when detailed parts sum to total. */
  residencyStatusLineDetailedConsistent(line: string): boolean {
    const p = this.parseResidencyStatusLineDetailed(line);
    if (!p) return false;
    return p.total === p.open + p.accepted + p.rejected + p.withdrawn;
  }

  /** L3 — true when open count is within [min,max]. Invalid → false. */
  openCountInRange(min: number, max: number): boolean {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
    const n = this.openCount();
    return n >= min && n <= max;
  }

  /** L3 — true when open share percent is at least threshold. Empty → false. */
  openShareAtLeast(percent: number): boolean {
    if (!Number.isFinite(percent)) return false;
    const p = this.openSharePercent();
    return p !== null && p >= percent;
  }

  /** L3 — clamp open-queue page size into [1, openCount] (empty → 1). */
  clampOpenQueuePageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize)) return 1;
    const total = Math.max(1, this.openCount());
    return Math.max(1, Math.min(total, Math.floor(pageSize)));
  }

  /** L3 — true when application density exceeds threshold. */
  applicationDensityExceeds(n: number): boolean {
    if (!Number.isFinite(n)) return false;
    return this.applicationCount() > n;
  }
}
