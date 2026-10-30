/**
 * Appeals against a restriction staff set (I-account-lifecycle-12, J-identity-14 #3 and #4).
 *
 * The person files one appeal per restriction at a time, inside the owner's window after the restriction started
 * (`IDENTITY_APPEAL_WINDOW_DAYS`; unset closes appeals). Compliance decides it with a code from the owner's decision
 * reason list (`IDENTITY_APPEAL_DECISION_REASONS`), never as the person who set the restriction. Lifting releases the
 * restriction through the founder control (`accountControls.change`), with a request key derived from the appeal and
 * the restore reason `appeal:<id>`, which the lift's four-eyes approval binds. Upholding changes only the appeal.
 *
 * Crash safety: a lift runs the control first, then moves the appeal by compare-and-set. If it crashes between the two,
 * the same decision again replays the control's stored result (same request key, same fingerprint) and then moves the
 * appeal, so the restriction is never lifted twice and an appeal never reads lifted while the restriction holds.
 * Every decision queues one notice to the account's proved address in the transaction that records it.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
  appealLiftReason,
  type AccountControlResult,
  type Appeal,
  type AppealDecideInput,
  type AppealForStaff,
  type AppealsMine,
  type AppealRestriction,
  type AppealSubmitInput,
  type Context,
  type IdentityAccountControlInput,
} from '@intafaced/contracts';
import type { KycRejectReasons } from '../kyc/cases.js';

export type AppealErrorCode =
  | 'identity.appeal_window_unset'
  | 'identity.appeal_window_closed'
  | 'identity.appeal_no_restriction'
  | 'identity.appeal_open'
  | 'identity.appeal_request_conflict'
  | 'identity.appeal_not_allowed'
  | 'identity.appeal_sign_in'
  | 'identity.appeal_reasons_unset'
  | 'identity.appeal_reason_unlisted'
  | 'identity.appeal_not_found'
  | 'identity.appeal_decided'
  | 'identity.appeal_version_conflict'
  | 'identity.appeal_decider_restricted'
  | 'identity.appeal_restriction_changed'
  | 'identity.appeal_lift_refused'
  | 'identity.appeal_lift_unconfigured';

export class AppealError extends Error {
  constructor(
    readonly code: AppealErrorCode,
    /** For `identity.appeal_lift_refused`: the founder control's own refusal code. */
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AppealError';
  }
}

interface AppealRow {
  id: string;
  user_id: string;
  restriction: AppealRestriction;
  restriction_ref: string;
  restricted_by: string | null;
  restriction_approved_by: string | null;
  client_request_id: string;
  text: string;
  status: Appeal['status'];
  decision_reason_code: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  version: string;
  created_at: Date;
}

export interface AppealControls {
  change(context: Context, input: IdentityAccountControlInput): Promise<AccountControlResult>;
}

export interface AppealOptions {
  /** The owner's appeal window in whole days; undefined when unset, and then no appeal can be filed. */
  readonly windowDays: number | undefined;
  /** The owner's decision reason list; empty when unset, and then no appeal can be decided. */
  readonly decisionReasons: KycRejectReasons;
  /** The founder control a lift runs through; undefined when the trading restriction is not wired. */
  readonly controls: AppealControls | undefined;
}

const OPEN = ['submitted', 'in_review'] as const;
const COLUMNS =
  'id, user_id, restriction, restriction_ref, restricted_by, restriction_approved_by, client_request_id, text, status, decision_reason_code, decided_by, decided_at, version::text, created_at';
const DAY_MS = 86_400_000;

/**
 * The request id a lift sends the founder control: fixed per appeal and approval, so a retried decision replays the same
 * change, and a lift the control refused (a stale or mismatched approval) never blocks a later one with a fresh approval.
 */
