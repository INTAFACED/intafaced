// Proves, without starting or touching anything: the option-B stand-ins refuse outside the local test
// stack, every record they build carries the `local-test:` marker and the LOCAL TEST label, and the
// hashes match what the services compute. Run: node tooling/scripts/local-test-gates.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GuardError,
  MARKERS,
  assertLocalTarget,
  bookProposal,
  buildLifecyclePublication,
  identityPayloadHash,
  kycApproveProposal,
  lifecycleIsFresh,
  makeContext,
  matchingPayloadHash,
  bankPayloadHash,
  fraudListingFields,
  SET_FRAUD_LISTING_ACTION,
  TEST_FRAUD_LIST,
  founderSignIns,
  termsProposal,
  TEST_TRANSFER_TERMS,
  TEST_ASSET_ROWS,
  TEST_RETIRED_ASSET_ROW,
  TEST_DEPOSIT_NETWORKS,
  TEST_DEPOSIT_TERMS,
  TEST_UNSUPPORTED_DEPOSIT,
  TEST_HALTED_DEPOSIT,
  TEST_WITHDRAWAL_LIMITS,
  TEST_CUSTODY_POLICY_RULES,
  TEST_CUSTODY_CONFIG_QUORUM,
  networkRowMatches,
  payProposal,
  assetEditProposal,
  assetRowMatches,
  needsFullTier,
  openProposal,
  openableMarkets,
  operatorIdentity,
  refusalText,
  CHART_DATA_CLASS_ACTION,
  TEST_CHART_COUNTS,
  TEST_CHART_DATA_CLASSES,
  chartDataClassPayloadHash,
  chartDataClassProposal,
  nextTotpStep,
  TOTP_SKEW_STEPS,
  EDGE_AUTHORITY_CACHE_MAX_MS,
  POSTING_FREEZE_REASON,
  postingFreezePlan,
  postingFreezeProposal,
  ADMIN_SESSION_COOKIE,
  scopesWithout,
  sealConsoleSession,
  stackFounderScopes,
} from './local-test-gates.mjs';
import { draftFounderVault } from './local-test-founders.mjs';
import { TEST_SPOT_LISTINGS, localTestDatabaseUrl } from './seed-spot-test-listing.mjs';
import { TEST_KYB_ENTITY_TYPES, TEST_KYB_UPLOAD_RULES } from './seed-pay-kyb-test-requirements.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'local-test-gates.mjs');
const run = (home, args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

const home = mkdtempSync(join(tmpdir(), 'local-test-gates-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
const ports = { edge: 14500, ledger: 14501, identity: 14502, trade: 14504, matching: 14505, customer: 3210 };
const marker = (extra = {}) => JSON.stringify({ kind: 'intafaced-local-test-stack', ports, ...extra });
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof GuardError && re.test(e.message));
// The guards read the stack's folder from LOCAL_STACK_STATE when it is set (a cloud container sets it), which would
// point them at the real stack instead of this test's empty home. These checks are about that home only.
const shellState = process.env.LOCAL_STACK_STATE;
delete process.env.LOCAL_STACK_STATE;
try {
  // Guard 1: no state directory, no marker, wrong marker, unreadable marker.
  refuses(() => assertLocalTarget({ home }), /state directory .* not found/);
  mkdirSync(state, { recursive: true });
  refuses(() => assertLocalTarget({ home }), /marker .* not found/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'something-else', ports }));
  refuses(() => assertLocalTarget({ home }), /not a local test stack marker/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), '{not json');
  refuses(() => assertLocalTarget({ home }), /unreadable/);

  // Guard 2: a marker that does not list every port the gates talk to.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { edge: 14500 } }));
  refuses(() => assertLocalTarget({ home }), /does not list ports for ledger, identity, trade, matching/);

  // Guard 3: the good marker passes; any foreign host, scheme or port is refused.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker());
  assert.ok(assertLocalTarget({ home }).marker);
  refuses(() => assertLocalTarget({ home, urls: ['http://example.com:14500'] }), /not http:\/\/127\.0\.0\.1/);
  refuses(() => assertLocalTarget({ home, urls: ['http://10.0.0.5:14504'] }), /not http:\/\/127\.0\.0\.1/);
  refuses(() => assertLocalTarget({ home, urls: ['https://127.0.0.1:14504'] }), /not http:\/\/127\.0\.0\.1/);
  refuses(() => assertLocalTarget({ home, urls: ['http://127.0.0.1:9999'] }), /not a port of the local test stack/);

  // Guard 4: makeContext refuses with no marker, before any secret or network read.
  const empty = mkdtempSync(join(tmpdir(), 'local-test-gates-empty-'));
  await assert.rejects(
    () => makeContext({ home: empty }),
    (e) => e instanceof GuardError,
  );
  rmSync(empty, { recursive: true, force: true });

  // Guard 5: every CLI command refuses (exit 1) with no marker.
  const nothing = mkdtempSync(join(tmpdir(), 'local-test-gates-none-'));
  for (const cmd of ['apply', 'operators', 'lifecycle', 'open', 'verify', 'status', ['posting-freeze', 'on'], ['posting-freeze', 'off']]) {
    const r = run(nothing, [cmd].flat());
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /refusing: state directory .* not found/);
  }
  rmSync(nothing, { recursive: true, force: true });
} finally {
  rmSync(home, { recursive: true, force: true });
  if (shellState !== undefined) process.env.LOCAL_STACK_STATE = shellState;
}
console.log('local-test-gates: guard checks passed');

