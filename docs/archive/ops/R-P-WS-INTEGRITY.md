# R-P-WS-INTEGRITY — WS market-ID + `/ws`→`/stream` blocker

| Field                    | Value                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claim**                | `P-WS-REPORT` (integrity report only) — **PATH-CLEAR vs open partners**; still **NO implement craft** / **no depth UI** until D-P0-WS product law + fleet proof                                                                                                                                                                                                                     |
| **Class**                | N (docs)                                                                                                                                                                                                                                                                                                                                                                            |
| **Proof mode**           | **NO-FLEET** — `docker` not on host; live market-set intersection not re-probed (`proof_missing: fleet-blocked`)                                                                                                                                                                                                                                                                    |
| **Tip when written**     | `9e863d7b` `feat: Stage-1 residual batch + FH-SEC-01 safe-regex (RE2) (#787)` (`origin/main` @ AFK 2026-08-05T04:22Z)                                                                                                                                                                                                                                                               |
| **Upgrade**              | **Board-Delta (real):** Denon **#433** matching + **#432** edge are **closed/gone** from open matrix. Open partners only **#428** (p2p instruments) + **#346** (pay gateway) — **zero path intersect** with `services/svc-ws`, `services/svc-matching`, `services/svc-edge`, nginx. nginx `/ws/` rewrite **already on tip** (see §1). Prior cycle106 stamp was stale on both facts. |
| **Sources**              | Code on tip + prior live probe in [`docs/REGROUP-2026-08-03.md`](../REGROUP-2026-08-03.md) §3 + Denon board [`docs/DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md`](../DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md) **D-P0-WS**                                                                                                                                      |
| **Dual-edit**            | **None.** This residual is `docs/ops/` only. Did **not** edit matching/edge/ws/nginx. Open partner paths: `services/svc-p2p/**`, `services/svc-pay/**`, tracker/docs scoreboard — not P-WS craft paths.                                                                                                                                                                             |
| **Landed (cleared)**     | **#424** CORS · **#422** scan/custody · **#433** / **#432** no longer open · nginx rewrite on tip · Stage-1 TRK batch through **#787** (unrelated to WS path)                                                                                                                                                                                                                       |
| **Still blocking depth** | **D-P0-WS product law** (which string is public depth market key) + **fleet proof** that trade market ids ∩ matching books is non-empty + shell client contract. **Not** partner path-intersect.                                                                                                                                                                                    |

**Purpose:** freeze the platform-integrity facts so depth/tape work is not started against a path that cannot work. **Does not** implement market authority, depth UI, or invent markets.

### AFK status (2026-08-05T04:22Z — tip `9e863d7b`)

| Metric      | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| freeProduct | **1** shell = `P-WS-REPORT` only · freeImplementable **0** (Stage-1 TRK claims `merged`)                                |
| openPRs     | **#428** Denon p2p CONFLICTING red Prettier+Typecheck · **#346** Shehzad pay CONFLICTING CI green                       |
| P-WS paths  | **PATH-CLEAR** vs both open partners — report refresh free; **implement still gated** on D-P0-WS + fleet, not dual-edit |
| nginx       | **Fixed on tip** — `location ^~ /ws/` → `proxy_pass http://svc-ws:4014/;` (trailing slash rewrite to `/stream`)         |
| NO-FLEET    | **Yes** — no live re-probe of market intersection                                                                       |
| Depth UI    | **NOT free** — frontend is HUMAN `nitro-frontend-all`; product law + fleet proof still open                             |

---

## 1 · nginx `/ws` vs svc-ws `/stream` — path fact

### What the shell proxies (tip `9e863d7b`)

`vendor/upstream-exchange/05_Web_Front/nginx.conf` (compose maps host `:8090` → container `:80`):

| Location           | Lines  | Behaviour                                                                                                   |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------- |
| `location /`       | SPA    | `try_files $uri $uri/ /index.html`                                                                          |
| `location /api/`   | ~76–83 | `proxy_pass http://svc-edge:4000`                                                                           |
| `location ^~ /ws/` | ~118–  | `proxy_pass http://svc-ws:4014/;` **with trailing slash** — prefix strip so `/ws/stream` → svc-ws `/stream` |

**Board-Delta vs cycle106:** the old stamp claimed `location /ws` with **no** URI rewrite (browser `/ws` arrived as `/ws` → 404). On current tip the block is `^~ /ws/` + `proxy_pass …4014/;` with an explicit comment that the trailing slash is the fix. **Path plumbing residual for nginx is closed on tip**; remaining depth blockers are market-id law + fleet ∩ + client contract + HUMAN front-end lane.

