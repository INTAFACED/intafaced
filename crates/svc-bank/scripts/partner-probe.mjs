// Slice `partner` with the TEST partner ON, through the TypeScript svc-bank: one scripted story of calls, each sent to
// the router and the doors as `index.ts` mounts them (tRPC through Fastify, the usage payment, the loopback record
// doors and the TEST age door), and every answer kept. `tests/partner_probe.rs` sends the same requests to the Rust
// door, in the same order, and holds each answer byte for byte. The wire replay holds the slice with the TEST partner
// off; this holds it on.
//
// The clock is pinned and moves one second a step, so both sides stamp the same times. The TEST book's boot id is
// random in each process, so it is written `<boot>` on both sides. The posting freeze and the operator's partner stop
// are set per step (`env`), the same on both sides: here a stand-in for the database's `partner_stops`,
// `partner_refusal_counts` and `business_accounts` reads (`fakeSql`), there a real Postgres.
//
// Usage (the workspace packages built, as for `record-door.mjs`):
//   TZ=UTC node --import tsx crates/svc-bank/scripts/partner-probe.mjs          writes the file
//   TZ=UTC node --import tsx crates/svc-bank/scripts/partner-probe.mjs --check  fails when it is stale

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-bank/src/`;
const OUT = `${CRATE}tests/fixtures/partner-probe.golden.json`;
const NAME = 'partner-probe';
if (!existsSync(SVC)) {
  console.error(`${NAME}: services/svc-bank no longer exists; the file it wrote is the reference now.`);
  process.exit(2);
}
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}
const CHECK = process.argv.includes('--check');
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

// ── The clock: pinned, moved by the story ──────────────────────────────────────────────────────────────────────────
export const START = Date.parse('2026-11-22T10:00:00.000Z');
let clock = START;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() {
    return clock;
  }
};

const fromService = createRequire(`${SVC}index.ts`);
const load = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const svc = (p) => import(`${SVC}${p}`);
const { default: Fastify } = await load('fastify');
const { fastifyTRPCPlugin } = await load('@trpc/server/adapters/fastify');
const contracts = await load('@intafaced/contracts');
const { createEdgeContext, encodePrincipal, retainRawBody, signPrincipalHeader, verifyServiceRequest, serviceAuthHeadersForBody } =
  contracts;
const { registerTestAgeDoor } = await load('@intafaced/service-kit');

const { createBankServices, unconfiguredRecipientState } = await svc('bank-service.ts');
const { createBankRouter } = await svc('router.ts');
const { createStepUpGate } = await svc('step-up/step-up-gate.ts');
const { unwiredApprovalConsumer } = await svc('action-approval-consume.ts');
const { unconfiguredExtraControls } = await svc('safety/extra-controls.ts');
const { unconfiguredBusinessDirectory } = await svc('business/business-directory.ts');
const { unconfiguredSecurityLock } = await svc('security-lock.ts');
const { unconfiguredApprovalMail } = await svc('ramps/address-approval.ts');
const { unconfiguredTrustedDevices } = await svc('ramps/trusted-devices.ts');
const { unconfiguredIdentityRecovery } = await svc('recovery/identity-recovery.ts');
const { cardIssuerFor } = await svc('cards/issuer.ts');
const { rampProgrammeFor } = await svc('ramps/rails.ts');
const { destinationSanctions } = await svc('ramps/sanctions-list.ts');
const { testPartner } = await svc('partner/test-partner.ts');
const { parseCashLegRates } = await svc('partner/cash-leg.ts');
const { registerAgentsUsagePayment, usagePaymentHeldBy } = await svc('agents/usage-payment.ts');
const { answerTestPartnerRecord, onLoopback, TEST_PARTNER_RECORD_BASE } = await svc('partner/test-partner-record.ts');
const { ageSharedPotInvite, ageBusinessInvite, agePayYourselfRule, ageScheduledTransfer } = await svc('test-age-door.ts');

const SECRET = 'placeholder-bank-partner-probe-edge-secret-0000';
const INTERNAL = 'placeholder-bank-partner-probe-internal-secret-0';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADA_BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB_BUSINESS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VENUE_OWNER = '0x1111111111111111111111111111111111111111';

// ── What the database would answer, as the story sets it ─────────────────────────────────────────────────────────
/** The world each step runs in: svc-ledger's freeze and the operator's stopped kinds. */
const world = { posting: true, cause: null, stopped: [] };
/** Each refusal the desk counted, `<refused_by>|<cause>|<kind>` → count. */
const counted = {};
/** The business accounts the story holds (`bank.business_accounts`), and their first administrator. */
const BUSINESSES = [
  { id: ADA_BUSINESS, name: 'TEST Ada Ltd', asset_id: 'EUR', status: 'active', owner_user_id: ADA, admin: ADA },
  { id: BOB_BUSINESS, name: 'TEST Bob Ltd', asset_id: 'EUR', status: 'active', owner_user_id: BOB, admin: BOB },
];

function fakeSql(strings, ...values) {
  const text = strings.join('$');
  if (text.includes('FROM bank.partner_stops')) {
    return Promise.resolve(world.stopped.length ? [{ stopped_kinds: [...world.stopped] }] : []);
  }
  if (text.includes('INSERT INTO bank.partner_refusal_counts')) {
    const key = `${values[0]}|${values[1]}|${values[2]}`;
    counted[key] = (counted[key] ?? 0) + 1;
    return Promise.resolve([]);
  }
  if (text.includes('FROM bank.business_accounts WHERE id =')) {
    return Promise.resolve(BUSINESSES.filter((b) => b.id === values[0]));
  }
  if (text.includes('JOIN bank.business_members')) {
    const b = BUSINESSES.find((x) => x.id === values[0] && x.status === 'active');
    return Promise.resolve(b ? [{ user_id: b.admin }] : []);
  }
  if (text.includes('UPDATE bank.business_invites')) {
    if (values[2] !== INVITE) return Promise.resolve([]);
    const secs = values[0];
    return Promise.resolve([
      { created_at: new RealDate(START - secs * 1000), expires_at: new RealDate(START + 7 * 86_400_000 - secs * 1000) },
    ]);
  }
  if (text.includes('UPDATE bank.')) return Promise.resolve([]);
  return Promise.reject(new Error(`${NAME}: no stand-in for ${text.slice(0, 80)}`));
}

function stub(name) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub(`${name}.${prop}`);
    },
    apply() {
      throw new Error(`probe stub: ${name}`);
    },
    construct() {
      throw new Error(`probe stub: new ${name}`);
    },
  });
}

// ── The service, as `index.ts` builds it for this slice ──────────────────────────────────────────────────────────
const partner = testPartner();
const freeze = {
  read: async () => ({ postingEnabled: world.posting, cause: world.posting ? null : world.cause }),
  postingEnabled: async () => world.posting,
};
/** The TEST venue's deposit control as the cash leg pays into it: it fails while the story says so. */
const venue = { fail: false, paid: [] };
const payout = {
  async pay({ ref, venue: account, coin, amount }) {
    if (venue.fail) throw new Error('the TEST venue answered 503');
    venue.paid.push({ ref, owner: account.owner, coin, amount: String(amount) });
  },
};
const bank = createBankServices(fakeSql, stub('ledger'), stub('history'), {
  testPartner: partner,
  testCashLeg: { rates: parseCashLegRates('EUR:USDC:1.08,USD:USDC:1'), payout },
  custodyLayer: 'off',
  bankApi: { allowLocalHttp: false },
  postingFreeze: freeze,
  identityRecovery: unconfiguredIdentityRecovery(),
  receiptSecret: INTERNAL,
  deposits: { custody: stub('payCustodyDeposits'), addressCap: () => undefined, addressExpiryDays: () => undefined },
  assetRegistry: stub('assetRegistry'),
  recipients: unconfiguredRecipientState(),
  requestNotices: stub('requestNotices'),
  transferNotices: stub('transferNotices'),
  scheduledNotices: stub('scheduledNotices'),
  directory: unconfiguredBusinessDirectory(),
  activity: { pages: stub('historyPages'), cursorSecret: INTERNAL, payWithdrawals: stub('payWithdrawals') },
  statementJobs: { leaseMs: null, testRenderHoldMs: null },
  loans: { priceSource: stub('tradePrices'), marginCalls: stub('marginCalls'), moduleEnabled: true },
  cardProgramme: { sanctions: () => undefined, simulatorAllowed: false },
  cards: {
    issuer: cardIssuerFor('none', { APP_ENV: 'test' }),
    cashbackEarned: stub('cashbackEarned'),
    rates: stub('cardRates'),
    moduleEnabled: true,
  },
  portfolio: { tickers: stub('tickers'), pages: stub('portfolioPages'), history: stub('holdingsHistory'), closes: stub('closes') },
  autoInvest: { enabled: true },
  ramps: {
    programme: rampProgrammeFor('none'),
    sanctions: destinationSanctions(() => undefined),
    securityLock: unconfiguredSecurityLock(),
    approvalMail: unconfiguredApprovalMail(),
    trustedDevices: unconfiguredTrustedDevices(),
  },
});
const approvals = unwiredApprovalConsumer();
const router = createBankRouter(bank, {
  extraControls: unconfiguredExtraControls(),
  scheduledTransfersEnabled: true,
  interestAccrualEnabled: true,
  loanAccrualEnabled: true,
  loanRiskSweepEnabled: false,
  autoInvestEnabled: true,
  autoInvestConvertWired: false,
  approvals,
  stepUp: createStepUpGate({ mode: 'off', approvals, store: stub('stepUpUses') }),
  statementStepUp: createStepUpGate({ mode: 'required', approvals, store: stub('stepUpUses') }),
  ownMoveStepUp: createStepUpGate({ mode: 'required', approvals, store: stub('stepUpUses') }),
});

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank', internalSecret: INTERNAL });
const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'probe-request' });
retainRawBody(app);
registerTestAgeDoor(app, {
  open: true,
  internalSecret: INTERNAL,
  subjects: {
    'shared-pot-invite': ageSharedPotInvite(fakeSql),
    'business-invite': ageBusinessInvite(fakeSql),
    'pay-yourself-rule': agePayYourselfRule(fakeSql),
    'scheduled-transfer': ageScheduledTransfer(fakeSql),
  },
  installRawBody: false,
});
registerAgentsUsagePayment(app, {
  secret: INTERNAL,
  freeze,
  businessPayer: async (id) =>
    (await fakeSql`SELECT m.user_id FROM bank.business_accounts a JOIN bank.business_members m WHERE a.id = ${id.toLowerCase()}`)[0]
      ?.user_id ?? null,
  heldBy: usagePaymentHeldBy(partner, bank.partnerCustody, 'off'),
});
const read = async (req, reply) => {
  if (!onLoopback(req.socket.remoteAddress)) return reply.code(403).send({ error: 'loopback only' });
  const below = req.url.split('?')[0].slice(TEST_PARTNER_RECORD_BASE.length);
  const [status, body] = await answerTestPartnerRecord(partner, req.method, below, req.body ?? null);
  return reply.code(status).header('cache-control', 'no-store').send(body);
};
app.get(`${TEST_PARTNER_RECORD_BASE}/venue`, read);
for (const p of ['/balances', '/moves', '/onboarding', '/direct-debits', '/dd-refund']) app.post(`${TEST_PARTNER_RECORD_BASE}${p}`, read);
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router,
    createContext: ({ req }) => {
      const ctx = edgeContext(req);
      const { service } = verifyServiceRequest(req, { legacySecret: INTERNAL, bodyBindMode: 'accept-both' });
      return { ...ctx, service };
    },
  },
});
await app.ready();

// ── The story ──────────────────────────────────────────────────────────────────────────────────────────────────────
function person(userId) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new RealDate('2099-01-01T00:00:00Z'),
  });
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'GB'), 'x-intafaced-region': 'GB' };
}
const query = (as, path, input) => ({
  as,
  method: 'GET',
  url: `/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
});
const mutate = (as, path, input) => ({
  as,
  method: 'POST',
  url: `/trpc/${path}`,
  body: input === undefined ? undefined : JSON.stringify(input),
});
const rest = (method, path, body, service) => ({ service, method, url: path, body: body === undefined ? undefined : JSON.stringify(body) });
const spend = (id, amount, kind = 'payment', assetId = 'EUR') => mutate(ADA, 'testPartner.spend', { spendId: id, assetId, amount, kind });
const leg = (quote, spend, least) => ({
  legKey: `convert-cash:${VENUE_OWNER.slice(2)}:${quote}`,
  cash: 'EUR',
  coin: 'USDC',
  spend,
  least,
  venue: { venueId: 'test-venue', owner: VENUE_OWNER.toUpperCase().replace('0X', '0x') },
});
const usage = (body) => rest('POST', '/internal/agents/usage-payment', body, 'svc-agents');
const account = (owner, extra = {}) => ({ account: { venueId: 'test-partner-bank', owner, subAccount: null, ...extra } });

