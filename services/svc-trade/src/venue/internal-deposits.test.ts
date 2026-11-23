import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { VenueRefusalError, type UserVenueDeposit } from '@intafaced/venue-contracts';
import { registerInternalVenueDeposits, type InternalDepositsDoor } from './internal-deposits.js';

// J-campaigns-04 #2 #3: svc-campaigns reads the venue's own deposits for one wallet, through the door, and nothing else.
const SECRET = 'test-internal-service-secret-at-least-32-characters';
const OWNER = '0x00000000000000000000000000000000000000a1';
const DEPOSIT: UserVenueDeposit = {
  depositRef: '84532:0xbb:0',
  txHash: '0xbb',
  asset: 'USDC',
  amount: 25_000_000_000_000_000_000n,
  status: 'credited',
  confirmations: 3,
  required: 3,
  reason: null,
  seenAt: new Date('2026-11-12T12:00:00Z'),
  explorerUrl: null,
};

function door(over: Partial<{ deposits: InternalDepositsDoor['venue'] }> = {}): InternalDepositsDoor & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    account: async (owner) => ({ venueId: 'test-venue', owner: owner.toLowerCase(), subAccount: null }),
    venue:
      over.deposits ??
      (async () => ({
        deposits: async (account) => {
          asked.push(account.owner);
          return { venueId: 'test-venue', value: [DEPOSIT], asOf: new Date('2026-11-12T12:00:05Z') } as never;
        },
      })),
  };
}

async function app(d: InternalDepositsDoor | null) {
  const a = Fastify();
  retainRawBody(a);
  registerInternalVenueDeposits(a, { door: d, secret: SECRET });
  await a.ready();
  return a;
}
const get = (owner: string, service = 'svc-campaigns') => ({
  method: 'GET' as const,
  url: `/internal/venue/deposits?owner=${owner}`,
  headers: serviceAuthHeadersForBody(service, SECRET, ''),
});

describe('GET /internal/venue/deposits', () => {
  it("answers the venue's own deposits for the wallet, amounts as decimal strings", async () => {
    const d = door();
    const res = await (await app(d)).inject(get(OWNER));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      venueId: 'test-venue',
      asOf: '2026-11-12T12:00:05.000Z',
      value: [{ depositRef: '84532:0xbb:0', asset: 'USDC', status: 'credited', seenAt: '2026-11-12T12:00:00.000Z' }],
    });
    expect(typeof res.json().value[0].amount).toBe('string');
    expect(d.asked).toEqual([OWNER]);
  });

  it('refuses a caller without credentials, any service but svc-campaigns, and an owner that is no address', async () => {
    const a = await app(door());
    expect((await a.inject({ method: 'GET', url: `/internal/venue/deposits?owner=${OWNER}` })).statusCode).toBe(401);
    expect((await a.inject(get(OWNER, 'svc-bank'))).json()).toMatchObject({ code: 'trade.deposit_read_forbidden' });
    expect((await a.inject(get('0x12'))).json()).toMatchObject({ code: 'trade.deposit_read_input' });
  });

  it('a door that is off or a venue that is down answers 503 by name, never an empty list', async () => {
    const off = await (await app(null)).inject(get(OWNER));
    expect([off.statusCode, off.json().code]).toEqual([503, 'trade.venue.door_off']);
    const down = door({
      deposits: async () => {
        throw new VenueRefusalError({ venueId: 'test-venue', code: 'venue_down', detail: 'TEST switch' });
      },
    });
    const res = await (await app(down)).inject(get(OWNER));
    expect([res.statusCode, res.json().code]).toEqual([503, 'trade.venue.venue_down']);
    const none = door({ deposits: async () => ({}) });
    expect((await (await app(none)).inject(get(OWNER))).json().code).toBe('trade.venue.not_offered');
  });
});
