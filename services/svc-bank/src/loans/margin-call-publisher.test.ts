import { describe, expect, it } from 'vitest';
import { MemoryEventBus, bankMarginCalled } from '@intafaced/events';
import { parseAmount } from '@intafaced/ledger-client';
import { eventMarginCallSink } from './margin-call-publisher.js';

/**
 * THE HALF THAT WAS MISSING.
 *
 * svc-notify's `bankMarginCalled` consumer has been complete since svc-notify
 * shipped and parked on a stream nothing created, so a margin call started a
 * grace clock gating liquidation and the borrower was never told. These assert
 * the publish, not the notification — whether the borrower was reached is
 * svc-notify's answer and is allowed to be "no". What must never again be "no"
 * is whether anything carried the call at all.
 *
 * No database and no NATS. `MemoryEventBus` validates on the PRODUCER side
 * through the same `validatePayload` the real bus uses, so a payload this
 * accepts is one JetStream would accept — which is the only thing worth
 * certifying here.
 */
describe('bankMarginCalled publisher', () => {
  const loanId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const calledAt = new Date('2026-08-04T12:00:00.000Z');
  const graceExpiresAt = new Date('2026-08-04T13:00:00.000Z');

  const call = (overrides: Partial<Parameters<ReturnType<typeof eventMarginCallSink>['send']>[0]> = {}) => {
    const sequence = overrides.sequence ?? 1;
    return {
      loanId,
      userId,
      sequence,
      band: 'margin_call' as const,
      episode: overrides.episode ?? sequence,
      ltvBps: 7_693,
      cureCollateralAmount: parseAmount('0.0415'),
      collateralAssetId: 'BTC',
      calledAt,
      graceExpiresAt,
      ...overrides,
    };
  };

  it('publishes the call the consumer is waiting for', async () => {
    const bus = new MemoryEventBus('svc-bank');
    await eventMarginCallSink(bus).send(call());

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]!.subject).toBe(bankMarginCalled.subject);
    expect(bus.published[0]!.producer).toBe('svc-bank');
  });

  /**
   * MONEY IS A DECIMAL STRING ON THE WIRE (§0.6). The sink takes a scaled
   * bigint, because that is what the risk arithmetic produces, and it must not
   * hand a bigint or a number to the bus. A `number` here would be a rounded
   * cure figure — the exact amount a borrower has to post to avoid liquidation.
   */
  it('sends the cure figure as a decimal string, not a number', async () => {
    const bus = new MemoryEventBus('svc-bank');
    await eventMarginCallSink(bus).send(call());

    const payload = bus.published[0]!.payload as Record<string, unknown>;
    expect(payload.cureCollateralAmount).toBe('0.0415');
    expect(typeof payload.cureCollateralAmount).toBe('string');
  });

  /**
   * The bus key is loan + band + episode. `sequence` stays on the payload
   * because the consumer dedupes on `<loanId>:<sequence>`, and that sequence is
   * the episode. A cure then a new breach is a second notification. Keying on
   * the loan alone would swallow it. Keying on the envelope id would notify
   * twice on a redelivery.
   */
  it('keys on loan + band + episode, so a second episode is a second notification', async () => {
    const bus = new MemoryEventBus('svc-bank');
    const sink = eventMarginCallSink(bus);

    await sink.send(call({ sequence: 1, episode: 1 }));
    await sink.send(call({ sequence: 2, episode: 2 }));

    const keys = bus.published.map((e) => e.idempotencyKey);
    expect(keys).toEqual([`bank.margin_call:${loanId}:margin_call:1`, `bank.margin_call:${loanId}:margin_call:2`]);
  });

  it('redelivers the same call under the same key', async () => {
    const bus = new MemoryEventBus('svc-bank');
    const sink = eventMarginCallSink(bus);

    await sink.send(call({ sequence: 3 }));
    await sink.send(call({ sequence: 3 }));

    expect(new Set(bus.published.map((e) => e.idempotencyKey)).size).toBe(1);
  });

  it('carries both clocks the borrower is owed — when it was called, and when grace ends', async () => {
    const bus = new MemoryEventBus('svc-bank');
    await eventMarginCallSink(bus).send(call());

    const payload = bus.published[0]!.payload as Record<string, unknown>;
    expect(payload.calledAt).toBe('2026-08-04T12:00:00.000Z');
    expect(payload.graceExpiresAt).toBe('2026-08-04T13:00:00.000Z');
    expect(payload.loanId).toBe(loanId);
    expect(payload.userId).toBe(userId);
    expect(payload.ltvBps).toBe(7_693);
    expect(payload.collateralAssetId).toBe('BTC');
  });

  /**
   * A REFUSED PUBLISH MUST REACH THE CALLER, not be swallowed here.
   *
   * `raiseMarginCall` catches it and writes `notify_error` on the row it has
   * already committed, so a call that could not be delivered stays a real call
   * with a running grace clock and a recorded reason nobody heard about it. A
   * sink that swallowed this would make an undeliverable call indistinguishable
   * from a delivered one — which is the whole distinction the schema keeps.
   */
  it('lets a rejected publish reach the caller', async () => {
    const bus = new MemoryEventBus('svc-bank');
    await expect(eventMarginCallSink(bus).send(call({ sequence: 0 }))).rejects.toThrow();
    expect(bus.published).toHaveLength(0);
  });
});
