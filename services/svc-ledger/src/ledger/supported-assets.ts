import type { Sql } from 'postgres';
import {
  ASSET_EDIT_ACTION_TYPE,
  ASSET_EDIT_INVALID,
  ASSET_EDIT_TARGET_SERVICE,
  ASSET_NOT_FOUND,
  ASSET_PRECISION_UNSET,
  ASSET_PRECISION_INVALID,
  ASSET_DEFAULT_NETWORK_NOT_LISTED,
  assetApplyEditInputSchema,
  assetEditPayloadHash,
  assetsGetInputSchema,
  assetsListInputSchema,
  parseAssetEdit,
  registryAssetSchema,
  type AssetEditInput,
  type AssetsListInput,
  type RegistryAsset,
} from '@intafaced/contracts';
import { LedgerError } from '@intafaced/ledger-client';
import { assertFounderAudienceAttestation, type ActionApprovalConsumer } from './action-approval-consume.js';

/**
 * ONE SUPPORTED ASSET AND NETWORK REGISTRY (W-balances-05), the service half of
 * `packages/contracts/src/asset-registry.ts`. The rows are `assets` (0025),
 * the table every balance already has a foreign key to.
 *
 * Reads: `list` returns the published rows (precision set), `get` one row. A row
 * whose precision the owner has not published refuses `ledger.asset_precision_unset`
 * on `get` and is left out of `list`: its precision is never read as 18 or as
 * the old declared scale column, which nothing reads.
 *
 * Writes: `applyEdit` applies one founder edit, approved through svc-identity's
 * action approval (`ledger.asset_edit`, target `svc-ledger`, target id the asset).
 * Identity keeps only the payload hash, so the hash is recomputed here from the
 * edit that travels with the call, and the approval's `expectedVersion` is the
 * row's revision (`0` for a new asset): an edit approved against an older row
 * refuses once another edit has landed. One operation id applies once; a retry
 * with the same id returns the row instead of applying again.
 *
 * `active` is not touched: it is read by nothing, and the registry `state` is the
 * one the services that own deposit, withdraw and trade read.
 */

/** Another edit landed after this one was approved. Nothing changed; a fresh approval against the new revision is needed. */
export const ASSET_EDIT_STALE = 'ledger.asset_edit_stale' as const;
/** The operation id was already used for a different approval or edit. Nothing changed. */
export const ASSET_OPERATION_CONFLICT = 'ledger.asset_operation_conflict' as const;
/** A list filter that is not a registry state or action. A read refusal, distinct from a refused edit. */
export const ASSET_LIST_FILTER_INVALID = 'ledger.asset_list_filter_invalid' as const;

/** The registry's refusals of the caller's request: 400 with the code on both the S2S and the operator ports. */
export const REGISTRY_REFUSALS: ReadonlySet<string> = new Set([
  ASSET_NOT_FOUND,
  ASSET_PRECISION_UNSET,
  ASSET_PRECISION_INVALID,
  ASSET_DEFAULT_NETWORK_NOT_LISTED,
  ASSET_EDIT_INVALID,
  ASSET_LIST_FILTER_INVALID,
]);

interface AssetRow {
  id: string;
  kind: string;
  precision: number | null;
  networks: unknown;
  default_network_id: string | null;
  allowed_actions: string[];
  state: string;
  revision: number;
  updated_at: Date;
}

const COLUMNS = 'id, kind, precision, networks, default_network_id, allowed_actions, state, revision, updated_at';

/** The operator's view: every row, published or not, so a founder can see what is still blank before proposing an edit. */
export interface OperatorAssetRow {
  id: string;
  kind: string;
  precision: number | null;
  networks: unknown;
  defaultNetworkId: string | null;
  allowedActions: string[];
  state: string;
  revision: number;
  updatedAt: string;
}

