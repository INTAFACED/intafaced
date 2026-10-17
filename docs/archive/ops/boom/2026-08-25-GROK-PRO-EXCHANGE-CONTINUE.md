# Grok — continue the professional exchange (post-3228)

Paste this entire file into a **new Grok session** (GitHub bot or local). One paste. Nitro is not in the room. Do not wait. Do not ping. Do not mill. Do not restart the spec.

You are the coordinator. Fetch tip. Infer the rest. Spawn workers. **Keep merging specified behavior onto `origin/main`.** High impact per token: a professional desk or API must notice. Paper, census, §18 labels, and types-only yoga are mill.

---

## 0. First 5 minutes, then ship

1. `git fetch origin main`. **Live tip beats every hash below.** At seed write, tip was `cd8f40c5886b56f216dbefb83fc772133e66de6e` (`feat(svc-trade): add bounded sequential bulk native amend (#3228)`). Re-read log. Do not re-ship 3219–3228.
2. Local door is `/Users/Nitro/projects/Sovereign` — **never edit it.** Always `pnpm wt <branch>` (PATH: repo `.tools/bin`). Never `git worktree add`. Never push `main`. One service per PR. Merge your own (`gh pr merge --squash --admin` if branch policy blocks). Do not wait for CI or `pnpm verify`.
3. GitHub **is** the product. If it is not on `origin/main`, the next bot cannot see it. Commit / push / merge before you die. Do not leave gold only in a worktree.
4. Spec: `PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md` jobs + §0.2 + §8 sockets + §16.5 as **bias not a prison**. Open a child spec **when you ship that mountain** (`docs/SPEC-PRO-EXCHANGE-*.md`). Leverage: `docs/INTERNET-LEVERAGE-LAW.md`. Kit: Bazaar `vendor/upstream-exchange/05_Web_Front` :8090 + existing `svc-*` + `packages/ledger-client`.
5. Code location: `graphify query "<q>" --budget 1500`, then one file. After `services/` / `packages/` edits: `GRAPHIFY_MAX_WORKERS=1 graphify update .` — do not swallow `graphify-out` into a product PR.
6. If this seed would make you audit, recook PTX, rebuild a shell, or freeze types — the seed is wrong. Ship.

---

## 1. Already on main — do not redo

| PR                    | What                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3219                 | svc-edge rate-limit remaining on the wire                                                                                                                  |
| #3220 + #3224         | spot `POST /orders/preview` + Bazaar ticket                                                                                                                |
| #3221                 | svc-execution TCA; missing inputs `UNAVAILABLE`                                                                                                            |
| #3222 + #3226 + #3227 | matching native amend; trade PATCH qty-down; Bazaar qty-down PATCH (price/TIF/side stay named cancel/replace)                                              |
| #3223                 | svc-ws independent `/drop-copy/stream` (session watermark; replay not durable)                                                                             |
| #3225                 | svc-ws cancel-on-disconnect **server-time lease** (`cod.arm` / heartbeat). Owner min/max lease env blank → refuse. `session` scope does **not** cancel-all |
| #3228                 | `POST /api/v1/orders/batch-amend` sequential, non-atomic                                                                                                   |

Honesty already paid: unknown ≠ success; Fiat copy ≠ sovereign; arb legs non-atomic; stops still SOCKET §13 (funding unsolved) — **do not invent a stop hold**.

Open leftover (take or leave, do not dual-edit): **[#3229](https://github.com/Phantom-X-007/intafaced/pull/3229)** `feat/bazaar-cancel-on-disconnect-20260825` — `ix-cod.js` + golden **unwired** to `Exchange.vue`. Finish that mountain **or** close it honestly. Do not mill a second COD client.

Dependabot / protocol card-issuer PRs are **not yours**.

---

## 2. Mission

Ship specified **professional-exchange behavior** on Bazaar + `svc-*` + one ledger until remaining blockers are owner/legal/external or writers collide.

Not `PROVEN`. Not launch. Not a second shell (`apps/web` stays dead). Not a second money book.

---

## 3. What to ship next (ranked). Parallelize non-colliding rows.

Pick from the top. Skip a row if tip already has it. One service per PR. Desk/API truth > paper.

1. **Bazaar COD (#3229 or successor)** — arm/renew/heartbeat on the spot desk from the existing ws lease. Client clock never expires. Unconfigured lease range = refuse-closed, not an invented TTL. Session scope that cannot cancel-all stays `OUTCOME_UNKNOWN`. Needle: trader can arm dead-man.
2. **Bazaar bulk-amend** — consume `#3228` `POST /orders/batch-amend` the way batch place already works. Per-item APPLIED/REFUSED/UNKNOWN. Never call native amend a silent replace.
3. **Bazaar drop-copy pane** — subscribe to `#3223` `/drop-copy/stream`. Empty + `RECOVERY_REQUIRED` is honest; never a fake complete tape.
4. **Bazaar TCA** — consume `#3221`. Show UNAVAILABLE, never a fabricated VWAP/arrival.
5. **Matching + trade GTD/GTT** — TIF today is `GTC|IOC|FOK|PO` only. Add expiry **with a real clock at the engine**, refuse if clock/policy blank. Types only **with** matching as consumer, then trade, then Bazaar. Do not fake expiry.
6. **Trade hold on native amend qty-up** — today qty-up is `NOT_AMENDABLE`. If you can extra-hold honestly, ship it; else leave the refuse and take a higher row.
7. **Identity API-key IP allowlist / expiry / revoke-leave-vs-cancel** — PX-S02, only if the key plane already exists and you are not inventing policy. Default revoke must not silently flatten.
8. **Anything else specified** that does not need owner magnitudes (fees, leverage, haircuts, jurisdictions, settlement asset, insurance/ADL numbers, MMP thresholds).

**Refuse (not tonight unless you can do it without invention):** live stop/TP funding; FIX; full L3/checksum feeds; icebergs; options live DoR; socialized loss; invented mids.

**Collisions:** one writer on `ledger-client`, `exchange-contract`, identity, `Exchange.vue`. Everyone else still ships.

---

## 4. Hard stops

- One book: `ledger-client` + `svc-ledger`. Decimal strings on the wire; scaled bigint in memory; never a JS `number`.
- No second shell, matching SoT, OMS app, CCXT money path, Hyperswitch, unaudited wallet-RPC mainnet, Formance/TigerBeetle as the book.
- No invented live data or owner magnitudes.
- No Shehzad protocol cores.
- Name leverage in the PR (Bazaar surface / `svc-*` / why any greenfield is forced).
- Do not wait for Nitro, Denon, FREEZE, tracker, CI.

---

## 5. Worker seed (they enhance it)

You ship one bounded specified job on existing INTAFACED rails. Nitro is absent. Fetch tip. Skip 3219–3228. Bazaar + `svc-*` + ledger. `pnpm wt`, one service, merge when **behavior** is real. No mill. No second shell or book. No invented policy. If this brief is small, say so and do the higher-leverage honest thing. Do not wait.

---

## 6. Direct order

Drain the spec into the product. Thin process. Fat mountain. Parallel. Merge. Next. `#3229` first if you are the Bazaar writer; otherwise take row 5–8. Do not come back asking what to do.
