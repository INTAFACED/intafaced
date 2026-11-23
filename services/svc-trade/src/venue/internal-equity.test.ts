import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type UserVenueBalance } from '@intafaced/venue-contracts';
import { readEquity, registerInternalEquity, type EquityDeps, type EquityVenue } from './internal-equity.js';

// J-campaigns-13 #2 #4: an airdrop's snapshot and a pool's minimum balance read the person's venue equity in one asset,
// from the venue's own balances of the accounts their wallet signed through our door; a failed read is never 0.
const SECRET = 'test-internal-service-secret-at-least-32-characters';
const OWNER = '0x00000000000000000000000000000000000000a1';
const NOW = new Date('2026-11-16T10:30:00Z');
const EARLIER = new Date('2026-11-16T10:29:58Z');

const balance = (asset: string, total: string): UserVenueBalance => ({
  asset,
  free: parseAmount(total),
  locked: 0n,
  total: parseAmount(total),
});

function deps(over: Partial<{ accounts: { owner: string; subAccount: string | null }[]; down: boolean }> = {}) {
  const asked: string[] = [];
  const venue: EquityVenue = {
    venue: { id: 'test-venue' },
    balances: async (account) => {
      if (over.down) throw new VenueRefusalError({ code: 'venue_down', message: 'down' } as never);
      asked.push(account.subAccount ? `${account.owner}/${account.subAccount}` : account.owner);
      return account.subAccount
        ? { value: [balance('USDC', '-12.5')], asOf: EARLIER }
        : { value: [balance('USDC', '100.25'), balance('BTC', '1'), balance('USDC', '0.75')], asOf: NOW };
    },
  };
  const d: EquityDeps = {
    venue: async () => venue,
    store: {
      ownerSignedAccounts: async (userId) => (userId === 'user-1' ? (over.accounts ?? [{ owner: OWNER, subAccount: null }]) : []),
    },
    now: () => NOW,
  };
  return { d, asked };
}

describe('readEquity', () => {
  it("adds up the venue's totals in the asset only, per account, with the venue's as-of time", async () => {
    const { d } = deps();
    expect(await readEquity(d, 'user-1', 'USDC')).toEqual({
      venueId: 'test-venue',
      asset: 'USDC',
      asOf: NOW.toISOString(),
      equity: '101',
      accounts: [{ venueAccount: OWNER, equity: '101', asOf: NOW.toISOString() }],
    });
  });

  it('keeps a negative total negative, and answers the oldest as-of time across accounts', async () => {
    const { d } = deps({
      accounts: [
        { owner: OWNER, subAccount: 'sub-1' },
        { owner: OWNER, subAccount: null },
      ],
    });
    const read = await readEquity(d, 'user-1', 'USDC');
    expect(read.equity).toBe('88.5');
    expect(read.asOf).toBe(EARLIER.toISOString());
    expect(read.accounts.map((a) => [a.venueAccount, a.equity])).toEqual([
      [OWNER, '101'],
      [`${OWNER}/sub-1`, '-12.5'],
    ]);
    const { d: onlySub } = deps({ accounts: [{ owner: OWNER, subAccount: 'sub-1' }] });
    expect((await readEquity(onlySub, 'user-1', 'USDC')).equity).toBe('-12.5');
  });

  it('answers 0 for a person with no account of theirs at the venue, read at now', async () => {
    const { d, asked } = deps();
    expect(await readEquity(d, 'user-2', 'USDC')).toEqual({
      venueId: 'test-venue',
      asset: 'USDC',
      asOf: NOW.toISOString(),
      equity: '0',
      accounts: [],
    });
    expect(asked).toEqual([]);
  });
});

async function app(d: EquityDeps | null) {
  const a = Fastify();
  retainRawBody(a);
  registerInternalEquity(a, {
    equity: d ? d : { venue: null, store: deps().d.store, now: () => NOW },
    secret: SECRET,
  });
  await a.ready();
  return a;
}
const url = (userId: string, asset = 'USDC') =>
  `/internal/venue/equity?userId=${encodeURIComponent(userId)}&asset=${encodeURIComponent(asset)}`;
const get = (path: string, service = 'svc-campaigns') => ({
  method: 'GET' as const,
  url: path,
  headers: serviceAuthHeadersForBody(service, SECRET, ''),
});

describe('GET /internal/venue/equity', () => {
  it('answers svc-campaigns with the equity as a decimal string', async () => {
    const res = await (await app(deps().d)).inject(get(url('user-1')));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ venueId: 'test-venue', asset: 'USDC', equity: '101' });
  });

  it('refuses a call without service credentials, and any other service', async () => {
    const a = await app(deps().d);
    expect((await a.inject({ method: 'GET', url: url('user-1') })).statusCode).toBe(401);
    const other = await a.inject(get(url('user-1'), 'svc-tax'));
    expect([other.statusCode, other.json().code]).toEqual([403, 'trade.equity_read_forbidden']);
  });

  it('refuses a malformed user or asset', async () => {
    const a = await app(deps().d);
    expect((await a.inject(get(url('')))).json().code).toBe('trade.equity_read_input');
    expect((await a.inject(get(url('user-1', 'usd coin')))).json().code).toBe('trade.equity_read_input');
  });

  it('answers 503 with a code when the door is off or the venue is down, never 0', async () => {
    const off = await (await app(null)).inject(get(url('user-1')));
    expect([off.statusCode, off.json().code]).toEqual([503, 'trade.venue.door_off']);
    const down = await (await app(deps({ down: true }).d)).inject(get(url('user-1')));
    expect([down.statusCode, down.json().code]).toEqual([503, 'trade.venue.venue_down']);
    expect(down.json()).not.toHaveProperty('equity');
  });
});
