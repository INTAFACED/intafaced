import { describe, expect, it } from 'vitest';
import {
  CodController,
  computeExpiryMs,
  decideArm,
  firedFrame,
  leaseRangeFromEnv,
  parseCodCommand,
  targetsFromCancel,
  wouldInventCodMassSuccess,
  wouldInventCodMassSuccessFrame,
  type CodArmCommand,
  type CodLease,
  type TradeCancelPort,
  type TradeCancelResult,
} from './cod.js';

const RANGE = { minTtlMs: 1_000, maxTtlMs: 60_000 };

function arm(over: Partial<CodArmCommand> = {}): CodArmCommand {
  return {
    commandId: 'cmd-1',
    ttlMs: 5_000,
    scope: 'account',
    excludedOrderClasses: [],
    ...over,
  };
}

function appliedCancel(orderId: string): TradeCancelResult {
  return { reached: true, status: 200, orders: [{ orderId }] };
}

/** Each cancelAll stays pending until the test releases that call. */
function holdCancelAll(): {
  cancel: TradeCancelPort;
  calls: Array<{ accessToken: string; marketId?: string }>;
  release: (index: number, result: TradeCancelResult) => void;
} {
  const releases: Array<(result: TradeCancelResult) => void> = [];
  const calls: Array<{ accessToken: string; marketId?: string }> = [];
  return {
    calls,
    cancel: {
      async cancelAll(input) {
        calls.push(input);
        return new Promise<TradeCancelResult>((resolve) => {
          releases.push(resolve);
        });
      },
    },
    release(index, result) {
      const resolve = releases[index];
      if (!resolve) throw new Error(`no cancelAll held at ${index}`);
      resolve(result);
    },
  };
}

function codController(cancel: TradeCancelPort): CodController {
  return new CodController({
    range: RANGE,
    now: () => 1_000,
    schedule: () => () => {},
    cancel,
  });
}

function armAccount(commandId: string): string {
  return JSON.stringify({ type: 'cod.arm', commandId, ttlMs: 5_000, scope: 'account' });
}

function firedFrames(frames: readonly string[]): Array<{ type: string; commandId?: string; targets?: unknown }> {
  return frames
    .map((frame) => JSON.parse(frame) as { type: string; commandId?: string; targets?: unknown })
    .filter((frame) => frame.type === 'cod.fired');
}

