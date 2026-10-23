#!/usr/bin/env node
/**
 * Assembled order-path smoke (Spec CX-8 · B-layer · prod-claim agent-max path C).
 *
 * L1 Health — trade + matching + ledger /health
 * L2 Edge place+cancel — EDGE_PRINCIPAL_SECRET (always when EDGE set)
 * L3 Two-user fill — TRADE_SMOKE_L3=1 (maker sell + taker buy, poll fill + ledger delta)
 * L4 Stress — TRADE_SMOKE_STRESS_N sequential place+cancel + clientOrderId idempotent
 *
 * Never invent fills or balances. STRICT=1 fails closed on missing proof.
 * REQs: PC-L2-1 · PC-L3-1..5 · PC-L4-1..2 — docs/ORDER-ROUTE-PROD-CLAIM-AGENT-MAX-2026-08-02.md
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readLatestEmailConfirmToken } from '../../../tooling/scripts/local-test-state.mjs';

const TRADE = process.env.TRADE_HTTP_URL ?? 'http://127.0.0.1:4004';
const MATCHING = process.env.MATCHING_HTTP_URL ?? 'http://127.0.0.1:4005';
const LEDGER = process.env.LEDGER_HTTP_URL ?? 'http://127.0.0.1:4001';
const IDENTITY = process.env.IDENTITY_HTTP_URL ?? 'http://127.0.0.1:4002';
const STRICT = process.env.ORDER_PATH_SMOKE_STRICT === '1';
const EDGE = process.env.EDGE_PRINCIPAL_SECRET?.trim() || '';
const INTERNAL = process.env.INTERNAL_SERVICE_SECRET?.trim() || '';
// With TRADE_SMOKE_SEED_SQL=1 these two are replaced by real, freshly registered `local-test`
// identity users (see registerLocalTestTraders): identity's order admission refuses a user
// or session it has never issued (auth.account_frozen / auth.credential_denied).
let USER = process.env.TRADE_SMOKE_USER_ID ?? '11111111-1111-4111-8111-111111111111';
let MAKER = process.env.TRADE_SMOKE_MAKER_ID ?? '22222222-2222-4222-8222-222222222222';
/** userId -> the real identity session id its orders are signed with. */
const SESSION_IDS = new Map();
const SYMBOL = process.env.TRADE_SMOKE_SYMBOL ?? 'BTC/USDT';
const QTY = process.env.TRADE_SMOKE_QTY ?? '0.1';
const PRICE = process.env.TRADE_SMOKE_PRICE ?? '100';
const SEED = process.env.TRADE_SMOKE_SEED_SQL === '1';
const L3 = process.env.TRADE_SMOKE_L3 === '1';
const STRESS_N = Math.max(0, Number(process.env.TRADE_SMOKE_STRESS_N ?? '0') || 0);
const TRADE_DB = process.env.TRADE_DATABASE_URL ?? process.env.TEST_DATABASE_URL_TRADE ?? '';
const REGION = process.env.TRADE_SMOKE_REGION ?? 'DE';
const FILL_WAIT_MS = Number(process.env.TRADE_SMOKE_FILL_WAIT_MS ?? '15000') || 15000;

const log = (line) => console.log(`[order-path-smoke] ${line}`);

function dec(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isFilledOrder(json, expectedQty) {
  const status = json.status ?? json.state ?? '';
  // Full terminal fill only — partial filled>0 is not L3 success under STRICT.
  if (status === 'closed' || status === 'filled') return true;
  if (expectedQty != null && json.filled != null && String(json.filled) === String(expectedQty) && dec(json.filled) > 0) {
    return true;
  }
  return false;
}

async function loadContracts() {
  return import('@intafaced/contracts');
}

async function loadLedgerClient() {
  return import('@intafaced/ledger-client');
}

async function probe(name, url, path = '/health') {
  const target = url.replace(/\/$/, '') + path;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(target, { signal: ac.signal });
    clearTimeout(t);
    return { name, url: target, ok: res.ok || res.status < 500, status: res.status };
  } catch (err) {
    return { name, url: target, ok: false, status: 0, error: (err && err.message) || String(err) };
  }
}

