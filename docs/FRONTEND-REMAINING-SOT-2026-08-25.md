# Remaining product UI — source of truth

**Status:** Living frontend inventory and closure specification · **north-star UI map added 2026-08-31**<br>
**Shipped chrome PRs on `origin/main` [RAN-IT]:** desk `#3313` · money `#3358` · bank `#3371` · pay `#3375` · p2p `#3379` · platform OS `#3380` · public `#3384` · route close `#3385` · ticket TIF `#3388`  
**Finish implementation:** `#3406` + residual `#3419`; graph refresh `#3408/#3445`; P0s `#3453/#3459/#3460/#3461/#3462/#3463`; route matrix `#3456/#3457`.<br>
**Codex 2026-09-01 on tip [RAN-IT]:** chart races `#3672` · admin queues `#3673` · session cleanup `#3674` · residual numbers `#3675` · uiproof fail-closed `#3676` · layout reset `#3677` · Node 24 `#3678` · chart a11y `#3679`.<br>
**Grok TRUTH wave on tip [RAN-IT]:** hashed Tier-A 178 `#3872` · RUM policy `#3871` · admin boundaries `#3873` · Reset+⌘K `#3874` · STOMP refuse `#3878` · skip/404 `#3879` · reduced-motion `#3880` · 320 reflow `#3881` · bind-unknown `#3883` · dod-gate `#3946` · 768/1024 `#3949` · `/platform` 320 `#3986` · N4 loading-bar `#3988` · N4 catalog titles `#4088` · member orange janitor `#4163`.<br>
**Current closure bar:** §§9–18 (shell safety/proof) **and** §§19–21 (north-star terminal map). The 2026-08-26 prompt is execution history, not live law. Status remains **frontend baseline shipped; closure in progress** until §18.2 is all-true.<br>
**Codex paste:** [`PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md`](PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md)<br>
**Tip at this map:** worktree base `origin/main` (re-derive: `git log -1 --oneline origin/main`). Do not inventory the Grok door checkout.<br>
**Product UI:** Bazaar `vendor/upstream-exchange/05_Web_Front` `:8090` only. No second SPA. N4 paint. Ledger-client only for value.

This file names **every frontend surface and every remaining closure gate**. It is the sole living frontend _execution_ map. Product terminal law stays in [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) **M07/M25** and [`SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md`](SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md) (PX-S05). This file maps those R-items onto Bazaar; it does not recook them. Sections 0–8 are 2026-08-26 baseline; §§9–18 win on shell safety; §§19–21 win on “what the exchange UI still owes.” Do not create another frontend tracker or paste this whole file as one PR.

---

## 0 · What “the rest” is

The desk is the trade surface. The rest is **everything a member still opens**: sign-in, the ledger book, bank/pay, OTC, OS modules, marketing/CMS, staff admin, later chart power.

Locked from 2026-07-31 (still true): **desk before CMS**. N4 is closed. Honesty vocabulary stays. Green/red = market only.

---

## 1 · Excellence order (named, in order)

| #   | Mountain                    | Pack when                                                                                                      | Codex now?                  |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 0   | **Trader desk** `/exchange` | Done `#3313` · glance verified 2026-08-25                                                                      | No                          |
| 1   | **Money OS**                | Code `#3358` · **eye not re-checked**                                                                          | No                          |
| 2   | **Bank** `/bank/*`          | Code `#3371` (glance tiles in `Bank.vue`) · **eye not checked**                                                | No                          |
| 3   | **Pay** `/pay/*`            | Code `#3375` (same tile pattern, **no SHOW-PAY**)                                                              | No                          |
| 4   | **OTC / C2C**               | `/p2p` OS `#3379`; `/otc` `/ctc` still **desk-mode** routes                                                    | No                          |
| 5   | **OS modules**              | Chrome unify `#3380`/`#3385` (small diffs, compact IxState)                                                    | No                          |
| 6   | **Marketing / CMS**         | Homepage + help/notice/invite `#3384`                                                                          | No                          |
| 7   | **Staff admin**             | `#3406` craft + `#3460` fail-closed. Queues still launchers                                                    | **§20.6**                   |
| 8   | **Chart host**              | LWC 5.2.1 **interim**. **Advanced Charts** after approval. Drawings/compare on AC. Alerts/replay still refuse. | **No AC code** until access |

---

## 2 · Complete surface list (every route group)

Live = page exists and talks to a real `svc-*` or ledger. **Refuse** = honest not-built (must stay). **Mall** = marketing chrome we kill on money/desk, keep on marketing routes.

### 2.1 Money OS (mountain 1 — deep spec in money SoT)

