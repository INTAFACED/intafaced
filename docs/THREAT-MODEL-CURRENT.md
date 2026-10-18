# Threat model — current (fiat plane · wallet_rpc · vendor Java)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Board:** D26-P3-02 · **Class:** Judgment (not a pentest, not go-live, not clearance).  
**Tip this page was written against:** `1723273b` (`origin/main` at branch create, 2026-08-15). Re-derive: `git rev-parse --short origin/main`.  
**What this is:** ranked judgment of **custodial money doors** on the Fiat Plane, the vendored **`01_wallet_rpc`** custody tree, and **vendor Java dual-book** risk. Residuals are **named tickets / sockets / gates**, not vibes.  
**What this is not:** an attack campaign, a Strix/ZAP run, a host pentest, or a licence to boot wallet RPC. Track B attack work stays later — [`SECURITY-WHEN-PLAIN.md`](SECURITY-WHEN-PLAIN.md).

**Leverage (Phase A IN):** existing security floor + wallet-rpc review + Java money-plane map + staging-deploy slice. This page is the **current home**. Do not treat [`audit/2026-07-29/05-THREAT-MODEL.md`](audit/2026-07-29/05-THREAT-MODEL.md) as live. Do not treat [`PEACE-OF-MIND-AUDIT-CURRENT.md`](PEACE-OF-MIND-AUDIT-CURRENT.md) as this mountain (orientation / product scoreboard only).

**Sibling slice (kept):** [`THREAT-MODEL-STAGING-DEPLOY.md`](THREAT-MODEL-STAGING-DEPLOY.md) is D26-P3-01 — one workflow file. It is **not** this document.

**Class X stays Nitro human:** secret values and rotation, production go-live, sanctions **list content**. Agents do not generate keys, paste secrets, or fill `INTAFACED_SANCTIONS_REGIONS`.

---

## 0 · Verdict (one breath)

**The Fiat Plane may hold customer value only in `packages/ledger-client`.** TS money services are doors into that book. The vendored Java exchange still contains a second book that is **neutered in source** (Grade D empty, throws/doors/DAO no-ops) and **unproven at runtime** (compose jars are not the scanned tree). **`01_wallet_rpc` must not be pointed at real value** — owner actions + security review findings still LIVE the moment anyone supplies env and starts it. Staging deploy credentials are a separate, smaller blast radius ([P3-01](THREAT-MODEL-STAGING-DEPLOY.md)).

**Go-live is blocked by named Class X and §13 sockets, not by “we need another July 29 one-pager.”**

---

## 1 · Ranked assets (what an attacker actually wants)

| #   | Asset                                                                                         | Why it ranks here                                                                                                          | Plane                |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | **Spending keys / withdrawal seeds** (ECT withdraw secret, ETH hot-wallet key, node RPC auth) | Disclosure is irreversible. A leaked private key **is** the account; rotation does not exist — sweep only.                 | wallet_rpc · Class X |
| 2   | **The ledger book** (`svc-ledger` + `ledger-client` recipes)                                  | Doctrine §0.6: every other module is a liar if it holds a balance. Compromise here is the platform.                        | Fiat                 |
| 3   | **Live pay/bank rails** (EVM hot wallet, future card acquirer, P2P escrow)                    | Moves value out of the book onto a chain or a sponsor bank. Card acquiring is not a code gap.                              | Fiat · Class X       |
| 4   | **Vendor Java second book** (MemberWallet / Kafka settlement / admin mint paths)              | If throws/doors are lifted or **stale jars** run, the UI shell becomes a second SoT.                                       | Vendor Java          |
| 5   | **Staging/prod host + transport secrets**                                                     | Shell behind the fleet. Deliberately does **not** hold rail keys in the workflow.                                          | P3-01                |
| 6   | **Identity / session**                                                                        | Stolen session drains only what the book + rail still allow; still a door. Written review is **D26-P3-06**, not this page. | Fiat (adjacent)      |
| 7   | **Public git history**                                                                        | This repo is public. Committed credentials and Actions logs are publication channels.                                      | All                  |

---

## 2 · Trust boundaries

