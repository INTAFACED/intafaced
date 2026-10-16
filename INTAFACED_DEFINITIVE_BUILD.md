# INTAFACED — DEFINITIVE BUILD
### Sovereign OS · Master Engineering Document
**Version 2.2 — FINAL · July 2026 · Phantom Capital Holdings · Strictly Confidential**

> **CORRECTION 2026-10-16.** This file is still the product spec the coverage gate reads (`tooling/ci/coverage-check.mjs` keys off `## N ·` headings). It is not the map of the tree. Where this file disagrees with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) or [`AGENTS.md`](AGENTS.md), those two win.
>
> Do not follow: §0 rule 5 ("TypeScript everywhere") as a ban on the Java FIX gateway, the Solidity contracts, or the unwired Rust matcher socket; §1 row "Frontend | Next.js" as a description of every surface; §2's tree where it names `apps/web`, `ws-gateway`, `svc-launch`, or `svc-core-ops`; any sentence that makes `vendor/upstream-exchange/05_Web_Front` the served customer screen. The served screen is `apps/customer`. §5.3 below is rewritten to that fact. The `## N ·` headings are unchanged so the coverage gate still resolves.

---

## 0 · DOCTRINE

This document is the single source of truth for building the INTAFACED Sovereign OS. Every Cursor agent, every PR, every schema change answers to this file. Rules:

1. **Never half done.** A module ships when its Definition of Done (§14) passes — not before, and nothing "temporary" survives to the next phase.
2. **Core first.** Nothing is built on top of the Core until the Core's test suite is green. The eleven modules are surfaces; the Core is the house.
3. **Three shared systems only.** Identity, Balance (Ledger), Token. Every cross-module link runs through one of these three. If a proposed feature needs a fourth shared system, the design is wrong — redesign it.
4. **Adapters, not integrations.** All external rails (card issuers, PSP partners, bank rails, liquidity venues) sit behind internal interfaces. NTG / SettleTX / PayKwik and any future partner plug in as adapters later — the platform never depends on them to function.
5. **One language.** TypeScript everywhere. Agents never context-switch. Performance-critical services are isolated behind interfaces so they can be ported (Rust) without touching callers.
6. **Ledger is law.** No module holds its own balance. Every value movement anywhere in the OS is a double-entry ledger transaction in the Core. No exceptions — not for fees, not for rewards, not for gas.
7. **Blueprint branding rule.** The onboarding intelligence is the GMaster Neural Engine consumed as an internal service. User-facing copy references only: *Identity Blueprint, Sovereign Intelligence, Neural Engine*. No third-party system names anywhere in UI, API responses, or docs shipped to users.

---

## 1 · STACK

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.x, Node 20 LTS | One language across services + web; agent velocity |
| Monorepo | pnpm workspaces + Turborepo | Shared packages, cached builds, task graph |
| API framework | Fastify + tRPC (internal) / REST (public) | Type-safe internal calls; clean public API surface |
| Database | PostgreSQL 16 | Source of truth. Ledger, identity, orders — all here |
| ORM / migrations | Drizzle ORM + drizzle-kit | SQL-first, type-safe, agent-friendly migrations |
| Cache / hot state | Redis 7 | Sessions, orderbook snapshots, rate limits |
| Event bus | NATS JetStream | Module decoupling, event sourcing for ledger + orders |
| Frontend | Next.js 15 (App Router) | All user surfaces, one design system |
| Realtime | WebSocket gateway (uWebSockets.js) | Orderbook, lobbies, agent streams |
| Auth | Own service — JWT (short) + rotating refresh, TOTP 2FA, WebAuthn | Sovereignty; no third-party auth dependency |
| Queue / jobs | BullMQ (Redis) | Settlements, payouts, emissions, notifications |
| AI layer | Model-agnostic gateway service (`svc-agents`) | Anthropic API first; providers swappable per Doctrine 5 |
| Infra | Docker Compose (dev) → Kubernetes (prod) | Deterministic envs for agents; scale path |
| Observability | OpenTelemetry + Grafana stack | Traces across every module from day one |
| Testing | Vitest (unit) + Playwright (e2e) + drizzle test DB | DoD gates in §14 |

**Rust port path:** `svc-matching` and `svc-mining-pool` are the only services with hard performance ceilings. Both are specced with narrow gRPC interfaces so a Rust rewrite is a drop-in swap. Do not prematurely optimize; TS v1 handles soft-launch volume.

---

## 2 · MONOREPO LAYOUT

```
intafaced/
├── apps/
│   ├── web/                  # Next.js — all user surfaces (trade, bank, pay, academy…)
│   ├── admin/                # Next.js — operator console (Core ops, compliance, listings)
│   └── ws-gateway/           # WebSocket fan-out (orderbook, lobbies, agent streams)
├── services/
│   ├── svc-identity/         # Accounts, auth, KYC state, rank & XP          [PHASE 1]
│   ├── svc-ledger/           # Double-entry ledger — the single balance graph [PHASE 1]
│   ├── svc-token/            # Token accounting, staking, emissions, burn    [PHASE 1]
│   ├── svc-matching/         # Orderbook + matching engine (isolated, gRPC)  [PHASE 2]
│   ├── svc-trade/            # Markets, orders API, fees, copy-trading       [PHASE 2]
│   ├── svc-pay/              # Gateway/PSP/PayFac core + rail adapters       [PHASE 3]
│   ├── svc-p2p/              # Offers, escrow, disputes, reputation          [PHASE 3]
│   ├── svc-blueprint/        # GMaster Neural Engine consumer + matching     [PHASE 4]
│   ├── svc-bank/             # Accounts UX, loans, yield, card middleware    [PHASE 5]
│   ├── svc-launch/           # Launchpad, meme factory, NFT, RWA             [PHASE 5]
│   ├── svc-dex/              # Contracts interface, pools, self-custody      [PHASE 5]
│   ├── svc-academy/          # Lobbies, curriculum, certifications           [PHASE 5]
│   ├── svc-market/           # Vendor marketplace                            [PHASE 5]
│   ├── svc-mining-pool/      # PoW pool, shares, payouts                     [PHASE 5]
│   ├── svc-agents/           # Agent fleet runtime + model gateway           [PHASE 5]
│   └── svc-core-ops/         # Support, CRM, affiliates, compliance ops      [PHASE 5]
├── packages/
│   ├── contracts/            # Shared zod schemas + tRPC routers + event types
│   ├── db/                   # Drizzle schemas per service, migration tooling
│   ├── ui/                   # Design system — black glass / phosphor green
│   ├── ledger-client/        # The ONLY way any service touches balances
│   ├── events/               # NATS subjects, publishers, typed consumers
│   ├── auth/                 # JWT verify, guards, permission scopes
│   └── config/               # Env, feature flags, jurisdiction config
├── tooling/
│   ├── agent-protocol/       # Cursor agent execution rules (§15)
│   └── ci/                   # Turbo pipelines, DoD gate scripts
├── docker-compose.yml        # postgres, redis, nats, grafana — one command up
├── turbo.json
└── INTAFACED_DEFINITIVE_BUILD.md   # This file. The law.
```

**Rule:** services never import each other's DB schemas. Cross-service calls go through `packages/contracts` (tRPC) or `packages/events` (NATS). Balance mutations go through `packages/ledger-client` only.

---

## 3 · PHASE 0 — FOUNDATIONS

Deliverables before any product code:

- [ ] Monorepo scaffolded per §2, `pnpm i && turbo build` green
- [ ] `docker-compose up` boots Postgres 16, Redis 7, NATS JetStream, Grafana
- [ ] `packages/config`: typed env loader, feature flags, `JURISDICTION_MATRIX` (geo rules per module)
- [ ] `packages/events`: NATS subject naming law — `intafaced.<service>.<entity>.<verb>` (e.g. `intafaced.ledger.tx.posted`)
- [ ] `packages/contracts`: zod-first schema pattern established with one example router
- [ ] CI: lint, typecheck, unit tests, migration check on every PR; DoD gate script stub
- [ ] `packages/ui`: design tokens locked — pure black `#000`, phosphor green `#00FF41` primary, glass surfaces (`backdrop-blur`, 1px `rgba(0,255,65,0.15)` borders), Orbitron (display) + Inter (body) for platform; console/HUD component primitives: `Panel`, `Ticker`, `RankBadge`, `StatBlock`, `LobbyCard`

---

## 4 · PHASE 1 — THE CORE

Three services. This phase is the entire foundation. **No Phase 2 work begins until §14 DoD passes for all three.**

### 4.1 svc-identity

One account, one verification, one rank — the key that opens every room.

**Schema (Postgres, drizzle):**

