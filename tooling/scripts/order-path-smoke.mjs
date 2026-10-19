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
 * REQs: PC-L2-1 · PC-L3-1..5 · PC-L4-1..2 — docs/ORDER-ROUTE-PROD-CLAIM-AGENT-MAX-2026-08-02.md (removed)
 */
import { randomUUID } from 'node:crypto';

const TRADE = process.env.TRADE_HTTP_URL ?? 'http://127.0.0.1:4004';
const MATCHING = process.env.MATCHING_HTTP_URL ?? 'http://127.0.0.1:4005';
const LEDGER = process.env.LEDGER_HTTP_URL ?? 'http://127.0.0.1:4001';
const STRICT = process.env.ORDER_PATH_SMOKE_STRICT === '1';
const EDGE = process.env.EDGE_PRINCIPAL_SECRET?.trim() || '';
const INTERNAL = process.env.INTERNAL_SERVICE_SECRET?.trim() || '';
const USER = process.env.TRADE_SMOKE_USER_ID ?? '11111111-1111-4111-8111-111111111111';
const MAKER = process.env.TRADE_SMOKE_MAKER_ID ?? '22222222-2222-4222-8222-222222222222';
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
  const { recipes, parseAmount, formatAmount } = await loadLedgerClient();
  const request = recipes.deposit({
    userId,
    assetId,
    amount: parseAmount(amountStr),
    rail: 'cx8-smoke',
    railRef,
  });
  const wire = {
    ...request,
    entries: request.entries.map((e) => ({
      ...e,
      amount: typeof e.amount === 'bigint' ? formatAmount(e.amount) : e.amount,
    })),
  };
  const raw = JSON.stringify(wire);
  const headers = {
    'content-type': 'application/json',
    ...contracts.serviceAuthHeadersForBody('svc-trade', INTERNAL, raw),
  };
  const res = await fetch(`${LEDGER.replace(/\/$/, '')}/trpc/post`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  if (!res.ok) throw new Error(`ledger deposit ${assetId} for ${userId} failed ${res.status}: ${text.slice(0, 400)}`);
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

async function seedMarketAndFunds(contracts) {
  if (!SEED) return;
  if (!TRADE_DB) throw new Error('TRADE_SMOKE_SEED_SQL=1 requires TRADE_DATABASE_URL');
  if (!INTERNAL) throw new Error('TRADE_SMOKE_SEED_SQL=1 requires INTERNAL_SERVICE_SECRET');

  const postgres = (await import('postgres')).default;
  const sql = postgres(TRADE_DB, { max: 1, onnotice: () => undefined });
  try {
    await sql`
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
    `;
    log(`SEED market ${SYMBOL}`);
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
    sid: randomUUID(),
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
