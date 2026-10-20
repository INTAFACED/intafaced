import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase } from '@intafaced/db';
import {
  createEdgeContext,
  encodePrincipal,
  poolTargetId,
  protocolOpsIdempotencyKey,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { approvalPayloadHash } from '../operator-desks.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createListingDesk } from './wiring.js';
import { createMemoryListingStore, createPgListingStore, type ListingStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const POOL = '0x' + 'aB'.repeat(20);
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

/**
 * A stand-in for identity that enforces what identity enforces: an approval is proposed for one action, target, payload and
 * operation id, is spent once, and is spent again only by the same request id.
 */
function identity(over: Partial<ActionApproval> = {}) {
  type Row = { approval: ActionApproval; consumedBy: string | null };
  const rows = new Map<string, Row>();
  let n = 0;
  const reject = (code: string): never => {
    throw new Error(code);
  };
  return {
    consumed: () => [...rows.values()].filter((r) => r.consumedBy !== null).length,
    /** The two founders agree to exactly this action; the caller carries the returned ids. */
    propose(actionType: string, targetId: string, fields: Record<string, string>) {
      n += 1;
      const approval: ActionApproval = {
        approvalId: `ap_${n}`,
        operationId: `op_${n}`,
        payloadHash: approvalPayloadHash(actionType, fields),
        targetService: 'svc-ops',
        targetId,
        expectedVersion: '1',
        actionType,
        requesterId: USER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'p1',
        createdAt: '2026-10-20T00:00:00.000Z',
        expiresAt: '2026-10-20T00:10:00.000Z',
        status: 'CONSUMED',
        ...over,
      };
      rows.set(approval.approvalId, { approval, consumedBy: null });
      return { approvalId: approval.approvalId, operationId: approval.operationId };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId) ?? reject('action_approval.not_found');
      const a = row!.approval;
      if (row!.consumedBy !== null) {
        if (input.requestId === undefined || input.requestId !== row!.consumedBy) reject('action_approval.consumed');
      } else if (input.targetService !== a.targetService) reject('action_approval.service_mismatch');
      if (input.payloadHash !== a.payloadHash) reject('action_approval.payload_mismatch');
      if (input.targetId !== a.targetId || input.expectedVersion !== a.expectedVersion || input.operationId !== a.operationId) {
        reject('action_approval.target_mismatch');
      }
      row!.consumedBy = input.requestId ?? '(none)';
      return a;
    },
  };
}

const HIDE_FIELDS = { reasonCode: 'scam_report', reason: 'reported by three users' };

function build(opts: { store?: ListingStore | null; ids?: ReturnType<typeof identity>; codes?: string[] | null } = {}) {
  const store = opts.store === null ? undefined : (opts.store ?? createMemoryListingStore());
  const ids = opts.ids ?? identity();
  const router = createOpsRouter(new OpsService(), undefined, {
    approvals: ids,
    ...(store
      ? {
          protocolListing: createListingDesk({
            store,
            approvals: ids,
            reasonCodes: () => (opts.codes === undefined ? ['scam_report'] : opts.codes),
            now: () => '2026-10-20T10:00:00.000Z',
          }),
        }
      : {}),
  });
  return { router, store, ids };
}
const as = async (router: ReturnType<typeof build>['router'], scopes: string[] = ['admin:read', 'admin:write']) =>
  router.createCaller(await signed(scopes));

const POOL_ID = poolTargetId(84532, POOL);
/** Propose the matching approval, then the exact input a founder UI would send. */
const hideInput = (ids: ReturnType<typeof identity>, over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  poolAddress: POOL,
  ...HIDE_FIELDS,
  ...ids.propose('protocol.pool.hide', POOL_ID, { targetId: POOL_ID, ...HIDE_FIELDS }),
  ...over,
});
const restoreInput = (ids: ReturnType<typeof identity>, over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  poolAddress: POOL,
  ...ids.propose('protocol.pool.restore', POOL_ID, { targetId: POOL_ID }),
  ...over,
});
const refuses = (code: string) => ({ code: 'PRECONDITION_FAILED', message: expect.stringContaining(code) });

