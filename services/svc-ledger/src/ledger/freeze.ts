import type { Sql, TransactionSql } from 'postgres';
import { LedgerError } from '@intafaced/ledger-client';
import { DualControlError, dualControlRefuse, MISSING_OPERATOR } from './dual-control.js';

/** Pool handle, or the client `sql.begin` passes. Both run the freeze SQL. */
type FreezeDb = Sql | TransactionSql;

/**
 * THE KILL-SWITCH, in the database.
 *
 * §4.2 requires that a book we cannot verify stops accepting writes. That
 * requirement was previously met by a `boolean` field on LedgerService, which
 * met it only for as long as the process lived and only for that one process.
 * A freeze is a fact about the LEDGER, not about a server, so it lives with the
 * ledger.
 *
 * The row is a singleton, like `chain_tip`, and for the same reason: the state
 * is global, and two rows would raise the question of which one is true.
 */

export interface FreezeState {
  readonly frozen: boolean;
  /** Why it is frozen. Null exactly when `frozen` is false. */
  readonly reason: string | null;
  /**
   * Who last moved the switch — in either direction. An operator's principal
   * id, `reconciliation` for the automatic self-freeze, or
   * `env:LEDGER_POSTING_ENABLED` for a boot-time freeze.
   */
  readonly actor: string | null;
  readonly changedAt: Date;
  /**
   * Database timestamp text at column precision, retained for the existing
   * operator approval version. Never round-trip it through a millisecond Date.
   * Durable event identity/order use switch_seq under the singleton lock.
   */
  readonly changedAtPrecise: string;
}

interface FreezeRow {
  frozen: boolean;
  reason: string | null;
  actor: string | null;
  changed_at: Date;
  changed_at_precise: string;
}

const MISSING = 'posting_freeze row is missing — run migrations (0002_durable_freeze) before starting svc-ledger';

function toState(row: FreezeRow): FreezeState {
  return {
    frozen: row.frozen,
    reason: row.reason,
    actor: row.actor,
    changedAt: row.changed_at,
    changedAtPrecise: row.changed_at_precise,
  };
}

/**
 * Current freeze state.
 *
 * NOT the read that gates `post()` — that one happens inside the transaction
 * that already holds the chain-tip lock (see postgres-ledger.ts). This is for
 * health, readiness, and the operator surface, where a lock would buy nothing.
 */
export async function readFreeze(sql: FreezeDb): Promise<FreezeState> {
  const rows = await sql<FreezeRow[]>`
    SELECT frozen, reason, actor, changed_at, changed_at::text AS changed_at_precise
      FROM posting_freeze WHERE id = true
  `;
  const row = rows[0];
  if (!row) throw new LedgerError(MISSING, 'ledger.uninitialised');
  return toState(row);
}

/**
 * Move the switch and return what the database now says.
 *
 * `changed_at` is the database clock after acquiring the singleton row lock.
 * Durable replay order and idempotency use an outbox sequence allocated under
 * that lock; neither timestamp nor UUID decides which switch occurred first.
 *
 * A freeze always carries a reason and an actor. A thaw carries the caller and
 * a second operator who is not that caller and not the actor who froze the
 * book. One actor string does not clear the row. The reason is cleared only
 * when the thaw is accepted, because "why it is frozen" is meaningless once it
 * is not. The database enforces an attributed freeze (`posting_freeze_attributed_ck`).
 *
 * STOP §4.2b #3: a second freeze MUST NOT silently overwrite a prior freeze's
 * reason/actor (recon hourly used to clobber an operator freeze). Same
 * attribution is a **true** no-op (no `changed_at` bump, no second outbox row);
 * different attribution is refused. Unfreeze of an already-open book is also a
 * true no-op — a double thaw must not rewrite actor/`changed_at` or re-emit.
 *
 * When the switch does move, the `ledgerFreezeUpdated` intent is inserted in
 * the same transaction. Publish happens after commit. A crash or a bus throw
 * leaves the row unpublished for the same-attribution retry and for the
 * outbox recover path. The retry does not take this UPDATE, so it does not
 * insert a second row and does not move `changed_at` again.
 */
export type FreezeCommand =
  | { readonly frozen: true; readonly reason: string; readonly actor: string }
  | { readonly frozen: false; readonly actor: string; readonly confirmOperatorId?: string | null };

