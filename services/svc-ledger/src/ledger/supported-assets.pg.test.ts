import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  ASSET_EDIT_ACTION_TYPE,
  ASSET_EDIT_INVALID,
  ASSET_NOT_FOUND,
  ASSET_PRECISION_INVALID,
  ASSET_PRECISION_UNSET,
  actionApprovalSchema,
  assetEditPayloadHash,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type AssetEditInput,
} from '@intafaced/contracts';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import {
  ASSET_EDIT_STALE,
  ASSET_LIST_FILTER_INVALID,
  ASSET_OPERATION_CONFLICT,
  applyAssetEdit,
  getAsset,
  listAssets,
  listOperatorAssets,
} from './supported-assets.js';

/**
 * THE ONE ASSET AND NETWORK REGISTRY (W-balances-05), against real Postgres with every migration applied.
 *
 * What is asserted: nothing the owner has not published is read as published (a blank precision is left out of `list`
 * and refused by `get`); an edit lands only with an approval identity consumed for exactly that edit, that asset and
 * that revision; one operation id applies once; an edit approved against an older row refuses; and the record of who
 * changed what is append-only.
 *
 * PG-hard like the rest of this folder: TEST_DATABASE_URL, else Testcontainers, never a skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_registry_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const REQUESTER = 'founder-a';
const APPROVER = 'founder-b';
const OPERATOR = 'operator-1';

interface Proposed {
  actionType: string;
  targetService: string;
  targetId: string;
  expectedVersion: string;
  payloadHash: string;
  requesterId: string;
  approverId: string | null;
  founders: boolean;
  consumedBy?: string;
}

/**
 * Identity, as far as the ledger sees it: an approval binds action, target, version and payload hash, is consumed
 * once, and a retry under the same request id returns the consumed row (`already_consumed_by_this_request`).
 */
function fakeIdentity() {
  const rows = new Map<string, Proposed>();
  const calls: ActionApprovalConsumeInput[] = [];
  const consumer: ActionApprovalConsumer = {
    async consume(input) {
      calls.push(input);
      const row = rows.get(input.approvalId);
      if (!row) throw new ActionApprovalConsumeError('no such approval', 'action_approval.consume_failed');
      const binds =
        row.targetService === input.targetService &&
        row.targetId === input.targetId &&
        row.expectedVersion === input.expectedVersion &&
        row.payloadHash === input.payloadHash;
      if (!binds) throw new ActionApprovalConsumeError('payload_mismatch', 'action_approval.consume_failed');
      if (row.consumedBy !== undefined && row.consumedBy !== input.requestId) {
        throw new ActionApprovalConsumeError('action_approval.consumed', 'action_approval.consume_failed');
      }
      // As identity does today: a same-request retry returns the consumed row without the founder attestation, which
      // is not stored. The ledger then refuses it (fails closed) rather than applying an unattested approval.
      const again = row.consumedBy !== undefined;
      row.consumedBy = input.requestId;
      return actionApprovalSchema.parse({
        approvalId: input.approvalId,
        operationId: input.operationId,
        actionType: row.actionType,
        targetService: row.targetService,
        targetId: row.targetId,
        expectedVersion: row.expectedVersion,
        payloadHash: row.payloadHash,
        requesterId: row.requesterId,
        approverId: row.approverId,
        policyVersion: 'v1',
        createdAt: '2026-10-23T00:00:00.000Z',
        expiresAt: '2026-10-23T00:10:00.000Z',
        status: 'CONSUMED',
        ...(again ? { consumption: 'already_consumed_by_this_request' } : {}),
        ...(row.founders && !again ? { approverIsFounder: true, requesterIsFounder: true } : {}),
      }) as ActionApproval;
    },
  };
  const approve = (approvalId: string, edit: AssetEditInput, revision: number, over: Partial<Proposed> = {}) => {
    rows.set(approvalId, {
      actionType: ASSET_EDIT_ACTION_TYPE,
      targetService: 'svc-ledger',
      targetId: edit.id,
      expectedVersion: String(revision),
      payloadHash: assetEditPayloadHash(edit),
      requesterId: REQUESTER,
      approverId: APPROVER,
      founders: true,
      ...over,
    });
  };
  return { consumer, approve, calls };
}

