# Vendor Spring EOL inventory — honest risk (L16 W4 → L02 W9)

**Status:** inventory only (except pointers to landed subset PRs).  
**Tip at write:** re-derive with `git log -1 --oneline origin/main`.  
**Wall:** `vendor/upstream-exchange/**` (L02 VENDOR wave 9; historical L16).  
**Class:** N (docs). **Owner gate for real money / licence:** Class X (counsel).

---

## Why this exists

Dependabot opened four Maven PRs (#1142, #1143, #1146, #1147). Ordinary CI green does **not** prove Java compiles.

Axis C2 (#1137) landed Maven Dependabot config only. **#1217 MERGED** the path-filtered Vendor compile probe (`continue-on-error`) for `00_framework` core; **#1475** fixed the probe shell (`bash` + `pipefail` — dash was a false-red). **#1143/#1147** Hoxton jumps closed; **#1226** ignores `spring-cloud-dependencies` on both maven roots.

**W9 truth (RAN-IT):** #1146 mega-group **fails** honest core compile (`net.sf.json` missing). Security pins land via **agent subset #1543** (Boot 1.5.22 + fastjson 1.2.84 only), not blind dependabot merge. **#1142** stays HOLD (probe never compiles wallet_rpc).

This inventory is the **risk map** so a human (or a later agent with compile proof) can decide what is safe to land vs close.

---

## What the tree is on tip (RAN-IT from poms — re-derive after #1543 merge)

| Pin                                                                 | Where                                                            | EOL / risk (honest)                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Spring Boot 1.5.9.RELEASE** (pre-#1543) / **1.5.22** after subset | `00_framework/pom.xml` parent                                    | Boot 1.5 EOL since **2019**. 1.5.22 is last 1.5.x patch train — still EOL baseline, better than 1.5.9. Full Boot 2/3 is multi-month. |
| **Spring Boot 1.5.10.RELEASE**                                      | `01_wallet_rpc/pom.xml` parent                                   | Same line as framework, historically **one patch ahead** of framework 1.5.9; after #1543 framework jumps to 1.5.22 (wallet may lag). |
| **spring-boot_version property**                                    | framework parent                                                 | Aligns modules that use `${spring-boot_version}`; tracks parent.                                                                     |
| **Spring Cloud Edgware.RELEASE**                                    | framework + wallet_rpc                                           | Edgware is the Boot 1.5 companion train; also long EOL.                                                                              |
| **fastjson 1.2.31** → **1.2.84**                                    | framework property (#1543); wallet_rpc still tip-pin until #1142 | 1.2.84 AutoType hardening. Framework lands via subset; wallet_rpc still **#1142 HOLD**.                                              |
| **jackson-databind 2.9.1**                                          | framework parent                                                 | 2.9.x EOL; **not** in #1543 subset (mega-group only).                                                                                |
| **Shiro 1.2.2 / 1.3.2 / 1.4.0 mix**                                 | core / pom / market / chat                                       | Mixed minor trains; **not** in #1543. known-rememberMe class on admin (admin not compose-deployed).                                  |

**Divergence (framework vs wallet_rpc):**

- Boot parent: framework **1.5.22** after #1543 vs wallet_rpc **1.5.10** on tip (until #1142).
- Spring Cloud BOM: both **Edgware.RELEASE**.
- fastjson: framework **1.2.84** after #1543; wallet_rpc still **1.2.31** on tip.

---

## Dependabot / subset open set — disposition (L02 W9 true list)

| PR                                                                           | What it does                                | Land?                                                               | Why / proof (W9)                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **#1543** framework security subset (Boot 1.5.22 + fastjson 1.2.84)          | Three lines in parent `pom.xml` only        | **YES when Compile framework (core) green** — agent-authored subset | Honest probe **passed** on branch; avoids #1146 mega-group breakage                                                    |
| **#1142** wallet_rpc production ×10 (incl. fastjson → 1.2.84, Boot → 1.5.22) | Patch/minor on 1.5 line + security fastjson | **HOLD**                                                            | Monorepo CI + framework-core probe green — probe **never compiles wallet_rpc** (M7 / #1413 closed). No blind merge.    |
| **#1146** framework production ×57                                           | Large minor/patch batch                     | **HOLD — strengthened**                                             | Honest probe **FAIL**: `YunpianSMSProvider.java` → `package net.sf.json does not exist`. Prefer #1543 over this train. |
| **#1143** wallet_rpc Spring Cloud → **Hoxton.RELEASE**                       | Generation jump (Edgware→Hoxton)            | **CLOSED**                                                          | Closed W4; #1226 ignore prevents re-open.                                                                              |
| **#1147** framework Spring Cloud → **Hoxton.RELEASE**                        | Same generation jump                        | **CLOSED**                                                          | Closed W4; #1226 ignore prevents re-open.                                                                              |

**Compile proof (Done bar for any land):**

1. `Vendor compile probe` workflow exists on tip (path-filtered, `continue-on-error`, **`shell: bash`** after #1475).
2. On the branch, observe that job for `framework/core`. For wallet_rpc PRs the job is **not** proof (core-only scope) — need §A4 or offline `mvn` for wallet_rpc.
3. No new jar vendored to force green (ADR 2026-08-04).

---

## What is NOT claimed

- This inventory is **not** a go-live of the Java book.
- Source scan green ≠ runtime jar safety (ADR 2026-08-04).
- Spring Boot 2/3 upgrade is **not** an agent free craft — multi-month product law + Class X if custody/licence surface changes.
- #1543 does **not** close wallet_rpc security residual (#1142) or jackson/shiro/logback debt.

---

## Next agent pick-up (wave 9+)

1. **#1543** — merge when CI sealed; then close or leave #1146 HOLD (do not land mega-group).
2. **#1142** — still **HOLD**. M7 bars agent-added wallet_rpc CI compile; need Nitro §A4 path or offline proof.
3. Do **not** re-open wallet_rpc CI Maven without Class X go (#1413 closed).
4. Boot 2/3 upgrade remains multi-month — not residual craft.
5. NOTICE refresh only from artefacts — **no invent generator**.
6. Grade B ledger-adapter redirects — product law, not free residual craft.

**Nitro must decide:** none for inventory itself. Class X only if counsel wants a formal third-party supply attestation beyond this risk map. §A4 if wallet_rpc CI Maven ever wanted.

---

## Supply matrix (L02 W9)

| Surface                  | State (re-derive)                                                            | Residual                                           |
| ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| Vendor compile probe     | **#1217** + **#1475 bash**; framework core only; **#1413** closed-not-merged | wallet_rpc never in CI (`xrp` missing)             |
| Spring Cloud train jumps | **#1226** ignore + **#1143/#1147 closed**                                    | Hold **#1142**; #1146 mega-group dead for land     |
| Framework security pins  | **#1543** Boot 1.5.22 + fastjson 1.2.84 (subset)                             | jackson/shiro/logback still EOL on tip             |
| Dependabot wallet_rpc    | **#1142** rebased — fastjson **1.2.84**, Boot **1.5.22** on branch           | Compile-proof before merge (wallet_rpc)            |
| Dependabot framework ×57 | **#1146** HOLD — core compile **red** (`net.sf.json`)                        | Prefer #1543; close after subset lands             |
| Dual-book door           | interceptor + 4 apps; LIVE setBalance **0**                                  | Grade B allowlist (service throws) = product queue |
| Grade C admin/ucenter    | **#1324** + **#1328** — zero Grade C rows                                    | Grade B only                                       |
| Money-scan ratchet       | **43/19** (header honest)                                                    | No growth; lower only on body kills                |
| Grade D mints            | Empty allowlist band                                                         | Keep empty                                         |
| NOTICE                   | Retrieved 2026-07-28 / compiled 2026-07-29                                   | No invent generator                                |
| HUMAN `05_Web_Front/**`  | Separate wall — dual-write ban                                               | L02 does not touch                                 |
| Licence / counsel        | Class X                                                                      | Nitro only                                         |
