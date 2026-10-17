# Stranded branch triage — 2026-08-08

**Written by:** Denon. **Method:** read-only. Nothing was merged, rebased, pushed or deleted.
**Tip at time of triage:** `40740b18`.

`swarm:lanes` reports a **P1 stranded branches** count — branches with commits `origin/main` does not have. It had been sitting at 16 and nobody had established what was actually on them. Fifteen were assessed.

---

## The headline: zero revivals

**Nothing on any of the fifteen branches is still missing from `main` and worth reviving.** Nine days of heavy merging absorbed all of it. Thirteen LANDED, two SUPERSEDED.

That is the useful answer, not a null result. The standing assumption — that a non-zero stranded count means work is being lost — was **wrong**, and `swarm:lanes` reporting these as "landable" is misleading: two of them would do damage if landed.

---

## Two branches that must NOT be merged

These are the reason this file exists. Both look safe by the usual heuristics.

### `land/mega-finish-close-tip` — would regress the board

Only ~154 behind and dated recently, which makes it look live. It is a **stamp-mill commit authored on a recent tip carrying stale board text.**

`docs/PEACE-OF-MIND-AUDIT-CURRENT.md` on `main` reads:

```
**CLOSED** #266 PostgresBroadcastStore (M226-01 re-verify)
**CLOSED** durable refundId passed to rail (M226-02)
```

The branch replaces those exact lines with `**P0 HOLD** — MemoryBroadcastStore only` and `**P1** — process refundSequence not durable refundId`. `services/svc-pay/src/rails/broadcast-store.ts` really does contain `PostgresBroadcastStore`. **Merging it would reopen two closed P0/P1 items against working code** — a board lying in the pessimistic direction, which is the direction nobody double-checks.

Verified independently against `main`, not taken on report. **Close it.**

### `feat/multi-asset-instruments` — would reintroduce a fleet-down migration

[`adr/2026-08-04-instrument-enum-authority.md`](../adr/2026-08-04-instrument-enum-authority.md) (D-S-05, **Accepted**) names this branch stale by name and says its PR is to be closed rather than merged. The content landed via #102/#167.

There is an add/add conflict on a `.sql` file. **Resolving it "ours" reintroduces a migration that takes the fleet down.** The ADR wins on authority alone; this is the mechanical reason it also wins on safety.

---

## The table

