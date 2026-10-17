// Proves, without starting or touching anything: the test-world script refuses outside the local
// test stack, and its planning functions (welcome credits, founder pick, friend replies) are
// idempotent and skip the right accounts. Run: node tooling/scripts/local-test-world.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from './local-test-world.mjs';

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
  assert.equal(isSkippedAccount('local_test_operator_a'), true);
  assert.equal(isSkippedAccount('local_test_operator_b'), true);
  assert.equal(isSkippedAccount('local_test_operators_real_person'), false);
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
  assert.equal(isPayScopeRefusal('starter fee is not configured'), false);
  assert.equal(merchantPaymentId(userId, 1), merchantPaymentId(userId, 1));
  assert.notEqual(merchantPaymentId(userId, 1), merchantPaymentId(userId, 2));
  assert.equal(MERCHANT_PAYMENTS.length, 8);
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
  assert.equal(opened.actions.filter((a) => a.kind === 'create-payment').length, 8);
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
    founders: [{ key: 'nitro', handle: 'local_nitro', userId: pair[0].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true }],
  });
  assert.equal(half, null);
  const enrolled = enrolledLocalFounders({
    founders: [
      { key: 'nitro', handle: 'local_nitro', userId: pair[0].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
      { key: 'phantom', handle: 'local_phantom', userId: pair[1].userId, password: 'pw', totpSecret: 'SECRET', totpConfirmed: true },
      {
        key: 'operator',
        handle: 'local_test_operator_a',
        userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        password: 'pw',
        totpSecret: 'SECRET',
        totpConfirmed: true,
      },
    ],
  });
  assert.deepEqual(
    enrolled.map((f) => f.handle),
    ['local_nitro', 'local_phantom'],
  );
  assert.equal(enrolledLocalFounders({ founders: [{ ...enrolled[0], totpConfirmed: false }, enrolled[1]] }), null);

  const sql = openKybApprovalSql(payloadHash);
  assert.ok(sql.includes(`payload_hash = '${payloadHash}'`));
  assert.ok(sql.includes("'PENDING'"));
  assert.equal(sql.includes(merchantId), false);
  assert.throws(() => openKybApprovalSql(merchantId), /not sha256/);
  assert.deepEqual(founderVaultFiles({ scriptRepo: '/tmp/a', stackRepo: '/tmp/a' }), ['/tmp/a/.env.founder-secrets.local']);
  assert.deepEqual(founderVaultFiles({ scriptRepo: '/tmp/a', stackRepo: 'relative' }), ['/tmp/a/.env.founder-secrets.local']);

  const worldSrc = readFileSync(script, 'utf8');
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

  console.log('local-test-world: all checks passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}