export function appealLiftRequestId(appealId: string, approvalId: string): string {
  const h = createHash('sha256').update(`appeal-lift:${appealId.toLowerCase()}:${approvalId}`).digest('hex');
  // A version-5-shaped UUID from the hash: the control's request id is a UUID.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** The founder control area each appealable restriction lives in, and the prefix of its `restriction_ref`. */
const AREA: Readonly<Record<AppealRestriction, 'trading' | 'identity'>> = { trading_restricted: 'trading', staff_freeze: 'identity' };
const REF_PREFIX: Readonly<Record<AppealRestriction, string>> = { trading_restricted: 'trading', staff_freeze: 'staff_freeze' };

/**
 * The restriction as it stands, its row locked: whether it holds, its version, when its row was last written and the
 * database clock. A trading restriction is its own row; a staff freeze is the account's status and control version.
 */
async function heldNow(
  tx: Sql | TransactionSql,
  userId: string,
  restriction: AppealRestriction,
): Promise<{ restricted: boolean; version: string; since: Date; now: Date }> {
  const [row] =
    restriction === 'trading_restricted'
      ? await tx<Array<{ restricted: boolean; version: string; since: Date; now: Date }>>`
          SELECT restricted, version::text, updated_at AS since, clock_timestamp() AS now
          FROM trading_restrictions WHERE user_id = ${userId} FOR UPDATE`
      : await tx<Array<{ restricted: boolean; version: string; since: Date; now: Date }>>`
          SELECT status = 'frozen' AS restricted, identity_control_version::text AS version, updated_at AS since,
            clock_timestamp() AS now
          FROM users WHERE id = ${userId} FOR UPDATE`;
  return row ?? { restricted: false, version: '0', since: new Date(0), now: new Date() };
}

/** The restriction's version an appeal names, from its `restriction_ref`. */
function refVersion(ref: string): string {
  return ref.slice(ref.indexOf(':') + 1);
}

export class AccountAppeals {
  constructor(
    private readonly sql: Sql,
    private readonly options: AppealOptions,
  ) {}

  private present(row: AppealRow): Appeal {
    const decided = row.status === 'lifted' || row.status === 'upheld';
    const words = row.decision_reason_code ? this.options.decisionReasons.get(row.decision_reason_code) : undefined;
    return {
      id: row.id,
      restriction: row.restriction,
      status: row.status,
      text: row.text,
      submittedAt: row.created_at.toISOString(),
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      decision:
        decided && row.decision_reason_code
          ? {
              outcome: row.status as 'lifted' | 'upheld',
              reason: { code: row.decision_reason_code, text: words?.reason ?? null, guidance: words?.guidance ?? null },
            }
          : null,
      version: row.version,
    };
  }

  private presentForStaff(row: AppealRow): AppealForStaff {
    return { ...this.present(row), userId: row.user_id, restrictedBy: row.restricted_by, decidedBy: row.decided_by };
  }

  /** The owner's window, and every appeal this person filed, newest first. */
  async mine(userId: string): Promise<AppealsMine> {
    const rows = await this.sql<AppealRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
      FROM account_appeals WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 50`;
    return { windowDays: this.options.windowDays ?? null, appeals: rows.map((r) => this.present(r)) };
  }

  /** Open appeals, oldest first, for compliance. */
  async queue(limit: number): Promise<AppealForStaff[]> {
    const rows = await this.sql<AppealRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
      FROM account_appeals WHERE status IN ${this.sql(OPEN)} ORDER BY created_at ASC, id ASC LIMIT ${limit}`;
    return rows.map((r) => this.presentForStaff(r));
  }

  /** A signed-in person's appeal: the trading restriction, from the account status page. */
  async submit(userId: string, input: AppealSubmitInput): Promise<Appeal> {
    if (input.restriction !== 'trading_restricted') throw new AppealError('identity.appeal_no_restriction');
    return this.file(userId, 'trading_restricted', input.text, input.clientRequestId);
  }

  /**
   * A staff-frozen person's appeal, filed signed out once the sign-in name and password proved the account (the caller's
   * part, `AuthService.proveAppellant`). It names the staff freeze. An active account signs in and appeals there; a
   * closed one is refused, because identity keeps no flag that says a closure is final or open to appeal.
   */
  async submitSignedOut(
    proved: { userId: string; status: 'active' | 'frozen' | 'closed' },
    input: Pick<AppealSubmitInput, 'text' | 'clientRequestId'>,
  ): Promise<Appeal> {
    if (proved.status === 'active') throw new AppealError('identity.appeal_sign_in');
    if (proved.status === 'closed') throw new AppealError('identity.appeal_not_allowed');
    return this.file(proved.userId, 'staff_freeze', input.text, input.clientRequestId);
  }

  /**
   * File an appeal. Order: the owner's window must be set; a repeat of the same request returns the appeal it made; the
   * restriction must hold and have started inside the window; no other appeal may be open for it.
   */
  private async file(userId: string, restriction: AppealRestriction, text: string, clientRequestId: string): Promise<Appeal> {
    const windowDays = this.options.windowDays;
    if (windowDays === undefined) throw new AppealError('identity.appeal_window_unset');
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const [again] = await tx<AppealRow[]>`
        SELECT ${tx.unsafe(COLUMNS)}
        FROM account_appeals WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}`;
      if (again) {
        if (again.restriction !== restriction || again.text !== text) throw new AppealError('identity.appeal_request_conflict');
        return this.present(again);
      }
      const held = await heldNow(tx, userId, restriction);
      if (!held.restricted) throw new AppealError('identity.appeal_no_restriction');
      const setBy = await restrictionSetBy(tx, userId, restriction, held.version);
      // The window runs from when the restriction was set (its audit row); a later no-op write does not restart it.
      const since = setBy.at ?? held.since;
      if (held.now.getTime() > since.getTime() + windowDays * DAY_MS) throw new AppealError('identity.appeal_window_closed');
      const ref = `${REF_PREFIX[restriction]}:${held.version}`;
      const [open] = await tx<Array<{ id: string }>>`
        SELECT id FROM account_appeals WHERE user_id = ${userId} AND restriction_ref = ${ref} AND status IN ${tx(OPEN)}`;
      if (open) throw new AppealError('identity.appeal_open');
      const [row] = await tx<AppealRow[]>`
        INSERT INTO account_appeals (user_id, restriction, restriction_ref, restricted_by, restriction_approved_by, client_request_id, text)
        VALUES (${userId}, ${restriction}, ${ref}, ${setBy.actor}, ${setBy.approver}, ${clientRequestId}, ${text})
        RETURNING ${tx.unsafe(COLUMNS)}`;
      await tx`INSERT INTO account_appeal_events (appeal_id, status, actor_id) VALUES (${row!.id}, 'submitted', ${userId})`;
      return this.present(row!);
    });
  }

  /**
   * Decide an open appeal. Order, before anything changes: the reason list is set and holds the code; the appeal is open
   * at the version read; the decider is neither the account holder nor anyone who set the restriction (who ran it or
   * approved it). A repeat of a decision already recorded by the same person with the same outcome and code returns it
   * unchanged. The appeal row stays locked for the whole decision, the lift's control call included, so a lift and an
   * uphold of one appeal never interleave.
   */
  async decide(context: Context, input: AppealDecideInput): Promise<AppealForStaff> {
    const deciderId = context.principal!.userId.toLowerCase();
    if (this.options.decisionReasons.size === 0) throw new AppealError('identity.appeal_reasons_unset');
    if (!this.options.decisionReasons.has(input.reasonCode)) throw new AppealError('identity.appeal_reason_unlisted');
    const outcome = input.decision === 'lift' ? 'lifted' : 'upheld';
    return this.sql.begin(async (tx) => {
      const row = await this.read(tx, input.appealId, true);
      const again = this.settledRepeat(row, deciderId, outcome, input.reasonCode);
      if (again) return again;
      this.assertDecidable(row, deciderId, input);
      if (input.decision === 'lift') {
        if (input.restrictionVersion !== refVersion(row.restriction_ref)) throw new AppealError('identity.appeal_restriction_changed');
        // A lift this appeal already ran (the process stopped before the appeal moved) is done: never run it twice.
        if (!(await liftedByAppeal(tx, row))) {
          const controls = this.options.controls;
          if (!controls) throw new AppealError('identity.appeal_lift_unconfigured');
          const result = await controls.change(context, {
            requestId: appealLiftRequestId(row.id, input.approvalId!),
            target: { area: AREA[row.restriction], userId: row.user_id },
            action: 'restore',
            reason: appealLiftReason(row.id),
            expectedVersion: input.restrictionVersion,
            approvalId: input.approvalId!,
          });
          const released = (result.outcome === 'changed' || result.outcome === 'noop') && result.after?.restricted === false;
          if (!released)
            throw new AppealError(
              'identity.appeal_lift_refused',
              result.outcome === 'refused' || result.outcome === 'conflict' ? result.code : result.outcome,
            );
        }
      } else {
        // An uphold names the restriction it upholds: one lifted or replaced since the appeal was filed is not this one.
        const held = await heldNow(tx, row.user_id, row.restriction);
        if (!held.restricted || held.version !== refVersion(row.restriction_ref))
          throw new AppealError('identity.appeal_restriction_changed');
      }
      const [done] = await tx<AppealRow[]>`
        UPDATE account_appeals SET status = ${outcome}, decision_reason_code = ${input.reasonCode}, decided_by = ${deciderId},
          decided_at = clock_timestamp(), version = version + 1
        WHERE id = ${row.id} AND version = ${row.version}::bigint
        RETURNING ${tx.unsafe(COLUMNS)}`;
      if (!done) throw new AppealError('identity.appeal_version_conflict');
      await tx`INSERT INTO account_appeal_events (appeal_id, status, actor_id, reason_code) VALUES (${done.id}, ${outcome}, ${deciderId}, ${input.reasonCode})`;
      await queueAppealDecidedNotice(tx, { userId: done.user_id, appealId: done.id, outcome, now: done.decided_at! });
      return this.presentForStaff(done);
    });
  }

  private async read(tx: Sql | TransactionSql, appealId: string, lock = false): Promise<AppealRow> {
    const id = appealId.toLowerCase();
    const [row] = lock
      ? await tx<AppealRow[]>`
          SELECT ${tx.unsafe(COLUMNS)}
          FROM account_appeals WHERE id = ${id} FOR UPDATE`
      : await tx<AppealRow[]>`
          SELECT ${tx.unsafe(COLUMNS)}
          FROM account_appeals WHERE id = ${id}`;
    if (!row) throw new AppealError('identity.appeal_not_found');
    return row;
  }

  private settledRepeat(row: AppealRow, deciderId: string, outcome: 'lifted' | 'upheld', reasonCode: string): AppealForStaff | null {
    return row.status === outcome && row.decided_by === deciderId && row.decision_reason_code === reasonCode
      ? this.presentForStaff(row)
      : null;
  }

  private assertDecidable(row: AppealRow, deciderId: string, input: AppealDecideInput): void {
    if (!(OPEN as readonly string[]).includes(row.status)) throw new AppealError('identity.appeal_decided');
    if (row.version !== input.expectedVersion) throw new AppealError('identity.appeal_version_conflict');
    const setters = [row.restricted_by, row.restriction_approved_by]
      .filter((id): id is string => id !== null)
      .map((id) => id.toLowerCase());
    if (deciderId === row.user_id || setters.includes(deciderId)) throw new AppealError('identity.appeal_decider_restricted');
  }
}

