import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type UserVenueFill } from '@intafaced/venue-contracts';
import { readOurFills, registerInternalOurFills, type OurFillsDeps, type OurFillsVenue } from './internal-our-fills.js';

// J-campaigns-11 #3 #4: a competition's volume is read from the venue's own fills of orders placed through our door, with
// our builder fee above zero, once per venue fill and account.
const SECRET = 'test-internal-service-secret-at-least-32-characters';
const OWNER = '0x00000000000000000000000000000000000000a1';
const SINCE = new Date('2026-11-16T10:00:00Z');
const NOW = new Date('2026-11-16T10:30:00Z');

function fill(over: Partial<UserVenueFill> & { fillId: string }): UserVenueFill {
  return {
    venueClientOrderId: `ours-${over.fillId}`,
    symbol: 'BTC-USDC',
    side: 'sell',
    price: parseAmount('60000'),
    amount: parseAmount('0.5'),
    role: 'taker',
    venueFee: parseAmount('1.5'),
    builderFee: parseAmount('0.3'),
    feeAsset: 'USDC',
    realisedPnl: null,
    filledAt: new Date('2026-11-16T10:05:00Z'),
    ...over,
  };
}

const FILLS: UserVenueFill[] = [
  fill({ fillId: 'f1' }),
  // Placed through another front end: the venue reports a builder fee, but the order is none our door signed.
  fill({ fillId: 'f2', venueClientOrderId: 'elsewhere-1' }),
  // Ours, but with no builder fee of ours, or below zero: adds nothing.
  fill({ fillId: 'f3', builderFee: 0n }),
  fill({ fillId: 'f4', builderFee: -parseAmount('0.1') }),
  // Before the competition's start.
  fill({ fillId: 'f5', filledAt: new Date('2026-11-16T09:59:59Z') }),
  fill({ fillId: 'f6', price: parseAmount('59990'), amount: parseAmount('0.25'), filledAt: new Date('2026-11-16T10:06:00Z') }),
  // A market the venue no longer lists: no quote asset to count it in.
  fill({ fillId: 'f7', symbol: 'OLD-USDC' }),
];

function deps(over: Partial<{ accounts: { owner: string; subAccount: string | null }[]; down: boolean }> = {}) {
  const asked: { since: Date; owner: string }[] = [];
  const venue: OurFillsVenue = {
    venue: { id: 'test-venue' },
    markets: async () => ({ value: [{ symbol: 'BTC-USDC', quoteAsset: 'USDC' }], asOf: NOW }),
    fills: async (account: { owner: string }, since: Date) => {
      if (over.down) throw new VenueRefusalError({ code: 'venue_down', message: 'down' } as never);
      asked.push({ since, owner: account.owner });
      return { value: FILLS, asOf: NOW };
    },
  };
  const d: OurFillsDeps = {
    venue: async () => venue,
    store: {
      ownerSignedAccounts: async (userId) => (userId === 'user-1' ? (over.accounts ?? [{ owner: OWNER, subAccount: null }]) : []),
      sentBuilderFeeOrders: async (_venueId, _account, ids) => new Set(ids.filter((id) => id.startsWith('ours-'))),
    },
    now: () => NOW,
  };
  return { d, asked };
}

describe('readOurFills', () => {
  it('keeps only fills of our signed orders with a builder fee above zero, from the start, with their notional', async () => {
    const { d, asked } = deps();
    const read = await readOurFills(d, 'user-1', SINCE);
    expect(asked).toEqual([{ since: SINCE, owner: OWNER }]);
    expect(read).toEqual({
      venueId: 'test-venue',
      asOf: NOW.toISOString(),
      value: [
        {
          fillId: 'f1',
          venueAccount: OWNER,
          symbol: 'BTC-USDC',
          quoteAsset: 'USDC',
          notional: '30000',
          builderFee: '0.3',
          feeAsset: 'USDC',
          filledAt: '2026-11-16T10:05:00.000Z',
        },
        {
          fillId: 'f6',
          venueAccount: OWNER,
          symbol: 'BTC-USDC',
          quoteAsset: 'USDC',
          notional: '14997.5',
          builderFee: '0.3',
          feeAsset: 'USDC',
          filledAt: '2026-11-16T10:06:00.000Z',
        },
      ],
    });
  });

  it("names a sub-account's fills by owner and sub-account, so the two sides of one trade stay two", async () => {
    const { d } = deps({
      accounts: [
        { owner: OWNER, subAccount: null },
        { owner: OWNER, subAccount: 'sub-1' },
      ],
    });
    const read = await readOurFills(d, 'user-1', SINCE);
    expect(read.value.map((f) => `${f.venueAccount}#${f.fillId}`)).toEqual([
      `${OWNER}#f1`,
      `${OWNER}/sub-1#f1`,
      `${OWNER}#f6`,
      `${OWNER}/sub-1#f6`,
    ]);
  });

  it('reads nothing for a person with no account of theirs at the venue', async () => {
    const { d, asked } = deps();
    expect((await readOurFills(d, 'user-2', SINCE)).value).toEqual([]);
    expect(asked).toEqual([]);
  });
});

async function app(d: ReturnType<typeof deps>['d'] | null) {
  const a = Fastify();
  retainRawBody(a);
  registerInternalOurFills(a, {
    fills: d ? d : { venue: null, store: deps().d.store, now: () => NOW },
    secret: SECRET,
  });
  await a.ready();
  return a;
}
const url = (userId: string, since = SINCE.toISOString()) =>
  `/internal/venue/our-fills?userId=${encodeURIComponent(userId)}&since=${encodeURIComponent(since)}`;
const get = (path: string, service = 'svc-campaigns') => ({
  method: 'GET' as const,
  url: path,
  headers: serviceAuthHeadersForBody(service, SECRET, ''),
});

describe('GET /internal/venue/our-fills', () => {
  it('answers svc-campaigns with the fills, amounts as decimal strings', async () => {
    const res = await (await app(deps().d)).inject(get(url('user-1')));
    expect(res.statusCode).toBe(200);
    expect(res.json().value.map((f: { fillId: string; notional: string }) => [f.fillId, f.notional])).toEqual([
      ['f1', '30000'],
      ['f6', '14997.5'],
    ]);
  });

  it('refuses a call without service credentials, and any other service', async () => {
    const a = await app(deps().d);
    expect((await a.inject({ method: 'GET', url: url('user-1') })).statusCode).toBe(401);
    const other = await a.inject(get(url('user-1'), 'svc-tax'));
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('trade.fill_read_forbidden');
  });

  it('refuses a malformed user or time', async () => {
    const a = await app(deps().d);
    expect((await a.inject(get(url('', SINCE.toISOString())))).json().code).toBe('trade.fill_read_input');
    expect((await a.inject(get(url('user-1', 'yesterday')))).json().code).toBe('trade.fill_read_input');
  });

  it('answers 503 with a code when the door is off or the venue is down, never an empty list', async () => {
    const off = await (await app(null)).inject(get(url('user-1')));
    expect([off.statusCode, off.json().code]).toEqual([503, 'trade.venue.door_off']);
    const down = await (await app(deps({ down: true }).d)).inject(get(url('user-1')));
    expect([down.statusCode, down.json().code]).toEqual([503, 'trade.venue.venue_down']);
  });
});
