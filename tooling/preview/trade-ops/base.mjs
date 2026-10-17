/**
 * TEST edge for the trade operator desk preview. In-memory, local only, never deployed.
 *
 * What is real and what is TEST:
 *   · market list and market lifecycle pass through to the local test stack on :3210 (real local data);
 *   · founder sign-in, kill-switch state, operator order list, restrictions and approvals are TEST fixtures here,
 *     because a real founder session cannot be minted without creating founder authority (see TROPS.md).
 * Every answer a real service would refuse (missing route, unwired authority) is answered with the same typed
 * refusal the real edge gives, never a made-up success.
 */
import { createHash, randomUUID } from 'node:crypto';

export const NITRO = '00000000-0000-4000-8000-000000000001';
export const PHANTOM = '00000000-0000-4000-8000-000000000002';
const UPSTREAM = process.env.TROPS_UPSTREAM ?? 'http://127.0.0.1:3210';

export async function upstream(path) {
  try {
    const res = await fetch(`${UPSTREAM}${path}`, { signal: AbortSignal.timeout(4000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 503, body: { code: 'upstream_unreachable', message: 'The local test stack on :3210 did not answer.' } };
  }
}

const FALLBACK_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

export async function createState() {
  const m = await upstream(`/api/trade/trpc/markets.list?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
  const rows = m.status === 200 ? (m.body?.result?.data?.json ?? m.body?.result?.data ?? []) : [];
  const symbols = rows.length ? rows.map((r) => r.symbol) : FALLBACK_SYMBOLS;
  const now = Date.now();
  const testUsers = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`);
  const orders = [];
  const seedRand = (n) => ((n * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 28; i += 1) {
    const symbol = symbols[i % Math.min(symbols.length, 6)];
    const market = rows.find((r) => r.symbol === symbol);
    const tick = market?.tickSize ?? '0.01';
    const lot = market?.lotSize ?? '1';
    const qty = String(Number(lot) * (1 + (i % 5)));
    const filledQty = i % 7 === 3 ? String(Number(lot)) : '0';
    const held = i === 11;
    const seeded = i % 4 === 0;
    const price = (100 + Math.floor(seedRand(i + 1) * 900) * Number(tick || 1)).toFixed(Math.max(0, (tick.split('.')[1] ?? '').length));
    orders.push({
      id: randomUUID(),
      userId: seeded ? NITRO : testUsers[i % testUsers.length],
      clientOrderId: null,
      timestamp: now - i * 91_000,
      datetime: new Date(now - i * 91_000).toISOString(),
      symbol,
      type: 'limit',
      side: i % 2 ? 'sell' : 'buy',
      timeInForce: 'GTC',
      postOnly: false,
      price,
      amount: qty,
      filled: filledQty,
      remaining: String(Number(qty) - Number(filledQty)),
      cost: filledQty === '0' ? '0' : String(Number(filledQty) * Number(price)),
      status: 'open',
      recoveryReason: held ? 'SUBMIT_UNKNOWN' : null,
      reconciliationKey: held ? `recon-${i}` : null,
      recoveryRequired: held,
      seeded,
    });
  }
  return {
    orders,
    killSwitch: { disabledModules: [], reasons: {}, audit: [] },
    restrictions: new Map(),
    approvals: new Map(),
  };
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const hash = sha;

export function baseRoutes(state) {
  const trpcOk = (data) => ({ status: 200, body: { result: { data: { json: data } } } });
  return [
    // ── founder sign-in (TEST) ──
    { method: 'POST', path: '/api/identity/trpc/auth.login', handle: () =>
        trpcOk({ userId: NITRO, accessToken: 'test-founder-access-token', refreshToken: 'test-founder-refresh-token', expiresAt: new Date(Date.now() + 4 * 3_600_000 - 60_000).toISOString() }) },
    { method: 'POST', path: '/api/identity/trpc/auth.logout', handle: () => trpcOk({ signedOut: true }) },
    { method: 'GET', path: '/api/identity/trpc/accountControls.operatorStatus', handle: () =>
        trpcOk({ status: 'enabled', userId: NITRO, version: '1', changedAt: new Date().toISOString() }) },
    // ── real local data, passed through ──
    { method: 'GET', path: '/api/trade/trpc/markets.list', handle: async ({ url }) => upstream(`${url.pathname}${url.search}`) },
    { method: 'GET', path: /^\/api\/v1\/market-lifecycle\/.+/, handle: async ({ url }) => upstream(`${url.pathname}${url.search}`) },
    // ── operator reads (TEST rows) ──
    { method: 'GET', path: '/api/v1/admin/orders/open', handle: ({ query }) => {
        const limit = Number(query.get('limit'));
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
          return { status: 400, body: { code: 'BadRequest', message: 'admin orders limit is unset — refuse to invent 100', intafacedCode: 'trade.admin_orders_limit_unset' } };
        return { status: 200, body: state.orders.slice(0, limit) };
      } },
    { method: 'GET', path: '/admin/kill-switches', handle: () => ({ status: 200, body: state.killSwitch }) },
  ];
}
