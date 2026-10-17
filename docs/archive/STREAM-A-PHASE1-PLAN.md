# Stream A Phase 1 — execution plan (audited)

**Owner:** Nitro Stream A · **Branch prefix:** `feat/app-*`  
**Claim:** [GitHub #83](https://github.com/Phantom-X-007/intafaced/issues/83) · [`NITRO-STREAM-A-CLAIM.md`](NITRO-STREAM-A-CLAIM.md)  
**Floor:** [`PEACE-OF-MIND-AUDIT-CURRENT.md`](PEACE-OF-MIND-AUDIT-CURRENT.md) · residual [`POST-MERGE-RESIDUAL-AFTER-86.md`](POST-MERGE-RESIDUAL-AFTER-86.md)  
**Product UI:** `vendor/*/05_Web_Front` → intended **http://localhost:8090** (compose) or host dev **:8080**  
**Claim tags:** `[VERIFIED 2026-07-29]` against origin/main `18c91c9`, open PRs, shell map, this Mac (no docker)

---

## Verdict (one breath)

**Prior split is mostly right for a money product** (structure/usable first, beauty parked, agents choose taste).  
**Needs change:** honesty is a **gate on every money-touching slice**, not checklist item #7 at the end; prices/candles are **spine-or-seed dependent** and must not become fake UI; dual-book label is mandatory before account panes feel “done.”  
**Phase 1 starts with:** shell boot + browser baseline (S0), then terminal honesty bar (S1), then only unblocked surface work.

---

## Delta vs prior plan

|              | Item                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kept**     | Denon-ordered surface list (terminal → prices → plane toggle → order entry → account panes → mobile → empty/error); agents pick existing shell patterns; small PRs; beauty deferred not abandoned; Nitro not component-picker                         |
| **Changed**  | Empty/error + money honesty **ride every money slice** (not only final #7). Visual sign-off **after demo-ready path**, not as a mid-loop art review. Order-entry “polish” = **safety** (validate, precision, confirm, honest reject) before cosmetics |
| **Added**    | Honesty bar · demo-ready vs pretty-ready · blocked-on-spine list · Phase 2 polish backlog · anti-collision protocol · slice PR shape · Nitro one-glance verify per slice · rollback · dual-book UI label · local Mac boot reality                     |
| **Rejected** | Fake non-zero prices without feed/seed · inventing multi-asset / licences · redesigning the product shell · new design system · Stream A editing `services/` “because Denon is offline” when open backend PRs would collide · full-repo archaeology   |

---

## Adversarial answers (required)

### What must be honest before “auto” is safe?

| Surface                  | Honesty rule                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prices / last / 24h**  | Show live only when feed answers. Zero + “No feed” is honest; invented ticks are not. Chart with no bars → “No history yet” / chart frame, not fake candles                     |
| **Balances / available** | Vendor wallet endpoints are **exchange shell balances**, not TypeScript ledger books. UI must not imply “platform books”                                                        |
| **Order fill / placed**  | Only claim success on real `code == 0` response. Timeout / null body → “not placed,” never optimistic fill                                                                      |
| **Fee preview**          | Label estimate; if rate unknown, show “—” not `0` as free                                                                                                                       |
| **KYC / plane**          | CEX (fiat/custodial) keeps member/KYC gates; DEX/protocol drops them **only where backend already does**. UI must not promise permissionless where region/sanctions still block |
| **Errors**               | Prefer IxState taxonomy (unreachable / not routed / unauthorized / scope / tier) over blank or generic grey                                                                     |
| **Halted market**        | Already partially present (`exchangeable`); keep and never soft-enable                                                                                                          |

### What prior chat under-specified?

1. **Data source for non-zero prices** — board: seed Java `market` candles **or** external history datafeed. Not a pure Vue paint job.
2. **API readiness** — Java market/exchange/uc + optional edge `:4000` must be up for live data; shell alone only proves layout.
3. **Demo seed ownership** — Stream B / ops for DB seed; Stream A owns UI degradation when empty.
4. **This Mac boot path** — docker absent here; compose `:8090` may be Denon’s machine. Host `npm run dev` on **:8080** + env targets is the fallback.
5. **Dual-book** — residual #1 is product law; account panes “wired” without a source label is trust debt.

### False UI if backend is down — fail honestly

| Temptation                                | Fail-honest alternative                          |
| ----------------------------------------- | ------------------------------------------------ |
| Seed hard-coded last prices in the client | Keep zeros + **No feed** / empty markets         |
| Cache yesterday’s ticks as live           | Show **Stale** timestamp or hide last            |
| Optimistic order success                  | Require response; “did not respond — not placed” |
| Hide empty order book                     | “No bids / No asks” (already in terminal)        |
| Collapse IxState reasons into “Error”     | Keep reason taxonomy on platform modules         |

### Where sub-agents help

| Stage                                              | Agent class                | Job                         |
| -------------------------------------------------- | -------------------------- | --------------------------- |
| Shell map (routes, terminal, account, chart entry) | explore / mechanical       | Once per wave, not every PR |
| One slice implement                                | implementer · one worktree | One concern                 |
| Money-display + empty-state critic                 | fresh read-only critic     | Before merge of money UI    |
| Brand scan / forbidden vendor names                | mechanical gate            | Every PR                    |

Do **not** fan out monorepo archaeology for sport.

### Cut as out of scope (Phase 1)

- New design system, component library migration, marketing landing redesign
- Multi-asset instruments merge · licence answers · Strix
- Java rebrand / Mongo `_class` migration
- Making shell the money books
- Rebuilding `apps/web`
- Beauty: motion, micro-illustration, custom icon set (Phase 2)

### Proof without Nitro watching every commit

| Proof                                    | Enough when                                       |
| ---------------------------------------- | ------------------------------------------------- |
| PR link + CI                             | Always for merge path                             |
| One-line Nitro verify                    | “Open URL X — look for Y — keep going / change Z” |
| Agent browser/screenshot                 | Layout/empty states when shell boots              |
| `pnpm verify` or justified narrow verify | Repo gate; shell may use lint/build + brand-scan  |
| Critic comment on money PR               | High-risk money display                           |

---

## Honesty bar (explicit — money UI)

**Pass** a money-touching screen only if all true:

1. No fabricated balances, fills, or prices.
2. Source of balances named when non-obvious (exchange wallet vs platform ledger).
3. Failed fetch never looks like “zero wealth” without a down/empty signal.
4. Order path: validate → confirm (or clear one-shot) → real API → honest reject.
5. Fee/estimate never reads as free when unknown.
6. Brand-scan clean; no partner/model vendor names in user copy.
7. Dual-book residual respected: shell never posts TS ledger recipes.

---

## Demo-ready vs pretty-ready

|          | **Demo-ready (Phase 1 exit)**                                     | **Pretty-ready (Phase 2)**                    |
| -------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Terminal | Layout loads; chart frame; depth/book; feed status honest         | Visual density, animations, chart skin polish |
| Prices   | Non-zero **only if** real seed/feed; else honest empty            | Sparkline aesthetics                          |
| Plane    | DEX/CEX (or Protocol/Exchange) toggle with correct gate copy      | Toggle art / microcopy craft                  |
| Orders   | Validation, precision, fee estimate honesty, confirm, rejects     | Button choreography                           |
| Account  | Panes call real endpoints; empty/error honest; dual-book label    | Table polish                                  |
| Mobile   | Drawer opens; primary nav reachable; terminal not unusable        | Full responsive redesign                      |
| Brand    | English + black/orange from #86; Nitro **yes/no** once demo works | Illustration, marketing pages                 |

---

## Blocked on spine / Stream B (do not DIY)

Open `[cross-stream] <file> — need` when blocked. Live re-check `gh pr list`.

| Block                                                  | Why Stream A cannot close alone            | Action if needed                                      |
| ------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------- |
| Candle / price history seed                            | Java market DB or external datafeed wiring | `[cross-stream]` seed script or market history source |
| Fleet redeploy (protocol/indexer 404s)                 | Edge + services                            | Denon ops — UI already has IxState                    |
| Multi-asset instruments                                | Ledger asset enum                          | **Denon only** — do not merge                         |
| CORS origin allowlist                                  | Java modules + product domains             | Nitro names domains → spine                           |
| Proxy new `/api/*` prefix · `main.js` · edge routes    | Shared spine files                         | `[cross-stream]`                                      |
| Licence Priority-1 (TradingView path, MySQL connector) | Legal                                      | Denon — do not invent                                 |
| Real rails / live chain                                | Product money                              | Residual queue                                        |
| Docker / compose on this Mac                           | Tooling absent here                        | Host npm dev or Denon’s machine for :8090             |

**Not blocked for UI structure:** rebrand #86 on main · terminal shell already large · IxState · account tab scaffolding.

---

## Anti-collision protocol

1. **Only** `feat/app-*` for Stream A product UI.
2. **Only** paths: `vendor/*/05_Web_Front/src/pages|components|assets/images`, `App.vue`, `routes.js`; append-only regions in `en.js` / `intafaced.css`.
3. **Never** edit open-backend PR territory: `services/`, `packages/`, `tooling/`, Java, compose, edge, proxy, `main.js`.
4. Before branch: `gh pr list` + `git worktree list` — no shared branch with other chats.
5. One concern per PR; rebase onto `origin/main` before push if main moved.
6. SPLIT-BOARD “territory suspended” banner does **not** authorize stomping open feature PRs — treat Stream A boundary as **collision law** even when permission is wide.

**Open PRs at plan time (do not stomp):** #89 pay mount · #91 trade tape · #93 webauthn · #94 token stake · #97 governance. (Re-check live.)

---

## Shell architecture (what exists vs missing)

| Area             | Exists on main                                                                                                                        | Gap for Phase 1                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Terminal         | `pages/exchange/Exchange.vue` — markets, chart TV widget, depth, book, trades, order entry, account tabs, Live/No feed, empty strings | Confirm step optional; dual-book label; plane toggle absent here  |
| Chart datafeed   | vendored TV + vendor datafeed module                                                                                                  | Empty history until seed/feed                                     |
| Account panes    | Balances / Positions note / Open / Fills / History wired to vendor APIs in code                                                       | Live proof; empty vs error distinction when login fails mid-fetch |
| Platform modules | `/platform` hub, bank/pay/p2p/token/… + **IxState**                                                                                   | Not Stream A demo path priority                                   |
| DEX page         | `/dex` descriptive module page                                                                                                        | Not a CEX↔DEX toggle on terminal                                  |
| Mobile drawer    | `App.vue` Drawer + platform submenu                                                                                                   | Post-retheme visual pass                                          |
| Rebrand          | #86 English black/orange                                                                                                              | Nitro sign-off once demo-ready                                    |

**Books:** TypeScript ledger only. Shell wallet/order APIs are **venue UI**, quarantined as books (peace residual #1).

---

## Ordered slices (complete set)

Each slice: one PR, one concern, browser proof when shell runs.

### S0 — Shell boot + browser baseline

- **Goal:** Prove layout on a real browser; file bugs only.
- **Area:** no product code required; docs note.
- **Deps:** node_modules + `npm run dev` (or compose :8090).
- **Cross-stream:** none for static shell; backends optional.
- **Done when:** terminal + drawer opened; checklist of visible issues logged on #83.
- **Nitro verify:** open terminal URL — see black/orange shell, chart area, order form.
- **Risk if wrong:** building blind on wrong surface (`apps/web`).

### S1 — Terminal honesty bar (money-safe defaults)

- **Goal:** Feed-down / zero prices never read as “live free market”; balances labeled exchange-not-ledger; unknown fee ≠ free.
- **Area:** `Exchange.vue` (+ append-only copy if needed).
- **Deps:** S0 preferred.
- **Done when:** No feed + empty history messages are unambiguous; balance footnote present.
- **Nitro verify:** with backends down, page still explains itself.
- **Risk:** over-warning scares demo — keep one short line, not walls of text.

### S2 — Prices / chart bars (honest non-zero **or** honest empty)

- **Goal:** Demo shows real-looking prices **or** explicit empty history — never fake ticks.
- **Area:** Stream A UI only for empty copy; seed is B.
- **Deps:** market service + seed **or** external history decision.
- **Cross-stream:** seed job / datafeed target.
- **Done when:** either bars present from real source, or UI clearly “no history yet” with working frame.
- **Nitro verify:** chart not permanently confusing zeros-as-live.
- **Risk:** client-side fake series → trust failure.

### S3 — DEX / CEX (plane) UI toggle

- **Goal:** User switches custodial exchange vs protocol/DEX surface; KYC copy only on custodial.
- **Area:** `App.vue` and/or terminal header + routes to existing `/dex` / `/exchange` / protocol. Prefer **existing nav patterns**, not new system.
- **Deps:** backend plane logic already exists (`checkAccess`).
- **Done when:** toggle changes route/mode; protocol path does not demand KYC UI; CEX still can.
- **Nitro verify:** one click DEX → no KYC nag; CEX → normal member path.
- **Risk:** UI promises permissionless while region block still applies — copy must mention region rules if known.

### S4 — Order-entry safety (not art)

- **Goal:** validation, precision clamp, fee estimate honesty, **confirm** before place, clear halt/disabled states.
- **Area:** `Exchange.vue` order panel.
- **Deps:** S1.
- **Done when:** bad input blocked; confirm shows side/amount/price/est fee; reject/timeout honest.
- **Nitro verify:** try place with empty amount — blocked; confirm appears when valid.
- **Risk:** confirm friction too high — one modal is enough.

### S5 — Account panes proof

- **Goal:** Balances / Open / History / Fills show **real endpoint data** when logged in; empty vs error distinct; dual-book label.
- **Area:** `Exchange.vue` account section (existing tables).
- **Deps:** uc/exchange APIs up + test user.
- **Done when:** each tab proven with data or honest empty; never silent blank.
- **Nitro verify:** signed-in demo account shows rows or “Nothing here yet.”
- **Risk:** showing vendor wallet as “your platform balance.”

### S6 — Mobile drawer post-retheme

- **Goal:** Drawer usable; platform modules reachable; terminal not broken at phone width.
- **Area:** `App.vue` drawer + terminal CSS if needed.
- **Deps:** S0.
- **Done when:** narrow viewport: menu opens, nav works, critical terminal actions reachable or gracefully stacked.
- **Nitro verify:** phone-width browser — open menu, hit Exchange + Platform.
- **Risk:** half-broken desktop while fixing mobile — keep changes local.

### S7 — Empty + error completeness (terminal + critical nav)

- **Goal:** Backend down never white-screens; IxState parity where platform modules already use it; terminal request() path audited.
- **Area:** Exchange + any Stream A pages still blank on fail.
- **Deps:** can parallel S1–S5 as a continuous bar.
- **Done when:** forced proxy-down still shows messages.
- **Nitro verify:** stop backends, reload — still readable.
- **Risk:** none if honest; delay of S7-as-last was the old plan’s bug — treat as continuous.

### S8 — Nitro visual sign-off (Phase 1 exit gate)

- **Goal:** “This is the product look” yes/no on rebrand + demo path.
- **Area:** none (human).
- **Deps:** demo-ready path (S0–S5 minimum; S6–S7 as available).
- **Done when:** Nitro answers keep / change list.
- **Nitro verify:** single guided URL tour (below).

### Rollback

- Each slice is one PR; revert = reverse merge.
- No force-push to main.
- Do not “fix forward” honesty regressions with cosmetics.

---

## Phase 2 polish backlog (parked, not forgotten)

1. Chart skin / interval chrome polish
2. Depth graph aesthetics
3. Order form motion / success confetti ban (keep calm finance UI)
4. Marketing index / help illustration pass
5. Icon set consistency
6. Dense-vs-comfortable density toggle
7. Full mobile terminal redesign (not just drawer)
8. Accessibility pass (focus rings, contrast audit)
9. Optional light theme (only if product wants)
10. Landing / invite page craft

---

## PR shape & agents

| Rule   | Detail                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------ |
| Branch | `feat/app-<slice>` from current `origin/main`                                                    |
| Size   | One slice; title `feat(app): …`                                                                  |
| Verify | Brand-scan · shell lint/build if feasible · browser path in PR body                              |
| Agents | explore once → implement → critic on money slices                                                |
| Docs   | Update #83 checkboxes; this file for plan truth; peace residual only if dual-book status changes |

---

## Nitro guided demo path (one glance)

1. Open shell base URL → home loads (black/orange).
2. **Exchange** → terminal: pair header, chart frame, book, order form.
3. Note **Live** vs **No feed** — matches reality.
4. Order form: empty amount cannot submit.
5. Account tabs: sign-in prompt or rows.
6. Mobile width: drawer opens.
7. Optional: **DEX/Protocol** path vs **Exchange** — no false KYC.
8. Say: **keep going** or **change Z**.

---

## Status log

| Date       | Note                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-29 | Plan authored on `feat/app-phase1-plan` from `origin/main` `18c91c9`.                                                                                                                                                    |
| 2026-07-29 | **S0:** Shell boots on this Mac with portable **Node 18** + host `npm run dev` on **:8090** (system Node 26 breaks old webpack; docker absent). Home + `/exchange` HTML 200. Java market backends not up → honest empty. |
| 2026-07-29 | **S1:** terminal honesty — no-feed labels, zero≠live print, fee “—” until symbol-info, dual-book balance footnote, chart no-feed copy. Landed via **#98**.                                                               |
| 2026-07-29 | **S3–S6 + S4/S5 core:** CEX/DEX plane toggle in shell nav; order confirm modal + placing state; account loading/error; mobile drawer routes + stop force-reg on exchange. Landed in **#98** squash (App + Exchange).     |
| 2026-07-29 | **S5/S7 polish:** unknown ≠ empty/zero for wallet and order tabs; Available shows “—” when wallet unreachable; dead duplicate `loadAccount` removed. Follow-up PR after #98.                                             |
| 2026-07-29 | **S2 still blocked** on market seed / external history (Stream B). **S8** only when Nitro chooses look tour — not a mid-loop gate.                                                                                       |
| 2026-07-29 | **Reference exchange UI screenshots:** not required — plan done-when criteria are specific enough for Phase 1; beauty stays Phase 2.                                                                                     |
| 2026-07-29 | **S7 continuous:** markets list / book / trades unknown≠empty; phone order form not clipped. Agent work — no Nitro eyes required.                                                                                        |
| 2026-07-29 | **Agent floor closed:** home market table unavailable≠empty; mobile drawer routes complete; fee reset on pair change; scoreboard + claim updated. Remaining: **S2 seed (#109)** · **S8 look tour (Nitro-only)**.         |

---

## Agent-complete floor (no Nitro eyes)

Phase 1 **agent surface work is done** when S0–S1 + S3–S7 are on main and continuous honesty holds. Not agent-closable:

| Item                                | Why                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| **S2** non-zero prices / chart bars | Needs Stream B seed — [#109](https://github.com/Phantom-X-007/intafaced/issues/109) |
| **S8** visual sign-off              | Nitro product call only                                                             |

---

## Links

| Doc                                                                  | Role                            |
| -------------------------------------------------------------------- | ------------------------------- |
| [`NITRO-STREAM-A-CLAIM.md`](NITRO-STREAM-A-CLAIM.md)                 | Territory + claim               |
| [`SPLIT-BOARD.md`](SPLIT-BOARD.md)                                   | Two-stream law                  |
| [`POST-MERGE-RESIDUAL-AFTER-86.md`](POST-MERGE-RESIDUAL-AFTER-86.md) | Money residual (not UI theater) |
| Issue #83                                                            | Checklist scoreboard            |
