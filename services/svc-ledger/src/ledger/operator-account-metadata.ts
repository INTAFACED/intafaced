import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { LedgerError } from '@intafaced/ledger-client';
import { frozenMessage } from './freeze.js';
import { recordLookup, type LookupActor, type LookupRecorder } from './operator-lookup.js';
import { consumeLedgerApproval, type ActionApprovalConsumer } from './action-approval-consume.js';

/**
 * Operator metadata on a ledger account (OPS-ledger-desk-01, J-ops-console-03 #6, #7; migration 0029).
 *
 * A founder can label an account with a key and a value: set a new key, overwrite one, or delete one, always with a
 * reason. A delete needs a second founder: svc-identity's action approval `ledger.account_metadata.delete`, bound to
 * the account, the key, the reason and the key's revision, spent once here. Every change keeps the value before and
 * after in `account_metadata_changes`, which is append-only.
 *
 * Metadata is not a posting. Nothing here writes an entry, a balance or a transaction's own metadata (that is part of
 * the hash chain and immutable, 0016). Both writes still refuse `ledger.frozen` while the posting freeze is on: a
 * frozen book takes no operator write. The freeze is read under a share lock in the write's own transaction, so a
 * freeze that lands while a write is in flight waits for it, and a write after it is refused. A delete checks the
 * freeze before it asks identity to spend the approval, so a refused delete keeps its approval for after the unfreeze. A
 * freeze or write that lands in the moment after that check and before the write is refused
 * `ledger.account_metadata_approval_spent`: the approval was used, and the founders approve again. A crash in that moment
 * also leaves the approval used and nothing written; a retry is refused by identity's attestation rule.
 *
 * Reading an account's metadata names that account, so it writes an `operator_access_log` row first
 * (`account_metadata.read`), like the desk's other reads, and is refused with nothing read when it cannot.
 */

export const ACCOUNT_METADATA_INVALID = 'ledger.account_metadata_invalid' as const;
export const ACCOUNT_NOT_FOUND = 'ledger.account_not_found' as const;
/** The key's revision moved after the founder read it (or after the delete was approved): nothing changed. */
export const ACCOUNT_METADATA_STALE = 'ledger.account_metadata_stale' as const;
/** A delete of a key that holds no value. */
export const ACCOUNT_METADATA_KEY_ABSENT = 'ledger.account_metadata_key_absent' as const;
export const LEDGER_FROZEN = 'ledger.frozen' as const;
/**
 * A delete whose approval identity had just spent, refused because the freeze or another write landed in the moment
 * between the check and the write. Nothing changed; the approval is gone, so the founders approve again.
 */
export const ACCOUNT_METADATA_APPROVAL_SPENT = 'ledger.account_metadata_approval_spent' as const;

export const ACCOUNT_METADATA_DELETE_ACTION = 'ledger.account_metadata.delete' as const;
/** The target identity consumes against, in the same `posting_<verb>` form as the ledger's other approvals. */
export const ACCOUNT_METADATA_DELETE_TARGET = 'posting_account_metadata.delete' as const;
export const ACCOUNT_METADATA_READ_ACTION = 'account_metadata.read' as const;
/** How many recent changes a read answers. A page size, not a money magnitude. */
export const ACCOUNT_METADATA_HISTORY = 50;

const accountId = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/, 'a key is lower case: a letter, then letters, digits, _ . : or -, 64 at most');
const reason = z.string().trim().min(12).max(500);
/** The revision the founder read: 0 for a key never set. */
const revision = z.number().int().min(0).max(2_147_483_646);

export const accountMetadataReadInputSchema = z.object({ accountId }).strict();
export type AccountMetadataReadInput = z.infer<typeof accountMetadataReadInputSchema>;

export const accountMetadataSetInputSchema = z
  .object({
    accountId,
    key,
    value: z.string().min(1).max(500),
    reason,
    revision,
  })
  .strict();
export type AccountMetadataSetInput = z.infer<typeof accountMetadataSetInputSchema>;

export const accountMetadataDeleteInputSchema = z
  .object({
    accountId,
    key,
    reason,
    revision: revision.refine((r) => r >= 1, 'a key that was never set has nothing to delete'),
    approvalId: z.string().trim().min(1).max(128),
    operationId: z.string().trim().min(1).max(128),
  })
  .strict();
export type AccountMetadataDeleteInput = z.infer<typeof accountMetadataDeleteInputSchema>;