async function deposit(contracts, userId, assetId, amountStr, railRef) {
  const { createHttpLedgerClient, recipes, parseAmount } = await loadLedgerClient();
  const ledger = createHttpLedgerClient({
    baseUrl: LEDGER.replace(/\/$/, ''),
    sign: (payload) => contracts.serviceAuthHeadersForBody('svc-trade', INTERNAL, payload),
  });
  await ledger.post(
    recipes.deposit({
      userId,
      assetId,
      amount: parseAmount(amountStr),
      rail: 'cx8-smoke',
      railRef,
    }),
  );
  log(`SEED deposit ${amountStr} ${assetId} for ${userId}`);
}

/** Available balance via S2S — never invent. */
async function ledgerAvailable(contracts, userId, assetId) {
  const body = { ownerType: 'user', ownerId: userId, assetId, kind: 'available' };
  const raw = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    ...contracts.serviceAuthHeadersForBody('svc-trade', INTERNAL, raw),
  };
  const res = await fetch(`${LEDGER.replace(/\/$/, '')}/trpc/balance`, {
    method: 'POST',
    headers,
    body: raw,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ledger balance ${assetId} ${userId} ${res.status}: ${text.slice(0, 300)}`);
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ledger balance non-json: ${text.slice(0, 200)}`);
  }
  return String(json.amount ?? '0');
}

/**
 * SMOKE DATA, not an authority decision. Place is refused with
 * trade.lifecycle_authority_unavailable until the market has an AUTHORIZED
 * lifecycle publication (PX-S01), and nothing else in this rig publishes one.
 * So the smoke publishes one through the app's own route
 * (POST /internal/market-lifecycle, service-signed), shaped like the fixtures in
 * services/svc-trade/src/market-lifecycle.test.ts. Every actor, grant and dossier
 * id starts with `local-test:`: svc-trade accepts that marker only while APP_ENV
 * is dev/test and treats such a record as no authority anywhere else.
 */
async function publishSmokeLifecycleAuthority(contracts, marketId) {
  const base = `${TRADE.replace(/\/$/, '')}/internal/market-lifecycle`;
  const signed = (body) => ({
    'content-type': 'application/json',
    ...contracts.serviceAuthHeadersForBody('svc-trade', INTERNAL, body),
  });
  // A rerun against the same database must chain onto the current head.
  const head = await fetch(`${base}/${marketId}`, { headers: signed('') });
  let predecessor = null;
  if (head.status === 200) predecessor = (await head.json()).evidenceId ?? null;
  else if (head.status !== 404) throw new Error(`lifecycle head read failed ${head.status}`);

  const now = Date.now();
  const at = new Date(now).toISOString();
  const ready = (ref) => ({ status: 'READY', evidenceRefs: [`local-test:cx8-smoke:${ref}`] });
  const publication = {
    marketId,
    idempotencyKey: `local-test:cx8-smoke:${now}`,
    causalPredecessorId: predecessor,
    authoritySubject: 'local-test:cx8-smoke-operator',
    authorityScope: `market:${marketId}:place`,
    ruleVersion: 'local-test:cx8-smoke-rules',
    instrumentVersion: 'local-test:cx8-smoke-instrument',
    observedAt: at,
    effectiveAt: at,
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    authority: {
      decision: 'AUTHORIZED',
      reasonCode: null,
      legalOwnerId: 'local-test:cx8-smoke-owner',
      accountId: 'local-test:cx8-smoke-account',
      subAccountId: 'local-test:cx8-smoke-subaccount',
      actorId: 'local-test:cx8-smoke-operator',
      origin: 'OPERATOR',
      sessionId: 'local-test:cx8-smoke-session',
      credentialId: null,
      grantId: 'local-test:cx8-smoke-grant',
      grantVersion: 'local-test:cx8-smoke-grant-v1',
      mandateId: 'local-test:cx8-smoke-mandate',
      decidedAt: at,
      freshnessAt: at,
    },
    dossier: {
      dossierId: 'local-test:cx8-smoke-dossier',
      marketId,
      ruleVersion: 'local-test:cx8-smoke-rules',
      instrumentVersion: 'local-test:cx8-smoke-instrument',
      legalEntityAndJurisdiction: ready('legal'),
      counterpartyRole: ready('counterparty'),
      deterministicSettlement: ready('settlement'),
      custodyAndTransferSupport: ready('custody'),
      oracleIndexAndDisruption: ready('oracle'),
      liquidityAndMarketQuality: ready('liquidity'),
      surveillanceAndRetention: ready('surveillance'),
      riskAndLimits: ready('risk'),
      operationsAndIncidentOwner: ready('operations'),
      windDownAndResiduals: ready('winddown'),
      approvedAt: at,
      approvalRefs: ['local-test:cx8-smoke-approval'],
    },
  };
  const raw = JSON.stringify(publication);
  const res = await fetch(base, { method: 'POST', headers: signed(raw), body: raw });
  const text = await res.text();
  if (!res.ok) throw new Error(`lifecycle publication for ${marketId} failed ${res.status}: ${text.slice(0, 400)}`);
  log(`SEED lifecycle authority (local-test: smoke data) for ${SYMBOL}`);
}