describe('protocol listing desk', () => {
  it('hides a pool with a second founder, lists it with who and under which policy, and shows it on the public hide list', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    const input = hideInput(ids);
    const key = protocolOpsIdempotencyKey('protocol.pool.hide', POOL_ID, input.approvalId);
    await expect(caller.protocolListing.pools.hide(input)).resolves.toEqual({
      action: 'protocol.pool.hide',
      targetId: POOL_ID,
      state: 'hidden',
      outcome: 'applied',
      note: null,
      idempotencyKey: key,
    });
    const list = await caller.protocolListing.pools.list();
    expect(list.pools).toEqual([
      {
        chainId: 84532,
        poolAddress: POOL.toLowerCase(),
        state: 'hidden',
        hidden: {
          reasonCode: 'scam_report',
          reason: 'reported by three users',
          approvalId: input.approvalId,
          policyVersion: 'p1',
          at: '2026-10-20T10:00:00.000Z',
        },
      },
    ]);
    // The public read needs no scope and carries no reason and no signer.
    const anon = router.createCaller(await signed([]));
    await expect(anon.protocolListing.hidden()).resolves.toEqual({
      asOf: '2026-10-20T10:00:00.000Z',
      pools: [{ chainId: 84532, poolAddress: POOL.toLowerCase() }],
      markets: [],
    });
  });

  it('replays a retry with the same approval from the stored result and spends nothing twice', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    const input = hideInput(ids);
    const first = await caller.protocolListing.pools.hide(input);
    expect(await caller.protocolListing.pools.hide(input)).toEqual(first);
    expect(ids.consumed()).toBe(1);
  });

  it('survives a crash between spending the approval and writing the decision: the retry is not refused as consumed', async () => {
    const real = createMemoryListingStore();
    let crashes = 1;
    const store: ListingStore = {
      ...real,
      record: async (draft, at) => {
        if (crashes-- > 0) throw new Error('process died after consume');
        return real.record(draft, at);
      },
    };
    const { router, ids } = build({ store });
    const caller = await as(router);
    const input = hideInput(ids);
    await expect(caller.protocolListing.pools.hide(input)).rejects.toThrow('process died after consume');
    expect(ids.consumed()).toBe(1);
    await expect(caller.protocolListing.pools.hide(input)).resolves.toMatchObject({ outcome: 'applied', state: 'hidden' });
    expect(await real.list('pool')).toHaveLength(1);
  });

  it('refuses a different caller reusing a spent approval, and a changed reason, before anything is hidden', async () => {
    const { router, ids, store } = build();
    const caller = await as(router);
    const input = hideInput(ids);
    await caller.protocolListing.pools.hide(input);
    // Another approval id with the first one's payload: identity has no such approval.
    await expect(caller.protocolListing.pools.hide({ ...input, approvalId: 'ap_other' })).rejects.toThrow(/not_found/);

    const changed = hideInput(ids, { reason: 'a different reason than the founders signed' });
    await expect(caller.protocolListing.pools.hide(changed)).rejects.toMatchObject(refuses('action_approval.payload_mismatch'));
    expect((await store!.list('pool')).map((r) => r.reason)).toEqual(['reported by three users']);
  });

  it('refuses an operation id that is not the one identity issued, and a target the founders did not sign', async () => {
    const { router, ids, store } = build();
    const caller = await as(router);
    await expect(caller.protocolListing.pools.hide(hideInput(ids, { operationId: 'op_invented' }))).rejects.toMatchObject(
      refuses('action_approval.target_mismatch'),
    );
    await expect(caller.protocolListing.pools.hide(hideInput(ids, { chainId: 1 }))).rejects.toMatchObject(
      refuses('action_approval.payload_mismatch'),
    );
    expect(await store!.list('pool')).toEqual([]);
  });

  it('answers a second approval on a hidden pool as a no-op with a note, still logging it', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    await caller.protocolListing.pools.hide(hideInput(ids));
    const again = await caller.protocolListing.pools.hide(hideInput(ids));
    expect(again).toMatchObject({ outcome: 'noop', state: 'hidden', note: 'Already hidden by an earlier approval.' });
    expect(ids.consumed()).toBe(2);
  });

  it('restores a hidden pool, and answers a restore of a listed one as a no-op', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    await caller.protocolListing.pools.hide(hideInput(ids));
    await expect(caller.protocolListing.pools.restore(restoreInput(ids))).resolves.toMatchObject({ outcome: 'applied', state: 'visible' });
    expect((await caller.protocolListing.hidden()).pools).toEqual([]);
    await expect(caller.protocolListing.pools.restore(restoreInput(ids))).resolves.toMatchObject({
      outcome: 'noop',
      note: 'Already listed; nothing to restore.',
    });
  });

  it('delists and restores a market by upper-cased symbol', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    const fields = { reasonCode: 'scam_report', reason: 'wash trading' };
    await expect(
      caller.protocolListing.markets.delist({
        symbol: ' btc-usdt ',
        ...fields,
        ...ids.propose('protocol.market.delist', 'BTC-USDT', { targetId: 'BTC-USDT', ...fields }),
      }),
    ).resolves.toMatchObject({ targetId: 'BTC-USDT', state: 'hidden', outcome: 'applied' });
    expect((await caller.protocolListing.hidden()).markets).toEqual([{ symbol: 'BTC-USDT' }]);
    await caller.protocolListing.markets.restore({
      symbol: 'BTC-USDT',
      ...ids.propose('protocol.market.restore', 'BTC-USDT', { targetId: 'BTC-USDT' }),
    });
    expect((await caller.protocolListing.hidden()).markets).toEqual([]);
    expect((await caller.protocolListing.markets.list()).markets).toMatchObject([{ symbol: 'BTC-USDT', state: 'visible', hidden: null }]);
  });

  it('refuses owner.decision when the reason codes are blank, and an unknown code, before it consumes anything', async () => {
    for (const [codes, expected] of [
      [null, 'owner.decision'],
      [[], 'owner.decision'],
      [['spam'], 'protocol.ops_reason_code_unknown'],
    ] as const) {
      const { router, ids, store } = build({ codes: codes as string[] | null });
      const caller = await as(router);
      await expect(caller.protocolListing.pools.hide(hideInput(ids))).rejects.toMatchObject(refuses(expected));
      expect(ids.consumed()).toBe(0);
      expect(await store!.list('pool')).toEqual([]);
    }
  });

  it('refuses without an approval, with an approval for another action, and when identity is unwired', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    await expect(caller.protocolListing.pools.hide(hideInput(ids, { approvalId: '  ' }))).rejects.toMatchObject(
      refuses('action_approval.missing'),
    );
    // An approval proposed for another action carries another payload hash, so it cannot be spent here.
    const other = ids.propose('ops.venue_cost.record', POOL_ID, { targetId: POOL_ID, ...HIDE_FIELDS });
    await expect(caller.protocolListing.pools.hide(hideInput(ids, other))).rejects.toMatchObject(
      refuses('action_approval.payload_mismatch'),
    );

    const unwired = createOpsRouter(new OpsService(), undefined, {
      protocolListing: createListingDesk({
        store: createMemoryListingStore(),
        approvals: undefined,
        reasonCodes: () => ['scam_report'],
        now: () => '2026-10-20T10:00:00.000Z',
      }),
    });
    await expect((await as(unwired)).protocolListing.pools.hide(hideInput(ids))).rejects.toMatchObject(
      refuses('action_approval.identity_unwired'),
    );
  });

  it('refuses when the approver is not a distinct founder, and nothing is hidden', async () => {
    const ids = identity({ approverIsFounder: false });
    const { router, store } = build({ ids });
    await expect((await as(router)).protocolListing.pools.hide(hideInput(ids))).rejects.toMatchObject(
      refuses('action_approval.not_founders'),
    );
    expect(await store!.list('pool')).toEqual([]);
  });

  it('keeps writes behind admin:write and lists behind admin:read', async () => {
    const { router, ids } = build();
    const reader = await as(router, ['admin:read']);
    await expect(reader.protocolListing.pools.hide(hideInput(ids))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = await as(router, ['admin:write']);
    await expect(writer.protocolListing.pools.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('without storage, writes and reads refuse, and the public hide list is never taken for empty', async () => {
    const { router, ids } = build({ store: null });
    const caller = await as(router);
    await expect(caller.protocolListing.pools.hide(hideInput(ids))).rejects.toMatchObject(
      refuses('ops.protocol_listing_storage_unconfigured'),
    );
    await expect(caller.protocolListing.hidden()).rejects.toMatchObject(refuses('ops.protocol_listing_storage_unconfigured'));
    await expect(caller.protocolListing.pools.list()).rejects.toMatchObject(refuses('ops.protocol_listing_storage_unconfigured'));
  });

  it('rejects a malformed pool address, a missing operation id and any extra field', async () => {
    const { router, ids } = build();
    const caller = await as(router);
    await expect(caller.protocolListing.pools.hide(hideInput(ids, { poolAddress: '0x1' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.protocolListing.pools.hide(hideInput(ids, { operationId: undefined }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.protocolListing.pools.hide(hideInput(ids, { extra: 1 }) as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

const decision = (over: Partial<Parameters<ListingStore['record']>[0]> = {}): Parameters<ListingStore['record']>[0] => ({
  idempotencyKey: 'protocol.pool.hide:84532:0xabc:ap_1',
  action: 'protocol.pool.hide',
  kind: 'pool',
  targetId: '84532:0xabc',
  state: 'hidden',
  reasonCode: 'scam_report',
  reason: 'TEST',
  approvalId: 'ap_1',
  requesterId: USER,
  approverId: APPROVER,
  policyVersion: 'p1',
  ...over,
});

function storeContract(name: string, open: () => Promise<{ store: ListingStore; close: () => Promise<void> }>) {
  describe(name, () => {
    it('writes a decision once, returns the stored one on a repeat key, and a no-op never moves the state', async () => {
      const { store, close } = await open();
      try {
        const first = await store.record(decision(), '2026-10-20T10:00:00.000Z');
        const repeat = await store.record(decision({ reason: 'different text' }), '2026-10-20T11:00:00.000Z');
        expect(repeat).toEqual(first);
        expect(await store.state('pool', '84532:0xabc')).toMatchObject({
          state: 'hidden',
          reason: 'TEST',
          updatedAt: '2026-10-20T10:00:00.000Z',
        });
        expect(first.outcome).toBe('applied');
        const second = await store.record(
          decision({ idempotencyKey: 'protocol.pool.hide:84532:0xabc:ap_2', approvalId: 'ap_2', reason: 'later' }),
          '2026-10-20T12:00:00.000Z',
        );
        expect(second).toMatchObject({ outcome: 'noop', note: 'Already hidden by an earlier approval.' });
        expect(await store.state('pool', '84532:0xabc')).toMatchObject({ reason: 'TEST', approvalId: 'ap_1' });
        expect(await store.list('market')).toEqual([]);
      } finally {
        await close();
      }
    });

    it('lets two racing approvals on one target apply once and answer the other as a no-op', async () => {
      const { store, close } = await open();
      try {
        const results = await Promise.all(
          ['ap_1', 'ap_2'].map((approvalId) =>
            store.record(
              decision({ idempotencyKey: `protocol.pool.hide:84532:0xabc:${approvalId}`, approvalId }),
              '2026-10-20T10:00:00.000Z',
            ),
          ),
        );
        expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'noop']);
      } finally {
        await close();
      }
    });

    it('lets two racing calls with one key write one decision', async () => {
      const { store, close } = await open();
      try {
        const results = await Promise.all([
          store.record(decision(), '2026-10-20T10:00:00.000Z'),
          store.record(decision(), '2026-10-20T10:00:00.000Z'),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect(await store.list('pool')).toHaveLength(1);
      } finally {
        await close();
      }
    });
  });
}

storeContract('memory listing store', async () => ({ store: createMemoryListingStore(), close: async () => undefined }));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('durable protocol listing on real PostgreSQL', () => {
  const open = async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    await migrateOutreach(sql);
    return {
      sql,
      store: createPgListingStore(sql),
      close: async () => {
        await sql.end();
        await database.drop();
      },
    };
  };
  storeContract('postgres listing store', open);

  it('refuses to change or delete a decision, an unknown kind and an unknown state', async () => {
    const { sql, store, close } = await open();
    try {
      await store.record(decision(), '2026-10-20T10:00:00.000Z');
      await expect(sql`UPDATE ops.protocol_listing_decisions SET note='x'`).rejects.toThrow(/protocol_listing_decision_immutable/);
      await expect(sql`DELETE FROM ops.protocol_listing_decisions`).rejects.toThrow(/protocol_listing_decision_immutable/);
      await expect(
        sql`INSERT INTO ops.protocol_listing_overrides (kind,target_id,state,approval_id,policy_version) VALUES ('token','x','hidden','a','p')`,
      ).rejects.toThrow();
      await expect(
        sql`INSERT INTO ops.protocol_listing_overrides (kind,target_id,state,approval_id,policy_version) VALUES ('pool','x','applying','a','p')`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('keeps the down migration from dropping a log that has decisions', async () => {
    const { sql, store, close } = await open();
    try {
      await store.record(decision(), '2026-10-20T10:00:00.000Z');
      await expect(migrateOutreach(sql, 'down')).rejects.toThrow(/archive them before rolling back/);
    } finally {
      await close();
    }
  });
});
