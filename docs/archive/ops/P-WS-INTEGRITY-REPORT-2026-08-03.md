# P-WS integrity report — market-ID contract + `/ws` vs `/stream`

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claim**               | `P-WS-REPORT` — integrity report only (no code, no depth UI, no invent)                                                                                                                                                                                                                                                                                                                                   |
| **Class**               | N (docs)                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Written**             | 2026-08-03                                                                                                                                                                                                                                                                                                                                                                                                |
| **Tip**                 | `f96ac6b4` `docs(ops): night engine keep-alive law (#474)` (`origin/main`)                                                                                                                                                                                                                                                                                                                                |
| **Proof mode**          | **NO-FLEET** — live market counts not re-probed this session · stamp `proof_missing: fleet-blocked`                                                                                                                                                                                                                                                                                                       |
| **Dual-edit**           | **None.** Docs only. Did **not** edit `services/svc-matching` or `services/svc-edge` (open Denon: #433 matching, #432/#424 edge).                                                                                                                                                                                                                                                                         |
| **Sources (read-only)** | `services/svc-ws/**`, `packages/market-data/**`, `services/svc-edge/src/routes.ts`, `services/svc-matching/src/router.ts` + README, `services/svc-trade` market schema + `trade-service.ts`, `vendor/upstream-exchange/05_Web_Front/nginx.conf`, `apps/web/src/lib/market/*` (reference client), `docs/REGROUP-2026-08-03.md` §3, `docs/DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md` **D-P0-WS** |
| **Sibling**             | Open PR [#475](https://github.com/Phantom-X-007/intafaced/pull/475) carries the same facts under `docs/ops/R-P-WS-INTEGRITY.md` — this file is the dated canonical path named by the night-engine claim.                                                                                                                                                                                                  |

**Purpose:** freeze platform-integrity facts so depth/tape work is not started against a path that cannot work. **Does not** implement nginx, market-authority code, depth UI, or invent markets/mids.

---

## 1 · WS market-ID contract (what IDs mean on the wire)

### Public depth / tape (`svc-ws`)

| Element                                    | Contract                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upgrade path**                           | `GET /stream` only (`STREAM_PATH` in `services/svc-ws/src/ws/gateway.ts`)                                                                                                    |
| **Market key**                             | Query `?market=<id>` — required                                                                                                                                              |
| **ID shape allowed at the door**           | Regex `^[A-Za-z0-9._:-]{1,64}$` — syntax only; **not** product authority                                                                                                     |
| **Channel**                                | Omit / empty / `depth` → depth; `channel=trades` → public tape; anything else → HTTP **400**                                                                                 |
| **Subscribe model**                        | **No inbound JSON.** Market is only on the upgrade URL; inbound frames dropped; one market per socket                                                                        |
| **Authority for “is this a real market?”** | **svc-matching** `GET /markets` only. `DepthHub.ensureKnownMarket` / trade hub equivalent. Unknown → close **1008** with `unknown market "<id>"` (no depth poll for that id) |
| **Depth source**                           | Poll matching `GET /markets/:marketId/depth?limit=` — no credential; amounts = **decimal strings**                                                                           |
| **Wire frames**                            | `@intafaced/market-data` unchanged: `DepthSnapshot`, `DepthDelta`, `TradePrint`                                                                                              |

Frame shapes (types only — not live data):

```jsonc
{ "type": "snapshot", "marketId": "<string>", "sequence": 812, "bids": [["30000.5", "1.25"]], "asks": [] }
{ "type": "delta", "marketId": "<string>", "fromSequence": 812, "sequence": 813, "bids": [["30000.5", "0"]], "asks": [] }
{ "type": "trade", "marketId": "<string>", "sequence": 812, "price": "30000.5", "quantity": "0.25", "ts": "…" }
```

- `quantity: "0"` **removes** a level; **absent** price in a delta means **unchanged**.
- Client safety: `applyDelta` **refuses** gap / wrong `fromSequence` / wrong `marketId` — resnapshot required.
- Trade prints strip order ids; aggressor side is **not** on `orderFilled` today (events PR if ever added).

### Private stream (same process, different path)

| Element  | Contract                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Path     | `/private/stream`                                                                                                                          |
| Auth     | JWT `access_token` query or `Authorization: Bearer`; needs `trade:read` or `trade:write`; **403** if `JWT_ACCESS_SECRET` unset             |
| Channels | `orders` / `fills` / `positions` ready frames then bus fan-out; positions stay silent until `positionUpdated` publishes — **never invent** |

### Three namespaces (the integrity problem)

| Plane                  | Who owns the string                                                    | What the string is                                                                                                |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Edge / public REST** | Edge prefixes `/api/v1` → **svc-trade** (`preservePath`)               | Catalog rows: `Market.id` = **UUID** (`trade.markets.id uuid PK`), `Market.symbol` = human pair (e.g. `BTC/USDT`) |
| **Matching engine**    | In-process journal map; `GET /markets` → `{ markets: engine.markets }` | Whatever `marketId` has ever had a book (after submit/seed/journal). **Not** a copy of Postgres listings          |
| **svc-ws allow-list**  | Refreshed from matching `GET /markets`                                 | **Exact copy of matching’s list** (modulo refresh lag). Never trade Postgres. Never edge                          |

Money path truth (code): `svc-trade` calls `matching.submit(market.id, …)` and `matching.depth(market.id, …)` — engine keys are **trade UUIDs**, not symbols.

Intersection that must be non-empty for depth to work for a listed market:

```
trade.markets.id (shown via edge/trade REST)
  ∩ matching.engine.markets
  = ids svc-ws will accept on ?market=
```

If the shell opens `?market=<trade UUID>` but matching has never seen that UUID → ws closes `unknown market`.  
If the shell opens a **symbol** / Vue slug (`btc_usdt`, `BTC-USDT`) while the money path keys books by UUID → same close (or empty intersection).

**Safety note (why ws gates hard):** matching historically could allocate a book on depth read for any string; public internet must not grow engine memory. Matching depth route on tip **404s** unknown markets without creating; ws still gates on the market list before poll.

---

## 2 · `/ws` vs `/stream` routing (edge + matching surface map)

### svc-edge — REST only; **no WebSocket**

| Surface          | Behaviour                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALL /api/*`     | Prefix table → upstream HTTP; buffers `response.text()` — **not** a socket path (README: streaming “Not built yet”)                         |
| `/api/v1`        | → svc-trade, `preservePath: true` (public markets/orders REST)                                                                              |
| `/api/trade`     | → svc-trade (stripped prefix style)                                                                                                         |
| **svc-matching** | **Deliberately absent** from the table (S2S secret only)                                                                                    |
| **svc-ws**       | **Not proxied.** Listed in `OUTSIDE_THE_DOOR` — browser / nginx hit `:4014` (or shell `/ws`) directly; edge kill-switch cannot halt sockets |
| CORS             | On tip: still “not built” in edge README; open #424 adds CORS (browser readability; does **not** fix WS path)                               |

### svc-matching — S2S writes; public reads

| Route                                       | Auth                    | Role for WS                                    |
| ------------------------------------------- | ----------------------- | ---------------------------------------------- |
| `POST /markets/:marketId/orders`            | Internal service secret | Creates journal presence under that `marketId` |
| `DELETE /markets/:marketId/orders/:orderId` | Internal service secret | —                                              |
| `GET /markets/:marketId/depth`              | **Public**              | Depth bytes svc-ws polls                       |
| `GET /markets`                              | **Public**              | **Authority list** for ws `ensureKnownMarket`  |

Matching is **not** browser-reachable through edge; only via fleet network / compose (ws → matching).

### svc-ws — second internet-facing process (port **4014**)

| Route                                               | Role                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /stream?market=` (+ optional `channel=trades`) | Public WS upgrade                                                          |
| `GET /private/stream`                               | JWT private lifecycle                                                      |
| `GET /markets`, `GET /markets/:id/depth`            | HTTP helpers (same books as socket)                                        |
| Kill-switch                                         | `ws.gateway` / `WS_GATEWAY_ENABLED` — 503 upgrades; not edge’s module flag |

### Vendor shell nginx (`:8090`) — path mismatch

From `vendor/upstream-exchange/05_Web_Front/nginx.conf` on tip:

| Location         | Proxies to      | Rewrite?                                         |
| ---------------- | --------------- | ------------------------------------------------ |
| `location /`     | SPA `try_files` | —                                                |
| `location /api/` | `svc-edge:4000` | none (edge path intact)                          |
| `location /ws`   | `svc-ws:4014`   | **none** — path `/ws` arrives at svc-ws as `/ws` |

**Code-level result (independent of fleet):**

1. Client `ws://host:8090/ws?market=…` → svc-ws sees path **`/ws`** → only `/stream` upgrades → **404**.
2. Client `ws://host:8090/stream?market=…` → never hits `location /ws`; **`location /` wins** → SPA HTML, not a WebSocket to svc-ws.
3. Therefore: **no URL on `:8090` reaches the depth stream** (REGROUP §3). Upgrade headers on `/ws` are correct for _a_ proxy; the path never matches the service contract.

Retired reference client (`apps/web` `ws-transport.ts`) already targets **`/stream`** on `NEXT_PUBLIC_WS_URL` (direct `:4014`), not shell `/ws`.

### Surface map (one glance)

```
Browser :8090
  /api/*     → svc-edge → (trade, identity, …)     [HTTP only]
  /ws        → svc-ws:4014 path=/ws                 [BROKEN — 404 at gateway]
  /stream    → SPA try_files                         [BROKEN — never reaches svc-ws]

Browser / fleet direct :4014
  /stream?market=…           → depth | trades      [works if market known]
  /private/stream            → JWT private         [config-dependent]
  /markets, /markets/…/depth → HTTP snapshots

svc-ws (poll / list)
  → matching GET /markets + GET /markets/:id/depth  [S2S network; no edge]

svc-trade (money)
  → matching POST /markets/:uuid/orders             [INTERNAL_SERVICE_SECRET]
```

---

## 3 · What is broken / unknown vs tip

### Broken on tip (code-backed — no fleet required)

| Issue                          | Evidence                                                          | Impact                                                             |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| **nginx path ≠ svc-ws path**   | nginx `/ws` no rewrite; gateway only `/stream`                    | Shell cannot stream depth/tape same-origin                         |
| **SPA swallows `/stream`**     | `location /` before any `/stream` location                        | Cannot “just open `/stream` on :8090”                              |
| **Three market namespaces**    | trade UUID / matching journal / ws allow-list                     | Even with nginx fixed, wrong `?market=` closes                     |
| **Listed ≠ bookable**          | Postgres list does not create matching books                      | Edge-visible markets may never appear on ws                        |
| **Test fixtures vs prod keys** | Matching/ws unit tests often use `BTC-USDT`; money path uses UUID | Easy green tests with live namespace divergence                    |
| **Edge cannot kill ws**        | `OUTSIDE_THE_DOOR.ws` + SOCKET §13                                | Operator “halt market data” via edge is a lie until design changes |
| **No rate limit**              | edge + ws READMEs                                                 | Reconnect storms → one matching list call per attempt              |

### Prior live probe (REGROUP 2026-08-03 §3) — **not re-run**

| Fact                          | Then                                | This session                                                       |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Edge/trade markets            | **16**                              | **Unverified** — `proof_missing: fleet-blocked`                    |
| Matching / svc-ws markets     | **10**                              | **Unverified**                                                     |
| Intersection                  | **0**                               | **Unverified** as count; **structural risk still holds** from code |
| Direct upgrade with edge UUID | close `unknown market "a7cc445e-…"` | Anecdote in REGROUP; UUID shape matches trade `id`                 |

### Unknown until fleet returns

1. Current sizes of trade list, matching list, intersection.
2. Whether any MM/seed path has put **trade UUIDs** into the matching journal on a healthy stack.
3. Whether private `/private/stream` is configured in the same environment (`JWT_ACCESS_SECRET`).
4. Whether any shell code path already attempts a WS URL (depth UI residual is blocked; do not invent mid/UI to “check”).

### Explicitly **not** claimed broken here

- Matching reconcile / money-stranding (#433) — separate Class M lane; do not hitch-hike.
- Edge CORS (#424) / screening (#432) — do not fix WS path by themselves.
- Empty tape on a quiet market — empty ≠ broken (honesty law).

---

## 4 · Blockers (open PRs that touch related paths)

Agents must **not** dual-edit these. Babysit only.

| PR                                                              | Title (short)                               | Paths that block craft on those trees                                    | Relation to P-WS                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **[#433](https://github.com/Phantom-X-007/intafaced/pull/433)** | matching reconcile / money-stranding refuse | `services/svc-matching/**` (engine, router, reconcile, README)           | Touches matching surface ws **reads**; any market-seed or list change waits on Denon merge/rebase |
| **[#432](https://github.com/Phantom-X-007/intafaced/pull/432)** | screening config authority                  | `packages/config/screening*`, `services/svc-edge/src/env.ts`, `index.ts` | Edge boot/env dual-edit magnet; not the WS path itself                                            |
| **[#424](https://github.com/Phantom-X-007/intafaced/pull/424)** | edge CORS                                   | `services/svc-edge/src/cors*`, `index.ts`, README                        | CORS for browser REST; **does not** proxy WebSockets                                              |
| **[#475](https://github.com/Phantom-X-007/intafaced/pull/475)** | prior P-WS integrity docs                   | `docs/ops/R-P-WS-INTEGRITY.md`                                           | Sibling report same facts; merge one canonical docs PR                                            |

Other open integrity PRs (#448 secrets, #445 test skips, #441 coverage, …) are general merge-queue load (D-P0-MERGE) — they do not own `/stream`, but thrash slows Denon landing D-P0-WS.

**Human / product lock:** **D-P0-WS** on Denon hard board — authority rule for market id is **not** free agent craft.

---

## 5 · Recommended unstick order (babysit only)

Do **not** implement money/depth UI in this claim. Sequence for Denon (or explicit handoff):

1. **Product law (tip note / ADR) — first**  
   Pick the public depth market key explicitly:
   - **(A) Trade UUID everywhere** (aligns with `matching.submit(market.id)` today), or
   - **(B) Canonical symbol everywhere** (migration of matching keys + all callers), or
   - **(C) Dual map** (ws resolves symbol → UUID) — only if A/B rejected with written reasons.  
     Agents must **not** invent this mid-stream.

2. **Namespace alignment**  
   Make `trade.markets.id ∩ matching.GET /markets` non-empty for every market the shell may stream (seed/MM/journal so listed UUIDs have books — **or** stop listing rows with no book, honestly). No fabricated depth.

3. **nginx path**  
   One same-origin URL on `:8090` that upgrades to svc-ws **`/stream`** (rewrite `/ws` → `/stream`, **or** higher-priority `location` for `/stream` + likely `/private/stream` **before** SPA `/`). Do not leave `/stream` under `try_files`.

4. **Client contract (shell later)**  
   Pass the **decided** key on `?market=`, not a free-form Vue slug alone. Reference: `apps/web` `DepthController` + `ws-transport` gap/resnapshot behaviour.

5. **Fleet proof** (acceptance = D-P0-WS done bar)
   - Collect trade `id` set + matching markets + ws markets.
   - Assert intersection ≠ ∅.
   - One live first frame `type: snapshot` on `ws://svc-ws:4014/stream?market=<id_from_∩>`.
   - Same through `:8090` public path after nginx fix.

6. **Only then** depth/tape UI residual / shell port (swarm orient: depth **not** free until this lane moves).

### Explicit non-goals until 1–5

| Do not                                    | Why                                     |
| ----------------------------------------- | --------------------------------------- |
| Depth / live book UI into shell           | Blocked on D-P0-WS                      |
| Invent mids, seed books for screenshots   | Fabricated-money / honesty              |
| Implement inside #433 / #432 / #424 trees | Dual-edit ban                           |
| Treat nginx-only as “depth done”          | Leaves unknown-market closes            |
| Treat `apps/web` as the product desk      | Retired reference; shell is the surface |

### Free residual (unchanged)

Shell money call sites (RP1), landing honesty (RP2), announce (RP3), wire adopt (RP4), AFK residuals — **not** depth.

---

## 6 · Verification stamp (this report)

| Check                                     | Result                             |
| ----------------------------------------- | ---------------------------------- |
| Tip `origin/main`                         | `f96ac6b4`                         |
| nginx `/ws` + SPA `/` read                | Yes                                |
| svc-ws `/stream` only                     | Yes (`gateway.ts`)                 |
| trade `markets.id` UUID → matching submit | Yes (`trade-service.ts` + drizzle) |
| Live 16/10/∩0 re-probe                    | **No** — NO-FLEET; cite REGROUP §3 |
| Edits to matching / edge                  | **None**                           |
| Depth UI / invent markets                 | **None**                           |

**Stamp:** `proof_missing: fleet-blocked` for live market-set intersection. Structural path + ownership facts above are code-backed on tip.
