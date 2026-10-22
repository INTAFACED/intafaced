import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  ASSET_EDIT_ACTION_TYPE,
  actionApprovalSchema,
  assetAllows,
  assetEditPayloadHash,
  type ActionApprovalConsumeInput,
  type AssetEditInput,
} from '@intafaced/contracts';
import { AssetRegistry, AssetRegistryError } from './asset-registry.js';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';

/** All assets, networks and figures here are TEST values. */
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => (schema: string) => rewriteSchemaSql(readFileSync(join(drizzleDir, f), 'utf8'), 'ledger', schema));

/** A fake identity: consumes each approval once, as a distinct founder pair, and records what it was asked. */
function fakeIdentity(overrides: { approverIsFounder?: boolean } = {}) {
  const seen: ActionApprovalConsumeInput[] = [];
  const used = new Set<string>();
  const consumer: ActionApprovalConsumer = {
    async consume(input) {
      seen.push(input);
      if (used.has(input.approvalId)) throw new ActionApprovalConsumeError('approval already consumed', 'action_approval.consume_failed');
      used.add(input.approvalId);
      return actionApprovalSchema.parse({
        ...input,
        actionType: ASSET_EDIT_ACTION_TYPE,
        requesterId: 'founder-a',
        approverId: 'founder-b',
        approverIsFounder: overrides.approverIsFounder ?? true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: '2026-10-22T09:00:00.000Z',
        expiresAt: '2026-10-22T09:10:00.000Z',
        status: 'CONSUMED',
      });
    },
  };
  return { consumer, seen };
}

const edit = (o: Partial<AssetEditInput> = {}): AssetEditInput => ({
  id: 'TSTA',
  kind: 'crypto',
  precision: 6,
  networks: [{ networkId: 'test-net', label: 'TEST net' }],
  defaultNetworkId: 'test-net',
  allowedActions: ['deposit', 'withdraw'],
  state: 'active',
  reason: 'TEST registry edit',
  ...o,
});

let n = 0;
const ids = () => ({ approvalId: `appr-${++n}`, operationId: `op-${n}` });

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  throw new Error('expected a refusal');
}