// Markers: a production check can match these exact strings.
assert.equal(MARKERS.idPrefix, 'local-test:');
assert.match(MARKERS.label, /^LOCAL TEST — not a real approval$/);
assert.match(MARKERS.lifecycleLabel, /LOCAL TEST — not an owner or legal approval/);

// The lifecycle publication: every id-like field carries the marker, every label says LOCAL TEST.
const now = new Date('2026-10-13T10:00:00.000Z');
const pub = buildLifecyclePublication({ marketId: 'm-1', now });
assert.equal(pub.marketId, 'm-1');
assert.equal(pub.causalPredecessorId, null);
for (const v of [
  pub.idempotencyKey,
  pub.authoritySubject,
  pub.authorityScope.replace('market:m-1:', ''),
  pub.ruleVersion,
  pub.instrumentVersion,
  pub.authority.actorId,
  pub.authority.legalOwnerId,
  pub.authority.accountId,
  pub.authority.subAccountId,
  pub.authority.sessionId,
  pub.authority.grantId,
  pub.authority.grantVersion,
  pub.dossier.dossierId,
  pub.dossier.ruleVersion,
  pub.dossier.instrumentVersion,
  ...pub.dossier.approvalRefs,
]) {
  assert.ok(String(v).startsWith(MARKERS.idPrefix), `not marked: ${v}`);
}
assert.equal(pub.authoritySubject, pub.authority.actorId, 'schema: authoritySubject must equal authority.actorId');
assert.ok(pub.authorityScope.startsWith('market:m-1:'), 'schema: scope must be market-bound');
assert.equal(pub.authority.decision, 'AUTHORIZED');
assert.equal(pub.authority.origin, 'OPERATOR');
assert.ok(pub.authority.sessionId, 'OPERATOR origin needs a session id');
const families = Object.keys(pub.dossier).filter((k) => pub.dossier[k]?.status);
assert.equal(families.length, 10, 'all ten admission families present');
for (const f of families) {
  assert.equal(pub.dossier[f].status, 'READY');
  for (const ref of pub.dossier[f].evidenceRefs) assert.ok(ref.startsWith(MARKERS.idPrefix) && ref.includes('LOCAL TEST'), ref);
}
assert.ok(pub.dossier.approvalRefs.every((r) => r.includes('LOCAL TEST — not an owner or legal approval')));
// Timestamps obey the service's own rules (services/svc-trade/src/market-lifecycle.ts schema).
assert.ok(Date.parse(pub.effectiveAt) <= Date.parse(pub.observedAt));
assert.ok(Date.parse(pub.dossier.approvedAt) <= Date.parse(pub.observedAt));
assert.ok(Date.parse(pub.expiresAt) > Date.parse(pub.observedAt));
// A follow-on publication names its predecessor.
assert.equal(buildLifecyclePublication({ marketId: 'm-1', now, causalPredecessorId: 'e-1' }).causalPredecessorId, 'e-1');
assert.throws(() => buildLifecyclePublication({ marketId: ' ' }), /marketId required/);

// Freshness: ours, authorised, more than a week left.
assert.equal(lifecycleIsFresh(pub, new Date('2026-10-14T10:00:00.000Z')), true);
assert.equal(lifecycleIsFresh(pub, new Date('2026-11-10T10:00:00.000Z')), false, 'under a week left renews');
assert.equal(lifecycleIsFresh({ ...pub, authoritySubject: 'someone-else' }, now), false, 'never adopts a publication that is not ours');
assert.equal(lifecycleIsFresh(null, now), false);

// Hashes equal what the services compute (see services/svc-matching/src/action-approval-consume.ts and
// services/svc-identity/src/auth/privileged-dual-control.ts).
const { createHash } = await import('node:crypto');
const sha = (o) => `sha256:${createHash('sha256').update(JSON.stringify(o)).digest('hex')}`;
assert.equal(matchingPayloadHash('matching.open', { marketId: 'm-1' }), sha({ actionType: 'matching.open', marketId: 'm-1' }));
assert.equal(identityPayloadHash('kyc.approve', { recordId: 'r-1' }), sha({ targetId: 'kyc.approve', recordId: 'r-1' }));
const matchingSrc = readFileSync(resolve(here, '..', '..', 'services', 'svc-matching', 'src', 'action-approval-consume.ts'), 'utf8');
assert.ok(matchingSrc.includes('JSON.stringify({ actionType, ...fields })'), 'matching hash recipe changed; update matchingPayloadHash');
const identitySrc = readFileSync(
  resolve(here, '..', '..', 'services', 'svc-identity', 'src', 'auth', 'privileged-dual-control.ts'),
  'utf8',
);
assert.ok(identitySrc.includes('JSON.stringify({ targetId, ...fields })'), 'identity hash recipe changed; update identityPayloadHash');

