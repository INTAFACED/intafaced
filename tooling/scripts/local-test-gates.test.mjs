// Proves, without starting or touching anything: the option-B stand-ins refuse outside the local test
// stack, every record they build carries the `local-test:` marker and the LOCAL TEST label, and the
// hashes match what the services compute. Run: node tooling/scripts/local-test-gates.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  needsFullTier,
  openProposal,
  openableMarkets,
  operatorIdentity,
  refusalText,
} from './local-test-gates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'local-test-gates.mjs');
const run = (home, args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

const home = mkdtempSync(join(tmpdir(), 'local-test-gates-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
const ports = { edge: 14500, ledger: 14501, identity: 14502, trade: 14504, matching: 14505, customer: 3210 };
const marker = (extra = {}) => JSON.stringify({ kind: 'intafaced-local-test-stack', ports, ...extra });
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof GuardError && re.test(e.message));
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
  for (const cmd of ['apply', 'operators', 'lifecycle', 'open', 'verify', 'status']) {
    const r = run(nothing, [cmd]);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /refusing: state directory .* not found/);
  }
  rmSync(nothing, { recursive: true, force: true });
} finally {
  rmSync(home, { recursive: true, force: true });
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

// The CLI help names every command.
const src = readFileSync(script, 'utf8');
for (const cmd of ['apply', 'operators', 'lifecycle', 'open', 'verify', 'status']) assert.ok(src.includes(`'${cmd}'`), cmd);
// Nothing in the gates module writes a table directly.
assert.equal(
  /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
  false,
  'gates must not write database rows',
);

console.log('local-test-gates: marker, builder, hash and planning checks passed');
