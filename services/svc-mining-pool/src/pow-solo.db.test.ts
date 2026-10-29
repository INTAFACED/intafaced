import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { payWindow, runEpochPayoutTick } from './epoch-jobs.js';
import { failingPow, grindPow, powHeader, type PowSpec } from './pow.js';
import { createMiningRouter } from './router.js';
import { MiningReadStore } from './reads.js';
import { handleSubmitSharePost } from './submit-share.js';

const SECRET = 'mining-pow-db-edge-secret-32chars!!';
const HMAC = 'mining-pow-db-hmac-secret-32chars!!!';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const WINDOW = 'w-pow';
const SPEC: PowSpec = { dimension: 8, targetBits: 8, testnet: true };
const POW: NodeJS.ProcessEnv = { MINING_POW_DIMENSION: '8', MINING_POW_TARGET_BITS: '8', MINING_POW_TESTNET: 'true' };
const migration = (name: string) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');

function databaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL required for mining proof-of-work and solo tests');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-mining-pool' });

function signed(userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: userId,
  });
}

describe('mining proof of work and solo mode', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
    vi.stubEnv('APP_ENV', 'test');
    db = await createTestDatabase({
      service: 'mining_pool',
      url: databaseUrl(),
      migrations: [
        migration('0000_mining_pool_init.sql'),
        migration('0001_blank_reward_share.sql'),
        migration('0002_mining_reads.sql'),
        migration('0003_share_workers.sql'),
        migration('0004_pow_solo.sql'),
      ],
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  beforeEach(async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
    vi.stubEnv('APP_ENV', 'test');
    await db.truncateAll();
  });

  const post = (body: unknown, env: NodeJS.ProcessEnv = POW) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    return handleSubmitSharePost({
      rawBody,
      sql: db.sql,
      secret: HMAC,
      headers: serviceAuthHeadersForBody('svc-cron', HMAC, rawBody),
      env,
    });
  };
  const work = (shareId: string, workerName: string, nonce: string, minerId = ALICE) => ({
    windowId: WINDOW,
    assetId: 'IFC',
    shares: [{ shareId, minerId, workerName, powNonce: nonce }],
  });
  const good = (workerName: string, minerId = ALICE, start = 0) => grindPow(SPEC, powHeader(WINDOW, minerId, workerName), start);
  const bad = (workerName: string, minerId = ALICE) => failingPow(SPEC, powHeader(WINDOW, minerId, workerName));
  const router = (env: NodeJS.ProcessEnv = POW) => createMiningRouter(new MiningReadStore(db.sql, null), undefined, { env });
  const shares = () => db.sql`SELECT share_id, weight::text AS weight, pow_nonce, solo, testnet FROM mining_pool.shares ORDER BY share_id`;

  it('a valid share is stored at weight 1 with its nonce; the pool never takes a weight from the rig', async () => {
    const nonce = good('Rig-A');
    expect(await post(work('s-good', 'Rig-A', nonce))).toMatchObject({ status: 200 });
    expect(await shares()).toEqual([{ share_id: 's-good', weight: '1', pow_nonce: nonce, solo: false, testnet: true }]);
    const weighed = work('s-weighed', 'Rig-A', good('Rig-A', ALICE, Number.parseInt(nonce, 16) + 1));
    weighed.shares[0] = { ...weighed.shares[0]!, weight: '1000' } as (typeof weighed.shares)[0];
    expect(await post(weighed)).toEqual({ status: 409, body: { accepted: false, error: 'mining.pow_weight_from_client' } });
    expect(await shares()).toHaveLength(1);
  });

  it('an invalid share is refused mining.pow_invalid with one rejection row, and the batch keeps nothing', async () => {
    const batch = {
      windowId: WINDOW,
      assetId: 'IFC',
      shares: [
        { shareId: 's-ok', minerId: ALICE, workerName: 'Rig-A', powNonce: good('Rig-A') },
        { shareId: 's-bad', minerId: ALICE, workerName: 'Rig-A', powNonce: bad('Rig-A') },
      ],
    };
    expect(await post(batch)).toEqual({ status: 409, body: { accepted: false, error: 'mining.pow_invalid' } });
    expect(await post(batch)).toEqual({ status: 409, body: { accepted: false, error: 'mining.pow_invalid' } });
    expect(await shares()).toEqual([]);
    const rejections = () =>
      db.sql`SELECT idempotency_key, window_id, miner_id, reason_code FROM mining_pool.share_rejections ORDER BY window_id`;
    expect(await rejections()).toEqual([
      {
        idempotency_key: expect.stringMatching(/^pow-invalid:[0-9a-f]{64}$/),
        window_id: WINDOW,
        miner_id: ALICE,
        reason_code: 'mining.pow_invalid',
      },
    ]);
    // The same share id failing in another window is that window's own refusal, never a key conflict.
    const elsewhere = {
      ...batch,
      windowId: 'w-pow-2',
      shares: [{ shareId: 's-bad', minerId: ALICE, workerName: 'Rig-A', powNonce: failingPow(SPEC, powHeader('w-pow-2', ALICE, 'Rig-A')) }],
    };
    expect(await post(elsewhere)).toEqual({ status: 409, body: { accepted: false, error: 'mining.pow_invalid' } });
    const both = await rejections();
    expect(both.map((row) => [row.window_id, row.reason_code])).toEqual([
      [WINDOW, 'mining.pow_invalid'],
      ['w-pow-2', 'mining.pow_invalid'],
    ]);
    expect(both[0]!.idempotency_key).not.toBe(both[1]!.idempotency_key);
    // A long share id still names its refusal: the key is a fixed-length hash of the window, account, rig and share.
    const long = { ...batch, shares: [{ shareId: 's'.repeat(300), minerId: ALICE, workerName: 'Rig-A', powNonce: bad('Rig-A') }] };
    expect(await post(long)).toEqual({ status: 409, body: { accepted: false, error: 'mining.pow_invalid' } });
    expect(await rejections()).toHaveLength(3);
    await db.sql`DELETE FROM mining_pool.share_rejections`;
    // Work ground for another rig or account is not this rig's work.
    expect((await post(work('s-moved', 'Rig-A', good('Rig-B')))).body).toEqual({ accepted: false, error: 'mining.pow_invalid' });
    expect((await post(work('s-other', 'Rig-A', good('Rig-A', BOB)))).body).toEqual({ accepted: false, error: 'mining.pow_invalid' });
    expect(await shares()).toEqual([]);
  });

  it('a share without work is refused mining.pow_missing once parameters are published', async () => {
    const legacy = { windowId: WINDOW, assetId: 'IFC', shares: [{ shareId: 's-legacy', minerId: ALICE, weight: '1' }] };
    expect(await post(legacy)).toEqual({ status: 409, body: { accepted: false, error: 'mining.pow_missing' } });
    expect(await shares()).toEqual([]);
  });

  it('the same work under a new share id is a duplicate and counts once', async () => {
    const nonce = good('Rig-A');
    expect((await post(work('s-1', 'Rig-A', nonce))).status).toBe(200);
    expect(await post(work('s-2', 'Rig-A', nonce))).toEqual({ status: 409, body: { accepted: false, error: 'mining.share_duplicate' } });
    expect(await shares()).toEqual([{ share_id: 's-1', weight: '1', pow_nonce: nonce, solo: false, testnet: true }]);
  });

  it('blank parameters: work refuses mining.pow_spec_unset and stores nothing; a share without work goes on as before', async () => {
    expect(await post(work('s-w', 'Rig-A', good('Rig-A')), {})).toEqual({
      status: 409,
      body: { accepted: false, error: 'mining.pow_spec_unset' },
    });
    expect(await shares()).toEqual([]);
    const legacy = { windowId: WINDOW, assetId: 'IFC', shares: [{ shareId: 's-legacy', minerId: ALICE, weight: '4' }] };
    expect((await post(legacy, {})).status).toBe(200);
    expect(await shares()).toEqual([{ share_id: 's-legacy', weight: '4', pow_nonce: null, solo: false, testnet: false }]);
  });

  it('a partial set refuses mining.pow_spec_unset and a mainnet set refuses audit.external, before anything is stored', async () => {
    expect((await post(work('s-p', 'Rig-A', good('Rig-A')), { ...POW, MINING_POW_TARGET_BITS: '' })).body).toEqual({
      accepted: false,
      error: 'mining.pow_spec_unset',
    });
    expect((await post(work('s-m', 'Rig-A', good('Rig-A')), { ...POW, MINING_POW_TESTNET: 'false' })).body).toEqual({
      accepted: false,
      error: 'audit.external',
    });
    expect(await shares()).toEqual([]);
  });

  it('the pow read names the published TEST testnet set, or blank with its code, and never serves mainnet', async () => {
    const caller = (env: NodeJS.ProcessEnv) => router(env).createCaller(signed(ALICE, ['identity:read']));
    expect(await caller(POW).pow()).toEqual({ status: 'published', dimension: 8, targetBits: 8, testnet: true });
    expect(await caller({}).pow()).toEqual({ status: 'unset', code: 'mining.pow_spec_unset' });
    await expect(caller({ ...POW, MINING_POW_TESTNET: 'false' }).pow()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'audit.external' },
    });
    await expect(caller({ ...POW, MINING_POW_DIMENSION: '' }).pow()).rejects.toMatchObject({ cause: { code: 'mining.pow_spec_unset' } });
  });

  it('setMode saves solo for the caller rig, again changes nothing, and the roster reads it back', async () => {
    const alice = router().createCaller(signed(ALICE, ['ledger:read', 'trade:write']));
    const saved = await alice.workers.setMode({ name: 'Rig-S', mode: 'solo' });
    expect(saved).toMatchObject({ name: 'Rig-S', mode: 'solo' });
    expect(await alice.workers.setMode({ name: 'Rig-S', mode: 'solo' })).toEqual(saved);
    const mine = await alice.workers.mine({ windowMinutes: 60 });
    expect(mine.workers.map((worker) => [worker.name, worker.mode])).toEqual([['Rig-S', 'solo']]);
    // Another account's rig of the same name is its own worker, still pooled.
    const bob = router().createCaller(signed(BOB, ['ledger:read', 'trade:write']));
    expect((await bob.workers.mine({ windowMinutes: 60 })).workers).toEqual([]);
    expect(await bob.workers.setMode({ name: 'Rig-S', mode: 'pooled' })).toMatchObject({ mode: 'pooled' });
    expect(saved.id).not.toBe((await bob.workers.mine({ windowMinutes: 60 })).workers[0]!.id);
    expect((await alice.workers.mine({ windowMinutes: 60 })).workers[0]).toMatchObject({ mode: 'solo' });
  });

  it('setMode needs the rig write scope and a rig name', async () => {
    await expect(
      router()
        .createCaller(signed(ALICE, ['ledger:read']))
        .workers.setMode({ name: 'Rig-S', mode: 'solo' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const alice = router().createCaller(signed(ALICE, ['trade:write']));
    for (const name of ['', 'a b', 'x'.repeat(65), 'a:b']) {
      await expect(alice.workers.setMode({ name, mode: 'solo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(alice.workers.setMode({ name: 'Rig-S', mode: 'mainnet' as 'solo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.sql`SELECT name FROM mining_pool.workers`).toEqual([]);
  });

  it('a mode change is refused mining.mode_change_in_window while the rig has open-window shares, and the mode stays', async () => {
    expect((await post(work('s-a', 'Rig-A', good('Rig-A')))).status).toBe(200);
    const alice = router().createCaller(signed(ALICE, ['ledger:read', 'trade:write']));
    await expect(alice.workers.setMode({ name: 'Rig-A', mode: 'solo' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'mining.mode_change_in_window' },
    });
    expect((await alice.workers.mine({ windowMinutes: 60 })).workers.map((worker) => [worker.name, worker.mode])).toEqual([
      ['Rig-A', 'pooled'],
    ]);
    // Saving the mode it already has is not a change.
    expect(await alice.workers.setMode({ name: 'Rig-A', mode: 'pooled' })).toMatchObject({ mode: 'pooled' });
    // Once the window is closed the rig may change.
    await db.sql`UPDATE mining_pool.windows SET status = 'paid' WHERE window_id = ${WINDOW}`;
    expect(await alice.workers.setMode({ name: 'Rig-A', mode: 'solo' })).toMatchObject({ mode: 'solo' });
  });

  it('solo shares stay out of the PPLNS window: pending, the operator window and the payout split', async () => {
    const alice = router().createCaller(signed(ALICE, ['ledger:read', 'trade:write']));
    await alice.workers.setMode({ name: 'Rig-S', mode: 'solo' });
    expect((await post(work('s-pooled', 'Rig-A', good('Rig-A')))).status).toBe(200);
    expect((await post(work('s-solo', 'Rig-S', good('Rig-S')))).status).toBe(200);
    expect((await post(work('s-bob', 'Rig-B', good('Rig-B', BOB), BOB))).status).toBe(200);
    expect(await shares()).toEqual([
      expect.objectContaining({ share_id: 's-bob', solo: false }),
      expect.objectContaining({ share_id: 's-pooled', solo: false }),
      expect.objectContaining({ share_id: 's-solo', solo: true }),
    ]);
    const pending = (await alice.windows.pending()).windows.find((window) => window.windowId === WINDOW);
    expect(pending).toMatchObject({ callerWeight: '1', totalWeight: '2' });
    const ops = await router()
      .createCaller(signed(ALICE, ['admin:read']))
      .ops.windows();
    expect(ops.windows.find((window) => window.windowId === WINDOW)).toMatchObject({ shareCount: 2, totalWeight: '2' });
  });

  it('a window of testnet work credits nothing: the payout refuses mining.testnet_no_credit, posts nothing and closes it', async () => {
    expect((await post(work('s-a', 'Rig-A', good('Rig-A')))).status).toBe(200);
    await db.sql`UPDATE mining_pool.windows SET epoch = 3, reward = 10, fee_bps = 100 WHERE window_id = ${WINDOW}`;
    const ledger = new MemoryLedger();
    const posted = vi.spyOn(ledger, 'post');
    const alice = router().createCaller(signed(ALICE, ['ledger:read', 'trade:write']));
    await expect(alice.workers.setMode({ name: 'Rig-A', mode: 'solo' })).rejects.toMatchObject({
      cause: { code: 'mining.mode_change_in_window' },
    });
    await expect(runEpochPayoutTick({ sql: db.sql, ledger })).rejects.toThrow('mining.testnet_no_credit');
    expect(posted).not.toHaveBeenCalled();
    expect(await db.sql`SELECT status FROM mining_pool.windows WHERE window_id = ${WINDOW}`).toEqual([{ status: 'no_credit' }]);
    const ops = await router()
      .createCaller(signed(ALICE, ['admin:read']))
      .ops.windows();
    expect(ops.windows.find((window) => window.windowId === WINDOW)).toMatchObject({ status: 'no_credit' });
    // Closed, it is never paid again, and its rig may change mode.
    await expect(payWindow(db.sql, ledger, WINDOW)).resolves.toBeUndefined();
    expect(await runEpochPayoutTick({ sql: db.sql, ledger })).toEqual({ paid: [], refused: [] });
    expect(posted).not.toHaveBeenCalled();
    expect(await alice.workers.setMode({ name: 'Rig-A', mode: 'solo' })).toMatchObject({ mode: 'solo' });
  });

  it("the testnet stamp is the stored work, not today's settings: unchecked work in another window is not stamped and keeps its own refusal", async () => {
    expect((await post(work('s-a', 'Rig-A', good('Rig-A')))).status).toBe(200);
    const legacy = { windowId: 'w-legacy', assetId: 'IFC', shares: [{ shareId: 's-legacy', minerId: ALICE, weight: '4' }] };
    expect((await post(legacy, {})).status).toBe(200);
    expect(await db.sql`SELECT window_id, testnet FROM mining_pool.shares ORDER BY window_id`).toEqual([
      { window_id: 'w-legacy', testnet: false },
      { window_id: WINDOW, testnet: true },
    ]);
    await db.sql`UPDATE mining_pool.windows SET epoch = CASE WHEN window_id = ${WINDOW} THEN 3 ELSE 4 END, reward = 10, fee_bps = 100`;
    const ledger = new MemoryLedger();
    const posted = vi.spyOn(ledger, 'post');
    // The legacy window is refused for its own reason (the parked emission), never closed as testnet.
    await expect(payWindow(db.sql, ledger, 'w-legacy')).rejects.toThrow('mining.emission_unpublished');
    await expect(runEpochPayoutTick({ sql: db.sql, ledger })).rejects.toThrow('mining.testnet_no_credit');
    expect(await db.sql`SELECT window_id, status FROM mining_pool.windows ORDER BY window_id`).toEqual([
      { window_id: 'w-legacy', status: 'open' },
      { window_id: WINDOW, status: 'no_credit' },
    ]);
    await expect(runEpochPayoutTick({ sql: db.sql, ledger })).rejects.toThrow('mining.emission_unpublished');
    expect(posted).not.toHaveBeenCalled();
  });

  it('a window holding only solo work has no pooled split (mining.no_pooled_shares) and solo credit refuses mining.emission_unpublished', async () => {
    const alice = router({}).createCaller(signed(ALICE, ['trade:write']));
    await alice.workers.setMode({ name: 'Rig-S', mode: 'solo' });
    const legacy = { windowId: WINDOW, assetId: 'IFC', shares: [{ shareId: 's-solo', minerId: ALICE, weight: '4', workerName: 'Rig-S' }] };
    expect((await post(legacy, {})).status).toBe(200);
    await db.sql`UPDATE mining_pool.windows SET epoch = 3, reward = 10, fee_bps = 100 WHERE window_id = ${WINDOW}`;
    const ledger = new MemoryLedger();
    const posted = vi.spyOn(ledger, 'post');
    await expect(payWindow(db.sql, ledger, WINDOW)).rejects.toThrow('mining.no_pooled_shares');
    expect(await db.sql`SELECT status FROM mining_pool.windows WHERE window_id = ${WINDOW}`).toEqual([{ status: 'open' }]);
    expect(posted).not.toHaveBeenCalled();
    // The share reports count the solo work, so it is never invisible.
    const mine = await router({})
      .createCaller(signed(ALICE, ['ledger:read']))
      .shares.mine({});
    expect(mine.windows).toEqual([{ windowId: WINDOW, acceptedCount: 1, rejectedCount: 0, soloCount: 1, acceptedWeight: '4' }]);
    const ops = await router({})
      .createCaller(signed(ALICE, ['admin:read']))
      .ops.shares({ windowId: WINDOW });
    expect(ops.windows).toEqual(mine.windows);
    // The room reads the same refusal from the service.
    await expect(
      router({})
        .createCaller(signed(ALICE, ['ledger:read']))
        .workers.soloCredit(),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'mining.emission_unpublished' },
    });
  });
});