// Proposals target exactly what the services consume.
const open = openProposal('m-1');
assert.deepEqual(
  [open.actionType, open.targetService, open.targetId, open.expectedVersion, open.policyVersion],
  ['matching.open', 'svc-matching', 'open:m-1', '1', 'local-test:v1'],
);
const kyc = kycApproveProposal('r-1');
assert.deepEqual(
  [kyc.actionType, kyc.targetService, kyc.targetId, kyc.expectedVersion],
  ['kyc.approve', 'svc-identity', 'kyc.approve', '1'],
);
const routerSrc = readFileSync(resolve(here, '..', '..', 'services', 'svc-matching', 'src', 'router.ts'), 'utf8');
assert.ok(routerSrc.includes("'matching.open', { marketId }, `open:${marketId}`"), 'matching open recipe changed; update openProposal');
// Halt and resume use the same recipe as open, one action word apart.
for (const action of ['halt', 'resume']) {
  const p = bookProposal(action, 'm-1');
  assert.deepEqual([p.actionType, p.targetId], [`matching.${action}`, `${action}:m-1`]);
  assert.equal(p.payloadHash, matchingPayloadHash(`matching.${action}`, { marketId: 'm-1' }));
  assert.ok(
    routerSrc.includes(`'matching.${action}', { marketId }, \`${action}:\${marketId}\``),
    `matching ${action} recipe changed; update bookProposal`,
  );
}
assert.throws(() => bookProposal('delete', 'm-1'));
const identityRouter = readFileSync(resolve(here, '..', '..', 'services', 'svc-identity', 'src', 'router.ts'), 'utf8');
assert.ok(identityRouter.includes("'kyc.approve', { recordId: input.recordId }"), 'kyc.approve recipe changed; update kycApproveProposal');

// Bank ops: fields sorted by key, the same recipe as services/svc-bank/src/action-approval-consume.ts.
assert.equal(
  bankPayloadHash('bank.ops.publishTransferTerms', { fee: '0', assetId: 'USDT' }),
  sha({ actionType: 'bank.ops.publishTransferTerms', fields: { assetId: 'USDT', fee: '0' } }),
);
const bankSrc = readFileSync(resolve(here, '..', '..', 'services', 'svc-bank', 'src', 'action-approval-consume.ts'), 'utf8');
assert.ok(bankSrc.includes('JSON.stringify({ actionType, fields: sortedCopy })'), 'bank hash recipe changed; update bankPayloadHash');
const terms = termsProposal(TEST_TRANSFER_TERMS[0]);
assert.deepEqual(
  [terms.actionType, terms.targetService, terms.targetId, terms.expectedVersion, terms.policyVersion],
  ['bank.ops.publishTransferTerms', 'svc-bank', 'bank.ops.publishTransferTerms', '1', 'local-test:v1'],
);
const termsSrc = readFileSync(resolve(here, '..', '..', 'services', 'svc-bank', 'src', 'transfers', 'transfer-terms.ts'), 'utf8');
assert.ok(
  termsSrc.includes("PUBLISH_TRANSFER_TERMS_ACTION = 'bank.ops.publishTransferTerms'"),
  'terms action renamed; update termsProposal',
);
// The TEST figures are canonical decimals, so the hash the stack signs is the one svc-bank recomputes.
for (const t of TEST_TRANSFER_TERMS)
  for (const v of [t.perTransferLimit, t.dailyLimit, t.fee]) assert.match(v, /^(0|[1-9]\d*)(\.\d*[1-9])?$/, `${t.assetId} ${v}`);

// The TEST fraud list (W-withdraw-03): the approval is bound to the fields svc-bank normalises (lower-case EVM address, `*` or a
// lower-case network, the next revision, the reason), so the hash the stack signs is the one svc-bank recomputes.
const fraudSrc = readFileSync(resolve(here, '..', '..', 'services', 'svc-bank', 'src', 'ramps', 'fraud-list.ts'), 'utf8');
assert.ok(fraudSrc.includes(`SET_FRAUD_LISTING_ACTION = '${SET_FRAUD_LISTING_ACTION}'`), 'fraud listing action renamed; update the stack');
for (const field of ['revision: String(input.expectedRevision + 1)', 'reason: input.reason.trim()'])
  assert.ok(fraudSrc.includes(field), 'fraud listing approval fields changed; update fraudListingFields');
assert.deepEqual(
  fraudListingFields({
    network: '*',
    address: '0x7E5700000000000000000000000000000000FA1D',
    listed: true,
    expectedRevision: 0,
    reason: ' LOCAL TEST: x ',
  }),
  { network: '*', address: '0x7e5700000000000000000000000000000000fa1d', listed: 'true', revision: '1', reason: 'LOCAL TEST: x' },
);
assert.deepEqual(fraudListingFields({ network: 'Base', address: 'bc1Qx', listed: false, expectedRevision: 2, reason: 'LOCAL TEST: y' }), {
  network: 'base',
  address: 'bc1Qx',
  listed: 'false',
  revision: '3',
  reason: 'LOCAL TEST: y',
});
const journey05 = readFileSync(resolve(here, '..', '..', 'apps', 'customer', 'tests', 'real-app', 'J-wallet-05.pw.mjs'), 'utf8');
for (const listed of TEST_FRAUD_LIST) {
  assert.ok(journey05.includes(`FRAUD_LISTED = '${listed.address}'`), 'J-wallet-05 #2 lists another address; keep them the same');
  assert.match(listed.reason, /^LOCAL TEST: .{10,}/);
}

