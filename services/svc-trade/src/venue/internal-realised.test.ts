import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type UserVenueFill } from '@intafaced/venue-contracts';
import { readRealised, registerInternalRealised, type RealisedDeps, type RealisedVenue } from './internal-realised.js';

// J-bank-31 #2 #7: pay yourself moves what the person's trading realised, as the venue reports it on closing fills of
// their main venue accounts; a failed read is never 0.
const SECRET = 'test-internal-service-secret-at-least-32-characters';
const OWNER = '0x00000000000000000000000000000000000000a1';
const NOW = new Date('2026-11-17T10:30:00Z');
const SINCE = new Date('2026-11-17T09:00:00Z');

const fill = (over: Partial<UserVenueFill>): UserVenueFill => ({
  fillId: 'f',
  venueClientOrderId: null,
  symbol: 'TEST-PERP',
  side: 'sell',
  price: parseAmount('1'),
  amount: parseAmount('1'),
  role: 'taker',
  venueFee: 0n,
  builderFee: 0n,
  feeAsset: 'USDC',
  realisedPnl: null,
  filledAt: new Date('2026-11-17T10:00:00Z'),
  ...over,
});

function deps(over: Partial<{ down: boolean; fills: UserVenueFill[] }> = {}) {
  const asked: string[] = [];
  const venue: RealisedVenue = {
    venue: { id: 'test-venue' },
    markets: async () => ({
      value: [
        { symbol: 'TEST-PERP', quoteAsset: 'USDC' },
        { symbol: 'TEST-BTC', quoteAsset: 'BTC' },
      ],
    }),
    fills: async (account) => {
      if (over.down) throw new VenueRefusalError({ code: 'venue_down', message: 'down' } as never);
      asked.push(account.subAccount ? `${account.owner}/${account.subAccount}` : account.owner);
      return {
        asOf: NOW,
        value: over.fills ?? [
          fill({ fillId: 'open' }), // opening: reports none
          fill({ fillId: 'close', realisedPnl: parseAmount('300') }),
          fill({ fillId: 'loss', realisedPnl: parseAmount('-20.5') }),
          fill({ fillId: 'other-quote', symbol: 'TEST-BTC', realisedPnl: parseAmount('1') }),
          fill({ fillId: 'before', realisedPnl: parseAmount('50'), filledAt: new Date('2026-11-17T08:00:00Z') }),
        ],
      };
    },
  };
  const d: RealisedDeps = {
    venue: async () => venue,
    store: {
      ownerSignedAccounts: async (userId) =>
        userId === 'user-1'
          ? [
              { owner: OWNER, subAccount: null },
              { owner: OWNER, subAccount: 'sub-1' },
            ]
          : [],
    },
    now: () => NOW,
  };
  return { d, asked };
}

describe('readRealised', () => {
  it("adds up the venue's realised result on closing fills in the window, of markets quoted in the asset, on main accounts only", async () => {
    const { d, asked } = deps();
    expect(await readRealised(d, 'user-1', 'USDC', SINCE, NOW)).toEqual({
      venueId: 'test-venue',
      asset: 'USDC',
      since: SINCE.toISOString(),
      until: NOW.toISOString(),
      asOf: NOW.toISOString(),
      realised: '279.5',
      accounts: [{ owner: OWNER, realised: '279.5', asOf: NOW.toISOString() }],
    });
    // A sub-account's result is not withdrawable from the main account, so it is never read.
    expect(asked).toEqual([OWNER]);
  });

  it('answers 0 for a person with no account at the venue', async () => {
    const { d, asked } = deps();
    expect((await readRealised(d, 'user-2', 'USDC', SINCE, NOW)).realised).toBe('0');
    expect(asked).toEqual([]);
  });
});

async function app(d: RealisedDeps | null) {
  const a = Fastify();
  retainRawBody(a);
  registerInternalRealised(a, { realised: d ? d : { venue: null, store: deps().d.store, now: () => NOW }, secret: SECRET });
  await a.ready();
  return a;
}
const url = (userId: string, since = SINCE.toISOString()) =>
  `/internal/venue/realised?userId=${encodeURIComponent(userId)}&asset=USDC&since=${encodeURIComponent(since)}`;
const get = (path: string, service = 'svc-bank') => ({
  method: 'GET' as const,
  url: path,
  headers: serviceAuthHeadersForBody(service, SECRET, ''),
});

describe('GET /internal/venue/realised', () => {
  it('answers svc-bank with the realised result as a decimal string', async () => {
    const res = await (await app(deps().d)).inject(get(url('user-1')));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ venueId: 'test-venue', asset: 'USDC', realised: '279.5' });
  });

  it('refuses a call without service credentials, and any other service', async () => {
    const a = await app(deps().d);
    expect((await a.inject({ method: 'GET', url: url('user-1') })).statusCode).toBe(401);
    const other = await a.inject(get(url('user-1'), 'svc-campaigns'));
    expect([other.statusCode, other.json().code]).toEqual([403, 'trade.realised_read_forbidden']);
  });

  it('refuses a missing since time', async () => {
    const res = await (await app(deps().d)).inject(get(url('user-1', 'soon')));
    expect([res.statusCode, res.json().code]).toEqual([400, 'trade.realised_read_input']);
  });

  it('answers 503 with a code when the door is off or the venue is down, never 0', async () => {
    const off = await (await app(null)).inject(get(url('user-1')));
    expect([off.statusCode, off.json().code]).toEqual([503, 'trade.venue.door_off']);
    const down = await (await app(deps({ down: true }).d)).inject(get(url('user-1')));
    expect([down.statusCode, down.json().code]).toEqual([503, 'trade.venue.venue_down']);
    expect(down.json()).not.toHaveProperty('realised');
  });
});