function toOperatorRow(row: AssetRow): OperatorAssetRow {
  return {
    id: row.id,
    kind: row.kind,
    precision: row.precision,
    networks: row.networks,
    defaultNetworkId: row.default_network_id,
    allowedActions: row.allowed_actions,
    state: row.state,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One stored row in the wire shape. A stored row that does not fit it is a fault here, never a guess. */
function toRegistryAsset(row: AssetRow): RegistryAsset {
  if (row.precision === null) {
    throw new LedgerError(`The owner has not published the precision of ${row.id}`, ASSET_PRECISION_UNSET);
  }
  return registryAssetSchema.parse(toOperatorRow(row));
}

export async function listAssets(sql: Sql, input: unknown = {}): Promise<RegistryAsset[]> {
  const parsed = assetsListInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new LedgerError(parsed.error.issues.map((i) => i.message).join('; '), ASSET_LIST_FILTER_INVALID);
  }
  const { state, action }: AssetsListInput = parsed.data;
  const rows = await sql.unsafe<AssetRow[]>(
    `SELECT ${COLUMNS} FROM assets
      WHERE precision IS NOT NULL
        AND ($1::text IS NULL OR state = $1::text)
        AND ($2::text IS NULL OR $2::text = ANY (allowed_actions))
      ORDER BY id`,
    [state ?? null, action ?? null],
  );
  return rows.map(toRegistryAsset);
}

export async function getAsset(sql: Sql, input: unknown): Promise<RegistryAsset> {
  const parsed = assetsGetInputSchema.safeParse(input);
  if (!parsed.success) throw new LedgerError(parsed.error.message, ASSET_NOT_FOUND);
  const rows = await sql.unsafe<AssetRow[]>(`SELECT ${COLUMNS} FROM assets WHERE id = $1`, [parsed.data.assetId]);
  const row = rows[0];
  if (!row) throw new LedgerError(`No asset ${parsed.data.assetId} is registered`, ASSET_NOT_FOUND);
  return toRegistryAsset(row);
}

export async function listOperatorAssets(sql: Sql): Promise<OperatorAssetRow[]> {
  const rows = await sql.unsafe<AssetRow[]>(`SELECT ${COLUMNS} FROM assets ORDER BY id`);
  return rows.map(toOperatorRow);
}

/** The same edit is the same approved payload: the hash identity binds, in which network and action order do not count. */
function sameEdit(stored: unknown, edit: AssetEditInput): boolean {
  return assetEditPayloadHash(stored as AssetEditInput) === assetEditPayloadHash(edit);
}

interface AppliedEdit {
  approval_id: string;
  asset_id: string;
  revision: number;
  edit: AssetEditInput;
  applied_at: Date;
}

/** The row exactly as one applied edit left it, whatever has landed since. */
function asApplied(prior: AppliedEdit): RegistryAsset {
  const { reason: _reason, ...body } = prior.edit;
  return registryAssetSchema.parse({ ...body, revision: prior.revision, updatedAt: prior.applied_at.toISOString() });
}

/** A retry of an applied operation answers with the row that operation produced; another edit under its id refuses. */
async function replay(sql: Sql, input: { approvalId: string; operationId: string; edit: AssetEditInput }): Promise<RegistryAsset | null> {
  const rows = await sql<AppliedEdit[]>`
    SELECT approval_id, asset_id, revision, edit, applied_at FROM asset_edits WHERE operation_id = ${input.operationId}
  `;
  const prior = rows[0];
  if (!prior) return null;
  if (prior.approval_id !== input.approvalId || prior.asset_id !== input.edit.id || !sameEdit(prior.edit, input.edit)) {
    throw new LedgerError(`Operation ${input.operationId} was already used for another edit`, ASSET_OPERATION_CONFLICT);
  }
  return asApplied(prior);
}

const isUniqueViolation = (err: unknown, constraint: string) =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505' &&
  (err as { constraint_name?: string }).constraint_name === constraint;

/**
 * Apply one approved founder edit. `operatorId` is the signed-in operator who sends it (attribution); the two people
 * who decided are the approval's requester and approver, and identity attests both are founders.
 */
export async function applyAssetEdit(
  sql: Sql,
  approvals: ActionApprovalConsumer,
  operatorId: string,
  input: unknown,
): Promise<RegistryAsset> {
  const parsed = assetApplyEditInputSchema.safeParse(input);
  if (!parsed.success) {
    // The edit's own refusal when it is the edit that is wrong: a blank precision is the owner's to set, not malformed.
    const edit = input !== null && typeof input === 'object' ? parseAssetEdit((input as { edit?: unknown }).edit) : null;
    if (edit && !edit.ok) throw new LedgerError(edit.message, edit.code);
    throw new LedgerError(parsed.error.issues.map((i) => i.message).join('; '), ASSET_EDIT_INVALID);
  }
  const { approvalId, operationId, edit } = parsed.data;

  // The row is read before the operation is looked up. The row and its asset_edits record commit together, so a
  // concurrent request for the same operation that commits between the two reads is found by the lookup. Read the
  // other way round, this request could miss the record yet see the new revision, and ask identity for the wrong one.
  const current = (await sql<Array<{ kind: string; revision: number }>>`SELECT kind, revision FROM assets WHERE id = ${edit.id}`)[0];

  const replayed = await replay(sql, parsed.data);
  if (replayed) return replayed;

  // The kind is what every balance in the asset was booked as; an edit does not re-label it.
  if (current && current.kind !== edit.kind) {
    throw new LedgerError(`${edit.id} is ${current.kind}; an edit cannot change an asset's kind`, ASSET_EDIT_INVALID);
  }
  const expected = current?.revision ?? 0;

  // `requestId` lets identity tell this retry from someone else's use. Identity does not repeat the founder attestation
  // on a repeated consume, so such a retry refuses below (fails closed) until it does; the founders approve again.
  const consumed = await approvals.consume({
    approvalId,
    operationId,
    payloadHash: assetEditPayloadHash(edit),
    targetService: ASSET_EDIT_TARGET_SERVICE,
    targetId: edit.id,
    expectedVersion: String(expected),
    requestId: operationId,
  });
  assertFounderAudienceAttestation(consumed, {
    actionType: ASSET_EDIT_ACTION_TYPE,
    targetService: ASSET_EDIT_TARGET_SERVICE,
    targetId: edit.id,
  });
  const approverId = consumed.approverId;
  if (approverId === null) {
    throw new LedgerError('The approval has no approver', ASSET_EDIT_INVALID);
  }

  try {
    await sql.begin(async (tx) => {
      const locked = (await tx<Array<{ revision: number }>>`SELECT revision FROM assets WHERE id = ${edit.id} FOR UPDATE`)[0];
      // A concurrent request for the same operation got here first and applied it: answer as its retry, not as stale.
      if ((await tx`SELECT 1 FROM asset_edits WHERE operation_id = ${operationId}`).length > 0) return;
      if ((locked?.revision ?? 0) !== expected || (locked === undefined) !== (current === undefined)) {
        throw new LedgerError(`${edit.id} changed after this edit was approved; approve it again`, ASSET_EDIT_STALE);
      }
      if (locked === undefined) {
        // A new asset. The declared-but-unread scale column keeps its default: the registry's precision is the one
        // that is read, and wiring that column is the open fee-remainder question `assets-decimals.test.ts` guards.
        const inserted = await tx`
          INSERT INTO assets (id, kind, precision, networks, default_network_id, allowed_actions, state, revision, updated_at)
          VALUES (${edit.id}, ${edit.kind}::asset_kind, ${edit.precision}, ${tx.json(edit.networks as never)},
                  ${edit.defaultNetworkId}, ${edit.allowedActions}::text[], ${edit.state}, 1, now())
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        if (inserted.length === 0) {
          // The conflicting insert committed first. If it was this same operation, answer as its retry.
          if ((await tx`SELECT 1 FROM asset_edits WHERE operation_id = ${operationId}`).length > 0) return;
          throw new LedgerError(`${edit.id} was added after this edit was approved; approve it again`, ASSET_EDIT_STALE);
        }
      } else {
        await tx`
          UPDATE assets
             SET precision = ${edit.precision},
                 networks = ${tx.json(edit.networks as never)},
                 default_network_id = ${edit.defaultNetworkId},
                 allowed_actions = ${edit.allowedActions}::text[],
                 state = ${edit.state},
                 revision = revision + 1,
                 updated_at = now()
           WHERE id = ${edit.id}
        `;
      }
      await tx`
        INSERT INTO asset_edits (operation_id, approval_id, asset_id, revision, requester_id, approver_id, operator_id, edit, applied_at)
        VALUES (${operationId}, ${approvalId}, ${edit.id}, ${expected + 1}, ${consumed.requesterId}, ${approverId},
                ${operatorId}, ${tx.json(edit as never)}, now())
      `;
    });
  } catch (err) {
    // Belt and braces for any other interleaving of the same operation: answer as the replay does.
    if (isUniqueViolation(err, 'asset_edits_pkey')) {
      const again = await replay(sql, parsed.data);
      if (again) return again;
    }
    if (isUniqueViolation(err, 'asset_edits_asset_revision_uq')) {
      throw new LedgerError(`${edit.id} changed after this edit was approved; approve it again`, ASSET_EDIT_STALE);
    }
    throw err;
  }
  // `applied_at` and the row's `updated_at` are the same transaction's `now()`, so this is the row as written.
  const applied = await replay(sql, parsed.data);
  if (!applied) throw new LedgerError(`${edit.id}: the applied edit could not be read back`, ASSET_EDIT_STALE);
  return applied;
}