// Asset registry: the proposal names the row's revision and the action svc-ledger consumes; every TEST row is a valid
// edit body (unique EVM networks, the default among them) and is matched again once published, so a rerun is a no-op.
const regSrc = readFileSync(resolve(here, '..', '..', 'packages', 'contracts', 'src', 'asset-registry.ts'), 'utf8');
assert.ok(regSrc.includes("ASSET_EDIT_ACTION_TYPE = 'ledger.asset_edit'"), 'asset edit action renamed; update assetEditProposal');
const assetProposal = assetEditProposal({ id: 'USDT' }, 3, 'sha256:x');
assert.deepEqual(
  [
    assetProposal.actionType,
    assetProposal.targetService,
    assetProposal.targetId,
    assetProposal.expectedVersion,
    assetProposal.policyVersion,
  ],
  ['ledger.asset_edit', 'svc-ledger', 'USDT', '3', 'local-test:v1'],
);
const ownerProfile = JSON.parse(readFileSync(resolve(here, '..', 'profiles', 'test-owner-values', 'ledger.json'), 'utf8'));
const usdtRow = TEST_ASSET_ROWS.find((row) => row.id === 'USDT');
assert.equal(String(usdtRow.precision), ownerProfile.values.LEDGER_ASSET_PRECISION_USDT.value);
assert.notEqual(ownerProfile.values.LEDGER_ASSET_PRECISION_USDT.value.trim(), '');
for (const row of TEST_ASSET_ROWS) {
  const ids = row.networks.map((n) => n.networkId);
  assert.equal(new Set(ids).size, ids.length, row.id);
  assert.ok(ids.includes(row.defaultNetworkId), row.id);
  assert.ok(row.allowedActions.includes('withdraw') && row.state === 'active', row.id);
  for (const n of row.networks) assert.ok(n.label.startsWith('TEST '), n.label);
  const published = { ...row, allowedActions: [...row.allowedActions].reverse(), revision: 4, updatedAt: '2026-10-23T00:00:00.000Z' };
  assert.ok(assetRowMatches(published, row), `${row.id} published again on every run`);
  assert.ok(!assetRowMatches({ ...published, networks: [] }, row), `${row.id} blank row taken as published`);
  assert.ok(!assetRowMatches({ ...published, precision: null }, row));
  assert.ok(!assetRowMatches(null, row));
}

// The retired TEST row: named TEST, allows nothing, lists a TEST network, and is not one of the active rows deposits use.
assert.ok(TEST_RETIRED_ASSET_ROW.id.startsWith('TEST'));
assert.equal(TEST_RETIRED_ASSET_ROW.state, 'retired');
assert.deepEqual(TEST_RETIRED_ASSET_ROW.allowedActions, []);
assert.ok(TEST_RETIRED_ASSET_ROW.networks.every((n) => n.label.startsWith('TEST ')));
assert.ok(!TEST_ASSET_ROWS.some((row) => row.id === TEST_RETIRED_ASSET_ROW.id));
assert.ok(assetRowMatches({ ...TEST_RETIRED_ASSET_ROW, revision: 1, updatedAt: '2026-10-24T00:00:00.000Z' }, TEST_RETIRED_ASSET_ROW));
assert.ok(!assetRowMatches({ ...TEST_RETIRED_ASSET_ROW, state: 'active' }, TEST_RETIRED_ASSET_ROW), 'an unretired row taken as published');