/**
 * A thaw needs two distinct operators, and the confirming one cannot be the
 * person who froze the book. An already-open book is not a refusal: a second
 * clear is a no-op. Blank, whitespace, and the same id in another hex case
 * are the same person.
 */
export function unfreezeRefusal(
  current: { readonly frozen: boolean; readonly actor: string | null },
  actor: string | null,
  confirmOperatorId: string | null,
): { readonly code: typeof MISSING_OPERATOR; readonly message: string } | null {
  if (!current.frozen) return null;
  const pair = dualControlRefuse(actor, confirmOperatorId);
  if (pair) return pair;
  const confirm = (confirmOperatorId ?? '').trim().toLowerCase();
  const freezer = (current.actor ?? '').trim().toLowerCase();
  if (freezer.length > 0 && confirm === freezer) {
    return {
      code: MISSING_OPERATOR,
      message: 'the operator who froze posting cannot be the one who clears it',
    };
  }
  return null;
}

export async function writeFreeze(
  sql: Sql,
  next: FreezeCommand,
): Promise<{ state: FreezeState; switched: boolean }> {
  return sql.begin(async (tx) => writeFreezeInTransaction(tx, next));
}

/** Caller owns the transaction and the post-commit publication boundary. */
export async function writeFreezeInTransaction(
  sql: TransactionSql,
  next: FreezeCommand,
): Promise<{ state: FreezeState; switched: boolean }> {
  const rows = await sql<FreezeRow[]>`
    SELECT frozen, reason, actor, changed_at, changed_at::text AS changed_at_precise
      FROM posting_freeze WHERE id = true FOR UPDATE
  `;
  if (!rows[0]) throw new LedgerError(MISSING, 'ledger.uninitialised');
  const current = toState(rows[0]);
  if (next.frozen && current.frozen) return resolveAttributedFreeze(current, next);
  if (!next.frozen && !current.frozen) return { state: current, switched: false };
  if (!next.frozen) {
    const refusal = unfreezeRefusal(current, next.actor, next.confirmOperatorId ?? null);
    if (refusal) throw new DualControlError(refusal.message);
  }

  const updated = await sql<FreezeRow[]>`
    UPDATE posting_freeze
       SET frozen = ${next.frozen}, reason = ${next.frozen ? next.reason : null},
           actor = ${next.actor}, changed_at = clock_timestamp()
     WHERE id = true
    RETURNING frozen, reason, actor, changed_at, changed_at::text AS changed_at_precise
  `;
  const state = toState(updated[0]!);
  // This allocation occurs only after the actual singleton row lock. Earlier
  // transaction starts cannot receive an earlier order for a later switch.
  await insertFreezeOutbox(sql, state);
  return { state, switched: true };
}

/**
 * The in-process/legacy freeze key. Durable PostgreSQL intents use switch_seq.
 *
 * A function rather than an inline template because the defect it fixes lives
 * entirely in the choice of input (STOP §4.2b #7), and that choice is worth a
 * test that does not need a database to run. `changedAtPrecise` is the column's
 * own text; `changedAt` is a JS `Date` and has already lost the microseconds
 * that separate a freeze from the thaw that followed it.
 */
export function freezeEventKey(state: Pick<FreezeState, 'changedAtPrecise'>): string {
  return `ledger.freeze:${state.changedAtPrecise}`;
}

export interface FreezeOutboxRow {
  id: string;
  idempotency_key: string;
  payload: unknown;
}

/**
 * The bus payload for one switch, written beside the `posting_freeze` update.
 *
 * `changedAt` is the JS instant the column already returned. The idempotency
 * key contains the durable switch sequence and is stored alongside it.
 * A retry publishes the stored identity without allocating another sequence.
 * Nothing here is money.
 */
function freezeOutboxPayload(state: FreezeState): {
  frozen: boolean;
  reason: string | null;
  actor: string;
  changedAt: string;
} {
  return {
    frozen: state.frozen,
    reason: state.reason,
    actor: state.actor ?? 'unknown',
    changedAt: state.changedAt.toISOString(),
  };
}