const changeSchema = z.object({
  seq: z.string(),
  key: z.string(),
  action: z.enum(['set', 'delete']),
  before: z.string().nullable(),
  after: z.string().nullable(),
  revision: z.number().int(),
  requesterId: z.string(),
  approverId: z.string().nullable(),
  reason: z.string(),
  recordedAt: z.string().datetime(),
});
export type AccountMetadataChange = z.infer<typeof changeSchema>;

export const accountMetadataOutputSchema = z.object({
  accountId: z.string().uuid(),
  address: z.string(),
  /** Keys that hold a value now, by key. */
  entries: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      revision: z.number().int(),
      updatedAt: z.string().datetime(),
      updatedBy: z.string(),
    }),
  ),
  /** A deleted key's revision, so a founder can set it again from the revision the ledger holds. */
  deleted: z.array(z.object({ key: z.string(), revision: z.number().int() })),
  /** The newest changes first. */
  changes: z.array(changeSchema),
  frozen: z.boolean(),
});
export type AccountMetadataOutput = z.infer<typeof accountMetadataOutputSchema>;

export const accountMetadataChangeOutputSchema = z.object({ accountId: z.string().uuid(), change: changeSchema });
export type AccountMetadataChangeOutput = z.infer<typeof accountMetadataChangeOutputSchema>;

/** The fields the delete's approval is bound to; the console hashes the same ones (`approval-hash.ts`). */
export function accountMetadataDeleteFields(
  input: Pick<AccountMetadataDeleteInput, 'accountId' | 'key' | 'reason'>,
): Record<string, string> {
  return { accountId: input.accountId, key: input.key, reason: input.reason };
}

type ChangeRow = {
  seq: string;
  key: string;
  action: 'set' | 'delete';
  before: string | null;
  after: string | null;
  revision: number;
  requester_id: string;
  approver_id: string | null;
  approval_id: string | null;
  reason: string;
  recorded_at: Date;
};

const changeOf = (r: ChangeRow): AccountMetadataChange => ({
  seq: String(r.seq),
  key: r.key,
  action: r.action,
  before: r.before,
  after: r.after,
  revision: r.revision,
  requesterId: r.requester_id,
  approverId: r.approver_id,
  reason: r.reason,
  recordedAt: r.recorded_at.toISOString(),
});

export async function readAccountMetadata(sql: Sql, input: AccountMetadataReadInput): Promise<AccountMetadataOutput> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const [account] = await tx<Array<{ owner_type: string; owner_id: string }>>`
      SELECT owner_type::text AS owner_type, owner_id FROM accounts WHERE id = ${input.accountId}
    `;
    if (!account) throw new LedgerError('No ledger account has that id.', ACCOUNT_NOT_FOUND);
    const keys = await tx<Array<{ key: string; value: string | null; revision: number; updated_at: Date; updated_by: string }>>`
      SELECT key, value, revision, updated_at, updated_by FROM account_metadata WHERE account_id = ${input.accountId} ORDER BY key
    `;
    const changes = await tx<ChangeRow[]>`
      SELECT seq::text AS seq, key, action, before, after, revision, requester_id, approver_id, approval_id, reason, recorded_at
        FROM account_metadata_changes
       WHERE account_id = ${input.accountId}
       ORDER BY seq DESC
       LIMIT ${ACCOUNT_METADATA_HISTORY}
    `;
    const [freeze] = await tx<Array<{ frozen: boolean }>>`SELECT frozen FROM posting_freeze WHERE id = true`;
    return {
      accountId: input.accountId,
      address: `${account.owner_type}:${account.owner_id}`,
      entries: keys
        .filter((k) => k.value !== null)
        .map((k) => ({
          key: k.key,
          value: k.value as string,
          revision: k.revision,
          updatedAt: k.updated_at.toISOString(),
          updatedBy: k.updated_by,
        })),
      deleted: keys.filter((k) => k.value === null).map((k) => ({ key: k.key, revision: k.revision })),
      changes: changes.map(changeOf),
      frozen: freeze?.frozen ?? false,
    };
  });
}

/** Records the read under the founder first; a read that cannot be recorded is refused with nothing read. */
export async function operatorAccountMetadataRead(
  reader: LookupRecorder & { readAccountMetadata(input: AccountMetadataReadInput): Promise<AccountMetadataOutput> },
  actor: LookupActor,
  input: AccountMetadataReadInput,
): Promise<AccountMetadataOutput> {
  await recordLookup(reader, actor, { ownerType: 'account', ownerId: input.accountId, action: ACCOUNT_METADATA_READ_ACTION });
  return reader.readAccountMetadata(input);
}

type Tx = TransactionSql;

