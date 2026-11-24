// Mocked answers for the Account screen test. Labelled test data only: made-up ids, no real account.
export const owner = '00000000-0000-4000-8000-000000000001';
export const trpc = (data) => ({ result: { data } });
export const failure = {
  status: 503,
  json: { error: { message: 'Isolated read failed', code: -32603, data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 } } },
};

export const rank = () => ({
  userId: owner,
  rank: 2,
  xp: '2500',
  seasonXp: '400',
  nextRankAt: '1500',
  updatedAt: '2026-10-10T08:00:00.000Z',
});
export const perks = () => ({
  feeDiscountBps: 50,
  p2pLimitMultiplier: 1.5,
  copyFollowerCap: 10,
  lobbyHostRights: false,
  cardTier: 'none',
  otcAccess: false,
  launchpadTier: 0,
});
export const passkeys = () => [
  { credentialId: 'dGVzdC1rZXktMQ', publicKey: 'x', counter: 0, createdAt: '2026-10-09T10:00:00.000Z', transports: ['internal'] },
];
export const sessions = () => ({
  userId: owner,
  sessions: [
    seat('11111111-1111-4111-8111-111111111111', '2026-10-10T09:41:00.000Z'),
    seat('22222222-2222-4222-8222-222222222222', '2026-10-09T09:41:00.000Z'),
  ],
  nextCursor: null,
});
/** One live sign-in, every field svc-identity's `listSessions` answers with: last used when it began, on no device it names. */
function seat(id, createdAt) {
  return {
    id,
    familyId: id,
    createdAt,
    lastUsedAt: createdAt,
    device: null,
    userAgent: null,
    ip: null,
    country: null,
    isCurrent: false,
    revoked: false,
  };
}
/** svc-identity's `kyc.status` answer: the tier, the records, and whether the level is the trading checks' alone. */
export const kyc = (tier, records = []) => ({ tier, tradingOnly: false, records });
export const kycRecord = () => ({
  id: '33333333-3333-4333-8333-333333333333',
  userId: owner,
  tier: 'basic',
  jurisdiction: 'US',
  status: 'approved',
  reviewedAt: '2026-10-09T12:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-10-08T12:00:00.000Z',
});
export const apiKeys = () => [
  {
    id: 'key-1',
    name: 'Test key',
    prefix: 'if_test',
    scopes: ['read'],
    lastUsedAt: null,
    revoked: false,
    mode: 'sandbox',
    requireSignature: false,
    requireNonEmptyIpAllowlist: false,
    ipAllowlist: [],
  },
];