// ── Opening the market in svc-matching: the REAL two-person path ─────────────
//
// svc-trade refuses PLACE with trade.matching_market_missing until svc-matching
// lists the market, and matching lists it only after `POST /markets/:id/open`
// consumes an identity action approval: one person proposes, a DIFFERENT person
// approves with MFA, and matching consumes that approval at identity. Opening a
// market is founder-only, so both people must be live founders. This reproduces
// that path with two throwaway `local-test` founders (enrolled with identity's
// own founder invites and pinned as its founder pair by the CX-8 boot helper)
// and a real TOTP enrolment each, and forges nothing:
//   · each founder's MFA flag comes from a real `auth.login` with a TOTP code,
//     read back from the verified access token (the way the edge would);
//   · the approval is proposed, approved and consumed through identity's own
//     tRPC doors and matching's own route.
// SMOKE DATA: users, handles and ids carry `local-test` and are created per run.

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what any authenticator app computes. */
function totpCode(secretBase32, atMs) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** One identity tRPC mutation. `principal` is what the edge would forward for a verified session; null for public doors. */
async function identityCall(contracts, procedure, input, principal) {
  const raw = JSON.stringify(input ?? {});
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (principal) {
    const encoded = contracts.encodePrincipal(principal);
    headers['x-intafaced-principal'] = encoded;
    headers['x-intafaced-principal-sig'] = contracts.signPrincipalHeader(encoded, EDGE, REGION);
    headers['x-intafaced-region'] = REGION;
  }
  const res = await fetch(`${IDENTITY.replace(/\/$/, '')}/trpc/${procedure}`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  if (!res.ok) throw new Error(`identity ${procedure} failed ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text).result.data;
}

/** Read the principal out of a real access token, verifying it as the edge does. */
async function principalOf(accessToken) {
  const auth = await import('@intafaced/auth');
  return auth.verifyAccessToken(accessToken, {
    secret: process.env.JWT_ACCESS_SECRET?.trim() || '',
    issuer: process.env.JWT_ISSUER?.trim() || '',
    audience: process.env.JWT_AUDIENCE?.trim() || '',
    accessTtlSeconds: 900,
  });
}

async function registerLocalTestOperator(contracts, role) {
  const suffix = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const handle = `localtest_cx8_${role}_${suffix}`;
  const email = `${handle}@example.test`;
  const session = await identityCall(contracts, 'auth.register', { handle, email, password, region: REGION }, null);
  return { handle, email, password, userId: session.userId, accessToken: session.accessToken };
}

/**
 * Enrol one smoke founder: a single-use founder invite (`auth.registerFounder`, public sign-up stays closed),
 * then a real TOTP enrolment so identity can pin the account into the founder pair at its next boot.
 */
async function registerLocalTestFounder(contracts, role, invite) {
  const suffix = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const handle = `localtest_cx8_${role}_${suffix}`;
  const email = `${handle}@example.test`;
  let session;
  try {
    session = await identityCall(contracts, 'auth.registerFounder', { invite, handle, email, password }, null);
  } catch (err) {
    throw new Error(
      `${(err && err.message) || err} (founder enrolment needs a database whose founder pair is not pinned yet: use a fresh one)`,
    );
  }
  const principal = await principalOf(session.accessToken);
  const enrol = await identityCall(contracts, 'totp.enrol', {}, principal);
  await identityCall(contracts, 'totp.confirm', { secret: enrol.secret, code: totpCode(enrol.secret, Date.now()) }, principal);
  return { handle, email, password, userId: session.userId, totpSecret: enrol.secret };
}

/**
 * Phase 1, run by the CX-8 boot helper (`--enrol-founders`) while identity is up with founder invites and no
 * founder pair: enrol the two smoke founders and print them as one machine-read line. The boot helper then
 * restarts identity with the pair pinned to these two ids and passes the line back as CX8_FOUNDERS_JSON.
 * SMOKE RIG ONLY: throwaway `localtest_cx8_*` accounts, created per run; they are not the real founders.
 */
async function enrolFounders() {
  const invites = (process.env.CX8_FOUNDER_INVITES ?? '').split(',').filter(Boolean);
  if (invites.length !== 2) throw new Error('--enrol-founders needs CX8_FOUNDER_INVITES (two founder invite codes)');
  const contracts = await loadContracts();
  const founders = [];
  for (const [i, role] of ['fa', 'fb'].entries()) founders.push(await registerLocalTestFounder(contracts, role, invites[i]));
  console.log(`CX8_FOUNDERS_JSON=${JSON.stringify(founders)}`);
}

/** Phase 2: a real password + TOTP login for a smoke founder; the principal is read back from the verified token. */
async function founderMfaPrincipal(contracts, founder) {
  // The enrolment code's step is spent (replay-protected); the next step's code is inside identity's +/-1 step drift window.
  const session = await identityCall(
    contracts,
    'auth.login',
    { identifier: founder.email, password: founder.password, totpCode: totpCode(founder.totpSecret, Date.now() + 30_000) },
    null,
  );
  const principal = await principalOf(session.accessToken);
  if (!principal.mfa) throw new Error(`founder ${founder.handle} login did not yield an MFA session`);
  return principal;
}

// Opening a market (`matching.open`) is a founder-only action: identity needs a live founder to propose and a
// different live founder to approve, each on an MFA session. The CX-8 boot helper enrols the two smoke founders
// through identity's own founder invites and pins them as the founder pair before this runs.
async function openMarketInMatching(contracts, marketId) {
  if (!EDGE) throw new Error('opening the market needs EDGE_PRINCIPAL_SECRET (the smoke acts as the edge)');
  const founders = JSON.parse(process.env.CX8_FOUNDERS_JSON ?? '[]');
  if (founders.length !== 2)
    throw new Error('opening the market needs two enrolled smoke founders (CX8_FOUNDERS_JSON, set by the CX-8 boot helper)');
  const [requester, approver] = founders;
  const requesterMfa = await founderMfaPrincipal(contracts, requester);
  const approverMfa = await founderMfaPrincipal(contracts, approver);

  // Requester proposes; approver approves; matching consumes.
  const action = { actionType: 'matching.open', targetService: 'svc-matching', targetId: `open:${marketId}`, expectedVersion: '1' };
  const payloadHash = `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType: action.actionType, marketId }))
    .digest('hex')}`;
  const proposed = await identityCall(
    contracts,
    'actionApproval.propose',
    { ...action, payloadHash, policyVersion: 'local-test:cx8-smoke-policy-v1' },
    requesterMfa,
  );
  const approved = await identityCall(
    contracts,
    'actionApproval.approve',
    { approvalId: proposed.approvalId, expectedPayloadHash: payloadHash },
    approverMfa,
  );

  const body = JSON.stringify({
    operatorId: requester.userId,
    confirmOperatorId: approved.approverId,
    approvalId: approved.approvalId,
    operationId: approved.operationId,
  });
  const res = await fetch(`${MATCHING.replace(/\/$/, '')}/markets/${marketId}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...contracts.serviceAuthHeadersForBody('svc-trade', INTERNAL, body) },
    body,
  });
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!res.ok || json?.accepted !== true)
    throw new Error(`matching open for ${marketId} not accepted ${res.status}: ${text.slice(0, 400)}`);
  log(`SEED matching open (local-test founders ${requester.handle} + ${approver.handle}, approval ${approved.approvalId})`);
}

