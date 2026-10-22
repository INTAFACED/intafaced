/**
 * TRD-0773 — stored disclosure acceptance gates the first mirror.
 * Production CopyService (not the legacy test adapter). Wording is the law's text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyTestAdmission } from '../controls/test-admission.js';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { CopyService, type LookupLeaderFillPort } from './copy-service.js';
import { parseCopyDisclosureLawJson, UNPUBLISHED_COPY_DISCLOSURE_LAW } from './disclosure.js';
import { CopyError } from './errors.js';
import { MemoryCopyFollowStore, SqlCopyFollowStore } from './follow-store.js';
import type { CopyDisclosureLaw, CopyFeeShareLaw, CopyJurisdictionLaw } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const FOLLOWER_A = '00000000-0000-4000-8000-0000000000a1';
const FOLLOWER_B = '00000000-0000-4000-8000-0000000000b2';
const LEADER = '00000000-0000-4000-8000-0000000000c3';
const SESSION = '00000000-0000-4000-8000-0000000000d4';
const SECRET = 'copy-disclosure-edge-secret-32bytes';
const futureExpiry = '2026-12-01T00:00:00.000Z';
const NOW = new Date('2026-10-18T00:00:00.000Z');

const TEXT_V1 = 'TEST owner disclosure v1';
const TEXT_V2 = 'TEST owner disclosure v2';
const LAW_V1: CopyDisclosureLaw = { published: true, version: 'v1', text: TEXT_V1 };
const LAW_V2: CopyDisclosureLaw = { published: true, version: 'v2', text: TEXT_V2 };

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};
const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function principal(userId: string, scopes: string[] = ['trade:read', 'trade:write']): Principal {
  return {
    sub: userId,
    userId,
    sid: SESSION,
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-copy-disclosure',
  });
}

function leaderLookup(): LookupLeaderFillPort {
  return async (fillId) => ({
    fillId,
    userId: LEADER,
    marketId: 'BTC-USDT',
    side: 'buy',
    qty: parseAmount('0.01'),
    notional: parseAmount('50'),
  });
}

function service(opts: { disclosureLaw?: CopyDisclosureLaw; store?: MemoryCopyFollowStore | SqlCopyFollowStore; places?: { n: number } }) {
  return new CopyService(new MemoryLedger(), {
    followTier: 'off',
    accountAdmission: readyTestAdmission(),
    feeShareLaw: publishedFee,
    jurisdictionLaw: publishedJur,
    disclosureLaw: opts.disclosureLaw ?? LAW_V1,
    store: opts.store,
    now: () => NOW,
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false }),
    lookupLeaderFill: leaderLookup(),
    placeFollowerOrder: async () => {
      if (opts.places) opts.places.n += 1;
      return { orderId: 'ord-disclosure' };
    },
  });
}

const followInput = {
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC-USDT'],
  maxNotionalPerOrder: '100',
  maxAggregateExposure: '1000',
  expiresAt: futureExpiry,
};

function planInput(followId: string, fillId: string) {
  return { followId, fillId, marketId: 'BTC-USDT', side: 'buy' as const, qty: '0.01', notional: '50' };
}

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. Copy disclosure does not start Docker.');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

describe('parseCopyDisclosureLawJson', () => {
  it('blank config is unpublished and carries no text', () => {
    expect(parseCopyDisclosureLawJson('')).toEqual(UNPUBLISHED_COPY_DISCLOSURE_LAW);
    expect(parseCopyDisclosureLawJson('   ')).toEqual(UNPUBLISHED_COPY_DISCLOSURE_LAW);
    expect(parseCopyDisclosureLawJson('{"published":false,"text":"ignored"}')).toEqual(UNPUBLISHED_COPY_DISCLOSURE_LAW);
  });

  it('published law keeps the owner text and refuses a missing field by key name', () => {
    expect(parseCopyDisclosureLawJson(JSON.stringify({ published: true, version: 'v1', text: TEXT_V1 }))).toEqual(LAW_V1);
    expect(() => parseCopyDisclosureLawJson('{"published":true,"version":"v1"}')).toThrow(/TRADE_COPY_DISCLOSURE_LAW/);
    expect(() => parseCopyDisclosureLawJson('{"published":true,"text":"TEST"}')).toThrow(/TRADE_COPY_DISCLOSURE_LAW/);
    expect(() => parseCopyDisclosureLawJson('{')).toThrow(/TRADE_COPY_DISCLOSURE_LAW/);
  });

  it('ships no disclosure sentence in .env.example', () => {
    const example = readFileSync(join(here, '..', '..', '..', '..', '.env.example'), 'utf8');
    const line = example.split('\n').find((row) => row.startsWith('TRADE_COPY_DISCLOSURE_LAW='));
    expect(line).toBe('TRADE_COPY_DISCLOSURE_LAW=');
    expect(parseCopyDisclosureLawJson('')).toEqual({ published: false });
  });
});

describe('copy disclosure gate', () => {
  it('follow is open, and plan and place refuse until this caller accepts the current version', async () => {
    const places = { n: 0 };
    const copy = service({ places });
    const caller = principal(FOLLOWER_A);
    const followed = await copy.follow(caller, followInput);
    const before = await copy.disclosure(caller);
    expect(Object.keys(before).sort()).toEqual(['accepted', 'published', 'text', 'version']);
    expect(before).toEqual({ published: true, version: 'v1', text: TEXT_V1, accepted: false });
    expect(JSON.stringify(before)).not.toContain(LEADER);

    await expect(copy.planMirrorForFollow(caller, planInput(followed.followId, 'fill-1'))).rejects.toMatchObject({
      code: 'trade.copy_disclosure_required',
      message: 'trade.copy_disclosure_required',
    });
    await expect(
      copy.placeMirrorForFollow(caller, { followId: followed.followId, fillId: 'fill-1', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_disclosure_required', message: 'trade.copy_disclosure_required' });
    expect(places.n).toBe(0);

    const accepted = await copy.acceptDisclosure(caller, { version: 'v1', clientAcceptId: 'accept-1' });
    expect(Object.keys(accepted).sort()).toEqual(['acceptedAt', 'clientAcceptId', 'version']);
    expect(accepted).toEqual({ version: 'v1', acceptedAt: NOW.toISOString(), clientAcceptId: 'accept-1' });
    expect(JSON.stringify(accepted)).not.toContain(LEADER);
    const replay = await copy.acceptDisclosure(caller, { version: 'v1', clientAcceptId: 'accept-replay' });
    expect(replay).toEqual(accepted);

    const plan = await copy.planMirrorForFollow(caller, planInput(followed.followId, 'fill-1'));
    expect(plan.qty).toBe('0.01');
    expect(plan.notional).toBe('50');
    await copy.grantSessionKey(caller, { followId: followed.followId });
    const placed = await copy.placeMirrorForFollow(caller, { followId: followed.followId, fillId: 'fill-1', leaderPaper: false });
    expect(placed.orderId).toBe('ord-disclosure');
    expect(places.n).toBe(1);
    expect((await copy.disclosure(caller)).accepted).toBe(true);
  });

  it('an old version is stale, and a newer published version needs its own acceptance', async () => {
    const store = new MemoryCopyFollowStore();
    const copy = service({ store });
    const caller = principal(FOLLOWER_A);
    const followed = await copy.follow(caller, followInput);
    await expect(copy.acceptDisclosure(caller, { version: 'v0', clientAcceptId: 'old' })).rejects.toMatchObject({
      code: 'trade.copy_disclosure_version_stale',
      message: 'trade.copy_disclosure_version_stale',
    });
    await copy.acceptDisclosure(caller, { version: 'v1', clientAcceptId: 'accept-1' });

    const next = service({ store, disclosureLaw: LAW_V2 });
    const view = await next.disclosure(caller);
    expect(view).toEqual({ published: true, version: 'v2', text: TEXT_V2, accepted: false });
    await expect(next.planMirrorForFollow(caller, planInput(followed.followId, 'fill-2'))).rejects.toMatchObject({
      code: 'trade.copy_disclosure_required',
    });
    await next.acceptDisclosure(caller, { version: 'v2', clientAcceptId: 'accept-2' });
    const plan = await next.planMirrorForFollow(caller, planInput(followed.followId, 'fill-2'));
    expect(plan.fillId).toBe('fill-2');
  });

  it('follower A acceptance does not let follower B mirror', async () => {
    const copy = service({});
    const a = principal(FOLLOWER_A);
    const b = principal(FOLLOWER_B);
    const followA = await copy.follow(a, followInput);
    const followB = await copy.follow(b, followInput);
    await copy.acceptDisclosure(a, { version: 'v1', clientAcceptId: 'accept-a' });
    expect((await copy.disclosure(b)).accepted).toBe(false);
    await expect(copy.planMirrorForFollow(b, planInput(followB.followId, 'fill-b'))).rejects.toMatchObject({
      code: 'trade.copy_disclosure_required',
    });
    await expect(copy.planMirrorForFollow(b, planInput(followA.followId, 'fill-a'))).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    const plan = await copy.planMirrorForFollow(a, planInput(followA.followId, 'fill-a'));
    expect(plan.followerId).toBe(FOLLOWER_A);
  });

  it('unpublished law refuses accept and mirror and returns no placeholder text', async () => {
    const copy = service({ disclosureLaw: UNPUBLISHED_COPY_DISCLOSURE_LAW });
    const caller = principal(FOLLOWER_A);
    const followed = await copy.follow(caller, followInput);
    expect(await copy.disclosure(caller)).toEqual({ published: false, version: null, text: null, accepted: false });
    await expect(copy.acceptDisclosure(caller, { version: 'v1', clientAcceptId: 'accept-1' })).rejects.toEqual(
      expect.objectContaining({ code: 'trade.copy_disclosure_unpublished', message: 'TRADE_COPY_DISCLOSURE_LAW' }),
    );
    await expect(copy.planMirrorForFollow(caller, planInput(followed.followId, 'fill-u'))).rejects.toMatchObject({
      code: 'trade.copy_disclosure_unpublished',
      message: 'TRADE_COPY_DISCLOSURE_LAW',
    });
    await expect(
      copy.placeMirrorForFollow(caller, { followId: followed.followId, fillId: 'fill-u', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_disclosure_unpublished', message: 'TRADE_COPY_DISCLOSURE_LAW' });
  });

  it('disclosure read and accept use the caller scopes', async () => {
    const copy = service({});
    const router = createTradeRouter({} as TradeService, undefined, copy);
    const reader = router.createCaller(signed(principal(FOLLOWER_A, ['trade:read'])));
    const writer = router.createCaller(signed(principal(FOLLOWER_A, ['trade:write'])));
    const both = router.createCaller(signed(principal(FOLLOWER_A)));

    await expect(writer.copy.disclosure()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.copy.acceptDisclosure({ version: 'v1', clientAcceptId: 'accept-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const view = await both.copy.disclosure();
    expect(view).toEqual({ published: true, version: 'v1', text: TEXT_V1, accepted: false });
    const accepted = await both.copy.acceptDisclosure({ version: 'v1', clientAcceptId: 'accept-wire' });
    expect(accepted.clientAcceptId).toBe('accept-wire');
    await expect(both.copy.acceptDisclosure({ version: 'v0', clientAcceptId: 'nope' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'trade.copy_disclosure_version_stale',
    });
  });

  it('an unmounted copy service returns unpublished and refuses accept', async () => {
    const router = createTradeRouter({} as TradeService);
    const caller = router.createCaller(signed(principal(FOLLOWER_A)));
    expect(await caller.copy.disclosure()).toEqual({ published: false, version: null, text: null, accepted: false });
    await expect(caller.copy.acceptDisclosure({ version: 'v1', clientAcceptId: 'accept-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'TRADE_COPY_DISCLOSURE_LAW',
    });
  });
});

describe('copy disclosure acceptance survives a new store on the same database', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('replay writes one row, a new store still gates B, and A can mirror again', async () => {
    const firstStore = new SqlCopyFollowStore(db!.sql);
    const places = { n: 0 };
    const first = service({ store: firstStore, places });
    const a = principal(FOLLOWER_A);
    const b = principal(FOLLOWER_B);
    const followA = await first.follow(a, followInput);
    const followB = await first.follow(b, followInput);
    await expect(first.planMirrorForFollow(a, planInput(followA.followId, 'fill-sql'))).rejects.toBeInstanceOf(CopyError);

    const accepted = await first.acceptDisclosure(a, { version: 'v1', clientAcceptId: 'accept-sql' });
    const replay = await first.acceptDisclosure(a, { version: 'v1', clientAcceptId: 'accept-sql-again' });
    expect(replay).toEqual(accepted);
    const rows = await db!.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM copy_disclosure_acceptances WHERE follower_id = ${FOLLOWER_A}
    `;
    expect(Number(rows[0]?.n)).toBe(1);

    await expect(db!.sql`UPDATE copy_disclosure_acceptances SET version = 'rewritten' WHERE follower_id = ${FOLLOWER_A}`).rejects.toThrow(
      /append-only/,
    );

    const restarted = service({ store: new SqlCopyFollowStore(db!.sql), places });
    expect(await restarted.disclosure(a)).toEqual({ published: true, version: 'v1', text: TEXT_V1, accepted: true });
    expect((await restarted.disclosure(b)).accepted).toBe(false);
    await expect(restarted.planMirrorForFollow(b, planInput(followB.followId, 'fill-b-sql'))).rejects.toMatchObject({
      code: 'trade.copy_disclosure_required',
    });
    const plan = await restarted.planMirrorForFollow(a, planInput(followA.followId, 'fill-sql'));
    expect(plan.notional).toBe('50');
    expect(places.n).toBe(0);
  });
});
