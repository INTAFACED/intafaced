import { transaction } from '@intafaced/db';
import { envScreeningList, screeningMoneyGrade } from '@intafaced/config/screening';
import type { Sql } from 'postgres';
import { consumePayApproval, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { PAY_SCREENING_RELEASE, screeningReleaseFields } from '../approval-bindings.js';
import { requireDualControl } from '../dual-control.js';
import { applyListPosture, screeningCaseFromAnswer } from './decision.js';
import { ScreeningDeskError } from './desk-errors.js';
import type { CaseView, ListStatus } from './desk-schemas.js';
import * as store from './desk-store.js';
import { answerFrom, listPostureOf, type ScreeningScreener } from './guard.js';
import type { ScreeningSubjectKind } from './store.js';

export interface ScreeningDeskDeps {
  readonly sql: Sql;
  readonly approvals: ActionApprovalConsumer;
  /** Omitted in production: no supplier is connected, so a rescreen answers `unavailable`. */
  readonly screener?: ScreeningScreener;
  readonly providerLabel?: string;
  readonly timeoutMs?: number;
  /** Owner-set life of a release. Unset: a release is refused, never given a default life. */
  readonly releaseTtlSeconds?: number | null;
  readonly listPosture?: 'blank' | 'named';
  readonly env?: Record<string, string | undefined>;
}

const noSupplier: ScreeningScreener = async () => null;

/**
 * The compliance desk over screening cases (W-compliance-notices-02): read a case, uphold it, release it, rescreen it.
 *
 * A RELEASE NEVER REWRITES THE REJECTED SEND. It records that a person decided, and the guard spends it ONCE on a new
 * withdrawal key (store.spendRelease). The original case keeps its status. A `refuse` case can only be upheld. A blank
 * sanctions list refuses a release: the list is the one thing a person cannot argue past. A release needs a second person
 * (identity approval bound to this case and reason) and an owner-set time-to-live.
 */
export class ScreeningDeskService {
  private readonly screener: ScreeningScreener;

  constructor(private readonly deps: ScreeningDeskDeps) {
    this.screener = deps.screener ?? noSupplier;
  }

  async list(q: {
    limit: number;
    status?: string;
    subjectKind?: string;
    cursor?: string;
  }): Promise<{ rows: CaseView[]; nextCursor: string | null }> {
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await store.listCases(this.deps.sql, { limit: q.limit + 1, status: q.status, kind: q.subjectKind, after });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      rows: page.map(store.caseView),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.updated_at, last.subject_key) : null,
    };
  }

  async get(kind: ScreeningSubjectKind, key: string): Promise<{ case: CaseView; events: ReturnType<typeof eventView>[] }> {
    const row = await store.getCase(this.deps.sql, kind, key);
    if (!row) throw new ScreeningDeskError('screening.case_not_found', 'no such screening case');
    return { case: store.caseView(row), events: (await store.listEvents(this.deps.sql, kind, key)).map(eventView) };
  }

  /** What the list and the supplier look like to the guard right now. Never returns list contents. */
  listStatus(): ListStatus {
    const list = envScreeningList(this.deps.env ?? process.env);
    return {
      posture: this.posture(),
      grade: screeningMoneyGrade(list),
      regionCount: list.regions.length,
      supplier: this.deps.screener ? 'connected' : 'none',
      releaseTtlSeconds: this.ttl(),
    };
  }

  async decide(
    actorId: string,
    input: {
      subjectKind: ScreeningSubjectKind;
      caseId: string;
      decision: 'release' | 'uphold';
      reason: string;
      approvalId?: string | null | undefined;
      operationId?: string | null | undefined;
    },
  ): Promise<CaseView> {
    const head = await this.readUndecided(input.subjectKind, input.caseId);
    if (head.status === 'clear') throw new ScreeningDeskError('screening.case_clear', 'a clear case has nothing to decide');
    let approverId: string | null = null;
    let expires: Date | null = null;
    if (input.decision === 'release') {
      this.assertReleasable(head);
      const ttl = this.ttl();
      if (ttl === null) throw new ScreeningDeskError('screening.release_ttl_unset', 'the owner has not set how long a release lasts');
      expires = new Date(Date.now() + ttl * 1000);
      const approver = await consumePayApproval(
        this.deps.approvals,
        input,
        PAY_SCREENING_RELEASE,
        screeningReleaseFields({ subjectKind: input.subjectKind, caseId: input.caseId, reason: input.reason }),
      );
      approverId = requireDualControl(actorId.toLowerCase(), approver.trim().toLowerCase());
    }
    return transaction(this.deps.sql, async (tx) => {
      const row = await store.getCase(tx, input.subjectKind, input.caseId, true);
      if (!row) throw new ScreeningDeskError('screening.case_not_found', 'no such screening case');
      if (row.decision !== null) throw new ScreeningDeskError('screening.case_decided', 'a person already decided this case');
      if (row.status !== head.status)
        throw new ScreeningDeskError('screening.case_decided', 'the case changed while it was being decided; reload');
      const decision = input.decision === 'release' ? 'released' : 'upheld';
      await store.writeDecision(tx, {
        kind: input.subjectKind,
        key: input.caseId,
        decision,
        actorId,
        approverId,
        reason: input.reason,
        releaseExpiresAt: expires,
      });
      await store.appendEvent(tx, {
        kind: input.subjectKind,
        key: input.caseId,
        action: input.decision,
        actorId,
        approverId,
        from: row.status,
        to: row.status,
        decision,
        reason: input.reason,
      });
      return store.caseView((await store.getCase(tx, input.subjectKind, input.caseId)) as store.CaseRow);
    });
  }

  /**
   * Ask the supplier again and write the answer on the case. It changes what the desk SEES, never what is allowed: a clear
   * answer releases nothing. A decided case is final.
   */
  async rescreen(actorId: string, input: { subjectKind: ScreeningSubjectKind; caseId: string; reason: string }): Promise<CaseView> {
    const head = await this.readUndecided(input.subjectKind, input.caseId);
    if (head.party_ref === null || head.amount === null || head.asset_id === null) {
      throw new ScreeningDeskError('screening.case_context_missing', 'this case predates the desk and does not say who it was for');
    }
    const answer = await answerFrom(this.screener, this.deps.timeoutMs ?? 5_000, {
      kind: input.subjectKind,
      partyRef: head.party_ref,
      assetId: head.asset_id,
      amount: head.amount,
    });
    const decision = applyListPosture(screeningCaseFromAnswer(answer), this.posture());
    return transaction(this.deps.sql, async (tx) => {
      const row = await store.getCase(tx, input.subjectKind, input.caseId, true);
      if (!row) throw new ScreeningDeskError('screening.case_not_found', 'no such screening case');
      if (row.decision !== null) throw new ScreeningDeskError('screening.case_decided', 'a person already decided this case');
      await store.writeRescreen(tx, {
        kind: input.subjectKind,
        key: input.caseId,
        status: decision.status,
        factors: decision.factors,
        provider: this.deps.providerLabel ?? 'none',
      });
      await store.appendEvent(tx, {
        kind: input.subjectKind,
        key: input.caseId,
        action: 'rescreen',
        actorId,
        approverId: null,
        from: row.status,
        to: decision.status,
        decision: null,
        reason: input.reason,
      });
      return store.caseView((await store.getCase(tx, input.subjectKind, input.caseId)) as store.CaseRow);
    });
  }

  private posture(): 'blank' | 'named' {
    return listPostureOf({ listPosture: this.deps.listPosture, env: this.deps.env });
  }

  private ttl(): number | null {
    const t = this.deps.releaseTtlSeconds;
    return typeof t === 'number' && Number.isInteger(t) && t > 0 ? t : null;
  }

  private async readUndecided(kind: ScreeningSubjectKind, key: string): Promise<store.CaseRow> {
    const row = await store.getCase(this.deps.sql, kind, key);
    if (!row) throw new ScreeningDeskError('screening.case_not_found', 'no such screening case');
    if (row.decision !== null) throw new ScreeningDeskError('screening.case_decided', 'a person already decided this case');
    return row;
  }

  private assertReleasable(row: store.CaseRow): void {
    if (row.status === 'refuse') {
      throw new ScreeningDeskError('screening.release_not_allowed', 'a refused case can only be upheld');
    }
    if (this.posture() === 'blank' || row.factors.some((f) => f.code === 'blank_list')) {
      throw new ScreeningDeskError(
        'screening.release_blocked_blank_list',
        'no sanctions list is configured; nothing can be released past it',
      );
    }
    if (row.subject_kind !== 'withdrawal') {
      throw new ScreeningDeskError('screening.release_unsupported_kind', 'only a withdrawal can be released today');
    }
    if (row.party_ref === null || row.amount === null || row.asset_id === null) {
      throw new ScreeningDeskError('screening.case_context_missing', 'this case predates the desk and does not say who it was for');
    }
  }
}

const eventView = (e: store.EventRow) => ({
  id: e.id,
  seq: String(e.seq),
  action: e.action,
  actorId: e.actor_id,
  approverId: e.approver_id,
  fromStatus: e.from_status,
  toStatus: e.to_status,
  reason: e.reason,
  createdAt: e.created_at.toISOString(),
});

const encodeCursor = (at: Date, key: string) => Buffer.from(`${at.toISOString()}|${key}`).toString('base64url');
function decodeCursor(raw: string): { at: Date; key: string } | undefined {
  const [iso, key] = Buffer.from(raw, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');
  return iso && key && !Number.isNaN(at.getTime()) && /^[a-f0-9]{64}$/.test(key) ? { at, key } : undefined;
}