async function insertFreezeOutbox(sql: TransactionSql, state: FreezeState): Promise<void> {
  await sql`
    WITH next_switch AS (
      SELECT nextval(pg_get_serial_sequence('ledger_freeze_outbox', 'switch_seq')) AS seq
    )
    INSERT INTO ledger_freeze_outbox (switch_seq, idempotency_key, payload)
    SELECT seq, 'ledger.freeze:seq:' || seq::text, ${sql.json(freezeOutboxPayload(state))}
      FROM next_switch
  `;
}

/** Unpublished `ledgerFreezeUpdated` intents, oldest first. */
export async function unpublishedFreezeOutbox(sql: Sql, limit = 100): Promise<FreezeOutboxRow[]> {
  return sql<FreezeOutboxRow[]>`
    SELECT id, idempotency_key, payload
      FROM ledger_freeze_outbox
     WHERE published_at IS NULL
     ORDER BY switch_seq ASC
     LIMIT ${limit}
  `;
}

export async function markFreezeOutboxPublished(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE ledger_freeze_outbox
       SET published_at = now()
     WHERE id = ${id} AND published_at IS NULL
  `;
}

/** The message `post()` refuses with. One phrasing, so callers can match on it. */
export function frozenMessage(reason: string | null): string {
  return `Ledger posting is frozen${reason ? `: ${reason}` : ''}`;
}

function attributedOverwriteError(current: FreezeState, next: { reason: string; actor: string }): LedgerError {
  return new LedgerError(
    `Ledger already frozen by ${current.actor ?? 'unknown'}: ${current.reason ?? 'no reason'} — ` +
      `refusing to overwrite with ${next.actor}: ${next.reason} (STOP §4.2b #3)`,
    'ledger.freeze_attributed',
  );
}

/**
 * Same-attribution re-freeze is a true no-op. A different actor/reason while
 * already frozen is `ledger.freeze_attributed` — the first reason stands.
 *
 * Shared by `writeFreeze` (after the SQL claim misses) and `MemoryPostingFreeze`
 * so a public-door test ledger cannot silently overwrite what Postgres refuses.
 */
export function resolveAttributedFreeze(
  current: FreezeState,
  next: { reason: string; actor: string },
): { state: FreezeState; switched: boolean } {
  if (current.reason === next.reason && current.actor === next.actor) {
    return { state: current, switched: false };
  }
  throw attributedOverwriteError(current, next);
}

/** Process-local tie. `Date` cannot name two switches inside one millisecond. */
let memoryChangedAtTie = 0;

function snapshotNow(frozen: boolean, reason: string | null, actor: string | null): FreezeState {
  const changedAt = new Date();
  memoryChangedAtTie += 1;
  // freezeEventKey is this text alone. `toISOString()` is milliseconds, so a
  // thaw in that same millisecond used to reuse the freeze msgID and a
  // duplicate-detecting bus dropped it. The tie is minted into the text here;
  // parsing `changedAt` cannot rebuild it. A no-op does not call this.
  const ms = changedAt.toISOString();
  const changedAtPrecise = `${ms.slice(0, -1)}${memoryChangedAtTie.toString(10).padStart(6, '0')}Z`;
  return { frozen, reason, actor, changedAt, changedAtPrecise };
}

/**
 * In-process freeze switch with the same attribution rules as `writeFreeze`.
 *
 * Postgres remains the durable book. This exists so mounted-door tests (and any
 * future in-process replica) cannot implement a freeze that overwrites the
 * standing reason — the defect STOP §4.2b #3 closed in SQL.
 */
export class MemoryPostingFreeze {
  private state: FreezeState = snapshotNow(false, null, null);

  snapshot(): FreezeState {
    return this.state;
  }

  freeze(reason: string, actor: string): FreezeState {
    if (!this.state.frozen) {
      this.state = snapshotNow(true, reason, actor);
      return this.state;
    }
    const { state } = resolveAttributedFreeze(this.state, { reason, actor });
    this.state = state;
    return this.state;
  }

  unfreeze(actor: string, confirmOperatorId?: string | null): FreezeState {
    if (!this.state.frozen) return this.state;
    const refusal = unfreezeRefusal(this.state, actor, confirmOperatorId ?? null);
    if (refusal) throw new DualControlError(refusal.message);
    this.state = snapshotNow(false, null, actor);
    return this.state;
  }
}
