// Proves, without starting or touching anything: the test-world script refuses outside the local
// test stack, and its planning functions (welcome credits, founder pick, friend replies) are
// idempotent and skip the right accounts. Run: node tooling/scripts/local-test-world.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPendingForApproval } from './local-test-gates.mjs';
import {
  ACADEMY_PATHS,
  GuardError,
  POPULATE_ALERTS,
  POPULATE_FRIEND_TO_USER,
  POPULATE_PREFIX,
  POPULATE_SPACES,
  POPULATE_STEPS,
  POPULATE_TRANSFERS,
  VERIFY_READS,
  WELCOME_AMOUNTS,
  assertLocalTarget,
  doneKey,
  fromScaled,
  isSkippedAccount,
  isTestAccount,
  parseLoginFile,
  parsePopulateArgs,
  pendingWelcomes,
  pickFounder,
  pickStackScript,
  planAcademyProgress,
  planAlerts,
  planInternalTransfers,
  planRestingBuy,
  planReturns,
  planSpaces,
  MERCHANT_DISPLAY_NAME,
  MERCHANT_INVOICES,
  MERCHANT_LEGAL_NAME,
  MERCHANT_LINKS,
  MERCHANT_PAYMENTS,
  KYB_DECIDE_ACTION,
  KYB_FOUNDERS_MISSING,
  enrolledLocalFounders,
  founderVaultFiles,
  isPayScopeRefusal,
  kybDecideApprovalFields,
  kybDecideHashedBody,
  kybDecidePayloadHash,
  merchantInvoiceId,
  merchantPaymentId,
  openKybApprovalSql,
  pickReusableKybApproval,
  planKybFounderApproval,
  planMerchantPopulate,
  MERCHANT_DISPUTE,
  MERCHANT_PAYOUT_FALLBACK_RAIL,
  MERCHANT_CHECKER_ROLE,
  MERCHANT_PAYOUT_DESTINATION,
  MERCHANT_PAYOUT_PAYMENT_N,
  MERCHANT_TIER_PRICING_RULE,
  tierPricingLayerRequestId,
  MERCHANT_TIERS,
  assignTierTarget,
  defineTierTarget,
  planTierAssignment,
  planTierDefinition,
  tierAssignRequestId,
  tierChangeHash,
  tierDefineRequestId,
  MERCHANT_REFUND,
  MERCHANT_SETTLEMENT_ASSET,
  OPEN_DISPUTE_ACTION,
  describeMoneyRefusal,
  merchantRefundId,
  planMerchantPayoutStage,
  planMerchantRefund,
  merchantRefundAttemptId,
  planPayoutChecker,
  planPayoutDestination,
  merchantDisputeId,
  merchantSettlementWindows,
  openDisputeApprovalFields,
  openDisputeApprovalSql,
  openDisputeHashedBody,
  openDisputeArgs,
  planOpenDispute,
  openDisputePayloadHash,
  planMerchantDispute,
  planMerchantPayoutRequest,
  planMerchantSettlement,
  planPairApproval,
  utcDayLabel,
  populateTransferId,
  populateUuid,
  publishedStarterFeeBps,
  returnTransferId,
  seedTransferId,
  shiftPrice,
  stackStateDir,
  summarizeResults,
  toScaled,
  welcomeRef,
  localEmailOutboxPath,
  MERCHANT_OWNER,
  OwnerFactor,
  enrolledTestOperatorPair,
  signInTestOperatorPair,
  ensurePayStepUp,
  populateMerchantStepUpMoney,
  EdgeClient,
  FRIEND,
  WORLD_DEPS,
  cmdPopulate,
  ensureOwnerSecondFactor,
  ensurePayoutTeammate,
  founderChange,
  operatorPair,
  populateMerchantMoneyBlock,
  populateMerchantStep,
  refusalText,
  verifyFriend,
  readMerchantOwner,
  accessTokenMfa,
  freshTotpCode,
  loginRequestBody,
  ownerFactorRefusal,
  stackPaths,
  totpStepAt,
  planEmailConfirm,
  readLatestEmailConfirmToken,
} from './local-test-world.mjs';
import { LOCAL_TEST_DEVICE_KEY } from './local-test-device.mjs';