```118:124:vendor/upstream-exchange/05_Web_Front/nginx.conf
    location ^~ /ws/ {
        proxy_pass http://svc-ws:4014/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
```

`proxy_pass` **with** a URI (`/`) → matched prefix is replaced. Browser `GET /ws/stream?market=…` arrives at svc-ws as **`/stream?market=…`**. (Historical cycle106 stamp described the broken no-slash form — superseded.)

### What svc-ws accepts

`services/svc-ws/src/ws/gateway.ts`:

```56:58:services/svc-ws/src/ws/gateway.ts
/** Bounded before anything else touches it. The hub does the authoritative check. */
const MARKET_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export const STREAM_PATH = '/stream';
```

```127:140:services/svc-ws/src/ws/gateway.ts
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://gateway.invalid');
    // Co-mounted with private gateway: Node fires every upgrade listener.
    // Only ignore the private path so private auth can run; other paths still 404.
    if (url.pathname === '/private/stream') return;
    if (url.pathname !== STREAM_PATH) return reject(socket, 404, 'Not Found');

    if (!enabled()) return reject(socket, 503, 'Service Unavailable');

    const marketId = url.searchParams.get('market');
    if (!marketId || !MARKET_ID.test(marketId)) return reject(socket, 400, 'Bad Request');

    const channel = parseChannel(url.searchParams.get('channel'));
    if (channel === null) return reject(socket, 400, 'Bad Request');
```

- Public upgrade path constant: **`STREAM_PATH = '/stream'`**.
- Pathname `/private/stream` → ignore (private gateway co-mount).
- Pathname **not** `/stream` → **HTTP 404** + destroy socket.
- Required query: `?market=<id>` matching `^[A-Za-z0-9._:-]{1,64}$`; optional `channel=depth|trades` (`parseChannel`).

Documented surface (`services/svc-ws/README.md` §API):

| Route                                          | Role                          |
| ---------------------------------------------- | ----------------------------- |
| `GET /stream?market=<id>`                      | depth snapshot then deltas    |
| `GET /stream?market=<id>&channel=trades`       | public tape                   |
| `GET /private/stream`                          | auth private (orders/fills/…) |
| `GET /markets`, `GET /markets/:marketId/depth` | REST mirrors                  |

Retired `apps/web` clients already target **`/stream`**, not `/ws`:

```90:98:apps/web/src/lib/market/ws-transport.ts
export function streamUrl(origin: string, marketId: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`depth origin must be http(s), got "${url.protocol}"`);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/stream';
  url.search = `market=${encodeURIComponent(marketId)}`;
  return url.toString();
}
```

Edge does **not** proxy WebSocket. `OUTSIDE_THE_DOOR.ws` documents the gap:

```126:141:services/svc-edge/src/routes.ts
export const OUTSIDE_THE_DOOR: Readonly<Record<string, string>> = {
  /**
   * SOCKET §13 · `socket.ws-behind-the-edge`
   *
   * svc-ws publishes 4014 and the browser connects to it directly
   * (`NEXT_PUBLIC_WS_URL`); the vendored shell's nginx proxies `/ws` straight to
   * `svc-ws:4014`. Neither path crosses svc-edge, so the operator kill-switch
   * cannot reach it. …
   */
  ws: 'svc-ws is reached directly by the browser on its own port, not through this edge (SOCKET §13 socket.ws-behind-the-edge)',
```

### The mismatch (code-level, independent of fleet)

1. Browser (or shell) that opens `ws://host:8090/ws?...` is proxied to svc-ws as path **`/ws`**.
2. svc-ws only upgrades **`/stream`**. Path `/ws` → **404 Not Found** (never a live book).
3. A client that instead opens `ws://host:8090/stream?...` never hits the `/ws` location: **`location /` wins** and `try_files` serves SPA HTML — not a WebSocket upgrade to svc-ws.
4. Therefore: **there is no URL on `:8090` that reaches the depth stream** (REGROUP §3). Upgrade headers on `/ws` are correct for _a_ WS proxy, but the path never matches the service contract.

### Fix shape (for Denon implementer — not done here)

Either:

- **Rewrite:** `location /ws/` (or `/ws`) with `proxy_pass http://svc-ws:4014/stream` (or equivalent strip/rewrite so upstream sees `/stream?…`), **or**
- **Expose the real path:** a higher-priority `location` for `/stream` (and likely `/private/stream`) that proxies to svc-ws **before** `location /` can catch it.

nginx half is short; it is not the whole blocker (see §2).

---

## 2 · Market-ID namespace — edge vs matching vs ws

