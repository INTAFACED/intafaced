import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { partial } from '@intafaced/service-kit/testing';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount as a } from '@intafaced/ledger-client/money';
import type { UserVenue, UserVenueMarket, UserVenuePosition } from '@intafaced/venue-contracts';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { InMemoryEngineProtectionStore } from './protection-store.js';
import { VenueProtections } from './protections.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

describe('VenueProtections.list: lists protections after a pre-prepare engine failure', () => {
  it('returns the failed protection instead of throwing 404 trade.venue_action_unknown when a stop failed on account freeze', async () => {
    const USER = '11111111-1111-4111-8111-11111111d303';
    const OWNER = '0x1111111111111111111111111111111111111111';
    const VENUE_ID = 'sim-venue';
    const now = new Date('2026-11-20T00:00:00Z');
    const person = {
      sub: USER,
      userId: USER,
      sid: '33333333-3333-4333-8333-3333333333d3',
      scopes: ['trade:read', 'trade:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    } as Principal;

    let indexPrice = a('3000');
    const market = (): UserVenueMarket => ({
      symbol: 'ETH-PERP',
      kind: 'perpetual',
      baseAsset: 'ETH',
      quoteAsset: 'USDC',
      tickSize: a('0.1'),
      lotSize: a('0.001'),
      minNotional: a('1'),
      makerFeeBps: { known: true, value: a('1') },
      takerFeeBps: { known: true, value: a('2') },
      mark: { known: true, value: a('3000') },
      index: { known: true, value: indexPrice },
    });
    const pos: UserVenuePosition = {
      symbol: 'ETH-PERP',
      side: 'long',
      size: a('1'),
      entryPrice: a('3000'),
      markPrice: a('3000'),
      marginMode: 'isolated',
      margin: a('600'),
      leverageBps: 50_000,
      unrealisedPnl: 0n,
      liquidationPrice: a('2400'),
    };

    const store = new InMemoryEngineProtectionStore();
    const freeze = new MemoryFreezeRead();
    let approvedAgentAddress = '';

    const venue = partial<UserVenue>({
      venue: { id: VENUE_ID, displayName: 'TEST Sim', environment: 'test' },
      markets: async () => ({ value: [market()], asOf: now }),
      positions: async () => ({ value: [pos], asOf: now }),
      agents: async () => ({
        value: approvedAgentAddress ? [{ address: approvedAgentAddress, name: 'INTAFACED protections', validUntil: null }] : [],
        asOf: now,
      }),
    });

    const door = new UserVenueDoor({
      connect: async () => venue,
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { require: async () => ({ stepUpEventId: 's', consumedAt: null, replayed: false }) } as StepUpCheck,
      builder: { address: '0x00000000000000000000000000000000000000b3', feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore(['ETH-PERP'], VENUE_ID)),
      ordersPageMax: 100,
      slippageCapBps: null,
      now: () => now,
    });

    const protections = new VenueProtections({
      door,
      store,
      keySeed: 'intafaced unit TEST protection seed',
      liveTier: async () => 'basic',
      freeze,
      now: () => now,
    });
    approvedAgentAddress = protections.protectionKey(USER, OWNER).address.toLowerCase();

    const created = await protections.create(
      person,
      {
        owner: OWNER,
        symbol: 'ETH-PERP',
        kind: 'stop_market',
        side: 'sell',
        quantity: '1',
        triggerSource: 'index',
        triggerPrice: '2900',
        clientOrderId: 'stop-frozen-1',
      },
      'DE',
    );
    expect(created.restsOn).toBe('engine');

    freeze.frozenUsers.add(USER);
    indexPrice = a('2890');
    await protections.tick();

    const listed = await protections.list(person, OWNER);
    expect(listed).toEqual([
      expect.objectContaining({
        clientOrderId: 'stop-frozen-1',
        status: 'failed',
        failure: 'your account is frozen, so our engine sent no order and nothing was closed',
      }),
    ]);

    // Only the door's "no order under that key" means no order: any other failure reading it still fails the list.
    vi.spyOn(door, 'orderByKey').mockRejectedValueOnce(new Error('TEST store down'));
    await expect(protections.list(person, OWNER)).rejects.toThrow('TEST store down');
  });
});
