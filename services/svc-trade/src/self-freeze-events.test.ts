import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { subscribeSelfFreeze, type SelfFreezeConsumers } from './self-freeze-events.js';

// J-wallet-13 #1 at svc-trade's edge: identity's `selfFreezeApplied` reaches each of the three places svc-trade keeps an
// agent permission (live runs, agent accounts and their assistant, own-agent allowances), once per freeze. Each part's
// own revoke is proven in its own test (live-runs, agent-orders, own-agent-trading). TEST ids only.

const USER = '11111111-1111-4111-8111-1111111111d1';
const FREEZE = '44444444-4444-4444-8444-4444444444d1';
const key = (freezeId: string) => `identity.self_freeze.frozen:${freezeId}`;

function recorder(failOnce: keyof SelfFreezeConsumers | null = null) {
  const calls: Array<[string, string]> = [];
  let fail = failOnce;
  const part = (name: keyof SelfFreezeConsumers) => ({
    async applySelfFreeze(userId: string) {
      calls.push([name, userId]);
      if (fail === name) {
        fail = null;
        throw new Error(`TEST: ${name} could not reach the venue`);
      }
      return {} as never;
    },
  });
  const consumers: SelfFreezeConsumers = {
    liveRuns: part('liveRuns'),
    agentOrders: part('agentOrders'),
    ownAgentTrading: part('ownAgentTrading'),
  };
  return { consumers, calls };
}

describe("the owner's own freeze event in svc-trade (J-wallet-13 #1)", () => {
  it('revokes in every part for the frozen person, and a second delivery of the same freeze is one revoke', async () => {
    const bus = new MemoryEventBus('svc-identity');
    const { consumers, calls } = recorder();
    await subscribeSelfFreeze(bus, consumers);
    const payload = { userId: USER, freezeId: FREEZE, since: '2026-11-18T06:00:00.000Z' };
    await bus.publish('selfFreezeApplied', payload, { idempotencyKey: key(FREEZE) });
    await bus.publish('selfFreezeApplied', payload, { idempotencyKey: key(FREEZE) });
    expect(calls).toEqual([
      ['liveRuns', USER],
      ['agentOrders', USER],
      ['ownAgentTrading', USER],
    ]);
  });

  it('a part that fails leaves the event unfinished: every part still ran, and the redelivery finishes it', async () => {
    const bus = new MemoryEventBus('svc-identity');
    const { consumers, calls } = recorder('agentOrders');
    await subscribeSelfFreeze(bus, consumers);
    const payload = { userId: USER, freezeId: FREEZE, since: '2026-11-18T06:00:00.000Z' };
    await expect(bus.publish('selfFreezeApplied', payload, { idempotencyKey: key(FREEZE) })).rejects.toThrow(/delivered again/);
    expect(calls.map(([name]) => name)).toEqual(['liveRuns', 'agentOrders', 'ownAgentTrading']);
    await bus.publish('selfFreezeApplied', payload, { idempotencyKey: key(FREEZE) });
    expect(calls).toHaveLength(6);
    // Done now: a third delivery changes nothing.
    await bus.publish('selfFreezeApplied', payload, { idempotencyKey: key(FREEZE) });
    expect(calls).toHaveLength(6);
  });

  it('a deployment with the user-venue door off has no part to revoke and takes the event', async () => {
    const bus = new MemoryEventBus('svc-identity');
    await subscribeSelfFreeze(bus, { liveRuns: null, agentOrders: null, ownAgentTrading: null });
    await expect(
      bus.publish(
        'selfFreezeApplied',
        { userId: USER, freezeId: FREEZE, since: '2026-11-18T06:00:00.000Z' },
        { idempotencyKey: key(FREEZE) },
      ),
    ).resolves.toBeDefined();
  });
});
