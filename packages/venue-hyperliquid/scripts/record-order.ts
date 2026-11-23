/**
 * RECORD THE TEST ORDER — writes `recordings/order-btc-perp.json`, the answers `hl-recorded` plays back
 * (src/recorded-order.ts). Never mainnet; every figure is TEST.
 *
 *   APP_ENV=test pnpm --filter @intafaced/venue-hyperliquid record:order
 *
 * Each read the order needs before it is sent (the listing, the book, the TEST account's state) goes to the live test
 * network and is kept as the venue answered it (`source: testnet`). The order's own answer, its status and its fill
 * need a funded test account, which the TEST key here never is: they are written to the venue's documented shape
 * (`source: documented-shape`), the fill at the best ask the captured book showed. The spot listing is cut to the
 * pairs whose tokens have the lowest indexes, keeping each entry whole: the adapter reads a spot pair's and a token's
 * own `index` field, never its position, so the kept pairs read the same.
 */
import fs from 'node:fs';
import { HL_TESTNET_API_URL } from '../src/signing.js';
import { HyperliquidTestnetUserVenue } from '../src/venue.js';
import type { FetchLike, Json } from '../src/core.js';
import { recordingFetch, type HlRecordedCall, type HlRecording } from '../src/recorded.js';
import { RECORDED_ORDER_INTENT, RECORDED_ORDER_NOW_MS, runRecordedOrder } from '../src/recorded-order.js';

const OUT = new URL('../recordings/order-btc-perp.json', import.meta.url);
/** The spot pairs kept from the live listing. */
const SPOT_PAIRS_KEPT = 8;
const OID = 31_000_001;
const TID = 41_000_001;

const live: FetchLike = (url, init) => globalThis.fetch(url, init);
const calls: HlRecordedCall[] = [];
const recorded = recordingFetch(live, calls);
let bestAsk: string | null = null;
let cloid: string | null = null;

/** The order's answers no unfunded TEST account can capture, in the venue's documented shape. */
function written(path: '/info' | '/exchange', request: Record<string, Json>): Json | undefined {
  if (path === '/exchange') {
    const action = request.action as { type: string; orders: { c: string }[] };
    if (action.type !== 'order') throw new Error(`record-order: unexpected action ${action.type}`);
    cloid = action.orders[0]!.c;
    return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.001', avgPx: bestAsk!, oid: OID } }] } } };
  }
  if (request.type === 'orderStatus') {
    return {
      status: 'order',
      order: {
        status: 'filled',
        statusTimestamp: RECORDED_ORDER_NOW_MS + 1,
        order: {
          coin: 'BTC',
          side: 'B',
          limitPx: '70000.0',
          sz: '0.0',
          origSz: '0.001',
          oid: OID,
          timestamp: RECORDED_ORDER_NOW_MS,
          cloid,
          tif: 'Ioc',
          orderType: 'Limit',
          reduceOnly: false,
        },
      },
    };
  }
  if (request.type === 'userFillsByTime') {
    // Taker fee at the venue's base perp rate (0.045%) on 0.001 × the ask: TEST.
    const fee = ((Number(bestAsk) * 0.001 * 0.00045 * 1e6) / 1e6).toFixed(6);
    return [
      {
        coin: 'BTC',
        px: bestAsk!,
        sz: '0.001',
        side: 'B',
        time: RECORDED_ORDER_NOW_MS + 1,
        startPosition: '0.0',
        dir: 'Open Long',
        closedPnl: '0.0',
        hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        oid: OID,
        crossed: true,
        fee,
        tid: TID,
        cloid,
        feeToken: 'USDC',
      },
    ];
  }
  return undefined;
}

const fetchImpl: FetchLike = async (input, init) => {
  const path = new URL(input).pathname as '/info' | '/exchange';
  const request = JSON.parse(init.body) as Record<string, Json>;
  const answer = written(path, request);
  if (answer !== undefined) {
    calls.push({ path, request, status: 200, answer, source: 'documented-shape' });
    const text = JSON.stringify(answer);
    return { ok: true, status: 200, text: async () => text };
  }
  const res = await recorded(input, init);
  if (path === '/info' && request.type === 'l2Book') {
    const book = JSON.parse(await res.text()) as { levels: [unknown[], { px: string }[]] };
    bestAsk = book.levels[1][0]!.px;
  }
  return res;
};

function trimSpot(answer: unknown): unknown {
  const spot = answer as { tokens: { index: number }[]; universe: { tokens: number[]; index: number }[] };
  const universe = [...spot.universe].sort((x, y) => x.index - y.index).slice(0, SPOT_PAIRS_KEPT);
  const keep = new Set(universe.flatMap((p) => p.tokens));
  return { ...spot, universe, tokens: spot.tokens.filter((t) => keep.has(t.index)) };
}

const venue = new HyperliquidTestnetUserVenue({
  appEnv: process.env.APP_ENV,
  baseUrl: HL_TESTNET_API_URL,
  fetch: fetchImpl,
  clock: () => new Date(RECORDED_ORDER_NOW_MS),
});
// The book first, so the written fill is at the price the live book showed.
await venue.book(RECORDED_ORDER_INTENT.symbol, 5);
const run = await runRecordedOrder(venue);
if (!run.outcome.definite || !run.outcome.accepted)
  throw new Error(`record-order: the order was not accepted: ${JSON.stringify(run.outcome)}`);
const recording: HlRecording = {
  label: 'TEST',
  note: "TEST answers of the Hyperliquid test network for one TEST order (packages/venue-hyperliquid/src/recorded-order.ts). source testnet: captured live by scripts/record-order.ts; source documented-shape: written to the venue's documented answer, as an order needs a funded test account. The spot listing is cut to its first pairs.",
  calls: calls.map((c) =>
    c.path === '/info' && (c.request as { type?: string }).type === 'spotMeta' ? { ...c, answer: trimSpot(c.answer) } : c,
  ),
};
fs.mkdirSync(new URL('.', OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(recording, null, 1)}\n`);
process.stdout.write(`record-order: ${calls.length} calls written to recordings/order-btc-perp.json (fill at ${bestAsk})\n`);