const STORY = [
  ['every switch off, and nothing offered yet', query(ADA, 'testPartner.switches')],
  ['a person not held at the partner is offered no cash leg', query(ADA, 'convertCash.offers')],
  ['the spend of a person not held at the partner is refused', spend('spend-0001', '1')],
  [
    'custody off, spaces twice, a TEST holder name with spaces',
    mutate(ADA, 'testPartner.set', {
      custody: 'off',
      notOffered: ['spaces', 'pots', 'spaces'],
      holderName: '  TEST Ada Lovelace ',
      reserve: 'required',
    }),
  ],
  ['funded with TEST 100 EUR', mutate(ADA, 'testPartner.fund', { fundId: 'fund-00001', assetId: 'EUR', amount: '100' })],
  ['the same funding again is the same', mutate(ADA, 'testPartner.fund', { fundId: 'fund-00001', assetId: 'EUR', amount: '100' })],
  ['the same id with another amount conflicts', mutate(ADA, 'testPartner.fund', { fundId: 'fund-00001', assetId: 'EUR', amount: '99' })],
  ['funded with TEST 50 USD', mutate(ADA, 'testPartner.fund', { fundId: 'fund-00002', assetId: 'USD', amount: '50.25' })],
  ['a payment leaves once', spend('spend-0001', '30')],
  ['the same payment again is the same move', spend('spend-0001', '30')],
  ['the same id with another amount conflicts', spend('spend-0001', '31')],
  ['a payout', spend('spend-0002', '10', 'payout')],
  ['a fee', spend('spend-0003', '0.5', 'fee')],
  ['more than the partner holds', spend('spend-0004', '1000')],
  ['an amount of zero', spend('spend-0005', '0')],
  ['a currency the person holds nothing in', spend('spend-0006', '1', 'payment', 'GBP')],
  ['the next reply is lost', mutate(ADA, 'testPartner.set', { nextReply: 'lost' })],
  ['the move is made and its answer lost', spend('spend-0007', '5')],
  ['the retry is answered with the one move', spend('spend-0007', '5')],
  ['posting frozen on svc-ledger', spend('spend-0008', '1'), { posting: false, cause: 'mismatch' }],
  ['the freeze unreadable cause is not reported', spend('spend-0008', '1'), { posting: false, cause: null }],
  ['the operator stops bank moves', spend('spend-0008', '1'), { stopped: ['bank_move'] }],
  ['a stop of another kind leaves moves open', spend('spend-0008', '1'), { stopped: ['card_hold'] }],
  ['the partner down', mutate(ADA, 'testPartner.set', { down: true })],
  ['a spend while down', spend('spend-0009', '1')],
  ['a funding while down', mutate(ADA, 'testPartner.fund', { fundId: 'fund-00003', assetId: 'EUR', amount: '1' })],
  ['no cash leg while down', query(ADA, 'convertCash.offers')],
  ['the switches while down', query(ADA, 'testPartner.switches')],
  [
    'answering again, cash leg off, unknown fee',
    mutate(ADA, 'testPartner.set', { down: false, notOffered: ['cash_leg'], fee: 'unknown', holderName: null }),
  ],
  ['no cash leg when switched off', query(ADA, 'convertCash.offers')],
  ['a carry when switched off', mutate(ADA, 'convertCash.carry', leg('quote_0001', '20', '21.6'))],
  ['the cash leg on again', mutate(ADA, 'testPartner.set', { notOffered: [] })],
  ['the offers with the partner balance', query(ADA, 'convertCash.offers')],
  ['a carry at a rate that moved', mutate(ADA, 'convertCash.carry', leg('quote_0002', '20', '21.61'))],
  ['a carry with no rate', mutate(ADA, 'convertCash.carry', { ...leg('quote_0003', '20', '1'), coin: 'BTC' })],
  ['a carry is made and paid out', mutate(ADA, 'convertCash.carry', leg('quote_0001', '20', '21.6'))],
  ['the same carry again', mutate(ADA, 'convertCash.carry', leg('quote_0001', '20', '21.6'))],
  ['another body under the key', mutate(ADA, 'convertCash.carry', leg('quote_0001', '21', '21.6'))],
  ['the leg read', query(ADA, 'convertCash.leg', { legKey: leg('quote_0001', '1', '1').legKey })],
  ['another person reads no leg', query(BOB, 'convertCash.leg', { legKey: leg('quote_0001', '1', '1').legKey })],
  ['the venue does not answer', mutate(ADA, 'convertCash.carry', leg('quote_0004', '10.333333', '1')), { venueFails: true }],
  ['the leg reads sending', query(ADA, 'convertCash.leg', { legKey: leg('quote_0004', '1', '1').legKey })],
  ['asked again once the venue answers, it is paid once', mutate(ADA, 'convertCash.carry', leg('quote_0004', '10.333333', '1'))],
  ['a request opened', mutate(ADA, 'testPartner.openCompliance', { kind: 'request', id: 'request-0001', dueDays: 14 })],
  ['the same request again', mutate(ADA, 'testPartner.openCompliance', { kind: 'request', id: 'request-0001', dueDays: 30 })],
  ['a review opened', mutate(ADA, 'testPartner.openCompliance', { kind: 'review', id: 'review-0001', dueDays: 365 })],
  ['a mutation with no body and no content type', mutate(ADA, 'testPartner.closurePaidOut')],
  ['a mutation sent as plain text', { ...mutate(ADA, 'testPartner.closurePaidOut', {}), type: 'text/plain' }],
  ['a mutation in a media type nothing reads', { ...mutate(ADA, 'testPartner.closurePaidOut'), body: '<a/>', type: 'application/xml' }],
  ['a mutation with a body and no content type', { ...mutate(ADA, 'testPartner.closurePaidOut', {}), type: null }],
  ['a JSON mutation with an empty body', { ...mutate(ADA, 'testPartner.closurePaidOut'), body: '', type: 'application/json' }],
  ['a mutation with no content type and no person', { method: 'POST', url: '/trpc/testPartner.closurePaidOut' }],
  ['a query posted without a content type', { method: 'POST', url: '/trpc/testPartner.switches', as: ADA }],
  ['no closure waits for its payout', { ...mutate(ADA, 'testPartner.closurePaidOut'), body: '{}' }],
  [
    'a business that does not exist',
    mutate(ADA, 'testPartner.fundBusiness', { accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fundId: 'bfund-0001', amount: '10' }),
  ],
  ['another owner’s business', mutate(ADA, 'testPartner.fundBusiness', { accountId: BOB_BUSINESS, fundId: 'bfund-0001', amount: '10' })],
  ['the owner’s business funded', mutate(ADA, 'testPartner.fundBusiness', { accountId: ADA_BUSINESS, fundId: 'bfund-0001', amount: '10' })],
  [
    'the business’s statement',
    query(ADA, 'testPartner.businessStatement', {
      accountId: ADA_BUSINESS,
      from: '2026-11-22T09:00:00.000Z',
      to: '2026-11-23T00:00:00.000Z',
    }),
  ],
  [
    'a statement before the funding',
    query(ADA, 'testPartner.businessStatement', {
      accountId: ADA_BUSINESS,
      from: '2026-11-21T00:00:00.000Z',
      to: '2026-11-22T10:00:10.000Z',
    }),
  ],
  [
    'a business owner not held at the partner',
    mutate(BOB, 'testPartner.fundBusiness', { accountId: BOB_BUSINESS, fundId: 'bfund-0002', amount: '10' }),
  ],
  ['the usage read of a partner-held person', usage({ action: 'read', userId: ADA, assetId: 'EUR' })],
  ['the usage read of a person not held', usage({ action: 'read', userId: BOB, assetId: 'EUR' })],
  [
    'the usage read of a business paid by its owner',
    usage({ action: 'read', userId: BOB, assetId: 'EUR', businessId: ADA_BUSINESS.toUpperCase() }),
  ],
  ['a usage payment', usage({ action: 'collect', userId: ADA, assetId: 'EUR', amount: '2.5', chargeKey: 'agent.usage:window-0001' })],
  [
    'the same usage payment while frozen: the guarded move asks the freeze again',
    usage({ action: 'collect', userId: ADA, assetId: 'EUR', amount: '2.5', chargeKey: 'agent.usage:window-0001' }),
    { posting: false, cause: 'person' },
  ],
  [
    'a new usage payment while frozen',
    usage({ action: 'collect', userId: ADA, assetId: 'EUR', amount: '1', chargeKey: 'agent.usage:window-0002' }),
    { posting: false, cause: 'person' },
  ],
  [
    'a usage payment while stopped',
    usage({ action: 'collect', userId: ADA, assetId: 'EUR', amount: '1', chargeKey: 'agent.usage:window-0002' }),
    { stopped: ['bank_move'] },
  ],
  [
    'a usage payment past the balance',
    usage({ action: 'collect', userId: ADA, assetId: 'EUR', amount: '1000', chargeKey: 'agent.usage:window-0003' }),
  ],
  ['a usage payment of zero', usage({ action: 'collect', userId: ADA, assetId: 'EUR', amount: '0', chargeKey: 'agent.usage:window-0004' })],
  [
    'a usage payment of a person not held',
    usage({ action: 'collect', userId: BOB, assetId: 'EUR', amount: '1', chargeKey: 'agent.usage:window-0005' }),
  ],
  ['the partner’s venue', rest('GET', '/test-partner/venue')],
  ['the partner’s balances', rest('POST', '/test-partner/balances', account(ADA))],
  ['the partner’s moves', rest('POST', '/test-partner/moves', account(ADA))],
  ['the partner’s onboarding', rest('POST', '/test-partner/onboarding', account(ADA))],
  ['the partner’s direct debits', rest('POST', '/test-partner/direct-debits', {})],
  ['a refund of nothing collected', rest('POST', '/test-partner/dd-refund', { owner: ADA, mandateId: 'm-1', collectionId: 'c-1' })],
  ['a refund with a field missing', rest('POST', '/test-partner/dd-refund', { owner: ADA })],
  ['another venue', rest('POST', '/test-partner/balances', account(ADA, { venueId: 'other' }))],
  ['no owner', rest('POST', '/test-partner/moves', account(''))],
  ['a sub-account', rest('POST', '/test-partner/moves', account(ADA, { subAccount: 'x' }))],
  ['no body', rest('POST', '/test-partner/moves')],
  ['the TEST age door unsigned', rest('POST', '/internal/test/age', { subject: 'business-invite', id: INVITE, ms: 1000 })],
  ['an invite aged', rest('POST', '/internal/test/age', { subject: 'business-invite', id: INVITE, ms: 1500 }, 'svc-identity')],
  [
    'an invite the door may not age',
    rest('POST', '/internal/test/age', { subject: 'shared-pot-invite', id: INVITE, ms: 1000 }, 'svc-identity'),
  ],
  [
    'an id that is no uuid',
    rest('POST', '/internal/test/age', { subject: 'pay-yourself-rule', id: 'not-a-uuid', ms: 1000 }, 'svc-identity'),
  ],
  ['a subject it does not age', rest('POST', '/internal/test/age', { subject: 'loan', id: INVITE, ms: 1000 }, 'svc-identity')],
  ['a body out of shape', rest('POST', '/internal/test/age', { subject: 7, id: '   ', ms: 0.5, extra: true }, 'svc-identity')],
  ['every switch back where the story left them', query(ADA, 'testPartner.switches')],
];