### Data-plane ownership (from code on tip `54317448`; structural citations from prior stamp, NO-FLEET — no service re-edit)

| Plane                     | Source of market identity                                                                                  | Shape on the wire                                                                      | Citation                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Browser REST via edge** | Edge `/api/v1/*` → **svc-trade** (`TRADE_URL`, `preservePath: true`)                                       | Public list: `GET /api/v1/markets` on trade                                            | `services/svc-edge/src/routes.ts` L60–69                                                 |
| **Trade catalog**         | Postgres `trade.markets`                                                                                   | `id` = **uuid PK**; `symbol` = human pair (e.g. `BTC/USDT`)                            | `services/svc-trade/drizzle/0000_trade_init.sql` L51–52; `types.ts` `Market.id`/`symbol` |
| **Trade → matching**      | `matching.submit(market.id, …)`, `matching.depth(market.id, …)`                                            | Engine key = **trade UUID string**, not symbol                                         | `trade-service.ts` L367, L580                                                            |
| **Matching books**        | In-process map; `GET /markets` → `{ markets: engine.markets }`                                             | IDs that have ever had a book / journal presence — **not** a copy of Postgres listings | `services/svc-matching/src/router.ts` L239; `engine.ts` `get markets()` L144–146         |
| **svc-ws**                | `HttpDepthSource.markets()` = matching `GET /markets`; `ensureKnownMarket` before any depth poll or attach | Subscribe with that same string or close **`unknown market "<id>"`**                   | `depth/source.ts` L102–108; `depth/hub.ts` L196–199, L225–232                            |

Edge route table (trade only for public markets REST; matching **absent**):

```60:69:services/svc-edge/src/routes.ts
export const UPSTREAMS: readonly Upstream[] = [
  { prefix: '/api/identity', module: 'identity', envVar: 'IDENTITY_URL', devUrl: 'http://localhost:4002' },
  { prefix: '/api/trade', module: 'trade', envVar: 'TRADE_URL', devUrl: 'http://localhost:4004' },
  // Public exchange REST (CCXT contract paths). Path preserved so
  // edge /api/v1/markets → trade /api/v1/markets.
  //
  // `module: 'trade'` and not 'v1'. This is the same service as the row above
  // reached under a different contract, so the kill-switch must treat the two
  // as one module or halting the market would only halt half of it.
  { prefix: '/api/v1', module: 'trade', envVar: 'TRADE_URL', devUrl: 'http://localhost:4004', preservePath: true },
```

Trade schema:

```51:53:services/svc-trade/drizzle/0000_trade_init.sql
CREATE TABLE IF NOT EXISTS "trade"."markets" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "symbol"       text NOT NULL,
```

Money path keys matching by **UUID**:

```367:367:services/svc-trade/src/spot/trade-service.ts
    const depth = await this.matching.depth(market.id, 50);
```

```580:580:services/svc-trade/src/spot/trade-service.ts
      result = await this.matching.submit(market.id, this.toEngineRequest(orderId, userId, input, orderType, tif, protectionPrice));
```

Matching public list + depth authority:

```224:239:services/svc-matching/src/router.ts
  app.get('/markets/:marketId/depth', async (req, reply) => {
    const { marketId } = req.params as { marketId: string };
    const limit = Number((req.query as { limit?: string }).limit ?? '50');
    const depth = engine.depth(marketId, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50);

    // 404 for a market that has never traded. Previously this route allocated
    // and STORED a book for any string, so an unauthenticated caller could grow
    // the engine's memory without bound — and every one of those phantom books
    // then appeared to exist. Reading must not create.
    if (depth === null) {
      return reply.code(404).send({ code: 'MarketNotFound', message: `${marketId} is not a market on this engine` });
    }
    return reply.code(200).send({ marketId, ...depth });
  });

  app.get('/markets', async () => ({ markets: engine.markets }));
```

svc-ws market gate (matching list only; never trade Postgres):

```102:108:services/svc-ws/src/depth/source.ts
  async markets(): Promise<readonly string[]> {
    const body = await this.#get('/markets');
    const markets = (body as { markets?: unknown }).markets;
    if (!Array.isArray(markets) || markets.some((m) => typeof m !== 'string')) {
      throw new DepthSourceError('svc-matching returned no market list', null);
    }
    return markets as readonly string[];
  }
```

```196:199:services/svc-ws/src/depth/hub.ts
      if (!(await this.ensureKnownMarket(sub.marketId))) {
        // Never call depth for an id the engine has no book for: that call would
        // CREATE the book upstream. See `DepthSource.markets`.
        this.#evict(sub, CLOSE_POLICY, `unknown market "${sub.marketId}"`);
```

