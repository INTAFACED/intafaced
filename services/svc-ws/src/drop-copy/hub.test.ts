import { describe, expect, it } from 'vitest';
import {
  DROP_COPY_CHANNEL,
  DROP_COPY_COMMON_UPSTREAM_FAILURE,
  DROP_COPY_GAP,
  DROP_COPY_RECOVERY_REQUIRED,
  DropCopyHub,
  dropCopyCompleteness,
  isInventedCompleteEmptyDropCopy,
  type DropCopyExecutionInput,
} from './hub.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fill(partial: Partial<DropCopyExecutionInput> = {}): DropCopyExecutionInput {
  return {
    fillId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    orderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    userId: USER,
    marketId: 'btc-usdt',
    side: 'buy',
    liquidity: 'maker',
    price: '100.5',
    qty: '0.01',
    quoteAmount: '1.005',
    feeAsset: 'USDT',
    feeAmount: '0.001005',
    engineSequence: 7,
    ts: '2026-07-31T00:00:00.000Z',
    ...partial,
  };
}

class FakeSink {
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedBytes = 0;

  send(frame: string): void {
    this.frames.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  parsed(): Array<Record<string, unknown>> {
    return this.frames.map((f) => JSON.parse(f) as Record<string, unknown>);
  }
}

function hub(recentLimit = 10): DropCopyHub {
  return new DropCopyHub({
    highWaterBytes: 1_000_000,
    maxLagTicks: 3,
    maxConnections: 8,
    maxConnectionsPerUser: 8,
    recentLimit,
  });
}

describe('dropCopyCompleteness', () => {
  it('never treats bus-down or empty session as a complete tape', () => {
    expect(dropCopyCompleteness({ bus: false, sessionExecutions: 0 })).toBe('COMMON_UPSTREAM_FAILURE');
    expect(dropCopyCompleteness({ bus: true, sessionExecutions: 0 })).toBe('RECOVERY_REQUIRED');
    expect(dropCopyCompleteness({ bus: true, sessionExecutions: 2 })).toBe('SESSION');
  });
});

describe('DropCopyHub', () => {
  it('has no place/cancel command surface', () => {
    const methods = Object.getOwnPropertyNames(DropCopyHub.prototype);
    expect(methods).not.toContain('place');
    expect(methods).not.toContain('cancel');
    expect(methods).not.toContain('placeOrder');
    expect(methods).not.toContain('cancelOrder');
  });

  it('connects with RECOVERY_REQUIRED on an empty bus-up tape — not complete empty', () => {
    const h = hub();
    h.announceBus(true);
    const sink = new FakeSink();
    h.attach(USER, sink);

    expect(sink.parsed().some((f) => isInventedCompleteEmptyDropCopy(JSON.stringify(f)))).toBe(false);
    const ready = sink.parsed().find((f) => f.type === 'ready');
    expect(ready).toMatchObject({
      channel: DROP_COPY_CHANNEL,
      bus: true,
      completeness: 'RECOVERY_REQUIRED',
      replayDurable: false,
      lastSeq: 0,
    });
    const snap = sink.parsed().find((f) => f.type === 'snapshot');
    expect(snap).toMatchObject({
      channel: DROP_COPY_CHANNEL,
      completeness: 'RECOVERY_REQUIRED',
      replayDurable: false,
      executions: [],
    });
    expect(sink.parsed().some((f) => f.type === 'status' && f.code === DROP_COPY_RECOVERY_REQUIRED)).toBe(true);
    expect(sink.parsed().some((f) => f.type === 'execution')).toBe(false);
  });

  it('declares COMMON_UPSTREAM_FAILURE when the drop-copy bus is down — not a complete empty tape', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(USER, sink);
    const ready = sink.parsed().find((f) => f.type === 'ready');
    expect(ready).toMatchObject({ bus: false, completeness: 'COMMON_UPSTREAM_FAILURE', replayDurable: false });
    expect(sink.parsed().some((f) => f.code === DROP_COPY_COMMON_UPSTREAM_FAILURE)).toBe(true);
    expect(sink.parsed().some((f) => f.completeness === 'complete')).toBe(false);
    expect(sink.parsed().some((f) => f.type === 'execution')).toBe(false);
  });

  it('assigns an independent drop-copy sequence that is not matching engineSequence', () => {
    const h = hub();
    h.announceBus(true);
    const sink = new FakeSink();
    h.attach(USER, sink);
    const before = sink.frames.length;

    h.publishExecution(fill({ engineSequence: 41 }));
    h.publishExecution(fill({ fillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', engineSequence: 99 }));

    const live = sink
      .parsed()
      .slice(before)
      .filter((f) => f.type === 'execution');
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject({ dropCopySeq: 1, engineSequence: 41, price: '100.5', qty: '0.01', feeAmount: '0.001005' });
    expect(live[1]).toMatchObject({ dropCopySeq: 2, engineSequence: 99 });
    expect(typeof live[0]!.price).toBe('string');
    expect(typeof live[0]!.qty).toBe('string');
    expect(typeof live[0]!.feeAmount).toBe('string');
    expect(h.lastSeq(USER)).toBe(2);
  });

  it('does not invent executions and does not leak another user', () => {
    const h = hub();
    h.announceBus(true);
    const alice = new FakeSink();
    const bob = new FakeSink();
    h.attach(USER, alice);
    h.attach(OTHER, bob);

    expect(h.publishExecution({ ...fill(), fillId: '' })).toBeNull();
    expect(h.publishExecution({ ...fill(), price: 100 as unknown as string })).toBeNull();
    h.publishExecution(fill());

    expect(alice.parsed().filter((f) => f.type === 'execution')).toHaveLength(1);
    expect(bob.parsed().filter((f) => f.type === 'execution')).toHaveLength(0);
  });

  it('refuses a blank or non-decimal price, qty, or fee before fan-out and does not copy a numeric quote amount', () => {
    const h = hub();
    h.announceBus(true);
    const sink = new FakeSink();
    h.attach(USER, sink);
    const before = sink.frames.length;

    const blankPrice = '11111111-1111-4111-8111-111111111111';
    const refused: DropCopyExecutionInput[] = [
      fill({ fillId: blankPrice, price: '' }),
      fill({ fillId: '22222222-2222-4222-8222-222222222222', price: 'not-a-price' }),
      fill({ fillId: '33333333-3333-4333-8333-333333333333', qty: '' }),
      fill({ fillId: '44444444-4444-4444-8444-444444444444', qty: '1.2.3' }),
      fill({ fillId: '55555555-5555-4555-8555-555555555555', feeAmount: '' }),
      fill({ fillId: '66666666-6666-4666-8666-666666666666', feeAmount: 'nope' }),
      fill({ fillId: '77777777-7777-4777-8777-777777777777', quoteAmount: 1.005 as unknown as string }),
      fill({ fillId: '88888888-8888-4888-8888-888888888888', quoteAmount: '' }),
    ];
    for (const input of refused) {
      expect(h.publishExecution(input)).toBeNull();
    }

    expect(sink.parsed().slice(before).filter((frame) => frame.type === 'execution')).toEqual([]);
    expect(h.lastSeq(USER)).toBe(0);
    expect(h.recentFor(USER)).toEqual([]);

    const later = new FakeSink();
    h.attach(USER, later);
    expect(later.parsed().find((frame) => frame.type === 'snapshot')).toMatchObject({ executions: [] });

    const published = h.publishExecution(fill({ fillId: blankPrice }));
    expect(published).toMatchObject({
      fillId: blankPrice,
      price: '100.5',
      qty: '0.01',
      quoteAmount: '1.005',
      feeAmount: '0.001005',
      dropCopySeq: 1,
    });
    const live = sink.parsed().slice(before).filter((frame) => frame.type === 'execution');
    expect(live).toEqual([
      expect.objectContaining({
        fillId: blankPrice,
        price: '100.5',
        qty: '0.01',
        quoteAmount: '1.005',
        feeAmount: '0.001005',
        dropCopySeq: 1,
      }),
    ]);
    expect(typeof live[0]!.price).toBe('string');
    expect(typeof live[0]!.qty).toBe('string');
    expect(typeof live[0]!.quoteAmount).toBe('string');
    expect(typeof live[0]!.feeAmount).toBe('string');
    const raw = sink.frames.slice(before).find((frame) => frame.includes('"type":"execution"'));
    expect(raw).toContain('"price":"100.5"');
    expect(raw).toContain('"quoteAmount":"1.005"');
  });

  it('dedupes fillId so a redelivery is not a second print', () => {
    const h = hub();
    h.announceBus(true);
    const sink = new FakeSink();
    h.attach(USER, sink);
    const before = sink.frames.length;
    h.publishExecution(fill());
    h.publishExecution(fill());
    expect(
      sink
        .parsed()
        .slice(before)
        .filter((f) => f.type === 'execution'),
    ).toHaveLength(1);
  });

  it('watermarks a gap when a slow consumer misses an execution', () => {
    const h = new DropCopyHub({
      highWaterBytes: 10,
      maxLagTicks: 50,
      maxConnections: 8,
      maxConnectionsPerUser: 8,
      recentLimit: 10,
    });
    h.announceBus(true);
    const sink = new FakeSink();
    sink.bufferedBytes = 100;
    h.attach(USER, sink);
    h.publishExecution(fill());
    expect(sink.parsed().some((f) => f.type === 'execution')).toBe(false);

    sink.bufferedBytes = 0;
    h.publishExecution(fill({ fillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', engineSequence: 8 }));
    const types = sink.parsed().map((f) => `${f.type}:${f.code ?? f.dropCopySeq ?? ''}`);
    expect(types.some((t) => t.startsWith(`status:${DROP_COPY_GAP}`))).toBe(true);
    expect(sink.parsed().filter((f) => f.type === 'execution')).toHaveLength(1);
    expect(sink.parsed().find((f) => f.type === 'execution')!.dropCopySeq).toBe(2);
  });

  it('surfaces DROP_COPY_GAP when a high-water drop drains with no later fill', () => {
    const h = new DropCopyHub({
      highWaterBytes: 10,
      maxLagTicks: 50,
      maxConnections: 8,
      maxConnectionsPerUser: 8,
      recentLimit: 10,
    });
    h.announceBus(true);
    const sink = new FakeSink();
    sink.bufferedBytes = 100;
    h.attach(USER, sink);
    const before = sink.frames.length;

    const dropped = h.publishExecution(fill());
    expect(dropped).toMatchObject({
      price: '100.5',
      qty: '0.01',
      quoteAmount: '1.005',
      feeAmount: '0.001005',
      dropCopySeq: 1,
    });
    expect(typeof dropped!.price).toBe('string');
    expect(typeof dropped!.qty).toBe('string');
    expect(typeof dropped!.quoteAmount).toBe('string');
    expect(typeof dropped!.feeAmount).toBe('string');

    h.sweepLag();
    const whileSlow = sink.parsed().slice(before);
    expect(whileSlow.filter((frame) => frame.type === 'execution')).toEqual([]);
    expect(whileSlow.some((frame) => frame.code === DROP_COPY_GAP)).toBe(false);

    sink.bufferedBytes = 0;
    h.sweepLag();

    const drained = sink.parsed().slice(before);
    expect(drained.filter((frame) => frame.type === 'status' && frame.code === DROP_COPY_GAP)).toEqual([
      expect.objectContaining({
        channel: DROP_COPY_CHANNEL,
        type: 'status',
        code: DROP_COPY_GAP,
        userId: USER,
        replayDurable: false,
        lastSeq: 1,
      }),
    ]);
    expect(drained.filter((frame) => frame.type === 'execution')).toEqual([]);
    const gapFrame = sink.frames.slice(before).find((frame) => frame.includes(DROP_COPY_GAP));
    expect(gapFrame).toBeDefined();
    expect(gapFrame).not.toContain('"price"');

    const later = h.publishExecution(
      fill({
        fillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        price: '101.25',
        qty: '0.02',
        quoteAmount: '2.025',
        feeAmount: '0.002',
        engineSequence: 8,
      }),
    );
    expect(later).toMatchObject({ price: '101.25', qty: '0.02', quoteAmount: '2.025', feeAmount: '0.002', dropCopySeq: 2 });
    expect(typeof later!.price).toBe('string');

    const live = sink.parsed().slice(before);
    expect(live.filter((frame) => frame.type === 'status' && frame.code === DROP_COPY_GAP)).toHaveLength(1);
    const executions = live.filter((frame) => frame.type === 'execution');
    expect(executions).toEqual([
      expect.objectContaining({
        fillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        price: '101.25',
        qty: '0.02',
        quoteAmount: '2.025',
        feeAmount: '0.002',
        dropCopySeq: 2,
      }),
    ]);
    expect(typeof executions[0]!.price).toBe('string');
    expect(typeof executions[0]!.qty).toBe('string');
    expect(typeof executions[0]!.quoteAmount).toBe('string');
    expect(typeof executions[0]!.feeAmount).toBe('string');
    expect(h.recentFor(USER).map((row) => [row.price, row.qty, row.quoteAmount, row.feeAmount])).toEqual([
      ['100.5', '0.01', '1.005', '0.001005'],
      ['101.25', '0.02', '2.025', '0.002'],
    ]);
  });

  it('does not emit DROP_COPY_GAP when every send was delivered and the socket was only slow', () => {
    const h = new DropCopyHub({
      highWaterBytes: 10,
      maxLagTicks: 50,
      maxConnections: 8,
      maxConnectionsPerUser: 8,
      recentLimit: 10,
    });
    h.announceBus(true);
    const sink = new FakeSink();
    h.attach(USER, sink);
    const before = sink.frames.length;

    const delivered = h.publishExecution(fill());
    expect(delivered).toMatchObject({
      price: '100.5',
      qty: '0.01',
      quoteAmount: '1.005',
      feeAmount: '0.001005',
      dropCopySeq: 1,
    });
    expect(typeof delivered!.price).toBe('string');
    expect(typeof delivered!.qty).toBe('string');
    expect(typeof delivered!.quoteAmount).toBe('string');
    expect(typeof delivered!.feeAmount).toBe('string');

    const sent = sink.parsed().slice(before);
    expect(sent.filter((frame) => frame.type === 'execution')).toEqual([
      expect.objectContaining({
        fillId: fill().fillId,
        price: '100.5',
        qty: '0.01',
        quoteAmount: '1.005',
        feeAmount: '0.001005',
        dropCopySeq: 1,
      }),
    ]);
    expect(sent.some((frame) => frame.code === DROP_COPY_GAP)).toBe(false);
    const rawExecution = sink.frames.slice(before).find((frame) => frame.includes('"type":"execution"'));
    expect(rawExecution).toContain('"price":"100.5"');

    sink.bufferedBytes = 100;
    h.sweepLag();
    expect(sink.parsed().slice(before).some((frame) => frame.code === DROP_COPY_GAP)).toBe(false);

    sink.bufferedBytes = 0;
    h.sweepLag();

    const drained = sink.parsed().slice(before);
    expect(drained.filter((frame) => frame.type === 'status' && frame.code === DROP_COPY_GAP)).toEqual([]);
    expect(drained.filter((frame) => frame.type === 'execution')).toHaveLength(1);
    expect(sink.frames.slice(before).some((frame) => frame.includes(DROP_COPY_GAP))).toBe(false);
    expect(h.lastSeq(USER)).toBe(1);
  });

  it('does not emit DROP_COPY_GAP when the socket was only slow across connect', () => {
    const h = new DropCopyHub({
      highWaterBytes: 10,
      maxLagTicks: 50,
      maxConnections: 8,
      maxConnectionsPerUser: 8,
      recentLimit: 10,
    });
    h.announceBus(true);
    const sink = new FakeSink();
    sink.bufferedBytes = 100;
    h.attach(USER, sink);

    h.sweepLag();
    expect(sink.parsed().some((frame) => frame.code === DROP_COPY_GAP)).toBe(false);
    expect(sink.parsed().some((frame) => frame.type === 'execution')).toBe(false);

    sink.bufferedBytes = 0;
    h.sweepLag();

    expect(sink.parsed().filter((frame) => frame.type === 'status' && frame.code === DROP_COPY_GAP)).toEqual([]);
    expect(sink.frames.some((frame) => frame.includes(DROP_COPY_GAP))).toBe(false);
    expect(sink.parsed().some((frame) => frame.type === 'execution')).toBe(false);
    expect(h.lastSeq(USER)).toBe(0);
    expect(h.recentFor(USER)).toEqual([]);
    const snap = sink.parsed().find((frame) => frame.type === 'snapshot');
    expect(snap).toMatchObject({ executions: [], lastSeq: 0 });
  });

  it('replays the session ring as SESSION and still refuses complete', () => {
    const h = hub();
    h.announceBus(true);
    h.publishExecution(fill());
    const sink = new FakeSink();
    h.attach(USER, sink);
    const snap = sink.parsed().find((f) => f.type === 'snapshot');
    expect(snap).toMatchObject({ completeness: 'SESSION', replayDurable: false });
    expect((snap!.executions as unknown[]).length).toBe(1);
    expect(sink.parsed().some((f) => f.completeness === 'complete')).toBe(false);
  });
});
