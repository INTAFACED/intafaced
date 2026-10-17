# 03D — Tracker honesty · Brand · Lockfile (Stream D)

**Fire:** money-class mega · 2026-07-31  
**TIP:** `4b77c173cd04c1d347da53cefaecb0c8fdd42c0c` (#250)  
**SINCE:** `cd277dcc3fc2f71d3694b2eccc12b20d0fdb3f00` (#239 residual high water)  
**Scope:** L8 tracker · L9 brand · L11 lockfile · light Stream A vendor honesty  
**Method:** read `tooling/tracker/features.mjs` + `docs/TRACKER.md` at tip; compare to SINCE snapshot (`docs-wave-audit-229-238` worktree at residual tip); brand-scan allowlist + manual grep on apps/docs; `pnpm-lock.yaml` importer delta for `services/svc-pay`; Stream A vendor comments only.  
**Not:** full money-path L3 adversarial (#226 code body is Stream B); not go-live clearance.

---

## 1 · Feature statuses at tip (primary targets)

| id                             | status @ SINCE           | status @ TIP            | note honesty                                                                                                                                                                                   |
| ------------------------------ | ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pay.rails`                    | `ready`                  | **`done`**              | Explicit: LIVE-capable path exists; **NOT go-live complete**. Residuals named (MemoryBroadcastStore single-process; in-process address book + watcher; owner RPC/custody; card acquiring §13). |
| `pay.user-money`               | `ready`                  | **`done`**              | Unblocked by live crypto-native when `EvmLiveChain` configured. Residuals: hand-credit still card-sandbox default; on-chain deposit = watcher→webhook→capture, not `deposit.credit`.           |
| `pay.gateway`                  | `wip`                    | **`wip`**               | Notes live rail existence; still no card acquiring, merchant onboarding, multi-replica store. Correct.                                                                                         |
| `ws.gateway`                   | `wip`                    | **`wip`**               | 3/4 streams (depth + public tape + private orders/fills); **futures positions still missing** — refuses `done`. Correct.                                                                       |
| `ws.depth`                     | `done`                   | `done`                  | Unchanged; split-out honesty intact.                                                                                                                                                           |
| `web.terminal`                 | (default / partial note) | **`wip`** + owner Nitro | Charts + equity live from real APIs; hotkeys + sub-accounts not started. Status upgraded honesty (incomplete title).                                                                           |
| `protocol.amm`                 | `wip`                    | **`ready`**             | Compile unblocked; artefacts committed. Explicitly **not `done`**: factory `0x0`, no live mint/swap on anvil in PR, **NOTHING AUDITED**. Correct.                                              |
| `protocol.smart-accounts`      | `ready`                  | `ready`                 | Unchanged; still not chain decision / audited.                                                                                                                                                 |
| `trade.spot` / `trade.convert` | `done`                   | `done`                  | Out of primary delta; convert note still honest about PG/CI limits.                                                                                                                            |
| `trade.ccxt-api`               | partial note             | partial note            | Still not `done` (no declared status → ready/blocked by deps). Residual empty books until seeding.                                                                                             |
| `token.*`                      | mostly `done`            | unchanged               | Not flipped by this delta.                                                                                                                                                                     |

`docs/TRACKER.md` is regenerated from `features.mjs` (`tracker:check` exit **0** in L0). UI glyphs: ✅ = `done`, 🔨 = `wip`, 🟢 = ready-ish, ⛔ = blocked on deps. **Glyph alone can mislead a non-coder** if they skip the note body.

---

## 2 · False-`done` judgment (the money question)

### Tracker definition (header of `features.mjs`, tightened 2026-07-28 / edge principal 2026-07-29)

`done` = **reachable + tested + not propped by stub/mock/TODO**.  
Explicitly: **not** “live product complete” (rails/chain/KYC ops may still be sandbox).

### F-1 · `pay.rails` → `done` — **NOT a false done under tracker law; residual-risk for operators**

| Check                              | Result                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Reachable live path when env set?  | Yes — `EvmLiveChain` (`viem` Public+Wallet), `defaultChainFor` when `PAY_CRYPTO_*` set  |
| Tested?                            | Note claims unit + broadcast claim suite + optional anvil                               |
| Fabricated live tx without config? | No — UnconfiguredChain / MemoryChain when unset; posture gates remain                   |
| Production go-live complete?       | **No** — note lists blocking residuals                                                  |
| Overclaim vs PEACE?                | PEACE says **ON MAIN** + ops own keys/RPC/go-live — aligned with note, not with bare ✅ |

**Verdict F-1:** Status flip `ready`→`done` after #226 is **consistent with repo tracker doctrine**.  
**Risk (P2, human-facing):** a scoreboard reader who only sees ✅ “RailAdapter + crypto-native + card-sandbox” may hear “money is live.” Mitigation already in note + PEACE residual; **do not strip residuals**. Optional polish: keep `done` but ensure any external “what’s shipped” blurb repeats **not go-live**.

**Not recommended:** silent downgrade to `ready` without a doctrine rewrite — that would re-open a settled “adapter exists under env” claim after Class M land.

### F-2 · `pay.user-money` → `done` — **acceptable, with residual honesty**

Unblocked withdrawals under live crypto-native is real progress. Residuals are named (sandbox hand-credit; deposit path ≠ `deposit.credit`). Matches “mounted money paths, not every rail product.”  
**No false-done flag** if PEACE continues to list pay ops residual.

### F-3 · `protocol.amm` = `ready` (not `done`) — **honest**

Title still says “audited templates”; note says **NOTHING AUDITED** and factory default zero. Status correctly refuses `done`. **Pass.**

### F-4 · `ws.gateway` stays `wip` — **honest**

Positions stream still missing; note says “three of four is not done.” **Pass.** (#227 positions honesty is empty-stream, not completion.)

### F-5 · `web.terminal` = `wip` — **honest upgrade**

Charts/equity claims match apps code comments (real OHLCV / real balance; empty ≠ invented zeros). Hotkeys/sub-accounts still open. **Pass.**

### F-6 · Stale partial note (secondary)

`trade.ccxt-api` note still says OHLCV “always [] until candle aggregation job” while `web.terminal` / fill aggregation path claims real OHLCV. Likely pre-delta drift, not #226-#228 invention. **P2 tracker hygiene** — refresh OHLCV sentence on next honesty pass; not a money false-done.

---

## 3 · Delta honesty (`features.mjs` / `TRACKER.md` SINCE→TIP)

Material flips after residual wave:

1. **`pay.rails`:** `ready` → `done`; `dependsOn` no longer waits on `pay.gateway` (adapter independent of hosted checkout) — **correct structural fix**.
2. **`pay.user-money`:** `ready` → `done`; note rewritten for live crypto-native unblock.
3. **`pay.gateway`:** still `wip`; note updated that public checkout can open crypto-native under live-only when configured.
4. **`protocol.amm`:** `wip` → `ready`; compile-unblock narrative; still not live/audited.
5. **`web.terminal`:** explicit `wip` + charts/equity 2026-07-31 note.
6. **`ws.gateway`:** unchanged `wip` wording (positions residual).

No feature in the primary set claims “production mainnet go-live” or “card acquiring live.”  
No `protocol.amm` / token launch path claims audit complete.

**Honesty judgment on the diff:** **PASS-WITH-CAUTION** — code-status honesty good; operator ✅ optics for pay need the residual sentence every time go-live is discussed.

---

## 4 · Brand (L9)

| Source                                       | Result                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| L0 `pnpm scan:brand` @ tip                   | **exit 0** — 741 files, 0 forbidden names (01-L0)                                         |
| `apps/**` OpenAI/Anthropic/Claude/GPT-       | **0 hits**                                                                                |
| Delta UI paths (terminal equity/chart)       | No vendor model/rail partner names in user copy                                           |
| Doctrine doc `INTAFACED_DEFINITIVE_BUILD.md` | Contains `Anthropic` — **allowlisted** in `brand-scan.mjs` (internal law, not shipped UI) |
| Prior audit docs naming `Claude`             | Historical; not introduced as user-facing product copy this delta                         |

**Brand verdict:** **CLEAN** for changed product paths. Vendor-shell intentional empty-state honesty is orthogonal and L0 `scan:vendor-shell` also exit 0.

---

## 5 · Lockfile / supply chain (L11)

### Importer delta `services/svc-pay` (SINCE → TIP)

| Package                                  | SINCE on svc-pay | TIP on svc-pay | Why                                                                                                                   |
| ---------------------------------------- | ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| **`viem` `^2.55.8` → resolved `2.55.8`** | **absent**       | **present**    | #226 live EVM rail: `EvmLiveChain` uses Public+Wallet clients, HD accounts (`viem/accounts`), encode/transfer helpers |

No other new third-party dependency appears under `services/svc-pay` importer (workspace packages + existing fastify/drizzle/trpc/otel/zod/postgres unchanged).

### Monorepo `packages:` section

`viem@2.55.8` **already existed** at SINCE (used by `svc-indexer` / `svc-protocol` chain clients). #226 **adds an importer edge**, not a brand-new resolved identity or version bump of viem.

**New third-party packages introduced to the workspace lock as first-class identities this delta:** **none detected** beyond attaching existing `viem` to pay.

**Supply-chain note:** `viem` is the intentional chain SDK for live crypto rail (not a random left-pad). Hot keys remain env-owned (`PAY_CRYPTO_HOT_WALLET_KEY` / mnemonic) — lockfile does not embed secrets.

---

## 6 · Stream A vendor (light skim only)

Sampled honesty comments / patterns under `vendor/upstream-exchange/05_Web_Front`:

- C2C: **never invent** quotes or balances; balance null until wallet API; failed price ≠ fixed 7.00
- Exchange: empty positions honest (“not zero risk”)
- CMS Notice/Help: failed list ≠ empty success
- Envelope: no invented gift amount while loading

No evidence in this skim of Stream A inventing balances or candles; pattern is **fail/empty honesty**. Full Stream A re-audit remains out of scope per freeze.

Terminal (non-vendor) confirms same doctrine: `LiveChart` empty = never traded; `AccountEquity` empty/anonymous = no invented zeros; dual-book banner on equity.

---

## 7 · Findings table

| ID   | Layer    | Severity | Finding                                                                              | Action                                                                                                              |
| ---- | -------- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| D-T1 | L8       | **P2**   | `pay.rails`/`pay.user-money` ✅ can be misread as go-live by non-coders              | Keep residual wording; PEACE/owner ops must continue to list keys/RPC/BroadcastStore; no silent “money live” claims |
| D-T2 | L8       | **info** | `pay.rails` `done` matches tracker law post-#226                                     | **No status downgrade** this fire                                                                                   |
| D-T3 | L8       | **pass** | `ws.gateway` `wip`, `protocol.amm` `ready` not `done`                                | None                                                                                                                |
| D-T4 | L8       | **P2**   | `trade.ccxt-api` OHLCV “always []” likely stale vs fill aggregation / terminal chart | Hygiene on next tracker honesty PR                                                                                  |
| D-B1 | L9       | **pass** | brand-scan clean; no OpenAI/Anthropic in apps UI                                     | None                                                                                                                |
| D-L1 | L11      | **info** | New svc-pay dep: **viem@2.55.8** (pre-existing monorepo resolve)                     | Accept for #226; no extra lock noise found                                                                          |
| D-V1 | Stream A | **pass** | Vendor empty-state honesty comments; no invent-balance pattern in skim               | None                                                                                                                |

**Counts:** findings **7** · **P0: 0** · **P1: 0** · **P2: 2** · pass/info: **5**

---

## 8 · VERDICT

**PASS-WITH-RESIDUALS**

- Tracker **does not** false-claim go-live, card acquiring, audited AMM, or complete WS positions.
- `pay.rails` / `pay.user-money` **`done` is doctrine-legal** for live-capable adapter + mounted paths; residuals that block production go-live are **named** — that is the contract.
- Brand clean.
- Lockfile: **one meaningful new importer dependency** (`viem` on svc-pay); no surprise package flood.
- Stream A light skim: honesty-only.

**This stream does not clear money e2e, production RPC, or multi-replica BroadcastStore.** Those remain ops / Stream B residuals.

---

## 9 · Proof pointers

| Claim                   | Where to check                                                             |
| ----------------------- | -------------------------------------------------------------------------- |
| Status + notes          | `tooling/tracker/features.mjs` · `docs/TRACKER.md`                         |
| SINCE baseline statuses | residual-wave worktree features at `cd277dc`                               |
| Brand L0                | `docs/audit/2026-07-31-money-class-mega/01-L0.md` (`scan:brand` exit 0)    |
| Equity/chart honesty    | `apps/web/src/components/terminal/account-equity.tsx`, `live-chart.tsx`    |
| Live rail + viem        | `services/svc-pay/package.json`, `services/svc-pay/src/rails/evm-chain.ts` |
| Lock importer           | `pnpm-lock.yaml` → `services/svc-pay` → `viem`                             |
| PEACE alignment         | `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` (live rail ON MAIN, ops residual)    |