| Route                                                | File                           | Live fact                                                            | Job                                                                                    |
| ---------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/uc/money`                                          | `components/uc/MoneyIndex.vue` | Ledger balances. **No fiat total** (no rate source). Dual-book note. | N4 ledger book. Glance in ~2s.                                                         |
| `/uc/record`                                         | `Record.vue`                   | History                                                              | Same book, history tab                                                                 |
| `/uc/entrust/current` `/history`                     | `Entrust*.vue`                 | Open / past orders                                                   | Orders in the money OS, link back to desk                                              |
| `/uc/account` `/uc/safe`                             | `Account.vue` `Safe.vue`       | Identity / security                                                  | Quiet settings, not a CMS                                                              |
| `/uc/recharge` `/uc/withdraw` `/uc/withdraw/address` | `CustodyNotBuilt.vue`          | **Refuse.** No chain custody until wallet-RPC review.                | Keep one refusal. N4 it. **Do not rebuild Java withdraw.**                             |
| `/platform`                                          | `pages/intafaced/Platform.vue` | Identity session hub                                                 | One session story. Desk “Log in” already points here.                                  |
| `/login` `/register` `/findPwd`                      | `pages/uc/Login.vue` etc.      | Auth                                                                 | N4 card. Success → **`/exchange`** (locked 2026-07-31). Wallpaper login_bg is residue. |
| `/uc` MemberCenter shell                             | `pages/uc/MemberCenter.vue`    | iView **light** sidebar + promo/innovation mall                      | OS header + **money rail only**. Kill promo cards as peers of balances.                |

### 2.2 Bank (mountain 2)

`/bank` `/bank/spaces` `/transfers` `/earn` `/loans` `/cards` `/ramps` `/analytics` `/business` — `pages/intafaced/Bank.vue` + `bank/*`. Live `svc-bank` + IxSubNav. Job: N4 + quiet IxState; **label vs `/uc/money`** (dim 21). Do not invent card/ramp issuers (Class X).

### 2.3 Pay (mountain 3)

`/pay` + money/merchant/network/permissions/links/payments/settlements/checkout — `svc-pay`. Job: merchant/checkout craft. **No Hyperswitch.** Gateway/PSP are Class X — UI must not fake a live acquirer.

### 2.4 OTC / C2C (mountain 4)

`/otc` `/otc/trade/*` `/ctc` `/uc/ad` `/uc/order`. Job: desk-adjacent P2P, not a mall. Dual-book if fiat vs ledger.

### 2.5 OS modules (mountain 5) — already `ix-page` + `svc-*`

Academy, Launch, Support, Ops, Portfolio, P2P, Token, Agents, Blueprint, Protocol, Dex, Chain, Quant, Execution, Market, Predict, Mining.

Job: **one OS chrome** (header + subnav + quiet honesty). Not 15 landing pages. Empty/error = IxState compact. Do not invent data so they “look live.”

`/dex` is protocol plane — keep plane honesty; do not clone the CEX desk.

### 2.6 Marketing / CMS (mountain 6 — last)

`/` Index, `/lab`, `/invite`, `/partner`, `/bzb`, `/announcement`, `/help*`, `/about-us`, `/app` (APK never existed — already honest).

Job: later. Must not sit on `/exchange` or `/uc/money`.

### 2.7 Staff admin (mountain 7)

Live console = **`apps/admin`**. `04_Web_Admin` stays undeployed. Not trader UI.

### 2.8 Chart host (mountain 8)

LWC 5.2.1 + RSI/MACD **already on tip** (interim). **Intended host:** TradingView Advanced Charts after approval (`LICENCE-POSITION.md` §1.1a). LWC plan A6 is historical. Do not code AC until access.

---

## 3 · Leverage (do not vibe)

| Need                     | Phase A                                                                                            | Forbidden                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shell                    | V-SHELL `:8090`                                                                                    | New SPA, Tailwind/shadcn, resurrect `apps/web`                                           |
| Money numbers            | `packages/ledger-client` + `svc-ledger`                                                            | Second book, Java ucenter, fixture-seeded balances                                       |
| Bank / pay / p2p / …     | matching `services/svc-*`                                                                          | Rewrite the domain                                                                       |
| Custody deposit/withdraw | **Refuse** until wallet-RPC review                                                                 | Fake addresses, invented fees, pretty custody                                            |
| Chart power              | **Intended:** Advanced Charts after approval (`LICENCE-POSITION.md` §1.1a). **Interim:** LWC 5.2.1 | Pirate TV copy; Widgets iframe; drawing-npm fake; Trading Platform unless owner names it |
| Admin                    | `apps/admin`                                                                                       | Restyle undeployed `04_Web_Admin`; third console                                         |
| Auth                     | real session / existing fixture                                                                    | Seeded money as “proof”                                                                  |

Internet leverage = extend these pages. Not npm a wallet dashboard.

---

## 4 · Cross-cutting law (all remaining mountains)

1. **N4** — near-black, 1px, no glass, restrained identity accent `#FF6B00` in named slots only, no P21 teal. Market green/red only.
2. **Quiet honesty** — one line; `Details` for endpoints. Failed ≠ `$0` ≠ empty.
3. **Dual-book labeled** — venue wallet vs platform ledger vs bank space.
4. **No fake live-ness.**
5. **OS chrome vs desk chrome** — `/exchange` stays desk-mode (`#3313`). Money/OS get a **thin OS header** (wordmark, module, account), not the ticker row, not Lab/Announce.
6. **iView 3 one kit.** Radius-0 on these pages; if tabs break, replace tab chrome **on the page**.
7. **390** is first-class.
8. **One mountain per PR.**
9. **Graphify** does not map vendor Vue — open the Vue file.
10. **Worktree** `pnpm wt` off tip. Copy untracked SoT files first. `STREAM_A_NODE` = sibling `.tools/node18` if needed. Never the Grok door.

---

## 5 · What we are _not_ speccing as a fake product

- A Coinbase-style **deposit/withdraw rail** while custody is refuse. The refusal _is_ the product until Denon/wallet-RPC.
- A second trading desk on `/dex` unless a written hole says Bazaar cannot do plane-in-desk.
- Widget-canvas Hyperdash (Wave C).
- AI homepage, promo carousel, more tabs as quality.

---

## 6 · Implicit needs (rest of UI)

1. After the desk, a pro still has to **see money and get in**. If `/uc/money` still looks like 2018 iView light + a wallpaper login, the desk win dies on the next click.
2. **Logged-in lands on the desk** (already locked). Money is one hop from the account chip.
3. Custody honesty must **look designed**, not like a bug.
4. Bank vs ledger must not show two different “totals” without labels.
5. He will not pick N1–N4 again.
6. He looks at pictures, not PR bodies. Each mountain gets a SHOW-*.html before Codex.
7. Spec just-in-time for the _next_ mountain’s layout; this file stays the full map so nothing is silently dropped.

---

## 7 · Flip

Wrong if Nitro says money is not next; if wallet-RPC becomes live (then withdraw is a **new** pack, not a silent restore of Java); if a second SPA becomes law (ADR).

---

## 8 · 2026-08-26 execution handoff (historical)

The local `PROMPT-CODEX-FRONTEND-FINISH-2026-08-26.md` drove `#3406/#3419`. It is not present on `origin/main` and is not the live finish bar. Sections 9–18 below supersede it without erasing the implementation history.

---

## 9 · 2026-08-31 closure verdict

The named finish set is substantially implemented, but the frontend is **not certifiably complete**. The earlier crop pass proved valuable visual work; it did not prove every route, state, safety boundary, browser interaction, or implicit professional-product requirement.

### 9.1 Confirmed P0 defects

| ID       | Defect                                                                                                                                                                                    | Why it is P0                                                                                                    | Closure evidence                                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FE-P0-01 | `apps/admin` BFF authentication is optional when its shared-secret configuration is blank; consequential routes can reach handlers without a fail-closed authenticated operator boundary. | Money/control-plane integrity. Blank configuration must deny, never weaken.                                     | Anonymous, blank-env, expired, wrong-role, CSRF/origin, and valid-MFA browser/API tests for every mutating admin route. The service-authored actor appears in the receipt.                                                                                                                   |
| FE-P0-02 | Member chart/market/indicator paths convert decimal-string economic values with `Number`/`parseFloat` and retain them as JS numbers.                                                      | Violates the repository money representation law and can reorder or round close values.                         | Decimal-string wire fixtures become scaled bigint/fixed-point canonical state. Property tests cover 38-digit, 18-decimal, >2^53, adjacent-tick, zero, and negative inputs. A lossy number may exist only at the final canvas coordinate boundary and never feed business state or wire data. |
| FE-P0-03 | The exchange market drawer is hidden by a later `display:none!important` cascade at tablet/mobile widths even when `.is-open`.                                                            | A user can open the state but cannot switch pairs. Core trade navigation is unreachable.                        | Browser tests at 390, 768, and 1024 open the pair drawer, move focus, select a pair, update URL/header, close with Escape, and prove no page overflow.                                                                                                                                       |
| FE-P0-04 | The router guard/interceptor still accepts or reads legacy `TOKEN`/`MEMBER` local-storage state before the store clears it.                                                               | Creates a brief, contradictory authorization path and can paint/fire protected UI from stale or forged storage. | One session authority only. Forged/stale storage cannot unlock or paint a protected route. Expiry/logout closes private sockets, clears the correct state, preserves a safe redirect, and is tested across tabs and reload.                                                                  |

### 9.2 Confirmed P1 product gaps

Re-derived against merged PRs on `origin/main` (do not re-implement landed rows):

1. **Landed `#3872` / `#3676` / `#3986`.** Matrix is 89 member routes. Durable hashed F1 crops are 178 cells in `tooling/uiproof/crops/look-tier-a-f1/SHA256SUMS`. `/platform` 320 closed. Remaining: other fixture classes.
2. **Superseded by §20.** Amend from the ticket. Chart drag-reprice waits Advanced Charts access (SOCKET). Do not build a LWC drag stand-in.
3. **Partial `#3673`.** Users/orders/finance queues exist as source-backed or explicit unavailable. Withdrawal approval stays `NOT MOUNTED` — no procedure. Queue _look_ is still Codex.
4. **REFUSED `#3878`.** Chart is REST snapshot + as-of. Live STOMP client is refused, not a look polish. Latest-request-wins on the existing host remains Grok TRUTH if a live door appears.
5. **Still OPEN.** Touch alternatives and named AT (VoiceOver/TalkBack) are not Axe and not 320/768/1024 reflow. Keyboard Fit/Follow `#3679` is not this.
6. **Landed `#3677` / `#3874`.** Reset + ⌘K orphan round-trips exist. Org layout-share stays SOCKET.
7. **Landed `#3873`.** Admin route-level error/not-found/loading exist. Withdrawal stays unmounted.
8. **Policy `#3871` / `#3851`.** Browser-support + RUM policy on tip. Field RUM collector REFUSED until named. Lab CWV is guidance, not a pass.
9. **Partial `#3678`.** Node 24 + webpack 5 on the member build. Vue 2.7 / less-loader leftover is LATER toolchain, not a silent Node 16 proof.

### 9.3 Confirmed P2 enhancements

- Named/versioned layout Save, Save As, Reset, and import/export only after the single-layout behavior is correct.
- Better chart range, zoom, pan, fit, and follow-live controls; never gesture-only.
- Structured, recoverable admin receipts and operator deep links.
- Broader visual baselines, field telemetry, and worker offload only where profiling proves need.

## 10 · Outcome and boundaries

### 10.1 Outcome

A professional user can enter, navigate, understand state, inspect market data, stage and authorize an order, manage open orders, inspect money, and recover from stale/down/unknown conditions without being lied to or trapped. An operator can inspect real queues and perform only server-authorized consequential actions with exact confirmation, lock, reconciliation, and durable receipt. Every claim is reproducible from the branch under test.

### 10.2 In scope

- Bazaar member SPA: `vendor/upstream-exchange/05_Web_Front`.
- Operator console: `apps/admin`.
- Existing shared UI/contracts used by those surfaces.
- Frontend build, browser security, accessibility, performance, telemetry, and `tooling/uiproof`.
- Honest UI for missing backend contracts.

### 10.3 Out of scope

- A second member SPA, `apps/web`, a new design system, or a replacement exchange kit.
- A second money book or any frontend-owned economic authority.
- Invented custody, card issuer, acquirer, FX, candle, alert, approval, or multi-market APIs.
- Backend feature invention inside a frontend PR. Missing contracts become typed dependencies and refuse-closed UI.
- A Vue rewrite disguised as polish. Toolchain work must be incremental and behavior-preserving.

## 11 · How implicit requirements are inferred

Every frontend lane must perform this loop before code:

1. **Name the user decision.** What does the user believe, choose, authorize, or recover from on this screen?
2. **Name the authority.** Which existing `svc-*`, ledger, identity session, or market feed owns the fact? If none exists, refuse closed.
3. **Enumerate states.** At minimum: loading, reachable-empty, live, stale, partial, refused, unauthorized, unconfigured, malformed, timeout, unknown outcome, and recovered.
4. **Follow the transitions.** Refresh, back/forward, reload, duplicate tab, slow response, response reordering, disconnect/reconnect, expiry, resize, zoom, and route change.
5. **Check all input modes.** Keyboard, single pointer, touch, screen reader, zoom/reflow, reduced motion, and storage-disabled mode.
6. **Research only the unstable or normative question.** Use current primary sources, record the date/version, and translate the finding into a repo-specific acceptance test. Research must not introduce a second stack.
7. **Write the falsifier first.** State the observation that would prove the feature unsafe, dishonest, inaccessible, or incomplete.
8. **Close with durable evidence.** Unit/golden tests prove math and parsers; browser tests prove behavior; committed baselines or attached immutable artifacts prove pixels; the scorecard indexes evidence but does not replace it.

### 11.1 Mandatory research prompts

| Before changing                    | Research question                                                                                                                           | Primary sources                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Chart/panes/reprice                | What does the vendored LWC version actually support for panes, price lines, hit testing, ranges, tracking mode, cleanup, and accessibility? | Matching-version Lightweight Charts docs/source/license only. TradingView proprietary Charting Library is not an option.       |
| Authentication/admin authorization | What must be browser-held, cookie-held, server-enforced, reauthenticated, CSRF-protected, logged, and revoked?                              | Current `svc-identity`/admin contracts first; then NIST SP 800-63B and OWASP session/transaction authorization guidance.       |
| Accessibility                      | Which WCAG 2.2 AA criteria apply to dense controls, dragging, chart canvas, status changes, sticky chrome, and reflow exceptions?           | W3C WCAG 2.2 Recommendation and Understanding documents.                                                                       |
| Build/runtime                      | What supported Node/browser/toolchain path preserves this SPA with the smallest migration boundary?                                         | Official Node, Vue, webpack, Babel and dependency migration/support pages.                                                     |
| Operator lists                     | Which real query contracts exist and what is their pagination, freshness, authorization, and row identity?                                  | Repo contracts and service code first. External design research only after the real data boundary is known.                    |
| Performance                        | Which user-visible latency is poor, and is the cause DOM, parsing, chart work, network, or feed burst?                                      | Profile this tree first; use Web Vitals and browser performance APIs for measurement, never a framework rewrite by assumption. |

### 11.2 Researched landscape baseline

Normative and security baselines:

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) is the accessibility target. Its guidance specifically requires alternatives to authored dragging and a 24×24 CSS-pixel target/spacing floor.
- [NIST SP 800-63B session guidance](https://pages.nist.gov/800-63-4/sp800-63b.html#session-management), [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) inform session storage, reauthentication, server enforcement, and what-you-see-is-what-you-sign confirmations. They do not replace repository contracts.
- [Node release status](https://nodejs.org/en/about/previous-releases) records Node 16/18 as EOL. [Vue's official lifecycle page](https://v2.vuejs.org/lts/) records Vue 2 as EOL. The plan therefore contains an in-place support lane, not a second SPA.

Product and implementation signals, not legal standards:

- [Lightweight Charts accessibility](https://tradingview.github.io/lightweight-charts/tutorials/a11y/intro) states that the library does not supply accessibility behavior by default; its keyboard/ARIA/description layer must be integrated by the product. Official tutorials also expose [panes](https://tradingview.github.io/lightweight-charts/tutorials/how_to/panes) and [price lines](https://tradingview.github.io/lightweight-charts/tutorials/how_to/price-line), supporting the staged chart interaction specified here.
- [CME EBS keyboard navigation](https://www.cmegroup.com/tools-information/webhelp/ebs-workstation-quick-guide/Content/Keyboard-Navigation.html) and [IBKR hotkey configuration](https://www.interactivebrokers.com/campus/trading-lessons/configuring-tws-hotkeys/) support discoverable, scoped shortcuts and cautious transmission defaults.
- [LSEG Workspace layout administration](https://www.lseg.com/content/dam/data-analytics/en_us/documents/support/workspace/administration-panel-configuration-guide.pdf) supports named, versioned Save/Save As/autosave semantics; this is why opaque persistence is completed before optional multi-layout expansion.
- [Core Web Vitals](https://web.dev/articles/defining-core-web-vitals-thresholds) provides the initial LCP/INP/CLS measurement thresholds. These are performance guidance, not proof of product correctness.
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots) recommends reviewed, versioned baselines and a controlled rendering environment. [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing) explicitly requires automated checks to be combined with manual assessment.
- [GOV.UK confirmation pages](https://design-system.service.gov.uk/patterns/confirmation-pages/) support stable reference numbers, next steps, and recoverable transaction records after completion.

## 12 · Cross-cutting product requirements

### 12.1 Truth and money

- Economic values remain decimal strings on the wire and fixed-point/scaled bigint in canonical memory.
- Unknown, unavailable, refused, stale, malformed, and reachable-zero are different types and different UI.
- Every displayed balance/order/price states its book or venue when ambiguity is possible.
- Market and account facts carry source and freshness. Client clocks never manufacture feed truth.
- Reordered responses and reconnects cannot overwrite the active pair/interval with stale data.
- No optimistic success for consequential writes. Timeout is unknown until authoritative reconciliation.

### 12.2 Navigation and session

- Route metadata names the required authority; a generic truthy “session” is insufficient.
- Deep links, redirects, back/forward, refresh, logout, expiry, and cross-tab state are deterministic.
- The member SPA holds no bearer token in local/session storage. The access token stays in memory; the refresh token is an HttpOnly, SameSite=Strict cookie set by svc-edge, so a reload, a second tab or a pop-out window renews the session through `POST /api/identity/session/refresh` (tabs coordinate with Web Locks and a BroadcastChannel; `apps/customer/src/features/session/session-sync.ts`).
- Protected content never paints before the authority check completes.
- Every route has a meaningful document title, stable main heading, skip path, and branded 404.

### 12.3 Responsive and accessibility

- WCAG 2.2 AA is the target. Automated scans help but do not certify it.
- Whole-page reflow works at 320 CSS px and 400% zoom. Essential two-dimensional chart/table regions may scroll internally, are labeled, and provide equivalent summary/actions.
- Test 390 portrait plus 768/1024 tablet widths, 1440 desktop, and representative landscape. No orientation lock.
- Pointer targets meet 24×24 CSS px or the WCAG spacing exception; submit/cancel/high-risk controls target at least 44 px where layout permits.
- Every authored drag interaction has a single-pointer non-drag alternative and a keyboard alternative.
- Sticky headers, dialogs, virtual keyboards, and error summaries never obscure focused controls.
- Status messages are programmatic and restrained: announce decision-relevant state, not every market tick.
- Color never carries side, movement, danger, or status alone.
- LWC panes expose focusable regions, keyboard point/series navigation, a concise textual summary, and high-contrast/scalable text behavior.

### 12.4 Resilience and recovery

- Network loss, service refusal, malformed payload, timeout, partial data, websocket gap, tab backgrounding, and visibility return each have explicit behavior.
- On visibility/focus/reconnect, private and market snapshots are revalidated; elapsed client time does not prove freshness.
- Duplicate clicks/tabs are absorbed by server idempotency and visible client locks.
- Error boundaries isolate a failing module and preserve navigation/logout.
- Retry never clears the last honest state or turns unknown into success.

### 12.5 Security and privacy

- Admin routes deny when authentication/authorization configuration is blank.
- Client hiding is never authorization. Server role/scope and recent authentication own the decision.
- Consequential confirmations bind the exact target and transaction facts (“what you see is what you sign”).
- Tokens, secrets, raw PII, authorization material, and sensitive receipts never enter logs, telemetry, URLs, or persistent browser storage.
- CSP begins report-only, then moves to exact sources, `object-src 'none'`, `base-uri 'none'`, appropriate `form-action`, and `frame-ancestors`; embeddable checkout/widget routes are scoped separately.
- Logout/expiry closes private sockets and clears browser-held state. External links use safe opener/referrer behavior.

### 12.6 Performance and observability

- Define a browser-support policy before baselines. Minimum proposed matrix: current Chromium, Firefox, and WebKit equivalents used by Playwright.
- Lab budgets begin with LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1 on representative hardware/fixtures; field results use the 75th percentile and are segmented mobile/desktop.
- Desk measures additionally: first honest book state, first accepted candle, ticket validation latency, submit-to-ack/unknown, reconnect duration, update coalescing, and long animation frames.
- Feed bursts are coalesced; long ladders/blotters are virtualized only after profiling; hidden tabs reduce noncritical rendering.
- Telemetry carries redacted correlation IDs and distinguishes client error, service refusal, timeout, and unknown write outcome.

## 13 · Exchange-specific closure

### 13.1 Chart and feed

- LWC remains vendored with pinned version/hash, Apache license, NOTICE, and attribution.
- Candle adapters reject numeric economic fields and malformed/reordered bars.
- RSI/MACD fixed-point goldens precede rendering; pane creation, removal, resize, precision, empty input, partial history, interval change, and teardown are tested.
- UI labels snapshot/live/stale/reconnecting and an as-of time. No stream means no “live” implication.
- Pair/interval request races are latest-request-wins. Old requests/subscriptions cannot mutate the new view.
- Zoom, pan, fit/reset, and follow-live are explicit controls in addition to gestures.

### 13.2 Reprice

Actual drag-reprice is allowed because an amend path exists, but dragging must only **stage** an edit:

1. An eligible open order renders a labeled price line.
2. Drag/tap/keyboard changes snap to the instrument tick using fixed-point math.
3. The UI shows original price, proposed price, remaining quantity, side, delta, and any service-authored preview.
4. Partial fill, cancellation, permission loss, stale order version, or feed loss invalidates/reloads the stage.
5. Release never submits. Review and explicit confirmation invoke the existing amend flow with idempotency and unknown-outcome recovery.
6. The current price input remains the accessible non-drag alternative.

Price alerts and multi-market remain disabled with a named missing API until a real contract exists.

### 13.3 Saved layout and shortcuts

- Persist pair, interval, book mode/group, panel widths, pane visibility, logical visible range, and follow-live as validated, versioned presentation state.
- Scope user-specific preferences by stable principal; never leak one account's selection to another.
- Corruption, quota refusal, private mode, old schema, unavailable pair, and breakpoint change fall back visibly and safely.
- Provide Reset layout before Save As/import/export.
- Browser tests prove full save/reload/remount/account-switch round trips, not helper normalization only.
- Full shortcut map stays in-product. Shortcuts never fire inside editable/composition contexts and expose an armed/focus scope. Instant transmission is out of scope unless separately specified and opt-in.

## 14 · Admin-specific closure

### 14.1 Authentication and authority

- Every admin page and BFF route requires authenticated operator identity and server-verified role/scope.
- Blank/malformed auth configuration returns a typed refusal before any consequential handler.
- State-changing requests enforce CSRF/origin protections and recent MFA/reauthentication according to action risk.
- Environment, operator, scope, authority source, reachability, and freshness are visible. Unknown is never styled as safe/off.

### 14.2 Dense work queues

Users, orders, and finance each need either a real query-backed table or an explicit unavailable state. A command launcher is not a queue.

Each real queue provides:

- stable record ID and deep link;
- total/page facts, paging, stable sorting, filters, refresh, age/SLA, and as-of time;
- loading, empty, stale, partial, refused, unauthorized, malformed, and unreachable states;
- PII minimization/masking and accessible table semantics;
- row-scoped actions bound to the displayed record version;
- no bulk command before the operator can inspect its target set.

Withdrawal approval remains non-interactive until a real server procedure exists. The absence itself is a passing honest state.

### 14.3 Consequential actions and receipts

- Final confirmation states environment, actor, target, current state, requested state, blast radius, reason, and whether the operation is live, staged, or inert.
- Typed phrase/reason/reauth requirements are service/action specific.
- Submit locks against duplicate intent. Timeout/transport loss yields unknown and a reconcile path.
- Completion shows immutable command/correlation/idempotency ID, actor, target, requested and returned state, service timestamp, verdict, and next action.
- Receipts survive navigation/reload through the authoritative audit source; transient component state is not the only record.
- Focus moves to confirmation/error/receipt and returns to the invoker on cancel.

## 15 · Executable acceptance system

### 15.1 Route authority

`tooling/uiproof/matrix.mjs` becomes generated-or-checked executable coverage truth derived from `routes.js`. This document describes families; the matrix proves exact routes. A test fails when a navigable route is absent unless it carries an explicit alias/redirect/exclusion reason.

### 15.2 Tiered matrix

Avoid a useless Cartesian explosion:

- **Tier A — every route:** 1440×900 and 390×844; navigation, mounted semantic screen, title/heading, no whole-page overflow, no uncaught error, expected auth/refusal, and deterministic crop.
- **Tier B — each layout family:** add 320, 768 portrait, 1024 landscape, 200% zoom, reduced motion, high contrast, keyboard traversal, focus visibility, and axe scan.
- **Tier C — critical workflows:** member login/logout/expiry; pair switch; chart interval/race/reconnect; order stage/confirm/ack/refuse/timeout/unknown/reconcile; cancel/amend/reprice; money unknown/zero/live; admin auth and every consequential action. Run across supported browser projects and all relevant data states.
- **Tier D — manual certification:** VoiceOver/NVDA-equivalent screen-reader pass, touch/virtual-keyboard pass, 400% reflow, chart summary/navigation, and human visual review.

### 15.3 Durable evidence

- Replace fixed sleeps with observable readiness/state predicates.
- Freeze locale, timezone, font, browser build, animation, clock, viewport, and network fixtures.
- Use `toHaveScreenshot`; commit reviewed baselines beside tests or publish immutable PR artifacts with manifest/hash. `.artifacts` alone is not cold-start evidence.
- Mask only irreducibly volatile cursor/clock regions—never balance, status, authority, warnings, receipt, or error content.
- Store exact commit SHA, browser/runtime versions, route/state/viewport, screenshot/diff location, and certifier in the evidence manifest.
- Automated accessibility tests are paired with manual checks; no tool output claims WCAG conformance by itself.

## 16 · Supported toolchain lane

The current Node 16–18 proof constraint is retired: those runtimes are EOL. The goal is a supported build path without replacing Bazaar.

1. Inventory actual webpack/Babel/Vue/iView blockers and browser targets.
2. Make the current shell build reproducibly on an active LTS Node release.
3. Incrementally move Webpack 3 toward a supported bundler version using official migrations; preserve route and screenshot behavior at each step.
4. Move Vue 2.5 at least to the final Vue 2 line or obtain an explicit supported-maintenance strategy. Research a Vue 3 compatibility migration separately; do not combine it with feature closure or create another SPA.
5. Generate dependency/license/vulnerability evidence and remove dead scaffold tests/dependencies only with route/build regression coverage.
6. Keep LWC vendored and reproducible; no CDN runtime dependency.

## 17 · Execution DAG and PR boundaries

One service/surface per PR. Independent lanes run in parallel; no PR combines member SPA, admin, and documentation merely for convenience.

### Wave 0 — stop unsafe claims

- **Admin lane:** FE-P0-01 fail-closed auth/authorization/CSRF/actor receipt.
- **Member money lane:** FE-P0-02 fixed-point chart/market/indicator pipeline and property goldens.
- **Member navigation lane:** FE-P0-03 responsive drawer plus focus/keyboard/touch proof.
- **Member identity lane:** FE-P0-04 remove legacy storage authority and converge guard/interceptor/store.

### Wave 1 — make proof executable

- Expand route inventory and tiered uiproof matrix.
- Add durable visual/semantic/a11y baselines and admin browser harness.
- Add state fixtures for live/empty/stale/refused/malformed/timeout/unknown.
- Record supported browser/runtime policy.

### Wave 2 — finish professional workflows

- Exchange freshness, request sequencing, reconnect, accessible chart controls, and true staged drag-reprice.
- Versioned/resettable saved layout and full browser round trip.
- Admin source-backed dense queues and durable receipts, preserving explicit unavailable rows for missing contracts.
- Route-level loading/error/not-found recovery.

### Wave 3 — supported runtime and quality budgets

- In-place member build/toolchain stabilization on active LTS Node.
- Performance budgets, feed coalescing, field/lab telemetry, client error boundaries, and redacted correlation.
- Cross-browser, zoom, screen-reader, touch, and human crop certification.

### Wave 4 — close and janitor

- Fix only failed acceptance rows.
- Append exact-SHA scorecard evidence; never replace old rows.
- Refresh Graphify after code changes.
- Merge each completed PR without treating CI as a permission gate.
- Declare completion only when §18 is true.

## 18 · File janitoring and final Definition of Done

### 18.1 Document roles

| Role                            | File                                                                                                            | Rule                                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product doctrine                | `INTAFACED_DEFINITIVE_BUILD.md`                                                                                 | Keep. Mark old `apps/web`/glass/green rows explicitly superseded by the later Bazaar/N4 amendment; do not silently delete history.                                                                                                                          |
| Reuse law                       | `docs/INTERNET-LEVERAGE-LAW.md`                                                                                 | Keep. Chart row: Advanced Charts intended / LWC interim. Correct stale `04_Web_Admin` preference to live `apps/admin`.                                                                                                                                      |
| Chart licence                   | `docs/LICENCE-POSITION.md` §1.1 / §1.1a                                                                         | Sole licence home. 2017 Charting Library stay purged. Advanced Charts = owner intent, approval pending. Do not recook here.                                                                                                                                 |
| Living frontend inventory/spec  | This file                                                                                                       | Sole frontend backlog/status/acceptance map. Update requirements here, not in a new board.                                                                                                                                                                  |
| Executable route proof          | `tooling/uiproof/matrix.mjs` and tests                                                                          | Exact route/state/viewport authority. Prose cannot claim coverage that this matrix does not execute.                                                                                                                                                        |
| Evidence index                  | `docs/FRONTEND-SCORECARD-LIVE.md`                                                                               | Append-only exact-SHA results and proof links. It is not a requirements document.                                                                                                                                                                           |
| Method                          | `docs/FRONTEND-MASTER-METHODOLOGY-2026-07-31.md`                                                                | Preserve useful dimensions/gates; mark obsolete start gates and rebuild language superseded.                                                                                                                                                                |
| Grok closure operating contract | [`docs/PROMPT-GROK-FRONTEND-GO.md`](PROMPT-GROK-FRONTEND-GO.md)                                                 | How Grok runs this map with Codex-look only. **Not a second remaining-SOT.** Compact-resume: re-read it + this file on `origin/main`. Codex paste remains [`PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md`](PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md). |
| Visual evidence                 | `SHOW-LAYOUT/MONEY/BANK` and committed crops                                                                    | Reference only for named families; absence of SHOW-PAY/etc. is not permission to invent style.                                                                                                                                                              |
| Terminal / OMS / TCA product    | `PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md` M07/M25 + `docs/SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md` | Product law. This file maps R-items to NOW/REFUSE/SOCKET/LATER. Never a second terminal spec.                                                                                                                                                               |
| Backend OSS catalog             | `docs/BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`                                                            | Backend only. UI take/keep/never is §19.2 here. Competitive delta is M07-out.                                                                                                                                                                               |
| History                         | old prompts, layout SoTs, selection/color boards, Wave A/B, GO-ready/autonomy plans, LWC A6                     | **Bannered 2026-09-01** (`[HISTORY]`). Proof value kept. Not live paste.                                                                                                                                                                                    |

The 2026-08-26 finish prompt is **not** on `origin/main` and is not live law. `SHOW-NOW.html` is **absent** — do not cite it. Wireframes that exist: `SHOW-LAYOUT` / `SHOW-MONEY` / `SHOW-BANK`.

### 18.2 Frontend done means all are true

- All FE-P0 items are closed with browser/API/property evidence.
- Every navigable route is represented in executable coverage or has an explicit alias/redirect/exclusion reason.
- All Tier A routes and Tier B families pass; every critical Tier C workflow passes; Tier D has named human certification.
- No canonical money value is a JS number; no frontend owns balance or authorization truth.
- Member and admin sessions/permissions fail closed and contain no persistent browser bearer.
- Exchange pair switching, chart freshness, reprice/amend/cancel, saved layout, keyboard, touch, and accessible alternatives work across the required matrix.
- Admin queues are real or explicitly unavailable; consequential actions bind exact facts, lock, reconcile unknowns, and return durable service receipts.
- Loading/empty/live/stale/refused/error/unknown states are distinct across member and admin surfaces.
- Supported runtime/browser policy, performance budgets, and production observability exist and pass their stated gates.
- Visual proof is durable and tied to an exact commit; scorecard and Graphify are updated.
- Canonical documents do not contradict the shipped architecture or claim unfinished/historical waves as current work.
- Every M07 R-item in §19.4 is NOW-complete, REFUSE-closed, SOCKET, or LATER with a named owner. M25 care chrome remains refuse-closed; algo/EMS read-only is allowed when the wire returns it. No heatmap/drawings/TCA conclusions without the named contract.

Until then, the correct status is: **frontend baseline shipped; closure in progress**. North-star desk (Layer B) is **not** implied by Layer A chrome PRs.

---

## 19 · North-star UI map (2026-08-31)

**Why this section exists.** Codex’s last spec wave banked a **backend** OSS catalog (`#3454`–`#3458`) and a competitive delta that is explicit: **“Scope: backend only. M07 out. Frontend is not this addendum.”** Shell-craft §§9–18 closed P0 safety and a 89-route matrix. Neither joined **M07/M25** (professional terminal / OMS / TCA) onto Bazaar. That join is the missing spec. Without it Codex will either vibe a second terminal or ship another skin and call the exchange done.

**Inventory this section used [RAN-IT on worktree `origin/main`].** Do **not** inventory `/Users/Nitro/projects/Sovereign` (Grok door; diverged). Tip `Exchange.vue` already has Spot/Perps/Convert/Copy/Options, Limit/Market/Stop/Stop-limit/Trailing/TP/TWAP/Scale/attached TP-SL, TIF GTC/IOC/FOK, amend + staged reprice (not chart-drag submit), cancel-all, RSI/MACD toggles, LWC **5.2.1** Apache vendored. Positions blotter still carries `spotNoPerps` empty copy. Flatten/reverse named controls were **not** found. `tooling/uiproof` has 89 routes / 178 Tier-A cells; screenshot proof was a dry-run fail pack, not green crops.

### 19.1 Unspoken needs (locked)

1. He directs; he cannot read Vue. “Ticket types exist in the file” is not a result. The crop is the result.
2. A pro will not stay on a venue whose screen is stale, duplicates an order after refresh, or offers TCA that cannot reproduce inputs (PX-S05 §1).
3. Ambition survives: do not silently cut M07 to “we have a chart + ticket.” If Vue2 cannot deliver a named job, **stop and name the hole** — refuse-closed control, not a prettier fake.
4. Internet leverage: extend Bazaar + iView 3. Chart **end-state** is TradingView **Advanced Charts** (owner, waiting on approval). LWC is interim only. Never a second SPA, never Bookmap/TapeDelta as the product, never OpenDAX, never AG Grid as a second kit, never a pirate TV tree in public git.
5. Backend OSS (QuickFIX/J, Real Logic SBE, QuantLib, WebAuthn, Zod-OpenAPI) is **not** a frontend shopping list. Greeks on screen are decimal strings from _our_ adapter, never a float from QuantLib-in-the-browser.
6. Missing API → honest refuse. Missing L3 → no fake heatmap. Paper options stay paper. Custody stays `CustodyNotBuilt`.
7. Owner sockets stay sockets: care/agency roles, TCA methodology, mobile policy, hotkey blast-radius policy, layout-share policy (`PX-S05-O01`–`O08`), **Advanced Charts access/agreement**.
8. One mountain per PR. Member SPA, admin, and docs are not one convenience commit.
9. Proof is worktree `:8090` / dist + Orca 1440+390. Door `:8090` is not proof.
10. **He does not know what he does not know.** Infer the requirement from the job, then name the official product limit. Do not hide that Advanced Charts is not Trading Platform, and that Alerts/Bar Replay are still absent on both.

### 19.2 Frontend leverage (take / keep / never)

Complements the backend peace map. Does not weaken [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md).

| Need                 | Take / keep                                                                                                                                                              | Never                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                | Vendored Bazaar Vue2 `:8090` + iView 3 + N4 tokens                                                                                                                       | New SPA, Tailwind/shadcn, resurrect `apps/web`, OpenDAX kit                                                                                                                               |
| Chart host           | **Intended:** TradingView **Advanced Charts** after GitHub access + counsel (`LICENCE-POSITION.md` §1.1a). **Interim:** vendored LWC **5.2.1** Apache + NOTICE (`#3406`) | Pirate/2017 Charting Library restore; public-git copy of AC (not redistributable); Widgets iframe (TV data); npm `lightweight-charts-drawing`; **Trading Platform** unless Nitro names it |
| Book / tape / ticket | Existing `Exchange.vue` widgets + `svc-matching` / `svc-trade` / `svc-ws`                                                                                                | npm `orderbook`, Bookmap, Sierra, ATAS, TapeDelta, HODLChart as the venue                                                                                                                 |
| Money                | `ledger-client` + `svc-ledger`                                                                                                                                           | Second book, fixture-seeded balances, JS `Number` economics (`#3463` holds)                                                                                                               |
| Identity             | Memory session (`#3459/#3461/#3462`) + `svc-identity`                                                                                                                    | localStorage TOKEN authority, Auth0 in money path                                                                                                                                         |
| Greeks display       | Decimal strings from a **QuantLib adapter in-repo** when that mountain is scheduled                                                                                      | QuantLib-Python / WASM in the hot UI; invented IV                                                                                                                                         |
| Admin                | `apps/admin`                                                                                                                                                             | Restyle undeployed `04_Web_Admin`; third ops console                                                                                                                                      |
| FIX / SBE            | Not UI. Gateway adapters later                                                                                                                                           | FIXimulator GUI, `node-quickfix`                                                                                                                                                          |

**Chart inference [WEB 2026-08-18, tradingview.com/charting-library-docs]:** Advanced Charts gives drawings, 100+ indicators, compare, theming, **our** datafeed, Vue-compatible widget constructor. It does **not** give multi-chart layouts, trade-from-chart, Broker API, or TV DOM — those are **Trading Platform** (paid). Neither library gives Pine, **Alerts**, or **Bar Replay**. Login-gated `/exchange` may fail AC’s “free if public / not behind a paywall” test — counsel. Until access: keep LWC honesty work; do not fake AC with extra LWC plugins.

2026 order-flow terminals (Bookmap, Tape Delta, HODLChart) prove the **job** (DOM+heatmap+footprint on one clock). They are **not** leverage. Our L3 door already refuses invented L3 (`svc-ws`). Heatmap/footprint stay **REFUSE** until a real MBO/L3 contract exists.

### 19.3 Three layers (do not collapse)

| Layer                        | Home                               | What “done” means                                                                                                                                           |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Shell craft / honesty** | §§0–8 rooms + §§9–18 P0/proof      | N4 OS, no mall on money-class routes, fail-closed admin, no JS money, executable route matrix, durable crops                                                |
| **B. Professional desk**     | M07 R01–R17 + PX-S05 §§6–11, 19–20 | Workspace, session truth, tickets that match matching, blotter, risk, recovery, capacity                                                                    |
| **C. Institutional OMS/TCA** | M25 R01–R12 + PX-S05 §§12–18       | Care/shift/manual-fill/allocation chrome **REFUSE**. Algo/EMS parent+child **read-only if the wire returns it**. TCA conclusions **SOCKET**. Not a fake OMS |

Layer A is in progress (~40% of §§9–18). Layer B is the **coding mountain** now. Layer C: **care/shift/manual-fill/allocation chrome REFUSE**; algo/EMS parent+child may be **read-only NOW** if the wire already returns them (`oms-claim` / `listLiveEmsChildren`). TCA conclusions stay SOCKET. Do not write “backend ABSENT” — PX-S05 `ABSENT` is the _care/TCA product_, not “no files.”

### 19.4 M07 complete map (every R-item)

Path: **NOW** = code on Bazaar this wave · **PARTIAL** = chrome exists, job incomplete · **REFUSE** = honest control until named API · **SOCKET** = owner/legal · **LATER** = after NOW, still in-shell.

| ID  | Job                                                                                                         | Path                                                                                                                                                                                                                                                                                                                                              | Tip [RAN-IT]                                                                    | Frontend work                                                                                                                          | Leverage                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| R01 | Multi-workspace, detach, saved layouts, multi-monitor, ⌘K, keyboard                                         | **NOW** local layout+Reset+⌘K completeness. **LATER** cloud/multi-monitor/share                                                                                                                                                                                                                                                                   | ⌘K + panel widths persist. No Reset, no versioned cloud layout                  | Reset; schema version; 390/1440 restore; ⌘K cover quant/execution/ops/market/support/portfolio/predict/mining                          | `desk-prefs.js` extend. No widget-canvas                  |
| R02 | Drawings, indicator templates, multi-chart link, overlays, alerts, compare, replay                          | **SOCKET** Advanced Charts access. **NOW (interim LWC):** overlays + as-of/stale/live + RSI/MACD on accepted candles. **After AC mounts:** drawings, indicator templates, compare, theming. **REFUSE even after AC:** Alerts, Bar Replay (not in the library). **REFUSE unless Trading Platform is named:** multi-chart layouts, trade-from-chart | LWC 5.2.1 panes; no AC in tree                                                  | Do not npm a drawing pack. Do not implement AC until access. Datafeed = our OHLCV/WS only                                              | AC official repo after approval; LWC until then           |
| R03 | DOM/ladder, heatmap, tape, footprint, spread matrix, watchlist, scanners, stats                             | **NOW** densify existing book+tape+watchlist; click-to-price already. **REFUSE** heatmap/footprint/scanner until L3/MBO                                                                                                                                                                                                                           | Book+tape+watchlist exist; L3 subscribe refused at WS                           | One-click from ladder **stages** ticket (does not silent-submit). No invented depth                                                    | Existing book widget                                      |
| R04 | Every native order/strategy, presets, one-click, drag-amend, sizing, preview                                | **NOW** capability matrix = **PX-S03/matching/trade arms ∪ visible buttons**, not “visible only.” Iceberg is a live matching door with no ticket control. Peg is a typed refuse door. Unsupported = refuse-closed **on the ticket**. Preview + staged drag-reprice (release never submits)                                                        | Types+TIF on ticket; iceberg/peg wraps leftover CSS; no matrix                  | Mount refuse-or-real for iceberg/peg/OCO/VWAP/RFQ/basket if the door exists; preview from existing APIs                                | Ticket + `svc-trade` / `svc-matching`. No new OMS product |
| R05 | Unified blotter: orders, fills, positions, strategies, transfers, funding, borrow, RFQ, errors              | **NOW** unify tabs that already have APIs. **REFUSE** rows for missing books                                                                                                                                                                                                                                                                      | Balances / empty positions / open+history. Positions `spotNoPerps`              | Perps positions if `svc-trade` returns them; else keep empty+reason. RFQ/funding/borrow tabs = explicit unavailable until query exists | Existing blotter                                          |
| R06 | Risk workspace: collateral, Greeks, scenarios, liq bands, ADL                                               | **NOW** show isolated IM/MM/liq if already on ledger/risk reads. **REFUSE** portfolio margin / 2×2 as a flag (competitive delta)                                                                                                                                                                                                                  | Not a dedicated risk pane                                                       | Compact risk strip on desk + `/portfolio` honesty. No invented Greeks                                                                  | `svc-ledger` / risk reads                                 |
| R07 | Mobile control plane                                                                                        | **SOCKET** `PX-S05-O08` + **LATER** (owner mobile policy). Not 390 desk parity                                                                                                                                                                                                                                                                    | 390 desk exists; not a control plane                                            | Do not build a second mobile app. 390 already first-class for Layer A                                                                  | Owner: Nitro Class X                                      |
| R08 | A11y, locale, precision, degraded, no-stale                                                                 | **NOW** (already Layer A)                                                                                                                                                                                                                                                                                                                         | Partial: error summary, numeric gate                                            | Finish Tier B families                                                                                                                 | Existing IxState                                          |
| R09 | Persistent session-status: auth, trading conn, private state, **each** MD sub, clock, schema, degraded deps | **NOW** — major hole                                                                                                                                                                                                                                                                                                                              | Header Live/Down is a **single** flag                                           | Per-channel chips; never one green “connected”                                                                                         | `svc-ws` ack/reject facts already distinct                |
| R10 | Lock-all, lock-order-entry, live/sim banners, protected hotkeys, account color, trading-enabled             | **NOW** UI + **SOCKET** for policy magnitudes (`PX-S05-O04`)                                                                                                                                                                                                                                                                                      | Not found as a global lock surface                                              | Banner + lock that **disables submit**; hotkeys no-op when locked. Default: destructive shortcuts off until owner policy               | Existing hotkeys                                          |
| R11 | Crash/sleep/refresh/tab-dup/reconnect: server truth before new intent; no duplicate orders                  | **NOW** — catastrophic if skipped                                                                                                                                                                                                                                                                                                                 | Session authority P0s landed; reconnect proof **not** the professional contract | Recovery-locked until private/open-order reconcile; idempotent client IDs; duplicate-tab shared session                                | `#3459/#3461` + order idempotency                         |
| R12 | Long-session / dense book / burst fills / budgets / shedding                                                | **LATER** with Wave 3 budgets                                                                                                                                                                                                                                                                                                                     | Unproven                                                                        | Do not fake; add budgets when measuring                                                                                                | Owner: agents after NOW 1–7; magnitudes SOCKET            |
| R13 | Parent/child/hedge causal tree                                                                              | **NOW** read-only algo/EMS parent+child if `svc-execution` returns them (`listLiveEmsChildren`, claim/pass on **algo** parents). **REFUSE** care trees                                                                                                                                                                                            | Flat open-order rows                                                            | Do not invent care parents. Show EMS tree only from the wire                                                                           | `svc-execution`                                           |
| R14 | Calendars + alerts with provenance                                                                          | **NOW** instrument-borne funding/expiry only. **REFUSE** listing/delisting, maintenance, governance, economic, announcement calendars until a calendar API. Price alerts REFUSE. Push/email = `PX-S05-X03` / `socket.notify-*`                                                                                                                    | Not a calendar surface                                                          | Quiet next-funding / expiry on pair header. No fake econ calendar                                                                      | Instrument master; notify sockets                         |
| R15 | Versioned portable shareable presets                                                                        | **NOW** local version+Reset. **SOCKET** org share                                                                                                                                                                                                                                                                                                 | Partial persist                                                                 | Export/import later; share is owner policy                                                                                             | `desk-prefs.js`                                           |
| R16 | Journal + hard live vs replay                                                                               | **LATER** + **SOCKET** retention (`PX-S05-O07` if present). Replay REFUSE until capture exists. Never a replay badge.                                                                                                                                                                                                                             | None                                                                            | Do not ship a journal that can edit PnL                                                                                                | Owner: later; privacy/retention SOCKET                    |
| R17 | Join/cross, reprice-by-tick, cancel, cancel-all, close, flatten, reverse + blast radius                     | **NOW** cancel, cancel-all, staged reprice, and **close** via existing `closePosition` (`DELETE /api/v1/positions/:id`) with per-target ACCEPTED/REJECTED/UNKNOWN — close is not a fill promise. **REFUSE** join/cross/flatten/reverse until a blast-radius payload. Copy `flatten()` is M26, not this control                                    | cancel-all exists; no close/flatten/join on Vue                                 | Do not conflate copy flatten with desk flatten                                                                                         | `svc-trade` close-position + existing cancel              |

### 19.5 M25 complete map (OMS / TCA)

Care/shift/manual-fill/allocation: **REFUSE** chrome. Algo claim/pass and TCA **raw facts** may exist in `svc-execution` (`oms-claim`, `oms-pass`, `oms-tca`) — consume as read-only / unavailable, never as a “best-ex” or care desk. Do not draw TT-style claim/pass chrome for **care** orders.

| ID  | Job                                                                                                                                         | Path                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R01 | Staged/care vs exchange-live children (originator, instruction, owner, account, limit, benchmark, urgency, discretion, expiry, compliance)  | **REFUSE** — no care-order service                                                            |
| R02 | Claim/unclaim/assign/pass/accept/reject/undo-pass; shared visibility; queue continuity                                                      | **REFUSE** for **care**. Algo parent claim/pass: **NOW** read-only if already on the EMS door |
| R03 | Night-desk/shift handoff; no unowned live interval; no account-risk transfer                                                                | **REFUSE**                                                                                    |
| R04 | Parent caps qty/price discretion; split/bulk/stitch/hold/release/manual-fill cannot exceed                                                  | **REFUSE**                                                                                    |
| R05 | Cancel/change, price worsening, manual fills, assignment, correction, client confirmation                                                   | **REFUSE** (native amend/cancel stays M07; this is care/manual)                               |
| R06 | OMS views unify care/synthetic/algo/RFQ/routed/native/liquidation/manual without collapsing semantics                                       | **REFUSE** fake unification; native blotter stays M07-R05                                     |
| R07 | TCA vs decision, arrival, interval VWAP/TWAP, midpoint, close/fixing, quoted spread, client benchmark                                       | **SOCKET** `PX-S05-O06` + **REFUSE** conclusions                                              |
| R08 | Cost: spread capture, impact, delay/opportunity, fees/rebates, funding, borrow, FX, venue/routing, residual                                 | **REFUSE**                                                                                    |
| R09 | Markouts by order/parent/strategy/trader/client/venue — no causality from correlation                                                       | **REFUSE**                                                                                    |
| R10 | Best-ex reconstruction from point-in-time retained data                                                                                     | **SOCKET** + **REFUSE** “compliant” badge                                                     |
| R11 | Pre-trade what-if (method, impact, risk/margin, capital, fees, legging)                                                                     | **REFUSE** as authority; ordinary order preview is M07-R04                                    |
| R12 | Desk dashboards: unattended, orphaned children, unconfirmed fills, breached instructions, failed hedges, stale ownership, allocation breaks | **LATER** admin/ops; not a fake “all fine”                                                    |

### 19.6 Other mountains that still need a screen (or a refuse)

Not M07, but a pro still opens them. Each is one later PR **after** §19.4 NOW, or a refuse on the desk.

| Mountain                       | Screen job                                                          | Now                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| M08 margin modes               | Mode switch with preview; 2×2 is four named products not a checkbox | Refuse unsupported mode                                                                                                    |
| M10 dated futures / hedge mode | Expiry strip; hedge vs one-way explicit                             | Perps button exists; positions empty until live                                                                            |
| M11 options                    | **Full chain** bid/ask/IV/delta — paper qty/price is **not** this   | Keep paper label; no fake IV                                                                                               |
| M12 RFQ/block                  | RFQ blotter, firm quote, expiry, allocation                         | `/p2p` OS + ticket copy mode; no fake last-look                                                                            |
| M14 PnL/statements             | Realized vs funding vs fees; export                                 | `/portfolio` + money OS                                                                                                    |
| M15 custody                    | Designed refusal                                                    | `CustodyNotBuilt`                                                                                                          |
| M16 surveillance               | Admin case UI                                                       | `apps/admin` only                                                                                                          |
| Predict / mining               | OS honesty pages                                                    | **`/predict` `/mining` exist** (`Predict.vue`, `Mining.vue`). Do not invent **new** routes. Empty/refuse, not fake markets |
| M26 Copy                       | Pause/stop/detach/flatten via **copy** APIs only                    | Ticket copy mode exists. Never desk flatten                                                                                |
| M27 Convert                    | Quote / expiry / execute; not a book trade                          | Ticket convert exists. Keep quote-refuse honesty                                                                           |

### 19.7 Layer A residuals (re-derived vs merged PRs — do not drop, do not re-open landed)

**Owner 2026-09-09 (do not nag, do not build)**

1. Named AT (VoiceOver/TalkBack) — **LATER / deferred.** Owner: not a now-gate. Keyboard-without-mouse already tested. Agents must not raise VoiceOver again until Nitro names it.
2. Admin withdrawal approval — `NOT MOUNTED` (no svc-edge procedure). Member `/uc/withdraw` is `CustodyNotBuilt`. Do **not** restore Java withdraw. Do **not** build a Coinbase rail. Denon PX-S12 already specs custody; wait wallet-RPC. Queue look `#4010` hashed.
3. Field RUM collector — REFUSED until a named collector. Lab policy `#3871`.
4. Taste freeze — identity pin `#FF6B00` **KEEP 2026-09-09** (member `#4210` `35aa4f654`, admin `#4215` `ffadd7130`). Remaining shown Layer A packs (desk, money, bank, pay, admin queues) **frozen KEEP** the same day. Not a new look pass.
5. Reachable-zero named live fixture — still owed as SOURCE-READ. **Nitro does nothing.** Do not seed balances. Golden `money-reachable-zero.golden.js` (HTTP 503 unknown/degraded · empty list empty · wire `"0"` string row).
6. Advanced Charts — SOCKET, waiting acceptance (`LICENCE-POSITION.md` §1.1a).
7. Mobile control plane — SOCKET `PX-S05-O08`. Not an App Store app. Sideload wrap `apps/mobile` exists, not store-listed. Do not build a second app.

**Landed / refuse-closed — do not re-implement**

- Desk touch `#4009` (hashed 1440+390; independent certifier)
- Admin queue N4 `#4010` (withdrawal still NOT MOUNTED)
- N4 catalog titles grey `#4088` (hashed 1440+390 `look-n4-residual-orange`; withdrawal still NOT MOUNTED)
- Member shell orange identity `#4163` (hashed 1440+390 `look-member-orange-janitor`; SHA `440a36dfa`)
- Restrained identity pin `#FF6B00` member `#4210` `35aa4f654` (`look-restrained-accent-member`) and admin `#4215` `ffadd7130` (`look-restrained-accent-admin`); KEEP 2026-09-09. Date-range, catalog titles, Buy/Sell, default links stay grey. Withdrawal still NOT MOUNTED.
- Money/Bank/Pay Layer A `#4017` (three named surfaces; 503 ≠ `$0`)
- Book/tape densify R03 `#3993` (heatmap still REFUSE until L3)
- recovery+drawer unique-port 52459 SHA `5ae971b3a`
- `/platform` 320 overflow `#3986`
- N4 loading-bar orange janitor `#3988`
- Durable hashed Tier-A 178 `#3872`
- Layout Reset + ⌘K `#3677` / `#3874`
- Admin error/not-found/loading `#3873`
- Dup-tab / recovery lock R11 `#3870` / `#3849` recovery.spec
- 768/1024 reflow `#3949`
- Chart live STOMP REFUSED `#3878` (snapshot + as-of)
- Chart live→stale after 15s silence `#4234` `22c2f23ba`
- Admin 390 wrap without undoing KEEP `#4229` `7f427dc1a` (supersedes `#4206`)
- KEEP index on SHOW-TASTE / dod-gate `#4223` `e539edc43`
- Chart drag-reprice superseded by ticket amend (§20); AC SOCKET
- Node 24 `#3678`; Vue 2.7 leftover LATER

### 19.8 Self-audit of this map

| Risk                                                        | Mitigation                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Inventorying the Grok door Vue (Limit+Market only, LWC 3.8) | Rejected. Tip `Exchange.vue` has the full type strip + LWC 5.2.1                                   |
| Treating backend OSS as frontend libraries                  | §19.2 never-list                                                                                   |
| Recooking PX-S05                                            | Pointer + map only                                                                                 |
| Counting M07 as 21 R-items (progress-file bug)              | North-star is **17**; M25 is **12**                                                                |
| Shipping heatmap because 2026 blogs say so                  | L3 refused at `svc-ws`; heatmap = lie                                                              |
| Silent downgrade of drawings to forever-LWC                 | Owner wants Advanced Charts. LWC is interim. Alerts/replay still refuse (not in AC)                |
| Claiming flatten exists                                     | Grep on tip found cancel-all, not flatten/reverse; **close** is a separate NOW via `closePosition` |
| Claiming uiproof green                                      | 178 F1 hashed `#3872`. dod-gate OPEN/TASTE rows are the now-gate; SOCKET/LATER/REFUSED stay named  |
| Claiming `/predict` `/mining` absent                        | False — routes.js L70–71. Corrected §19.6                                                          |
| Claiming M25 backend ABSENT                                 | Stale vs `oms-claim` / `oms-tca`. Split care vs algo                                               |

---

## 20 · What Codex codes now (order)

Do not paste this whole file. Paste [`PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md`](PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md). One family per PR.

1. **Session truth (R09+R11+R10)** — per-channel status; recovery-lock; order-entry lock; live banner. Highest leverage vs silent duplicate intent.
2. **Ticket honesty (R04)** — capability matrix vs matching; preview; amend from the **ticket** (not LWC drag — that dies when Advanced Charts lands).
3. **Blotter + risk strip (R05+R06)** — live or labelled empty; no fake uPnL.
4. **Layout Reset (R01/R15)** — **landed `#3677` + ⌘K `#3874`.** Org share SOCKET.
5. **Leave the chart.** Do not polish LWC. Do not implement Advanced Charts until access. (`#3672` races, `#3679` a11y already on tip.)
6. **Admin dense queues** — **source-backed `#3673`.** Visual density still Codex.
7. **Durable uiproof** — fail-closed `#3676`. Hashed F1 178 `#3872`. Other fixture classes + `/platform` 320 leftover still Codex.
8. **Toolchain** — **Node 24 `#3678`.**

Stop at refuse rows. Do not implement M25 care chrome, mobile control plane, heatmap, Advanced Charts (until access), Trading Platform, drawing-npm, or a second SPA.

### 20.1 Who builds what (Codex vs Grok)

**Codex (look):** anything a stranger judges in ~2s — desk chrome, N4, money/bank/pay crops, ticket layout, admin queue _look_, 390, Orca shots. Grok must not restyle those.

**Grok (truth, no paint):** fail-closed session/recovery/idempotency; capability **tests** (button vs matching/trade door); `closePosition` wire; blotter empty-reason copy only if existing IxState; admin BFF + source-backed tables; uiproof matrix/goldens; Node LTS build; decimal/fixed-point; refuse-closed holes. If the change is “how it looks,” stop and leave it for Codex.

**Nobody until Advanced Charts access:** new chart host, drawings, compare, TV files in git, LWC extras.

### 20.4 Grok orchestrator contract (2026-09-03)

[`PROMPT-GROK-FRONTEND-GO.md`](PROMPT-GROK-FRONTEND-GO.md) is how Grok executes §§19–20 when Nitro says `go`. Not a replacement map and not a 14-mountain DAG. After chat compact: `git fetch origin main`, re-read that file and this one from `origin/main`, resume the first incomplete GO-brief §6 step. Progress = merged PRs, not chat.

### 20.3 Codex 2026-09-01 audit (read-only · not a restyle)

All eight PRs merged; none a no-op. **#3676 “178 cells pass” is not a browser run** — policy tests only.

| PR            | Holds                                  | Still Codex / hole                                       |
| ------------- | -------------------------------------- | -------------------------------------------------------- |
| #3672 races   | `_historyFence`                        | `stompClient: null` — chart not live                     |
| #3673 queues  | KYC from `identity.kyc.pending`        | withdrawals/finance unavailable; KYC no cursor/total     |
| #3674 session | `authRefusal` → `clearIxSession`       | dual HTTP (`vue-resource`) leftover                      |
| #3675 numbers | no `this.num(` / `toFloat` on Exchange | `ix-money.ratio()` still IEEE for CSS bar width          |
| #3676 uiproof | missing cell = FAIL                    | F1 178 hashed `#3872`; other fixtures still open         |
| #3677 reset   | prefs v2 + Reset                       | one unnamed layout; splitters odd                        |
| #3678 Node 24 | `node:24` + webpack 5                  | Vue 2.7 shell; leftover less-loader                      |
| #3679 a11y    | Fit / Follow                           | Follow ≠ live feed; no drag-reprice (correct — AC later) |

Vue type strip still omits iceberg/peg/collar/close/bracket/oco (helpers exist). **Grok does not mount them.**

### 20.2 Completeness of this map

Named set is complete enough to code: M07 R01–R17, M25 R01–R12, rooms, leverage, AC vs LWC. Not a fake “frontend done.” Still owner/wait: Advanced Charts grant, Trading Platform (parked), custody, your eye on money/bank/pay, Class X sockets. AC _mount steps_ wait on that grant — do not invent a LWC stand-in.

## 21 · Flip

This map is wrong if Nitro says M07 is not this season; if wallet-RPC goes live (then custody is a **new** pack); if a second SPA becomes law (ADR); if a real L3/MBO feed lands (then R03 heatmap becomes NOW, still not Bookmap); if Nitro names **Trading Platform** instead of Advanced Charts (then multi-chart + chart-trading become in-scope); if Advanced Charts access lands (then R02 drawings/compare become NOW and this file’s “do not implement AC” lines expire).
