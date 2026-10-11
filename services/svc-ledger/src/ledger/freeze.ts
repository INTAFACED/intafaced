import type { Sql, TransactionSql } from 'postgres';
import { LedgerError } from '@intafaced/ledger-client';

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
   * `changed_at` at the column's own precision, as Postgres renders it.
   *
   * STOP §4.2b #7: the freeze event keyed its idempotency id off
   * `changedAt.toISOString()`, and a JavaScript `Date` holds MILLISECONDS while
   * `timestamptz` holds microseconds. A freeze and the thaw that followed it
   * inside the same millisecond produced the same `msgID`, and JetStream drops
   * the duplicate — which is the THAW. The platform then stays halted in every
   * consumer's view of the world while the database says it is open.
   *
   * Reading the timestamp back through a `Date` cannot fix this: the precision
   * is already gone by then. So the identity travels as the text the database
   * itself produced, and never round-trips through a JS clock type.
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
 * `changed_at` comes from `now()`, not from the calling process. Two replicas
 * disagreeing about the wall clock must not be able to disagree about the order
 * in which the platform was halted and resumed.
 *
 * A freeze always carries a reason and an actor; a thaw carries only the actor
 * and clears the reason, because "why it is frozen" is meaningless once it is
 * not. The database enforces the first half (`posting_freeze_attributed_ck`).
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
export async function writeFreeze(
  sql: Sql,
  next: { frozen: true; reason: string; actor: string } | { frozen: false; actor: string },
): Promise<{ state: FreezeState; switched: boolean }> {
  return sql.begin(async (tx) => {
    const result = await applyFreeze(tx, next);
    if (result.switched) await insertFreezeOutbox(tx, result.state);
    return result;
  });
}

async function applyFreeze(
  sql: FreezeDb,
  next: { frozen: true; reason: string; actor: string } | { frozen: false; actor: string },
): Promise<{ state: FreezeState; switched: boolean }> {
  if (next.frozen) {
    // Claim freeze only when currently thawed. Same attribution while already
    // frozen used to match the WHERE and still SET changed_at = now() — that
    // made hourly recon re-freeze walk the "when was it frozen?" clock and
    // mint a new freezeEventKey every cycle. True no-op = no UPDATE.
    const rows = await sql<FreezeRow[]>`
      UPDATE posting_freeze
         SET frozen = true,
             reason = ${next.reason},
             actor = ${next.actor},
             changed_at = now()
       WHERE id = true
         AND frozen = false
      RETURNING frozen, reason, actor, changed_at, changed_at::text AS changed_at_precise
    `;
    if (rows[0]) return { state: toState(rows[0]), switched: true };

    // Nothing matched. `readFreeze` throws `ledger.uninitialised` if the row is
    // absent. If the row is present and thawed the UPDATE above would have
    // taken it, so reaching here with `frozen = false` means another writer
    // thawed it between the two statements — a lost race, not a missing
    // migration. Same attribution while frozen is the true no-op path.
    const current = await readFreeze(sql);
    if (!current.frozen) {
      throw new LedgerError(
        `Freeze lost a race: the ledger was thawed by ${current.actor ?? 'unknown'} while ${next.actor} was freezing it. Retry.`,
        'ledger.freeze_raced',
      );
    }
    return resolveAttributedFreeze(current, next);
  }

  // Thaw only when currently frozen. Already-open → no-op (stable changed_at).
  const rows = await sql<FreezeRow[]>`
    UPDATE posting_freeze
       SET frozen = false, reason = null, actor = ${next.actor}, changed_at = now()
     WHERE id = true
       AND frozen = true
    RETURNING frozen, reason, actor, changed_at, changed_at::text AS changed_at_precise
  `;

  if (rows[0]) return { state: toState(rows[0]), switched: true };

  const current = await readFreeze(sql);
  // Row missing is `ledger.uninitialised` from readFreeze. Already open is the
  // honest no-op answer for a double thaw / retry.
  return { state: current, switched: false };
}

/**
 * The bus idempotency key for one freeze state change.
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
 * key is `freezeEventKey` — the column's own text — and is stored separately
 * so a later publish does not rebuild it from a millisecond `Date`.
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

async function insertFreezeOutbox(sql: FreezeDb, state: FreezeState): Promise<void> {
  await sql`
    INSERT INTO ledger_freeze_outbox (idempotency_key, payload)
    VALUES (${freezeEventKey(state)}, ${sql.json(freezeOutboxPayload(state))})
  `;
}

/** Unpublished `ledgerFreezeUpdated` intents, oldest first. */
export async function unpublishedFreezeOutbox(sql: Sql, limit = 100): Promise<FreezeOutboxRow[]> {
  return sql<FreezeOutboxRow[]>`
    SELECT id, idempotency_key, payload
      FROM ledger_freeze_outbox
     WHERE published_at IS NULL
     ORDER BY created_at ASC
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

  unfreeze(actor: string): FreezeState {
    if (!this.state.frozen) return this.state;
    this.state = snapshotNow(false, null, actor);
    return this.state;
  }
}