// TEST deposit networks and terms: labelled, decimal strings for money, every pair on a published network, and a network row
// published once is left alone (version and clock aside) while any difference publishes it again.
assert.deepEqual(
  TEST_DEPOSIT_NETWORKS.map((n) => n.networkId),
  ['ethereum', 'base'],
);
for (const n of TEST_DEPOSIT_NETWORKS) {
  assert.ok(n.displayName.startsWith('TEST '), n.displayName);
  assert.equal(typeof n.feeEstimateAmount, 'string');
  const published = { ...n, assetCodes: [...n.assetCodes].reverse(), version: 3, updatedAt: '2026-10-24T00:00:00.000Z' };
  assert.ok(networkRowMatches(published, n), `${n.networkId} published again on every run`);
  assert.ok(
    networkRowMatches({ ...published, assetCodes: [...n.assetCodes, 'ETH'] }, n),
    'another asset on the network is not a difference',
  );
  assert.ok(!networkRowMatches({ ...published, assetCodes: ['USDC'] }, n), `${n.networkId} missing a TEST asset taken as published`);
  assert.ok(!networkRowMatches({ ...published, enabled: false }, n), `${n.networkId} switched off taken as published`);
  assert.ok(!networkRowMatches({ ...published, confirmationsRequired: null }, n));
  assert.ok(!networkRowMatches(null, n));
}
// The TEST networks ask for as many confirmations as the stack's svc-pay credits at, so the room's count and the credit agree.
{
  const { default: payService } = await import('./local-stack-services/pay.mjs');
  const payEnv = payService({
    c: () => ({}),
    secrets: { payTravelRuleKey: 'TEST-placeholder' },
    dbUrl: () => '',
    urlOf: () => '',
    PORTS: {},
  }).env();
  for (const n of TEST_DEPOSIT_NETWORKS) assert.equal(String(n.confirmationsRequired), payEnv.PAY_MIN_CONFIRMATIONS, n.networkId);
}
assert.equal(TEST_DEPOSIT_TERMS.length, 4);
for (const t of TEST_DEPOSIT_TERMS) {
  const network = TEST_DEPOSIT_NETWORKS.find((n) => n.networkId === t.networkId);
  assert.ok(network?.assetCodes.includes(t.assetId), `${t.assetId} on ${t.networkId} is not on a TEST network`);
  assert.equal(t.label, network.displayName);
  assert.equal(typeof t.minimumDeposit, 'string');
  // Exactly one TEST pair stays switched off, with a TEST note; every other pair is on with none.
  const off = t.assetId === TEST_HALTED_DEPOSIT.assetId && t.networkId === TEST_HALTED_DEPOSIT.networkId;
  assert.equal(t.enabled, !off);
  if (off) assert.match(t.haltNote, /^TEST: /);
  else assert.equal(t.haltNote, null);
  // Exactly one TEST pair, switched on, publishes an unsupported-case list, each case marked TEST; the rest publish none.
  const listed = t.assetId === TEST_UNSUPPORTED_DEPOSIT.assetId && t.networkId === TEST_UNSUPPORTED_DEPOSIT.networkId;
  if (listed) {
    assert.ok(t.enabled && t.unsupportedCases.length > 0);
    for (const item of t.unsupportedCases) assert.match(item, /^TEST: /);
  } else assert.deepEqual(t.unsupportedCases, []);
}
assert.equal(TEST_DEPOSIT_TERMS.filter((t) => !t.enabled).length, 1);
// TEST withdrawal limits for every verified level, none for an unverified account, and the stack's svc-pay enforces them.
assert.deepEqual([...TEST_WITHDRAWAL_LIMITS.tiers], ['basic', 'full', 'institutional']);
{
  const { default: payService } = await import('./local-stack-services/pay.mjs');
  const payEnv = payService({
    c: () => ({}),
    secrets: { payTravelRuleKey: 'TEST-placeholder' },
    dbUrl: () => '',
    urlOf: () => '',
    PORTS: {},
  }).env();
  assert.equal(payEnv.PAY_WITHDRAWAL_LIMITS, 'required');
  // J-wallet-05: a TEST custody signer on TEST Ethereum only, so TEST Base stays unconnected (#7).
  assert.equal(payEnv.PAY_TEST_WITHDRAW_SIGNER_NETWORKS, 'ethereum');
}
// The TEST custody policy allows only wallet transfers on the crypto-native rail, labelled TEST, with no approval group, and
// asks one approval of the second founder for its own config task.
assert.equal(TEST_CUSTODY_POLICY_RULES.length, 1);
assert.match(TEST_CUSTODY_POLICY_RULES[0].id, /^TEST-/);
assert.deepEqual(JSON.parse(JSON.stringify(TEST_CUSTODY_POLICY_RULES[0])), {
  id: 'TEST-allow-wallet-sends',
  action: 'allow',
  match: { networks: ['crypto-native'], destinationKinds: ['crypto'], txTypes: ['transfer'] },
});
assert.deepEqual({ ...TEST_CUSTODY_CONFIG_QUORUM }, { kind: 'config', requiredApprovals: 1, expirySeconds: 3600 });
assert.deepEqual(payProposal('pay.registry_change', 'sha256:abc'), {
  actionType: 'pay.registry_change',
  targetService: 'svc-pay',
  targetId: 'pay.registry_change',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  policyVersion: MARKERS.policyVersion,
});

// Operators are labelled and distinct.
const a = operatorIdentity('a');
const b = operatorIdentity('B');
assert.notEqual(a.handle, b.handle);
for (const o of [a, b]) {
  assert.ok(o.handle.startsWith(MARKERS.operatorHandlePrefix) && /^[a-zA-Z0-9_]{3,32}$/.test(o.handle), o.handle);
  assert.ok(o.email.endsWith(MARKERS.operatorEmailDomain));
}
assert.throws(() => operatorIdentity('c'), /operators are a and b/);

// Which markets get a publication: active, orderable, spot, not paper, 24/7 crypto schedule only.
const base = { active: true, orderable: true, spot: true, paper: false, schedule: 'crypto-24x7' };
const picked = openableMarkets([
  { ...base, symbol: 'BTC/USDT' },
  { ...base, symbol: 'XAU/USD', schedule: 'cme-globex' },
  { ...base, symbol: 'EUR/USD', orderable: false, schedule: 'fx-global' },
  { ...base, symbol: 'PAPER/X', paper: true },
  { ...base, symbol: 'OFF/USDT', active: false },
]);
assert.deepEqual(
  picked.map((m) => m.symbol),
  ['BTC/USDT'],
);

// TEST spot listings: labelled TEST, no dollar side needed, quoted by the market maker, and opened like any spot book.
{
  const marketSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'local-test-market.mjs'), 'utf8');
  assert.ok(TEST_SPOT_LISTINGS.some((l) => l.symbol === 'ETH/BTC'));
  for (const l of TEST_SPOT_LISTINGS) {
    assert.match(l.displayName, /TEST/);
    assert.equal(l.symbol, `${l.baseAsset}/${l.quoteAsset}`);
    assert.ok(marketSrc.includes(`'${l.symbol}': { start:`), `${l.symbol} has a TEST price`);
    assert.match(marketSrc, new RegExp(`const DEFAULT_SYMBOLS = \\[[^\\]]*'${l.symbol}'`));
    assert.deepEqual(
      openableMarkets([{ ...base, symbol: l.symbol, test: true }]).map((m) => m.symbol),
      [l.symbol],
    );
  }
  // The spot seed refuses production and any database that does not look local or test.
  const local = 'postgres://u:p@127.0.0.1:15460/intafaced_local_test';
  assert.equal(localTestDatabaseUrl(local, {}), local);
  assert.throws(() => localTestDatabaseUrl(local, { NODE_ENV: 'production' }), /NODE_ENV is production/);
  assert.throws(() => localTestDatabaseUrl('postgres://u:p@db.example:5432/intafaced', {}), /does not look local or test/);
}

