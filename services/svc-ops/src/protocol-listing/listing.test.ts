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
} from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
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

/** Identity echoes the request back as CONSUMED unless a test overrides what it says. */
function approvals(over: Partial<ActionApproval> = {}) {
  const consumed: string[] = [];
  return {
    consumed,
    async consume(input: {
      approvalId: string;
      operationId: string;
      payloadHash: string;
      targetService: string;
      targetId: string;
      expectedVersion: string;
    }): Promise<ActionApproval> {
      consumed.push(input.operationId);
      return {
        ...input,
        actionType: over.actionType ?? actionOf(input.operationId),
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
    },
  };
}
const actionOf = (operationId: string) => operationId.split(':')[0]!;

function build(opts: { store?: ListingStore | null; approver?: ReturnType<typeof approvals>; codes?: string[] | null } = {}) {
  const store = opts.store === null ? undefined : (opts.store ?? createMemoryListingStore());
  const approver = opts.approver ?? approvals();
  const router = createOpsRouter(new OpsService(), undefined, {
    approvals: approver,
    ...(store
      ? {
          protocolListing: createListingDesk({
            store,
            approvals: approver,
            reasonCodes: () => (opts.codes === undefined ? ['scam_report'] : opts.codes),
            now: () => '2026-10-20T10:00:00.000Z',
          }),
        }
      : {}),
  });
  return { router, store, approver };
}
const as = async (router: ReturnType<typeof build>['router'], scopes: string[] = ['admin:read', 'admin:write']) =>
  router.createCaller(await signed(scopes));

const hide = { chainId: 84532, poolAddress: POOL, reasonCode: 'scam_report', reason: 'reported by three users', approvalId: 'ap_1' };
const refuses = (code: string) => ({ code: 'PRECONDITION_FAILED', message: expect.stringContaining(code) });

describe('protocol listing desk', () => {
  it('hides a pool with a second founder, lists it with who and under which policy, and shows it on the public hide list', async () => {
    const { router } = build();
    const caller = await as(router);
    const key = protocolOpsIdempotencyKey('protocol.pool.hide', poolTargetId(84532, POOL), 'ap_1');
    await expect(caller.protocolListing.pools.hide(hide)).resolves.toEqual({
      action: 'protocol.pool.hide',
      targetId: poolTargetId(84532, POOL),
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
          approvalId: 'ap_1',
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

  it('replays a retry with the same approval from the stored result and consumes nothing twice', async () => {
    const { router, approver } = build();
    const caller = await as(router);
    const first = await caller.protocolListing.pools.hide(hide);
    const second = await caller.protocolListing.pools.hide(hide);
    expect(second).toEqual(first);
    expect(approver.consumed).toHaveLength(1);
  });

  it('answers a second approval on a hidden pool as a no-op with a note, still logging it', async () => {
    const { router, approver } = build();
    const caller = await as(router);
    await caller.protocolListing.pools.hide(hide);
    const again = await caller.protocolListing.pools.hide({ ...hide, approvalId: 'ap_2' });
    expect(again).toMatchObject({ outcome: 'noop', state: 'hidden', note: 'Already hidden by an earlier approval.' });
    expect(approver.consumed).toHaveLength(2);
  });

  it('restores a hidden pool, and answers a restore of a listed one as a no-op', async () => {
    const { router } = build();
    const caller = await as(router);
    await caller.protocolListing.pools.hide(hide);
    await expect(caller.protocolListing.pools.restore({ chainId: 84532, poolAddress: POOL, approvalId: 'ap_3' })).resolves.toMatchObject({
      outcome: 'applied',
      state: 'visible',
    });
    expect((await caller.protocolListing.hidden()).pools).toEqual([]);
    await expect(caller.protocolListing.pools.restore({ chainId: 84532, poolAddress: POOL, approvalId: 'ap_4' })).resolves.toMatchObject({
      outcome: 'noop',
      note: 'Already listed; nothing to restore.',
    });
  });

  it('delists and restores a market by upper-cased symbol', async () => {
    const { router } = build();
    const caller = await as(router);
    await expect(
      caller.protocolListing.markets.delist({
        symbol: ' btc-usdt ',
        reasonCode: 'scam_report',
        reason: 'wash trading',
        approvalId: 'ap_5',
      }),
    ).resolves.toMatchObject({ targetId: 'BTC-USDT', state: 'hidden', outcome: 'applied' });
    expect((await caller.protocolListing.hidden()).markets).toEqual([{ symbol: 'BTC-USDT' }]);
    await caller.protocolListing.markets.restore({ symbol: 'BTC-USDT', approvalId: 'ap_6' });
    expect((await caller.protocolListing.hidden()).markets).toEqual([]);
    expect((await caller.protocolListing.markets.list()).markets).toMatchObject([{ symbol: 'BTC-USDT', state: 'visible', hidden: null }]);
  });

  it('refuses owner.decision when the reason codes are blank, and an unknown code, before it consumes anything', async () => {
    for (const [codes, expected] of [
      [null, 'owner.decision'],
      [[], 'owner.decision'],
      [['spam'], 'protocol.ops_reason_code_unknown'],
    ] as const) {
      const { router, approver, store } = build({ codes: codes as string[] | null });
      const caller = await as(router);
      await expect(caller.protocolListing.pools.hide(hide)).rejects.toMatchObject(refuses(expected));
      expect(approver.consumed).toHaveLength(0);
      expect(await store!.list('pool')).toEqual([]);
    }
  });

  it('refuses without an approval, with an approval for another action, and when identity is unwired', async () => {
    const { router } = build();
    const caller = await as(router);
    await expect(caller.protocolListing.pools.hide({ ...hide, approvalId: '  ' })).rejects.toMatchObject(
      refuses('action_approval.missing'),
    );
    const wrong = build({ approver: approvals({ actionType: 'ops.venue_cost.record' }) });
    await expect((await as(wrong.router)).protocolListing.pools.hide(hide)).rejects.toMatchObject(refuses('action_approval.wrong_action'));
    expect(await wrong.store!.list('pool')).toEqual([]);

    const unwired = createOpsRouter(new OpsService(), undefined, {
      protocolListing: createListingDesk({
        store: createMemoryListingStore(),
        approvals: undefined,
        reasonCodes: () => ['scam_report'],
        now: () => '2026-10-20T10:00:00.000Z',
      }),
    });
    await expect((await as(unwired)).protocolListing.pools.hide(hide)).rejects.toMatchObject(refuses('action_approval.identity_unwired'));
  });

  it('refuses when the approver is not a distinct founder, and nothing is hidden', async () => {
    const { router, store } = build({ approver: approvals({ approverIsFounder: false }) });
    await expect((await as(router)).protocolListing.pools.hide(hide)).rejects.toMatchObject(refuses('action_approval.not_founders'));
    expect(await store!.list('pool')).toEqual([]);
  });

  it('keeps writes behind admin:write and lists behind admin:read', async () => {
    const { router } = build();
    const reader = await as(router, ['admin:read']);
    await expect(reader.protocolListing.pools.hide(hide)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = await as(router, ['admin:write']);
    await expect(writer.protocolListing.pools.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('without storage, writes and reads refuse, and the public hide list is never taken for empty', async () => {
    const { router } = build({ store: null });
    const caller = await as(router);
    await expect(caller.protocolListing.pools.hide(hide)).rejects.toMatchObject(refuses('ops.protocol_listing_storage_unconfigured'));
    await expect(caller.protocolListing.hidden()).rejects.toMatchObject(refuses('ops.protocol_listing_storage_unconfigured'));
    await expect(caller.protocolListing.pools.list()).rejects.toMatchObject(refuses('ops.protocol_listing_storage_unconfigured'));
  });

  it('rejects a malformed pool address and any extra field', async () => {
    const caller = await as(build().router);
    await expect(caller.protocolListing.pools.hide({ ...hide, poolAddress: '0x1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.protocolListing.pools.hide({ ...hide, extra: 1 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

const decision = (over: Partial<Parameters<ListingStore['record']>[0]> = {}): Parameters<ListingStore['record']>[0] => ({
  idempotencyKey: 'protocol.pool.hide:84532:0xabc:ap_1',
  action: 'protocol.pool.hide',
  kind: 'pool',
  targetId: '84532:0xabc',
  outcome: 'applied',
  note: null,
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
        await store.record(
          decision({ idempotencyKey: 'protocol.pool.hide:84532:0xabc:ap_2', outcome: 'noop', approvalId: 'ap_2', reason: 'later' }),
          '2026-10-20T12:00:00.000Z',
        );
        expect(await store.state('pool', '84532:0xabc')).toMatchObject({ reason: 'TEST', approvalId: 'ap_1' });
        expect(await store.list('market')).toEqual([]);
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
