/**
 * "My account is compromised" (I-signin-sessions-28, J-identity-13 #3 to #5). The shapes and the refusals are in
 * `@intafaced/contracts/identity-compromise`. Identity keeps the case: it moves no money and reads no other service.
 *
 * `openCompromiseCase` runs inside the caller's transaction, after the password check: it ends every session and API
 * key, sets the owner's own freeze (`applySelfFreeze`, reason `compromise`) and opens the case, all or nothing, so a
 * crash never leaves keys revoked with no freeze, or a freeze with no case. It is idempotent on the open case: while one
 * is open it returns that case and ends nothing more.
 */
import type { Sql } from 'postgres';
import {
  COMPROMISE_CHECKLIST_ITEMS,
  type CompromiseCase,
  type CompromiseChecklistItem,
  type CompromiseReviewItem,
} from '@intafaced/contracts/identity-compromise';
import { applySelfFreeze } from '../auth/freeze-link.js';

export const COMPROMISE_NO_CASE = 'identity.compromise_no_case';

export class CompromiseError extends Error {
  constructor(readonly code: typeof COMPROMISE_NO_CASE) {
    super('There is no open compromised-account case on this account.');
    this.name = 'CompromiseError';
  }
}

type CaseRow = { id: string; opened_at: Date; sessions_ended: number; keys_ended: number };

export type OpenedCase = { caseId: string; openedAt: Date; changed: boolean; sessionsEnded: number };

/** Opens the case, or returns the open one. Call inside a transaction that already checked the password. */
export async function openCompromiseCase(tx: Sql, userId: string): Promise<OpenedCase> {
  await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  const open = await tx<CaseRow[]>`
    SELECT id, opened_at, sessions_ended, keys_ended FROM compromise_cases WHERE user_id = ${userId} AND state = 'open'`;
  if (open[0]) return { caseId: open[0].id, openedAt: open[0].opened_at, changed: false, sessionsEnded: 0 };
  // Counted here, before the freeze, so the case says what this press ended even when a freeze was already open.
  const sessions = await tx<Array<{ id: string }>>`
    UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false RETURNING id`;
  const keys = await tx<Array<{ id: string }>>`
    UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze'
    WHERE user_id = ${userId} AND revoked = false RETURNING id`;
  const freeze = await applySelfFreeze(tx, userId, 'compromise');
  const made = await tx<Array<{ id: string; opened_at: Date }>>`
    INSERT INTO compromise_cases (user_id, freeze_id, sessions_ended, keys_ended)
    VALUES (${userId}, ${freeze.id}, ${sessions.length}, ${keys.length})
    RETURNING id, opened_at`;
  return { caseId: made[0]!.id, openedAt: made[0]!.opened_at, changed: true, sessionsEnded: sessions.length };
}

async function openCase(sql: Sql, userId: string): Promise<CaseRow | null> {
  const rows = await sql<CaseRow[]>`
    SELECT id, opened_at, sessions_ended, keys_ended FROM compromise_cases WHERE user_id = ${userId} AND state = 'open'`;
  return rows[0] ?? null;
}

/** The person's open case with its checklist and notes, or null. */
export async function readCompromiseCase(sql: Sql, userId: string): Promise<CompromiseCase | null> {
  const row = await openCase(sql, userId);
  if (!row) return null;
  // What identity saw after the case opened: the first password change, the first other sign-in method change.
  const [seen] = await sql<Array<{ password: Date | null; second_factor: Date | null }>>`
    SELECT
      min(changed_at) FILTER (WHERE change = 'password_changed') AS password,
      min(changed_at) FILTER (WHERE change <> 'password_changed') AS second_factor
    FROM security_factor_events WHERE user_id = ${userId} AND changed_at >= ${row.opened_at}`;
  const reviews = await sql<Array<{ item: CompromiseReviewItem; reviewed_at: Date }>>`
    SELECT item, reviewed_at FROM compromise_case_reviews WHERE case_id = ${row.id}`;
  const done: Record<CompromiseChecklistItem, Date | null> = {
    password: seen?.password ?? null,
    second_factor: seen?.second_factor ?? null,
    devices: null,
    // Every key ended when the case opened.
    api_keys: row.opened_at,
    addresses: null,
  };
  for (const review of reviews) done[review.item] = review.reviewed_at;
  const notes = await sql<Array<{ id: string; kind: 'stolen_funds'; body: string; created_at: Date }>>`
    SELECT id, kind, body, created_at FROM compromise_case_notes WHERE case_id = ${row.id} ORDER BY created_at, id`;
  return {
    id: row.id,
    openedAt: row.opened_at.toISOString(),
    sessionsEnded: row.sessions_ended,
    keysEnded: row.keys_ended,
    checklist: COMPROMISE_CHECKLIST_ITEMS.map((item) => ({ item, doneAt: done[item]?.toISOString() ?? null })),
    notes: notes.map((note) => ({ id: note.id, kind: note.kind, body: note.body, createdAt: note.created_at.toISOString() })),
  };
}

/** A stolen-funds report as a note on the open case. The same request id answers the first note. Moves no money. */
export async function reportStolenFunds(
  sql: Sql,
  input: { userId: string; body: string; clientRequestId: string },
): Promise<{ noteId: string; changed: boolean }> {
  const row = await openCase(sql, input.userId);
  if (!row) throw new CompromiseError(COMPROMISE_NO_CASE);
  const made = await sql<Array<{ id: string }>>`
    INSERT INTO compromise_case_notes (case_id, user_id, kind, body, client_request_id)
    VALUES (${row.id}, ${input.userId}, 'stolen_funds', ${input.body}, ${input.clientRequestId})
    ON CONFLICT (case_id, client_request_id) DO NOTHING
    RETURNING id`;
  if (made[0]) return { noteId: made[0].id, changed: true };
  const first = await sql<Array<{ id: string }>>`
    SELECT id FROM compromise_case_notes WHERE case_id = ${row.id} AND client_request_id = ${input.clientRequestId}`;
  return { noteId: first[0]!.id, changed: false };
}

/** The person reviewed their devices or addresses while the case is open. The first review's time stands. */
export async function markCompromiseReviewed(
  sql: Sql,
  input: { userId: string; item: CompromiseReviewItem },
): Promise<{ item: CompromiseReviewItem; reviewedAt: Date }> {
  const row = await openCase(sql, input.userId);
  if (!row) throw new CompromiseError(COMPROMISE_NO_CASE);
  await sql`
    INSERT INTO compromise_case_reviews (case_id, item) VALUES (${row.id}, ${input.item})
    ON CONFLICT (case_id, item) DO NOTHING`;
  const [held] = await sql<Array<{ reviewed_at: Date }>>`
    SELECT reviewed_at FROM compromise_case_reviews WHERE case_id = ${row.id} AND item = ${input.item}`;
  return { item: input.item, reviewedAt: held!.reviewed_at };
}