describe('COD lease clock', () => {
  it('expiry is server receipt + ttl — client expiresAt is not an input', () => {
    expect(computeExpiryMs(1_000_000, 5_000)).toBe(1_005_000);
    const parsed = parseCodCommand({
      type: 'cod.arm',
      commandId: 'cmd-1',
      ttlMs: 5_000,
      scope: 'account',
      expiresAt: '1999-01-01T00:00:00.000Z',
      clientNow: 0,
    });
    expect(parsed.kind).toBe('arm');
    if (parsed.kind !== 'arm') return;
    const decided = decideArm({
      command: parsed.command,
      range: RANGE,
      nowMs: 2_000_000,
      hasWrite: true,
      cancelPortAttached: true,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.lease.receivedAtMs).toBe(2_000_000);
    expect(decided.lease.expiresAtMs).toBe(2_005_000);
  });

  it('renew uses a new server now, not a client-supplied expiry', () => {
    const first = computeExpiryMs(10_000, 5_000);
    const renewed = computeExpiryMs(12_000, 5_000);
    expect(renewed).toBe(17_000);
    expect(renewed).not.toBe(first);
  });
});

describe('COD arm policy', () => {
  it('refuses when owner lease range is blank', () => {
    expect(leaseRangeFromEnv(undefined, 60_000)).toBeNull();
    expect(decideArm({ command: arm(), range: null, nowMs: 1, hasWrite: true, cancelPortAttached: true })).toEqual({
      ok: false,
      code: 'cod.lease_range_unconfigured',
    });
  });

  it('refuses trade:read-only and excluded classes (owner socket)', () => {
    const write = decideArm({ command: arm(), range: RANGE, nowMs: 1, hasWrite: false, cancelPortAttached: true });
    expect(write.ok).toBe(false);
    if (write.ok) return;
    expect(write.code).toBe('cod.write_required');
    const excluded = decideArm({
      command: arm({ excludedOrderClasses: ['iceberg'] }),
      range: RANGE,
      nowMs: 1,
      hasWrite: true,
      cancelPortAttached: true,
    });
    expect(excluded.ok).toBe(false);
    if (excluded.ok) return;
    expect(excluded.code).toBe('cod.excluded_classes_unconfigured');
  });

  it('session scope arms but is not cancel-executable', () => {
    const decided = decideArm({
      command: arm({ scope: 'session' }),
      range: RANGE,
      nowMs: 1,
      hasWrite: true,
      cancelPortAttached: true,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.lease.cancelExecutable).toBe(false);
  });

  it('ttl outside owner range refuses', () => {
    const ttl = decideArm({ command: arm({ ttlMs: 50 }), range: RANGE, nowMs: 1, hasWrite: true, cancelPortAttached: true });
    expect(ttl.ok).toBe(false);
    if (ttl.ok) return;
    expect(ttl.code).toBe('cod.ttl_out_of_range');
  });
});

describe('COD fire honesty', () => {
  const lease: CodLease = {
    commandId: 'cmd-1',
    userId: 'user-a',
    accessToken: 't',
    receivedAtMs: 1,
    expiresAtMs: 2,
    ttlMs: 1,
    scope: 'account',
    cancelExecutable: true,
    fired: true,
  };

  it('session fire is UNKNOWN and not complete', () => {
    const mapped = targetsFromCancel({ scope: 'session', result: { reached: true, status: 200, orders: [{ orderId: 'o1' }] } });
    expect(mapped.tradeReached).toBe(false);
    expect(mapped.complete).toBe(false);
    expect(mapped.targets[0]?.outcome).toBe('OUTCOME_UNKNOWN');
    expect(mapped.targets[0]?.reason).toBe('cod.session_scope_not_mapped');
  });

  it('unreachable trade is UNKNOWN — never mass APPLIED', () => {
    const mapped = targetsFromCancel({ scope: 'account', result: { reached: false, reason: 'cod.trade_not_reached' } });
    expect(mapped.tradeReached).toBe(false);
    expect(mapped.complete).toBe(false);
    expect(mapped.targets.every((t) => t.outcome !== 'APPLIED')).toBe(true);
    const frame = firedFrame({
      lease,
      activation: 'disconnect',
      firedAtMs: 3,
      ...mapped,
    });
    expect(wouldInventCodMassSuccessFrame(frame)).toBe(false);
    expect(wouldInventCodMassSuccess({ channel: 'cod', type: 'cod.fired', complete: true, tradeReached: false })).toBe(true);
  });

  it('trade 200 with cancelled ids is APPLIED per target', () => {
    const mapped = targetsFromCancel({
      scope: 'account',
      result: { reached: true, status: 200, orders: [{ orderId: 'o1' }, { orderId: 'o2' }] },
    });
    expect(mapped).toEqual({
      tradeReached: true,
      complete: true,
      targets: [
        { selector: 'o1', outcome: 'APPLIED' },
        { selector: 'o2', outcome: 'APPLIED' },
      ],
    });
  });

  it('does not treat a reconnect empty blotter as COD mass-success', () => {
    expect(wouldInventCodMassSuccess({ channel: 'orders', type: 'snapshot', orders: [], userId: 'u' })).toBe(false);
    expect(wouldInventCodMassSuccess({ channel: 'orders', type: 'snapshot', orders: [], codComplete: true })).toBe(true);
  });
});

describe('parseCodCommand', () => {
  it('ignores non-COD and treats heartbeat as renew', () => {
    expect(parseCodCommand({ op: 'subscribe' }).kind).toBe('ignore');
    expect(parseCodCommand({ type: 'cod.heartbeat', commandId: 'h1' })).toEqual({ kind: 'renew', commandId: 'h1' });
  });
});

describe('CodController', () => {
  it('lease expiry uses the server schedule, not a client clock, and does not invent cancels', async () => {
    let nowMs = 1_000;
    const scheduled: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
    const cancelCalls: unknown[] = [];
    const cancel: TradeCancelPort = {
      async cancelAll(input) {
        cancelCalls.push(input);
        return { reached: true, status: 200, orders: [{ orderId: 'should-not-run' }] };
      },
    };
    const frames: string[] = [];
    const conn = {};
    const controller = new CodController({
      range: RANGE,
      now: () => nowMs,
      schedule: (fn, delay) => {
        const item = { fn, delay, cancelled: false };
        scheduled.push(item);
        return () => {
          item.cancelled = true;
        };
      },
      cancel,
    });
    controller.handleText(
      conn,
      JSON.stringify({
        type: 'cod.arm',
        commandId: 'c1',
        ttlMs: 5_000,
        scope: 'session',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      { userId: 'user-a', accessToken: 'tok', hasWrite: true, send: (f) => frames.push(f) },
    );
    expect(JSON.parse(frames[0]!).type).toBe('cod.armed');
    expect(JSON.parse(frames[0]!).expiresAt).toBe(new Date(6_000).toISOString());
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(5_000);

    nowMs = 1_500;
    controller.handleText(conn, JSON.stringify({ type: 'cod.renew', commandId: 'c2' }), {
      userId: 'user-a',
      accessToken: 'tok',
      hasWrite: true,
      send: (f) => frames.push(f),
    });
    expect(JSON.parse(frames[1]!).type).toBe('cod.renewed');
    expect(JSON.parse(frames[1]!).expiresAt).toBe(new Date(6_500).toISOString());
    expect(scheduled[0]!.cancelled).toBe(true);
    expect(scheduled[1]!.delay).toBe(5_000);

    nowMs = 6_500;
    scheduled[1]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    const fired = frames
      .map((f) => JSON.parse(f) as { type: string; tradeReached?: boolean; complete?: boolean; targets?: unknown })
      .find((f) => f.type === 'cod.fired');
    expect(fired).toMatchObject({
      type: 'cod.fired',
      activation: 'lease_expired',
      tradeReached: false,
      complete: false,
    });
    expect(cancelCalls).toEqual([]);
    expect(wouldInventCodMassSuccess(fired)).toBe(false);
  });

  it('delivers cod.fired to a later listener after the earlier unsubscribe runs again', async () => {
    let nowMs = 1_000;
    const scheduled: Array<{ fn: () => void }> = [];
    const first: string[] = [];
    const second: string[] = [];
    const conn = {};
    const controller = new CodController({
      range: RANGE,
      now: () => nowMs,
      schedule: (fn) => {
        scheduled.push({ fn });
        return () => {};
      },
      cancel: null,
    });

    const unsubscribeFirst = controller.listen('user-a', (frame) => {
      first.push(frame);
    });
    unsubscribeFirst();
    const unsubscribeSecond = controller.listen('user-a', (frame) => {
      second.push(frame);
    });
    unsubscribeFirst();

    controller.handleText(
      conn,
      JSON.stringify({
        type: 'cod.arm',
        commandId: 'c-listen',
        ttlMs: 5_000,
        scope: 'session',
      }),
      { userId: 'user-a', accessToken: 'tok', hasWrite: true, send: () => {} },
    );
    nowMs = 6_000;
    scheduled[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));

    expect(first).toEqual([]);
    expect(second.map((frame) => JSON.parse(frame) as { type: string; userId: string })).toEqual([
      expect.objectContaining({
        type: 'cod.fired',
        userId: 'user-a',
        activation: 'lease_expired',
        commandId: 'c-listen',
      }),
    ]);

    unsubscribeSecond();
    expect(controller.listenerCount).toBe(0);
  });

  it('delivers one cod.fired frame when no newer arm or fire arrives during cancelAll', async () => {
    const held = holdCancelAll();
    const controller = codController(held.cancel);
    const seat: string[] = [];
    const heard: string[] = [];
    const conn = {};
    controller.listen('user-a', (frame) => heard.push(frame));
    controller.handleText(conn, armAccount('only-lease'), {
      userId: 'user-a',
      accessToken: 'tok',
      hasWrite: true,
      send: (frame) => seat.push(frame),
    });

    const firing = controller.disconnect(conn);
    expect(held.calls).toEqual([{ accessToken: 'tok' }]);
    expect(firedFrames(seat)).toEqual([]);

    held.release(0, appliedCancel('kept-order'));
    await firing;

    const fired = {
      type: 'cod.fired',
      commandId: 'only-lease',
      userId: 'user-a',
      activation: 'disconnect',
      tradeReached: true,
      complete: true,
      targets: [{ selector: 'kept-order', outcome: 'APPLIED' }],
    };
    expect(firedFrames(seat)).toEqual([expect.objectContaining(fired)]);
    expect(firedFrames(heard)).toEqual([expect.objectContaining(fired)]);
    const replayed: string[] = [];
    controller.replayLastFire('user-a', (frame) => replayed.push(frame));
    expect(firedFrames(replayed)).toEqual([expect.objectContaining(fired)]);
    expect(held.calls).toHaveLength(1);
  });

  it('does not publish a stale cod.fired after a newer arm during cancelAll', async () => {
    const held = holdCancelAll();
    const controller = codController(held.cancel);
    const oldSeat: string[] = [];
    const newSeat: string[] = [];
    const heard: string[] = [];
    const oldConn = {};
    const newConn = {};
    controller.listen('user-a', (frame) => heard.push(frame));
    controller.handleText(oldConn, armAccount('old-lease'), {
      userId: 'user-a',
      accessToken: 'tok-old',
      hasWrite: true,
      send: (frame) => oldSeat.push(frame),
    });

    const firing = controller.disconnect(oldConn);
    expect(held.calls).toEqual([{ accessToken: 'tok-old' }]);

    controller.handleText(newConn, armAccount('new-lease'), {
      userId: 'user-a',
      accessToken: 'tok-new',
      hasWrite: true,
      send: (frame) => newSeat.push(frame),
    });
    expect(controller.armedCount).toBe(1);
    expect(JSON.parse(newSeat[0]!) as { type: string; commandId: string }).toMatchObject({
      type: 'cod.armed',
      commandId: 'new-lease',
    });

    held.release(0, appliedCancel('stale-order'));
    await firing;

    expect(firedFrames(oldSeat)).toEqual([]);
    expect(firedFrames(newSeat)).toEqual([]);
    expect(firedFrames(heard)).toEqual([]);
    const replayed: string[] = [];
    controller.replayLastFire('user-a', (frame) => replayed.push(frame));
    expect(replayed).toEqual([]);
    expect(controller.armedCount).toBe(1);
    expect(held.calls).toEqual([{ accessToken: 'tok-old' }]);
  });

  it('does not let an older fire overwrite lastFire when a newer fire already published', async () => {
    const held = holdCancelAll();
    const controller = codController(held.cancel);
    const oldSeat: string[] = [];
    const newSeat: string[] = [];
    const heard: string[] = [];
    const oldConn = {};
    const newConn = {};
    controller.listen('user-a', (frame) => heard.push(frame));
    controller.handleText(oldConn, armAccount('old-lease'), {
      userId: 'user-a',
      accessToken: 'tok-old',
      hasWrite: true,
      send: (frame) => oldSeat.push(frame),
    });
    controller.handleText(newConn, armAccount('new-lease'), {
      userId: 'user-a',
      accessToken: 'tok-new',
      hasWrite: true,
      send: (frame) => newSeat.push(frame),
    });

    const older = controller.disconnect(oldConn);
    const newer = controller.disconnect(newConn);
    expect(held.calls).toEqual([{ accessToken: 'tok-old' }, { accessToken: 'tok-new' }]);

    held.release(1, appliedCancel('new-order'));
    await newer;

    const newerFired = {
      type: 'cod.fired',
      commandId: 'new-lease',
      userId: 'user-a',
      activation: 'disconnect',
      tradeReached: true,
      complete: true,
      targets: [{ selector: 'new-order', outcome: 'APPLIED' }],
    };
    expect(firedFrames(newSeat)).toEqual([expect.objectContaining(newerFired)]);
    expect(firedFrames(heard)).toEqual([expect.objectContaining(newerFired)]);

    held.release(0, appliedCancel('stale-order'));
    await older;

    expect(firedFrames(oldSeat)).toEqual([]);
    expect(firedFrames(heard)).toEqual([expect.objectContaining(newerFired)]);
    const replayed: string[] = [];
    controller.replayLastFire('user-a', (frame) => replayed.push(frame));
    expect(firedFrames(replayed)).toEqual([expect.objectContaining(newerFired)]);
    expect(held.calls).toHaveLength(2);
  });
});