/** Inside a write's transaction: refuse while frozen, holding a share lock so a freeze waits for this write. */
async function refuseWhileFrozen(tx: Tx): Promise<void> {
  const [freeze] = await tx<Array<{ frozen: boolean; reason: string | null }>>`
    SELECT frozen, reason FROM posting_freeze WHERE id = true FOR SHARE
  `;
  if (!freeze) throw new LedgerError('posting_freeze row is missing — the ledger is not initialised', 'ledger.uninitialised');
  if (freeze.frozen) throw new LedgerError(frozenMessage(freeze.reason), LEDGER_FROZEN);
}

async function lockAccount(tx: Tx, id: string): Promise<void> {
  const [account] = await tx`SELECT 1 FROM accounts WHERE id = ${id} FOR KEY SHARE`;
  if (!account) throw new LedgerError('No ledger account has that id.', ACCOUNT_NOT_FOUND);
}

async function changeAt(sql: Sql | Tx, accountIdValue: string, keyValue: string, rev: number): Promise<ChangeRow | undefined> {
  const [row] = await sql<ChangeRow[]>`
    SELECT seq::text AS seq, key, action, before, after, revision, requester_id, approver_id, approval_id, reason, recorded_at
      FROM account_metadata_changes
     WHERE account_id = ${accountIdValue} AND key = ${keyValue} AND revision = ${rev}
  `;
  return row;
}

function parseOrRefuse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new LedgerError(parsed.error.issues.map((i) => i.message).join('; '), ACCOUNT_METADATA_INVALID);
  return parsed.data;
}

/**
 * Set or overwrite one key. `revision` is the key's revision the founder read (0 for a new key); the write takes the
 * next one. A retry of the same set after a lost reply finds its own change at that revision and answers it again; any
 * other change there means someone else wrote first, and nothing changes (`ledger.account_metadata_stale`).
 */
export async function setAccountMetadata(sql: Sql, actorId: string, input: unknown): Promise<AccountMetadataChangeOutput> {
  const cmd = parseOrRefuse(accountMetadataSetInputSchema, input);
  const next = cmd.revision + 1;
  const sameSet = (c: ChangeRow | undefined) =>
    c !== undefined && c.action === 'set' && c.after === cmd.value && c.requester_id === actorId && c.reason === cmd.reason;
  try {
    return await sql.begin(async (tx) => {
      await refuseWhileFrozen(tx);
      await lockAccount(tx, cmd.accountId);
      const [current] = await tx<Array<{ value: string | null; revision: number }>>`
        SELECT value, revision FROM account_metadata WHERE account_id = ${cmd.accountId} AND key = ${cmd.key} FOR UPDATE
      `;
      const held = current?.revision ?? 0;
      if (held !== cmd.revision) {
        const prior = await changeAt(tx, cmd.accountId, cmd.key, next);
        if (sameSet(prior)) return { accountId: cmd.accountId, change: changeOf(prior as ChangeRow) };
        throw new LedgerError(`${cmd.key} changed after it was read (revision ${held}); read it again`, ACCOUNT_METADATA_STALE);
      }
      await tx`
        INSERT INTO account_metadata (account_id, key, value, revision, updated_at, updated_by)
        VALUES (${cmd.accountId}, ${cmd.key}, ${cmd.value}, ${next}, now(), ${actorId})
        ON CONFLICT (account_id, key) DO UPDATE
          SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
      `;
      const [row] = await tx<ChangeRow[]>`
        INSERT INTO account_metadata_changes (account_id, key, action, before, after, revision, requester_id, reason)
        VALUES (${cmd.accountId}, ${cmd.key}, 'set', ${current?.value ?? null}, ${cmd.value}, ${next}, ${actorId}, ${cmd.reason})
        RETURNING seq::text AS seq, key, action, before, after, revision, requester_id, approver_id, approval_id, reason, recorded_at
      `;
      return { accountId: cmd.accountId, change: changeOf(row as ChangeRow) };
    });
  } catch (err) {
    // Two first writes of a new key race on the primary key: the loser wrote nothing.
    if (isUniqueViolation(err)) {
      const prior = await changeAt(sql, cmd.accountId, cmd.key, next);
      if (sameSet(prior)) return { accountId: cmd.accountId, change: changeOf(prior as ChangeRow) };
      throw new LedgerError(`${cmd.key} changed after it was read; read it again`, ACCOUNT_METADATA_STALE);
    }
    throw err;
  }
}

/**
 * Delete one key with a second founder's approval. Order: refuse while frozen and check the key still holds a value at
 * the approved revision (nothing spent yet), then ask identity to spend the approval, then write in one transaction
 * that re-checks both. A retry with the same approval after a lost reply finds the change that approval wrote and
 * answers it again without asking identity a second time.
 */