const BOOT = /test-partner-(move|quote|payment|hold)-[0-9a-f]{12}-/g;
const normal = (body) => body.replace(BOOT, 'test-partner-$1-<boot>-').replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"');

const steps = [];
for (const [name, req, env = {}] of STORY) {
  clock += 1_000;
  world.posting = env.posting ?? true;
  world.cause = env.cause ?? null;
  world.stopped = env.stopped ?? [];
  venue.fail = env.venueFails ?? false;
  const headers = req.as ? person(req.as) : {};
  if (req.service) Object.assign(headers, serviceAuthHeadersForBody(req.service, INTERNAL, req.body ?? ''));
  // The content type is JSON's whenever there is a body, unless the step names its own (`null` for none).
  const type = req.type !== undefined ? req.type : req.body === undefined ? null : 'application/json';
  const sent = type === null ? headers : { ...headers, 'content-type': type };
  const res = await app.inject({
    method: req.method,
    url: req.url,
    headers: sent,
    ...(req.body === undefined ? {} : { payload: req.body }),
  });
  steps.push({
    name,
    at: new RealDate(clock).toISOString(),
    env: { posting: world.posting, cause: world.cause, stopped: world.stopped, venueFails: venue.fail },
    as: req.as ?? null,
    service: req.service ?? null,
    method: req.method,
    url: req.url,
    headers: sent,
    body: req.body ?? null,
    status: res.statusCode,
    answer: normal(res.body),
  });
}
await app.close();

// Written as Prettier formats it, so the repository's format check and `--check` agree.
const prettier = createRequire(`${ROOT}package.json`)('prettier');
const file = await prettier.format(
  `${JSON.stringify(
    {
      note: 'Written by crates/svc-bank/scripts/partner-probe.mjs from the TypeScript svc-bank; never edited by hand.',
      secret: SECRET,
      internal: INTERNAL,
      businesses: BUSINESSES.map(({ id, name, asset_id, status, owner_user_id, admin }) => ({
        id,
        name,
        asset_id,
        status,
        owner_user_id,
        admin,
      })),
      steps,
      counted,
      venuePaid: venue.paid,
    },
    null,
    2,
  )}\n`,
  { ...(await prettier.resolveConfig(OUT)), filepath: OUT },
);
const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
if (CHECK) {
  const now = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (now !== file) {
    console.error(`${NAME}: ${OUT} is stale (${digest(now)} ≠ ${digest(file)}); run without --check`);
    process.exit(1);
  }
  console.log(`${NAME}: up to date, ${steps.length} steps`);
} else {
  writeFileSync(OUT, file);
  console.log(`${NAME}: wrote ${steps.length} steps`);
}
