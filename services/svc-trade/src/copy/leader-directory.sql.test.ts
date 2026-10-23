/**
 * COPYLEADERS acceptance. Postgres via TEST_DATABASE_URL. Does not start Docker.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import { principalFor } from '../spot/testing.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { SqlCopyFollowStore } from './follow-store.js';
import { sqlLeaderDirectory, type LeaderDirectory } from './leader-directory.js';
import { LEADER_DIRECTORY_PAGE_KEYS, LEADER_DIRECTORY_ROW_KEYS } from './leader-listing.js';
import { LEADER_EVENT_KEYS, LEADER_EVENTS_PAGE_KEYS } from './leader-events.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const OP = '00000000-0000-4000-8000-0000000000aa';
const F1 = '00000000-0000-4000-8000-0000000000b1';
const F2 = '00000000-0000-4000-8000-0000000000b2';
const F3 = '00000000-0000-4000-8000-0000000000b3';
const LEADER_A = '00000000-0000-4000-8000-0000000000c1';
const LEADER_B = '00000000-0000-4000-8000-0000000000c2';
const LEADER_C = '00000000-0000-4000-8000-0000000000c3';
const LEADER_D = '00000000-0000-4000-8000-0000000000c4';
const LEADER_E = '00000000-0000-4000-8000-0000000000c5';
const FIXTURE_PNL = '987654321.123';
const SECRET_REASON = 'OPERATOR-REASON-DO-NOT-LEAK';
const futureExpiry = '2026-12-01T00:00:00.000Z';

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

const operator = () => principalFor(OP, ['admin:write']);
const follower = (id: string) => principalFor(id, ['trade:read', 'trade:write']);

function openDb(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset. COPYLEADERS does not start Docker.');
  }
  return url;
}

describe('copy leader directory and events', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: openDb(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    // order_events refuses TRUNCATE. Same reset as the other copy SQL suites.
    await truncateTradeExceptOrderEvents(db!.sql);
  });

  function harness(law: CopyFeeShareLaw = publishedFee) {
    let tick = Date.parse('2026-10-18T00:00:00.000Z');
    const now = () => new Date(tick);
    const step = () => {
      tick += 60_000;
    };
    const store = new SqlCopyFollowStore(db!.sql);
    const directory: LeaderDirectory = sqlLeaderDirectory(db!.sql, { now, feeShareLaw: law });
    let placed = 0;
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: law,
      jurisdictionLaw: publishedJur,
      store,
      directory,
      now,
      placeMirrorEnabled: false,
      placeFollowerOrder: async () => {
        placed += 1;
        return { orderId: 'must-not-place' };
      },
    });
    return {
      now,
      step,
      store,
      directory,
      copy,
      placed: () => placed,
    };
  }

  async function counts() {
    const [audits] = await db!.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_leader_listing_audit`;
    const [events] = await db!.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_leader_events`;
    const [listings] = await db!.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_leader_listings`;
    return { audits: audits?.n ?? 0, events: events?.n ?? 0, listings: listings?.n ?? 0 };
  }

  const followInput = (leader: { leaderId?: string; leaderRef?: string }) => ({
    ...leader,
    region: 'SG',
    permittedMarkets: ['BTC-USDT'],
    maxNotionalPerOrder: '100',
    maxAggregateExposure: '1000',
    expiresAt: futureExpiry,
  });

  it('pages listed leaders with published fields and hides everyone else', async () => {
    const { copy, step } = harness();
    step();
    await copy.upsertListing(operator(), {
      clientRequestId: 'create-a',
      leaderUserId: LEADER_A,
      displayName: 'Leader A',
      recordKind: 'paper',
      state: 'listed',
      tenureStart: '2024-06-01T00:00:00.000Z',
      assets: ['BTC', 'ETH'],
      capacity: 10,
      strategyVersion: 'v3',
      publishedReturn: '1.25',
      maximumDrawdown: '0.4',
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-10-01T00:00:00.000Z',
      netOfCosts: true,
    });
    step();
    await copy.upsertListing(operator(), {
      clientRequestId: 'create-b',
      leaderUserId: LEADER_B,
      displayName: 'Leader B',
      recordKind: 'backtest',
      state: 'listed',
      assets: ['SOL'],
      strategyVersion: 'v1',
    });
    step();
    await copy.upsertListing(operator(), {
      clientRequestId: 'create-c',
      leaderUserId: LEADER_C,
      displayName: 'Leader C',
      recordKind: 'imported',
    });
    step();
    const suspended = await copy.upsertListing(operator(), {
      clientRequestId: 'create-d',
      leaderUserId: LEADER_D,
      displayName: 'Leader D',
      recordKind: 'paper',
      state: 'listed',
    });
    await copy.setLeaderState(operator(), {
      leaderRef: suspended.leaderRef,
      state: 'suspended',
      reason: SECRET_REASON,
      clientRequestId: 'suspend-d',
    });
    step();
    const delisted = await copy.upsertListing(operator(), {
      clientRequestId: 'create-e',
      leaderUserId: LEADER_E,
      displayName: 'Leader E',
      recordKind: 'self_reported',
      state: 'listed',
    });
    await copy.setLeaderState(operator(), {
      leaderRef: delisted.leaderRef,
      state: 'delisted',
      reason: SECRET_REASON,
      clientRequestId: 'delist-e',
    });

    await db!.sql`
      INSERT INTO trade.copy_leader_fixtures (
        leader_id, realised_pnl, closed_trades, winning_trades, window_start, window_end, source
      ) VALUES (
        ${LEADER_A}, ${FIXTURE_PNL}, 4, 3, ${new Date('2026-01-01T00:00:00.000Z')}, ${new Date('2026-10-01T00:00:00.000Z')}, 'operator'
      )
    `;

    const followed = await copy.follow(follower(F1), followInput({ leaderId: LEADER_A }));
    await copy.follow(follower(F2), followInput({ leaderId: LEADER_A }));
    await copy.pause(follower(F2), { followId: (await copy.listMyFollows(follower(F2), 10))[0]!.followId });

    const page = await copy.listLeaders(follower(F1), { limit: 10 });
    expect(Object.keys(page).sort()).toEqual([...LEADER_DIRECTORY_PAGE_KEYS].sort());
    expect(page.leaders.map((row) => row.displayName)).toEqual(['Leader A', 'Leader B']);
    const rowA = page.leaders[0]!;
    const rowB = page.leaders[1]!;
    expect(Object.keys(rowA).sort()).toEqual([...LEADER_DIRECTORY_ROW_KEYS].sort());
    expect(Object.keys(rowB).sort()).toEqual([...LEADER_DIRECTORY_ROW_KEYS].sort());
    expect(rowA).toMatchObject({
      displayName: 'Leader A',
      recordKind: 'paper',
      tenureStart: '2024-06-01T00:00:00.000Z',
      assets: ['BTC', 'ETH'],
      strategyVersion: 'v3',
      publishedReturn: { value: '1.25', reason: null },
      maximumDrawdown: { value: '0.4', reason: null },
      windowStart: { value: '2026-01-01T00:00:00.000Z', reason: null },
      windowEnd: { value: '2026-10-01T00:00:00.000Z', reason: null },
      netOfCosts: { value: true, reason: null },
      copiersCount: 1,
      capacity: { value: 10, reason: null },
      leaderShareBps: { value: '5000', reason: null },
    });
    expect(rowB).toMatchObject({
      displayName: 'Leader B',
      publishedReturn: { value: null, reason: 'no_published_record' },
      maximumDrawdown: { value: null, reason: 'no_published_record' },
      windowStart: { value: null, reason: 'no_published_record' },
      windowEnd: { value: null, reason: 'no_published_record' },
      netOfCosts: { value: null, reason: 'no_published_record' },
      capacity: { value: null, reason: 'capacity_unpublished' },
      copiersCount: 0,
      leaderShareBps: { value: '5000', reason: null },
    });
    const body = JSON.stringify(page);
    expect(body).not.toContain(LEADER_A);
    expect(body).not.toContain(LEADER_B);
    expect(body).not.toContain(F1);
    expect(body).not.toContain(F2);
    expect(body).not.toContain(FIXTURE_PNL);
    expect(body).not.toContain(SECRET_REASON);
    expect(followed.leaderId).toBeNull();
    expect(followed.leaderRef).toBe(rowA.leaderRef);
    expect(JSON.stringify(followed)).not.toContain(LEADER_A);

    const closed = sqlLeaderDirectory(db!.sql, { now: () => new Date(), feeShareLaw: { published: false } });
    const unpublishedShare = await closed.listLeaders({ limit: 10 });
    expect(unpublishedShare.leaders[0]?.leaderShareBps).toEqual({ value: null, reason: 'leader_share_unpublished' });

    await expect(copy.listLeaders(follower(F1), {})).rejects.toMatchObject({ code: 'trade.copy_leaders_limit_unset' });
    await expect(copy.listLeaders(follower(F1), { limit: 10, sort: 'return' })).rejects.toMatchObject({
      code: 'trade.copy_ranking_forbidden',
    });
    await expect(copy.listLeaders(follower(F1), { limit: 10, copiers: 'desc' })).rejects.toMatchObject({
      code: 'trade.copy_ranking_forbidden',
    });
    await expect(copy.listLeaders(follower(F1), { limit: 10, order: 'profit' })).rejects.toMatchObject({
      code: 'trade.copy_ranking_forbidden',
    });
  });

  it('pages without gaps or repeats', async () => {
    const { copy, step } = harness();
    for (const [id, name] of [
      [LEADER_A, 'A'],
      [LEADER_B, 'B'],
      [LEADER_C, 'C'],
    ] as const) {
      step();
      await copy.upsertListing(operator(), {
        clientRequestId: `page-${name}`,
        leaderUserId: id,
        displayName: name,
        recordKind: 'paper',
        state: 'listed',
      });
    }
    const first = await copy.listLeaders(follower(F1), { limit: 2 });
    expect(first.leaders.map((row) => row.displayName)).toEqual(['A', 'B']);
    expect(first.nextCursor).toBeTruthy();
    const second = await copy.listLeaders(follower(F1), { limit: 2, cursor: first.nextCursor });
    expect(second.leaders.map((row) => row.displayName)).toEqual(['C']);
    expect(second.nextCursor).toBeNull();
    const names = [...first.leaders, ...second.leaders].map((row) => row.leaderRef);
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses an operator without admin:read and a verified_live listing without evidence', async () => {
    const { copy } = harness();
    await expect(
      copy.upsertListing(principalFor(OP, ['trade:read']), {
        clientRequestId: 'no-perm',
        leaderUserId: LEADER_A,
        displayName: 'Nope',
        recordKind: 'paper',
        state: 'listed',
      }),
    ).rejects.toMatchObject({ code: 'scope.denied' });
    await expect(
      copy.upsertListing(operator(), {
        clientRequestId: 'no-evidence',
        leaderUserId: LEADER_A,
        displayName: 'Live',
        recordKind: 'verified_live',
        state: 'listed',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_leader_evidence_unset' });
    expect(await counts()).toEqual({ audits: 0, events: 0, listings: 0 });
    const listed = await copy.upsertListing(operator(), {
      clientRequestId: 'with-evidence',
      leaderUserId: LEADER_A,
      displayName: 'Live',
      recordKind: 'verified_live',
      state: 'listed',
      evidenceRef: 'filing-14',
    });
    expect(listed.recordKind).toBe('verified_live');
    expect(await counts()).toMatchObject({ audits: 1, listings: 1 });
  });

  it('refuses admin:read and admin:compliance on listing writes', async () => {
    const { copy } = harness();
    const before = await counts();
    for (const scopes of [['admin:read'], ['admin:compliance']] as const) {
      const principal = principalFor(OP, [...scopes]);
      await expect(
        copy.upsertListing(principal, {
          clientRequestId: `read-${scopes[0]}`,
          leaderUserId: LEADER_A,
          displayName: 'Nope',
          recordKind: 'paper',
          state: 'listed',
        }),
      ).rejects.toMatchObject({ code: 'scope.denied' });
      await expect(
        copy.setLeaderState(principal, {
          leaderRef: 'not-listed',
          state: 'suspended',
          reason: 'nope',
          clientRequestId: `state-${scopes[0]}`,
        }),
      ).rejects.toMatchObject({ code: 'scope.denied' });
    }
    expect(await counts()).toEqual(before);
  });

  it('follows by leaderRef the same leader as by leaderId, and refuses a bad ref', async () => {
    const { copy } = harness();
    const listed = await copy.upsertListing(operator(), {
      clientRequestId: 'ref-a',
      leaderUserId: LEADER_A,
      displayName: 'Leader A',
      recordKind: 'paper',
      state: 'listed',
    });
    const unlisted = await copy.upsertListing(operator(), {
      clientRequestId: 'ref-c',
      leaderUserId: LEADER_C,
      displayName: 'Leader C',
      recordKind: 'paper',
    });
    const byRef = await copy.follow(follower(F1), followInput({ leaderRef: listed.leaderRef }));
    const byId = await copy.follow(follower(F2), followInput({ leaderId: LEADER_A }));
    expect(byRef.leaderRef).toBe(listed.leaderRef);
    expect(byId.leaderRef).toBe(byRef.leaderRef);
    const stored = await db!.sql<Array<{ leader_id: string }>>`
      SELECT leader_id FROM trade.copy_follows
       WHERE follow_id = ${byRef.followId} OR follow_id = ${byId.followId}
    `;
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.leader_id === LEADER_A)).toBe(true);
    const mine = await copy.listMyFollows(follower(F1), 10);
    const detail = mine.find((row) => row.followId === byRef.followId);
    const paused = await copy.pause(follower(F1), { followId: byRef.followId });
    for (const body of [byRef, mine, detail, paused]) {
      expect(JSON.stringify(body)).not.toContain(LEADER_A);
    }
    expect(detail?.leaderRef).toBe(listed.leaderRef);
    await expect(copy.follow(follower(F3), followInput({ leaderRef: unlisted.leaderRef }))).rejects.toMatchObject({
      code: 'trade.copy_leader_not_found',
    });
    await expect(copy.follow(follower(F3), followInput({ leaderRef: 'not-a-leader' }))).rejects.toMatchObject({
      code: 'trade.copy_leader_not_found',
    });
    await expect(copy.follow(follower(F3), followInput({ leaderId: LEADER_A, leaderRef: listed.leaderRef }))).rejects.toMatchObject({
      code: 'trade.copy_leader_identity_unset',
    });
    await expect(copy.follow(follower(F3), followInput({}))).rejects.toMatchObject({ code: 'trade.copy_leader_identity_unset' });
  });

  it('fences new mirrors when a leader is suspended or delisted and leaves exposure and session keys', async () => {
    const { copy, store, placed } = harness();
    const suspended = await copy.upsertListing(operator(), {
      clientRequestId: 'sus-create',
      leaderUserId: LEADER_D,
      displayName: 'Suspended',
      recordKind: 'paper',
      state: 'listed',
    });
    const removed = await copy.upsertListing(operator(), {
      clientRequestId: 'del-create',
      leaderUserId: LEADER_E,
      displayName: 'Delisted',
      recordKind: 'paper',
      state: 'listed',
    });
    const a = await copy.follow(follower(F1), followInput({ leaderId: LEADER_D }));
    const b = await copy.follow(follower(F2), followInput({ leaderId: LEADER_D }));
    const keyA = await copy.grantSessionKey(follower(F1), { followId: a.followId });
    const keyB = await copy.grantSessionKey(follower(F2), { followId: b.followId });
    await store.setExposure(a.followId, parseAmount('12.5'));
    await store.setExposure(b.followId, parseAmount('7'));
    const beforeA = await store.getFollow(a.followId);
    const beforeB = await store.getFollow(b.followId);

    await copy.setLeaderState(operator(), {
      leaderRef: suspended.leaderRef,
      state: 'suspended',
      reason: SECRET_REASON,
      clientRequestId: 'sus-set',
    });
    for (const followId of [a.followId, b.followId]) {
      await expect(
        copy.planMirrorForFollow(follower(followId === a.followId ? F1 : F2), {
          followId,
          fillId: 'fill-sus',
          marketId: 'BTC-USDT',
          side: 'buy',
          qty: '0.01',
          notional: '10',
        }),
      ).rejects.toMatchObject({ code: 'trade.copy_leader_suspended' });
      await expect(
        copy.placeMirrorForFollow(follower(followId === a.followId ? F1 : F2), {
          followId,
          fillId: 'fill-sus',
          leaderPaper: false,
        }),
      ).rejects.toMatchObject({ code: 'trade.copy_leader_suspended' });
    }
    expect(placed()).toBe(0);
    expect(await store.getExposure(a.followId)).toBe(parseAmount('12.5'));
    expect(await store.getExposure(b.followId)).toBe(parseAmount('7'));
    const afterA = await store.getFollow(a.followId);
    const afterB = await store.getFollow(b.followId);
    expect(afterA?.sessionKeyHash).toBe(beforeA?.sessionKeyHash);
    expect(afterB?.sessionKeyHash).toBe(beforeB?.sessionKeyHash);
    expect(afterA?.sessionKeyRevoked).not.toBe(true);
    expect(afterB?.sessionKeyRevoked).not.toBe(true);
    expect(afterA?.relationshipState ?? 'ACTIVE').toBe('ACTIVE');
    expect(keyA.sessionKey).toBeTruthy();
    expect(keyB.sessionKey).toBeTruthy();
    const mine = await copy.listMyFollows(follower(F1), 10);
    expect(mine[0]?.leaderStatus).toBe('suspended');
    expect(JSON.stringify(mine)).not.toContain(SECRET_REASON);

    const third = await copy.follow(follower(F3), followInput({ leaderId: LEADER_E }));
    await copy.setLeaderState(operator(), {
      leaderRef: removed.leaderRef,
      state: 'delisted',
      reason: SECRET_REASON,
      clientRequestId: 'del-set',
    });
    await expect(
      copy.planMirrorForFollow(follower(F3), {
        followId: third.followId,
        fillId: 'fill-del',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_leader_delisted' });
    await expect(
      copy.placeMirrorForFollow(follower(F3), { followId: third.followId, fillId: 'fill-del', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_leader_delisted' });
    expect((await store.getFollow(third.followId))?.relationshipState ?? 'ACTIVE').toBe('ACTIVE');
    expect(placed()).toBe(0);
  });

  it('reads unknown when a leader has no listing', async () => {
    const { copy } = harness();
    const follow = await copy.follow(follower(F1), followInput({ leaderId: LEADER_A }));
    expect(follow.leaderStatus).toBe('unknown');
    expect(follow.leaderId).toBe(LEADER_A);
    expect(follow.leaderRef).toBeNull();
    const listed = await copy.listMyFollows(follower(F1), 10);
    expect(listed[0]?.leaderStatus).toBe('unknown');
    expect(listed[0]?.leaderId).toBe(LEADER_A);
    expect(listed[0]?.leaderRef).toBeNull();
  });

  it('refuses the next follow when capacity is reached and records one event', async () => {
    const { copy } = harness();
    const listed = await copy.upsertListing(operator(), {
      clientRequestId: 'cap-create',
      leaderUserId: LEADER_A,
      displayName: 'Full',
      recordKind: 'paper',
      state: 'listed',
      capacity: 1,
    });
    await copy.follow(follower(F1), followInput({ leaderRef: listed.leaderRef }));
    await expect(copy.follow(follower(F2), followInput({ leaderId: LEADER_A }))).rejects.toMatchObject({
      code: 'trade.copy_leader_capacity_full',
    });
    await expect(copy.follow(follower(F3), followInput({ leaderId: LEADER_A }))).rejects.toMatchObject({
      code: 'trade.copy_leader_capacity_full',
    });
    const events = await db!.sql<Array<{ kind: string; n: number }>>`
      SELECT kind, count(*)::int AS n
        FROM trade.copy_leader_events
       WHERE leader_ref = ${listed.leaderRef}
       GROUP BY kind
    `;
    expect(events).toEqual([{ kind: 'capacity_full', n: 1 }]);
    const page = await copy.listLeaders(follower(F1), { limit: 10 });
    expect(page.leaders[0]?.copiersCount).toBe(1);
  });

  it('appends listing_edited, returns events after the follow began, and replays setLeaderState', async () => {
    const { copy, step } = harness();
    step();
    const created = await copy.upsertListing(operator(), {
      clientRequestId: 'ev-create',
      leaderUserId: LEADER_A,
      displayName: 'Leader A',
      recordKind: 'paper',
      state: 'listed',
      strategyVersion: 'v1',
    });
    step();
    await copy.upsertListing(operator(), {
      clientRequestId: 'ev-edit-before',
      leaderUserId: LEADER_A,
      displayName: 'Leader A edited',
      recordKind: 'paper',
      state: 'listed',
      strategyVersion: 'v1',
    });
    const beforeFollow = await counts();
    expect(beforeFollow.events).toBe(1);
    step();
    const follow = await copy.follow(follower(F1), followInput({ leaderId: LEADER_A }));
    step();
    await copy.upsertListing(operator(), {
      clientRequestId: 'ev-edit-after',
      leaderUserId: LEADER_A,
      displayName: 'Leader A again',
      recordKind: 'paper',
      state: 'listed',
      strategyVersion: 'v2',
    });
    const events = await copy.followEvents(follower(F1), { followId: follow.followId, limit: 10 });
    expect(Object.keys(events).sort()).toEqual([...LEADER_EVENTS_PAGE_KEYS].sort());
    expect(events.events.length).toBeGreaterThan(0);
    for (const event of events.events) {
      expect(Object.keys(event).sort()).toEqual([...LEADER_EVENT_KEYS].sort());
      expect(event.occurredAt > follow.createdAt).toBe(true);
      expect(JSON.stringify(event)).not.toContain(SECRET_REASON);
      expect(JSON.stringify(event)).not.toContain(LEADER_A);
    }
    expect(events.events.some((event) => event.kind === 'listing_edited')).toBe(true);
    expect(events.events.some((event) => event.kind === 'strategy_version_changed')).toBe(true);
    const kinds = await db!.sql<Array<{ kind: string }>>`
      SELECT kind FROM trade.copy_leader_events WHERE leader_ref = ${created.leaderRef} ORDER BY occurred_at
    `;
    expect(kinds.map((row) => row.kind)).toContain('listing_edited');

    await expect(copy.followEvents(follower(F1), { followId: follow.followId })).rejects.toMatchObject({
      code: 'trade.copy_follow_events_limit_unset',
    });
    await expect(copy.followEvents(follower(F2), { followId: follow.followId, limit: 10 })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });

    const before = await counts();
    const first = await copy.setLeaderState(operator(), {
      leaderRef: created.leaderRef,
      state: 'suspended',
      reason: SECRET_REASON,
      clientRequestId: 'ev-suspend',
    });
    const mid = await counts();
    expect(mid.events).toBe(before.events + 1);
    expect(mid.audits).toBe(before.audits + 1);
    const second = await copy.setLeaderState(operator(), {
      leaderRef: created.leaderRef,
      state: 'suspended',
      reason: SECRET_REASON,
      clientRequestId: 'ev-suspend',
    });
    expect(second).toEqual(first);
    expect(await counts()).toEqual(mid);
    const [reasonRow] = await db!.sql<Array<{ reason: string }>>`
      SELECT reason FROM trade.copy_leader_listing_audit WHERE client_request_id = 'ev-suspend'
    `;
    expect(reasonRow?.reason).toBe(SECRET_REASON);
    const customer = JSON.stringify({
      events,
      follows: await copy.listMyFollows(follower(F1), 10),
      leaders: await copy.listLeaders(follower(F1), { limit: 10 }),
    });
    expect(customer).not.toContain(SECRET_REASON);
  });
});
