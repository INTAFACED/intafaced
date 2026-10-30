import { describe, expect, it } from 'vitest';
import { COPY_SKIP_REASON_IDS, COPY_STOP_REASON_IDS, EVENT_CATALOG, WIRING_SOCKETS } from './catalog.js';
import { EVENT_BUS_MATRIX } from './socket-inventory.js';

const uid = () => crypto.randomUUID();
const ts = () => new Date().toISOString();

describe('J-copy-bots-otc-03 copy notice events', () => {
  it('declares the three subjects under the subject law', () => {
    expect(EVENT_CATALOG.copySkipped.subject).toBe('intafaced.trade.copy.skipped');
    expect(EVENT_CATALOG.copyFailed.subject).toBe('intafaced.trade.copy.failed');
    expect(EVENT_CATALOG.copyStopped.subject).toBe('intafaced.trade.copy.stopped');
    for (const k of ['copySkipped', 'copyFailed', 'copyStopped'] as const) expect(EVENT_CATALOG[k].version).toBe(1);
  });

  it('a skip carries the follow, the leader fill and a reason id from the closed list', () => {
    const ok = {
      followId: 'follow-1',
      followerId: uid(),
      leaderId: uid(),
      leaderFillId: uid(),
      reason: 'insufficient_funds',
      skippedAt: ts(),
    };
    expect(EVENT_CATALOG.copySkipped.schema.parse(ok)).toEqual(ok);
    for (const reason of COPY_SKIP_REASON_IDS) {
      expect(EVENT_CATALOG.copySkipped.schema.safeParse({ ...ok, reason }).success).toBe(true);
    }
    // A raw service code or a sentence is never a reason.
    expect(EVENT_CATALOG.copySkipped.schema.safeParse({ ...ok, reason: 'trade.copy_paused' }).success).toBe(false);
    expect(EVENT_CATALOG.copySkipped.schema.safeParse({ ...ok, followerId: 'not-a-uuid' }).success).toBe(false);
    // The leader fill is an engine fill (a uuid); the follow id has no blanks.
    for (const leaderFillId of ['', 'fill-1']) {
      expect(EVENT_CATALOG.copySkipped.schema.safeParse({ ...ok, leaderFillId }).success).toBe(false);
    }
    for (const followId of ['', ' ', 'follow 1', ' follow-1', 'x'.repeat(65)]) {
      expect(EVENT_CATALOG.copySkipped.schema.safeParse({ ...ok, followId }).success).toBe(false);
    }
    const { skippedAt: _dropped, ...noTime } = ok;
    expect(EVENT_CATALOG.copySkipped.schema.safeParse(noTime).success).toBe(false);
  });

  it('a failure carries a lowercase reason id, never a raw code or a sentence', () => {
    const ok = { followId: 'follow-1', followerId: uid(), leaderId: uid(), leaderFillId: uid(), reason: 'order_rejected', failedAt: ts() };
    expect(EVENT_CATALOG.copyFailed.schema.safeParse(ok).success).toBe(true);
    const { leaderId: _leader, ...noLeader } = ok;
    expect(EVENT_CATALOG.copyFailed.schema.safeParse(noLeader).success).toBe(false);
    for (const reason of ['trade.market_not_tradable', 'Order rejected', '', 'x'.repeat(65)]) {
      expect(EVENT_CATALOG.copyFailed.schema.safeParse({ ...ok, reason }).success).toBe(false);
    }
  });

  it('a stop carries its reason id and whether closes still copy', () => {
    const ok = { followId: 'follow-1', followerId: uid(), leaderId: uid(), reason: 'follower', closeOnly: true, stoppedAt: ts() };
    expect(EVENT_CATALOG.copyStopped.schema.safeParse(ok).success).toBe(true);
    for (const reason of COPY_STOP_REASON_IDS) {
      expect(EVENT_CATALOG.copyStopped.schema.safeParse({ ...ok, reason }).success).toBe(true);
    }
    expect(EVENT_CATALOG.copyStopped.schema.safeParse({ ...ok, reason: 'paused' }).success).toBe(false);
    expect(EVENT_CATALOG.copyStopped.schema.safeParse({ ...ok, closeOnly: 'yes' }).success).toBe(false);
  });

  it('each event names the key its consumer dedupes on; a socket still open says it too', () => {
    const keys = { copySkipped: '(followId, leaderFillId)', copyFailed: '(followId, leaderFillId)', copyStopped: '(followId, closeOnly)' };
    for (const [k, key] of Object.entries(keys)) {
      expect(EVENT_CATALOG[k as keyof typeof keys].description).toContain(key);
      const sub = WIRING_SOCKETS.find((s) => s.event === k && s.missing === 'subscriber');
      if (sub) expect(sub.reason).toContain(key);
    }
  });

  it('the skip and the stop are wired end to end; the failure is still a class A socket at both ends', () => {
    // Published by services/svc-trade/src/copy/copy-notices.ts, read by svc-notify (events.ts, copy-notify.test.ts).
    for (const k of ['copySkipped', 'copyStopped'] as const) {
      expect(WIRING_SOCKETS.filter((s) => (s.event as string) === k)).toEqual([]);
      expect(EVENT_BUS_MATRIX[k]).toEqual({ kind: 'live' });
    }
    expect(WIRING_SOCKETS.filter((s) => s.event === 'copyFailed').map((s) => [s.missing, s.class])).toEqual([
      ['publisher', 'A'],
      ['subscriber', 'A'],
    ]);
    expect(EVENT_BUS_MATRIX.copyFailed).toEqual({ kind: 'socket', socketClass: 'A' });
  });
});