| Boundary                          | Trusted side                                 | Untrusted side                                   | What must not cross                                  |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| Client / shell → edge             | `svc-edge` principal + HMAC                  | Browser, Vue shell, staff console                | Partner names, invented mids, Java wallet as balance |
| Service → ledger                  | `ledger-client` recipes                      | Any `svc-*` or Java module                       | A local `number` balance; a second book              |
| Fiat Plane → Protocol Plane       | Shehzad chain / INTACHAIN (babysit only)     | Custodial withdraw-for-user                      | Mixing custody models in one door                    |
| TS fleet → `01_wallet_rpc`        | **Nothing today** (no compose, M5–M7)        | HTTP GET spend + cron floor                      | Env that boots RPC against mainnet                   |
| Java HTTP door → MemberWallet     | 410 interceptor + service throws (source)    | Kafka consumers, scheduled jobs, event listeners | HTTP door claimed as covering non-HTTP               |
| Scanned Java source → running jar | `vendor-java-money-scan` / door scan         | gitignored `target/*.jar` predating neutering    | “Scan clean ⇒ runtime safe”                          |
| CI / public logs → the world      | Masking is not a control                     | Fork clones, Actions logs                        | Any live secret (P3-01 §4; OWNER-ACTIONS)            |
| Screening mechanism → list        | Empty `screening.ts` + fail-closed prod boot | Counsel-supplied region list                     | Agent-invented sanctions content                     |

---

## 3 · Fiat plane — custodial money doors

**Law:** no module holds its own balance. Decimal strings on the wire; scaled bigint in memory. Kill path is a separate lever (`OPS-KILL-SWITCH-RUNBOOK.md` · board **D26-P2-10**), not a deploy rollback.

### 3.1 What is a door (and what is not)

A **money door** is a public or S2S entry that can create, hold, settle, reverse, or refuse a ledger recipe. Promise-falsify suites (**D26-P2-01** family) exist so those doors refuse invented rails rather than silently succeeding.

