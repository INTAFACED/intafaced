import type { Sql } from 'postgres';
import {
  ASSET_EDIT_ACTION_TYPE,
  ASSET_EDIT_INVALID,
  ASSET_EDIT_TARGET_SERVICE,
  ASSET_NOT_FOUND,
  ASSET_PRECISION_UNSET,
  assetApplyEditInputSchema,
  assetEditPayloadHash,
  assetsGetInputSchema,
  assetsListInputSchema,
  parseAssetEdit,
  registryAssetSchema,
  type AssetRegistryRefusal,
  type AssetsListInput,
  type RegistryAsset,
} from '@intafaced/contracts';
import { assertFounderAudienceAttestation, readApprovalIds, type ActionApprovalConsumer } from './action-approval-consume.js';

/**
 * One supported asset and network registry (W-balances-05), stored on `ledger.assets` (0025). Reads return the
 * contracts row; a founder edit applies once, only for an identity-approved `ledger.asset_edit` whose payload hash and
 * expected revision match. Nothing is defaulted: a row whose precision the owner has not set is not in the registry
 * (`get` refuses `ledger.asset_precision_unset`, `list` leaves it out) and is never read as 18 or as `decimals`.
 */
export class AssetRegistryError extends Error {
  constructor(
    readonly code: AssetRegistryRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'AssetRegistryError';
  }
}

interface AssetRow {
  id: string;
  kind: string;
  precision: number | null;
  networks: unknown;
  default_network_id: string | null;
  allowed_actions: string[];
  state: string;
  revision: number;
  registry_updated_at: Date;
}

function toRegistryAsset(row: AssetRow & { precision: number }): RegistryAsset {
  return registryAssetSchema.parse({
    id: row.id,
    kind: row.kind,
    precision: row.precision,
    networks: row.networks,
    defaultNetworkId: row.default_network_id,
    allowedActions: row.allowed_actions,
    state: row.state,
    revision: row.revision,
    updatedAt: row.registry_updated_at.toISOString(),
  });
}

const COLUMNS = `id, kind::text AS kind, precision, networks, default_network_id, allowed_actions, state, revision, registry_updated_at`;

export class AssetRegistry {
  constructor(private readonly sql: Sql) {}

  /** Registered assets (precision set), retired included unless filtered. Ordered by id. */
  async list(input: AssetsListInput): Promise<{ assets: RegistryAsset[] }> {
    const { state, action } = assetsListInputSchema.parse(input);
    const rows = await this.sql.unsafe<AssetRow[]>(
      `SELECT ${COLUMNS} FROM assets
        WHERE precision IS NOT NULL
          AND ($1::text IS NULL OR state = $1::text)
          AND ($2::text IS NULL OR $2::text = ANY (allowed_actions))
        ORDER BY id`,
      [state ?? null, action ?? null],
    );
    return { assets: rows.map((r) => toRegistryAsset(r as AssetRow & { precision: number })) };
  }

  async get(input: { assetId: string }): Promise<RegistryAsset> {
    const { assetId } = assetsGetInputSchema.parse(input);
    const [row] = await this.sql.unsafe<AssetRow[]>(`SELECT ${COLUMNS} FROM assets WHERE id = $1`, [assetId]);
    if (!row) throw new AssetRegistryError(ASSET_NOT_FOUND, `asset ${assetId} is not in the ledger`);
    if (row.precision === null) {
      throw new AssetRegistryError(ASSET_PRECISION_UNSET, `asset ${assetId} has no precision set; the owner must set it`);
    }
    return toRegistryAsset(row as AssetRow & { precision: number });
  }

  /**
   * Apply one approved founder edit. Order: parse (typed refusals), read the row's revision, consume the approval bound
   * to that revision and the edit's payload hash (identity refuses a mismatch or a reuse), then write under a row lock
   * that re-checks the revision, so an edit approved against an older row never lands.
   */
  async applyEdit(approvals: ActionApprovalConsumer, input: unknown, actorId: string): Promise<RegistryAsset> {
    const raw = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const parsedEdit = parseAssetEdit(raw.edit);
    if (!parsedEdit.ok) throw new AssetRegistryError(parsedEdit.code, parsedEdit.message);
    const shape = assetApplyEditInputSchema.safeParse({ ...raw, edit: parsedEdit.value });
    if (!shape.success) throw new AssetRegistryError(ASSET_EDIT_INVALID, shape.error.issues.map((i) => i.message).join('; '));
    const edit = shape.data.edit;
    const ids = readApprovalIds(shape.data);

    const [current] = await this.sql<Array<{ kind: string; revision: number }>>`
      SELECT kind::text AS kind, revision FROM assets WHERE id = ${edit.id}`;
    if (current && current.kind !== edit.kind) {
      throw new AssetRegistryError(ASSET_EDIT_INVALID, `asset ${edit.id} is ${current.kind}; its kind is not changed by an edit`);
    }
    const expectedRevision = current?.revision ?? 0;
    const payloadHash = assetEditPayloadHash(edit);
    const consumed = await approvals.consume({
      approvalId: ids.approvalId,
      operationId: ids.operationId,
      payloadHash,
      targetService: ASSET_EDIT_TARGET_SERVICE,
      targetId: edit.id,
      expectedVersion: String(expectedRevision),
    });
    assertFounderAudienceAttestation(consumed, {
      actionType: ASSET_EDIT_ACTION_TYPE,
      targetService: ASSET_EDIT_TARGET_SERVICE,
      targetId: edit.id,
    });

    const nextRevision = expectedRevision + 1;
    await this.sql.begin(async (tx) => {
      const [locked] = await tx<Array<{ revision: number }>>`
        SELECT revision FROM assets WHERE id = ${edit.id} FOR UPDATE`;
      if ((locked?.revision ?? 0) !== expectedRevision) {
        throw new AssetRegistryError(
          ASSET_EDIT_INVALID,
          `asset ${edit.id} changed after this edit was approved (revision ${locked?.revision ?? 0}, approved against ${expectedRevision})`,
        );
      }
      const networks = tx.json(edit.networks as unknown as Parameters<typeof tx.json>[0]);
      if (locked) {
        await tx`
          UPDATE assets SET precision = ${edit.precision}, networks = ${networks},
            default_network_id = ${edit.defaultNetworkId}, allowed_actions = ${edit.allowedActions}::text[],
            state = ${edit.state}, revision = ${nextRevision}, registry_updated_at = now()
          WHERE id = ${edit.id}`;
      } else {
        await tx`
          INSERT INTO assets (id, kind, decimals, precision, networks, default_network_id, allowed_actions, state, revision)
          VALUES (${edit.id}, ${edit.kind}::asset_kind, ${edit.precision}, ${edit.precision}, ${networks},
            ${edit.defaultNetworkId}, ${edit.allowedActions}::text[], ${edit.state}, ${nextRevision})`;
      }
      await tx`
        INSERT INTO asset_edits (approval_id, operation_id, asset_id, revision, payload_hash, edit, actor_id, approver_id)
        VALUES (${ids.approvalId}, ${ids.operationId}, ${edit.id}, ${nextRevision}, ${payloadHash},
          ${tx.json(edit as unknown as Parameters<typeof tx.json>[0])}, ${actorId}, ${consumed.approverId ?? null})`;
    });
    return this.get({ assetId: edit.id });
  }
}