/**
 * Who set the trading restriction now in force, and when: the founder control change that set it at this version, its
 * actor and its four-eyes approver. Null fields when identity keeps no such row (a restriction set before the audit named
 * it): the decision then still refuses the account holder, and the window runs from the row's last write.
 */
async function restrictionSetBy(
  tx: Sql | TransactionSql,
  userId: string,
  restriction: AppealRestriction,
  version: string,
): Promise<{ actor: string | null; approver: string | null; at: Date | null }> {
  const [row] = await tx<Array<{ actor_id: string | null; approver: string | null; at: Date }>>`
    SELECT actor_id, result->>'approverUserId' AS approver, created_at AS at FROM founder_control_audit
    WHERE result->'target'->>'area' = ${AREA[restriction]} AND result->>'outcome' = 'changed'
      AND result->'target'->>'userId' = ${userId} AND result->'after'->>'restricted' = 'true'
      AND result->'after'->>'version' = ${version}
    ORDER BY created_at DESC LIMIT 1`;
  return { actor: row?.actor_id ?? null, approver: row?.approver ?? null, at: row?.at ?? null };
}

/** Whether a founder control change already released this appeal's restriction with the appeal as its reason. */
async function liftedByAppeal(tx: TransactionSql, row: AppealRow): Promise<boolean> {
  const [found] = await tx<Array<{ audit_id: string }>>`
    SELECT audit_id FROM founder_control_audit
    WHERE result->'target'->>'area' = ${AREA[row.restriction]} AND result->>'outcome' = 'changed'
      AND result->'target'->>'userId' = ${row.user_id} AND result->'after'->>'restricted' = 'false'
      AND result->>'reason' = ${appealLiftReason(row.id)}
    LIMIT 1`;
  return found !== undefined;
}