| Door class                        | Where it lives                      | Current judgment                                                                           | Named residual                                     |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Ledger purpose / freeze / recipes | `svc-ledger` + `ledger-client`      | SoT. Live-path matrix **D26-P2-11** (#1745). Unmapped live path is a bug.                  | Recipe queue vs §13 — do not invent recipes        |
| Pay settle / mandate / grant      | `svc-pay`                           | Public doors refuse invent. **Card gateway stays Class X refuse** (tip `#1995`).           | `socket.psp-partners` (commercial; ADR 2026-08-04) |
| Pay crypto rail                   | `svc-pay` `EvmLiveChain`            | Ledger-only booking. Production RPC + hot-wallet key = **owner-supplied**.                 | Class X keys/RPC; dust policy product              |
| Bank earn / cards / ramps         | `svc-bank`                          | Refuse invent when rates/issuer unset (**D26-P2-01e**).                                    | Partner tables / Class X issuer                    |
| P2P escrow / dispute              | `svc-p2p`                           | Escrow in ledger; human ruling.                                                            | Moderator ids must not be invented                 |
| Trade / matching fill             | `svc-trade` / `svc-matching`        | Fills must not mint outside ledger. Matching dual-target is **D26-P2-06** (not this page). | No invented mids/depth                             |
| Token stake / buyback             | `svc-token`                         | Crash windows refuse unfunded yield.                                                       | Product residual on schedules                      |
| Vendor Java HTTP mint/withdraw    | `ucenter-api` / `admin` / `otc-api` | Dual-book door + throw in **source**. Admin has **no compose service**.                    | §4 below                                           |
| `01_wallet_rpc` spend             | `vendor/.../01_wallet_rpc`          | **Not in the fleet.** Gates forbid build/boot.                                             | §5 below                                           |

### 3.2 Attacker stories (fiat) — mitigated vs open

| Attacker                           | Goal                         | Mitigated by (tip)                                                        | Still open (named)                                            |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Stolen user session                | Drain available              | Hold + rail still required; identity review is **D26-P3-06**              | D26-P3-06 written review                                      |
| Compromised service HMAC           | Internal mint / XP / S2S     | Wave-1 HMAC internals; S2S not host-published                             | Session/auth review                                           |
| Invented card / PSP                | Fake acquiring               | Tip refuse; Hyperswitch banned (leverage law)                             | `socket.psp-partners` **Class X**                             |
| Empty sanctions list as “screened” | Serve blocked regions        | Prod/staging refuse boot without list **mechanism**; content empty by law | List **content** Class X; `socket` geo-IP vs `DEFAULT_REGION` |
| Java shell as books                | Replace ledger               | Quarantine + dual-book gates                                              | Runtime jar truth (**D26-P2-07**)                             |
| Staging workflow as vault          | All fleet secrets in Actions | P3-01 holds **transport only**                                            | Owner: create `staging` env (P3-01 D1) **Class X host**       |
| Kill path missing on a new door    | Unstoppable drain            | Kill-switch completeness **D26-P2-10**                                    | Prove every **new** money route                               |

### 3.3 What this page refuses to invent

- Sanctions IP/device/region **lists** (counsel + Nitro).
- A live card issuer or sponsor BIN.
- Production go-live yes.
- A pentest against a host that does not exist.

---

## 4 · Vendor Java — dual-book risk

**Law:** [`adr/2026-08-02-adopt-vendored-product-keep-our-ledger.md`](adr/2026-08-02-adopt-vendored-product-keep-our-ledger.md) · residual [`adr/2026-08-04-java-dual-book-residual.md`](adr/2026-08-04-java-dual-book-residual.md) (D-S-17).  
**Map (executed):** [`VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md`](VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md) · `pnpm map:vendor-java-money-plane`.  
**Rule that must not be laundered:** **no runtime safety claim may cite a source scan as evidence.**

### 4.1 What holds in source (tip)

| Control                             | Strength                        | Ticket / gate                                                     |
| ----------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Grade D ungated mints               | **Empty** and ratcheted         | **D26-P2-07** / #1747 · `vendor-java-money-scan`                  |
| Grade A DAO `WHERE 1=0` + throw     | Runtime **if that source runs** | Same scan                                                         |
| Grade B `MemberWalletService` throw | Runtime **if that source runs** | Kafka settlement uses this, not the HTTP door                     |
| HTTP 410 dual-book door             | HTTP only; 5/5 apps registered  | `dual-book-door-scan` · **D26-P2-02** / #1751                     |
| `custody-scan` walks Java           | Scan object includes money Java | **D26-P2-08** / #1748                                             |
| Jar-truth gate                      | Bans Grade D re-arm shapes      | `vendor-java-jar-truth` · rebuild path `pnpm vendor-java:rebuild` |

### 4.2 What does **not** hold

1. **Scanned source ≠ running binary.** Compose jars are gitignored; a clean source scan is a claim about files. Absent rebuilt jars, runtime is **UNVERIFIED** (D26-P2-07 done-bar: path real, not a green safety tick).
2. **HTTP door cannot reach Kafka / cron / Spring events.** `market` settlement and `wallet` `FinanceConsumer` are the load-bearing seams. Withdraw path can hit **RPC send before** the dual-book throw — §13 `socket.vendor-wallet-chain-before-book`. Compose **lacks** a `wallet` service today; mounting it without that control is a custody incident.
3. **Allowlisted second-book writes name ledger recipes; zero are redirected.** §13 `socket.vendor-java-ledger-redirect`. A throw is a holding position, not a migration.
4. **Grade C remaining sites** are door-only on some approve/envelope paths (map). Admin mint controllers are CLOSED in source **and** have no compose service — do not read that as “admin is production-safe.”
5. **Supply-chain of committed jars** (wallet_rpc 18 jars including an unnamed bitcoinj fork; Spring Boot 1.5.9). Board **D26-P3-11** — Maven/vendor in scan scope. Not closed by this judgment.

---

## 5 · `wallet_rpc` (incl. F10 · owner secrets)

**Review (static, 2026-08-05/06):** [`security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md`](security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md). That **is** the adoption-precondition read. It is **not** clearance to deploy.  
**Owner page:** [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md). **No secret values on this page.**  
**Perimeter gates:** `wallet-rpc-auth-scan` · `wallet-rpc-mainnet-scan` (M5–M7: no Dockerfile, no compose, no CI boot) · `secret-scan` withdraw-wallet convention.

**A4 still stands:** do not deploy `01_wallet_rpc` against real value. “Just point it at a testnet” is **not** available (F4 / A3b: no chain id + Etherscan mainnet second broadcast).

### 5.1 Findings that decide custody (rank, not CVSS)

LIVE = live the moment env is supplied and the process starts. Nothing in this tree runs in the fleet today; that is **enforced**, not incidental.

| Anchor       | Judgment                                                                                                                                                                                                                                                     | Ticket / path                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **F3**       | ETH hot-wallet **private key** logged every ~30s (unrotatable). Rank 1.                                                                                                                                                                                      | Review F3; Class X sweep if ever booted                                                                                            |
| **F1**       | ECT withdrawal secret printed to stdout on every withdraw                                                                                                                                                                                                    | **A1** rotate+TLS decision · Class X                                                                                               |
| **F2**       | Node RPC URI (credentials in userinfo) logged at INFO                                                                                                                                                                                                        | Rotate if those nodes are ours · **A3**                                                                                            |
| **F4**       | Pre-EIP-155 sign + unconditional Etherscan mainnet relay                                                                                                                                                                                                     | [`SPEC-EIP155-WALLET-RPC-WITHDRAWAL-SIGNING.md`](SPEC-EIP155-WALLET-RPC-WITHDRAWAL-SIGNING.md) · **A3b** needs JDK · **D26-P2-09** |
| **F5**       | Value-moving endpoints are HTTP GET behind one static token                                                                                                                                                                                                  | Auth land + `RpcSecurityConfig`; shared token blast radius unknown until env is read                                               |
| **F8**       | Trust-all TLS + fastjson 1.2.31 on key-handling services                                                                                                                                                                                                     | Review F8; do not boot                                                                                                             |
| **F9**       | Unencrypted bitcoinj wallet + key-destroy race                                                                                                                                                                                                               | Review F9                                                                                                                          |
| **F10**      | **`act/pom.xml` declares `rpc-common` twice (1.0 then 1.2).** Maven takes **1.0**. Reactor builds **1.2**. Auth guard may be absent on `act`. Gate W1 was version-blind; scan now **names** the 1.0 entries and still cannot prove resolution without Maven. | **D26-P2-09** · `tooling/ci/wallet-rpc-auth-scan.mjs` F10 comments                                                                 |
| **F19 / A2** | Deleted `main()` still disclosed a second ECT secret in git history                                                                                                                                                                                          | **A2** separate rotation                                                                                                           |
| **A3**       | ACT node RPC in a test `main()` — likely upstream’s node                                                                                                                                                                                                     | Owner decision whether it is ours                                                                                                  |

**Spend surfaces (map):** six HTTP `WalletController` send helpers + `@Scheduled` `PaymentHandler` / `CoinCollectJob` (cron **outside** any HTTP interceptor) → §13 `socket.wallet-rpc-spend-perimeter`.

### 5.2 What is already enforced (so this judgment is not a memory test)

- No `WALLET_RPC_AUTH_TOKEN` (≥32) → bootable modules that carry the guard **do not start**.
- ECT refuses unset **and** the old disclosed value (SHA-256 match; value not in tree).
- W3: publishing a wallet_rpc port off `127.0.0.1` in compose fails CI.
- Mainnet constants frozen; no new mainnet selector; M6/M7 forbid compose/CI boot.
- **F10 residual remains:** `act` is the module the gate cannot honestly bless.

---

## 6 · Class X — Nitro human only (do not agent-close)

| Item                                                                    | Why agents stop                                   | Home                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Rotate / sweep disclosed wallet secrets (A1, A2, maybe A3)              | Needs the live account                            | `OWNER-ACTIONS-WALLET-RPC-SECRETS.md` · `BOARD-CLEAR-HUMAN-BLOCKERS.md` |
| Generate any replacement key                                            | “A key an agent generated is a key an agent had.” | Same                                                                    |
| Sanctions / geo blocklist **content**                                   | Counsel                                           | `screening-content-scan` · `packages/config` empty mechanism            |
| Production go-live                                                      | Product + legal                                   | Doctrine; this page is not a yes                                        |
| Buy/provision staging or prod host; create GitHub `staging` environment | Money + repo settings                             | P3-01 D1–D3                                                             |
| Fill `socket.psp-partners`                                              | Commercial acquiring                              | ADR 2026-08-04                                                          |
| Independent pentest / Strix vs a live host                              | Track B · explicit Nitro go                       | `SECURITY-WHEN-PLAIN.md`                                                |

**D26-P3-05** (secret rotation **readiness** runbook) is ops engineering adjacent; **performing** rotation stays X.

---

## 7 · Named residuals (tickets, not vibes)

Ordered by what an attacker gains if we pretend they are closed.

| #      | Residual                                                                                                                                                       | Kind                                    | Owner                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| **R1** | Disclosed wallet_rpc secrets still in git history — rotate/sweep **A1** (first) and **A2**; decide **A3**                                                      | Class X                                 | Nitro                                          |
| **R2** | **F10** `act` / `rpc-common` 1.0 vs 1.2 — unauthenticated `/rpc/**` if 1.0 wins                                                                                | **D26-P2-09** + auth-scan version proof | Denon implement (JDK/Maven to prove)           |
| **R3** | **F4 / A3b** chain-id-less sign + Etherscan mainnet second broadcast — testnet is not a mitigation                                                             | `SPEC-EIP155-…` · **D26-P2-09**         | Denon + JDK; not agent-hot-fix without compile |
| **R4** | Java **runtime unverified** (jars ≠ scanned source) + **`socket.vendor-java-ledger-redirect`** (zero redirects) + **`socket.vendor-wallet-chain-before-book`** | **D26-P2-07** path · §13 sockets        | Denon; do not mount `wallet` compose           |
| **R5** | Fiat live rails: **`socket.psp-partners`**, sanctions **content**, pay production RPC/hot wallet                                                               | Class X                                 | Nitro + counsel                                |
| R6     | Cron/HTTP spend on wallet_rpc if ever composed                                                                                                                 | `socket.wallet-rpc-spend-perimeter`     | Owner before any Dockerfile                    |
| R7     | Staging environment protection + host (P3-01 D1)                                                                                                               | Class X / ops                           | Nitro — see staging threat model               |
| R8     | Auth/session written review                                                                                                                                    | **D26-P3-06**                           | Judgment mountain (not this PR)                |
| R9     | Vendor Java Maven/CVE in scan scope                                                                                                                            | **D26-P3-11**                           | Security mountain                              |
| R10    | Kill-switch completeness on every money route                                                                                                                  | **D26-P2-10**                           | Eng                                            |
| R11    | F3/F1/F2 log sinks — if the tree ever runs, logs **are** the exfil channel                                                                                     | Review F1–F3                            | Must fix **before** any boot, after A4         |

---

## 8 · Proven vs reasoned vs out of scope

**Proven on tip (gates / maps / reviews already landed):** dual-book Grade D empty; door registrations 5/5; custody-scan Java walk; wallet-rpc mainnet/auth/secret scans; card gateway Class X refuse; P3-01 workflow static checks; vendor Java money-plane map runner.

**Reasoned, not executed:** every claim about a running wallet_rpc or a rebuilt Java jar on a host. This machine’s threat model does not compile Java or pentest.

**Out of scope here:** Protocol Plane / INTACHAIN implement (Shehzad); Vue craft; D26-P0-05 options ADR; matching engine internals; staging workflow controls (already written).

---

## 9 · Review triggers (when this page is stale)

Re-read when any of these land — each invalidates a sentence above:

| Event                                                   | Invalidates                                            |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `01_wallet_rpc` Dockerfile, compose service, or CI boot | §5 “unenforced absence”; A4                            |
| F10 pom fix + Maven-resolved proof                      | R2                                                     |
| EIP-155 spec applied and compiled                       | R3; “testnet mitigation”                               |
| Rebuilt compose jars from scanned source in CI          | §4.2 (1)                                               |
| `wallet` Java service added to compose                  | R4 chain-before-book                                   |
| `socket.psp-partners` filled or card issuer invented    | §3                                                     |
| Sanctions list populated                                | Class X content; geo-IP socket                         |
| Staging host exists / first deploy                      | P3-01 becomes empirical                                |
| D26-P3-06 auth review ships                             | §3.2 session row                                       |
| A1/A2 rotation confirmed by Nitro                       | R1 (history still disclosed; values must be worthless) |

---

## 10 · Pointers (do not fork a seventh audit)

| Need                         | Read                                                |
| ---------------------------- | --------------------------------------------------- |
| **This mountain (current)**  | **This file**                                       |
| Staging deploy workflow only | `THREAT-MODEL-STAGING-DEPLOY.md`                    |
| When to pentest vs gates     | `SECURITY-WHEN-PLAIN.md`                            |
| July 29 one-pager            | **Archive** `audit/2026-07-29/05-THREAT-MODEL.md`   |
| Product trust scoreboard     | `PEACE-OF-MIND-AUDIT-CURRENT.md` (orientation)      |
| Wallet secrets owner list    | `OWNER-ACTIONS-WALLET-RPC-SECRETS.md`               |
| Wallet RPC findings F1–F21   | `security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md` |
| Java doors / §13             | `VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md`          |
| Dual-book residual law       | `adr/2026-08-04-java-dual-book-residual.md`         |