```sql
users            (id uuid pk, handle citext unique, email citext unique,
                  password_hash, totp_secret, webauthn_creds jsonb,
                  status enum[active,frozen,closed], created_at)
profiles         (user_id fk, display_name, avatar_url, modes text[],  -- trader|merchant|creator|student
                  locale, region, blueprint_id nullable)
kyc_records      (id, user_id, tier enum[none,basic,full,institutional],
                  provider_ref, jurisdiction, status enum[pending,approved,rejected,expired],
                  reviewed_at, expires_at)
rank_state       (user_id pk, rank int, xp bigint, season_xp bigint, updated_at)
xp_events        (id, user_id, source_module, action, xp_delta, meta jsonb, created_at)
rank_thresholds  (rank int pk, xp_required bigint, perks jsonb)  -- fee cuts, limits, hosting rights
sessions         (id, user_id, refresh_hash, device, ip, expires_at, revoked)
api_keys         (id, user_id, name, key_hash, scopes text[], domain_whitelist text[], created_at)
sub_accounts     (id, parent_user_id, label, purpose)  -- strategies/teams/funds; ledger-visible
```

**Rank mechanics (cross-module by design):**
- Every module emits `intafaced.identity.xp.earned` events with `{userId, sourceModule, action, xpDelta}`
- svc-identity is the only writer to `rank_state`; recalculates rank on XP events
- `rank_thresholds.perks` is the machine-readable perk table other services query: `{feeDiscountBps, p2pLimitMultiplier, copyFollowerCap, lobbyHostRights, cardTier}`
- Academy certifications, P2P completion record, copy-trade performance → all just XP events with meta. One graph.

**API (tRPC internal + REST public):**
- `auth.register / login / refresh / logout / totp.enroll / webauthn.enroll`
- `kyc.start / kyc.webhook / kyc.status`
- `rank.get(userId)` · `rank.perks(userId)` — hot-cached in Redis, invalidated on XP events
- `apiKeys.create/list/revoke` (scoped: `trade:read`, `trade:write`, `pay:write`, …)

### 4.2 svc-ledger — THE BALANCE

The single wallet graph. Double-entry. Every value movement in the OS posts here.

**Schema:**

```sql
assets           (id text pk,            -- 'BTC','USDT','USD','EUR','IFC' (native token)
                  kind enum[crypto,fiat,native], decimals int, active bool)
accounts         (id uuid pk, owner_type enum[user,subaccount,module,house,treasury],
                  owner_id uuid, asset_id fk, kind enum[available,hold,escrow,stake,collateral],
                  created_at, unique(owner_type,owner_id,asset_id,kind))
ledger_tx        (id uuid pk, idempotency_key text unique, module text,
                  reason text,           -- 'trade.fill','pay.settlement','p2p.escrow.lock',…
                  meta jsonb, posted_at timestamptz, hash bytea)  -- hash-chained
ledger_entries   (id bigserial pk, tx_id fk, account_id fk,
                  direction enum[debit,credit], amount numeric(38,18),
                  balance_after numeric(38,18))
balance_snapshots(account_id, as_of, balance)  -- hourly job, reconciliation anchor
```

**Invariants (enforced in service, tested to destruction):**
1. Every `ledger_tx` sums to zero per asset (Σ debits = Σ credits). Enforced in one serializable transaction.
2. `available` accounts can never go negative. `hold/escrow/stake/collateral` moves are always paired with an `available` counter-entry.
3. All writes via `packages/ledger-client` → `ledger.post({idempotencyKey, module, reason, entries[]})`. No raw SQL from other services, ever.
4. Hash chain: each tx hash = H(prev_hash ‖ tx canonical form). Tamper-evident book.
5. Reconciliation job: snapshots vs. entry replay must match to 18 decimals; mismatch = page the operator, freeze the module that diverged.

**Standard flows (specced as ledger recipes in `packages/ledger-client/recipes/`):**
- `deposit(user, asset, amount, rail)` — house omnibus ↔ user available
- `withdraw` — available → hold → (rail confirms) → house omnibus; reversal path defined
- `tradeFill(maker, taker, base, quote, price, qty, feeBps)` — 6-entry atomic tx incl. fee to house
- `escrowLock / escrowRelease / escrowRefund` (P2P)
- `stake / unstake` (token) · `collateralLock / liquidate` (loans)
- `feeCharge(user, module, asset, amount)` — with token-discount branch (§4.3)
- `rewardPay(user, reason)` — from rewards-engine account

### 4.3 svc-token — IFC

The native economy. Sources, sinks, flywheel — as code.

**Schema:**

```sql
token_params     (singleton: total_supply, emission_curve jsonb, halving_interval,
                  fee_discount_schedule jsonb, buyback_bps, burn_split_bps)
stakes           (id, user_id, amount, tier enum[flex,m3,m12], multiplier,
                  started_at, unlocks_at, status)
emission_epochs  (epoch int pk, scheduled_amount, mined_amount, difficulty, closed)
buyback_runs     (id, revenue_window, revenue_total jsonb, tokens_bought,
                  tokens_burned, tokens_to_rewards, executed_at)
governance_votes (id, proposal_id, user_id, weight, choice, cast_at)
proposals        (id, kind enum[listing,fee_param,curriculum,grant], body jsonb,
                  status, opens_at, closes_at)
```

**Mechanics:**
- **Fee currency:** `feeCharge` recipe checks payer's IFC balance + published decay schedule → discount applied, IFC leg posted to house fee account
- **Access tiers:** other services call `token.stakeOf(userId)` (cached) to gate launchpad allocations, OTC access, premium lobbies, vendor slots
- **Real-yield staking:** weekly job aggregates house fee accounts per asset → distributes pro-rata by stake × multiplier via `rewardPay` recipes. Real revenue, not emissions.
- **Buyback & burn:** fixed `buyback_bps` of platform revenue per window → market-buy on internal book (Phase 2+) → split to burn address account + rewards engine account. Structural, scheduled, logged in `buyback_runs`.
- **Mining emissions:** svc-token owns the emission schedule; svc-mining-pool (Phase 5) requests epoch allocations — token service is the only minter.
- **Gas:** internal transfer / deploy / mint actions call `feeCharge(reason:'gas')` in IFC.

### 4.4 Phase 1 exit criteria
- Ledger invariant suite: 100% pass incl. concurrency torture test (1k parallel posts, zero drift)
- Full auth lifecycle e2e: register → TOTP → session refresh → API key scoped call
- XP event → rank recalc → perks visible across a second service (stub consumer)
- Token: stake, fee-discount branch, and a simulated buyback run all reconcile in the ledger

---

## 5 · PHASE 2 — TRADE

The trading heart. Two services: the isolated engine and the product layer.

### 5.1 svc-matching (isolated, gRPC, Rust-portable)

**Responsibility:** orderbooks and matching only. No balances, no users — it speaks in account IDs and receives pre-validated orders. Deterministic, event-sourced, replayable.

- In-memory books per market: price-time priority, limit/market/stop, post-only, IOC/FOK
- Input: `SubmitOrder`, `CancelOrder` (gRPC). Output: `OrderAccepted`, `Fill`, `OrderCancelled` events → NATS `intafaced.matching.*`
- Every input persisted to an append-only `engine_journal` before processing → full replay = current book state (recovery guarantee)
- Snapshot every N events to Redis for ws-gateway depth streaming
- Determinism test: replay journal twice → byte-identical book state

### 5.2 svc-trade (product layer)

**Schema:**
```sql
markets        (id, base_asset, quote_asset, kind enum[spot,futures,options],
                tick_size, lot_size, status, maker_bps, taker_bps, listed_at)
orders         (id, user_id, sub_account_id, market_id, side, type, price, qty,
                filled_qty, status, tif, created_at)
fills          (id, order_id, counter_order_id, price, qty, fee_asset, fee_amount, ts)
positions      (id, user_id, market_id, side, size, entry_px, margin_mode,
                margin, liq_px, funding_paid)          -- futures
funding_rates  (market_id, window, rate, paid_at)
insurance_fund (asset, balance_ref)                     -- ledger house account ref
copy_leaders   (user_id, tier, sub_price, fee_share_bps /* not P&L profit-share — banned */, audited_stats jsonb, status)
copy_follows   (follower_id, leader_id, sizing_mode, max_alloc, active)
otc_quotes     (id, user_id, side, base, quote, qty, quoted_px, expires_at, status)
```

**Order flow (the money path — get this exactly right):**
1. REST/ws order in → auth + scope check → risk checks (market status, size limits by rank/KYC tier)
2. `ledger.hold` funds (quote for buys, base for sells; margin for futures) — atomic
3. Submit to svc-matching → on `Fill` event: `tradeFill` ledger recipe (6-entry, includes maker/taker fees with IFC discount branch) → on `Cancel`/expiry: release hold
4. XP event emitted per filled order; volume aggregates per user per window feed rank + fee-tier