// The TEST business verification requirements: shaped as pay.kyb_entity_types accepts them, every key labelled test_, and
// a sole trader asked for different documents than a company (J-merchant-02 #3). `apply` publishes them.
{
  const KNOWN = [
    'private_company',
    'listed_company',
    'financial_institution',
    'fund',
    'trust',
    'non_profit',
    'government_owned',
    'family_office',
    'partnership',
    'sole_proprietorship',
  ];
  for (const t of TEST_KYB_ENTITY_TYPES) {
    assert.ok(KNOWN.includes(t.entityType), t.entityType);
    for (const key of [...t.documentKeys, ...t.peopleRoles, ...t.questionnaireKeys]) assert.match(key, /^test_[a-z0-9_]{1,58}$/);
    assert.ok(t.countries.length >= 1 && t.countries.every((c) => /^[A-Z]{2}$/.test(c)));
    // The journeys open their businesses in DE (merchant.mjs openBusiness).
    assert.ok(t.countries.includes('DE'));
  }
  const docs = (name) => TEST_KYB_ENTITY_TYPES.find((t) => t.entityType === name).documentKeys;
  assert.notDeepEqual(docs('private_company'), docs('sole_proprietorship'));
  assert.ok(TEST_KYB_UPLOAD_RULES.maxBytes >= 1 && TEST_KYB_UPLOAD_RULES.contentTypes.length >= 1);
  const gatesSrc = readFileSync(script, 'utf8');
  assert.match(gatesSrc, /await seedSpotTestListings\(ctx\);\n\s*await seedPayKybRequirements\(ctx\);/);
}

// Tier planning: nobody with an approved full or institutional record is touched.
const users = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }, { id: 'u4' }];
const approved = new Map([
  ['u1', new Set(['full'])],
  ['u2', new Set(['basic'])],
  ['u3', new Set(['institutional'])],
]);
assert.deepEqual(
  needsFullTier(users, approved).map((u) => u.id),
  ['u2', 'u4'],
);

// refusalText reports the service's own words.
assert.equal(refusalText({ json: { error: { message: 'nope', data: { code: 'FORBIDDEN' } } }, text: '' }), 'nope [FORBIDDEN]');
assert.equal(refusalText({ json: null, text: 'plain' }), 'plain');

// Founder sign-ins: none until both founders are enrolled, then a and b in vault order, keyed like their TOTP steps.
{
  const vault = draftFounderVault();
  assert.deepEqual(founderSignIns(null), []);
  assert.deepEqual(founderSignIns(vault), []);
  vault.founders.forEach((f, i) => Object.assign(f, { userId: `user-${i}`, totpSecret: `SECRET${i}`, totpConfirmed: true }));
  const pair = founderSignIns(vault);
  assert.deepEqual(
    pair.map((f) => [f.key, f.handle, f.totpSecret]),
    [
      ['a', 'local_test_founder_a', 'SECRET0'],
      ['b', 'local_test_founder_b', 'SECRET1'],
    ],
  );
  assert.ok(pair.every((f) => f.email && f.password));
  vault.founders[1].totpConfirmed = false;
  assert.deepEqual(founderSignIns(vault), [], 'a founder without a confirmed second factor cannot sign in');
}
// verify submits founders' requests; populate (which approves only its friend) does not.
{
  const src = readFileSync(script, 'utf8');
  assert.match(src, /submitOwnedAccounts\(ctx, before, \{ founders: true \}\)/);
  const world = readFileSync(resolve(here, 'local-test-world.mjs'), 'utf8');
  assert.match(world, /gates\.submitOwnedAccounts\(gctx, before\);/);
}

// The CLI help names every command.
const src = readFileSync(script, 'utf8');
for (const cmd of ['apply', 'operators', 'lifecycle', 'open', 'verify', 'status']) assert.ok(src.includes(`'${cmd}'`), cmd);
// Nothing in the gates module writes a table directly.
assert.equal(
  /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
  false,
  'gates must not write database rows',
);

// Charts owner values (C-ops-04): the LOCAL TEST values are the documented ones, IFC/USDT is never given one, and the
// data class approval hashes exactly as svc-trade recomputes it (the same golden vector as its router test).
assert.deepEqual(TEST_CHART_COUNTS, {
  compareCap: 3,
  chartCountLimit: 4,
  drawingCap: 50,
  brushPointCap: 2000,
  delayedBoundarySeconds: 30,
  renderBudgetMs: 500,
});
assert.deepEqual(TEST_CHART_DATA_CLASSES, { 'BTC/USDT': 'real_time', 'ETH/USDT': 'real_time' });
assert.equal(Object.keys(TEST_CHART_DATA_CLASSES).includes('IFC/USDT'), false, 'IFC/USDT stays unset on purpose');
assert.equal(
  chartDataClassPayloadHash({ symbol: 'BTC/USDT', dataClass: 'real_time', expectedVersion: '0', reason: 'list BTC for the charts pilot' }),
  'sha256:d51ed1f6e5d8fc7ea6c05ea66c3ebd4f92df8647963ae67d3b53710de74a6e67',
);
const proposal = chartDataClassProposal({ symbol: 'ETH/USDT', dataClass: null, expectedVersion: '2', reason: 'TEST: clear it' });
assert.equal(proposal.actionType, CHART_DATA_CLASS_ACTION);
assert.equal(proposal.actionType, 'trade.chart_data_class_set');
assert.equal(proposal.targetService, 'svc-trade');
assert.equal(proposal.targetId, 'ETH/USDT');
assert.equal(proposal.expectedVersion, '2');
assert.equal(proposal.policyVersion, 'trade-chart-data-class-v1', 'the same policy version the founder page proposes');
assert.match(proposal.payloadHash, /^sha256:[0-9a-f]{64}$/);