const usdt = (over: Partial<AssetEditInput> = {}): AssetEditInput => ({
  id: 'USDT',
  kind: 'crypto',
  precision: 6,
  networks: [
    { networkId: 'tron', label: 'Tron (TRC-20)' },
    { networkId: 'ethereum', label: 'Ethereum (ERC-20)' },
  ],
  defaultNetworkId: 'ethereum',
  allowedActions: ['deposit', 'withdraw', 'trade', 'transfer'],
  state: 'active',
  reason: 'TEST: publish USDT',
  ...over,
});

describe('supported asset and network registry (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let identity: ReturnType<typeof fakeIdentity>;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_asset_registry', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    identity = fakeIdentity();
    // asset_edits is append-only by trigger; each test starts from the migrated rows with no edits.
    await db!.sql.unsafe(`ALTER TABLE asset_edits DISABLE TRIGGER asset_edits_append_only`);
    await db!.sql.unsafe(`DELETE FROM asset_edits`);
    await db!.sql.unsafe(`ALTER TABLE asset_edits ENABLE TRIGGER asset_edits_append_only`);
    await db!.sql.unsafe(`DELETE FROM assets WHERE id IN ('NEWCOIN')`);
    await db!.sql.unsafe(
      `UPDATE assets SET precision = NULL, networks = '[]', default_network_id = NULL, allowed_actions = '{}', revision = 0`,
    );
  });

  const apply = (approvalId: string, operationId: string, edit: AssetEditInput) =>
    applyAssetEdit(db!.sql, identity.consumer, OPERATOR, { approvalId, operationId, edit });

  it('publishes nothing the owner has not set: every migrated row is unpublished, listed for operators only', async () => {
    expect(await listAssets(db!.sql, {})).toEqual([]);
    await expect(getAsset(db!.sql, { assetId: 'USDT' })).rejects.toMatchObject({ code: ASSET_PRECISION_UNSET });
    await expect(getAsset(db!.sql, { assetId: 'NOPE' })).rejects.toMatchObject({ code: ASSET_NOT_FOUND });
    const operator = await listOperatorAssets(db!.sql);
    const row = operator.find((a) => a.id === 'USDT');
    expect(row).toMatchObject({ precision: null, networks: [], defaultNetworkId: null, allowedActions: [], revision: 0 });
  });

  it('applies an approved edit once and records who decided it', async () => {
    identity.approve('ap-1', usdt(), 0);
    const asset = await apply('ap-1', 'asset-edit:USDT:1', usdt());
    expect(asset).toMatchObject({ id: 'USDT', precision: 6, defaultNetworkId: 'ethereum', state: 'active', revision: 1 });
    expect(identity.calls[0]).toMatchObject({
      approvalId: 'ap-1',
      targetService: 'svc-ledger',
      targetId: 'USDT',
      expectedVersion: '0',
      payloadHash: assetEditPayloadHash(usdt()),
      requestId: 'asset-edit:USDT:1',
    });
    expect((await listAssets(db!.sql, {})).map((a) => a.id)).toEqual(['USDT']);
    expect((await listAssets(db!.sql, { action: 'withdraw' })).map((a) => a.id)).toEqual(['USDT']);
    expect(await listAssets(db!.sql, { state: 'halted' })).toEqual([]);
    const [edit] = await db!.sql`SELECT requester_id, approver_id, operator_id, revision FROM asset_edits`;
    expect(edit).toEqual({ requester_id: REQUESTER, approver_id: APPROVER, operator_id: OPERATOR, revision: 1 });
  });

  it('answers a retry of the same operation with the row, without applying it again', async () => {
    identity.approve('ap-1', usdt(), 0);
    const first = await apply('ap-1', 'asset-edit:USDT:1', usdt());
    const again = await apply('ap-1', 'asset-edit:USDT:1', usdt({ networks: [...usdt().networks].reverse() }));
    expect(again).toEqual(first);
    expect(again.revision).toBe(1);
    expect(identity.calls).toHaveLength(1);
    expect(await db!.sql`SELECT 1 FROM asset_edits`).toHaveLength(1);
  });

  it('applies two concurrent requests for the same operation once, and a retry gets the applied row', async () => {
    for (const [id, edit] of [
      ['USDT', usdt()],
      ['NEWCOIN', usdt({ id: 'NEWCOIN', networks: [], defaultNetworkId: null })],
    ] as const) {
      identity.approve(`ap-${id}`, edit, 0);
      const both = await Promise.allSettled([apply(`ap-${id}`, `op-${id}`, edit), apply(`ap-${id}`, `op-${id}`, edit)]);
      // Whichever lands second either finds the applied row (a retry) or reaches identity after the consume and is
      // refused unattested. Never a second apply, never stale.
      const values = both.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      expect(values.length).toBeGreaterThanOrEqual(1);
      for (const r of both) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'action_approval.not_founders' });
      for (const v of values) expect(v).toEqual(values[0]);
      expect(await apply(`ap-${id}`, `op-${id}`, edit)).toEqual(values[0]);
    }
    expect(await db!.sql`SELECT operation_id FROM asset_edits`).toHaveLength(2);
  });

  it('answers a retry with the row its operation produced, not a later one', async () => {
    identity.approve('ap-1', usdt(), 0);
    const first = await apply('ap-1', 'asset-edit:USDT:1', usdt());
    identity.approve('ap-2', usdt({ precision: 8 }), 1);
    await apply('ap-2', 'asset-edit:USDT:2', usdt({ precision: 8 }));
    const retry = await apply('ap-1', 'asset-edit:USDT:1', usdt());
    expect(retry).toEqual(first);
    expect(retry).toMatchObject({ precision: 6, revision: 1 });
    expect((await getAsset(db!.sql, { assetId: 'USDT' })).revision).toBe(2);
  });

  it('refuses a list filter that is not a state or action with a read code, not the edit code', async () => {
    await expect(listAssets(db!.sql, { state: 'frozen' })).rejects.toMatchObject({ code: ASSET_LIST_FILTER_INVALID });
  });

  it('fails closed after a lost reply: identity consumed, the row did not land, the approval must be given again', async () => {
    identity.approve('ap-1', usdt(), 0);
    // Identity consumed for this request, then the ledger crashed before its transaction.
    await identity.consumer.consume({
      approvalId: 'ap-1',
      operationId: 'asset-edit:USDT:1',
      payloadHash: assetEditPayloadHash(usdt()),
      targetService: 'svc-ledger',
      targetId: 'USDT',
      expectedVersion: '0',
      requestId: 'asset-edit:USDT:1',
    });
    await expect(apply('ap-1', 'asset-edit:USDT:1', usdt())).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    expect(await listAssets(db!.sql, {})).toEqual([]);
    identity.approve('ap-2', usdt(), 0);
    expect((await apply('ap-2', 'asset-edit:USDT:2', usdt())).revision).toBe(1);
  });

  it('refuses an operation id used for another edit, and changes nothing', async () => {
    identity.approve('ap-1', usdt(), 0);
    await apply('ap-1', 'asset-edit:USDT:1', usdt());
    await expect(apply('ap-1', 'asset-edit:USDT:1', usdt({ precision: 8 }))).rejects.toMatchObject({
      code: ASSET_OPERATION_CONFLICT,
    });
    expect((await getAsset(db!.sql, { assetId: 'USDT' })).precision).toBe(6);
  });

  it('refuses an edit that is not the approved one: identity sees a different payload hash', async () => {
    identity.approve('ap-1', usdt(), 0);
    await expect(apply('ap-1', 'asset-edit:USDT:1', usdt({ precision: 2 }))).rejects.toBeInstanceOf(ActionApprovalConsumeError);
    expect(await listAssets(db!.sql, {})).toEqual([]);
  });

  it('refuses an approval without a distinct founder pair attested', async () => {
    identity.approve('ap-1', usdt(), 0, { founders: false });
    await expect(apply('ap-1', 'asset-edit:USDT:1', usdt())).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    identity.approve('ap-2', usdt(), 0, { actionType: 'ledger.freeze' });
    await expect(apply('ap-2', 'asset-edit:USDT:2', usdt())).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    expect(await listAssets(db!.sql, {})).toEqual([]);
  });

  it('refuses an edit approved against an older revision once another edit has landed', async () => {
    identity.approve('ap-1', usdt(), 0);
    identity.approve('ap-2', usdt({ precision: 8 }), 0);
    await apply('ap-1', 'asset-edit:USDT:1', usdt());
    // ap-2 was approved at revision 0; the row is now at 1, so identity's version binding refuses it.
    await expect(apply('ap-2', 'asset-edit:USDT:2', usdt({ precision: 8 }))).rejects.toBeInstanceOf(ActionApprovalConsumeError);
    identity.approve('ap-3', usdt({ precision: 8, state: 'halted' }), 1);
    const halted = await apply('ap-3', 'asset-edit:USDT:3', usdt({ precision: 8, state: 'halted' }));
    expect(halted).toMatchObject({ precision: 8, state: 'halted', revision: 2 });
    expect(await listAssets(db!.sql, { state: 'active' })).toEqual([]);
  });

  it('refuses as stale when the row moved between the approval and the write', async () => {
    identity.approve('ap-1', usdt(), 0);
    const racing: ActionApprovalConsumer = {
      async consume(input) {
        const consumed = await identity.consumer.consume(input);
        await db!.sql`UPDATE assets SET revision = revision + 1 WHERE id = 'USDT'`;
        return consumed;
      },
    };
    await expect(
      applyAssetEdit(db!.sql, racing, OPERATOR, { approvalId: 'ap-1', operationId: 'asset-edit:USDT:1', edit: usdt() }),
    ).rejects.toMatchObject({ code: ASSET_EDIT_STALE });
    expect(await db!.sql`SELECT 1 FROM asset_edits`).toHaveLength(0);
  });

  it('adds a new asset at revision 1, active', async () => {
    const coin = usdt({ id: 'NEWCOIN', precision: 4, networks: [], defaultNetworkId: null, allowedActions: ['trade'] });
    identity.approve('ap-new', coin, 0);
    expect(await apply('ap-new', 'asset-edit:NEWCOIN:1', coin)).toMatchObject({ id: 'NEWCOIN', precision: 4, revision: 1 });
    const [row] = await db!.sql`SELECT precision, active FROM assets WHERE id = 'NEWCOIN'`;
    expect(row).toEqual({ precision: 4, active: true });
  });

  it('refuses a change of kind, a blank precision and an out-of-range one with their own codes, before asking identity', async () => {
    await expect(apply('ap-1', 'op-1', usdt({ kind: 'fiat' }))).rejects.toMatchObject({ code: ASSET_EDIT_INVALID });
    const blank = { ...usdt() } as Partial<AssetEditInput>;
    delete blank.precision;
    await expect(apply('ap-1', 'op-1', blank as AssetEditInput)).rejects.toMatchObject({ code: ASSET_PRECISION_UNSET });
    await expect(apply('ap-1', 'op-1', usdt({ precision: 19 }))).rejects.toMatchObject({ code: ASSET_PRECISION_INVALID });
    await expect(apply('ap-1', 'op-1', usdt({ defaultNetworkId: 'solana' }))).rejects.toMatchObject({
      code: 'ledger.asset_default_network_not_listed',
    });
    expect(identity.calls).toHaveLength(0);
  });

  it('keeps the record of edits append-only', async () => {
    identity.approve('ap-1', usdt(), 0);
    await apply('ap-1', 'asset-edit:USDT:1', usdt());
    await expect(db!.sql`UPDATE asset_edits SET operator_id = 'someone-else'`).rejects.toThrow(/append-only/);
    await expect(db!.sql`DELETE FROM asset_edits`).rejects.toThrow(/append-only/);
    await expect(db!.sql`TRUNCATE asset_edits`).rejects.toThrow(/append-only/);
    expect(await db!.sql`SELECT 1 FROM asset_edits`).toHaveLength(1);
  });
});