**Safety note:** tip matching depth **404s** unknown markets without allocating (`engine.depth` → `existingBook`). ws **still** gates on `GET /markets` so junk ids never poll and historically protected against the allocate-on-read bug (`source.ts` L13–21 header; engine comment L119–135). Both layers remain correct.

### Three namespaces, not two

1. **Edge-visible catalog** = trade Postgres rows (symbols + UUIDs) — what the shell/landing list.
2. **Matching journal keys** = whatever marketIds have books after orders/seeds (UUID if trade always submits UUID; unit tests often use symbolic `BTC-USDT`).
3. **svc-ws allow-list** = **exact copy of (2)** at refresh time — never trade Postgres, never edge.

Intersection that matters for depth:

```
edge_listable_ids ∩ ws_known_ids
  = trade.market.ids_shown_to_clients ∩ matching.engine.markets
```

If the shell (or any client) opens `/stream?market=<trade UUID>` but matching has never seen that UUID (empty journal / different seed IDs), ws closes: `unknown market "…"`.

### Prior live probe (REGROUP 2026-08-03) — **not re-run this session**

When the fleet was healthy, product-surfaces session recorded:

| Fact                                    | Value                                     | Status this session                                              |
| --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Edge / trade markets serving            | **16**                                    | **Unverified** (NO-FLEET)                                        |
| svc-ws / matching markets               | **10**                                    | **Unverified** (NO-FLEET)                                        |
| Set intersection                        | **0**                                     | **Unverified** (NO-FLEET); structural risk still holds from code |
| Direct upgrade to svc-ws with edge UUID | closes with `unknown market "a7cc445e-…"` | Anecdote from REGROUP; UUID shape matches trade `id`             |

Source: [`docs/REGROUP-2026-08-03.md`](../REGROUP-2026-08-03.md) §3 items 1–2.

### Structural risk that remains true without Docker

- Edge does **not** proxy market identity into matching or ws.
- Trade **does** use UUID as matching marketId on the money path.
- Matching only lists books it already has; listing a pair in Postgres does **not** create a matching book.
- Unit/fixtures use symbolic `BTC-USDT` / `btc-usdt` in places; production path uses UUID — easy to “green” tests while live namespaces diverge.
- Shell desk today uses **symbol** REST (`/orderbook/:symbol`, route `btc_usdt`) and has **no** live depth WebSocket port that reaches svc-ws (blocked by §1 even before ID alignment).

### What would prove ∩ ≠ 0 (when fleet returns)

1. `GET` trade (or edge) `/api/v1/markets` → collect `id` (and symbols).
2. `GET` matching `/markets` → collect engine market ids.
3. `GET` svc-ws `/markets` → must equal (2) (modulo refresh lag).
4. Assert non-empty intersection of trade `id` set with matching set.
5. Upgrade to `ws://svc-ws:4014/stream?market=<id_from_intersection>` → first frame `type: snapshot` (not close 1008 unknown market).
6. After nginx fix: same against `:8090` public path.

---

## 3 · Handoff Denon needs (D-P0-WS)

Platform-integrity lane. Agents **do not** invent the authority rule ([DENON hard board](../DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md) **D-P0-WS** / “product law, not only plumbing”).

### Decide first (product law — write on tip)

- [ ] **Which string is the public depth market key?** Options to pick explicitly (not invent mid-stream):
  1. **Trade UUID** everywhere (matching books, ws query param, shell socket) — aligns with current money path `matching.submit(market.id)`.
  2. **Canonical symbol** (e.g. `BTC/USDT` or `BTC-USDT`) everywhere — would require trade→matching key migration.
  3. **Dual map** (ws accepts symbol, resolves to UUID) — new contract; only if (1)/(2) are rejected with reasons.
- [ ] Document the decision in a short tip note (ADR or `docs/` handoff) **before** large shell depth UI work.

### Then implement (order that unblocks depth)

- [ ] **Align namespaces** so `trade.markets.id` ∩ `matching.GET /markets` is non-empty for every market the shell may stream (seed/MM/journal so listed UUIDs actually have books — or refuse list rows that have no book, honestly).
- [ ] **nginx path:** make one same-origin URL on `:8090` upgrade to svc-ws **`/stream`** (and decide `/private/stream` proxy if private channels are in scope). Do not leave `/stream` under SPA `try_files`.
- [ ] **Client contract:** shell (when later ported) must pass the **decided** market key on `?market=`, not a free-form slug that only matches the Vue route (`btc_usdt`).
- [ ] **Proof on fleet:** intersection script + one live snapshot frame through `:8090` (acceptance from hard board: _“Live shell can open depth for a real market id”_).