export async function deleteAccountMetadata(
  sql: Sql,
  approvals: ActionApprovalConsumer,
  operatorId: string,
  input: unknown,
): Promise<AccountMetadataChangeOutput> {
  const cmd = parseOrRefuse(accountMetadataDeleteInputSchema, input);
  const next = cmd.revision + 1;

  const replay = async (): Promise<AccountMetadataChangeOutput | null> => {
    const prior = await changeAt(sql, cmd.accountId, cmd.key, next);
    if (prior && prior.action === 'delete' && prior.reason === cmd.reason && prior.approval_id === cmd.approvalId) {
      return { accountId: cmd.accountId, change: changeOf(prior) };
    }
    return null;
  };
  const replayed = await replay();
  if (replayed) return replayed;

  // Before identity spends anything: a frozen book, a missing account or a key that moved refuses with the approval kept.
  await sql.begin(async (tx) => {
    await refuseWhileFrozen(tx);
    await lockAccount(tx, cmd.accountId);
    await holdsValueAt(tx, cmd);
  });

  const consumed = await consumeLedgerApproval(
    approvals,
    cmd,
    ACCOUNT_METADATA_DELETE_ACTION,
    ACCOUNT_METADATA_DELETE_TARGET,
    String(cmd.revision),
    accountMetadataDeleteFields(cmd),
    cmd.operationId,
    operatorId,
  );
  // `consumeLedgerApproval` has already required a distinct founder pair (identity's attestation), so the approver is set.
  const approverId = consumed.approverId as string;

  try {
    return await sql.begin(async (tx) => {
      // The approval is spent now. A freeze or a write that landed in the moment since the check above refuses here with
      // its own code, so the founder is told to ask for a new approval rather than retry this one.
      await spentIfRefused(() => refuseWhileFrozen(tx));
      await lockAccount(tx, cmd.accountId);
      const before = await spentIfRefused(() => holdsValueAt(tx, cmd, true));
      await tx`
        UPDATE account_metadata SET value = NULL, revision = ${next}, updated_at = now(), updated_by = ${operatorId}
         WHERE account_id = ${cmd.accountId} AND key = ${cmd.key}
      `;
      const [row] = await tx<ChangeRow[]>`
        INSERT INTO account_metadata_changes
          (account_id, key, action, before, after, revision, requester_id, approver_id, approval_id, reason)
        VALUES (${cmd.accountId}, ${cmd.key}, 'delete', ${before}, NULL, ${next}, ${consumed.requesterId}, ${approverId},
                ${cmd.approvalId}, ${cmd.reason})
        RETURNING seq::text AS seq, key, action, before, after, revision, requester_id, approver_id, approval_id, reason, recorded_at
      `;
      return { accountId: cmd.accountId, change: changeOf(row as ChangeRow) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await replay();
      if (again) return again;
      throw new LedgerError(`${cmd.key} changed after the delete was approved; approve it again`, ACCOUNT_METADATA_STALE);
    }
    throw err;
  }
}

/** A refusal after identity spent the approval: the same answer, under a code that says the approval is gone. */
async function spentIfRefused<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (
      err instanceof LedgerError &&
      (err.code === LEDGER_FROZEN || err.code === ACCOUNT_METADATA_STALE || err.code === ACCOUNT_METADATA_KEY_ABSENT)
    ) {
      throw new LedgerError(`${err.message}; the approval was used, so ask for a new one`, ACCOUNT_METADATA_APPROVAL_SPENT);
    }
    throw err;
  }
}

/** The key's current value at the approved revision, or the refusal that says why not. */
async function holdsValueAt(tx: Tx, cmd: AccountMetadataDeleteInput, lock = false): Promise<string> {
  const [current] = lock
    ? await tx<Array<{ value: string | null; revision: number }>>`
        SELECT value, revision FROM account_metadata WHERE account_id = ${cmd.accountId} AND key = ${cmd.key} FOR UPDATE
      `
    : await tx<Array<{ value: string | null; revision: number }>>`
        SELECT value, revision FROM account_metadata WHERE account_id = ${cmd.accountId} AND key = ${cmd.key}
      `;
  if (!current) throw new LedgerError(`${cmd.key} is not set on this account`, ACCOUNT_METADATA_KEY_ABSENT);
  if (current.revision !== cmd.revision) {
    throw new LedgerError(
      `${cmd.key} changed after the delete was approved (revision ${current.revision}); approve it again`,
      ACCOUNT_METADATA_STALE,
    );
  }
  if (current.value === null) throw new LedgerError(`${cmd.key} is already deleted`, ACCOUNT_METADATA_KEY_ABSENT);
  return current.value;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}
