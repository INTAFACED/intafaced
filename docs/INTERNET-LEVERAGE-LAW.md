# Internet leverage — standing law (agents · no Nitro decision)

**Status:** LAW · binding on every agent session  
**Operator decision (2026-08-05):** Phase A is **finished for current residual craft**. Agents **must use** that leverage. Nitro does **not** re-decide this per chat.  
**Home for maps:** Phase A audit · Phase B full-horizon (paths) · this file = **enforcement**  
**Partner pack (Denon + his agent):** [`INTERNET-LEVERAGE-PARTNER-BRIEF-2026-08-05.md`](INTERNET-LEVERAGE-PARTNER-BRIEF-2026-08-05.md)

---

## 0 · Plain English (for Nitro)

We already have enough **in-repo** building blocks for what agents should ship **now**: product UI kit, ledger, services.  
Agents must **wire and extend those**. Replacing the product UI is allowed under [`adr/2026-10-02-redesign-may-replace-product-ui.md`](adr/2026-10-02-redesign-may-replace-product-ui.md). Do not invent a second money book or a random new stack.  
**Phase B** is only the residual map (when to use an external tool later) — **not** an excuse to ignore Phase A.

**Enforced how:** written into `AGENTS.md` / project instruction brief / `AGENT_PROTOCOL` + PR checklist + **CI auto-load scan** so the law cannot silently disappear from cold starts.

---

## 1 · Finished decision: Phase A is sufficient **now**