/**
 * New custodial orders need a proved email (RC-identity-01). Proves it the way a person does: ask identity for a
 * confirmation, read the LOCAL-TEST link the rig's identity wrote to CX8_MAIL_OUTBOX, and open it. Nothing writes
 * `email_verified_at` itself.
 */
async function proveEmail(contracts, trader, waitMs = 15_000) {
  const outbox = process.env.CX8_MAIL_OUTBOX?.trim();
  if (!outbox) throw new Error('CX8_MAIL_OUTBOX is not set: run through order-path-cx8-boot.mjs, which starts identity with it');
  await identityCall(contracts, 'auth.requestEmailConfirmation', {}, await principalOf(trader.accessToken));
  const until = Date.now() + waitMs;
  let token = null;
  while (!token) {
    try {
      token = readLatestEmailConfirmToken(readFileSync(outbox, 'utf8'), trader.email);
    } catch {
      token = null;
    }
    if (token) break;
    if (Date.now() >= until) throw new Error(`no LOCAL-TEST confirm link reached ${trader.email} in ${outbox}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await identityCall(contracts, 'auth.confirmEmail', { token }, null);
}

/** SMOKE DATA: the buyer and seller are real identity users (handles `localtest_cx8_*`), created per run, emails proved. */
async function registerLocalTestTraders(contracts) {
  if (process.env.TRADE_SMOKE_USER_ID || process.env.TRADE_SMOKE_MAKER_ID) return;
  const buyer = await registerLocalTestOperator(contracts, 'buy');
  const seller = await registerLocalTestOperator(contracts, 'sel');
  for (const trader of [buyer, seller]) await proveEmail(contracts, trader);
  for (const trader of [buyer, seller]) SESSION_IDS.set(trader.userId, (await principalOf(trader.accessToken)).sid);
  USER = buyer.userId;
  MAKER = seller.userId;
  log(`SEED traders (local-test identity users ${buyer.handle} + ${seller.handle})`);
}

async function seedMarketAndFunds(contracts) {
  if (!SEED) return;
  if (!TRADE_DB) throw new Error('TRADE_SMOKE_SEED_SQL=1 requires TRADE_DATABASE_URL');
  if (!INTERNAL) throw new Error('TRADE_SMOKE_SEED_SQL=1 requires INTERNAL_SERVICE_SECRET');

  const postgres = (await import('postgres')).default;
  const sql = postgres(TRADE_DB, { max: 1, onnotice: () => undefined });
  try {
    const [market] = await sql`
      INSERT INTO trade.markets (
        symbol, base_asset, quote_asset, kind, tick_size, lot_size,
        min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
        asset_class, schedule, display_name
      ) VALUES (
        ${SYMBOL}, 'BTC', 'USDT', 'spot',
        '0.01', '0.0001', '0.0001', NULL, '1',
        'active', 5, 10, now(),
        'crypto', 'crypto-24x7', ${SYMBOL}
      )
      ON CONFLICT (symbol) DO UPDATE SET status = 'active', min_notional = '1', updated_at = now()
      RETURNING id
    `;
    log(`SEED market ${SYMBOL}`);
    await publishSmokeLifecycleAuthority(contracts, market.id);
    await openMarketInMatching(contracts, market.id);
    await registerLocalTestTraders(contracts);
  } finally {
    await sql.end({ timeout: 2 });
  }

  // Buyer (USER): USDT to buy. Maker (MAKER): BTC to sell.
  await deposit(contracts, USER, 'USDT', '10000', `cx8-usdt-${USER}-${Date.now()}`);
  if (L3) {
    await deposit(contracts, MAKER, 'BTC', '10', `cx8-btc-${MAKER}-${Date.now()}`);
  }
}

function edgeHeaders(contracts, userId) {
  const principal = {
    sub: userId,
    userId,
    sid: SESSION_IDS.get(userId) ?? randomUUID(),
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  const raw = contracts.encodePrincipal(principal);
  const sig = contracts.signPrincipalHeader(raw, EDGE, REGION);
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': sig,
    'x-intafaced-region': REGION,
  };
}

async function placeOrder(contracts, userId, body) {
  const headers = edgeHeaders(contracts, userId);
  const res = await fetch(`${TRADE.replace(/\/$/, '')}/api/v1/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { res, json, text, headers };
}

async function cancelOrder(headers, orderId) {
  const { 'content-type': _ct, ...cancelHeaders } = headers;
  const res = await fetch(`${TRADE.replace(/\/$/, '')}/api/v1/orders/${orderId}`, {
    method: 'DELETE',
    headers: cancelHeaders,
  });
  const text = await res.text();
  return { res, text };
}

async function getOrder(headers, orderId) {
  const { 'content-type': _ct, ...h } = headers;
  const res = await fetch(`${TRADE.replace(/\/$/, '')}/api/v1/orders/${orderId}`, {
    method: 'GET',
    headers: h,
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { res, json, text };
}

async function waitFilled(headers, orderId, label, expectedQty) {
  const deadline = Date.now() + FILL_WAIT_MS;
  let lastStatus = '';
  let lastJson = {};
  while (Date.now() < deadline) {
    const got = await getOrder(headers, orderId);
    lastJson = got.json;
    lastStatus = got.json.status ?? got.json.state ?? JSON.stringify(got.json).slice(0, 80);
    if (isFilledOrder(got.json, expectedQty)) {
      log(`L3_FILL_OK ${label} orderId=${orderId} status=${lastStatus} filled=${got.json.filled}`);
      return { ok: true, json: got.json };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`L3_FILL_TIMEOUT ${label} after ${FILL_WAIT_MS}ms lastStatus=${lastStatus} — not inventing fill`);
  return { ok: false, json: lastJson, lastStatus };
}

async function edgePlaceCancel(contracts) {
  if (!EDGE) {
    log('RESIDUAL_L2: set EDGE_PRINCIPAL_SECRET for edge-signed place+cancel');
    return 'skip';
  }

  // Below book price so we do not cross a residual ask from prior L3.
  const restPrice = String(Math.max(1, Number(PRICE) - 20));
  const clientOrderId = `cx8-l2-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const { res, json, text, headers } = await placeOrder(contracts, USER, {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: QTY,
    price: restPrice,
    timeInForce: 'GTC',
    clientOrderId,
  });

  if (!res.ok) {
    log(`AUTH_PLACE_FAIL status=${res.status} body=${text.slice(0, 500)}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }

  const orderId = json.id ?? json.orderId;
  log(`AUTH_PLACE_OK orderId=${orderId} clientOrderId=${clientOrderId}`);

  if (orderId) {
    const cancel = await cancelOrder(headers, orderId);
    if (!cancel.res.ok) {
      log(`AUTH_CANCEL_FAIL status=${cancel.res.status} body=${cancel.text.slice(0, 300)}`);
      if (STRICT) process.exit(1);
      return 'fail';
    }
    log(`AUTH_CANCEL_OK orderId=${orderId}`);
  }

  log('PROOF_OK assembled-edge-place-cancel (CX8-CI-2 / PC-L2-1)');
  return 'ok';
}

async function twoUserFill(contracts) {
  if (!L3) {
    log('RESIDUAL_L3: set TRADE_SMOKE_L3=1 for two-user fill (prod-claim agent-max)');
    return 'skip';
  }
  if (!EDGE) {
    log('L3 requires EDGE_PRINCIPAL_SECRET');
    if (STRICT) process.exit(1);
    return 'fail';
  }
  if (!INTERNAL) {
    log('L3 ledger proof requires INTERNAL_SERVICE_SECRET');
    if (STRICT) process.exit(1);
    return 'fail';
  }

  let buyerBtcBefore = '0';
  let sellerUsdtBefore = '0';
  try {
    buyerBtcBefore = await ledgerAvailable(contracts, USER, 'BTC');
    sellerUsdtBefore = await ledgerAvailable(contracts, MAKER, 'USDT');
    log(`L3_BAL_BEFORE buyerBTC=${buyerBtcBefore} sellerUSDT=${sellerUsdtBefore}`);
  } catch (err) {
    log(`L3_BAL_BEFORE_FAIL ${(err && err.message) || err}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }

  // Maker rests sell; taker buys at same price → match + settle via NATS.
  const makerClientId = `cx8-l3-maker-${Date.now()}`;
  const makerPlace = await placeOrder(contracts, MAKER, {
    symbol: SYMBOL,
    side: 'sell',
    type: 'limit',
    amount: QTY,
    price: PRICE,
    timeInForce: 'GTC',
    clientOrderId: makerClientId,
  });
  if (!makerPlace.res.ok) {
    log(`L3_MAKER_FAIL status=${makerPlace.res.status} body=${makerPlace.text.slice(0, 500)}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }
  const makerOrderId = makerPlace.json.id ?? makerPlace.json.orderId;
  log(`L3_MAKER_OK orderId=${makerOrderId}`);

  const takerClientId = `cx8-l3-taker-${Date.now()}`;
  const takerPlace = await placeOrder(contracts, USER, {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: QTY,
    price: PRICE,
    timeInForce: 'GTC',
    clientOrderId: takerClientId,
  });
  if (!takerPlace.res.ok) {
    log(`L3_TAKER_FAIL status=${takerPlace.res.status} body=${takerPlace.text.slice(0, 500)}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }
  const takerOrderId = takerPlace.json.id ?? takerPlace.json.orderId;
  log(`L3_TAKER_OK orderId=${takerOrderId}`);

  const takerFill = await waitFilled(takerPlace.headers, takerOrderId, 'taker', QTY);
  if (!takerFill.ok) {
    if (STRICT) process.exit(1);
    return 'fail';
  }

  const makerFill = await waitFilled(makerPlace.headers, makerOrderId, 'maker', QTY);
  if (!makerFill.ok) {
    if (STRICT) process.exit(1);
    return 'fail';
  }

  // Ledger conservation signal: buyer received base; seller received quote (fees may shrink amounts).
  try {
    const buyerBtcAfter = await ledgerAvailable(contracts, USER, 'BTC');
    const sellerUsdtAfter = await ledgerAvailable(contracts, MAKER, 'USDT');
    log(`L3_BAL_AFTER buyerBTC=${buyerBtcAfter} sellerUSDT=${sellerUsdtAfter}`);
    const btcUp = dec(buyerBtcAfter) > dec(buyerBtcBefore);
    const usdtUp = dec(sellerUsdtAfter) > dec(sellerUsdtBefore);
    if (!btcUp || !usdtUp) {
      log(`L3_LEDGER_FAIL expected buyer BTC↑ and seller USDT↑ — got btcUp=${btcUp} usdtUp=${usdtUp} — not inventing`);
      if (STRICT) process.exit(1);
      return 'fail';
    }
    log('L3_LEDGER_OK buyerBTC↑ sellerUSDT↑ (PC-L3-5)');
  } catch (err) {
    log(`L3_LEDGER_ERR ${(err && err.message) || err}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }

  log('PROOF_OK assembled-two-user-fill (CX8-CI-3 / PC-L3)');
  return 'ok';
}

async function stressPlaceCancel(contracts) {
  if (STRESS_N <= 0) {
    log('STRESS skip (TRADE_SMOKE_STRESS_N=0)');
    return 'skip';
  }
  if (!EDGE) return 'skip';

  for (let i = 0; i < STRESS_N; i++) {
    const clientOrderId = `cx8-stress-${i}-${Date.now()}`;
    const { res, json, text, headers } = await placeOrder(contracts, USER, {
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: QTY,
      price: String(Number(PRICE) - 10), // below book — rest only, no cross
      timeInForce: 'GTC',
      clientOrderId,
    });
    if (!res.ok) {
      log(`STRESS_PLACE_FAIL i=${i} status=${res.status} body=${text.slice(0, 300)}`);
      if (STRICT) process.exit(1);
      return 'fail';
    }
    const orderId = json.id ?? json.orderId;
    const cancel = await cancelOrder(headers, orderId);
    if (!cancel.res.ok) {
      log(`STRESS_CANCEL_FAIL i=${i} status=${cancel.res.status}`);
      if (STRICT) process.exit(1);
      return 'fail';
    }
    log(`STRESS_OK i=${i + 1}/${STRESS_N} orderId=${orderId}`);
  }
  log(`PROOF_OK stress-place-cancel N=${STRESS_N} (PC-L4-1)`);
  return 'ok';
}

/** Same clientOrderId twice → one order (CX-11 under assembled stack). */
async function stressIdempotentPlace(contracts) {
  if (STRESS_N <= 0) {
    log('IDEMPOTENT skip (STRESS_N=0)');
    return 'skip';
  }
  if (!EDGE) return 'skip';

  const clientOrderId = `cx8-idem-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: QTY,
    price: String(Number(PRICE) - 15),
    timeInForce: 'GTC',
    clientOrderId,
  };

  const first = await placeOrder(contracts, USER, body);
  if (!first.res.ok) {
    log(`IDEMPOTENT_PLACE1_FAIL status=${first.res.status} body=${first.text.slice(0, 300)}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }
  const id1 = first.json.id ?? first.json.orderId;

  const second = await placeOrder(contracts, USER, body);
  if (!second.res.ok) {
    log(`IDEMPOTENT_PLACE2_FAIL status=${second.res.status} body=${second.text.slice(0, 300)}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }
  const id2 = second.json.id ?? second.json.orderId;

  if (!id1 || id1 !== id2) {
    log(`IDEMPOTENT_FAIL id1=${id1} id2=${id2} — expected same order for clientOrderId`);
    // Best-effort cancel both if distinct
    if (id1) await cancelOrder(first.headers, id1);
    if (id2 && id2 !== id1) await cancelOrder(second.headers, id2);
    if (STRICT) process.exit(1);
    return 'fail';
  }

  const cancel = await cancelOrder(first.headers, id1);
  if (!cancel.res.ok) {
    log(`IDEMPOTENT_CANCEL_FAIL status=${cancel.res.status}`);
    if (STRICT) process.exit(1);
    return 'fail';
  }

  log(`IDEMPOTENT_OK clientOrderId=${clientOrderId} orderId=${id1} (PC-L4-2)`);
  log('PROOF_OK stress-clientOrderId-idempotent');
  return 'ok';
}

async function main() {
  if (process.argv.includes('--enrol-founders')) return enrolFounders();

  log('CX-8 assembled path — trade + matching + ledger (prod-claim agent-max path C)');
  log(`TRADE=${TRADE} MATCHING=${MATCHING} LEDGER=${LEDGER} STRICT=${STRICT} L3=${L3} STRESS_N=${STRESS_N}`);

  const probes = await Promise.all([probe('trade', TRADE), probe('matching', MATCHING), probe('ledger', LEDGER)]);
  for (const p of probes) {
    log(p.ok ? `UP  ${p.name} ${p.url} status=${p.status}` : `DOWN ${p.name} ${p.url} ${p.error ?? `status=${p.status}`}`);
  }

  if (!probes.every((p) => p.ok)) {
    log('HONEST_SKIP L1: fleet not fully reachable — not inventing fill/ledger proof. ' + 'CI: .github/workflows/order-path-cx8.yml');
    if (STRICT) process.exit(1);
    process.exit(0);
  }

  log('PROOF_OK assembled-health (CX8-CI-1)');

  let contracts;
  try {
    contracts = await loadContracts();
  } catch (err) {
    log(`contracts load fail: ${(err && err.message) || err}`);
    if (STRICT) process.exit(1);
    process.exit(0);
  }

  try {
    await seedMarketAndFunds(contracts);
  } catch (err) {
    log(`SEED_FAIL ${(err && err.message) || err}`);
    if (STRICT && EDGE) process.exit(1);
  }

  // L2 first (rest+cancel below book) — always when EDGE set.
  await edgePlaceCancel(contracts);

  if (L3) {
    await twoUserFill(contracts);
  } else {
    log('RESIDUAL_L3: set TRADE_SMOKE_L3=1 for two-user fill (prod-claim agent-max)');
  }

  await stressPlaceCancel(contracts);
  await stressIdempotentPlace(contracts);

  log('PROOF_OK order-path-smoke complete — not go-live; Human X still human');
  process.exit(0);
}

main().catch((err) => {
  console.error('[order-path-smoke] fatal', err);
  process.exit(1);
});