// PG-hard: no skip. The registry is a ledger table; a run without Postgres fails here.
describe('asset registry on ledger.assets (0025)', () => {
  let db: TestDb;
  let reg: AssetRegistry;
  beforeAll(async () => {
    db = await createTestDb({ service: 'ledger_asset_registry', url: URL, migrations });
    reg = new AssetRegistry(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql.unsafe(`ALTER TABLE asset_edits DISABLE TRIGGER asset_edits_append_only`);
    await db.sql.unsafe(`DELETE FROM asset_edits`);
    await db.sql.unsafe(`ALTER TABLE asset_edits ENABLE TRIGGER asset_edits_append_only`);
    await db.sql.unsafe(`DELETE FROM assets WHERE id LIKE 'TST%'`);
    await db.sql.unsafe(
      `UPDATE assets SET precision = NULL, networks = '[]', default_network_id = NULL, allowed_actions = '{}', state = 'active', revision = 0`,
    );
  });

  it('seeded assets have no precision yet: get refuses precision_unset, list leaves them out, decimals is not read', async () => {
    const [usd] = await db.sql<
      Array<{ decimals: number; precision: number | null }>
    >`SELECT decimals, precision FROM assets WHERE id = 'USD'`;
    expect(usd).toEqual({ decimals: 2, precision: null });
    expect(await refusal(reg.get({ assetId: 'USD' }))).toBe('ledger.asset_precision_unset');
    expect(await refusal(reg.get({ assetId: 'NOPE' }))).toBe('ledger.asset_not_found');
    expect((await reg.list({})).assets).toEqual([]);
  });

  it('an approved edit applies once, bound to the payload hash and the row revision', async () => {
    const { consumer, seen } = fakeIdentity();
    const a = ids();
    const row = await reg.applyEdit(consumer, { ...a, edit: edit() }, 'founder-a');
    expect(row).toMatchObject({ id: 'TSTA', precision: 6, revision: 1, defaultNetworkId: 'test-net', state: 'active' });
    expect(seen[0]).toMatchObject({
      targetService: 'svc-ledger',
      targetId: 'TSTA',
      expectedVersion: '0',
      payloadHash: assetEditPayloadHash(edit()),
    });
    // The same approval again: refused, and nothing changes.
    expect(await refusal(reg.applyEdit(consumer, { ...a, edit: edit() }, 'founder-a'))).toBe('action_approval.consume_failed');
    expect((await reg.get({ assetId: 'TSTA' })).revision).toBe(1);
    const [audit] = await db.sql`SELECT asset_id, revision, actor_id, approver_id FROM asset_edits`;
    expect(audit).toEqual({ asset_id: 'TSTA', revision: 1, actor_id: 'founder-a', approver_id: 'founder-b' });
    // The next edit is approved against revision 1.
    await reg.applyEdit(consumer, { ...ids(), edit: edit({ precision: 8 }) }, 'founder-a');
    expect(seen[2]?.expectedVersion).toBe('1');
    expect((await reg.get({ assetId: 'TSTA' })).precision).toBe(8);
  });

  it('deposit and withdraw read the same row and precision; list filters by action and state', async () => {
    const { consumer } = fakeIdentity();
    await reg.applyEdit(consumer, { ...ids(), edit: edit() }, 'founder-a');
    await reg.applyEdit(consumer, { ...ids(), edit: edit({ id: 'TSTB', allowedActions: ['trade'], state: 'halted' }) }, 'founder-a');
    const deposit = (await reg.list({ action: 'deposit' })).assets;
    const withdraw = (await reg.list({ action: 'withdraw' })).assets;
    expect(deposit).toEqual(withdraw);
    expect(deposit.map((a) => [a.id, a.precision])).toEqual([['TSTA', 6]]);
    expect((await reg.list({ state: 'halted' })).assets.map((a) => a.id)).toEqual(['TSTB']);
    expect(assetAllows(await reg.get({ assetId: 'TSTB' }), 'trade')).toBe(false);
  });

  it('a retired asset stays listed with its state', async () => {
    const { consumer } = fakeIdentity();
    await reg.applyEdit(consumer, { ...ids(), edit: edit() }, 'founder-a');
    await reg.applyEdit(consumer, { ...ids(), edit: edit({ state: 'retired' }) }, 'founder-a');
    expect((await reg.list({})).assets).toEqual([expect.objectContaining({ id: 'TSTA', state: 'retired' })]);
  });

  it('blank precision refuses ledger.asset_precision_unset before identity is asked', async () => {
    const { consumer, seen } = fakeIdentity();
    for (const precision of [undefined, null, '  ']) {
      expect(await refusal(reg.applyEdit(consumer, { ...ids(), edit: { ...edit(), precision } }, 'founder-a'))).toBe(
        'ledger.asset_precision_unset',
      );
    }
    expect(await refusal(reg.applyEdit(consumer, { ...ids(), edit: edit({ precision: 19 }) }, 'founder-a'))).toBe(
      'ledger.asset_precision_invalid',
    );
    expect(await refusal(reg.applyEdit(consumer, { ...ids(), edit: edit({ defaultNetworkId: 'other' }) }, 'founder-a'))).toBe(
      'ledger.asset_default_network_not_listed',
    );
    expect(seen).toHaveLength(0);
  });

  it('an edit approved against an older row refuses once another edit lands', async () => {
    const { consumer } = fakeIdentity();
    await reg.applyEdit(consumer, { ...ids(), edit: edit() }, 'founder-a');
    // Identity echoes the revision it was approved against; a second edit lands between read and write.
    const racing: ActionApprovalConsumer = {
      async consume(input) {
        const out = await consumer.consume(input);
        await reg.applyEdit(consumer, { ...ids(), edit: edit({ precision: 4 }) }, 'founder-a');
        return out;
      },
    };
    const err = await reg.applyEdit(racing, { ...ids(), edit: edit({ precision: 9 }) }, 'founder-a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssetRegistryError);
    expect((err as AssetRegistryError).message).toMatch(/changed after this edit was approved/);
    expect((await reg.get({ assetId: 'TSTA' })).precision).toBe(4);
  });

  it('a non-founder approver or a kind change refuses and writes nothing', async () => {
    const notFounder = fakeIdentity({ approverIsFounder: false });
    expect(await refusal(reg.applyEdit(notFounder.consumer, { ...ids(), edit: edit() }, 'founder-a'))).toBe('action_approval.not_founders');
    expect(await refusal(reg.get({ assetId: 'TSTA' }))).toBe('ledger.asset_not_found');
    const { consumer, seen } = fakeIdentity();
    expect(
      await refusal(
        reg.applyEdit(consumer, { ...ids(), edit: edit({ id: 'USD', kind: 'crypto', networks: [], defaultNetworkId: null }) }, 'founder-a'),
      ),
    ).toBe('ledger.asset_edit_invalid');
    expect(seen).toHaveLength(0);
  });

  it('missing approval ids refuse; asset_edits is append-only', async () => {
    const { consumer } = fakeIdentity();
    expect(await refusal(reg.applyEdit(consumer, { approvalId: '', operationId: 'op', edit: edit() }, 'founder-a'))).toBe(
      'ledger.asset_edit_invalid',
    );
    await reg.applyEdit(consumer, { ...ids(), edit: edit() }, 'founder-a');
    await expect(db.sql`DELETE FROM asset_edits`).rejects.toThrow(/append-only/);
    await expect(db.sql`UPDATE asset_edits SET actor_id = 'x'`).rejects.toThrow(/append-only/);
  });
});