| Need now                                                                         | Phase A answer                                                                                                            | Agent default                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Product UI                                                                       | Vendor shell `:8090` (`vendor/upstream-exchange/05_Web_Front`) until this redesign replaces it                            | May be replaced. [`adr/2026-10-02-redesign-may-replace-product-ui.md`](adr/2026-10-02-redesign-may-replace-product-ui.md) |
| Desk chart                                                                       | **Intended:** TradingView **Advanced Charts** after access (`LICENCE-POSITION.md` §1.1a). **Interim:** vendored LWC 5.2.1 | Never pirate TV files into public git; never iframe Widgets; never npm a drawing pack as a fake Advanced Charts           |
| Money truth                                                                      | `packages/ledger-client` + `svc-ledger`                                                                                   | Recipes only                                                                                                              |
| Trade / match / pay / bank / p2p / id / ws / notify / agents / academy / support | Matching `services/svc-*`                                                                                                 | Extend that service                                                                                                       |
| Ops UI patterns                                                                  | Prefer `04_Web_Admin` shape                                                                                               | No second admin product                                                                                                   |
| Custody go-live                                                                  | Wallet RPC: **critical defects frozen (#763)** — fix before live; not “optional MID review”                               | Do not invent hot wallets; no mainnet dual-broadcast residual                                                             |

**Not “platform complete”** — residual craft remains. **Sufficient leverage for residual craft without a second stack** = yes. Replacing the product UI is [`adr/2026-10-02-redesign-may-replace-product-ui.md`](adr/2026-10-02-redesign-may-replace-product-ui.md).

**Exchange backend OSS catalog (2026-08-31):** [`BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`](BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md) is the named take/keep/never list (QuickFIX/J, Real Logic SBE, QuantLib adapter, WebAuthn, OpenAPI-from-Zod 3). North-star §0.3 binds it. **Mega backend v1.25:** [`SPEC-BACKEND-MEGA-PLAN-2026-09-03.md`](SPEC-BACKEND-MEGA-PLAN-2026-09-03.md). Live-wire: [`SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md`](SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md). Phase A audit below is **historical**; do not read “FIX not found” as a ban on a QuickFIX/J **adapter**.

### 1.1 · Narrow greenfield exception

Phase A is the default, not a prohibition on justified new work. A greenfield or design exception is lawful only when the agent proves in the focused audit and PR body that the existing Phase A asset cannot satisfy the required behavior, names the smallest new boundary, preserves money/custody/product-law doctrine, and obtains any required LAW, Class X, or owner decision before implementation. “I prefer a new stack” is not evidence.

---

## 2 · Mandatory pre-code ritual (every agent · every code task)

Before the first edit of product code:

1. Open [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md) (Phase A) — find the asset for this mountain.
2. Open [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md) — find the tracker **id** row (path IN / EXT / GF / LAW / S / X).
3. If the job is **FIX session, SBE codec, QuantLib Greeks/calendars, WebAuthn, or OpenAPI-from-Zod**: path is **EXT from north-star §0.3** even when Phase B has no matching tracker row. Do **not** hand-roll those. Leftover matching/OMS/trade/bank bugs stay **IN** existing `svc-*`.
4. If the job is the **desk chart host**: intended EXT is **TradingView Advanced Charts** after Nitro’s access/approval (`LICENCE-POSITION.md` §1.1a). Until then **IN** vendored LWC. Do not implement Advanced Charts, Trading Platform, or a pirate copy. Do not treat 2026-07-29 Path A as “never Advanced Charts.”
5. **Default path = Phase A IN** unless step 3 or 4 applies, or the horizon row says LAW (wait for Denon), S (babysit), X (human Class X), or EXT (only then trial external).
6. In the PR body: name **which leverage** you used (`IN <svc>` or `EXT <lib>@<sha> adapter-only`, or “none — greenfield justified because …”).
7. If you almost rebuilt the ledger, full matching, or the full pay platform — **stop**. That is a failed session. Replacing the product UI follows [`adr/2026-10-02-redesign-may-replace-product-ui.md`](adr/2026-10-02-redesign-may-replace-product-ui.md).

**Nitro is not asked.** If ambiguous on money/custody, doctrine decides; if still stuck, ask **Denon**, not the operator for leverage homework.

---

## 3 · Hard bans (leverage-specific)

| Never                                                                                        | Why                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new site outside this redesign                                                             | The redesign may replace the product UI. [`adr/2026-10-02-redesign-may-replace-product-ui.md`](adr/2026-10-02-redesign-may-replace-product-ui.md) |
| Second balance book (Java wallet tables, Formance/TigerBeetle as SoT, service-held balances) | Doctrine + Phase A                                                                                                                                |
| Invent mids/depth/prices so UI “looks live”                                                  | Honesty                                                                                                                                           |
| Ignore named `svc-*` and rewrite the domain                                                  | Rebuild tax                                                                                                                                       |
| Implement Shehzad chain cores “with leverage”                                                | Ownership S                                                                                                                                       |
| Dual-edit open Denon/Shehzad PR paths                                                        | Collision — **necessary, not sufficient** (see §3.1)                                                                                              |
| Treat Phase B shopping as day-1 before Phase A wire                                          | Order of leverage                                                                                                                                 |
| **Hyperswitch** (or peer PSP orchestrators) in the money path                                | D-S-10 ADR #769: orchestrator ≠ acquirer; Doctrine 5 no third-party connectivity lib in money path                                                |
| Native node-gyp / `node-re2` on money-adjacent services                                      | ABI + supply-chain cost on bank-detail paths; pure-JS alternatives exist                                                                          |

Already machine-enforced where possible: dual-book / custody / brand / vendor-shell scans via `pnpm gates`.

### 3.1 Test isolation (Denon 2026-08-05)

File-level / worktree isolation is **not enough**. Suites that migrate at startup against a **shared** test Postgres can break peer agents (false reds; Denon A/B on #428).

**Law:** use a **dedicated test database per branch** (or equivalent isolation). Do not share one `intafaced_test` across concurrent worktrees.

### 3.2 ReDoS matchers — two tools, two jobs (Nitro locked 2026-08-05)

Denon correction: `@intafaced/safe-regex` is **re2js (pure JS)** — not native node-gyp RE2. The old “avoid RE2 on money paths” line does **not** apply to that package.

It is still **not** a free upgrade for every hot path. Measured (~4,050 patterns / ~99k match checks): both engines are sound on what they accept; **refusal surfaces differ**. re2js gains `\b` / `\p{…}` and loses `\uXXXX` / `[^]` (ordinary JS non-ASCII spelling — account IDs often need this).

| Job                                                                         | Tool                                            | Why                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Operator-supplied** field patterns (`svc-p2p` instruments)                | In-tree `linear-pattern.ts`                     | Full JS surface for non-ASCII account IDs; DB constraint in **0002** (#811 — edited 0001 never re-runs) |
| **Engineer-owned** parsers (subjects, symbols, controlled pattern language) | `@intafaced/safe-regex` (re2js) — **FH-SEC-01** | Pure JS ReDoS-safe; already on main                                                                     |
| Native `node-re2` / node-gyp RE2                                            | **Banned** on money-adjacent services           | Same ban as before                                                                                      |

**Agents must not** silently swap P2P operator patterns onto re2js “to tidy” — that narrows what operators may write. Revisit only with an explicit owner call.

---

## 4 · Phase B (no ceiling · no Nitro queue pick)

- Full residual map: every open tracker id has a path.
- **Start order (agents may proceed without asking Nitro):**
  1. Prefer **IN** residual on claimed free paths (decimals, shell honesty, pay residual on `svc-pay` after handoff). Depth E2E is **proven** (Denon fleet rebuild) — not a residual theater item.
  2. **ReDoS:** follow §3.2 split (linear-pattern for operator patterns; `@intafaced/safe-regex` for engineer parsers; no native node-re2) · **Gitleaks** CI.
  3. **Pay:** commercial `socket.psp-partners` / Class X — **not** Hyperswitch (refused).
  4. **Wallet RPC:** treat as **NOW critical** (mainnet dual-broadcast / pre-EIP-155 / pinned mainnet USDT class defects frozen by #763 — unfixed). Not “MID review someday.”
  5. **LAW rows:** Denon D-S board reported **18 done** — implement from specs.
  6. **X rows:** never agent-close.

Agents **do not** wait for Nitro to “pick the Top 5.”

---

## 5 · Stale map hygiene (agents own it)

When tip drifts (vendor path, deleted apps, new `svc-*`, tracker status flip, **partner corrections**): update Phase A or full-horizon **in the same PR wave**, not a sticky note to Nitro.  
`pnpm verify` / agent-autoload fails if this law vanishes from AGENTS / project instruction brief / protocol.

---

## 6 · Enhanced standing prompt (auto — paste optional)

```
INTERNET LEVERAGE LAW (binding — do not ask Nitro):

1. Phase A is finished for NOW residual craft. Prefer in-repo: ledger-client money, existing svc-*. The product UI may be replaced under docs/adr/2026-10-02-redesign-may-replace-product-ui.md.
2. Before code: read docs/INTERNET-LEVERAGE-LAW.md + Phase A audit + full-horizon row for the tracker id.
3. Replacing the product UI follows `docs/adr/2026-10-02-redesign-may-replace-product-ui.md`. Never a second ledger. Never invent prices. Never steal Shehzad chain. Never dual-edit open human PR files. Never share one migrate-on-startup test DB across worktrees.
4. PR must name leverage used. No Hyperswitch. ReDoS = §3.2 split (linear-pattern for operator patterns; @intafaced/safe-regex for engineer parsers; no native node-re2). LAW = Denon first. X = human only. Desk chart: Advanced Charts after owner access (LICENCE-POSITION §1.1a); LWC interim; never pirate TV into public git.
5. Proceed autonomously on IN / safe EXT (ReDoS split, Gitleaks). Wallet RPC defects are NOW-critical if you touch custody.
```

---

_Board-Delta: ReDoS §3.2 locked — operator patterns = linear-pattern; engineer parsers = safe-regex/re2js; native node-re2 still banned_