/**
 * "Your appeal was decided": one notice per decision to the account's proved address, keyed by the appeal (an appeal is
 * decided once). It names the outcome only; the reason's words are on the account status page.
 */
async function queueAppealDecidedNotice(
  tx: TransactionSql,
  input: { userId: string; appealId: string; outcome: 'lifted' | 'upheld'; now: Date },
): Promise<void> {
  const [user] = await tx<Array<{ email: string | null; email_verified_at: Date | null }>>`
    SELECT email, email_verified_at FROM users WHERE id = ${input.userId}`;
  if (!user?.email || !user.email_verified_at) return;
  const key = `appeal-decided:${input.appealId}`;
  await tx`
    INSERT INTO mail_outbox (flow_id, user_id, dedupe_key, body_hash, purpose, recipient, code, detail, expires_at, status, created_at)
    VALUES (
      NULL, ${input.userId}, ${key}, ${createHash('sha256').update(key).digest('hex')}, 'appeal-decided',
      ${user.email}, NULL, ${input.outcome}, ${input.now}, 'pending', ${input.now}
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

/** `IDENTITY_APPEAL_WINDOW_DAYS`: blank or unset is undefined (appeals closed); otherwise 1 to 3650 whole days. */
export function parseAppealWindowDays(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d{1,4}$/.test(raw.trim())) throw new Error('IDENTITY_APPEAL_WINDOW_DAYS must be whole days, 1 to 3650');
  const days = Number(raw.trim());
  if (days < 1 || days > 3650) throw new Error('IDENTITY_APPEAL_WINDOW_DAYS must be whole days, 1 to 3650');
  return days;
}