**Futures:** cross + isolated margin, mark price from index feed, liquidation engine job (checks liq_px vs mark, partial-liquidation ladder, insurance fund backstop), funding every 8h as ledger recipes.
**Options (v1 scope):** European calls/puts on BTC/ETH, cash-settled, strategy-builder UI in the product shell (§5.3); margining conservative (full collateral) in v1.
**Convert:** RFQ against internal book + spread — one-tap swap endpoint.
**Copy trading:** leader fills fan out to followers as proportional child orders (queued, size-capped per follower guardrails); **fee-share** (slice of house trading fee per SPEC-SOVEREIGN-ROUTING-AND-COPY — **not** P&L profit-share; any gains%/HWM/success fee is banned in v1) settled by ledger recipe when owner publishes §8 rates; `audited_stats` written only by svc-agents Copy-Intel job (Phase 5) — until then, displayed stats computed from fills directly.
**OTC:** staked-tier gate via `token.stakeOf`, RFQ workflow, fills post directly to ledger with spread to house.
**Liquidity:** internal MM bot account (house-owned, own strategy config) seeds books at launch; external venue aggregation is an adapter behind `LiquiditySource` interface — later, per Doctrine 4.
**Forex markets:** same engine, `kind:spot` with fiat pairs — rails to fund them arrive with svc-pay adapters.

### 5.3 The product shell — `apps/customer` (React) on `:8090`

Superseded 2026-10-16. The served customer screen is `apps/customer`, built by compose service `vendor-shell`. The Vue tree under `vendor/upstream-exchange/05_Web_Front` is not served. `apps/web` is not in the tree. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Audience that still stands: pro trader workbench; retail uses Convert and is not the terminal default.

- One React app, one shell frame, same-origin `/api/` and `/ws/`.
- Pro terminal: multi-book layout, depth, hotkeys, the chart already in the product, sub-account switcher.
- Convert: the retail swap path.
- Copy, inside this same app: leader boards with audited badges, and a mirror-follow flow whose guardrail defaults come from Blueprint (Phase 4 hook). This is a requirement. It does not claim the screen is already built.
- Live depth and trades come from `svc-ws`, not from a separate `ws-gateway` app.

### 5.4 Phase 2 exit criteria
- Engine determinism replay test green; 10k orders/s sustained on dev hardware
- Ledger reconciliation across 100k simulated fills: zero drift
- Liquidation ladder test suite: no scenario breaches insurance fund without partial-liq first
- Full e2e: deposit (simulated rail) → limit order → fill → fee with IFC discount → withdraw hold

---

## 6 · PHASE 3 — PAY + P2P

### 6.1 svc-pay

Three modes, one core: Gateway (white-label), PSP (own the merchant), PayFac (sub-merchant trees).

**Schema:**
```sql
merchants        (id, user_id, kyb_status, tier, mode enum[gateway,psp,payfac],
                  pricing jsonb, settlement_prefs jsonb, status)
sub_merchants    (id, payfac_merchant_id, kyb_ref, role_grants jsonb, status)
payment_profiles (id, merchant_id, checkout_config jsonb, fee_routing jsonb, domains text[])
payments         (id, merchant_id, profile_id, amount, currency, method,
                  rail_adapter, rail_ref, status enum[created,authorized,captured,
                  settled,refunded,disputed,failed], risk_score, created_at)
payment_events   (id, payment_id, event, payload jsonb, ts)   -- full state history
settlements      (id, merchant_id, window, gross, fees, net, payout_method,
                  payout_ref, status)
disputes         (id, payment_id, reason, evidence jsonb, status, due_at)
payment_links    (id, merchant_id, profile_id, slug, amount nullable, expires_at)
subscriptions    (id, merchant_id, customer_ref, plan jsonb, next_charge_at, status)
```