// TOTP steps: never a step identity already consumed (it refuses any step at or before the last one), never one before
// the current step, and the step after the current one only because identity accepts one step of clock skew. Pinned to
// identity's own window, so a narrower window there fails here instead of in every journeys shard.
assert.equal(nextTotpStep(0, 100), 100, 'a fresh operator signs in with the current step');
assert.equal(nextTotpStep(90, 100), 100, 'an old last step gives the current one, not the one after it');
assert.equal(nextTotpStep(99, 100), 100);
assert.equal(nextTotpStep(100, 100), 101, 'the current step spent: the next one, inside the skew window, without waiting');
assert.equal(nextTotpStep(101, 100), null, 'both spent: wait for the clock');
assert.equal(nextTotpStep(105, 100), null);
assert.equal(nextTotpStep(undefined, 100), 100);
assert.equal(nextTotpStep('not a step', 100), 100, 'an unreadable last step never waits forever');
for (let last = 95; last <= 102; last += 1) {
  const step = nextTotpStep(last, 100);
  if (step !== null) assert.ok(step > last && step >= 100 && step <= 100 + TOTP_SKEW_STEPS, `last ${last} gave ${step}`);
}
const identityTotp = readFileSync(resolve(here, '../../services/svc-identity/src/auth/totp.ts'), 'utf8');
assert.match(identityTotp, /const window = options\.window \?\? (\d+);/, 'identity still names its default skew window');
assert.equal(
  Number(/const window = options\.window \?\? (\d+);/.exec(identityTotp)[1]) >= TOTP_SKEW_STEPS,
  true,
  "the gates look ahead no further than identity's skew window",
);
// `apply` waits out Edge's authority cache after verify, so svc-p2p reads the founders' new tier: pinned to Edge's cap.
const edgeAuthority = readFileSync(resolve(here, '../../services/svc-edge/src/live-authority.ts'), 'utf8');
assert.equal(
  Number(/export const AUTHORITY_POSITIVE_CACHE_MAX_MS = (\d+);/.exec(edgeAuthority)?.[1]),
  EDGE_AUTHORITY_CACHE_MAX_MS,
  "the gates wait exactly as long as Edge's authority cache can hold a session's tier",
);