delete process.env.LOCAL_STACK_STATE; // the checks below assume the default state folder unless they pass an env

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'local-test-world.mjs');
const run = (home, args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

const home = mkdtempSync(join(tmpdir(), 'local-test-world-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
const marker = (extra = {}) => JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { edge: 14500, ledger: 14501 }, ...extra });
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof GuardError && re.test(e.message));
try {
  // Guard: no marker, bad marker, foreign host, foreign port, non-http.
  const here = (urls) => () => assertLocalTarget({ home, urls });
  refuses(here(['http://127.0.0.1:14500']), /marker .* not found/);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'something-else' }));
  refuses(here(['http://127.0.0.1:14500']), /not a local test stack marker/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), '{not json');
  refuses(here(['http://127.0.0.1:14500']), /unreadable/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker());
  assert.ok(assertLocalTarget({ home, urls: ['http://127.0.0.1:14500', 'http://127.0.0.1:14501'] }).marker);
  refuses(here(['http://example.com:14500']), /not http:\/\/127\.0\.0\.1/);
  refuses(here(['http://10.0.0.5:14500']), /not http:\/\/127\.0\.0\.1/);
  refuses(here(['https://127.0.0.1:14500']), /not http:\/\/127\.0\.0\.1/);
  refuses(here(['http://127.0.0.1:9999']), /not a port of the local test stack/);
  refuses(here(['not a url']), /not a URL/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker({ database: { host: 'db.prod.example' } }));
  refuses(here(['http://127.0.0.1:14500']), /database host/);

  // Guard through the real CLI: refuses (exit 1) with no marker, before any network or database use.
  const empty = mkdtempSync(join(tmpdir(), 'local-test-world-empty-'));
  for (const cmd of ['watch', 'seed', 'status']) {
    const r = run(empty, [cmd]);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /refusing: marker .* not found/);
  }
  rmSync(empty, { recursive: true, force: true });

  // Skipped accounts.
  assert.equal(isSkippedAccount('test-market-maker'), true);
  assert.equal(isSkippedAccount('test_market_maker'), true);
  assert.equal(isSkippedAccount('test_taker'), true);
  assert.equal(isSkippedAccount('Luffy'), false);
  assert.equal(isSkippedAccount('test_friend'), false);

  // Welcome plan: only ledger assets, skips the maker, idempotent once done.
  const users = [
    { id: '11111111-1111-4111-8111-111111111111', handle: 'Luffy', email: 'l@example.com', createdAt: '2026-10-13 17:23:43' },
    {
      id: '22222222-2222-4222-8222-222222222222',
      handle: 'test_market_maker',
      email: 'test-market-maker@local-test.invalid',
      createdAt: '2026-10-13 17:40:15',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      handle: 'test_friend',
      email: 'test-friend@local.test',
      createdAt: '2026-10-13 18:00:00',
    },
  ];
  const ledgerAssets = ['USDT', 'BTC', 'USD']; // ETH not in the ledger -> not credited
  const first = pendingWelcomes({ users, ledgerAssets, done: new Set() });
  assert.deepEqual(
    first.map((w) => `${w.handle}:${w.asset}:${w.amount}`),
    ['Luffy:USDT:10000', 'Luffy:BTC:0.25', 'test_friend:USDT:10000', 'test_friend:BTC:0.25'],
  );
  assert.equal(first[0].ref, `welcome-${users[0].id}-USDT`);
  assert.equal(welcomeRef('u', 'BTC'), 'welcome-u-BTC');
  assert.ok(first.every((w) => !w.handle.startsWith('test_market_maker')));
  const done = new Set(first.map((w) => doneKey(w.userId, w.asset)));
  assert.deepEqual(pendingWelcomes({ users, ledgerAssets, done }), []); // idempotent
  const withEth = pendingWelcomes({ users: [users[0]], ledgerAssets: [...ledgerAssets, 'ETH'], done });
  assert.deepEqual(
    withEth.map((w) => w.asset),
    ['ETH'],
  ); // a newly listed asset is picked up once
  assert.deepEqual(Object.keys(WELCOME_AMOUNTS), ['USDT', 'BTC', 'ETH']);
  // Refs fit local:fund's --ref rule (letters, digits, dashes; 4-64 chars).
  for (const w of first) assert.match(w.ref, /^[A-Za-z0-9-]{4,64}$/);

  // Founder = newest non-test user, never a test account.
  assert.equal(pickFounder(users).handle, 'Luffy');
  assert.equal(pickFounder([users[1], users[2]]), null);
  const newer = { id: '44444444-4444-4444-8444-444444444444', handle: 'Anna', email: 'a@example.com', createdAt: '2026-10-14 09:00:00' };
  assert.equal(pickFounder([...users, newer]).handle, 'Anna');
  assert.match(seedTransferId(users[0].id, 2), /^world-seed-11111111-2$/);
  assert.ok(seedTransferId(users[0].id, 1).length >= 8 && seedTransferId(users[0].id, 1).length <= 64);

  // Friend replies: only past the cursor, never to self, never twice.
  const friendId = users[2].id;
  const incoming = [
    { seq: 10, txId: 'aaaaaaaa-0000-4000-8000-000000000001', fromUserId: users[0].id, asset: 'USDT', amount: '5' },
    { seq: 11, txId: 'aaaaaaaa-0000-4000-8000-000000000002', fromUserId: friendId, asset: 'USDT', amount: '1' },
    { seq: 12, txId: 'aaaaaaaa-0000-4000-8000-000000000003', fromUserId: users[1].id, asset: 'USDT', amount: '2' },
    { seq: 13, txId: 'aaaaaaaa-0000-4000-8000-000000000004', fromUserId: users[0].id, asset: 'BTC', amount: '0.001' },
  ];
  const plan = planReturns({ incoming, friendId, cursor: 9, answered: new Set(), skipUserIds: new Set([users[1].id]) });
  assert.deepEqual(
    plan.map((r) => r.txId.slice(-1)),
    ['1', '4'],
  );
  assert.equal(plan[0].transferId, returnTransferId(incoming[0].txId));
  assert.match(plan[0].transferId, /^world-return-[0-9a-f]{32}$/);
  assert.deepEqual(planReturns({ incoming, friendId, cursor: 13, answered: new Set() }), []);
  assert.deepEqual(
    planReturns({ incoming, friendId, cursor: 9, answered: new Set(plan.map((r) => r.txId)), skipUserIds: new Set([users[1].id]) }),
    [],
  );

  // The two stand-in operators (local-test-gates.mjs) get no welcome funds and are never picked as the founder.
  // The local test founder pair is also not a customer.
  assert.equal(isSkippedAccount('local_test_operator_a'), true);
  assert.equal(isSkippedAccount('local_test_operator_b'), true);
  assert.equal(isSkippedAccount('local_test_operators_real_person'), false);
  assert.equal(isSkippedAccount('local_test_founder_a'), true);
  assert.equal(isSkippedAccount('local_test_founder_b'), true);
  assert.deepEqual(pendingWelcomes({ users: [{ id: 'fa', handle: 'local_test_founder_a' }], ledgerAssets: ['USDT'], done: new Set() }), []);
  assert.equal(
    pickFounder([
      { id: 'f', handle: 'Luffy', email: 'a@b.c', createdAt: '2026-10-13 17:23:43' },
      { id: 'o', handle: 'local_test_operator_a', email: 'x@y.z', createdAt: '2026-10-13 19:00:00' },
    ]).id,
    'f',
  );
  assert.deepEqual(pendingWelcomes({ users: [{ id: 'o', handle: 'local_test_operator_b' }], ledgerAssets: ['USDT'], done: new Set() }), []);

  // ── populate: state folder selection ────────────────────────────────────────
  assert.equal(stackStateDir('/h', {}), '/h/.intafaced/local-test-stack');
  assert.equal(stackStateDir('/h', { LOCAL_STACK_STATE: '/x/s3' }), '/x/s3');
  assert.throws(() => stackStateDir('/h', { LOCAL_STACK_STATE: 'relative/dir' }), GuardError);
  assert.throws(() => stackStateDir('/h', { LOCAL_STACK_STATE: '  ' }), GuardError); // a typo never falls back to the default
  // The guard reads the selected folder's marker, not the default one.
  const other = mkdtempSync(join(tmpdir(), 'local-test-world-other-'));
  writeFileSync(join(other, 'LOCAL-TEST-STACK.json'), marker());
  assert.ok(assertLocalTarget({ home: '/nowhere', urls: ['http://127.0.0.1:14500'], env: { LOCAL_STACK_STATE: other } }).marker);
  assert.throws(() => assertLocalTarget({ home: '/nowhere', urls: ['http://127.0.0.1:14500'], env: {} }), GuardError);
  rmSync(other, { recursive: true, force: true });
  // Funding runs from the checkout that started a non-default stack, else from this one.
  const fb = '/this/local-test-stack.mjs';
  assert.equal(pickStackScript({ marker: { repo: '/r' }, env: {}, fallback: fb, exists: () => true }), fb);
  assert.equal(
    pickStackScript({ marker: { repo: '/r' }, env: { LOCAL_STACK_STATE: '/x' }, fallback: fb, exists: () => true }),
    '/r/tooling/scripts/local-test-stack.mjs',
  );
  assert.equal(pickStackScript({ marker: { repo: '/r' }, env: { LOCAL_STACK_STATE: '/x' }, fallback: fb, exists: () => false }), fb);
  assert.equal(pickStackScript({ marker: { repo: 'rel' }, env: { LOCAL_STACK_STATE: '/x' }, fallback: fb, exists: () => true }), fb);

  // ── populate: the CLI refuses outside the local stack, before any network use ──
  const emptyP = mkdtempSync(join(tmpdir(), 'local-test-world-empty-p-'));
  for (const args of [['populate'], ['populate', '--dry-run'], ['populate', '--verify']]) {
    const r = run(emptyP, args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /refusing: marker .* not found/);
  }
  assert.equal(run(emptyP, ['populate', '--bogus']).status, 2);
  assert.equal(run(emptyP, ['populate', '--only', 'nope']).status, 2);
  rmSync(emptyP, { recursive: true, force: true });
  // With a valid marker, --dry-run prints the plan and changes nothing.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker({ ports: { edge: 14500, ledger: 14501, identity: 14502, bank: 14509 } }));
  const dry = run(home, ['populate', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run, nothing is changed/);
  assert.match(dry.stdout, /Savings \(test\)/);

  // ── populate: login note parsing never needs the password in output ──
  assert.deepEqual(parseLoginFile('LOCAL TEST ONLY\nEmail: a@local-test.invalid\nPassword: s3cr3t-Value\nEnter email and password'), {
    email: 'a@local-test.invalid',
    password: 's3cr3t-Value',
  });
  assert.equal(parseLoginFile('Email: a@b.c\n'), null);
  assert.equal(parseLoginFile('Password: x\n'), null);
  assert.equal(parseLoginFile(''), null);

  // ── populate: stable business keys ──
  const u1 = populateUuid('earn-a');
  assert.match(u1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(populateUuid('earn-a'), u1);
  assert.notEqual(populateUuid('earn-b'), u1);
  const uid = '7072c487-9715-4f6d-8610-5066cc8fccc7';
  for (const t of POPULATE_TRANSFERS) {
    const id = populateTransferId('xfer', uid, t.n);
    assert.ok(id.startsWith(POPULATE_PREFIX) && id.length >= 8 && id.length <= 64, id);
    assert.equal(id, populateTransferId('xfer', uid, t.n)); // a rerun sends the same key
  }
  assert.notEqual(populateTransferId('in', uid, 1), populateTransferId('out', uid, 1));
  assert.equal(new Set(POPULATE_TRANSFERS.map((t) => populateTransferId('xfer', uid, t.n))).size, POPULATE_TRANSFERS.length);

  // ── populate: spaces and internal transfers ──
  assert.ok(POPULATE_SPACES.every((s) => s.name.endsWith('(test)'))); // every name says it is test data
  assert.equal(planSpaces([]).length, POPULATE_SPACES.length);
  assert.equal(planSpaces(POPULATE_SPACES.map((s) => ({ name: s.name }))).length, 0); // idempotent
  assert.deepEqual(
    planSpaces([{ name: 'Savings (test)' }]).map((s) => s.key),
    ['travel', 'rainy', 'btc'],
  );
  const rows = [
    { id: 'p-usdt', kind: 'primary', assetId: 'USDT', name: 'USDT' },
    { id: 's-sav', kind: 'named', assetId: 'USDT', name: 'Savings (test)' },
    { id: 's-trv', kind: 'named', assetId: 'USDT', name: 'Travel (test)' },
  ];
  const tp = planInternalTransfers({ userId: uid, spaces: rows });
  assert.deepEqual(
    tp.plan.map((t) => `${t.n}:${t.fromSpaceId}>${t.toSpaceId}`),
    ['1:p-usdt>s-sav', '2:p-usdt>s-trv', '3:s-sav>s-trv'],
  );
  assert.deepEqual(
    tp.skipped.map((t) => t.n),
    [4],
  ); // the "rainy" space does not exist yet
  assert.match(tp.skipped[0].reason, /rainy/);
  assert.equal(planInternalTransfers({ userId: uid, spaces: [] }).plan.length, 0);
  assert.ok(POPULATE_FRIEND_TO_USER.every((t) => /^\d+(\.\d+)?$/.test(t.amount))); // amounts are decimal strings

  // ── populate: decimal math has no floats ──
  assert.equal(toScaled('64739.78', 8), 6473978000000n);
  assert.equal(fromScaled(6473978000000n, 8), '64739.78');
  assert.equal(fromScaled(toScaled('0.00042', 18), 18), '0.00042');
  assert.equal(shiftPrice('64739.78', 500, 0), '67976'); // +5%, floored to whole units
  assert.equal(shiftPrice('64739.78', -500, 0), '61502');
  assert.equal(shiftPrice('64739.78', -1000, 2), '58265.8');
  assert.throws(() => toScaled('1e5', 8));
  assert.throws(() => toScaled('abc', 8));

  // ── populate: alerts ──
  const marks = { 'BTC/USDT': { marketId: 'm-btc', last: '64739.78' }, 'ETH/USDT': { marketId: 'm-eth', last: '2600.5' } };
  const al = planAlerts({ marks, existing: [], wanted: POPULATE_ALERTS });
  assert.deepEqual(
    al.map((a) => `${a.symbol}:${a.direction}:${a.targetPrice}`),
    ['BTC/USDT:above:67976', 'BTC/USDT:below:61502', 'ETH/USDT:above:2730'],
  );
  const al2 = planAlerts({ marks, existing: [{ marketId: 'm-btc', direction: 'above', targetPrice: '67976' }], wanted: POPULATE_ALERTS });
  assert.equal(al2.length, 2); // idempotent: the existing one is not planned again
  assert.deepEqual(planAlerts({ marks: {}, existing: [], wanted: POPULATE_ALERTS }), []); // no price, no invented alert

  // ── populate: academy progress is partial and never the whole path ──
  const req = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual(planAcademyProgress({ requiredItemSlugs: req }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(planAcademyProgress({ requiredItemSlugs: ['a', 'b'], take: 9 }), ['a']); // always leaves one undone
  assert.deepEqual(planAcademyProgress({ requiredItemSlugs: [] }), []);
  assert.ok(ACADEMY_PATHS.every((x) => ['foundations', 'markets', 'builder', 'sovereign'].includes(x)));

  // ── populate: resting order sits under the market and respects precision and minimums ──
  const ord = planRestingBuy({
    last: '64739.78',
    bpsBelow: 1000,
    notionalTarget: '25',
    pricePrecision: '0.01',
    amountPrecision: '0.00001',
    minAmount: '0.00001',
    minCost: '5',
  });
  assert.equal(ord.price, '58265.8');
  assert.equal(ord.amount, '0.00042');
  assert.ok(toScaled(ord.price, 8) < toScaled('64739.78', 8));
  assert.throws(() =>
    planRestingBuy({
      last: '64739.78',
      bpsBelow: 1000,
      notionalTarget: '1',
      pricePrecision: '0.01',
      amountPrecision: '0.001',
      minAmount: '0.00001',
      minCost: '50',
    }),
  );

  // ── populate: summaries and arguments ──
  const sum = summarizeResults([
    { room: 'bank', item: 'a', status: 'created' },
    { room: 'bank', item: 'b', status: 'refused' },
    { room: 'earn', item: 'c', status: 'skipped' },
    { room: 'earn', item: 'd', status: 'created' },
  ]);
  assert.deepEqual(sum.total, { created: 2, exists: 0, refused: 1, skipped: 1, error: 0 });
  assert.equal(sum.rooms.bank.refused, 1);
  assert.equal(sum.rooms.earn.created, 1);
  assert.deepEqual(parsePopulateArgs(['--only', 'spaces, alerts', '--dry-run']).only, ['spaces', 'alerts']);
  assert.equal(parsePopulateArgs(['--verify']).verify, true);
  assert.equal(parsePopulateArgs(['--login-file', '/tmp/x.md']).loginFile, '/tmp/x.md');
  assert.throws(() => parsePopulateArgs(['--nope']));
  assert.equal(new Set(POPULATE_STEPS).size, POPULATE_STEPS.length);
  assert.ok(VERIFY_READS.every((r) => typeof r.count === 'function' && r.mod && r.proc));
  assert.equal(VERIFY_READS.find((r) => r.proc === 'notify.list').count({ items: [1, 2] }), 2);
  assert.equal(VERIFY_READS.find((r) => r.proc === 'mine').count(null), 0);

  // ── populate: merchant portal, through the product doors, never a minted scope ──
  const userId = '11111111-1111-4111-8111-111111111111';
  const inviteeId = '22222222-2222-4222-8222-222222222222';
  assert.equal(publishedStarterFeeBps({}), null);
  assert.equal(publishedStarterFeeBps({ PAY_MERCHANT_STARTER_FEE_BPS: '' }), null);
  assert.equal(publishedStarterFeeBps({ PAY_MERCHANT_STARTER_FEE_BPS: '150' }), 150);
  assert.equal(publishedStarterFeeBps({ PAY_MERCHANT_STARTER_FEE_BPS: '0' }), 0);
  assert.equal(publishedStarterFeeBps({ PAY_DEFAULT_FEE_BPS: '150' }), null);
  assert.equal(publishedStarterFeeBps({ PAY_MERCHANT_STARTER_FEE_BPS: 'nope' }), null);
  assert.equal(isPayScopeRefusal('Scope "pay:read" is required [FORBIDDEN]'), true);
  assert.equal(isPayScopeRefusal('Scope "pay:onboard" is required [FORBIDDEN]'), true);
  assert.equal(isPayScopeRefusal('starter fee is not configured'), false);
  assert.equal(merchantPaymentId(userId, 1), merchantPaymentId(userId, 1));
  assert.notEqual(merchantPaymentId(userId, 1), merchantPaymentId(userId, 2));
  assert.equal(MERCHANT_PAYMENTS.length, 10);
  assert.equal(MERCHANT_LINKS.length, 2);
  assert.equal(MERCHANT_INVOICES.length, 2);
  assert.ok(MERCHANT_PAYMENTS.every((p) => typeof p.amount === 'string'));

  const denied = planMerchantPopulate({ userId, scopeDenied: true, publishedFeeBps: 150 });
  assert.equal(denied.stop, 'pay-scope-unpublished');
  assert.deepEqual(denied.actions, []);
  assert.equal(JSON.stringify(denied).includes('issueAccessToken'), false);

  const noFee = planMerchantPopulate({ userId, merchant: null, publishedFeeBps: null });
  assert.equal(noFee.stop, 'starter-fee-unconfigured');
  assert.deepEqual(noFee.actions, []);

  const opened = planMerchantPopulate({ userId, merchant: null, publishedFeeBps: 150, sandboxRail: false, friendUserId: inviteeId });
  assert.equal(opened.stop, null);
  const create = opened.actions.find((a) => a.kind === 'create-merchant');
  assert.equal(create.feeBps, 150);
  assert.equal(create.legalName, MERCHANT_LEGAL_NAME);
  assert.equal(create.displayName, MERCHANT_DISPLAY_NAME);
  assert.equal(opened.actions.filter((a) => a.kind === 'create-payment').length, 10);
  assert.equal(
    opened.actions.some((a) => a.kind === 'authorize-payment'),
    false,
  );
  assert.equal(opened.actions.filter((a) => a.kind === 'create-link').length, 2);
  assert.equal(opened.actions.filter((a) => a.kind === 'create-invoice').length, 2);
  assert.equal(opened.actions.filter((a) => a.kind === 'ensure-subscription').length, 1);
  assert.equal(opened.actions.filter((a) => a.kind === 'invite').length, 1);
  assert.ok(opened.actions.some((a) => a.kind === 'submit-kyb'));
  assert.ok(opened.actions.some((a) => a.kind === 'decide-kyb'));

  const sandbox = planMerchantPopulate({ userId, merchant: { kybStatus: 'approved' }, sandboxRail: true, friendUserId: null });
  assert.ok(sandbox.actions.some((a) => a.kind === 'authorize-payment' && a.decline === true));
  assert.ok(sandbox.actions.some((a) => a.kind === 'capture-payment'));
  assert.ok(sandbox.actions.some((a) => a.kind === 'refund-payment'));
  assert.equal(
    sandbox.actions.some((a) => a.kind === 'create-merchant'),
    false,
  );
  assert.equal(
    sandbox.actions.some((a) => a.kind === 'submit-kyb'),
    false,
  );
  assert.ok(sandbox.actions.some((a) => a.kind === 'skip-invite'));

  const filled = planMerchantPopulate({
    userId,
    merchant: { id: 'm', kybStatus: 'approved' },
    sandboxRail: false,
    payments: MERCHANT_PAYMENTS.map((p) => ({ id: merchantPaymentId(userId, p.n), status: 'created' })),
    linkLabels: MERCHANT_LINKS.map((l) => l.label),
    invoiceDescriptions: MERCHANT_INVOICES.map((i) => i.description),
    mandateCustomerIds: ['LOCAL-TEST-customer-cia'],
    hasSubscription: true,
    teamUserIds: [inviteeId],
    friendUserId: inviteeId,
  });
  assert.equal(filled.stop, null);
  assert.deepEqual(filled.actions, []);
  assert.equal(merchantInvoiceId(userId, 1), merchantInvoiceId(userId, 1));

  // ── populate: settlement, payout request and dispute read first and never repeat ──
  assert.equal(utcDayLabel('2026-10-17T23:59:59.000Z'), '2026-10-17');
  assert.equal(utcDayLabel('2026-10-18T01:00:00+08:00'), '2026-10-17');
  assert.equal(utcDayLabel('nope'), null);
  const seedPay = (n, status, createdAt, capturedAmount = '1') => ({ id: merchantPaymentId(userId, n), status, createdAt, capturedAmount });
  // Only the spec payments that reach captured count; a failed or refunded one never opens a window.
  assert.deepEqual(
    merchantSettlementWindows(userId, [
      seedPay(3, 'captured', '2026-10-17T10:00:00Z'),
      seedPay(7, 'settled', '2026-10-16T10:00:00Z'),
      seedPay(5, 'refunded', '2026-10-15T10:00:00Z'),
      seedPay(4, 'failed', '2026-10-14T10:00:00Z'),
    ]),
    ['2026-10-16', '2026-10-17'],
  );
  assert.deepEqual(merchantSettlementWindows(userId, [seedPay(3, 'created', '2026-10-17T10:00:00Z')]), []);
  const dsPosted = { id: 's1', window: '2026-10-17', assetId: 'USDT', status: 'posted', net: '29.25' };
  const dsFirstRun = planMerchantSettlement({ windows: ['2026-10-17'], settlements: [] });
  assert.deepEqual(dsFirstRun, { run: ['2026-10-17'], exists: [] });
  const dsRerun = planMerchantSettlement({ windows: ['2026-10-17'], settlements: [dsPosted] });
  assert.deepEqual(dsRerun.run, [], 'a window that already has a settlement is never run again');
  assert.equal(dsRerun.exists[0].id, 's1');
  assert.deepEqual(planMerchantSettlement({ windows: ['2026-10-17'], settlements: [{ ...dsPosted, assetId: 'EUR' }] }).run, ['2026-10-17']);
  assert.equal(MERCHANT_SETTLEMENT_ASSET, 'USDT');

  assert.deepEqual(planMerchantPayoutRequest({ settlements: [], approvals: [] }), { target: null, existing: null });
  assert.equal(
    planMerchantPayoutRequest({ settlements: [{ ...dsPosted, status: 'paid_out' }], approvals: [] }).target,
    null,
    'a sent payout is not requested again',
  );
  assert.equal(planMerchantPayoutRequest({ settlements: [{ ...dsPosted, net: '0' }], approvals: [] }).target, null);
  const dsAsked = planMerchantPayoutRequest({ settlements: [dsPosted], approvals: [] });
  assert.equal(dsAsked.target.id, 's1');
  assert.equal(dsAsked.existing, null);
  for (const status of ['pending', 'approved', 'consumed']) {
    assert.equal(
      planMerchantPayoutRequest({ settlements: [dsPosted], approvals: [{ approvalId: 'a1', settlementId: 's1', status }] }).existing
        .approvalId,
      'a1',
    );
  }
  for (const status of ['expired', 'rejected', 'voided']) {
    assert.equal(
      planMerchantPayoutRequest({ settlements: [dsPosted], approvals: [{ approvalId: 'a1', settlementId: 's1', status }] }).existing,
      null,
    );
  }
  assert.equal(
    planMerchantPayoutRequest({ settlements: [dsPosted], approvals: [{ approvalId: 'a2', settlementId: 'other', status: 'pending' }] })
      .existing,
    null,
  );
  assert.equal(MERCHANT_PAYOUT_FALLBACK_RAIL, 'crypto-native');

  // Refund: 3.00 of the 18.00 payment 10, once. A recorded refund of that size is EXISTS on the rerun.
  assert.equal(MERCHANT_REFUND.amount, '3.00');
  assert.equal(MERCHANT_REFUND.n, 10);
  const rfPay = (status, refundedAmount = '0') => ({ id: merchantPaymentId(userId, 10), status, refundedAmount });
  const rfFirst = planMerchantRefund({ userId, payments: [rfPay('settled')] });
  assert.equal(rfFirst.kind, 'refund');
  assert.equal(rfFirst.amount, '3.00');
  assert.equal(rfFirst.refundId, merchantRefundId(userId, 10), 'the retry key is fixed, so a rerun cannot book a second refund');
  assert.notEqual(rfFirst.refundId, merchantRefundId(userId, 5), 'not the id of the fully refunded seed payment');
  assert.equal(planMerchantRefund({ userId, payments: [rfPay('captured')] }).kind, 'refund');
  // A refund the rail refused is reversed and its id is spent: only the next attempt gets a new, stable id.
  assert.equal(merchantRefundAttemptId(userId, 10, 1), merchantRefundId(userId, 10));
  assert.equal(merchantRefundAttemptId(userId, 10, 2), `${merchantRefundId(userId, 10)}-r2`);
  assert.equal(planMerchantRefund({ userId, payments: [rfPay('settled')], attempt: 2 }).refundId, merchantRefundAttemptId(userId, 10, 2));
  assert.equal(planMerchantRefund({ userId, payments: [rfPay('settled', '3.000000000000000000')] }).kind, 'exists');
  assert.equal(planMerchantRefund({ userId, payments: [rfPay('created')] }).kind, 'skip');
  assert.equal(planMerchantRefund({ userId, payments: [] }).kind, 'skip');

  // Saved destination: a well-formed 0x + 40 hex ref on the crypto rail; any saved row on that rail is EXISTS.
  assert.equal(MERCHANT_PAYOUT_DESTINATION.railId, MERCHANT_PAYOUT_FALLBACK_RAIL);
  assert.equal(MERCHANT_PAYOUT_DESTINATION.kind, 'crypto');
  assert.match(MERCHANT_PAYOUT_DESTINATION.ref, /^0x[0-9a-f]{40}$/);
  assert.equal(planPayoutDestination({ destinations: [] }).kind, 'set');
  assert.equal(planPayoutDestination({ destinations: [{ railId: 'card-sandbox', kind: 'bank' }] }).kind, 'set');
  assert.equal(
    planPayoutDestination({ destinations: [{ railId: 'crypto-native', kind: 'crypto', destinationMasked: '0x..' }] }).kind,
    'exists',
  );
  // J-merchant-02 #5: only an active destination is ready; a held one is waited out, an unverified one is left alone.
  const onRail = (state, activatesAt = null) => [
    { railId: 'crypto-native', kind: 'crypto', destinationMasked: '0x..', state, activatesAt },
  ];
  assert.equal(planPayoutDestination({ destinations: onRail('active') }).kind, 'exists');
  assert.deepEqual(planPayoutDestination({ destinations: onRail('held', '2026-10-30T12:00:45.000Z') }), {
    kind: 'wait',
    destination: onRail('held', '2026-10-30T12:00:45.000Z')[0],
    activatesAt: '2026-10-30T12:00:45.000Z',
  });
  assert.equal(planPayoutDestination({ destinations: onRail('unverified') }).kind, 'unverified');

  // Payout stage: request, then the second person decides, then the owner sends; a sent payout is never redone.
  // Only the settlement of the payout window is paid; an older posted window (held down by the dispute) is left alone.
  const stSettled = [dsPosted];
  const stWin = { window: '2026-10-17' };
  assert.equal(MERCHANT_PAYOUT_PAYMENT_N, 9);
  assert.equal(planMerchantPayoutStage({ settlements: [], approvals: [], ...stWin }).stage, 'none');
  assert.equal(planMerchantPayoutStage({ settlements: stSettled, approvals: [], window: null }).stage, 'none');
  assert.equal(
    planMerchantPayoutStage({ settlements: stSettled, approvals: [], window: '2026-10-18' }).stage,
    'none',
    'another day is another window',
  );
  assert.equal(planMerchantPayoutStage({ settlements: [{ ...dsPosted, net: '0' }], approvals: [], ...stWin }).stage, 'none');
  assert.equal(planMerchantPayoutStage({ settlements: stSettled, approvals: [], ...stWin }).stage, 'request');
  assert.equal(planMerchantPayoutStage({ settlements: [{ ...dsPosted, status: 'paid_out' }], approvals: [], ...stWin }).stage, 'sent');
  const stPending = { approvalId: 'a1', settlementId: 's1', status: 'pending', checkerUserId: null };
  const stage = (approvals) => planMerchantPayoutStage({ settlements: stSettled, approvals, ...stWin }).stage;
  assert.equal(stage([stPending]), 'decide');
  assert.equal(stage([{ ...stPending, checkerUserId: 'u2' }]), 'founders');
  assert.equal(stage([{ ...stPending, status: 'approved' }]), 'send');
  // An approval the payout already consumed (admitted, then refused by a later guard) resumes the send; it never files a new request.
  assert.equal(stage([{ ...stPending, status: 'consumed' }]), 'send');
  assert.equal(
    stage([
      { ...stPending, status: 'consumed' },
      { ...stPending, approvalId: 'a2', status: 'pending' },
    ]),
    'send',
  );
  assert.equal(planMerchantPayoutStage({ settlements: [{ ...dsPosted, status: 'failed' }], approvals: [], ...stWin }).stage, 'failed');
  assert.equal(stage([{ ...stPending, status: 'expired' }]), 'request');
  assert.equal(stage([{ ...stPending, settlementId: 'other' }]), 'request');

  // The second person: invited, then accepted, then only a role that can approve payouts decides. Roles are never changed.
  assert.equal(MERCHANT_CHECKER_ROLE, 'finance');
  assert.equal(planPayoutChecker({ members: [], checkerUserId: 'op-b' }).kind, 'invite');
  assert.equal(
    planPayoutChecker({ members: [{ userId: 'op-b', status: 'invited', memberId: 'm1' }], checkerUserId: 'op-b' }).memberId,
    'm1',
  );
  assert.equal(
    planPayoutChecker({ members: [{ userId: 'op-b', status: 'active', role: 'finance' }], checkerUserId: 'op-b' }).kind,
    'ready',
  );
  assert.equal(
    planPayoutChecker({ members: [{ userId: 'op-b', status: 'active', role: 'viewer' }], checkerUserId: 'op-b' }).kind,
    'wrong-role',
  );
  assert.equal(
    planPayoutChecker({ members: [{ userId: 'op-b', status: 'removed', role: 'finance' }], checkerUserId: 'op-b' }).kind,
    'unavailable',
  );

  // LOCAL TEST tiers: agreed values, defined by id and name, assigned once; only populate's own tier is ever defined again.
  assert.deepEqual(
    MERCHANT_TIERS.map((t) => [t.tier.id, t.tier.name, t.assign]),
    [
      ['local-test-tier', 'LOCAL TEST tier', true],
      ['local-test-tier-2', 'LOCAL TEST tier 2', false],
    ],
  );
  assert.ok(
    MERCHANT_TIERS.every(
      (t) => t.tier.name.startsWith('LOCAL TEST tier') && t.tier.approvalTtlSeconds === 86_400 && t.tier.reserve === null,
    ),
  );
  const [tier1, tier2] = MERCHANT_TIERS.map((t) => t.tier);
  assert.deepEqual(
    [tier1.approvalThresholds[0].amount, tier1.founderThresholds[0].amount, tier1.caps[0].limit, tier1.caps[1].limit],
    ['10', '1000', '500', 500],
  );
  assert.deepEqual(
    [tier2.approvalThresholds[0].amount, tier2.founderThresholds[0].amount, tier2.caps[0].limit, tier2.caps[1].limit],
    ['100', '5000', '5000', 5000],
  );
  // Merchant controls are required on the stack: both tiers cap one payment, a day and a month in USDT, and the assigned
  // one carries a TEST fee, or the TEST DATA payments are refused.
  for (const t of [tier1, tier2])
    assert.deepEqual(
      t.caps.filter((c) => /intake|per_payment/.test(c.kind)).map((c) => [c.kind, c.assetCode]),
      [
        ['per_payment', 'USDT'],
        ['daily_intake', 'USDT'],
        ['monthly_intake', 'USDT'],
      ],
    );
  // Amounts compare as scaled integers (two decimals), never as JS numbers.
  const cents = (v) => {
    const [whole, frac = ''] = String(v).split('.');
    return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  };
  const perPayment = tier1.caps.find((c) => c.kind === 'per_payment');
  assert.ok(
    MERCHANT_PAYMENTS.every((p) => cents(p.amount) <= cents(perPayment.limit)),
    'every TEST DATA payment fits one payment',
  );
  assert.equal(MERCHANT_TIER_PRICING_RULE.assetCode, 'USDT');
  // The fee layer's key is a business key over the tier, the version and the rules: a changed TEST rule is a new change.
  const rules = [MERCHANT_TIER_PRICING_RULE];
  assert.equal(tierPricingLayerRequestId(tier1.id, '0', rules), tierPricingLayerRequestId(tier1.id, '0', rules));
  assert.notEqual(tierPricingLayerRequestId(tier1.id, '0', rules), tierPricingLayerRequestId(tier1.id, '1', rules));
  assert.notEqual(
    tierPricingLayerRequestId(tier1.id, '0', rules),
    tierPricingLayerRequestId(tier1.id, '0', [{ ...MERCHANT_TIER_PRICING_RULE, minFee: '0.6' }]),
  );
  assert.ok(
    Number(tier1.founderThresholds[0].amount) >= Number(tier1.approvalThresholds[0].amount),
    'svc-pay refuses a founder bar under the approval bar',
  );
  assert.equal(planTierDefinition({ listed: [], tier: tier1 }).kind, 'define');
  assert.equal(planTierDefinition({ listed: [], tier: tier1 }).expectedVersion, '0');
  const tierSeen = {
    id: tier1.id,
    name: tier1.name,
    archetype: 'standard',
    caps: tier1.caps.map((c) => ({ ...c })),
    reserve: null,
    version: '1',
  };
  assert.equal(planTierDefinition({ listed: [tierSeen], tier: tier1 }).kind, 'exists');
  assert.equal(
    planTierDefinition({
      listed: [{ ...tierSeen, caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: '501.000000000000000000' }, tier1.caps[1]] }],
      tier: tier1,
    }).kind,
    'redefine',
    "populate's own tier (same id and name) on older terms is defined again",
  );
  assert.deepEqual(
    planTierDefinition({ listed: [{ ...tierSeen, caps: tierSeen.caps.slice(0, 2), version: '4' }], tier: tier1 }),
    { kind: 'redefine', tier: { ...tierSeen, caps: tierSeen.caps.slice(0, 2), version: '4' }, expectedVersion: '4' },
    'a tier from before the stack required merchant controls (no intake caps) is defined again from its version',
  );
  assert.equal(
    planTierDefinition({ listed: [{ ...tierSeen, name: 'someone else' }], tier: tier1 }).kind,
    'differs',
    'the same id under another name is not ours to rewrite',
  );
  assert.equal(
    planTierDefinition({
      listed: [
        { ...tierSeen, caps: tierSeen.caps.map((c) => (c.kind === 'daily_payout' ? { ...c, limit: '500.000000000000000000' } : c)) },
      ],
      tier: tier1,
    }).kind,
    'exists',
    'stored decimals compare as numbers',
  );
  assert.equal(planTierDefinition({ listed: [{ ...tierSeen, id: 'other-id' }], tier: tier1 }).kind, 'differs', 'looked up by name too');
  assert.equal(planTierAssignment({ profile: { tierId: null, version: '0' }, tierId: tier1.id, tierDefined: true }).kind, 'assign');
  assert.equal(planTierAssignment({ profile: { tierId: null, version: '3' }, tierId: tier1.id, tierDefined: true }).expectedVersion, '3');
  assert.equal(planTierAssignment({ profile: { tierId: tier1.id, version: '1' }, tierId: tier1.id, tierDefined: true }).kind, 'exists');
  assert.equal(planTierAssignment({ profile: { tierId: 'something', version: '1' }, tierId: tier1.id, tierDefined: true }).kind, 'other');
  assert.equal(planTierAssignment({ profile: { tierId: null, version: '0' }, tierId: tier1.id, tierDefined: false }).kind, 'skip');
  assert.equal(tierDefineRequestId(tier1.id, '0'), tierDefineRequestId(tier1.id, '0'));
  assert.notEqual(tierDefineRequestId(tier1.id, '0'), tierDefineRequestId(tier2.id, '0'));
  assert.notEqual(
    tierAssignRequestId('44444444-4444-4444-8444-444444444444', tier1.id, '0'),
    tierAssignRequestId('44444444-4444-4444-8444-444444444444', tier1.id, '1'),
  );
  assert.match(tierChangeHash(defineTierTarget(tier1), '0'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(tierChangeHash(defineTierTarget(tier1), '0'), tierChangeHash(JSON.parse(JSON.stringify(defineTierTarget(tier1))), '0'));
  assert.notEqual(tierChangeHash(defineTierTarget(tier1), '0'), tierChangeHash(defineTierTarget(tier1), '1'));
  assert.deepEqual(assignTierTarget('44444444-4444-4444-8444-444444444444', tier1.id).change, {
    kind: 'set_tier',
    tierId: tier1.id,
    archetypeId: 'standard',
  });

  // Refusals keep the service's words and name the cause for the step-up codes.
  assert.match(describeMoneyRefusal('A fresh confirmation is required. Confirm again. [FORBIDDEN]'), /^auth\.step_up_required/);
  assert.match(describeMoneyRefusal('This confirmation timed out. Confirm again. [FORBIDDEN]'), /^auth\.step_up_expired/);
  assert.match(describeMoneyRefusal('Your role on this merchant does not allow payout.send [FORBIDDEN]'), /^pay\.role_not_allowed/);
  assert.match(describeMoneyRefusal('No procedure found on path "auth.stepUpPay" [NOT_FOUND]'), /predates #5011/);
  assert.match(describeMoneyRefusal('pay.tier_unassigned'), /no risk tier/);
  assert.match(describeMoneyRefusal('pay.guard_screening_unavailable [SERVICE_UNAVAILABLE]'), /no supplier connected/);
  assert.match(describeMoneyRefusal('pay.rail_failed: No charge with reference ch_1 [BAD_REQUEST]'), /card sandbox no longer holds/);
  assert.equal(
    describeMoneyRefusal('something else [BAD_REQUEST]'),
    'something else [BAD_REQUEST]',
    'an unknown refusal comes back as received',
  );
  assert.match(describeMoneyRefusal('A fresh confirmation is required. Confirm again. [FORBIDDEN]'), /Service said: A fresh/);

  const dsMId = '44444444-4444-4444-8444-444444444444';
  const disputeFields = {
    disputeId: merchantDisputeId(userId),
    paymentId: merchantPaymentId(userId, MERCHANT_DISPUTE.n),
    merchantId: dsMId,
    amount: '12',
    assetId: 'USDT',
  };
  assert.equal(merchantDisputeId(userId), merchantDisputeId(userId));
  assert.ok(merchantDisputeId(userId).startsWith(POPULATE_PREFIX));
  assert.equal(MERCHANT_PAYMENTS.find((p) => p.n === MERCHANT_DISPUTE.n).want, 'captured', 'only a captured payment is disputed');
  const openPlan = planMerchantDispute({
    userId,
    merchantId: dsMId,
    payments: [seedPay(3, 'captured', '2026-10-17T10:00:00Z', '12')],
    existing: null,
  });
  assert.equal(openPlan.kind, 'open');
  assert.deepEqual(openPlan.fields, disputeFields);
  assert.equal(
    planMerchantDispute({ userId, merchantId: dsMId, payments: [seedPay(3, 'settled', '2026-10-17T10:00:00Z', '12')], existing: null })
      .kind,
    'open',
  );
  assert.equal(
    planMerchantDispute({
      userId,
      merchantId: dsMId,
      payments: [seedPay(3, 'captured', '2026-10-17T10:00:00Z', '12')],
      existing: { status: 'open' },
    }).kind,
    'exists',
  );
  assert.equal(
    planMerchantDispute({ userId, merchantId: dsMId, payments: [seedPay(3, 'created', '2026-10-17T10:00:00Z', '0')], existing: null }).kind,
    'skip',
  );
  assert.equal(
    planMerchantDispute({ userId, merchantId: dsMId, payments: [seedPay(3, 'disputed', '2026-10-17T10:00:00Z', '12')], existing: null })
      .kind,
    'skip',
  );
  assert.equal(planMerchantDispute({ userId, merchantId: dsMId, payments: [], existing: null }).kind, 'skip');
  // The approval binding matches svc-pay fraudOpenDisputeFields + payActionPayloadHash (approval-bindings.ts, #5010):
  // reason (trimmed) and the disputed flag are bound, in this key order.
  assert.equal(OPEN_DISPUTE_ACTION, 'pay.fraud_open_dispute');
  const boundDispute = { ...disputeFields, reasonCode: MERCHANT_DISPUTE.reasonCode, markPaymentDisputed: true };
  assert.deepEqual(Object.keys(openDisputeApprovalFields(boundDispute)), [
    'disputeId',
    'paymentId',
    'merchantId',
    'amount',
    'assetId',
    'reasonCode',
    'markPaymentDisputed',
  ]);
  assert.deepEqual(Object.keys(openDisputeHashedBody(boundDispute))[0], 'actionType');
  const disputeHash = openDisputePayloadHash(boundDispute);
  assert.notEqual(disputeHash, openDisputePayloadHash({ ...boundDispute, amount: '13' }));
  assert.notEqual(disputeHash, openDisputePayloadHash({ ...boundDispute, reasonCode: 'other' }), 'the reason is bound');
  assert.notEqual(disputeHash, openDisputePayloadHash({ ...boundDispute, markPaymentDisputed: false }), 'the flag is bound');
  assert.equal(
    openDisputePayloadHash({ ...boundDispute, reasonCode: `  ${MERCHANT_DISPUTE.reasonCode} ` }),
    disputeHash,
    'trimmed like svc-pay',
  );
  // Pinned vector: computed once from svc-pay's field order, so a key-order or encoding drift fails here.
  assert.equal(
    openDisputePayloadHash({
      disputeId: 'd-1',
      paymentId: 'p-1',
      merchantId: 'm-1',
      amount: '12',
      assetId: 'USDT',
      reasonCode: 'LOCAL-TEST product_not_received',
      markPaymentDisputed: true,
    }),
    'sha256:f445656c779dce9f47fe5497bc2764437b0a7a45692bbb216ae795bf1b5cc554',
  );
  const dsDsql = openDisputeApprovalSql(disputeHash);
  assert.match(dsDsql, /action_type = 'pay\.fraud_open_dispute'/);
  assert.match(dsDsql, /status IN \('PENDING', 'APPROVED'\)/);
  assert.throws(() => openDisputeApprovalSql("x' OR 1=1 --"), /not sha256/);
  // Pair approval: no proposal without two distinct approvers; an open dsRow is dsReused, never filed twice.
  const dsPairA = { userId: 'op-a' };
  const dsPairB = { userId: 'op-b' };
  const dsBase = { actionType: OPEN_DISPUTE_ACTION, payloadHash: disputeHash, policyVersion: 'v1', missing: 'no pair' };
  assert.deepEqual(planPairApproval({ ...dsBase, pair: [dsPairA], open: [] }), { propose: false, refusal: 'no pair' });
  assert.deepEqual(planPairApproval({ ...dsBase, pair: [dsPairA, { userId: 'op-a' }], open: [] }), { propose: false, refusal: 'no pair' });
  const dsFresh = planPairApproval({ ...dsBase, pair: [dsPairA, dsPairB], open: [] });
  assert.equal(dsFresh.propose, true);
  assert.equal(dsFresh.proposal.targetId, OPEN_DISPUTE_ACTION);
  assert.equal(dsFresh.proposerUserId, 'op-a');
  assert.equal(dsFresh.approverUserId, 'op-b');
  const dsRow = {
    approvalId: 'ap',
    operationId: 'op',
    actionType: OPEN_DISPUTE_ACTION,
    payloadHash: disputeHash,
    status: 'PENDING',
    requesterId: 'op-a',
  };
  const dsReused = planPairApproval({ ...dsBase, pair: [dsPairA, dsPairB], open: [dsRow] });
  assert.equal(dsReused.propose, false);
  assert.equal(dsReused.reuse.approvalId, 'ap');
  assert.equal(dsReused.approverUserId, 'op-b');
  assert.equal(planPairApproval({ ...dsBase, pair: [dsPairA, dsPairB], open: [{ ...dsRow, requesterId: 'stranger' }] }).propose, false);
  assert.equal(
    planPairApproval({ ...dsBase, pair: [dsPairA, dsPairB], open: [{ ...dsRow, payloadHash: `sha256:${'cd'.repeat(32)}` }] }).propose,
    true,
  );

  // ── live KYB: hash field set matches svc-pay, and an open proposal is not filed again ──
  const identityHash = `sha256:${'ab'.repeat(32)}`;
  const merchantId = '33333333-3333-4333-8333-333333333333';
  const fields = kybDecideApprovalFields({ merchantId, decision: 'approved', identityHash });
  assert.deepEqual(Object.keys(fields), ['decision', 'identityHash', 'merchantId']);
  assert.equal('reason' in fields, false);
  const hashed = kybDecideHashedBody({ merchantId, decision: 'approved', identityHash });
  assert.deepEqual(Object.keys(hashed), ['actionType', 'decision', 'identityHash', 'merchantId']);
  assert.equal(hashed.actionType, KYB_DECIDE_ACTION);
  assert.deepEqual({ decision: hashed.decision, identityHash: hashed.identityHash, merchantId: hashed.merchantId }, fields);
  const canonical = JSON.stringify(hashed);
  assert.equal(
    kybDecidePayloadHash({ merchantId, decision: 'approved', identityHash }),
    `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  );
  const oldShape = JSON.stringify({ actionType: KYB_DECIDE_ACTION, merchantId, decision: 'approved' });
  assert.notEqual(
    kybDecidePayloadHash({ merchantId, decision: 'approved', identityHash }),
    `sha256:${createHash('sha256').update(oldShape).digest('hex')}`,
  );

  const pair = [{ userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
  const payloadHash = kybDecidePayloadHash({ merchantId, decision: 'approved', identityHash });
  const pendingRow = {
    approvalId: 'appr-1',
    operationId: 'op-1',
    actionType: KYB_DECIDE_ACTION,
    payloadHash,
    status: 'PENDING',
    requesterId: pair[0].userId,
  };
  const reused = planKybFounderApproval({
    founders: pair,
    pending: [pendingRow],
    merchantId,
    decision: 'approved',
    identityHash,
    policyVersion: 'local-test:v1',
  });
  assert.equal(reused.propose, false);
  assert.equal(reused.reuse.approvalId, 'appr-1');
  assert.equal(reused.approverUserId, pair[1].userId);
  assert.equal(
    pickReusableKybApproval([pendingRow, { ...pendingRow, approvalId: 'appr-2', status: 'APPROVED' }], payloadHash).approvalId,
    'appr-2',
  );

  const fresh = planKybFounderApproval({
    founders: pair,
    pending: [{ ...pendingRow, payloadHash: `sha256:${'00'.repeat(32)}` }],
    merchantId,
    decision: 'approved',
    identityHash,
    policyVersion: 'local-test:v1',
  });
  assert.equal(fresh.propose, true);
  assert.equal(fresh.proposal.payloadHash, payloadHash);
  assert.deepEqual(Object.keys(JSON.parse(canonical)), ['actionType', 'decision', 'identityHash', 'merchantId']);

  const absent = planKybFounderApproval({
    founders: [],
    pending: [],
    merchantId,
    decision: 'approved',
    identityHash,
    policyVersion: 'local-test:v1',
  });
  assert.equal(absent.propose, false);
  assert.equal(absent.reuse, undefined);
  assert.equal(absent.refusal, KYB_FOUNDERS_MISSING);
  assert.equal(JSON.stringify(absent).includes('approvalId'), false);
  const noMerchant = planKybFounderApproval({
    founders: pair,
    pending: [],
    merchantId: undefined,
    decision: 'approved',
    identityHash,
    policyVersion: 'local-test:v1',
  });
  assert.equal(noMerchant.propose, false);
  assert.equal(noMerchant.proposal, undefined);

  const half = enrolledLocalFounders({
    founders: [
      { key: 'a', handle: 'local_test_founder_a', userId: pair[0].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
    ],
  });
  assert.equal(half, null);
  const enrolled = enrolledLocalFounders({
    founders: [
      { key: 'b', handle: 'local_test_founder_b', userId: pair[1].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
      { key: 'a', handle: 'local_test_founder_a', userId: pair[0].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
    ],
  });
  assert.deepEqual(
    enrolled.map((f) => f.handle),
    ['local_test_founder_a', 'local_test_founder_b'],
  );
  assert.equal(enrolledLocalFounders({ founders: [{ ...enrolled[0], totpConfirmed: false }, enrolled[1]] }), null);
  assert.equal(
    enrolledLocalFounders({
      founders: [
        ...enrolled,
        {
          key: 'operator',
          handle: 'local_test_operator_a',
          userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          password: 'pw',
          totpSecret: 'SECRET',
          totpConfirmed: true,
        },
      ],
    }),
    null,
  );
  assert.equal(
    enrolledLocalFounders({
      founders: [
        { key: 'nitro', handle: 'local_nitro', userId: pair[0].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
        { key: 'phantom', handle: 'local_phantom', userId: pair[1].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
      ],
    }),
    null,
  );

  const sql = openKybApprovalSql(payloadHash);
  assert.ok(sql.includes(`payload_hash = '${payloadHash}'`));
  assert.ok(sql.includes("'PENDING'"));
  assert.equal(sql.includes(merchantId), false);
  assert.throws(() => openKybApprovalSql(merchantId), /not sha256/);
  assert.deepEqual(founderVaultFiles({ stateDir: '/tmp/stack-state' }), ['/tmp/stack-state/founders.json']);
  assert.deepEqual(founderVaultFiles({ scriptRepo: '/tmp/a', stackRepo: '/tmp/a' }), []);
  assert.deepEqual(founderVaultFiles({ stateDir: 'relative' }), []);
  assert.equal(KYB_FOUNDERS_MISSING.includes('pnpm local:founder'), false);
  assert.match(KYB_FOUNDERS_MISSING, /local_test_founder_a/);
  assert.match(KYB_FOUNDERS_MISSING, /founders\.json/);

  const line =
    'LOCAL-TEST purpose=email-confirm email=Owner@Example.com expires=2026-10-17T00:00:00.000Z link=confirmEmail?token=abc%2Bdef\n' +
    'LOCAL-TEST purpose=password-reset email=owner@example.com expires=2026-10-17T00:00:00.000Z link=completePasswordReset?code=nope\n' +
    'LOCAL-TEST purpose=email-confirm email=other@example.com expires=2026-10-17T00:00:00.000Z link=confirmEmail?token=other\n';
  assert.equal(readLatestEmailConfirmToken(line, 'owner@example.com'), 'abc+def');
  assert.equal(readLatestEmailConfirmToken(line, 'other@example.com'), 'other');
  assert.equal(readLatestEmailConfirmToken('no link here', 'owner@example.com'), null);
  assert.deepEqual(planEmailConfirm({ emailVerified: true, outboxText: line, email: 'owner@example.com' }), {
    action: 'already-confirmed',
    token: null,
  });
  assert.deepEqual(planEmailConfirm({ emailVerified: false, outboxText: line, email: 'owner@example.com' }), {
    action: 'confirm',
    token: 'abc+def',
  });
  assert.equal(planEmailConfirm({ emailVerified: false, outboxText: '', email: 'owner@example.com' }).token, null);
  assert.equal(localEmailOutboxPath({ LOCAL_STACK_STATE: '/tmp/stack-state' }, '/tmp/home'), '/tmp/stack-state/email-outbox.log');

  // ── Owner second factor: login with TOTP, outbox link, enrolment store ───
  // Every scripted sign-in presents the stack's one TEST browser key (local-test-device.mjs), as the journeys' browser does.
  const deviceKey = LOCAL_TEST_DEVICE_KEY;
  assert.deepEqual(loginRequestBody({ email: 'o@x.invalid', password: 'pw' }), { identifier: 'o@x.invalid', password: 'pw', deviceKey });
  assert.deepEqual(loginRequestBody({ email: 'o@x.invalid', password: 'pw' }, ''), {
    identifier: 'o@x.invalid',
    password: 'pw',
    deviceKey,
  });
  assert.deepEqual(loginRequestBody({ email: 'o@x.invalid', password: 'pw' }, '123456'), {
    identifier: 'o@x.invalid',
    password: 'pw',
    deviceKey,
    totpCode: '123456',
  });
  // The exact line identity's local-outbox mail writes for an email-confirm (localMailLine).
  const realLine = `LOCAL-TEST purpose=email-confirm email=owner@example.com expires=2026-10-18T00:10:00.000Z link=confirmEmail?token=${encodeURIComponent('Zx-_9+/=')}\n`;
  assert.equal(readLatestEmailConfirmToken(realLine, 'OWNER@example.com'), 'Zx-_9+/=');
  assert.equal(readLatestEmailConfirmToken(realLine + realLine.replace('Zx-_9', 'newer'), 'owner@example.com'), 'newer+/=');
  {
    let clock = 10 * 30_000 + 5_000;
    const waits = [];
    const out = await freshTotpCode({
      secret: 'S',
      lastStep: 10,
      totp: async (secret) => `code-for-${secret}`,
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += 10_000;
      },
    });
    assert.equal(out.code, 'code-for-S');
    assert.equal(out.step, 11);
    assert.ok(waits.length >= 2, 'waits for the next 30 second step instead of replaying one');
    const noWait = await freshTotpCode({ secret: 'S', lastStep: 0, totp: () => 'c', now: () => clock, wait: () => assert.fail('no wait') });
    assert.equal(noWait.step, totpStepAt(clock));
  }
  {
    assert.equal(stackPaths(home).merchantOwner.startsWith(stackPaths(home).stateDir), true);
    const factorDir = mkdtempSync(join(tmpdir(), 'owner-factor-'));
    try {
      const file = join(factorDir, 'sub', 'owner-factor.json');
      let clock = 100 * 30_000;
      const mk = () => new OwnerFactor({ file, totp: (secret) => `${secret}:code`, now: () => clock, wait: async () => (clock += 30_000) });
      const f = mk();
      assert.equal(f.secret, null);
      assert.equal(await f.nextCode(), undefined, 'no secret, no code on the login');
      f.savePending('PENDINGSECRET0000', ['rc1', 'rc2']);
      assert.equal(mk().pendingSecret, 'PENDINGSECRET0000');
      assert.equal(mk().secret, null);
      f.adoptPending(100);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.match(saved.label, /LOCAL TEST/);
      assert.equal(saved.secret, 'PENDINGSECRET0000');
      assert.equal(saved.pendingSecret, undefined);
      // step 100 is spent: the next login code must come from a later step.
      const code = await mk().nextCode();
      assert.equal(code, 'PENDINGSECRET0000:code');
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastStep, 101);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      rmSync(factorDir, { recursive: true, force: true });
    }
  }
  {
    // F1: the clock moves across a 30 s boundary while the code is being made; code and step must agree.
    let clock = 50 * 30_000 + 29_900;
    const out = await freshTotpCode({
      secret: 'S',
      lastStep: 40,
      totp: async (secret, t) => {
        clock += 500;
        return `${secret}@${totpStepAt(t)}`;
      },
      now: () => clock,
      wait: () => assert.fail('no wait'),
    });
    assert.equal(out.step, 50);
    assert.equal(out.code, 'S@50');
    assert.ok(totpStepAt(clock) > out.step, 'the clock really crossed the boundary');
  }
  {
    const mfaToken = (mfa) => `h.${Buffer.from(JSON.stringify({ mfa })).toString('base64url')}.s`;
    assert.equal(accessTokenMfa(mfaToken(true)), true);
    assert.equal(accessTokenMfa(mfaToken(false)), false);
    assert.equal(accessTokenMfa('garbage'), null);
    const dir = mkdtempSync(join(tmpdir(), 'owner-factor-b-'));
    try {
      const file = join(dir, 'f.json');
      let clock = 200 * 30_000;
      const mk = () =>
        new OwnerFactor({ file, totp: (s, t) => `${s}@${totpStepAt(t)}`, now: () => clock, wait: async () => (clock += 30_000) });
      const f = mk();
      f.savePending('PENDING-LIVE-SECRET', ['rc']);
      f.markPendingStep(200);
      assert.equal(mk().pendingLastStep, 200, 'a later login never repeats the confirm step');
      assert.equal(readdirSync(dir).length, 1, 'atomic write leaves no tmp file behind');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      f.adoptPending(201);
      assert.equal(mk().secret, 'PENDING-LIVE-SECRET');
      assert.equal(mk().data.pendingStep, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.match(ownerFactorRefusal('Two-factor is already enrolled [CONFLICT]'), /holds|does not hold/);
  assert.match(ownerFactorRefusal('Two-factor is already enrolled [CONFLICT]'), /nothing was reset/);
  assert.match(ownerFactorRefusal('Verify with your second factor [FORBIDDEN]'), /cannot drive/);
  assert.equal(ownerFactorRefusal('boom [X]'), 'boom [X]');
  assert.equal(stackPaths(home).merchantOwner.endsWith('merchant-owner.json'), true);
  assert.equal(MERCHANT_OWNER.handle, 'test_merchant_owner');
  assert.match(MERCHANT_OWNER.email, /@local-test\.invalid$/);
  assert.equal(isTestAccount({ handle: MERCHANT_OWNER.handle, email: MERCHANT_OWNER.email }), true);
  {
    const pending = [
      { id: 'r1', userId: 'u1', tier: 'full' },
      { id: 'r2', userId: 'u2', tier: 'full' },
      { id: 'r3', userId: 'u1', tier: 'basic' },
      { id: 'r4', userId: 'u1', tier: 'institutional' },
    ];
    assert.deepEqual(
      selectPendingForApproval(pending).map((r) => r.id),
      ['r1', 'r2', 'r3'],
    );
    assert.deepEqual(
      selectPendingForApproval(pending, ['u1']).map((r) => r.id),
      ['r1', 'r3'],
      'a request from anyone else is never picked',
    );
    assert.deepEqual(selectPendingForApproval(pending, ['nobody']), []);
  }
  {
    const op = (l, extra = {}) => ({
      handle: `local_test_operator_${l}`,
      userId: `00000000-0000-4000-8000-00000000000${l === 'a' ? 1 : 2}`,
      password: 'pw',
      totpSecret: 'SECRETSECRETSECRET',
      lastStep: 5,
      ...extra,
    });
    const ready = { operators: { a: op('a'), b: op('b') } };
    assert.deepEqual(
      enrolledTestOperatorPair(ready).map((x) => x.handle),
      ['local_test_operator_a', 'local_test_operator_b'],
    );
    assert.equal(JSON.stringify(enrolledTestOperatorPair(ready)).includes('SECRET'), false, 'no secret leaves the file');
    assert.equal(enrolledTestOperatorPair(null), null);
    assert.equal(enrolledTestOperatorPair({ operators: { a: op('a') } }), null);
    assert.equal(enrolledTestOperatorPair({ operators: { a: op('a'), b: op('b', { totpSecret: '' }) } }), null);
    assert.equal(enrolledTestOperatorPair({ operators: { a: op('a'), b: op('b', { password: undefined }) } }), null);
    assert.equal(enrolledTestOperatorPair({ operators: { a: op('a'), b: op('b', { handle: 'real_person' }) } }), null);
    assert.equal(
      enrolledTestOperatorPair({ operators: { a: op('a'), b: op('b', { userId: op('a').userId }) } }),
      null,
      'two distinct people',
    );
  }
  {
    const d = mkdtempSync(join(tmpdir(), 'merchant-owner-'));
    try {
      const file = join(d, 'merchant-owner.json');
      assert.equal(readMerchantOwner(file), null);
      const f = new OwnerFactor({ file, totp: () => '000000' });
      f.setAccount({ handle: 'test_merchant_owner', email: 'o@local-test.invalid', password: 'pw-test', userId: 'u-1' });
      f.savePending('SECRETSECRETSECRET', ['rc']);
      f.adoptPending(7);
      assert.deepEqual(readMerchantOwner(file), {
        handle: 'test_merchant_owner',
        email: 'o@local-test.invalid',
        password: 'pw-test',
        userId: 'u-1',
        totpSecret: 'SECRETSECRETSECRET',
        lastStep: 7,
      });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).kind, 'intafaced-local-test-merchant-owner');
      assert.equal(new OwnerFactor({ file, totp: () => '0' }).account.userId, 'u-1');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  // Operator pair: the signed-in subject must be the operator the pair names before any elevated token is used, and
  // signing in writes no second credentials file.
  {
    const d = mkdtempSync(join(tmpdir(), 'world-op-pair-'));
    try {
      const ids = { a: '00000000-0000-4000-8000-00000000000a', b: '00000000-0000-4000-8000-00000000000b' };
      const opsFile = join(d, 'operators.json');
      const opsText = JSON.stringify({
        operators: Object.fromEntries(
          ['a', 'b'].map((l) => [l, { handle: `local_test_operator_${l}`, userId: ids[l], password: 'pw', totpSecret: 'S', lastStep: 1 }]),
        ),
      });
      writeFileSync(opsFile, opsText);
      const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
      const gatesWith = (over = {}) => {
        const minted = [];
        const session = (l) => ({
          token: over[l]?.token ?? jwt({ sub: over[l]?.sub ?? ids[l], tier: 'full' }),
          op: { userId: over[l]?.userId ?? ids[l], sessionId: `sess-${l}` },
          approvalToken: async () => {
            minted.push(l);
            return `approval-${l}`;
          },
        });
        return { minted, gates: { operatorSessions: async () => ({ a: session('a'), b: session('b') }) } };
      };
      const gctx = { paths: { operators: opsFile, stateDir: d } };
      const good = await signInTestOperatorPair(gctx, gatesWith().gates);
      assert.equal(good.ok, true);
      assert.deepEqual(
        good.sessions.map((x) => [x.letter, x.userId, x.token, x.tier]),
        [
          ['a', ids.a, 'approval-a', 'full'],
          ['b', ids.b, 'approval-b', 'full'],
        ],
      );
      for (const [over, who] of [
        [{ a: { sub: ids.b } }, 'A'],
        [{ b: { userId: ids.a } }, 'B'],
        [{ a: { token: 'not-a-jwt' } }, 'A'],
        [{ b: { sub: 'someone-else' } }, 'B'],
      ]) {
        const r = await signInTestOperatorPair(gctx, gatesWith(over).gates);
        assert.equal(r.ok, false, JSON.stringify(over));
        assert.equal(r.sessions, undefined, 'no session, and so no elevated token, leaves a pair that is not who it names');
        assert.match(r.refusal, new RegExp(`operator ${who} signed in as a different account`));
      }
      assert.equal(await signInTestOperatorPair({ paths: { operators: join(d, 'none.json') } }, gatesWith().gates), null);
      const failing = { operatorSessions: async () => Promise.reject(new Error('identity down')) };
      assert.match((await signInTestOperatorPair(gctx, failing)).refusal, /identity down/);
      assert.deepEqual(readdirSync(d), ['operators.json'], 'never writes a second credentials file');
      assert.equal(readFileSync(opsFile, 'utf8'), opsText, 'leaves operators.json to the gates');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  // open-dispute (journey tests): the dispute id is the payment's business key, the reason is labelled LOCAL-TEST and
  // fits svc-pay's 64 characters, the amount is the payment's own captured amount, and a second run opens nothing.
  {
    const pay = '0a1b2c3d-0000-4000-8000-00000000000a';
    const merchantId = '0a1b2c3d-0000-4000-8000-00000000000b';
    assert.deepEqual(openDisputeArgs([pay.toUpperCase(), ' product_not_received ']), {
      paymentId: pay,
      reasonCode: 'LOCAL-TEST product_not_received',
    });
    assert.equal(openDisputeArgs([pay, 'r'.repeat(53)]).reasonCode.length, 64);
    for (const bad of [[], ['not-a-payment', 'r'], [pay], [pay, '  '], [pay, 'r'.repeat(54)], [pay, 'tab\there']]) {
      assert.equal(openDisputeArgs(bad), null, `refused: ${JSON.stringify(bad)}`);
    }
    const payment = { merchantId, status: 'captured', assetId: 'USDT', capturedAmount: '12' };
    assert.deepEqual(planOpenDispute({ paymentId: pay, payment, existing: null }), {
      kind: 'open',
      disputeId: `LOCAL-TEST-dispute-${pay}`,
      fields: { disputeId: `LOCAL-TEST-dispute-${pay}`, paymentId: pay, merchantId, amount: '12', assetId: 'USDT' },
    });
    const existing = { status: 'open', amount: '12', assetId: 'USDT' };
    assert.equal(planOpenDispute({ paymentId: pay, payment, existing }).kind, 'exists');
    assert.equal(planOpenDispute({ paymentId: pay, payment: null, existing: null }).kind, 'refuse');
    for (const status of ['created', 'authorized', 'failed', 'refunded', 'disputed']) {
      assert.equal(planOpenDispute({ paymentId: pay, payment: { ...payment, status }, existing: null }).kind, 'refuse', status);
    }
    assert.equal(planOpenDispute({ paymentId: pay, payment: { ...payment, status: 'settled' }, existing: null }).kind, 'open');
    assert.equal(planOpenDispute({ paymentId: pay, payment: { ...payment, capturedAmount: '0' }, existing: null }).kind, 'refuse');
    const usage = run(home, ['open-dispute', 'nope']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /open-dispute <paymentId> <reason>/);
  }

  console.log('local-test-world: all checks passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}

// ── The merchant setup, driven on a scripted stack ──────────────────────────────────────────────────────────────────────
// Each test below calls the populate code with stand-ins for what it reaches outside itself (ctx.deps: the Edge, the
// gates module, psql, the outbox, the clock) and asserts the requests it sends, in which order, with which bearer, and
// what it records and writes.

const jwtOf = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const claimsOf = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};
const okRes = (data) => ({ status: 200, body: { result: { data } } });
const noRes = (message, code = 'BAD_REQUEST', status = 400) => ({ status, body: { error: { message, data: { code } } } });
const W = {
  owner: '0a1b2c3d-0000-4000-8000-0000000000a1',
  main: '0a1b2c3d-0000-4000-8000-0000000000a2',
  friend: '0a1b2c3d-0000-4000-8000-0000000000a3',
  opA: '0a1b2c3d-0000-4000-8000-0000000000b1',
  opB: '0a1b2c3d-0000-4000-8000-0000000000b2',
  fa: '0a1b2c3d-0000-4000-8000-0000000000c1',
  fb: '0a1b2c3d-0000-4000-8000-0000000000c2',
  merchant: '0a1b2c3d-0000-4000-8000-0000000000d1',
};
const OWNER_TOTP_SECRET = 'OWNERTOTPSECRET234567';
const MAIN_LOGIN = { email: 'main@local-test.invalid', password: 'pw-main-test' };
const CONFIRM_TOKEN = 'CONFIRM+token/1';
const KYB_IDENTITY_HASH = `sha256:${'ab'.repeat(32)}`;

/**
 * A scripted LOCAL TEST stack: one state, one router that answers every door the merchant setup uses, and the gates and
 * psql stand-ins. `calls` holds every request in order: { src: 'edge' | 'gates-edge' | 'gates' | 'psql', door, input, bearer }.
 * `over[door]` answers a door for one scenario (return undefined to fall through to the default answer).
 */
function scriptedWorld({ kyb = 'stub', operators = true, founders = null, over = {}, state: seed = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'world-merchant-'));
  const p = stackPaths(dir, { LOCAL_STACK_STATE: join(dir, 'state') });
  mkdirSync(p.stateDir, { recursive: true });
  const outbox = join(p.stateDir, 'email-outbox.log');
  const calls = [];
  const unexpected = [];
  const minted = [];
  const st = {
    ownerRegistered: false,
    emailVerified: false,
    factorSecret: null,
    fileAtConfirm: null,
    fileAtRegister: null,
    kycPending: [],
    approved: new Map([
      [W.opA, new Set(['full'])],
      [W.opB, new Set(['full'])],
    ]),
    merchant: null,
    payments: new Map(),
    ...seed,
  };
  if (operators) {
    const op = (l, id) => ({ handle: `local_test_operator_${l}`, userId: id, password: 'pw', totpSecret: `OPSECRET${l}`, lastStep: 0 });
    writeFileSync(join(p.stateDir, 'operators.json'), JSON.stringify({ operators: { a: op('a', W.opA), b: op('b', W.opB) } }));
  }
  if (founders) writeFileSync(join(p.stateDir, 'founders.json'), JSON.stringify({ founders }));
  const tier0 = MERCHANT_TIERS[0].tier;
  const login = (input) => {
    if (input.identifier === MAIN_LOGIN.email && input.password === MAIN_LOGIN.password)
      return okRes({ accessToken: jwtOf({ sub: W.main, mfa: false, sid: 's-main' }), userId: W.main });
    const founder = (founders ?? []).find((f) => f.handle === input.identifier && f.password === input.password);
    if (founder && input.totpCode)
      return okRes({
        accessToken: jwtOf({ sub: founder.userId, mfa: true, sid: `s-${founder.handle}`, tier: 'full' }),
        userId: founder.userId,
      });
    if (input.identifier === MERCHANT_OWNER.email && st.ownerRegistered && input.password === st.ownerPassword) {
      if (st.factorSecret && !input.totpCode) return noRes('Two-factor code required', 'mfa_required', 401);
      return okRes({ accessToken: jwtOf({ sub: W.owner, mfa: Boolean(input.totpCode), sid: 's-owner' }), userId: W.owner });
    }
    return noRes('Invalid credentials', 'UNAUTHORIZED', 401);
  };
  const doors = {
    'identity auth.login': login,
    'identity auth.register': (input) => {
      st.fileAtRegister = existsSyncSafe(p.merchantOwner) ? JSON.parse(readFileSync(p.merchantOwner, 'utf8')) : null;
      st.ownerRegistered = true;
      st.ownerPassword = input.password;
      return okRes({ accessToken: jwtOf({ sub: W.owner, mfa: false, sid: 's-owner' }), userId: W.owner });
    },
    'identity me': () => okRes({ emailVerified: st.emailVerified }),
    'identity auth.requestEmailConfirmation': () => {
      writeFileSync(
        outbox,
        `LOCAL-TEST purpose=email-confirm email=${MERCHANT_OWNER.email} expires=2026-11-22T00:10:00.000Z link=confirmEmail?token=${encodeURIComponent(CONFIRM_TOKEN)}\n`,
        { flag: 'a' },
      );
      return okRes({ sent: true });
    },
    'identity auth.confirmEmail': (input) => {
      if (input.token !== CONFIRM_TOKEN) return noRes('bad token');
      st.emailVerified = true;
      return okRes({ ok: true });
    },
    'identity totp.enrol': () =>
      st.factorSecret
        ? noRes('Two-factor is already enrolled', 'CONFLICT', 409)
        : okRes({ secret: OWNER_TOTP_SECRET, recoveryCodes: ['RC-1'] }),
    'identity totp.confirm': (input) => {
      st.fileAtConfirm = JSON.parse(readFileSync(p.merchantOwner, 'utf8'));
      st.factorSecret = input.secret;
      return okRes({ ok: true });
    },
    'identity kyc.submit': (input, bearer) => {
      st.kycPending.push({ id: `kyc-${claimsOf(bearer)?.sub}`, userId: claimsOf(bearer)?.sub, tier: input.tier });
      return okRes({ ok: true });
    },
    'pay merchant.me': () => okRes(st.merchant),
    'pay merchant.create': (input) => {
      st.merchant = { id: W.merchant, kybStatus: 'none', feeBps: input.pricing.feeBps };
      return okRes(st.merchant);
    },
    'pay merchant.submitKyb': () => {
      st.merchant.kybStatus = 'pending';
      return okRes({ kybStatus: 'pending' });
    },
    'pay merchant.decideKybStub': () => {
      if (kyb !== 'stub') return noRes('pay.kyb_operator_required', 'FORBIDDEN', 403);
      st.merchant.kybStatus = 'approved';
      return okRes({ kybStatus: 'approved' });
    },
    'pay kyb.decisionBinding': () => okRes({ identityHash: KYB_IDENTITY_HASH }),
    'identity actionApproval.propose': (input) =>
      okRes({ approvalId: `ap-${input.actionType}`, operationId: `op-${input.actionType}`, status: 'PENDING' }),
    'identity actionApproval.approve': () => okRes({ status: 'APPROVED' }),
    'pay merchant.decideKyb': () => {
      st.merchant.kybStatus = 'approved';
      return okRes({ kybStatus: 'approved' });
    },
    'pay railHealth': () => okRes([]),
    'pay payment.get': (input) =>
      st.payments.has(input.paymentId) ? okRes(st.payments.get(input.paymentId)) : noRes('payment not found', 'NOT_FOUND', 404),
    'pay payment.create': (input) => {
      st.payments.set(input.requestId, {
        id: input.requestId,
        status: 'created',
        createdAt: '2026-11-22T01:00:00.000Z',
        capturedAmount: '0',
        refundedAmount: '0',
      });
      return okRes({ status: 'created' });
    },
    'pay payment.list': () => okRes({ items: [...st.payments.values()] }),
    'pay merchant.listLinks': () => okRes({ items: [] }),
    'pay merchantOps.invoices.list': () => okRes({ items: [] }),
    'pay merchantOps.customers.list': () => okRes({ items: [] }),
    'pay mandate.list': () => okRes({ items: [] }),
    'pay subscription.list': () => okRes({ items: [] }),
    'pay merchantOps.team.list': () => okRes({ items: [] }),
    'pay merchant.createLink': () => okRes({ id: 'link-1' }),
    'pay merchantOps.invoices.create': () => okRes({ id: 'inv-1', status: 'open' }),
    'pay mandate.create': () => okRes({ id: 'mandate-1' }),
    'pay subscription.create': () => okRes({ id: 'sub-1' }),
    'pay merchantOps.team.invite': (input) => okRes({ role: input.role }),
    'pay merchantControl.get': () =>
      okRes({ tierId: tier0.id, version: 1, pricing: [{ assetCode: MERCHANT_TIER_PRICING_RULE.assetCode }] }),
    'pay merchantControl.tiers.list': () => okRes({ status: 'configured', tiers: MERCHANT_TIERS.map((t) => ({ ...t.tier, version: 1 })) }),
    'pay merchant.payoutDestinations.list': () =>
      okRes({ items: [{ railId: MERCHANT_PAYOUT_DESTINATION.railId, kind: 'crypto', state: 'active', destinationMasked: '0x12...ab' }] }),
    'pay merchantControl.approvals.list': () => okRes({ items: [] }),
    'pay fraud.getDispute': () => noRes('dispute_not_found', 'NOT_FOUND', 404),
  };
  const answer = (src, mod, proc, input, bearer) => {
    const door = `${mod} ${proc}`;
    calls.push({ src, door, input, bearer });
    const scripted = over[door]?.(input, bearer, st, calls);
    if (scripted) return scripted;
    if (doors[door]) return doors[door](input, bearer, st);
    unexpected.push(door);
    return noRes(`unexpected door ${door}`, 'NOT_FOUND', 404);
  };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const [, mod, proc] = /^\/api\/([^/]+)\/trpc\/(.+)$/.exec(u.pathname);
    const input =
      init.method === 'GET' ? (u.searchParams.has('input') ? JSON.parse(u.searchParams.get('input')) : undefined) : JSON.parse(init.body);
    const bearer = init.headers.authorization ? init.headers.authorization.replace(/^Bearer /, '') : null;
    const r = answer('edge', mod, proc, input, bearer);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const viaGates = (mod, proc, input, bearer) => {
    const r = answer('gates-edge', mod, proc, input, bearer);
    return { status: r.status, json: r.body, text: JSON.stringify(r.body) };
  };
  const gctx = {
    paths: { operators: join(p.stateDir, 'operators.json'), stateDir: p.stateDir },
    secrets: { jwt: 'TEST-JWT-SECRET' },
    totp: { totp: () => '222222' },
    edge: { query: async (...a) => viaGates(...a), mutate: async (...a) => viaGates(...a) },
    tokens: {
      issueAccessToken: async (claims) => {
        minted.push(claims);
        calls.push({ src: 'gates', door: `mint ${claims.scopes.join(',')}`, input: claims, bearer: null });
        return { token: jwtOf({ sub: claims.userId, scopes: claims.scopes, minted: true }) };
      },
    },
  };
  const gates = {
    MARKERS: { kycJurisdiction: 'LOCAL-TEST-XX', policyVersion: 'local-test-policy-1' },
    refusalText: (res) => refusalText(res),
    makeContext: async () => {
      calls.push({ src: 'gates', door: 'makeContext' });
      return gctx;
    },
    listAccountsAndTiers: () => ({ approved: st.approved, pending: st.kycPending }),
    submitOwnedAccounts: async () => [],
    approvePending: async (_gctx, _sessions, { userIds } = {}) => {
      calls.push({ src: 'gates', door: 'approvePending', input: { userIds } });
      const rows = [];
      for (const r of st.kycPending.slice()) {
        if (userIds && !userIds.includes(r.userId)) continue;
        if (!st.approved.has(r.userId)) st.approved.set(r.userId, new Set());
        st.approved.get(r.userId).add(r.tier);
        st.kycPending.splice(st.kycPending.indexOf(r), 1);
        rows.push({ ok: true, id: r.id });
      }
      return rows;
    },
    operatorSessions: async () => {
      calls.push({ src: 'gates', door: 'operatorSessions' });
      const session = (l, id) => ({
        token: jwtOf({ sub: id, tier: 'full', mfa: true, sid: `s-${l}` }),
        op: { userId: id, sessionId: `s-${l}` },
        approvalToken: async () => `approval-${l}`,
      });
      return { a: session('a', W.opA), b: session('b', W.opB) };
    },
    founderTotp: async (_gctx, key) => `founder-code-${key}`,
  };
  const psqlCalls = [];
  const deps = {
    fetch,
    assertStack: () => calls.push({ src: 'assertStack', door: 'assertStack' }),
    gates: async () => gates,
    psql: (_secrets, role, sql) => {
      psqlCalls.push({ role, sql });
      calls.push({ src: 'psql', door: 'psql', input: sql });
      if (/FROM identity\.users/.test(sql))
        return [
          [W.main, 'local_test_account', MAIN_LOGIN.email, '2026-11-01'],
          [W.friend, FRIEND.handle, FRIEND.email, '2026-11-02'],
          [W.owner, MERCHANT_OWNER.handle, MERCHANT_OWNER.email, '2026-11-03'],
        ];
      if (/identity\.action_approvals/.test(sql)) return st.openApprovals ?? [];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    outboxPath: () => outbox,
    guard: () => ({ paths: p }),
    now: () => st.clock,
    wait: async (ms) => {
      st.clock += ms;
    },
  };
  st.clock = Date.now();
  const records = [];
  const logs = [];
  const baseCtx = {
    p,
    secrets: { jwt: 'TEST-JWT-SECRET' },
    log: (m) => logs.push(m),
    record: (room, item, status, detail = '') => records.push({ room, item, status, detail }),
    deps,
  };
  const doorsSent = (src = null) => calls.filter((c) => !src || c.src === src).map((c) => c.door);
  const at = (door, from = 0) => {
    const i = calls.findIndex((c, n) => n >= from && c.door === door);
    return i;
  };
  return {
    dir,
    p,
    st,
    calls,
    unexpected,
    minted,
    psqlCalls,
    deps,
    gates,
    gctx,
    baseCtx,
    records,
    logs,
    doorsSent,
    at,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const existsSyncSafe = (f) => {
  try {
    statSync(f);
    return true;
  } catch {
    return false;
  }
};
const ownerSends = (w, door) => w.calls.filter((c) => c.src === 'edge' && c.door === door);
const indexes = (w, door) => w.calls.map((c, i) => (c.door === door ? i : -1)).filter((i) => i >= 0);
const lastIndex = (w, door) => Math.max(-1, ...indexes(w, door));
const FORBIDDEN_WORDS = ['pnpm local:founder', 'grant law unpublished', 'bps (published)', '.env.founder-secrets.local'];

/** Records every fs call of the given names while fn runs: [name, firstArg]. */
async function watchFs(names, fn) {
  const fsMod = (await import('node:fs')).default;
  const real = Object.fromEntries(names.map((n) => [n, fsMod[n]]));
  const seen = [];
  for (const n of names)
    fsMod[n] = (...args) => {
      seen.push([n, String(args[0]), args[1]]);
      return real[n].apply(fsMod, args);
    };
  try {
    await fn();
  } finally {
    Object.assign(fsMod, real);
  }
  return seen;
}

test('populate merchant: a new owner is confirmed, enrolled and verified, then signs in again before any pay door', async () => {
  const w = scriptedWorld({ kyb: 'stub' });
  const loginFile = join(w.dir, 'TEST-LOGIN.md');
  writeFileSync(loginFile, `Email: ${MAIN_LOGIN.email}\nPassword: ${MAIN_LOGIN.password}\n`);
  writeFileSync(w.p.secrets, JSON.stringify({ jwt: 'TEST-JWT-SECRET' }));
  const fee = process.env.PAY_MERCHANT_STARTER_FEE_BPS;
  process.env.PAY_MERCHANT_STARTER_FEE_BPS = '150';
  const out = [];
  const realWrite = process.stdout.write;
  const realLog = console.log;
  let fsSeen;
  try {
    process.stdout.write = (chunk) => (out.push(String(chunk)), true);
    console.log = (...a) => out.push(a.join(' '));
    fsSeen = await watchFs(['readFileSync', 'existsSync', 'unlinkSync', 'rmSync', 'openSync', 'renameSync'], () =>
      cmdPopulate(['--only', 'merchant', '--login-file', loginFile], w.deps),
    );
  } finally {
    process.stdout.write = realWrite;
    console.log = realLog;
    if (fee === undefined) delete process.env.PAY_MERCHANT_STARTER_FEE_BPS;
    else process.env.PAY_MERCHANT_STARTER_FEE_BPS = fee;
  }
  try {
    assert.deepEqual(w.unexpected, [], 'every door the setup used is one the stack has');
    const last = JSON.parse(readFileSync(join(w.p.stateDir, 'run', 'populate-last.json'), 'utf8'));
    const records = last.results;
    assert.equal(records.filter((r) => r.status === 'error').length, 0, JSON.stringify(records));

    // The main test account signs in with its password only, and nothing of the merchant runs on it.
    const logins = ownerSends(w, 'identity auth.login');
    assert.equal(logins[0].input.identifier, MAIN_LOGIN.email);
    assert.equal('totpCode' in logins[0].input, false, 'the main test account signs in with a password only');
    for (const c of w.calls.filter((c) => c.src === 'edge' && c.bearer))
      assert.notEqual(claimsOf(c.bearer)?.sub, W.main, `${c.door} never runs on the main test account`);

    // The owner is its own LOCAL TEST account; its credentials are on disk before it is registered.
    const register = ownerSends(w, 'identity auth.register');
    assert.equal(register.length, 1);
    assert.equal(register[0].input.handle, MERCHANT_OWNER.handle);
    assert.equal(w.st.fileAtRegister?.account?.password, register[0].input.password, 'credentials are written before the register call');
    assert.equal(w.st.fileAtRegister.account.email, MERCHANT_OWNER.email);

    // Email: asked for and confirmed through identity's own doors, with the link from the outbox; no SQL writes anything.
    const confirm = ownerSends(w, 'identity auth.confirmEmail');
    assert.deepEqual(
      confirm.map((c) => c.input),
      [{ token: CONFIRM_TOKEN }],
    );
    assert.ok(w.at('identity auth.requestEmailConfirmation') < w.at('identity auth.confirmEmail'));
    assert.ok(w.psqlCalls.length > 0);
    for (const q of w.psqlCalls) assert.match(q.sql, /^\s*SELECT\b/, 'psql only reads');
    assert.equal(
      w.psqlCalls.some((q) => /email_verified_at|UPDATE|INSERT|DELETE/i.test(q.sql)),
      false,
    );

    // Second factor: enrolled, written down before it is confirmed, kept in merchant-owner.json (mode 600), never deleted.
    assert.ok(w.at('identity totp.enrol') < w.at('identity totp.confirm'));
    assert.equal(w.st.fileAtConfirm.pendingSecret, OWNER_TOTP_SECRET, 'the secret is written down before it is confirmed');
    const held = JSON.parse(readFileSync(w.p.merchantOwner, 'utf8'));
    assert.equal(held.secret, OWNER_TOTP_SECRET);
    assert.equal(held.pendingSecret, undefined);
    assert.equal(statSync(w.p.merchantOwner).mode & 0o777, 0o600);
    assert.deepEqual(
      fsSeen.filter(([n, f]) => (n === 'unlinkSync' || n === 'rmSync') && f.startsWith(w.p.stateDir)),
      [],
      'never deletes the factor file or anything in the state folder',
    );
    assert.deepEqual(
      readdirSync(w.p.stateDir).filter((f) => /factor|owner/i.test(f)),
      ['merchant-owner.json'],
      'the only second-factor file is the merchant owner one',
    );
    const printed = [...out, ...records.map((r) => JSON.stringify(r)), readFileSync(w.p.log, 'utf8')].join('\n');
    assert.equal(printed.includes(OWNER_TOTP_SECRET), false, 'the TOTP secret is never printed, logged or recorded');

    // Verification: the owner files its own request, and only that request is approved.
    const kyc = ownerSends(w, 'identity kyc.submit');
    assert.equal(kyc.length, 1);
    assert.equal(claimsOf(kyc[0].bearer).sub, W.owner);
    assert.equal(kyc[0].input.tier, 'full');
    assert.deepEqual(
      w.calls.filter((c) => c.door === 'approvePending').map((c) => c.input.userIds),
      [[W.owner]],
    );

    // Signed in again (with a fresh TOTP code) after the email, the factor and the verification, before any pay door.
    const firstPay = w.calls.findIndex((c) => c.door.startsWith('pay '));
    const resign = w.calls.findIndex((c, i) => i > lastIndex(w, 'approvePending') && c.door === 'identity auth.login');
    assert.ok(resign > w.at('identity auth.confirmEmail'), 'confirm email, then sign in again');
    assert.ok(resign > w.at('identity totp.confirm'));
    assert.ok(resign < firstPay, 'the new session is in place before merchant.me');
    assert.equal(typeof w.calls[resign].input.totpCode, 'string', 'the owner signs in with its second factor');
    assert.equal(claimsOf(w.calls[firstPay].bearer).mfa, true);

    // Onboarding: create (the published starter fee), submit, decide, sign in again; only then the pay:read reads.
    const create = ownerSends(w, 'pay merchant.create');
    assert.equal(create.length, 1);
    assert.equal(create[0].input.pricing.feeBps, 150);
    assert.ok(
      records.some((r) => r.item === `merchant "${MERCHANT_LEGAL_NAME}"` && /fee 150 bps from PAY_MERCHANT_STARTER_FEE_BPS/.test(r.detail)),
    );
    const rail = w.at('pay railHealth');
    for (const door of ['pay merchant.create', 'pay merchant.submitKyb', 'pay merchant.decideKybStub'])
      assert.ok(w.at(door) >= 0 && w.at(door) < rail, `${door} runs before the pay:read reads`);
    const afterKyb = w.calls.findIndex((c, i) => i > w.at('pay merchant.decideKybStub') && c.door === 'identity auth.login');
    assert.ok(afterKyb > 0 && afterKyb < rail, 'signs in again after KYB approval, before the reads');

    // The tier is read before any payment; the money block runs once the catalogue is in place.
    assert.ok(w.at('pay merchantControl.tiers.list') < w.at('pay payment.create'), 'tiers are in place before the first payment');
    assert.ok(w.at('pay merchantOps.team.invite') > 0);
    assert.deepEqual(
      ownerSends(w, 'pay merchantOps.team.invite').map((c) => c.input),
      [{ userId: W.friend, role: 'viewer', label: MERCHANT_DISPLAY_NAME }],
    );
    assert.ok(w.at('pay fraud.getDispute') > lastIndex(w, 'pay merchantOps.team.invite'), 'the money block runs after the catalogue');
    assert.ok(w.at('pay merchantControl.approvals.list') > lastIndex(w, 'pay payment.create'));

    // No path to a founder secrets file, and no stale instruction in anything it says.
    assert.equal(
      fsSeen.some(([, f]) => f.includes('.env.founder-secrets')),
      false,
    );
    for (const word of FORBIDDEN_WORDS) assert.equal(printed.includes(word), false, word);
  } finally {
    w.cleanup();
  }
});

test('populate merchant: live-only KYB is decided by the stack pair, then the owner signs in again', async () => {
  for (const scenario of ['operators', 'founders']) {
    const founders =
      scenario === 'founders'
        ? ['a', 'b'].map((l) => ({
            key: l,
            handle: `local_test_founder_${l}`,
            userId: l === 'a' ? W.fa : W.fb,
            password: `pw-founder-${l}`,
            totpSecret: `FSECRET${l}`,
            totpConfirmed: true,
          }))
        : null;
    const w = scriptedWorld({
      kyb: 'live',
      founders,
      state: {
        approved: new Map([
          [W.opA, new Set(['full'])],
          [W.opB, new Set(['full'])],
          [W.fa, new Set(['full'])],
          [W.fb, new Set(['full'])],
        ]),
      },
    });
    process.env.PAY_MERCHANT_STARTER_FEE_BPS = '150';
    try {
      await populateMerchantStep(w.baseCtx);
      assert.deepEqual(w.unexpected, [], scenario);
      const kybCalls = w.calls.filter((c) => c.src === 'gates-edge');
      const ids = scenario === 'founders' ? [W.fa, W.fb] : [W.opA, W.opB];
      if (scenario === 'founders') {
        assert.equal(w.doorsSent().includes('operatorSessions'), false, 'with a founder vault the operators are not signed in');
        assert.deepEqual(
          kybCalls.filter((c) => c.door === 'identity auth.login').map((c) => [c.input.identifier, c.input.totpCode]),
          [
            ['local_test_founder_a', 'founder-code-a'],
            ['local_test_founder_b', 'founder-code-b'],
          ],
        );
      } else {
        assert.equal(w.doorsSent().filter((d) => d === 'operatorSessions').length, 1, 'no vault: the two TEST operators are the pair');
        assert.equal(
          kybCalls.some((c) => c.door === 'identity auth.login'),
          false,
        );
      }
      // admin:compliance is minted once for the first decider's own session, and used only for the binding and the decide.
      const compliance = w.minted.filter((m) => m.scopes.includes('admin:compliance'));
      assert.equal(compliance.length, 1);
      assert.equal(compliance[0].userId, ids[0]);
      assert.equal(compliance[0].mfa, true);
      const bearerOf = (door) => kybCalls.filter((c) => c.door === door).map((c) => claimsOf(c.bearer)?.scopes ?? c.bearer);
      assert.deepEqual(bearerOf('pay kyb.decisionBinding'), [['admin:compliance']]);
      assert.deepEqual(bearerOf('pay merchant.decideKyb'), [['admin:compliance']]);
      // The binding read, an open-approval read, one proposes, the other approves, then the decide consumes it.
      const order = kybCalls.map((c) => c.door).filter((d) => !d.endsWith('auth.login'));
      assert.deepEqual(order, [
        'pay kyb.decisionBinding',
        'identity actionApproval.propose',
        'identity actionApproval.approve',
        'pay merchant.decideKyb',
      ]);
      const propose = kybCalls.find((c) => c.door === 'identity actionApproval.propose');
      assert.equal(propose.input.actionType, KYB_DECIDE_ACTION);
      assert.equal(
        propose.input.payloadHash,
        kybDecidePayloadHash({ merchantId: W.merchant, decision: 'approved', identityHash: KYB_IDENTITY_HASH }),
      );
      const approve = kybCalls.find((c) => c.door === 'identity actionApproval.approve');
      if (scenario === 'operators') {
        assert.equal(propose.bearer, 'approval-a');
        assert.equal(approve.bearer, 'approval-b', 'the other person approves');
      } else {
        assert.equal(claimsOf(propose.bearer).sub, W.fa);
        assert.equal(claimsOf(approve.bearer).sub, W.fb, 'the other person approves');
      }
      assert.ok(w.psqlCalls.some((q) => /identity\.action_approvals/.test(q.sql) && q.sql.includes(propose.input.payloadHash)));
      const decided = w.calls.findIndex((c) => c.door === 'pay merchant.decideKyb');
      const resign = w.calls.findIndex((c, i) => i > decided && c.src === 'edge' && c.door === 'identity auth.login');
      assert.ok(resign > decided && resign < w.at('pay railHealth'), 'the owner signs in again after the founder pair decides');
      assert.ok(w.records.some((r) => r.item === 'KYB decision' && r.status === 'created' && /founder pair approved/.test(r.detail)));
      for (const word of FORBIDDEN_WORDS) assert.equal(JSON.stringify(w.records).includes(word), false, word);
    } finally {
      delete process.env.PAY_MERCHANT_STARTER_FEE_BPS;
      w.cleanup();
    }
  }
});

test('populate merchant: with no KYB pair it stops before any proposal, and no money door is opened', async () => {
  const w = scriptedWorld({ kyb: 'live', operators: false });
  process.env.PAY_MERCHANT_STARTER_FEE_BPS = '150';
  try {
    await populateMerchantStep(w.baseCtx);
    const pending = w.records.find((r) => r.item === 'KYB pending');
    assert.equal(pending?.status, 'refused');
    assert.equal(pending.detail, KYB_FOUNDERS_MISSING);
    assert.equal(
      w.calls.some((c) => c.src === 'gates-edge'),
      false,
      'nothing is proposed, read or decided',
    );
    assert.deepEqual(w.minted, [], 'no elevated token is minted');
    const after = w.calls.slice(w.at('pay merchant.decideKybStub') + 1).map((c) => c.door);
    assert.equal(
      after.some((d) => d.startsWith('pay ')),
      false,
      `money stays closed while KYB is pending: ${after}`,
    );
    for (const word of FORBIDDEN_WORDS) assert.equal(JSON.stringify(w.records).includes(word), false, word);
  } finally {
    delete process.env.PAY_MERCHANT_STARTER_FEE_BPS;
    w.cleanup();
  }
  // KYB still pending when the catalogue runs (the first decide was refused, the second finds no pair): the catalogue's
  // money actions are skipped and the money block does not run.
  let stubCalls = 0;
  const later = scriptedWorld({
    kyb: 'live',
    operators: false,
    over: {
      'pay merchant.decideKybStub': () => (stubCalls++ === 0 ? noRes('pay is restarting', 'INTERNAL_SERVER_ERROR', 500) : undefined),
    },
  });
  process.env.PAY_MERCHANT_STARTER_FEE_BPS = '150';
  try {
    await populateMerchantStep(later.baseCtx);
    assert.equal(stubCalls, 2);
    assert.ok(
      later.records.some(
        (r) => r.item === 'create-payment' && r.status === 'skipped' && /KYB pending; live money stays closed/.test(r.detail),
      ),
    );
    for (const door of [
      'pay payment.create',
      'pay payment.refund',
      'pay merchantOps.team.invite',
      'pay settlement.list',
      'pay merchant.payoutDestinations.list',
      'pay fraud.getDispute',
    ])
      assert.equal(later.at(door), -1, `${door} is not sent while KYB is pending`);
  } finally {
    delete process.env.PAY_MERCHANT_STARTER_FEE_BPS;
    later.cleanup();
  }
});

test('populate merchant: a session without pay:onboard is a refusal that names it, and another pending verification stops the owner', async () => {
  {
    const w = scriptedWorld({ over: { 'pay merchant.me': () => noRes('Scope "pay:onboard" is required', 'FORBIDDEN', 403) } });
    try {
      await populateMerchantStep(w.baseCtx);
      const r = w.records.at(-1);
      assert.equal(r.status, 'refused');
      assert.match(r.detail, /pay:onboard/);
      assert.match(r.detail, /Nothing minted\. Starter fee not configured\./);
      assert.equal(w.calls.filter((c) => c.door.startsWith('pay ')).length, 1, 'stops at merchant.me');
    } finally {
      w.cleanup();
    }
  }
  {
    const w = scriptedWorld({ state: { kycPending: [{ id: 'kyc-x', userId: W.friend, tier: 'full' }] } });
    try {
      await populateMerchantStep(w.baseCtx);
      const r = w.records.find((x) => x.item === 'verification tier full (TEST, local operators)');
      assert.equal(r.status, 'refused');
      assert.match(r.detail, /1 other pending verification request\(s\) exist; populate approves only the owner's/);
      assert.equal(w.doorsSent().includes('approvePending'), false, "only the owner's own request is ever approved");
      assert.equal(
        w.calls.some((c) => c.door.startsWith('pay ')),
        false,
        'populate stops before any pay door',
      );
    } finally {
      w.cleanup();
    }
  }
});

test("the owner's second factor is written down before it is confirmed, never printed, and never reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-factor-'));
  try {
    const file = join(dir, 'merchant-owner.json');
    let clock = 1_000 * 30_000;
    const factor = () => new OwnerFactor({ file, totp: () => '123456', now: () => clock, wait: async (ms) => (clock += ms) });
    const scripted = (answers) => {
      const sent = [];
      return {
        sent,
        user: {
          token: jwtOf({ mfa: true }),
          query: async (mod, proc, input) => (sent.push(`${mod} ${proc}`), toRes(answers[`${mod} ${proc}`]?.(input))),
          mutate: async (mod, proc, input) => (sent.push(`${mod} ${proc}`), toRes(answers[`${mod} ${proc}`]?.(input))),
        },
      };
    };
    const toRes = (r) =>
      r ? { status: r.status, json: r.body, text: JSON.stringify(r.body) } : { status: 404, json: null, text: 'no door' };
    const logs = [];
    const records = [];
    const printed = [];
    const realLog = console.log;
    console.log = (...a) => printed.push(a.join(' '));
    try {
      // Fresh: enrol, write down, confirm, adopt.
      let atConfirm = null;
      const a = scripted({
        'identity totp.enrol': () => okRes({ secret: OWNER_TOTP_SECRET, recoveryCodes: ['RC'] }),
        'identity totp.confirm': (input) => {
          atConfirm = JSON.parse(readFileSync(file, 'utf8'));
          return input.secret === OWNER_TOTP_SECRET && input.code === '123456' ? okRes({}) : noRes('bad code');
        },
      });
      const ctx = { user: a.user, factor: factor(), log: (m) => logs.push(m), record: (...r) => records.push(r) };
      assert.deepEqual(await ensureOwnerSecondFactor(ctx), { ok: true, changed: true });
      assert.deepEqual(a.sent, ['identity totp.enrol', 'identity totp.confirm']);
      assert.equal(atConfirm.pendingSecret, OWNER_TOTP_SECRET, 'secret is written down before it is confirmed');
      assert.equal(typeof atConfirm.pendingStep, 'number', 'the confirm step is written down before it is used');
      assert.equal(factor().secret, OWNER_TOTP_SECRET);

      // Held: nothing is called again.
      const b = scripted({});
      assert.deepEqual(await ensureOwnerSecondFactor({ ...ctx, user: b.user, factor: factor() }), { ok: true, changed: false });
      assert.deepEqual(b.sent, []);

      // Held, but the session has no second factor (stack reset): refused, nothing reset.
      const c = scripted({});
      c.user.token = jwtOf({ mfa: false });
      assert.equal((await ensureOwnerSecondFactor({ ...ctx, user: c.user, factor: factor() })).ok, false);
      assert.deepEqual(c.sent, []);
      assert.match(records.at(-1)[3], /populate never deletes it/);

      // A factor whose secret populate does not hold: REFUSED, never a reset.
      const otherFile = join(dir, 'other.json');
      const d = scripted({ 'identity totp.enrol': () => noRes('Two-factor is already enrolled', 'CONFLICT', 409) });
      const fresh = new OwnerFactor({ file: otherFile, totp: () => '1' });
      assert.deepEqual(await ensureOwnerSecondFactor({ ...ctx, user: d.user, factor: fresh }), { ok: false, changed: false });
      assert.deepEqual(d.sent, ['identity totp.enrol'], 'nothing after the refusal');
      assert.match(records.at(-1)[3], /nothing was reset/);

      // A pending secret from a crashed run is confirmed first, without a new enrolment.
      writeFileSync(otherFile, JSON.stringify({ pendingSecret: 'PENDINGSECRET234567', pendingRecoveryCodes: [] }));
      const e = scripted({ 'identity totp.confirm': (input) => (input.secret === 'PENDINGSECRET234567' ? okRes({}) : noRes('no')) });
      const resumed = new OwnerFactor({ file: otherFile, totp: () => '1', now: () => clock });
      assert.deepEqual(await ensureOwnerSecondFactor({ ...ctx, user: e.user, factor: resumed }), { ok: true, changed: true });
      assert.deepEqual(e.sent, ['identity totp.confirm']);

      // No store: refused before any door.
      const f = scripted({});
      assert.equal((await ensureOwnerSecondFactor({ ...ctx, user: f.user, factor: null })).ok, false);
      assert.deepEqual(f.sent, []);
    } finally {
      console.log = realLog;
    }
    assert.deepEqual(logs, [], 'the factor step never logs');
    assert.deepEqual(printed, [], 'the factor step never prints');
    for (const r of records)
      for (const secret of [OWNER_TOTP_SECRET, 'PENDINGSECRET234567'])
        assert.equal(JSON.stringify(r).includes(secret), false, 'no secret goes into a message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner's login adopts a pending secret once, and the factor file is written atomically and never deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-login-'));
  try {
    const file = join(dir, 'merchant-owner.json');
    writeFileSync(
      file,
      JSON.stringify({
        account: { handle: 'test_merchant_owner', email: 'o@local-test.invalid', password: 'pw' },
        pendingSecret: 'PENDINGSECRET234567',
        pendingStep: 5,
      }),
    );
    let clock = 100 * 30_000;
    const factor = new OwnerFactor({ file, totp: (s) => `code-of-${s.slice(0, 4)}`, now: () => clock, wait: async (ms) => (clock += ms) });
    const bodies = [];
    const deps = {
      ...WORLD_DEPS,
      assertStack: () => {},
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const r = body.totpCode
          ? okRes({ accessToken: jwtOf({ sub: 'u-1', mfa: true }), userId: 'u-1' })
          : noRes('Two-factor code required', 'mfa_required', 401);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    };
    const client = new EdgeClient(factor.account, factor, deps);
    const seen = await watchFs(['openSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'rmSync', 'writeFileSync'], () => client.login());
    assert.deepEqual(
      bodies.map((b) => b.totpCode ?? null),
      [null, 'code-of-PEND'],
      'one try without a code, then once with the pending secret',
    );
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.secret, 'PENDINGSECRET234567', 'the pending secret is adopted');
    assert.equal(saved.pendingSecret, undefined);
    assert.equal(saved.lastStep, 100);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Atomic: a tmp file is opened, synced and renamed onto the file; the file itself is never written in place or deleted.
    const names = seen.map(([n]) => n);
    const tmpOpen = seen.findIndex(([n, f]) => n === 'openSync' && f.startsWith(`${file}.tmp-`));
    assert.ok(tmpOpen >= 0);
    assert.ok(names.indexOf('fsyncSync', tmpOpen) > tmpOpen);
    const rename = seen.findIndex(([n, f, to]) => n === 'renameSync' && f.startsWith(`${file}.tmp-`) && to === file);
    assert.ok(rename > names.indexOf('fsyncSync', tmpOpen), 'fsync before rename');
    assert.equal(
      seen.some(([n, f]) => n === 'writeFileSync' && f === file),
      false,
      'never written in place',
    );
    assert.equal(
      seen.some(([n]) => n === 'unlinkSync' || n === 'rmSync'),
      false,
      'never deletes the factor file',
    );
    assert.deepEqual(readdirSync(dir), ['merchant-owner.json'], 'no tmp file left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A money-block world: the seed's captured payments exist and settle; every door is answered by `scriptedWorld`. */
function moneyWorld({ settled = false, refunded = false, dispute = null, over = {}, founders = null } = {}) {
  const day = '2026-11-21T10:00:00.000Z';
  const window = utcDayLabel(day);
  const payments = new Map();
  for (const spec of MERCHANT_PAYMENTS.filter((s) => s.want === 'captured')) {
    const id = merchantPaymentId(W.owner, spec.n);
    payments.set(id, {
      id,
      status: 'captured',
      createdAt: day,
      capturedAmount: spec.amount,
      refundedAmount: refunded && spec.n === MERCHANT_REFUND.n ? MERCHANT_REFUND.amount : '0',
    });
  }
  const settlement = { id: 'st-1', window, status: 'posted', gross: '68', fees: '1', net: '67', assetId: MERCHANT_SETTLEMENT_ASSET };
  const OWNER_STEPUP = jwtOf({ sub: W.owner, stepUp: 'owner' });
  const MATE_STEPUP = jwtOf({ sub: W.opB, stepUp: 'mate' });
  const w = scriptedWorld({
    founders,
    state: { payments, settlements: settled ? [settlement] : [] },
    over: {
      'pay settlement.list': (_i, _b, st) => okRes({ items: st.settlements }),
      'pay settlement.run': (input, _b, st) => {
        st.settlements.push({ ...settlement, window: input.window });
        return okRes(settlement);
      },
      'identity auth.stepUpPay': (input, bearer) => {
        if (!input.factorProof) return noRes('factor proof required');
        const who = claimsOf(bearer)?.sub;
        return okRes({
          accessToken: who === W.opB ? MATE_STEPUP : OWNER_STEPUP,
          refreshable: false,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
      },
      'pay payment.refund': (input) => okRes({ id: input.paymentId, amount: '18', status: 'captured', refundedAmount: input.amount }),
      'pay merchantOps.team.list': () =>
        okRes({ items: [{ userId: W.opB, memberId: 'mem-1', status: 'active', role: MERCHANT_CHECKER_ROLE }] }),
      'pay merchantControl.approvals.request': (input) =>
        okRes({
          approvalId: 'pa-1',
          status: 'pending',
          makerUserId: W.opB,
          railId: input.railId,
          assetCode: 'USDT',
          amount: '67',
          payloadHash: 'ph-1',
          settlementId: input.settlementId,
        }),
      'pay merchantControl.approvals.decide': () => okRes({ approvalId: 'pa-1', status: 'approved' }),
      'pay settlement.payout': (input) =>
        okRes({ id: input.settlementId, status: 'paid_out', net: '67', assetId: 'USDT', payoutMethod: input.railId }),
      'pay fraud.getDispute': () => (dispute ? okRes(dispute) : undefined),
      'pay fraud.openDispute': (input) => okRes({ disputeId: input.disputeId, status: 'open', ledgerWire: 'lw-1' }),
      ...over,
    },
  });
  const ownerToken = jwtOf({ sub: W.owner, mfa: true, sid: 's-owner' });
  const user = new EdgeClient(
    { handle: MERCHANT_OWNER.handle, email: MERCHANT_OWNER.email, password: 'pw', userId: W.owner },
    { secret: 'OWNERSECRET', nextCode: async () => '111111' },
    w.deps,
  );
  user.token = ownerToken;
  user.tokenAt = Date.now();
  const ctx = { ...w.baseCtx, user };
  return { ...w, ctx, OWNER_STEPUP, MATE_STEPUP, window };
}

test('the merchant money block reads before it writes, and refund and payout go only through the step-up', async () => {
  const w = moneyWorld();
  try {
    await populateMerchantMoneyBlock(w.ctx, W.merchant);
    assert.deepEqual(w.unexpected, []);
    assert.deepEqual(
      w.records.map((r) => `${r.item}: ${r.status}`),
      [
        `settlement ${w.window} USDT: created`,
        'payout destination: exists',
        'refund: created',
        'payout request: created',
        'payout approval: created',
        'payout send: created',
        'dispute: created',
      ],
      JSON.stringify(w.records),
    );
    // 1. settlement: read, run the missing window, read again; 2. step-up money; 3. dispute: read, then the pair.
    const first = (d) => w.at(d);
    assert.ok(first('pay settlement.list') < first('pay settlement.run'), 'settlement is read before it is run');
    assert.deepEqual(
      ownerSends(w, 'pay settlement.run').map((c) => c.input),
      [{ merchantId: W.merchant, window: w.window, assetId: MERCHANT_SETTLEMENT_ASSET }],
    );
    assert.ok(first('pay settlement.run') < first('pay merchant.payoutDestinations.list'), 'settlement comes before refund and payout');
    assert.ok(first('pay merchant.payoutDestinations.list') < first('pay payment.refund'));
    assert.ok(
      first('pay merchantControl.approvals.list') < first('pay merchantControl.approvals.request'),
      'approvals are read before a request',
    );
    assert.ok(
      first('pay merchantControl.approvals.request') < first('pay merchantControl.approvals.decide'),
      'the request comes before the approval',
    );
    assert.ok(first('pay merchantControl.approvals.decide') < first('pay settlement.payout'), 'the send comes after the approval');
    assert.ok(first('pay settlement.payout') < first('pay fraud.getDispute'), 'dispute comes after settlement and payout');
    const disputeSignIn = w.calls.findIndex((c, i) => i > first('pay fraud.getDispute') && c.door === 'operatorSessions');
    assert.ok(disputeSignIn > first('pay fraud.getDispute'), 'a dispute is read before the approvers sign in');
    // Bearers: refund and send on the owner's step-up, the request on the teammate's, the decide on the owner's own session.
    const bearers = (door) => w.calls.filter((c) => c.door === door).map((c) => c.bearer);
    assert.deepEqual(bearers('pay payment.refund'), [w.OWNER_STEPUP], "payment.refund carries the owner's step-up token");
    assert.deepEqual(bearers('pay settlement.payout'), [w.OWNER_STEPUP], "settlement.payout carries the owner's step-up token");
    assert.deepEqual(bearers('pay merchantControl.approvals.request'), [w.MATE_STEPUP]);
    assert.equal(claimsOf(bearers('pay merchantControl.approvals.decide')[0]).sid, 's-owner', 'the owner decides on their own session');
    assert.deepEqual(
      w.minted.filter((m) => m.scopes.includes('pay:write')),
      [],
      'no pay:write stand-in for an active teammate',
    );
    // Dispute: two TEST operators, admin:treasury for the first one's own session, propose, approve, open with the treasury token.
    const treasury = w.minted.filter((m) => m.scopes.includes('admin:treasury'));
    assert.equal(treasury.length, 1);
    assert.equal(treasury[0].userId, W.opA);
    const disputeDoors = w.calls.filter((c, i) => i > first('pay fraud.getDispute') && c.src === 'gates-edge');
    assert.deepEqual(
      disputeDoors.map((c) => c.door),
      ['identity actionApproval.propose', 'identity actionApproval.approve', 'pay fraud.openDispute'],
    );
    assert.equal(disputeDoors[0].input.actionType, OPEN_DISPUTE_ACTION);
    assert.equal(disputeDoors[0].bearer, 'approval-a');
    assert.equal(disputeDoors[1].bearer, 'approval-b');
    assert.deepEqual(claimsOf(disputeDoors[2].bearer).scopes, ['admin:treasury']);
    assert.equal(disputeDoors[2].input.disputeId, merchantDisputeId(W.owner));
    assert.equal(disputeDoors[2].input.approvalId, `ap-${OPEN_DISPUTE_ACTION}`);
    const { approvalId: _a, operationId: _o, ...bound } = disputeDoors[2].input;
    assert.equal(disputeDoors[0].input.payloadHash, openDisputePayloadHash(bound), 'the approved fields are the ones sent');
    assert.ok(w.psqlCalls.some((q) => /^\s*SELECT/.test(q.sql) && q.sql.includes(disputeDoors[0].input.payloadHash)));
    // Every refund and payout of the whole block carries a step-up token.
    for (const c of w.calls.filter((x) => x.door === 'pay payment.refund' || x.door === 'pay settlement.payout'))
      assert.equal(c.bearer, w.OWNER_STEPUP);
  } finally {
    w.cleanup();
  }
});

test('the merchant money block leaves what exists: a settled window, a made refund, an open dispute', async () => {
  const w = moneyWorld({ settled: true, refunded: true, dispute: { status: 'open', amount: '12', assetId: 'USDT' } });
  try {
    await populateMerchantMoneyBlock(w.ctx, W.merchant);
    assert.equal(w.at('pay settlement.run'), -1, 'a settled window is not run again');
    assert.equal(w.at('pay payment.refund'), -1, 'a made refund is not made again');
    assert.equal(w.records.find((r) => r.item === 'refund').status, 'exists');
    assert.equal(w.records.find((r) => r.item === `settlement ${w.window} USDT`).status, 'exists');
    assert.equal(w.records.find((r) => r.item === 'dispute').status, 'exists');
    assert.equal(
      w.calls.slice(w.at('pay fraud.getDispute')).some((c) => c.door === 'operatorSessions' || c.src === 'gates-edge'),
      false,
      'no approver signs in for an open dispute',
    );
  } finally {
    w.cleanup();
  }
  // A refused read is recorded in the service's words and nothing is opened.
  const r = moneyWorld({ over: { 'pay fraud.getDispute': () => noRes('pay is down', 'INTERNAL_SERVER_ERROR', 500) } });
  try {
    await populateMerchantMoneyBlock(r.ctx, W.merchant);
    assert.match(r.records.at(-1).detail, /pay is down/);
    assert.equal(r.records.at(-1).status, 'refused');
    assert.equal(r.at('pay fraud.openDispute'), -1);
  } finally {
    r.cleanup();
  }
  // A founder vault that holds the founders' real accounts is never used: the TEST operators open the dispute.
  const real = ['local_nitro', 'local_test_founder_a', 'local_test_founder_b'].map((handle, n) => ({
    handle,
    userId: `u-${n}`,
    password: 'pw',
    totpSecret: 'S',
    totpConfirmed: true,
  }));
  const f = moneyWorld({ founders: real });
  try {
    await populateMerchantMoneyBlock(f.ctx, W.merchant);
    assert.equal(f.records.at(-1).status, 'created');
    assert.equal(
      f.calls.some((c) => /local_nitro|local_phantom/.test(JSON.stringify(c.input ?? ''))),
      false,
      "never the founders' real accounts",
    );
    assert.equal(
      f.calls.some((c) => c.src === 'gates-edge' && c.door === 'identity auth.login'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('the payout checker approves only the teammate request for this settlement, and the step-up is re-minted near expiry', async () => {
  const cases = [
    [{ makerUserId: W.owner }, 'refused', /owner cannot approve their own request/],
    [{ makerUserId: W.opA }, 'skipped', /not filed by the TEST teammate/],
    [{ railId: 'some-other-rail' }, 'skipped', /names rail some-other-rail/],
    [{ amount: '66' }, 'skipped', /names 66 USDT, not the settlement's 67 USDT/],
  ];
  for (const [change, status, why] of cases) {
    const w = moneyWorld({
      settled: true,
      over: {
        'pay merchantControl.approvals.list': () =>
          okRes({
            items: [
              {
                approvalId: 'pa-9',
                status: 'pending',
                settlementId: 'st-1',
                makerUserId: W.opB,
                railId: MERCHANT_PAYOUT_DESTINATION.railId,
                assetCode: 'USDT',
                amount: '67',
                payloadHash: 'ph',
                ...change,
              },
            ],
          }),
      },
    });
    try {
      await populateMerchantMoneyBlock(w.ctx, W.merchant);
      const r = w.records.find((x) => x.item === 'payout approval');
      assert.equal(r.status, status, JSON.stringify(change));
      assert.match(r.detail, why);
      assert.equal(w.at('pay merchantControl.approvals.decide'), -1, 'nothing is decided');
      assert.equal(w.at('pay settlement.payout'), -1, 'nothing is sent');
    } finally {
      w.cleanup();
    }
  }
  // The held step-up token is reused only while it has 30 s or more; nearer expiry a new one is minted with a fresh code.
  for (const [left, minted] of [
    [60_000, 0],
    [10_000, 1],
  ]) {
    let codes = 0;
    const sent = [];
    const ctx = {
      payStepUp: { ok: true, token: 'held', expiresAt: new Date(Date.now() + left).toISOString() },
      user: {
        factor: { secret: 'S', nextCode: async () => String((codes += 1)) },
        mutate: async (mod, proc, input) => {
          sent.push(input);
          return input.factorProof
            ? {
                status: 200,
                json: {
                  result: { data: { accessToken: 'fresh', refreshable: false, expiresAt: new Date(Date.now() + 300_000).toISOString() } },
                },
                text: '',
              }
            : { status: 400, json: { error: { message: 'factor proof required' } }, text: '' };
        },
      },
    };
    const tok = await ensurePayStepUp(ctx, W.merchant);
    assert.equal(tok.token, minted ? 'fresh' : 'held');
    assert.equal(codes, minted, minted ? 'a token near expiry is re-minted with one TOTP step' : 'a token with time left is reused');
  }
});

test('the payout teammate is invited by the owner and accepts once with a pay:write stand-in on their own session', async () => {
  const team = [
    [],
    [{ userId: W.opB, memberId: 'mem-7', status: 'invited', role: MERCHANT_CHECKER_ROLE }],
    [{ userId: W.opB, memberId: 'mem-7', status: 'active', role: MERCHANT_CHECKER_ROLE }],
  ];
  let reads = 0;
  const w = scriptedWorld({
    founders: ['a', 'b'].map((l) => ({
      key: l,
      handle: `local_test_founder_${l}`,
      userId: l === 'a' ? W.fa : W.fb,
      password: 'pw',
      totpSecret: 'S',
      totpConfirmed: true,
    })),
    over: {
      'pay merchantOps.team.list': () => okRes({ items: team[Math.min(reads++, 2)] }),
      'pay merchantOps.team.acceptInvite': () => okRes({ status: 'active' }),
    },
  });
  try {
    const user = new EdgeClient({ handle: MERCHANT_OWNER.handle, email: 'o', password: 'pw', userId: W.owner }, null, w.deps);
    user.token = jwtOf({ sub: W.owner, mfa: true, sid: 's-owner' });
    user.tokenAt = Date.now();
    const ctx = { ...w.baseCtx, user };
    const pair = await operatorPair(ctx);
    assert.equal(pair.ok, true);
    assert.deepEqual([pair.a.userId, pair.b.userId], [W.opA, W.opB], 'the TEST operators, even with a founder vault present');
    assert.equal(
      w.calls.some((c) => c.door === 'identity auth.login'),
      false,
      "the founders' accounts are not signed in",
    );
    assert.deepEqual(await ensurePayoutTeammate(ctx, pair), { ok: true });
    const invite = ownerSends(w, 'pay merchantOps.team.invite');
    assert.deepEqual(
      invite.map((c) => c.input),
      [{ userId: W.opB, role: MERCHANT_CHECKER_ROLE, label: MERCHANT_DISPLAY_NAME }],
    );
    assert.equal(claimsOf(invite[0].bearer).sid, 's-owner', 'the owner invites on their own session');
    assert.deepEqual(
      w.minted.map((m) => [m.userId, m.sessionId, m.scopes]),
      [[W.opB, 's-b', ['pay:write']]],
      'one stand-in token, for the accept',
    );
    const accept = ownerSends(w, 'pay merchantOps.team.acceptInvite');
    assert.deepEqual(
      accept.map((c) => c.input),
      [{ memberId: 'mem-7' }],
    );
    assert.deepEqual(claimsOf(accept[0].bearer).scopes, ['pay:write']);
    assert.ok(w.at('mint pay:write') > w.at('pay merchantOps.team.invite'));
  } finally {
    w.cleanup();
  }
  // A teammate on a role that cannot approve is reported, and populate changes no role.
  const r = scriptedWorld({
    over: { 'pay merchantOps.team.list': () => okRes({ items: [{ userId: W.opB, memberId: 'm', status: 'active', role: 'viewer' }] }) },
  });
  try {
    const user = new EdgeClient({ handle: 'o', email: 'o', password: 'pw', userId: W.owner }, null, r.deps);
    user.token = jwtOf({ sub: W.owner });
    user.tokenAt = Date.now();
    const ctx = { ...r.baseCtx, user };
    const out = await ensurePayoutTeammate(ctx, await operatorPair(ctx));
    assert.equal(out.ok, false);
    assert.match(out.refusal, /is a viewer on the merchant/);
    assert.deepEqual(r.minted, []);
    assert.equal(
      r.calls.some((c) => /invite|acceptInvite/.test(c.door)),
      false,
    );
  } finally {
    r.cleanup();
  }
});

test('a tier change is submitted by operator A and confirmed by operator B on their plain sessions, with the hash of the change', async () => {
  const sent = [];
  const minted = [];
  const tier = MERCHANT_TIERS[0].tier;
  const target = defineTierTarget(tier);
  const pair = {
    a: { loginToken: 'login-a', token: 'approval-a' },
    b: { loginToken: 'login-b', token: 'approval-b' },
    gates: { refusalText: (res) => refusalText(res) },
    gctx: {
      tokens: { issueAccessToken: async (c) => minted.push(c) },
      edge: {
        mutate: async (mod, proc, input, bearer) => {
          sent.push({ door: `${mod} ${proc}`, input, bearer });
          const outcome = proc.endsWith('.submit') ? 'pending_second_approval' : 'changed';
          return { status: 200, json: { result: { data: { outcome } } }, text: '' };
        },
      },
    },
  };
  const out = await founderChange(pair, {
    submitProc: 'founderAdmin.control.configure.submit',
    confirmProc: 'founderAdmin.control.configure.confirm',
    input: { requestId: 'rq-1', change: target.change, reason: 'LOCAL TEST', expectedVersion: '0' },
    target,
    expectedVersion: '0',
    reason: 'LOCAL TEST',
  });
  assert.deepEqual(out, { ok: true, outcome: 'changed', refusal: null });
  assert.deepEqual(
    sent.map((c) => [c.door, c.bearer]),
    [
      ['pay founderAdmin.control.configure.submit', 'login-a'],
      ['pay founderAdmin.control.configure.confirm', 'login-b'],
    ],
    'the founders act on their plain MFA sessions',
  );
  assert.deepEqual(sent[1].input, {
    requestId: 'rq-1',
    decision: 'confirm',
    reason: 'LOCAL TEST',
    expectedChangeHash: tierChangeHash(target, '0'),
  });
  assert.deepEqual(minted, [], 'no scope stand-in for tier changes');
});

test('the friend is verified only on its own request; another pending request stops it', async () => {
  for (const [others, approves] of [
    [[], true],
    [[{ id: 'k-2', userId: W.owner, tier: 'full' }], false],
  ]) {
    const w = scriptedWorld({ state: { kycPending: [{ id: 'k-1', userId: W.friend, tier: 'full' }, ...others] } });
    try {
      const out = await verifyFriend(w.baseCtx, { userId: W.friend });
      const asked = w.calls.filter((c) => c.door === 'approvePending').map((c) => c.input.userIds);
      if (approves) {
        assert.equal(out.ok, true);
        assert.deepEqual(asked, [[W.friend]], "only the friend's request is approved");
      } else {
        assert.equal(out.ok, false);
        assert.match(out.why, /populate approves only the friend's/);
        assert.deepEqual(asked, []);
      }
    } finally {
      w.cleanup();
    }
  }
});

test('the populate collaborators default to the real ones: the stack gates module and the global fetch', async () => {
  const gatesModule = await import('./local-test-gates.mjs');
  assert.equal(await WORLD_DEPS.gates(), gatesModule, 'the default stack loads the gates module next to it');
  assert.equal(typeof WORLD_DEPS.fetch, 'function');
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response('{}'));
  try {
    await WORLD_DEPS.fetch('http://127.0.0.1:1/x');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(urls, ['http://127.0.0.1:1/x']);
});

test('populate merchant: on the card sandbox only the seed refund goes without a step-up; the money refund and the payout carry it', async () => {
  const OWNER_STEPUP = jwtOf({ sub: W.owner, stepUp: 'owner' });
  const MATE_STEPUP = jwtOf({ sub: W.opB, stepUp: 'mate' });
  const day = '2026-11-21T10:00:00.000Z';
  const set = (st, id, patch) => st.payments.set(id, { ...st.payments.get(id), ...patch });
  const w = scriptedWorld({
    state: { settlements: [], merchant: { id: W.merchant, kybStatus: 'approved' }, emailVerified: true },
    over: {
      'pay railHealth': () => okRes([{ id: 'card-sandbox', mode: 'sandbox' }]),
      'pay payment.create': (input, _b, st) => {
        const spec = MERCHANT_PAYMENTS.find((s) => merchantPaymentId(W.owner, s.n) === input.requestId);
        st.payments.set(input.requestId, {
          id: input.requestId,
          status: 'created',
          createdAt: day,
          capturedAmount: '0',
          refundedAmount: '0',
          amount: spec.amount,
        });
        return okRes({ status: 'created' });
      },
      'pay payment.authorize': (input, _b, st) => {
        if (st.payments.get(input.paymentId).amount === '3.00') {
          set(st, input.paymentId, { status: 'failed' });
          return noRes('card declined', 'BAD_REQUEST');
        }
        set(st, input.paymentId, { status: 'authorized' });
        return okRes({ status: 'authorized' });
      },
      'pay payment.capture': (input, _b, st) => {
        set(st, input.paymentId, { status: 'captured', capturedAmount: st.payments.get(input.paymentId).amount });
        return okRes({ status: 'captured' });
      },
      'pay payment.refund': (input, _b, st) => {
        set(st, input.paymentId, { refundedAmount: input.amount });
        return okRes({ id: input.paymentId, amount: '18', status: 'captured', refundedAmount: input.amount });
      },
      'pay settlement.list': (_i, _b, st) => okRes({ items: st.settlements }),
      'pay settlement.run': (input, _b, st) => {
        const s = { id: 'st-1', window: input.window, status: 'posted', gross: '68', fees: '1', net: '67', assetId: 'USDT' };
        st.settlements.push(s);
        return okRes(s);
      },
      'identity auth.stepUpPay': (input, bearer) =>
        input.factorProof
          ? okRes({
              accessToken: claimsOf(bearer)?.sub === W.opB ? MATE_STEPUP : OWNER_STEPUP,
              refreshable: false,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            })
          : noRes('factor proof required'),
      'pay merchantOps.team.list': () =>
        okRes({ items: [{ userId: W.opB, memberId: 'mem-1', status: 'active', role: MERCHANT_CHECKER_ROLE }] }),
      'pay merchantControl.approvals.request': (input) =>
        okRes({
          approvalId: 'pa-1',
          status: 'pending',
          makerUserId: W.opB,
          railId: input.railId,
          assetCode: 'USDT',
          amount: '67',
          payloadHash: 'ph',
        }),
      'pay merchantControl.approvals.decide': () => okRes({ approvalId: 'pa-1', status: 'approved' }),
      'pay settlement.payout': (input) => okRes({ id: input.settlementId, status: 'paid_out', net: '67', assetId: 'USDT' }),
      'pay fraud.openDispute': (input) => okRes({ disputeId: input.disputeId, status: 'open' }),
    },
  });
  // The owner already exists with its factor (a rerun): signs in with its TOTP and goes straight to the catalogue.
  const factor = new OwnerFactor({ file: w.p.merchantOwner, totp: () => '1' });
  factor.setAccount({ handle: MERCHANT_OWNER.handle, email: MERCHANT_OWNER.email, password: 'pw-owner', userId: W.owner });
  factor.savePending(OWNER_TOTP_SECRET, []);
  factor.adoptPending(1);
  Object.assign(w.st, {
    ownerRegistered: true,
    ownerPassword: 'pw-owner',
    factorSecret: OWNER_TOTP_SECRET,
    approved: new Map([...w.st.approved, [W.owner, new Set(['full'])]]),
  });
  try {
    await populateMerchantStep(w.baseCtx);
    assert.deepEqual(w.unexpected, []);
    assert.equal(
      w.records.filter((r) => r.status === 'error' || r.status === 'refused').length,
      0,
      JSON.stringify(w.records.filter((r) => r.status !== 'created' && r.status !== 'exists')),
    );
    const seedRefundId = merchantRefundId(W.owner, MERCHANT_PAYMENTS.find((s) => s.want === 'refunded').n);
    const refunds = ownerSends(w, 'pay payment.refund');
    assert.equal(refunds.length, 2, 'the seed refund of payment 5 and the money refund');
    for (const r of refunds) {
      if (r.input.refundId === seedRefundId) assert.equal(claimsOf(r.bearer).sid, 's-owner', 'the seed refund runs on the owner session');
      else assert.equal(r.bearer, OWNER_STEPUP, `refund ${r.input.refundId} carries the owner's step-up token`);
    }
    assert.ok(
      refunds.some((r) => r.input.refundId === merchantRefundId(W.owner, MERCHANT_REFUND.n) && r.input.amount === MERCHANT_REFUND.amount),
    );
    assert.deepEqual(
      ownerSends(w, 'pay settlement.payout').map((c) => c.bearer),
      [OWNER_STEPUP],
      'settlement.payout is sent once, on the step-up',
    );
    assert.ok(w.at('pay merchantControl.tiers.list') < w.at('pay payment.create'), 'tiers are in place before the first payment');
    assert.ok(
      lastIndex(w, 'pay merchantControl.tiers.list') < w.at('pay merchantControl.approvals.request'),
      'tiers are in place before the payout request',
    );
    assert.ok(w.at('pay settlement.run') < w.at('pay settlement.payout'));
    assert.ok(w.at('pay settlement.payout') < w.at('pay fraud.getDispute'));
    assert.equal(w.records.find((r) => r.item === 'dispute').status, 'created');
  } finally {
    w.cleanup();
  }
});

// A missing door is found before a TOTP step is spent; the step-up token is only ever a one-request bearer, and no log
// line, record or file carries it.
test('The step-up token is only ever a one-request bearer', async () => {
  // A missing procedure is found before a TOTP step is spent, and the answer is kept for the run.
  for (const probe of [
    { status: 404, json: null, text: 'Not Found' },
    { status: 400, json: { error: { message: 'No procedure found on path "auth.stepUpPay"', data: { code: 'NOT_FOUND' } } }, text: '' },
  ]) {
    let codes = 0;
    const ctx = {
      user: {
        mutate: async () => probe,
        factor: { secret: 'S', nextCode: async () => (codes += 1) },
      },
    };
    const r = await ensurePayStepUp(ctx, 'm-1');
    assert.equal(r.ok, false);
    assert.equal(r.missing, true);
    assert.match(r.refusal, /predates #5011/);
    assert.equal(codes, 0, 'no TOTP step is spent on a door that is not there');
    assert.equal(await ensurePayStepUp(ctx, 'm-1'), r, 'the failed answer is kept for the run');
  }

  // The flow: a saved destination, one refund, the teammate's request, the owner's approval, the send. A scripted
  // stack answers each door and records the bearer it was sent with; every log line, record and file write is kept.
  const OWNER_TOKEN = 'owner.STEPUP-TOKEN-OWNER.sig';
  const MATE_TOKEN = 'mate.STEPUP-TOKEN-MATE.sig';
  const ownerId = '0a1b2c3d-1111-4000-8000-000000000001';
  const mateId = '0a1b2c3d-2222-4000-8000-000000000002';
  const mId = '0a1b2c3d-3333-4000-8000-000000000003';
  const day = '2026-10-17T10:00:00.000Z';
  const payments = [
    { id: merchantPaymentId(ownerId, MERCHANT_REFUND.n), status: 'captured', refundedAmount: '0', createdAt: day },
    { id: merchantPaymentId(ownerId, MERCHANT_PAYOUT_PAYMENT_N), status: 'settled', refundedAmount: '0', createdAt: day },
  ];
  const settlement = { id: 'st-1', window: utcDayLabel(day), status: 'posted', net: '40', assetId: 'USDT' };
  const sent = [];
  const ok = (data) => ({ status: 200, json: { result: { data } }, text: '' });
  const answer = (who, mod, proc, input, bearer) => {
    sent.push({ who, door: `${mod} ${proc}`, input, bearer });
    switch (`${mod} ${proc}`) {
      case 'pay merchant.payoutDestinations.list':
        return ok({
          items: [{ railId: MERCHANT_PAYOUT_DESTINATION.railId, kind: 'crypto', state: 'active', destinationMasked: '0x12...ab' }],
        });
      case 'identity auth.stepUpPay':
        if (!input.factorProof) return { status: 400, json: { error: { message: 'factor proof required' } }, text: '' };
        return ok({
          accessToken: who === 'owner' ? OWNER_TOKEN : MATE_TOKEN,
          refreshable: false,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
      case 'pay payment.refund':
        return ok({ id: input.paymentId, amount: '12', status: 'captured', refundedAmount: input.amount });
      case 'pay merchantControl.approvals.list':
        return ok({ items: [] });
      case 'pay merchantOps.team.list':
        return ok({ items: [{ userId: mateId, memberId: 'mem-1', status: 'active', role: MERCHANT_CHECKER_ROLE }] });
      case 'pay merchantControl.approvals.request':
        return ok({
          approvalId: 'ap-1',
          status: 'pending',
          makerUserId: mateId,
          railId: input.railId,
          assetCode: 'USDT',
          amount: '40',
          payloadHash: 'h1',
        });
      case 'pay merchantControl.approvals.decide':
        return ok({ approvalId: 'ap-1', status: 'approved' });
      case 'pay settlement.payout':
        return ok({ id: input.settlementId, status: 'paid_out', net: '40', assetId: 'USDT', payoutMethod: input.railId });
      default:
        throw new Error(`unexpected door ${mod} ${proc}`);
    }
  };
  const d = mkdtempSync(join(tmpdir(), 'world-stepup-'));
  const opsFile = join(d, 'operators.json');
  writeFileSync(opsFile, JSON.stringify({ operators: { b: { totpSecret: 'MATESECRET', lastStep: 0 } } }));
  const logs = [];
  const records = [];
  const writes = [];
  const fsMod = (await import('node:fs')).default;
  const real = { writeFileSync: fsMod.writeFileSync, appendFileSync: fsMod.appendFileSync, writeSync: fsMod.writeSync };
  for (const name of Object.keys(real))
    fsMod[name] = (...args) => {
      writes.push(String(args[1]));
      return real[name].apply(fsMod, args);
    };
  try {
    const ctx = {
      log: (...a) => logs.push(a.join(' ')),
      record: (...a) => records.push(a),
      user: {
        account: { userId: ownerId },
        factor: { secret: 'OWNERSECRET', nextCode: async () => '111111' },
        query: async (mod, proc, input, bearer) => answer('owner', mod, proc, input, bearer),
        mutate: async (mod, proc, input, bearer) => answer('owner', mod, proc, input, bearer),
      },
      opPair: {
        ok: true,
        gates: { refusalText: (res) => JSON.stringify(res.json?.error ?? res.text) },
        gctx: {
          paths: { operators: opsFile },
          totp: { totp: () => '222222' },
          edge: { mutate: async (mod, proc, input, bearer) => answer('mate', mod, proc, input, bearer) },
        },
        a: { userId: '0a1b2c3d-4444-4000-8000-000000000004', letter: 'a', loginToken: 'a-login' },
        b: { userId: mateId, letter: 'b', loginToken: 'mate-login' },
      },
    };
    await populateMerchantStepUpMoney(ctx, mId, { payments, windows: [utcDayLabel(day)], settlements: [settlement] });
    assert.deepEqual(
      records.map((r) => `${r[1]}: ${r[2]}`),
      ['payout destination: exists', 'refund: created', 'payout request: created', 'payout approval: created', 'payout send: created'],
      JSON.stringify(records),
    );
    const bearerOf = (door) => sent.filter((c) => c.door === door).map((c) => c.bearer);
    assert.deepEqual(bearerOf('pay payment.refund'), [OWNER_TOKEN], "payment.refund carries the owner's step-up token");
    assert.deepEqual(
      bearerOf('pay merchantControl.approvals.request'),
      [MATE_TOKEN],
      "merchantControl.approvals.request carries the teammate's step-up token",
    );
    assert.deepEqual(bearerOf('pay settlement.payout'), [OWNER_TOKEN], "settlement.payout carries the owner's step-up token");
    assert.deepEqual(bearerOf('pay merchantControl.approvals.decide'), [null], 'the owner decides on their own session');
    assert.equal(
      sent.filter((c) => c.who === 'owner' && c.door === 'identity auth.stepUpPay' && c.input.factorProof).length,
      1,
      'one owner step-up serves the refund and the send',
    );
    const doors = sent.map((c) => c.door);
    assert.ok(doors.indexOf('pay merchant.payoutDestinations.list') === 0, 'the saved destination is read first');
    assert.ok(doors.indexOf('pay merchantControl.approvals.list') < doors.indexOf('pay merchantControl.approvals.request'));
    assert.ok(doors.indexOf('pay merchantControl.approvals.request') < doors.indexOf('pay merchantControl.approvals.decide'));
    assert.ok(doors.indexOf('pay merchantControl.approvals.decide') < doors.indexOf('pay settlement.payout'));
    // Bearers only: neither token is in a log line, a record or anything written to a file.
    const carried = [
      ...logs,
      ...records.map((r) => JSON.stringify(r)),
      ...writes,
      ...readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')),
    ];
    assert.ok(writes.length > 0, 'the teammate step spends a TOTP step and writes it down');
    for (const text of carried)
      for (const token of ['STEPUP-TOKEN-OWNER', 'STEPUP-TOKEN-MATE'])
        assert.equal(text.includes(token), false, `the step-up token is never logged, recorded or written: ${text.slice(0, 120)}`);
  } finally {
    Object.assign(fsMod, real);
    rmSync(d, { recursive: true, force: true });
  }
});