**Rail adapter interface (Doctrine 4 — the whole point):**
```ts
interface RailAdapter {
  id: string;                      // 'crypto-native' | 'card-generic' | later: 'settletx', 'paykwik', 'ntg', 'stripe', 'paypal'
  capabilities: RailCapability[];  // authorize, capture, refund, payout, webhook
  authorize(p: PaymentIntent): Promise<RailResult>;
  capture(ref: string): Promise<RailResult>;
  refund(ref: string, amount: Amount): Promise<RailResult>;
  payout(s: SettlementInstruction): Promise<RailResult>;
  verifyWebhook(req): RailEvent | null;
}
```
- **v1 ships two adapters:** `crypto-native` (real: on-chain USDT/USDC/BTC/ETH acceptance with instant convert via svc-trade Convert) and `card-sandbox` (full flow against a mock acquirer for end-to-end testing). SettleTX/PayKwik/NTG/Stripe/PayPal drop in later as adapters with zero core changes.
- **Smart routing:** rules table (geo, method, amount band, risk score, live approval-rate stats per adapter) → agent-tunable in Phase 5
- **Settlement:** merchant net posts to their ledger account (same balance graph they trade/spend from — the doc's promise, kept); payout to bank/crypto via adapter `payout`
- **Merchant crypto acceptance for any user:** flip `modes += merchant` on profile → instant `crypto-native` acceptance, payment links, hosted checkout
- Checkout builder, hosted pages, plugins (Woo/Magento/OpenCart) in the product shell (§5.3) + public REST

### 6.2 svc-p2p

**Schema:**
```sql
offers        (id, maker_id, side, asset, fiat_currency, price_type enum[fixed,float],
               price, min_amt, max_amt, methods jsonb, terms text, status)
p2p_trades    (id, offer_id, taker_id, amount, fiat_amount, method,
               status enum[created,escrowed,fiat_sent,released,cancelled,disputed],
               chat_thread_id, deadlines jsonb)
p2p_disputes  (id, trade_id, opened_by, evidence jsonb, moderator_id, resolution, ts)
p2p_reputation(user_id, completed, completion_rate, avg_release_secs,
               disputes_lost, badges text[])
p2p_merchants (user_id, verified, limits jsonb, api_access bool)
```

**Escrow = ledger recipes** (`escrowLock` on taker accept → `escrowRelease` on maker confirm / `escrowRefund` on cancel / moderator resolution path). Reputation events feed the same XP graph — a spotless P2P record raises limits everywhere (rank perks table).
100+ fiat currencies = config, not code: `fiat_currencies` seed table + display formatting in `packages/config`.

### 6.3 Phase 3 exit criteria
- Payment lifecycle e2e on both v1 adapters incl. refund + dispute + settlement to ledger
- Adapter conformance test kit (any future adapter must pass it before merge)
- P2P full trade + dispute resolution e2e; escrow invariants tortured (no path strands funds)
- PayFac: sub-merchant onboard → payment → split settlement across the tree

---

## 7 · PHASE 4 — SOVEREIGN BLUEPRINT

### 7.1 svc-blueprint

Consumes the **GMaster Neural Engine** as an internal service (HTTP contract to the GMaster deployment; engine internals live in the GMaster codebase, not here).

**Branding law (Doctrine 7):** everything user-facing says *Identity Blueprint / Neural Engine / Sovereign Intelligence* only.

**Schema:**
```sql
blueprints      (id, user_id unique, engine_version, profile jsonb,
                 -- {decisionStyle, riskTemperament, energyRhythm, learningMode, crewRole}
                 card_asset_url, visibility enum[private,crew,public], created_at)
crews           (id, name, formed_at, season, xp bigint, lobby_id nullable)
crew_members    (crew_id, user_id, role, joined_at)
match_runs      (id, user_id, candidates jsonb, scores jsonb, placed_crew_id, ts)
mentor_matches  (student_id, mentor_id, fit_score, status)
```

**Flow:** signup → Blueprint session (voice/text via svc-agents gateway, guided sequence + birth data) → engine returns profile JSON → **Blueprint card rendered server-side** (satori/resvg → PNG, brand-heavy, share-optimized — this is the acquisition artifact, treat it as a product) → matching job scores open crews on complementary-profile heuristics → placement + mentor shortlist + curriculum path + default agent guardrails written to profile.

**Downstream reads:** svc-trade (guardrail defaults), svc-academy (curriculum path, lobby routing), svc-agents (tone register). All read-only consumers of `blueprints.profile`.
**Ownership:** export (JSON + card) and hard-delete endpoints — portable, deletable, per the doc's promise.

### 7.2 Phase 4 exit criteria
- Full onboarding e2e: signup → session → reveal → crew placement < 3 minutes
- Card renders pixel-perfect at share sizes (1080×1350, 1200×630); no third-party system names anywhere in output (automated copy-scan test in CI)
- Deletion truly cascades; export complete

---

## 8 · PHASE 5 — THE REMAINING SURFACES

Each lands on the finished Core. Build order within phase: **Bank → Agents → Academy → Launch → Mine → DEX → Market → Core-Ops** (Bank monetizes existing users; Agents multiply every other module).

### 8.1 svc-bank
- Multi-currency account UX over existing ledger accounts (no new balance system — views + rails)
- **Loans:** `collateralLock` recipe, portfolio-aware LTV job (marks from svc-trade index prices), margin-call notifications, liquidation via internal book, interest accrual daily recipe
- **Earn:** flexible/fixed pools as stake-kind ledger accounts; native staking already lives in svc-token
- **Cards:** `CardIssuerAdapter` interface (issue, fund, authorize-webhook, controls). v1 ships `card-sim` adapter completing the full flow: auth webhook → real-time ledger check → crypto-to-fiat convert at spend via Convert → approve/decline < 2s budget → cashback recipe in IFC. Real issuer drops in later per Doctrine 4.
- Fiat on/off ramp = svc-pay adapters reused

### 8.2 svc-agents
- **Model gateway:** provider-agnostic completion API (Anthropic first), per-task model routing table, token/cost metering per user → premium agent tiers billed via ledger
- **Fleet runtime:** each agent = defined toolset + guardrail schema + audit log. Every action → `agent_actions` table + user-visible log (Agentic Law from Vol. I)
- v1 fleet: **Navigator** (tool-calling over all module APIs, exec inside user guardrails), **Support** (KB + account-state grounded, escalation w/ case file), **Market Scanner** (jobs over trade data → ranked signals by tier), **Merchant Agent** (approval-rate watch, routing proposals)
- v2: Portfolio (auto-rebalance in guardrails), Copy-Intel (writes `audited_stats`), Launch, Risk & Compliance (screening + report drafts), Coach, Growth

### 8.3 svc-academy
- **Lobbies:** rooms (capacity tiers: free/staked/invite), stage + chat + shared charts via ws-gateway; streaming ingest v1 = LiveKit self-hosted (WebRTC SFU, self-hosted per sovereignty; behind `StreamProvider` interface)
- Spatial layer v1 = 2D navigable room canvas (avatars, presence, rank visible); VR-ready = keep scene state serializable
- Ambassadors: residency contracts, per-session IFC pay + sub revenue share (ledger recipes), displayed ambassador rank
- Curriculum: import the existing 23-document DERIV//DESK library (20 playbooks + 3 workbooks) as the day-one curriculum spine, re-skinned to platform brand; paths sequenced by Blueprint; simulated-environment workbooks run against a paper-trading market flag in svc-trade
- Certifications → XP events + perks (fee cuts, follower caps, hosting rights) — already wired via rank system
- Tournaments: seasonal ladders on paper or live PnL, IFC prize pools from rewards engine

### 8.4 svc-launch
- Token factory: ERC-20 deploy via audited template contracts (viem), params locked in UI; instant market creation in svc-trade + optional seed pool in svc-dex
- Meme factory: name/ticker/supply/art → contract + listing + LP in one flow; creation fee + perpetual trading fees
- Launchpad raises: presale/fair-launch configs, vesting schedules enforced by contract + platform escrow, allocation tiers by `token.stakeOf`
- NFT: mint/list/auction, on-chain royalty enforcement, media on own object storage
- RWA: issuance registry + compliance flags per jurisdiction; activates fully with licensing (config-gated)

### 8.5 svc-mining-pool
- Stratum-style share protocol for the MatMul PoW (spec from token paper); share validation workers; difficulty per epoch from svc-token
- Solo + pooled modes, PPLNS payouts as ledger recipes, live dashboards; pool fee 1–3% to house
- Testnet mode flag for Phase 0 of the launch sequence

### 8.6 svc-dex
- Non-custodial wallet (client-side keys, MPC optional later), multi-chain via viem
- AMM pools from audited templates, IFC pairs seeded at launch
- Smart order router: internal book vs. pool quote → best execution
- No-KYC lane gated by `JURISDICTION_MATRIX`
- Operator oversight: full analytics read, zero custody

### 8.7 svc-market
- Vendor lifecycle: apply → vet → list; slots partly gated by stake
- Listings, subscriptions, one-time purchases — all settled via ledger recipes with house commission
- Vendor API scopes ride the existing api_keys system

### 8.8 svc-core-ops
- Support desk (tickets + KB, Support Agent first-line), CRM, affiliate/IB trees (multi-tier commission config, payout automation via ledger), referral tracking, compliance ops (screening queues, report drafts, geo-block + VPN/Tor detection at edge), analytics warehouse (read-replica + cube layer), marketing engine hooks
- **Admin app** (`apps/admin`): listings control, fee params, jurisdiction matrix, treasury ops, buyback runs, module kill-switches

---

## 9 · CROSS-CUTTING SYSTEMS

- **Public API:** REST + webhooks, named keys, scopes, domain whitelist, sandbox env — one gateway in front of trade/pay/data
- **Notifications:** event-driven fan-out (in-app, push, email/SMS adapters)
- **i18n:** all surfaces keyed from day one; 100+ languages = translation files, not refactors
- **Security:** argon2id, TOTP + WebAuthn, withdrawal allow-lists + delay tiers, device fingerprints, rate limits per scope, secrets via vault, three-layer custody ops runbook (cold/warm/hot house wallets with multi-sig approval workflow in admin)
- **Compliance:** KYC tiers gate limits per `JURISDICTION_MATRIX`; every module checks the matrix — geo rules are config, launch markets are a toggle
- **Observability:** every ledger recipe, order, payment traced end-to-end; SLO dashboards per module

---

## 10 · DATA & EVENT LAW

- NATS subjects: `intafaced.<service>.<entity>.<verb>` — versioned payloads in `packages/events`, consumers idempotent
- Event sourcing where money moves: ledger, matching journal, payment_events — replayable by design
- PII isolation: KYC docs in separate encrypted store; services get status flags, never documents

## 11 · LAUNCH-SEQUENCE MAPPING (Vol. I §XV → build flags)

| Drop phase | Feature flags on |
|---|---|
| 0 · Tease | waitlist + referral queue, mining testnet |
| I · Blueprint | onboarding + card share, founding badges (NFT mint), token paper |
| II · Lobby preview | academy invite lobbies, mining mainnet, card waitlist |
| III · Soft launch | ranked waves, meme factory |
| IV · Public drop | full open, TGE + listing + staking, tournament |
| V · Seasons | season engine, limited drops |

Everything ships dark behind flags; the drop sequence is configuration, not deployment risk.

## 12 · BUILD PHASES SUMMARY

| Phase | Scope | Gate |
|---|---|---|
| 0 | Foundations, design system | tooling green |
| 1 | **THE CORE** — identity, ledger, token | invariant suite + e2e |
| 2 | Matching + Trade + terminal | determinism + zero-drift |
| 3 | Pay + P2P (adapter architecture) | lifecycle e2e + conformance kit |
| 4 | Blueprint onboarding | 3-min e2e + brand-scan |
| 5 | Bank → Agents → Academy → Launch → Mine → DEX → Market → Ops | per-module DoD |

## 13 · WHAT IS DELIBERATELY NOT IN v1
- Rust engine port (interface ready; port when volume demands)
- External liquidity venue aggregation (adapter interface ready)
- Live card issuer / bank / PSP partner rails (adapters ready; `crypto-native` is real from day one)
- VR lobby client (scene state ready)
- MPC custody for DEX wallets

Nothing here blocks launch; everything here has a socket waiting (incl. first-party Woo/Magento/OpenCart PHP packages — consume svc-pay/src/plugins reference client + webhook vectors; PHP CMS is out-of-monorepo CI).

## 14 · DEFINITION OF DONE (per module — "never half done", enforced)
1. All schema migrations reversible and applied in CI
2. Unit coverage on money paths ≥ 95%; ledger recipes have invariant tests
3. e2e happy path + top-3 failure paths green in CI
4. Every user-facing string i18n-keyed; brand-scan clean (Doctrine 7)
5. Observability: traces + at least one SLO dashboard panel
6. Admin controls: kill-switch + config surface in `apps/admin`
7. Docs: service README with API contract, event subjects, ledger recipes used
8. Zero TODOs referencing "later" without a §13 socket entry

## 15 · AGENT EXECUTION PROTOCOL (Cursor)
1. Read this file + target service README before any edit
2. One service per task; cross-service needs = contracts/events PR first
3. Never write raw SQL to another service's tables; never move value outside ledger-client
4. Every PR: migration check, typecheck, tests, brand-scan
5. On ambiguity: the doctrine (§0) decides; if it doesn't, stop and ask D.

---

# v1.1 AMENDMENT — THE PROTOCOL PLANE
### Web4 Architecture · Sovereign Lane · INTACHAIN

## 16 · ADDITIONAL DOCTRINES

8. **Two planes, one economy.** The Fiat Plane (custodial: Trade, Bank, Pay, cards) runs fully compliant — it is what connects fiat, card networks, and institutional flow. The Protocol Plane (INTACHAIN) is genuinely non-custodial — self-custody wallets, on-chain order books, contract-held collateral. Identity rank, Blueprint, agents, and IFC travel across both. This is the Web4 claim, made structural.
9. **Sovereignty by architecture, not evasion.** No-KYC exists on the Protocol Plane because there is nothing to KYC — the platform never holds user assets there. Reference proof: Hyperliquid's entire model (self-custody + fully on-chain CLOB → no identity requirement, and it out-volumes every other on-chain venue). Anywhere the platform *does* take custody or touch card networks, verification applies per jurisdiction. We never ship a custodial product pretending to be decentralised.
10. **The custody boundary is drawn in code.** An automated CI check (`custody-scan`) asserts that no Protocol Plane service imports `ledger-client` write recipes and no contract grants platform keys withdrawal power over user funds. Provably non-custodial or it doesn't merge.

## 17 · INTACHAIN — THE SOVEREIGN CHAIN

### 17.1 Target architecture (Hyperliquid-class, honestly sequenced)
End state mirrors the proven shape: one chain, BFT consensus, two execution domains —
- **INTACORE:** native financial engine at the chain level — fully on-chain CLOB (price-time priority, tick/lot rules), perp + spot markets, protocol-level margining and liquidations, one-block finality
- **INTAEVM:** EVM environment secured by the same validators, reading INTACORE state directly — builders deploy against our liquidity permissionlessly

### 17.2 Buildable path (no fantasy engineering)
- **P0 — Contracts on proven rails.** Deploy the sovereign suite (smart accounts, AMM pools, lending markets, on-chain P2P escrow) as contracts on an established EVM L2 + optionally HyperEVM itself to tap existing liquidity. Ship value in weeks, learn in production.
- **P1 — Own chain, proven stack.** INTACHAIN v1 as a Cosmos SDK / CometBFT chain with a **native CLOB module** (the dYdX v4 precedent — in-validator order book, buildable by a small team) plus an EVM module sharing state. Sovereign, fast finality, our validators + permissionless set over time. **Implement parked 2026-09-03** until Nitro GO: [`docs/adr/2026-09-03-protocol-rails-until-intachain.md`](docs/adr/2026-09-03-protocol-rails-until-intachain.md). Operating rails until then: house book (`svc-matching`) + Protocol P0 on Base. Not a cut of this end-state.
- **P2 — Performance core.** Rust execution engine for the CLOB module (the same narrow interface as `svc-matching` — the Fiat Plane engine and INTACORE share the matching spec, one codebase target), scaling toward Hyperliquid-class throughput.
- **P3 — Progressive decentralisation.** Validator set opens on a published schedule; governance (IFC-weighted, already specced §4.3) takes parameter control. Decentralisation is a roadmap with dates, not a marketing word.

### 17.3 IFC on-chain
- Gas asset on INTACHAIN; staking secures validators (real security budget, not APY theatre)
- Protocol fee flow mirrors the strongest live precedent: dominant share of chain trading fees → continuous open-market IFC buyback (unifies with §4.3 buyback engine — one flywheel across both planes)
- Same token, two planes: bridged canonically; ledger IFC and chain IFC are one supply, reconciled by the bridge contract + `svc-bridge` attestation

### 17.4 Self-custody smart accounts
- Passkey-native account abstraction: email/passkey login creating a smart contract wallet — Hyperliquid-grade onboarding ease, zero seed-phrase wall, social recovery
- User keys only; platform holds session-scoped permissions the user grants and revokes (trading session keys, spend allowances) — never withdrawal rights (Doctrine 10)
- Same wallet funds the sovereign card and trades INTACORE

### 17.5 New services
```
services/
  ├── svc-chain/        # INTACHAIN node ops, validator tooling, chain config
  ├── svc-indexer/      # Chain → Postgres read models for the shell (books, fills, positions)
  ├── svc-bridge/       # Fiat Plane ↔ Protocol Plane transfers; canonical IFC bridge;
  │                     #   deposit/withdraw between ledger and chain with attestations
  └── svc-protocol/     # Contract suite lifecycle: smart accounts, AMM, lending,
                        #   on-chain escrow, launch factory contracts; audit pipeline
```
`svc-dex` (§8.6) is absorbed into this plane — the DEX is not a module beside the exchange; it IS the Protocol Plane's front door.

## 18 · THE SOVEREIGN CARD

The durable version of the Genesis-class card — engineered so it can't be rugged:
- **Self-custody funded:** funds live in the user's smart account until the authorization moment; spend pulls exact fiat equivalent via just-in-time conversion. The issuer never holds balances — a program shutdown strands zero user funds (the failure mode that kills every pure no-KYC card program).
- **Tiered access:** minimal-verification low-limit tier where issuer jurisdiction lawfully allows simplified due diligence; higher limits step up verification. Friction-tiering, not compliance-skipping — this is why the card is still alive in year three.
- **Adapter-isolated:** rides the existing `CardIssuerAdapter` (§8.1). Issuer risk is a swappable module; the smart-account funding contract is ours and permanent.
- Cashback in IFC on-chain; card tier tracks rank across both planes.

## 19 · WEB4 — THE THIRD PLANE
What bridges the two planes is what no competitor has, and it is already specced:
- **Portable sovereign identity:** rank, reputation, and Blueprint issued as on-chain attestations containing zero PII — provable standing without identity disclosure. A no-KYC user on the Protocol Plane still carries earned rank, crew, and perks.
- **Agents across both planes:** Navigator executes on INTACORE via user-granted session keys under the same guardrail law (§8.2). The first agent-native chain UX.
- **One economy:** IFC, one supply, one flywheel; fees from both planes feed one buyback; the Academy trains users who trade on either plane; the P2P escrow runs custodial (ledger) or sovereign (contract) at the user's choice.
Web2 rails in. Web3 settlement out. Intelligence binding them. That is the Web4 standard, in code.

## 20 · BEAT-THE-LEADER TARGETS (engineering SLOs, not slogans)
| Benchmark | Leader today | INTAFACED target |
|---|---|---|
| On-chain CLOB throughput | Hyperliquid ~200k ord/s | P1: 10k/s (CometBFT CLOB) → P2: 100k+/s (Rust core) |
| Perp finality | ~1 block / sub-second | ≤ 1 block on INTACHAIN |
| CEX matching (Fiat Plane) | Binance-class latency | < 5ms p99 internal match (Rust port trigger: >10k/s sustained) |
| Card auth decision | Revolut-class | < 2s incl. on-chain JIT conversion |
| Onboarding to first trade | Hyperliquid email login | ≤ 3 min incl. Blueprint (§7.2) — with identity intelligence they lack |
| Fee → value loop | HYPE ~97% fees to buyback | Published %, both planes, one token |

## 21 · REVISED PHASE MAP
| Phase | Scope |
|---|---|
| 0–1 | Foundations + Core (unchanged — the ledger runs the Fiat Plane and the bridge accounting) |
| 2 | Matching + Trade (unchanged; matching spec now dual-target: svc-matching AND INTACORE module) |
| 3 | Pay + P2P (unchanged) |
| **3P** | **Protocol P0:** contract suite on proven rails, smart accounts, sovereign P2P escrow live |
| 4 | Blueprint (+ on-chain attestation issuance) |
| **4P** | **Protocol P1:** INTACHAIN mainnet — native CLOB, INTAEVM, IFC gas + staking, bridge live |
| 5 | Remaining Fiat Plane surfaces (§8) + sovereign card |
| **5P** | **Protocol P2–P3:** Rust core, validator opening, governance handover schedule published |

---

# v2.0 FINAL — SOVEREIGN BANKING, SOVEREIGN RAILS, FULL COVERAGE

## 22 · THE SOVEREIGNTY LAW (supersedes any ambiguity)

**Zero-KYC follows custody. Everywhere. Without exception.**
- If the platform never holds the asset → the feature ships permissionless: no KYC, no KYB, no account gate beyond a wallet. Enforced by `custody-scan` (Doctrine 10).
- If the platform holds the asset or touches fiat/card-network rails → the feature ships on the Fiat Plane with tiered verification per `JURISDICTION_MATRIX`.
- Every product below exists in its **maximum lawful sovereign form**. Nothing is left custodial that can be non-custodial.

## 23 · SOVEREIGN BANKING (Protocol Plane — zero KYC by architecture)

The full Revolut feature set, rebuilt non-custodial:

**ACCOUNTS** — Smart-account "vaults" per user: multi-asset self-custody balances (stables + majors) with banking-grade UX — named spaces, scheduled transfers, spend analytics computed client-side/indexer-side from chain data. No custodian → no identity requirement.
**SWAP / CONVERT** — One-tap sovereign convert: smart router across INTACORE books + AMM pools, executed from the user's own account via session key. Fiat-denominated display, crypto settlement. Zero KYC — it's their keys end to end.
**LOANS** — On-chain lending markets (Aave-class, ours): collateral locked in contracts, not our ledger; portfolio-aware LTV via oracle marks; liquidations by permissionless keepers + protocol backstop. Borrow stables against BTC/ETH/IFC with no application, no identity — the collateral IS the underwriting.
**EARN / YIELD** — On-chain sources only on this plane: IFC validator staking, lending-market supply APY, AMM LP fees, protocol real-yield share. Displayed as simple "vault yield" UX. No custodial pool ever masquerades as DeFi.
**CARD (SOVEREIGN TIER)** — Per §18: self-custody funded, JIT conversion at authorization, minimal-verification low-limit tier where issuer jurisdiction allows simplified due diligence; limits step up with verification. Funds never leave the user's account until the swipe clears. IFC cashback on-chain.
**P2P FIAT BRIDGE** — Where a sovereign user needs fiat in/out without the compliant plane: non-custodial P2P (§24 P2P row) — contract escrow, counterparty pays their bank rail directly. The platform never touches the fiat leg.
**RECEIVE / PAY ANYONE** — Handle-based transfers (rank-identity attestation → wallet resolution), payment requests, split bills — all contract transfers. Venmo UX, zero custodian.

## 24 · SOVEREIGN RAILS (zero-KYB merchant processing by architecture)

Full in-house processing stack, two lanes:

**LANE A — PERMISSIONLESS CRYPTO RAILS (zero KYB, Protocol Plane)**
- Merchant mode = deploying a **merchant contract** to the user's own smart account: acceptance address, auto-split rules, optional auto-convert to stables via sovereign router. One tap, no application, no KYB — because the platform is never in the flow of funds. Buyer pays merchant directly; contract handles conversion/splits; indexer renders the dashboard.
- Payment links / hosted checkout / QR / invoices / subscriptions (recurring pull via user-granted allowances) — all as contract interactions + hosted UI. A DM becomes a sale with no onboarding.
- 100+ asset acceptance via router; settlement instant, final, self-custodied.
- Protocol fee taken in-stream by the contract (published bps) → feeds the one buyback.
- High-risk verticals: no vertical gate exists on this lane — there is no counterparty to impose one. Sanctions-screening on the hosted front-end per applicable law; the contracts themselves are permissionless infrastructure.

**LANE B — IN-HOUSE FIAT PROCESSING (compliant plane — fully our stack)**
- Everything in §6.1 stands: own gateway, own PSP core, own PayFac trees, own routing, own fraud engine, own checkout, own analytics — 100% our software. External parties only where card-scheme membership legally requires a sponsor (acquiring BIN), specced as adapters; **path to principal membership / own acquiring licenses is the §13 socket** — the endgame is our own scheme connections.
- KYB here is tiered and fast (email → KYB → live in a day, per Vol. I) but it exists — no bank or scheme connects an anonymous processor, and this lane is what delivers PayPal/Stripe reach, cards, and bank settlement.
- **The bridge sell:** every Lane B merchant gets Lane A free — and every Lane A merchant can graduate to Lane B when they want fiat. One dashboard, two rails. That dual offer is itself the Web4 product no PSP has.

## 25 · FULL COVERAGE MATRIX — EVERY VOL. I FEATURE, MAPPED

Plane: **F** = Fiat (custodial/compliant) · **P** = Protocol (non-custodial/zero-KYC) · **B** = both planes

### TRADE (Vol. I §VI)
| Feature | Plane | Service | Phase |
|---|---|---|---|
| Spot order book (majors + ERC-20 + custom listings, fiat pairs) | B | svc-trade + INTACORE | 2 / 4P |
| Futures (cross/isolated, insurance fund, funding) | B | svc-trade + INTACORE | 2 / 4P |
| Options (calls/puts, strategy builder) | F→P | svc-trade; INTACORE later | 2 / 5P |
| OTC desk (RFQ, staked gate) | F | svc-trade | 2 |
| Convert one-tap | B | svc-trade / sovereign router | 2 / 3P |
| Copy trading (audited leaders, fee-share — not P&L profit-share) | B | svc-trade + session-key mirroring on-chain | 2 / 5P |
| Forex pairs | F | svc-trade (rails via svc-pay) | 2 |
| Matching engine (full depth) | B | svc-matching / INTACORE CLOB | 2 / 4P |
| Deep liquidity (internal MM day one; venue aggregation) | B | LiquiditySource adapters | 2 (§13 socket) |
| Algo execution TWAP/VWAP/EWAP/PVOL | F | svc-trade exec module | 2 |
| Sub-accounts + consolidated reporting | B | svc-identity + ledger | 1 |
| Pro terminal + native mobile | B | product shell §5.3 + mobile (§8 Core row) | 2 |
| 100+ languages | B | i18n system (§9) | 0 |

### DEX (§VII) — absorbed into Protocol Plane
| Web3 self-custody wallet (multi-chain, MFA) | P | smart accounts §17.4 | 3P |
| Smart-contract trading (on-chain settlement) | P | INTACORE + svc-protocol | 3P/4P |
| Liquidity pools (AMM, IFC pairs seeded) | P | svc-protocol | 3P |
| No-KYC lane | P | entire plane, by architecture | 3P |
| Smart routing (book vs pool best-ex) | P | sovereign router | 3P |
| Operator oversight (analytics, zero custody) | P | svc-indexer + admin | 4P |

### P2P (§VIII)
| Direct maker/taker trading | B | svc-p2p | 3 |
| Escrow protection + moderated disputes | B | ledger recipes (F) / escrow contracts (P) | 3 / 3P |
| 100+ fiat currencies, any payment method | B | config-driven | 3 |
| Reputation system (same XP graph) | B | svc-p2p → identity XP | 3 |
| Merchant programme (badges, limits, API) | B | svc-p2p | 3 |

### LAUNCH (§IX)
| Token launchpad (ICO/IDO, vesting, staked allocation tiers) | P | svc-launch + contracts | 5/3P |
| Meme factory (one-click, instant market + LP) | P | svc-launch → INTACORE permissionless spot listing (HyperEVM precedent) | 5P |
| Custom asset creation (ERC-20, multi-chain, admin) | B | svc-launch | 5 |
| Instant listing | B | svc-trade + INTACORE | 5 |
| Fundraising module (milestones, investor mgmt) | F | svc-launch | 5 |
| NFT marketplace (mint/auction, on-chain royalties) | P | svc-launch contracts | 5 |
| RWA tokenisation (licence-gated) | F | svc-launch + compliance flags | 5 (§13) |
| Structured issuance (wrapped/synthetic/structured) | F | svc-launch | 5 (§13) |

### BANK (§X)
| Multi-currency accounts | B | svc-bank (F) / §23 vaults (P) | 5 / 3P |
| Crypto loans (LTV, margin calls, liquidation) | B | ledger recipes (F) / lending contracts (P) | 5 / 3P |
| Earn & staking (flex/fixed; native real yield) | B | svc-token + svc-bank / on-chain §23 | 1–5 / 3P |
| Virtual cards (instant, Apple/Google Pay) | B | CardIssuerAdapter; sovereign tier §18 | 5 |
| Physical cards (rank-linked tiers, controls) | B | same | 5 |
| Cashback in token | B | rewardPay recipe / on-chain | 5 |
| Fiat on/off ramp | F | svc-pay adapters | 3–5 |
| DeFi modules (P2P lending, strategies) | P | svc-protocol | 5P |
| Smart-contract loan automation | P | lending contracts | 3P |

### PAY (§XI) — full list
| Branded gateway (zero third-party branding) | F | svc-pay + apps | 3 |
| PSP mode (own merchant, digital KYC/KYB, custom pricing) | F | svc-pay | 3 |
| PayFac mode (sub-merchants, 14 permission areas, settlement control) | F | svc-pay role grants | 3 |
| Smart routing (geo/card/risk/approval-rate) | F | routing engine + Merchant Agent | 3/5 |
| Multi-channel checkout: PayPal, Stripe rails, crypto 100+ assets, external wallets (MetaMask/Trust/Coinbase/Phantom/Brave/TronLink), guest checkout | B | adapters (F) + walletconnect (P) | 3 (§13 sockets for PayPal/Stripe) |
| Merchant onboarding (3-step, tiered limits, live in a day) | F | svc-pay | 3 |
| Dual settlement (bank IBAN/IFSC or crypto) | F | payout adapters | 3 |
| API-first (keys, scopes, webhooks, whitelist, sandbox) | B | public API gateway §9 | 3 |
| Fraud & risk (scoring, chargeback, decline recovery) | F | risk engine + agent | 3/5 |
| Checkout builder (fields, fee routing, discounts, shipping) | B | payment_profiles | 3 |
| Subscriptions (card + crypto recurring) | B | svc-pay / allowance contracts | 3/3P |
| High-risk verticals | B | Lane B policy / Lane A permissionless | 3/3P |
| Revenue analytics + export | B | svc-pay + indexer | 3 |
| Payment links + hosted checkout | B | both lanes §24 | 3/3P |
| Merchant crypto acceptance for any user | P | merchant contracts §24 Lane A — **zero KYB** | 3P |
| Commerce plugins (Woo/Magento/OpenCart) | B | svc-pay plugins reference client (+ §13 PHP CMS socket) | 3 |

### MARKET (§XII)
| All 8 vendor categories (bots, DeFi, compliance, payment ext., security/custody, data, advisory, partner integrations) | B | svc-market listings taxonomy | 5 |
| Vendor model (vet, listing fees, commissions, premium placement, stake-gated slots) | B | svc-market + token.stakeOf | 5 |

### ACADEMY (§XIII) — every listed item
| Live session lobbies (capacity tiers incl. penthouse) | B | svc-academy + ws-gateway | 5 |
| Spatial meta layer (avatars, stage, presence; VR-ready) | B | 2D canvas v1, serializable scenes | 5 |
| Ambassador residencies (IFC pay + rev share, displayed rank) | B | contracts + ledger recipes | 5 |
| Specialist rooms (futures/options/meme war room/forex/DeFi lab/merchant clinic) | B | room taxonomy config | 5 |
| Crew sessions (private lobbies, leaderboards, challenges) | B | svc-blueprint crews + academy | 4/5 |
| Stream-native design (clippable) | B | clip export pipeline | 5 |
| Events & tournaments (competitions, paper leagues, prize pools, card-tier prizes) | B | season engine | 5 |
| Structured paths (Blueprint-sequenced) | B | curriculum engine | 5 |
| Playbooks + workbooks (20+3 proprietary library imported day one) | B | DERIV//DESK port | 5 |
| Certification ranks → real perks | B | XP/perks system §4.1 | 1/5 |
| Video library | B | media service | 5 |
| AI Coach | B | svc-agents | 5 |
| Community & mentorship (matched crews, boards, leader pipeline) | B | blueprint + academy | 4/5 |
| Free tier + premium + staked lobbies + ambassador subs | B | access model + token gates | 5 |

### CORE (§XIV) — every listed item
| Support desk (AI first-line + KB) | — | svc-core-ops + Support Agent | 5 |
| CRM / HR & team / Finance (live revenue fused) / Project engine | — | svc-core-ops | 5 |
| Compliance (geo KYC/AML, geo-block, VPN/Tor detect, per-jurisdiction) | F | JURISDICTION_MATRIX + edge | 0–5 |
| Analytics (volume, cohorts, funnels, export) | — | warehouse §8.8 | 5 |
| Affiliate & IB network (multi-tier, sub-trees, payout automation) | — | svc-core-ops + ledger | 5 |
| Referrals (token-paid, tracked) | — | same | 5 |
| Marketing engine (+ Growth Agent) | — | svc-core-ops | 5 |
| Knowledge base / Workflow automation | — | svc-core-ops | 5 |
| Mining pool ops (solo+pooled, dashboards, payouts) | B | svc-mining-pool | 5 |
| Custody (cold/warm/hot, multi-sig approvals) | F | custody runbook + admin workflow §9 | 2 |
| Portfolio suite (users + house) | B | portfolio views over ledger+indexer | 5 |
| Site builder (drag-drop, live asset APIs, domains, SSL) | — | svc-core-ops builder | 5 |
| Social promotion (one-tap share, tracked attribution, every surface) | B | share pipeline + Blueprint cards | 4/5 |
| Developer platform (public APIs, docs, sandbox) | B | API gateway §9 | 3 |
| Mobile apps (iOS/Android, own name, zero attribution) | B | React Native app in apps/ | 2–5 |

### TOKEN (§IV) + BLUEPRINT (§III) + AGENTS (§V)
| Fee currency / access tiers / PoC mining (MatMul, H200/B200, halvings, pools) / real-yield staking / governance / gas / rewards engine / burn-buyback / full distribution table | B | svc-token + svc-mining-pool + INTACHAIN | 1/5/4P |
| Blueprint: session, reveal card, smart matching, crews, mentor fit, personalised curriculum, agent personalisation, lobby routing, social artifact, owned & private (export/delete) | B | svc-blueprint §7 + attestations §19 | 4 |
| All 10 agents (Navigator, Portfolio, Scanner, Copy-Intel, Launch, Merchant, Risk&Compliance, Support, Coach, Growth) + Agentic Law + model-agnostic + premium subs | B | svc-agents §8.2 | 5 |

### REVENUE (§XVII), FLYWHEEL (§XVIII), DROP (§XV), ROADMAP (§XIX)
| All 20 revenue streams | — | fee params per service; admin-configurable | per phase |
| Token sources/sinks/flywheel | — | §4.3 + §17.3 — one buyback, both planes | 1/4P |
| Drop phases 0–V as feature flags | — | §11 mapping | launch |
| Vol. I 8-week roadmap items | — | superseded by §12/§21 phase gates — same content, honest sequence | — |

**Coverage check:** every named feature in Vol. I chapters I–XIX appears above exactly once with an owner and phase. CI carries `coverage-check`: this matrix is machine-readable (`tooling/coverage.yaml`); any Vol. I feature without a green DoD at its phase gate blocks the drop phase that promised it. *Never half done — enforced.*

## 26 · PRIVACY STACK (the "private" in the standard)
- Zero-PII attestations for rank/Blueprint on-chain (§19); PII never leaves the Fiat Plane's encrypted store (§10)
- Client-side analytics for sovereign vaults — the indexer serves aggregates, never sells identity graphs
- No ads, no data resale, ever — the business model is fees, stated in the doc as law
- Optional stealth handles on Protocol Plane; one human, two unlinkable presentations if they choose

---

# v2.1 — THE EXECUTION EMPIRE
### Proprietary Connectivity · Cross-Venue Execution · User Quant Platform

## 27 · INTAFACED CONNECT (svc-connect) — the proprietary venue fabric

Our own CCXT-class layer, built past it: typed, streaming-first, latency-graded, and wired into the ledger. No third-party connectivity library in the money path — Doctrine 5 applies (own tech, narrow interfaces, Rust-portable hot paths).

**Scope:**
- **Unified venue schema:** one typed contract (`packages/venue-contracts`) for markets, books, trades, funding, borrow rates, fees, account state — normalised across CEXs (Binance, OKX, Bybit, Coinbase, Kraken tier one), DEXs/chains (Hyperliquid, Uniswap-class AMMs, our own INTACORE), and FX/CFD rails (MT5 bridge adapter — the desk you already run) 
- **Adapter classes:** `MarketDataAdapter` (WS-first, sequenced books, gap-detected, cross-checked), `TradeAdapter` (order lifecycle, idempotent, rate-limit governor per venue), `AccountAdapter` (balances, positions, transfer rails between venues)
- **Latency grading:** every adapter continuously scored — round-trip, book staleness, reject rates — feeding execution routing weights live
- **Venue vault:** per-user encrypted external API keys (HSM-backed, scoped, withdrawal-permission refused by policy — connect keys must be trade-only), per-house segregated key sets
- **Unified data lake:** all normalised ticks/books/fills → time-series store (own capture, our data moat; also the backtest fuel for §29)
- INTACORE is a first-class venue in the same fabric — internal flow gets the lowest-latency adapter by construction

## 28 · INTAFACED EXECUTION (svc-execution) — the cross-venue brain

Proprietary OMS/EMS sitting above Connect. The §5.2 algo suite (TWAP/VWAP/EWAP/PVOL) moves here and generalises to every venue and asset class.

**Core:**
- **Smart Order Router (cross-venue):** best-execution across internal book + external CEXs + on-chain pools; cost model includes fees, expected impact, latency grade, transfer cost between venues; full execution reports (implementation shortfall, venue attribution)
- **Algo engine:** TWAP/VWAP/EWAP/PVOL, iceberg, sniper, pairs/spread execution, basis and funding-capture programs — parameterised, audited, resumable
- **Arbitrage engine (proprietary):** cross-exchange spot arb, triangular, spot-perp basis, funding-rate arb, cross-asset (XAU/BTC-class correlations via the MT5 bridge), DEX↔CEX with inventory-based execution (pre-positioned inventory both sides — no bridge-latency fantasy); opportunity scanner → risk-checked sizing → atomic-as-possible legs → PnL attribution per opportunity class
- **Market-making engine (proprietary):** quoting models (spread/skew/inventory bands), cross-venue hedging, kill-switches on volatility/inventory breach; runs as the internal MM of §5.2 *and* as an external-venue MM — the same engine seeds our books and works the street
- **HFT posture, stated honestly:** external venues = API-bound low-latency (co-location where venues offer it, Rust hot path per Doctrine 5) — competitive in crypto microstructure; true microsecond HFT exists only where we own the venue: INTACORE and svc-matching, where our engine has structural first-class access. We win latency where we own the ground and win breadth everywhere else.
- **Risk spine:** pre-trade checks per strategy (max notional, venue exposure caps, drawdown halts), global kill-switch in admin, every order traced end-to-end

**Tenancy — the Throne Law:** svc-execution is multi-tenant. The **house desk** (proprietary strategies, Throne-descended systems) runs as a sealed private tenant: separate keys, separate deployment namespace, strategies never in the product repo, never listed, never disclosed. The platform sells the rails, never the alpha.

## 29 · INTAFACED QUANT (svc-quant) — users build their own systems

The quant studio: every user gets the same class of rails the house runs on. This is the Bloomberg-terminal-meets-game-modding surface no exchange ships properly.

- **Strategy Studio (no-code):** visual builder — signal blocks (indicators, cross-venue spreads, funding, on-chain metrics, Scanner agent feeds), condition logic, execution blocks (algos from §28), risk blocks (mandatory: position caps, stop policy, drawdown halt). Blueprint-aware defaults: guardrails pre-tuned to the user's risk temperament.
- **Code SDK (pro):** TypeScript + Python SDKs against a sandboxed strategy runtime — event-driven (`onTick/onBook/onFill/onFunding`), full Connect market data, execution via the same OMS with per-strategy scoped permissions. Deterministic replay guaranteed.
- **Backtest engine:** event-level backtests on the §27 data lake with venue fee/latency/slippage models; walk-forward and Monte Carlo runs; honesty enforced — results display with overfitting warnings and out-of-sample verdicts, no curve-fit marketing allowed on-platform
- **Paper → Live pipeline:** paper mode against live feeds (Academy workbooks plug in here) → staged live with capital ramps → full live; kill-switch always user-visible (Agentic Law applies to strategies too)
- **Sandboxing:** user code runs isolated (V8 isolates / WASM, CPU+mem+egress capped, no raw network — market data and orders only through the runtime API); external venue keys from the Venue Vault, trade-only scope enforced
- **Strategy Marketplace:** publish strategies to INTAFACED MARKET as subscriptions or profit-share (copy-trading generalised to systems); Copy-Intel agent audits live track records — same honesty regime as leaders; house commission per §8.7
- **Compute tiers:** free (paper + limited live), Adept/Sovereign-class tiers by stake/sub for more strategies, faster data, priority execution — token-gated per §4.3

## 30 · INTEGRATION & REVENUE ADDENDA

- **New services:** `svc-connect`, `svc-execution`, `svc-quant` — Connect/Execution enter **Phase 2** (they generalise the matching/trade work); Quant Studio lands **Phase 5**, SDK + Marketplace **Phase 5+**
- **Sovereign lane:** on-chain-only strategies (INTACORE + DEX venues, session-key execution from smart accounts) run fully non-custodial — quant with zero KYC where custody permits, per §22
- **Coverage matrix additions:** Algo execution row (§25 Trade) now reads → svc-execution, cross-venue, Phase 2. New rows: Venue fabric (B/svc-connect/2), Cross-venue SOR + arb + MM engines (F+P/svc-execution/2), House desk private tenant (—/sealed/2), Strategy Studio + SDK + backtests (B/svc-quant/5), Strategy marketplace (B/svc-quant+market/5)
- **New revenue streams (Vol. I §XVII extends to 24):** Quant subscriptions & compute tiers · Strategy-marketplace commissions · Execution/OMS fees on external-venue flow · House desk PnL (private line)
- **DoD additions:** venue adapter conformance kit (replay + chaos tests per venue); backtest determinism test; sandbox escape test suite; Venue Vault key-scope audit (withdrawal-permission refusal verified)

---

# v2.2 — GAP CLOSURES & FORCE MULTIPLIERS

## 31 · GAP CLOSURES (table stakes, now specced)

**AUTO-INVEST (svc-bank)** — DCA schedules (any asset/basket, any cadence, funded from ledger or sovereign vault via standing session-key allowance), card round-ups sweeping spare change into a chosen asset or yield vault, threshold sweeps ("anything over X moves to yield"). Both planes; ledger recipes (F) / allowance contracts (P). **Phase 5.**

**TAX ENGINE (svc-tax — new, owned not vendored)** — per-jurisdiction reporting across every surface: trades, P2P, cards spend-disposals, on-chain activity via indexer, mining income, staking rewards. Lot accounting (FIFO/LIFO/HIFO per jurisdiction), realised/unrealised views, export packs (PDF/CSV + local formats). Reads ledger + data lake; nothing to re-import, which is the entire advantage. Marketplace tax vendors remain for exotic jurisdictions. **Phase 5.**

**ALERTS & WATCHLISTS (svc-notify extension)** — price/percent/volatility alerts, funding and liquidation-proximity warnings, whale-flow pings from Scanner tiers, watchlists synced across terminal + mobile, portfolio digest notifications. Rides §9 notification fan-out. **Phase 2 (alerts core) / 5 (intelligence tiers).**

**BUSINESS BANKING (svc-bank-biz — new)** — corporate accounts on the same ledger: multi-user roles with approval workflows (maker/checker, spend thresholds), team expense cards (per-card limits, category locks, receipt capture), invoicing wired to Pay, accounting exports, and **CRYPTO PAYROLL**: scheduled multi-recipient payouts in stables/fiat mix, contractor self-onboarding, payslip records — payroll to sovereign vaults means borderless teams get paid in minutes. KYB per Lane B; payroll *to* sovereign recipients needs nothing from them. This is the product for the remote-operator economy the brand already lives in. **Phase 5.**

## 32 · MODULE XII — INTAFACED PREDICT (the twelfth room)

Prediction markets as a first-class INTACORE market type — Polymarket-class, on our own chain, wired into the whole OS.
- Binary + categorical + scalar markets; CLOB-traded outcome shares (not AMM-only) — real books, real depth, same engine
- Resolution stack: oracle adapters + designated-reporter + IFC-staked dispute escalation (bond-slashing on bad reports)
- Market creation permissioned at launch (house + verified creators) → governance-opened; creation and resolution fees to the one buyback
- Fully sovereign: trade from smart accounts, zero KYC by architecture; geo-gating on the hosted front-end per JURISDICTION_MATRIX
- OS wiring: Academy runs prediction leagues and launch-prediction games (already in Vol. I §XIII) on real infrastructure; Scanner surfaces mispricings; Quant SDK gets prediction feeds — and the house prediction-alpha stack (weather/satellite/model ensemble thesis) runs against it as sealed tenant per the Throne Law
- Culture engine: every market is a shareable card; every resolution is a moment. **Phase 5P.**

## 33 · CREW VAULTS (svc-blueprint + svc-protocol)

Crews become financial units: shared multi-sig smart-account treasuries per crew — pooled deposits with member share tracking, proposal + threshold-approval spending, pooled strategy deployment via Quant (crew-owned systems), shared goals with progress rendered in the crew lobby, split rules on exit. Tournament prize pools pay straight into crew vaults. The social layer becomes a balance sheet — no competitor has squad money. **Phase 5P.**

## 34 · LEGACY VAULTS (svc-protocol)

Self-custody's unsolved problem, solved as a trust product: time-locked inheritance and recovery on smart accounts — designated guardian sets (social recovery M-of-N), inactivity-triggered succession with challenge windows, staged release schedules for heirs, optional attestation-based (zero-PII) beneficiary claims. Serious money can now live sovereign for decades. Premium feature; token-gated tiers. **Phase 5P.**

## 35 · LAUNCH TRUST LAYER (svc-launch upgrade)

The anti-rug architecture that makes INTAFACED LAUNCH the venue people trust:
- Enforced LP locks with public countdown; vesting proofs on team allocations rendered on every token page
- Bonding-curve launch option (fair-price discovery before book listing)
- Deployer reputation: on-chain history score on every creator (rugs are forever); Launch Agent flags risk patterns pre-listing
- Honest-market badges gate cross-promotion — trust is the moat in meme season, and it routes all serious flow to us. **Phase 5.**

## 36 · TREASURY YIELD ON STABLES (svc-bank + RWA module)

Tokenized T-bill vaults: sovereign and fiat-plane stable balances opt into RWA treasury yield (licence-gated per jurisdiction, activates with the RWA module §8.4). "Your cash earns treasury yield, self-custodied" — beats every neobank savings rate with a truthful sentence. **Phase 5 (§13 socket until licensing).**

## 37 · INTAFACED INFRA — RAMP-AS-A-SERVICE & WHITE-LABEL (B2B line)

The OS itself becomes sellable infrastructure:
- **Ramp widget:** embeddable on/off-ramp + checkout for third-party apps (their users, our rails, rev-share) — the easiest external monetisation of the Pay + Connect stack
- **White-label tiers:** hosted exchange-in-a-box → full OS licensing for operators (own brand, our engine), priced as setup + rev-share; every white-label instance feeds the same buyback
- Runs on existing multi-tenancy (PayFac trees + execution tenancy already specced) — this is packaging, not new core. Potentially the largest single revenue line in the stack. **Phase 5+ (post public drop).**

## 38 · ADDENDA
- **Coverage matrix additions:** Auto-invest (B/svc-bank/5) · Tax engine (B/svc-tax/5) · Alerts & watchlists (B/svc-notify/2–5) · Business banking + payroll (F→P recipients/svc-bank-biz/5) · PREDICT module (P/INTACORE+svc-predict/5P) · Crew vaults (P/blueprint+protocol/5P) · Legacy vaults (P/svc-protocol/5P) · Launch trust layer (P/svc-launch/5) · Treasury yield (B/svc-bank+RWA/5§13) · Infra B2B (—/packaging/5+)
- **Revenue engine extends to 30 streams:** + payroll & business subscriptions · tax-report tiers · Predict trading/creation/resolution fees · legacy-vault premiums · white-label setup + rev-share · ramp widget fees
- **Vol. I lineup gains:** INTAFACED PREDICT · INTAFACED BIZ · INTAFACED LEGACY · INTAFACED INFRA — module count 11 → 12, products 24 → 28
- **DoD additions:** payroll run integrity test (multi-recipient atomicity) · resolution-dispute game-theory test suite (Predict) · guardian-recovery e2e incl. adversarial guardian case (Legacy) · white-label tenant isolation audit

---

**THE FINAL FORM: EVERY VOL. I FEATURE MAPPED. EVERY GAP CLOSED. EVERY SOVEREIGN VERSION BUILT.**
**TWELVE ROOMS. TWO PLANES. ONE ECONOMY. THE RAILS ARE THE PRODUCT. THE ALPHA STAYS SEALED. NEVER HALF DONE.**

*Phantom Capital Holdings // Strictly Confidential // July 2026 // v2.2 FINAL*