// The platform posting freeze. svc-ledger's `ledgerActionPayloadHash` is TypeScript that imports
// @intafaced/contracts, so this plain-node test cannot import it without a build; the pins below check only the
// parts that decide whether an approval is consumable (the hash recipe, the action types and targets, the freeze
// reason as the one hashed field, the version binding, the founder audience), not the surrounding text.
const ledgerConsume = readFileSync(resolve(here, '../../services/svc-ledger/src/ledger/action-approval-consume.ts'), 'utf8');
assert.ok(ledgerConsume.includes('JSON.stringify({ actionType, ...fields })'), 'ledger hash recipe changed');
assert.ok(ledgerConsume.includes("`sha256:${createHash('sha256')"), 'ledger hash prefix changed');
const ledgerOperator = readFileSync(resolve(here, '../../services/svc-ledger/src/operator-http.ts'), 'utf8').replace(/\s+/g, ' ');
assert.ok(
  ledgerOperator.includes("'ledger.freeze', 'posting_freeze', prior.changedAtPrecise, { reason: parsed.reason, }"),
  'freeze consume changed',
);
assert.ok(ledgerOperator.includes("'ledger.unfreeze', 'posting_unfreeze', prior.changedAtPrecise, {}"), 'unfreeze consume changed');
const audience = readFileSync(resolve(here, '../../services/svc-identity/src/auth/action-approval-audience.ts'), 'utf8');
const founderLevel = /FOUNDER_LEVEL_ACTION_TYPES[^=]*=\s*\[([^\]]*)\]/.exec(audience)?.[1] ?? '';
assert.ok(founderLevel.includes("'ledger.freeze'") && founderLevel.includes("'ledger.unfreeze'"), 'the freeze verbs are founder-level');
// The same hash svc-ledger computes, by behaviour: sha256 over { actionType, ...fields } in that order.
const version = '2026-10-29 05:00:00.123456+00';
const on = postingFreezeProposal(true, version);
assert.deepEqual(
  [on.actionType, on.targetService, on.targetId, on.expectedVersion, on.policyVersion],
  ['ledger.freeze', 'svc-ledger', 'posting_freeze', version, 'local-test:v1'],
);
assert.equal(on.payloadHash, sha({ actionType: 'ledger.freeze', reason: POSTING_FREEZE_REASON.trim() }));
const off = postingFreezeProposal(false, version);
assert.deepEqual([off.actionType, off.targetId, off.expectedVersion], ['ledger.unfreeze', 'posting_unfreeze', version]);
assert.equal(off.payloadHash, sha({ actionType: 'ledger.unfreeze' }));
assert.throws(() => postingFreezeProposal(true, undefined), /freeze version/);
assert.throws(() => postingFreezeProposal(false, ''), /freeze version/);
// svc-ledger wants a reason of 12 to 500 characters after trimming; the freeze carries the LOCAL TEST label.
assert.ok(POSTING_FREEZE_REASON.trim().length >= 12 && POSTING_FREEZE_REASON.length <= 500);
assert.ok(POSTING_FREEZE_REASON.startsWith(MARKERS.label));
// Planning, from the record founder A reads, before anyone else signs in.
const ours = { frozen: true, reason: POSTING_FREEZE_REASON, actor: 'f-a', version };
const open0 = { frozen: false, reason: null, actor: null, version };
assert.deepEqual(postingFreezePlan(open0, false), { action: 'skip' });
assert.deepEqual(postingFreezePlan(ours, true), { action: 'skip' });
assert.deepEqual(postingFreezePlan(open0, true), { action: 'run' });
assert.deepEqual(postingFreezePlan(ours, false), { action: 'run' });
// A freeze this tool did not set is refused both ways: `off` never lifts it, `on` never reports it as its own.
const foreignState = { frozen: true, reason: 'reconciliation mismatch on USDT', actor: 'reconciliation', version };
for (const want of [true, false]) {
  const plan = postingFreezePlan(foreignState, want);
  assert.equal(plan.action, 'refuse', `foreign freeze, ${want ? 'on' : 'off'}`);
  assert.match(plan.why, /reconciliation mismatch on USDT.*reconciliation/);
}
// No state, or a change with no version to bind the approval to, refuses before any second sign-in.
assert.equal(postingFreezePlan(null, true).action, 'refuse');
assert.equal(postingFreezePlan({ reason: null }, true).action, 'refuse');
assert.match(postingFreezePlan({ ...open0, version: undefined }, true).why, /version/);
assert.match(postingFreezePlan({ ...ours, version: '' }, false).why, /version/);
assert.deepEqual(postingFreezePlan({ ...open0, version: undefined }, false), { action: 'skip' });
// Usage is checked before the stack is: a bad or missing on|off exits 2 without reading any marker.
for (const args of [['posting-freeze'], ['posting-freeze', 'maybe']]) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: tmpdir() }, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /usage: local-test-gates\.mjs posting-freeze on\|off/);
  assert.doesNotMatch(r.stderr, /refusing/);
}
// scoped-session: the founder scopes come from the stack's own identity definition, never a copy, and less one only.
{
  const identityDef = readFileSync(resolve(here, 'local-stack-services/identity.mjs'), 'utf8');
  const literal = /IDENTITY_FOUNDER_SESSION_SCOPES: '([^']+)'/.exec(identityDef)?.[1];
  assert.ok(literal, 'identity.mjs still names the founder session scopes as one literal');
  const scopes = await stackFounderScopes(mkdtempSync(join(tmpdir(), 'scoped-')));
  assert.deepEqual(scopes, literal.split(','), "the founder scopes are identity's own list");
  assert.deepEqual(scopesWithout(['a:x', 'b:y', 'c:z'], 'b:y'), ['a:x', 'c:z']);
  assert.throws(
    () => scopesWithout(['a:x', 'b:y'], 'b:yy'),
    /b:yy is not a founder session scope/,
    'a misspelt scope never passes as left out',
  );
}
// The sealed cookie opens only as the console opens it: same key, same cookie name and origin in the AAD.
{
  const key = Buffer.alloc(32, 7);
  const secret = key.toString('base64url');
  const session = { userId: 'u', accessToken: 't', refreshToken: 'r', expiresAt: 'e', issuedAt: 'i', csrf: 'c' };
  const open = (value, origin) => {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(Buffer.from(`${ADMIN_SESSION_COOKIE}\n${origin}\nv1`));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  };
  const sealed = sealConsoleSession(session, { secret, origin: 'http://127.0.0.1:3100' });
  assert.deepEqual(open(sealed, 'http://127.0.0.1:3100'), session);
  assert.throws(() => open(sealed, 'http://127.0.0.1:3101'), 'a cookie sealed for one origin never opens on another');
  assert.throws(() => sealConsoleSession(session, { secret: 'short', origin: 'x' }), /32-byte/);
  const consoleSession = readFileSync(resolve(here, '../../apps/admin/src/lib/founder-session.ts'), 'utf8');
  assert.ok(consoleSession.includes(`export const ADMIN_COOKIE = '${ADMIN_SESSION_COOKIE}';`), "the console's cookie name");
  assert.ok(consoleSession.includes("createCipheriv('aes-256-gcm', config.key, iv)"), "the console's cipher");
  assert.ok(consoleSession.includes('cipher.setAAD(Buffer.from(`${ADMIN_COOKIE}\\n${config.origin}\\nv1`));'), "the console's AAD");
  assert.ok(
    consoleSession.includes("'accessToken,csrf,expiresAt,issuedAt,refreshToken,userId'"),
    "the console's session keys are the ones scoped-session seals",
  );
}

console.log('local-test-gates: marker, builder, hash and planning checks passed');
