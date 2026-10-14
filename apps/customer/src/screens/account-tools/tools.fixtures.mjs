// Mocked answers for the account tools tests. Labelled test data only: made-up ids and names, no real account, and a
// secret that is obviously fake. Nothing here is, or looks like, a working key.
import { readFileSync } from 'node:fs';

export const owner = '00000000-0000-4000-8000-000000000001';
export const trpc = (data) => ({ result: { data } });
export const failure = {
  status: 503,
  json: { error: { message: 'Isolated read failed', code: -32603, data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 } } },
};
export const refused = (message, code) => ({
  status: 400,
  json: { error: { message, code: -32600, data: { code: 'BAD_REQUEST', ...(code ? { cause: { code } } : {}) } } },
});

/** The only "secret" in these tests. It is shown on screen and must never be written anywhere else. */
// Built at run time so no key-shaped literal sits in the source for the secret scan to flag.
export const FAKE_SECRET = ['FAKE-KEY-FOR-TESTS-ONLY', '0000', '0000', 'NOT-A-REAL-SECRET'].join('-');

export const keys = () => [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Price alerts bot',
    prefix: 'fake_a1b2',
    scopes: ['trade:read'],
    lastUsedAt: '2026-10-13T08:30:00.000Z',
    revoked: false,
    mode: 'live',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Grid trader',
    prefix: 'fake_c3d4',
    scopes: ['trade:read', 'trade:write'],
    lastUsedAt: null,
    revoked: false,
    mode: 'live',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Old spreadsheet',
    prefix: 'fake_e5f6',
    scopes: ['trade:read'],
    lastUsedAt: '2026-09-01T12:00:00.000Z',
    revoked: true,
    mode: 'live',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Test run',
    prefix: 'fake_g7h8',
    scopes: ['trade:read'],
    lastUsedAt: null,
    revoked: false,
    mode: 'sandbox',
  },
];

export const subAccounts = () => [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    label: 'Weekend bot',
    purpose: 'Runs a grid on ETH while I am away',
    revoked: false,
    createdAt: '2026-10-10T09:41:00.000Z',
  },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'Long term', purpose: null, revoked: false, createdAt: '2026-09-20T09:41:00.000Z' },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    label: 'Old experiment',
    purpose: 'Closed in September',
    revoked: true,
    createdAt: '2026-08-01T09:41:00.000Z',
  },
];

export const rank = () => ({
  userId: owner,
  rank: 2,
  xp: '2500',
  seasonXp: '400',
  nextRankAt: '1500',
  updatedAt: '2026-10-10T08:00:00.000Z',
});
export const perks = (feeDiscountBps = 50) => ({
  feeDiscountBps,
  p2pLimitMultiplier: 1.5,
  copyFollowerCap: 10,
  lobbyHostRights: false,
  cardTier: 'none',
  otcAccess: false,
  launchpadTier: 0,
});

export const markets = JSON.parse(readFileSync(new URL('../../data/__fixtures__/markets.json', import.meta.url), 'utf8'));
/** Rates for two markets only: the others stay unset, so the page has to show dashes. */
export const fees = () => ({
  'BTC/USDT': { symbol: 'BTC/USDT', maker: '0.001', taker: '0.0015', percentage: true },
  'ETH/USDT': { symbol: 'ETH/USDT', maker: '0.001', taker: '0.0015', percentage: true },
});