### Explicit non-goals for this handoff

- No depth/tape **UI** polish in the same change unless path + namespace already green.
- No inventing mid/prices/candles to make books look full.
- No dual-edit of open partner money PR paths (`#428` p2p instruments, `#346` pay gateway — different concerns; do not hitch-hike). Matching/edge dual-edit blocks **#433/#432** are closed.

### Suggested acceptance checklist (Denon self-audit)

1. Decision note on tip names the authoritative market id.
2. `trade ids ∩ matching markets ≠ ∅` on running fleet.
3. `:8090` has a documented WS URL that returns snapshot (not 404 HTML, not unknown market).
4. Tracker / LIVE-LANES: depth UI residual only unblocked **after** 1–3.

---

## 4 · Explicitly NOT free

| Item                                                       | Why blocked / reserved                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Depth UI / live book port into shell**                   | Blocked on D-P0-WS (§1 + §2). REGROUP §3 + swarm orient: depth/tape **not** free product residual.                         |
| **Tape / public trades channel UI**                        | Same `/stream` path + same market key.                                                                                     |
| **Inventing markets, mids, or seed depth for screenshots** | Honesty law; fabricated-money ratchet; NO-FLEET does not authorize fake books.                                             |
| **Implementing inside open partner PRs**                   | `#428` p2p · `#346` pay — path-clear for WS but **never dual-edit**. Matching/edge open dual-edit (**#433/#432**) cleared. |
| **Treating nginx-only fix as “depth done”**                | Path fix alone leaves ∩ = 0 (or unknown market closes).                                                                    |
| **apps/web as product surface**                            | Retired; port targets vendor shell. Depth state machine in apps/web is reference, not the live desk.                       |

**Free for Nitro residual (unchanged by this report):** shell money call sites (RP1), landing honesty (RP2), announce (RP3), wire adopt (RP4), AFK residuals — **not** depth.

---

## 5 · File / PR touch map (for implementers)

| Area                | Path                                                      | Role                          |
| ------------------- | --------------------------------------------------------- | ----------------------------- |
| nginx               | `vendor/upstream-exchange/05_Web_Front/nginx.conf` L76–83 | `/ws` proxy vs SPA `/` L55–57 |
| ws gateway          | `services/svc-ws/src/ws/gateway.ts` L58, L127–140         | `/stream` only                |
| ws market gate      | `services/svc-ws/src/depth/source.ts`, `hub.ts`           | matching list                 |
| edge route          | `services/svc-edge/src/routes.ts` L60–69, L126–141        | `/api/v1` → trade; ws outside |
| trade id            | `drizzle/0000_trade_init.sql` L51–52; `trade-service.ts`  | UUID to matching              |
| matching list       | `services/svc-matching/src/router.ts` L224–239            | journal books + depth 404     |
| prior live write-up | `docs/REGROUP-2026-08-03.md` §3                           | 16 vs 10, ∩0                  |
| Denon queue id      | **D-P0-WS**                                               | authority + implement         |

---

## 6 · This report’s verification

| Check                            | Result                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| Tip SHA stamped                  | `9e863d7b` (`origin/main` @ 2026-08-05T04:22Z · AFK keep-alive)                            |
| Denon #424 / #422 / #433 / #432  | **Not open** — partner matrix is **#428** + **#346** only                                  |
| P-WS path ∩ open partners        | **∅** — p2p/pay only; ws/matching/edge/nginx clear                                         |
| nginx `/ws/` rewrite             | **On tip** — `^~ /ws/` + `proxy_pass …4014/;` (cycle106 “no rewrite” stamp **superseded**) |
| svc-ws `/stream` only            | Unchanged — `STREAM_PATH = '/stream'`                                                      |
| trade UUID → matching            | Unchanged structural fact; fleet ∩ **not** re-probed                                       |
| Live market-set re-probe         | **No** — NO-FLEET; cite REGROUP for last live numbers                                      |
| Code changes to matching/edge/ws | **None** (report-only; dual-edit ban; front-end HUMAN)                                     |
| freeProduct (this freeze)        | **1** = P-WS-REPORT shell only; freeImplementable **0**                                    |
| Depth UI                         | **Not free** — D-P0-WS + fleet + HUMAN `nitro-frontend-all`                                |

**Stamp:** `proof_missing: fleet-blocked` for live market-set intersection. **Partner path-intersect is no longer the block.** Residual for craft: D-P0-WS market-key product law + fleet proof + client contract; depth UI remains HUMAN / not free residual. Claim **P-WS-REPORT** → residual-own after this refresh (report done; not mountain done).
