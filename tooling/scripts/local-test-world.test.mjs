// Proves, without starting or touching anything: the test-world script refuses outside the local
// test stack, and its planning functions (welcome credits, founder pick, friend replies) are
// idempotent and skip the right accounts. Run: node tooling/scripts/local-test-world.test.mjs
import assert from 'node:assert/strict';
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
  assert.ok(POPULATE_SPACES.every((s) => /\(test\)$/.test(s.name))); // every name says it is test data
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

  // LOCAL TEST tiers: agreed values, defined by id and name, assigned once, never rewritten.
  assert.deepEqual(
    MERCHANT_TIERS.map((t) => [t.tier.id, t.tier.name, t.assign]),
    [
      ['local-test-tier', 'LOCAL TEST tier', true],
      ['local-test-tier-2', 'LOCAL TEST tier 2', false],
    ],
  );
  assert.ok(
    MERCHANT_TIERS.every((t) => /^LOCAL TEST tier/.test(t.tier.name) && t.tier.approvalTtlSeconds === 86_400 && t.tier.reserve === null),
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
  assert.ok(Math.max(...MERCHANT_PAYMENTS.map((p) => Number(p.amount))) <= Number(tier1.caps[2].limit));
  assert.equal(MERCHANT_TIER_PRICING_RULE.assetCode, 'USDT');
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
    'differs',
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

  // The step-up token is only ever a one-request bearer; no log line, record or file carries it.
  {
    const src = readFileSync(new URL('./local-test-world.mjs', import.meta.url), 'utf8');
    const flow = src.slice(src.indexOf('async function ensurePayStepUp'), src.indexOf('function trpcData'));
    assert.ok(flow.indexOf("'No procedure found") < flow.indexOf('nextCode()'), 'a missing procedure is found before a TOTP step is spent');
    assert.doesNotMatch(flow, /(?:log|record)\([^)]*(?:tok\.token|accessToken|payStepUp\.token)/, 'the token is never logged or recorded');
    assert.doesNotMatch(flow, /(?:writePrivate\w*|writeFileSync)\([^)]*(?:token|accessToken)/i, 'the token is never written down');
    for (const proc of ['payment.refund', 'merchantControl.approvals.request', 'settlement.payout']) {
      assert.match(flow, new RegExp(`'${proc.replace('.', '\\.')}'[\\s\\S]{0,160}tok\\.token`), `${proc} carries the step-up token`);
    }
  }

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

  const worldSrc = readFileSync(script, 'utf8');
  assert.equal(worldSrc.includes('.env.founder-secrets.local'), false);
  assert.equal(worldSrc.includes('pnpm local:founder'), false);
  const kybFn = worldSrc.slice(
    worldSrc.indexOf('async function decideKybByFounderPair'),
    worldSrc.indexOf('async function runMerchantAction'),
  );
  assert.equal(kybFn.includes('operatorSessions'), false);
  assert.equal(kybFn.includes('gatesApi()'), true);
  assert.equal(kybFn.includes('actionApproval.propose'), true);
  assert.ok(kybFn.indexOf('KYB_FOUNDERS_MISSING') < kybFn.indexOf('actionApproval.propose'));
  assert.equal(worldSrc.includes('bps (published)'), false);
  assert.ok(worldSrc.includes('bps from PAY_MERCHANT_STARTER_FEE_BPS'));

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
  const confirmFn = worldSrc.slice(
    worldSrc.indexOf('async function confirmSeededOwnerEmail'),
    worldSrc.indexOf('async function populateMerchantStep'),
  );
  assert.match(confirmFn, /auth\.requestEmailConfirmation/);
  assert.match(confirmFn, /auth\.confirmEmail/);
  assert.equal(confirmFn.includes('email_verified_at'), false);
  assert.equal(confirmFn.includes('UPDATE'), false);
  assert.equal(worldSrc.includes('grant law unpublished'), false);
  const merchantFn = worldSrc.slice(
    worldSrc.indexOf('async function populateMerchantStep'),
    worldSrc.indexOf('function emptyMerchantObservation'),
  );
  assert.ok(merchantFn.indexOf('confirmSeededOwnerEmail') < merchantFn.indexOf('resignInForMerchantScopes'));
  assert.match(merchantFn, /pay:onboard/);
  const actionFn = worldSrc.slice(worldSrc.indexOf('async function runMerchantAction'), worldSrc.indexOf('const STEP_FNS'));
  assert.equal(actionFn.split('resignInForMerchantScopes').length, 3);

  // ── populate: the merchant money block reads before it writes; refund and payout go only through the step-up flow ──
  const moneyFn = worldSrc.slice(
    worldSrc.indexOf('async function populateMerchantMoneyBlock'),
    worldSrc.indexOf('const OPERATORS_MISSING'),
  );
  const payFlowFn = worldSrc.slice(worldSrc.indexOf('const OPERATORS_MISSING'), worldSrc.indexOf('function trpcData'));
  assert.ok(moneyFn.length > 500);
  assert.equal(
    /settlement\.payout|payment\.refund|refund-payment/.test(moneyFn),
    false,
    'the money block itself neither sends nor refunds',
  );
  assert.match(moneyFn, /populateMerchantStepUpMoney\(ctx, merchantId/);
  assert.equal(worldSrc.split("'settlement.payout'").length, 2, 'settlement.payout is called in exactly one place');
  // The other payment.refund call is the older seed refund of spec payment 5 (runMerchantAction), which has no step-up token.
  assert.equal(worldSrc.split("'payment.refund'").length, 3, 'payment.refund is called in two places');
  assert.ok(payFlowFn.includes("'settlement.payout'") && payFlowFn.includes("'payment.refund'"), 'both sit in the step-up flow');
  assert.match(moneyFn, /'settlement\.list'/);
  assert.match(payFlowFn, /'merchantControl\.approvals\.list'/);
  assert.match(moneyFn, /'fraud\.getDispute'/);
  assert.ok(moneyFn.indexOf("'settlement.list'") < moneyFn.indexOf("'settlement.run'"), 'settlement is read before it is run');
  assert.ok(
    payFlowFn.indexOf("'merchantControl.approvals.list'") < payFlowFn.indexOf("'merchantControl.approvals.request'"),
    'approvals are read before a request',
  );
  assert.ok(
    payFlowFn.indexOf("'merchant.payoutDestinations.list'") < payFlowFn.indexOf('await savePayoutDestination(ctx'),
    'the saved destination is read before one is saved',
  );
  assert.ok(
    payFlowFn.indexOf('planMerchantRefund(') < payFlowFn.indexOf("'payment.refund'"),
    'the refund is planned from what exists before it is made',
  );
  assert.ok(
    payFlowFn.indexOf("'merchantControl.approvals.request'") < payFlowFn.indexOf("'merchantControl.approvals.decide'"),
    'the request comes before the approval',
  );
  assert.ok(
    payFlowFn.indexOf("'merchantControl.approvals.decide'") < payFlowFn.indexOf("'settlement.payout'"),
    'the send comes after the approval',
  );
  assert.ok(
    payFlowFn.indexOf('populateMerchantTiers') < 0 ||
      moneyFn.indexOf('populateMerchantTiers(ctx') < moneyFn.indexOf('populateMerchantStepUpMoney(ctx'),
    'tiers are in place before the payout request',
  );
  assert.ok(
    moneyFn.indexOf("'fraud.getDispute'") < moneyFn.indexOf('openDisputeByApprovalPair('),
    'a dispute is read before the approvers sign in',
  );
  assert.match(moneyFn, /'exists'/);
  assert.match(payFlowFn, /'refused'/);
  assert.ok(moneyFn.indexOf('planMerchantSettlement') < moneyFn.indexOf("'settlement.run'"));
  assert.ok(
    moneyFn.indexOf("'settlement.run'") < moneyFn.indexOf('populateMerchantStepUpMoney(ctx'),
    'settlement comes before refund and payout',
  );
  assert.ok(
    moneyFn.indexOf('populateMerchantStepUpMoney(ctx') < moneyFn.indexOf('openDisputeByApprovalPair('),
    'dispute comes after settlement and payout',
  );
  // The checker approves only what populate asked for, and the step-up token is re-minted when it is about to expire.
  assert.match(payFlowFn, /approval\.makerUserId !== pair\.b\.userId/);
  assert.match(payFlowFn, /Date\.parse\(held\.expiresAt\) - Date\.now\(\) >= 30_000/);
  assert.ok(payFlowFn.indexOf('approval.makerUserId !== pair.b.userId') < payFlowFn.indexOf("'merchantControl.approvals.decide'"));
  // The teammate is a real MFA session: only the invite accept borrows a pay:write token, and the owner approves unaided.
  const mateFn = payFlowFn.slice(
    payFlowFn.indexOf('async function ensurePayoutTeammate'),
    payFlowFn.indexOf('async function teammateStepUp'),
  );
  assert.equal(mateFn.split('approverScopedToken(').length, 2, 'one stand-in token, for the accept');
  assert.match(mateFn, /acceptInvite/);
  assert.equal(/local_nitro|local_phantom/.test(payFlowFn), false, "never the founders' real accounts");
  const decideCall = payFlowFn.slice(
    payFlowFn.indexOf("'merchantControl.approvals.decide'"),
    payFlowFn.indexOf("'merchantControl.approvals.decide'") + 260,
  );
  assert.equal(/tok\b|approverScopedToken|pay:write/.test(decideCall), false, 'the owner decides on their own session');
  const tierFn = payFlowFn.slice(
    payFlowFn.indexOf('async function founderChange'),
    payFlowFn.indexOf('async function ensurePayoutTeammate'),
  );
  assert.ok(tierFn.includes('a.loginToken') && tierFn.includes('b.loginToken'), 'the founders act on their plain MFA sessions');
  assert.equal(/approverScopedToken|approvalToken/.test(tierFn), false, 'no scope stand-in for tier changes');
  assert.ok(tierFn.indexOf('tierChangeHash(') < tierFn.indexOf('expectedChangeHash'), 'the confirm carries the hash of the change');
  const disputeFn = worldSrc.slice(
    worldSrc.indexOf('async function openDisputeByApprovalPair'),
    worldSrc.indexOf('async function populateMerchantMoneyBlock'),
  );
  assert.match(disputeFn, /signInTestOperatorPair/);
  assert.match(disputeFn, /loadEnrolledFounders/);
  assert.match(disputeFn, /'admin:treasury'/);
  assert.equal(/local_nitro|local_phantom/.test(disputeFn), false, "never the founders' real accounts");
  assert.ok(disputeFn.indexOf('planPairApproval') < disputeFn.indexOf("'fraud.openDispute'"));
  assert.match(worldSrc, /if \(merchantId && moneyOpen\) await populateMerchantMoneyBlock\(ctx, merchantId\)/);

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
    const login = worldSrc.slice(worldSrc.indexOf('  async login() {'), worldSrc.indexOf('  async ensureAccount()'));
    assert.match(login, /pendingSecret/);
    assert.match(login, /adoptPending/);
    assert.match(worldSrc, /writePrivateAtomic[\s\S]*fsyncSync[\s\S]*renameSync/);
    assert.equal(
      worldSrc.includes('unlinkSync(this.file') || worldSrc.includes('rmSync(this.file'),
      false,
      'never deletes the factor file',
    );
  }
  assert.match(ownerFactorRefusal('Two-factor is already enrolled [CONFLICT]'), /holds|does not hold/);
  assert.match(ownerFactorRefusal('Two-factor is already enrolled [CONFLICT]'), /nothing was reset/);
  assert.match(ownerFactorRefusal('Verify with your second factor [FORBIDDEN]'), /cannot drive/);
  assert.equal(ownerFactorRefusal('boom [X]'), 'boom [X]');
  const factorFn = worldSrc.slice(
    worldSrc.indexOf('async function ensureOwnerSecondFactor'),
    worldSrc.indexOf('async function populateMerchantStep'),
  );
  assert.match(factorFn, /totp\.enrol/);
  assert.match(factorFn, /totp\.confirm/);
  assert.ok(
    factorFn.indexOf('savePending') < factorFn.indexOf('totp.confirm', factorFn.indexOf('savePending')),
    'secret is written down before it is confirmed',
  );
  assert.equal(/console\.log|log\(/.test(factorFn.replace(/record\(/g, '')), false, 'the factor step never prints or logs');
  assert.equal(/secret\}|\$\{.*[sS]ecret/.test(factorFn), false, 'no secret goes into a message');
  assert.equal(factorFn.includes('UPDATE'), false);
  // Separate merchant owner: the main test customer is never given a factor or an enrolment.
  assert.ok(worldSrc.includes('new EdgeClient(account, factor)'));
  assert.equal(stackPaths(home).merchantOwner.endsWith('merchant-owner.json'), true);
  assert.equal(MERCHANT_OWNER.handle, 'test_merchant_owner');
  assert.match(MERCHANT_OWNER.email, /@local-test\.invalid$/);
  assert.equal(isTestAccount({ handle: MERCHANT_OWNER.handle, email: MERCHANT_OWNER.email }), true);
  const ownerFn = worldSrc.slice(
    worldSrc.indexOf('async function ensureMerchantOwner'),
    worldSrc.indexOf('async function populateMerchantStep'),
  );
  assert.match(ownerFn, /ensureAccount/);
  assert.ok(ownerFn.indexOf('setAccount(account)') < ownerFn.indexOf('ensureAccount'), 'credentials are written before the register call');
  const cmdFn = worldSrc.slice(worldSrc.indexOf('async function cmdPopulate'), worldSrc.indexOf('async function main'));
  assert.equal(/OwnerFactor|totp|factor/i.test(cmdFn), false, 'the main test account signs in with a password only');
  assert.equal(worldSrc.includes('world-owner-factor'), false);
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
    assert.match(worldSrc, /approvePending\(gctx, null, \{ userIds: \[friend\.userId\] \}\)/);
    assert.match(worldSrc, /approvePending\(gctx, null, \{ userIds: \[userId\] \}\)/);
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
    const pairFn = worldSrc.slice(
      worldSrc.indexOf('async function signInTestOperatorPair'),
      worldSrc.indexOf('function loadEnrolledFounders'),
    );
    assert.match(pairFn, /operatorSessions/);
    assert.equal(pairFn.includes('writePrivate') || pairFn.includes('writeFileSync'), false, 'never writes a second credentials file');
    assert.match(worldSrc, /signedIn = founders \? await signInLocalFounders[\s\S]*signInTestOperatorPair/);
  }
  const kycFn = worldSrc.slice(
    worldSrc.indexOf('async function ensureOwnerKycFull'),
    worldSrc.indexOf('async function populateMerchantStep'),
  );
  assert.match(kycFn, /kyc\.submit/);
  assert.match(kycFn, /approvePending/);
  assert.match(kycFn, /other pending verification request/, "only the owner's own request is ever approved");
  assert.ok(kycFn.indexOf('others.length') < kycFn.indexOf('approvePending'));
  const stepFn = worldSrc.slice(
    worldSrc.indexOf('async function populateMerchantStep'),
    worldSrc.indexOf('function emptyMerchantObservation'),
  );
  assert.ok(stepFn.indexOf('ensureOwnerKycFull') < stepFn.indexOf('resignInForMerchantScopes'));
  assert.ok(
    stepFn.indexOf("'create-merchant', 'submit-kyb', 'decide-kyb'") < stepFn.indexOf("'railHealth'"),
    'onboarding runs before the pay:read reads',
  );
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

  // Operator pair: the signed-in subject must be the operator the pair names before any elevated token is used.
  {
    const src = readFileSync(new URL('./local-test-world.mjs', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async function signInTestOperatorPair'), src.indexOf('function loadEnrolledFounders'));
    assert.match(body, /claims\.sub !== expected/);
    assert.match(body, /sess\.op\.userId !== expected/);
    assert.ok(body.indexOf('claims.sub !== expected') < body.indexOf('out.push('), 'identity check runs before the session is used');
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