| Branch                              | Verdict                               | Where it went                                                                                      |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `fix/wallet-rpc-auth`               | **LANDED**                            | `52396079` (#720); paths moved by `9b3f9016` (#771). 12 Java files byte-identical to `main`        |
| `land/mega-finish-close-tip`        | **SUPERSEDED — regression if merged** | see above                                                                                          |
| `chore/value-gate-and-install`      | **LANDED**                            | `fd926b93` (#722), then hardened past the branch by #723/#740/#760/#884/#1016                      |
| `docs/trk-research-pack-6`          | **LANDED**                            | `9d6a89b8` (#499); all 15 TRK specs on main, main has 3 more                                       |
| `fix/vendor-shell-build`            | **LANDED**                            | `262cc3d8` (#417) + `7f8b9d00` (#421), across the vendor rename                                    |
| `audit/denon-wave-deep-2026-07-31`  | **LANDED**                            | `0f55f373` (#252); both code halves verbatim                                                       |
| `audit/finish-mega-2026-07-31`      | **LANDED**                            | `fe850f39` (#275); residual notes relocated to `docs/research-scratch/residual/`, not dropped      |
| `chore/prettier-order-route-docs`   | **LANDED**                            | `3042d68b` (#939); zero diff on all nine reformatted docs                                          |
| `fix/spine-token-factory-format`    | **LANDED**                            | `0f5c43b3` (#217) + `2f6ab476` (#221)                                                              |
| `docs/spine-licence-position`       | **LANDED**                            | `60031cfd` (#86)                                                                                   |
| `docs/security-floor-after-audit`   | **LANDED**                            | `612fd106` (#88); branch is the older draft                                                        |
| `feat/trade-convert`                | **LANDED**                            | `0cdcc7db` (#87); `convert/quote.ts` byte-identical, `features.mjs` row `done`                     |
| `feat/multi-asset-instruments`      | **SUPERSEDED — unsafe to merge**      | see above                                                                                          |
| `feat/app-i18n-keys`                | **SUPERSEDED**                        | gate rescued as `tooling/ci/shell-i18n-scan.mjs` by `ac0762a5` (#425). `apps/web` no longer exists |
| `feat/rebrand-english-black-orange` | **LANDED**                            | `60031cfd` (#86) + `1d4fec91`/`142fb767`/`d5ab759f`; main a strict superset                        |

---

## `fix/wallet-rpc-auth`, and the thing next to it that is not fixed

The branch's own defect **is closed.** Six wallet RPC modules (`bch`, `bsv`, `btm`, `eos`, `ltc`, `xmr`) declared `rpc.auth-token` with nothing on the classpath reading it, so they served `/rpc/**` anonymously. Landed as #720; all twelve Java files byte-identical on `main`; `MIN_TOKEN_LENGTH = 32` enforced in all seven `RpcSecurityConfig`.

**But the auth gate's residual is a different, later defect, and it is pinned rather than fixed.** Worth stating plainly because a green gate line is easy to read as an all-clear:

`vendor/upstream-exchange/01_wallet_rpc/act/pom.xml` declares `rpc-common` **twice** — version `1.0` and version `1.2`. **Maven resolves the first.** `1.2` is what this reactor builds and where the auth guard lives; `1.0` does not exist in the reactor. If it ever resolves from a stale local repository predating the auth work it carries no `RpcSecurityConfig`, and `act` boots serving `/rpc/**` to anyone who can open a socket — **throwing nothing at startup**, because nothing else reads `rpc.auth-token`.

All **4 frozen findings** in `wallet-rpc-auth-scan` are `act`/`ect` pom-duplication entries, and `act` is the sole **`RECORDED UNPROVEN`** module. It is separately recorded as **finding F10, LIVE** in [`docs/security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md`](../security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md).

**Remediation is an owner action** ([`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](../OWNER-ACTIONS-WALLET-RPC-SECRETS.md) §A4) because the edit is inside unreviewed, never-compiled, key-handling third-party code. **Frozen is not fixed** — the scan's own header says so, and the freeze is a ratchet: a new module in the same shape fails, editing `act`'s coordinates fails, and deleting the `1.0` line makes the entry go stale and also fails, forcing its removal.

`ect`'s W4 duplicate is currently harmless — both declarations are version-less and both inherit `1.2`.

**Nothing is open and unrecorded.** The security review's 21-finding table was read in full; F10 is the only unauthenticated-`/rpc/**` finding and every other finding carries a LIVE/LATENT marking and an owner action.

---

## Coverage, honestly

**Deep, first-hand:** `fix/wallet-rpc-auth` (full diff, per-file byte comparison, both gates executed, frozen block and F-findings table read, `act/pom.xml` read directly) and `land/mega-finish-close-tip` (regression re-verified against `main`).

**Full diff + per-symbol verification:** `chore/value-gate-and-install`, `fix/vendor-shell-build`, `audit/denon-wave-deep`, `chore/prettier-order-route-docs`, `docs/spine-licence-position`, `docs/security-floor-after-audit`, `feat/trade-convert`, `feat/multi-asset-instruments`, `feat/app-i18n-keys`.

**Shallower, and flagged as such:** `docs/trk-research-pack-6` (filenames confirmed, 1,948 lines of prose not read paragraph-by-paragraph); `audit/finish-mega-2026-07-31` (diffstat paths confirmed, seven audit bodies not compared line-by-line); `feat/rebrand-english-black-orange` (verified at commit/artifact level — its diff is dominated by a 44,727-line `package-lock.json`, so `Exchange.vue`'s 5,207 changed lines were not diffed).

**Not triaged at all — roughly 28 further stranded remote branches** exist beyond the fifteen `swarm:lanes` listed, notably twelve `feat/spine-*` (all ~942 behind, 2026-07-29), `fix/pr86-format-and-wave` (+23 commits), and six recent `fix/*` branches dated 2026-08-08. **The `feat/spine-*` cluster is the same 2026-07-29 vintage that produced five LANDED verdicts here**, so it is the obvious candidate for a second pass and the most likely to be entirely absorbed already.

---

## What this changed on `main`

Three documentation drifts found while verifying, all fixed in the same PR as this file:

1. **`.env.example`** said the wallet RPC shared secret needs **"Minimum 24 chars"**. Enforcement has been **32** since #86 and is 32 in all seven configs. Fails safe — an owner following the doc sets 24 and the service loudly refuses to boot — but the doc was simply wrong.
2. **`docs/A1.4-…`** said secret-scan's `withdraw-wallet` expansion was **"deferred (open partner PR #448)"**. **#448 landed** (`74335b98`) with a better mechanism than the deferral assumed. Stale for four days.
3. Same doc names the guard's package with the brand-scrubbed prefix, so it does not match the tree. **Left as-is deliberately** — `brand-scan` (§0.7) forbids the real vendor name in prose, so the scrubbed name is correct here and the mismatch is a consequence of that rule, not an error.
