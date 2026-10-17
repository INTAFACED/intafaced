# Bulletproof arsenal for INTAFACED (around Strix)

**Date:** 2026-07-29  
**Companion docs:** [`STRIX-ASSESSMENT-2026-07-29.md`](./STRIX-ASSESSMENT-2026-07-29.md) · [`AUDIT-V2-RESIDUAL-AND-STRESS-2026-07-29.md`](./AUDIT-V2-RESIDUAL-AND-STRESS-2026-07-29.md) · [`PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md`](./PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md)  
**Rule:** No tool for its own sake. Every row must cover a **risk class Strix does not own alone**, at a **named phase**, with a **named owner** (machine law / human / agent / red team).

**One-line thesis:** Strix is the **live exploit + PoC layer**. Bulletproof for real money needs **nine other layers** under it — doctrine scanners, secrets, SCA, SAST-as-law, property/concurrency proofs, DAST smoke, supply-chain, infra/runtime, and independent human red-team/compliance. None of those are “optional nice-to-haves” for a custodial financial OS.

---

## 0 · What you were really asking (implicit requirements)

Surface: “What else on top of Strix so we are bulletproof later?”

Inferred needs (money at risk → these are requirements, not wishlist):

| #   | Unspoken need                           | Why it exists for INTAFACED                                                                                                                                |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Loss classes named**                  | Not “security tools” — _double-spend, race on holds, IDOR to balances, authz bypass, secret leak, supply-chain, custody-plane bleed, false-green AI tests_ |
| 2   | **Layered defense with no single hero** | Strix is probabilistic LLM offense; money law must stay **deterministic**                                                                                  |
| 3   | **Phase map**                           | Don’t buy/run expensive layers before routers + staging exist                                                                                              |
| 4   | **CI law vs campaign tools**            | What blocks merge vs what you run monthly / pre-go-live                                                                                                    |
| 5   | **Overlap with audit V2**               | Don’t invent a second arsenal that contradicts meta-audit absorb/reject                                                                                    |
| 6   | **Human + independent check**           | For real money, AI tools never replace an independent pentest / ASVS-style verification near go-live                                                       |
| 7   | **Doctrine-native**                     | Generic AppSec won’t encode §0.6 ledger-only, decimal money, brand, custody plane                                                                          |
| 8   | **Proof diversity**                     | Same bug class caught by scanner _and_ property test _and_ exploit PoC is the bar                                                                          |

### Better prompt (for Denon / future chat)

> Build a **phase-gated security arsenal** for INTAFACED (custodial Fiat plane + non-custodial Protocol). Anchor on Strix as the **dynamic exploit/PoC campaign tool only**. For each risk class (money integrity, authz, secrets, supply chain, runtime, AI false-green, compliance), name: tool or workflow, what it covers that Strix does not, when to introduce, CI vs campaign, cost class, and reject list. Prefer absorb existing audit V2 shortlist. No install without explicit go.

---

## 1 · What Strix already covers (so we do not double-buy)

From the Strix deep-read (see assessment doc):

| Strix strength                  | Detail                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Autonomous multi-agent red team | Root orchestrator + exploit/validation subagents                                  |
| Dynamic exploit + PoC           | Mandatory validation posture; not alert-only                                      |
| White/grey/black box            | Local code, GitHub, live URL; auth instructions                                   |
| Offensive toolkit in sandbox    | Nuclei, sqlmap, semgrep, gitleaks, browser, Caido, nmap, …                        |
| CI _capability_                 | Headless + PR diff mode exists — **not** recommended as merge-blocking law for us |

**What Strix is _not_ (gaps the arsenal must fill):**

| Gap                                  | Why it matters for money                                   |
| ------------------------------------ | ---------------------------------------------------------- |
| No doctrine §0                       | Won’t fail “balance outside ledger” or “money as number”   |
| Non-deterministic cost/findings      | Cannot be sole Definition of Done                          |
| Weak on pure mathematical invariants | Double-spend / hold invariants need property tests         |
| Not continuous secrets/SCA law       | Uses tools inside a campaign; not a always-on gate         |
| Not supply-chain SBOM policy         | One-shot scans ≠ dependency lifecycle                      |
| Not infra/IAM/K8s posture            | Sandbox attacks apps; not your cloud account graph         |
| Not compliance evidence alone        | SOC2/PCI-style auditors want process + independent pentest |
| Not AI-code-cheat detection          | Agents can green-wash tests; Strix won’t catch that        |
| Not chaos / failure injection        | Crash mid-transfer needs different tools                   |

---

## 2 · Industry stack (2026) — how the industry layers tools

Practitioners and 2026 AppSec roundups still organize by **layer**, not by “AI vs not AI”:

| Layer                   | Job                            | Typical tools (examples)                          | Relation to Strix                                                              |
| ----------------------- | ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Secrets**             | Stop keys shipping             | gitleaks, TruffleHog, GitHub secret scanning      | Strix can find secrets mid-pentest; **CI secret scan is law**                  |
| **SCA**                 | Known vulns in deps            | osv-scanner, Trivy, npm audit, Dependency-Check   | Strix may run trivy/nuclei occasionally; **not** continuous SCA                |
| **SAST**                | Custom + taint rules           | Semgrep CE, CodeQL, Sonar                         | Strix runs semgrep inside sandbox; **doctrine rules live in _our_ CI Semgrep** |
| **DAST**                | Runtime HTTP without full AI   | OWASP ZAP, StackHawk, Wapiti                      | Cheap continuous cousin of Strix; lower cost, lower creativity                 |
| **AI / agent pentest**  | Exploit chaining + PoC         | **Strix** (OSS), XBOW (closed/enterprise), Escape | This is Strix’s seat                                                           |
| **Manual / boutique**   | Business logic + skilled human | Burp Suite Pro + human; firms                     | Last mile for money products                                                   |
| **ASVS / requirements** | What “done” means              | OWASP ASVS L2→L3 for high-value finance           | Checklist Strix does not replace                                               |

Industry consensus (2026 AppSec guides): **SAST + SCA early in PR; DAST on staging; exploit validation for high severity; never one tool alone.**  
AI pentest (Strix/XBOW class) is framed as **exploit-first continuous validation**, not a replacement for SAST/SCA. Community caveat (recent social): AI pentest tools “work in demos”; production value = custom apps + continuous, not one magic scan.

**last30days note (2026-06-29 → 2026-07-29):** Engine run completed (Reddit/HN/GitHub/TikTok/IG). X errored (403). Signal for this _tool-stack_ topic was thin/noisy (off-topic social noise); strongest durable anchors were GitHub project presence of **Semgrep, ZAP, Strix**. Treat social as weak corroboration; **layer architecture + Intafaced doctrine** dominate this doc.

---

## 3 · Implicit risk classes for a real-money OS

Map every arsenal item to a **loss class**:

| Loss class                | Example failure                                  | Primary proof layer                                           | Strix role                             |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------- |
| **L-Money integrity**     | Double credit, hold leak, balance outside ledger | Doctrine scanners + property tests + ledger recipes           | Exploit races / business logic if live |
| **L-Authz**               | IDOR, vertical privilege, mass assignment        | SAST custom rules + grey-box Strix + ShopPay-style checklists | **Strong**                             |
| **L-Authn/session**       | JWT flaws, session fixation                      | Strix skills + unit/integration                               | Strong                                 |
| **L-Secrets**             | API keys in repo/logs                            | gitleaks/TruffleHog always-on                                 | Opportunistic                          |
| **L-Injection**           | SQLi, command, SSTI                              | Semgrep + ZAP + Strix PoC                                     | Strong                                 |
| **L-Supply chain**        | Malicious/outdated dep                           | SCA + lockfile policy + SBOM                                  | Weak                                   |
| **L-Custody plane**       | Protocol service posts ledger                    | custody-scan (already law)                                    | N/A — doctrine                         |
| **L-Brand/legal**         | Vendor names in UI                               | brand-scan (already law)                                      | N/A                                    |
| **L-AI false-green**      | Empty tests, swallowed errors                    | cheat detectors on fix diffs                                  | None                                   |
| **L-Runtime/infra**       | Exposed admin, bad IAM, open ports               | CSPM/IaC scan, network policy                                 | Partial (host-facing only)             |
| **L-Availability**        | Withdraw path dies under load                    | k6/load + chaos                                               | Not primary                            |
| **L-Compliance evidence** | “Prove you tested”                               | ASVS matrix + independent pentest report                      | Input only                             |

---

## 4 · Full arsenal (complete named set)

Status keys: **HAVE** · **PLANNED (audit V2)** · **ADD** · **LATER** · **SKIP**

### A · Already law (keep; grow)

| Item                                       | Status           | Covers                                         | Phase     |
| ------------------------------------------ | ---------------- | ---------------------------------------------- | --------- |
| `pnpm verify` (build/typecheck/test + DoD) | HAVE             | Engineering floor                              | Now       |
| `pnpm scan:brand`                          | HAVE             | Brand doctrine §0.7                            | Now       |
| `pnpm scan:custody`                        | HAVE             | Protocol plane custody bleed                   | Now       |
| DoD gate / migration-check                 | HAVE             | Ship honesty                                   | Now       |
| Multi-agent audit program                  | HAVE / in flight | Code judgment layers L1–L11                    | Now       |
| Maker-checker / cross-family critic        | PLANNED          | Self-review blindness                          | Money PRs |
| ShopPay-style business-logic prompts       | PLANNED          | Payment IDOR/webhook patterns as _calibration_ | Audit L3  |

### B · Deterministic machine law (under Strix — **absorb first**)

These are the **highest ROI** adds. Strix will never replace them.

| Item                                                                    | Status                | Why not Strix alone                                                                                        | Phase to adopt                        |
| ----------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Semgrep CE + custom doctrine rules**                                  | PLANNED → **ADD**     | Encodes §0 (money as number, bare ledger.post, cross-service SQL, unauth procedures) as **merge blockers** | **Now / next PR wave**                |
| **gitleaks** (and/or TruffleHog verified)                               | PLANNED L12 → **ADD** | Always-on secrets; Strix is campaign-only                                                                  | **Now** (one-shot main + CI)          |
| **osv-scanner / Trivy fs** (SCA + container)                            | ADD                   | Continuous known-CVE + image scan                                                                          | After deps stabilize; before deploy   |
| **Structural cheat detectors** (swarm-orchestrator greps or home-grown) | PLANNED → **ADD**     | AI false-green on fix PRs                                                                                  | Phase D of audit / every money fix PR |
| **Expand custody-scan / money-type scan**                               | PLANNED → **ADD**     | Doctrine as code                                                                                           | Now alongside Semgrep                 |

### C · Money-correctness proofs (Strix is weak here)

| Item                                                                | Status            | Why                                                                                               | Phase                               |
| ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **fast-check** (or equivalent property tests) on ledger/holds       | PLANNED → **ADD** | Invariants: non-negative balances, hold ≤ available, double-spend impossible under concurrent ops | As money fixes land; before go-live |
| **Concurrent smoke** (k6 / autocannon / scripted parallel withdraw) | PLANNED → **ADD** | Races Strix _might_ find only if it happens to try                                                | After `platform:up`                 |
| **Crash/recovery matrix** (kill mid-transfer, restart, reconcile)   | ADD workflow      | Not a single tool — test design                                                                   | Before staging with real flows      |
| **Mutation testing on `packages/ledger*` only**                     | LATER             | Measures test honesty; whole monorepo is waste                                                    | If property suite thin              |

### D · Dynamic / runtime (Strix’s peers — use both)

| Item                                                              | Status                   | Why _with_ Strix                                                            | Phase                           |
| ----------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- | ------------------------------- |
| **OWASP ZAP** (baseline + authenticated API scan in CI/staging)   | **ADD**                  | Cheap, deterministic-ish DAST; continuous; Strix is expensive deep campaign | Staging + optional weekly       |
| **Strix** (standard/deep, non-prod, budget-capped, telemetry off) | PARKED → **LATER**       | PoC-validated creative attacks, business logic                              | Staging / pre-go-live           |
| **Burp Suite Pro + human session** (or boutique firm)             | LATER                    | Independent skilled eye; auditor-friendly                                   | Pre-go-live / annual            |
| **XBOW / Escape / SaaS AI pentest**                               | SKIP default             | Overlap with Strix; cloud trust + cost; Strix already chosen as OSS seat    | Only if Strix fails in practice |
| **StackHawk**                                                     | SKIP unless ZAP friction | Paid DAST/CI polish; ZAP first                                              | Optional                        |

### E · Process & assurance (tools are not enough)

| Item                                                                  | Status                       | Why                                            | Phase                   |
| --------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------- | ----------------------- |
| **Threat model doc** (data flows, trust boundaries, Fiat vs Protocol) | PLANNED (05-threat-model)    | ASVS L3 expects design review                  | Before staging          |
| **OWASP ASVS mapping** (target **L2 now, L3 for go-live money**)      | **ADD**                      | External checklist of “what bulletproof means” | Track as matrix in docs |
| **Public procedure census** (every unauth/auth route)                 | PLANNED                      | Authz completeness                             | Pre-router-mount audit  |
| **Independent external pentest**                                      | LATER **required for money** | Independence for partners/regulators/self      | Pre-go-live             |
| **Rules of engagement template** for Strix/ZAP                        | **ADD** (doc only)           | Scope, test accounts, no prod                  | Before first run        |
| **Incident runbook** (key rotation, ledger freeze path)               | ADD                          | Detection without response is incomplete       | Deploy plane            |

### F · Infra / supply chain (when there is a deploy plane)

| Item                                                           | Status | Why                               | Phase                |
| -------------------------------------------------------------- | ------ | --------------------------------- | -------------------- |
| **SBOM** (CycloneDX/SPDX from lockfiles)                       | LATER  | Supply-chain honesty              | First container ship |
| **Container image scan** (Trivy on images you ship)            | LATER  | Runtime image CVEs                | First image          |
| **IaC scan** (Checkov/tfsec if Terraform; k8s policies if K8s) | LATER  | Misconfig → money exposure        | When IaC exists      |
| **CSPM / cloud posture**                                       | LATER  | IAM blast radius                  | Cloud account live   |
| **Chaos / toxiproxy**                                          | LATER  | Partial failure under money paths | Post-staging stress  |

### G · Explicit SKIP / waste (named so nobody “helps” later)

| Item                                                             | Why skip                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| Strix / any AI pentest as **merge-blocking CI law**              | Non-deterministic $ and flaky DoD                     |
| **app.strix.ai cloud** as default for monorepo                   | Source leaves perimeter; separate trust decision      |
| Full **CodeQL Pro** day-one                                      | Semgrep first; CodeQL if gaps after 2 quarters        |
| **SaaS PR bots** (CodeRabbit/Greptile) whole-repo                | Optional; multi-agent + scanners cover if disciplined |
| **50-agent fan-out** security theatre                            | Already rejected in residual audit                    |
| **Line-auditing vendor/** media                                  | Waste                                                 |
| **Running any exploit tool on production**                       | Explicit non-goal                                     |
| **Buying every AI pentest competitor** (XBOW + Escape + Hex + …) | One seat: Strix OSS; re-evaluate only on failure      |

---

## 5 · Phase timeline (when the time is right)

**Post-audit correction (2026-07-29):** routers **are** mounted; full product audit closed (#80/#81). Living status: [`SECURITY-FLOOR-AFTER-AUDIT-2026-07-29.md`](./SECURITY-FLOOR-AFTER-AUDIT-2026-07-29.md). Full multi-agent A–E is **closed** — next Denon waves use WAVE-AUDIT only.

```
NOW (post-audit: mounts + platform:up exist; Track A tooling still partial)
  ├─ Grow: Semgrep doctrine rules, gitleaks, cheat-diff, property tests on ledger
  ├─ Keep: brand/custody/DoD/verify; WAVE-AUDIT after Denon (not full archaeology)
  └─ Park as default: Strix campaign, chaos, CSPM, external pentest

NEAR eligible (local platform:up / staging — run when you schedule, not every PR)
  ├─ ZAP baseline against local APIs (auth test users)
  ├─ k6 concurrent smoke on withdraw/hold/stake
  └─ Optional: one Strix *white-box* quick on scoped services (telemetry off, budget cap)

Staging / non-prod deploy
  ├─ Strix standard/deep grey-box (instruction-file ROE)
  ├─ ZAP weekly continuous
  ├─ Trivy images + SCA in pipeline
  └─ ASVS L2 gap close

Pre-go-live (real money soon)
  ├─ ASVS L3-oriented review + threat model signed
  ├─ Independent external pentest (human firm)
  ├─ Strix deep re-run on staging after fixes
  ├─ Property + concurrent + crash matrix green
  └─ Incident + key rotation drills

Production
  ├─ Continuous: SAST/SCA/secrets CI only
  ├─ Continuous: monitoring/alerting (out of this doc’s tool scope but required)
  └─ NEVER: autonomous Strix against prod without formal engagement
```

---

## 6 · Recommended “minimum bulletproof stack” (decision-ready)

### Tier 0 — non-negotiable forever (cheap, deterministic)

1. Existing brand / custody / DoD / verify
2. **Semgrep** custom rules for doctrine + authz sinks
3. **gitleaks** (or TruffleHog verified mode) on every PR
4. Cheat-detector greps on money fix diffs
5. Property tests on ledger/hold invariants

### Tier 1 — when something listens (staging)

6. **OWASP ZAP** authenticated API baseline
7. **k6** (or autocannon) concurrent money-path smoke
8. **Strix** campaign (standard→deep), non-prod only, budget + ROE

### Tier 2 — before customer money

9. **ASVS** mapped checklist (L2 done, L3 for critical money surfaces)
10. **Independent human pentest**
11. SCA + image scan (osv-scanner/Trivy) wired into ship pipeline
12. Threat model + public route census current

### Tier 3 — scale / cloud maturity

13. SBOM + IaC + CSPM
14. Chaos on money paths
15. Optional CodeQL if Semgrep leaves cross-file holes

**Strix’s permanent seat:** Tier 1–2 **campaign exploit validation**. Not Tier 0 law.

---

## 7 · Workflows (how the arsenal is used, not just installed)

### W1 · Every PR (merge law)

`pnpm verify` → brand → custody → (future) Semgrep doctrine → gitleaks → tests.  
Money PR: + maker-checker critic + cheat-diff.

### W2 · Every money fix

Property or failure test that would have failed before fix → critic → verify.  
No “fixed” without a test that names the loss class.

### W3 · Weekly staging (once staging exists)

ZAP baseline job + dependency SCA summary. Human triage only High+.

### W4 · Pre-release Strix campaign

1. Freeze staging build
2. ROE file + test accounts
3. `STRIX_TELEMETRY=0`, budget cap, standard then deep if needed
4. Findings → tickets with PoC; fix → re-run scoped Strix / ZAP
5. Store report as release evidence

### W5 · Annual / go-live gate

External pentest + ASVS matrix sign-off + incident drill.

---

## 8 · Overlap matrix (avoid double-spend of tools)

| Capability              | Our doctrine scanners | Semgrep      | ZAP     | Strix         | Property/k6    | Human pentest      |
| ----------------------- | --------------------- | ------------ | ------- | ------------- | -------------- | ------------------ |
| §0 money/custody/brand  | **Primary**           | Custom rules | —       | —             | Supports       | —                  |
| Secrets                 | —                     | Partial      | —       | Opportunistic | —              | —                  |
| Known CVE deps          | —                     | —            | —       | Opportunistic | —              | —                  |
| Classic web vulns       | —                     | Good         | Good    | **Best PoC**  | —              | Best judgment      |
| Business logic / IDOR   | —                     | Limited      | Limited | **Strong**    | Partial        | **Strongest**      |
| Concurrent double-spend | —                     | —            | Weak    | Maybe         | **Primary**    | Strong             |
| AI false-green          | Cheat detectors       | —            | —       | —             | Mutation later | Review             |
| Compliance story        | Partial               | Partial      | Partial | Input         | Input          | **Primary report** |

---

## 9 · Cost / heaviness (so “arsenal” stays lean)

| Class                | Examples                                      | Cost shape                    |
| -------------------- | --------------------------------------------- | ----------------------------- |
| Free OSS CI          | Semgrep CE, gitleaks, ZAP, osv-scanner, Trivy | Engineer time + CI minutes    |
| Dev library          | fast-check                                    | PR time                       |
| LLM campaign         | Strix                                         | API $ per run; cap hard       |
| Paid SaaS AI pentest | XBOW etc.                                     | High; default skip            |
| Human firm           | External pentest                              | Highest $; required pre-money |

**Budget rule:** Spend first on **Tier 0** until green. Strix dollars only after staging exists.

---

## 10 · Alignment with existing audit decisions

| Prior decision                                        | This doc                                           |
| ----------------------------------------------------- | -------------------------------------------------- |
| STRX-class out of scope until deploy                  | **Confirmed** — Strix remains parked for campaigns |
| Absorb Semgrep, gitleaks, fast-check, cheat detectors | **Confirmed** — elevated to Tier 0/1               |
| Skip h5i/Ivy unless stack fails                       | **Confirmed**                                      |
| Skip production live pentest                          | **Confirmed**                                      |
| Proof diversity > magic tool                          | **Confirmed**                                      |

---

## 11 · Research confidence

| Source                                                    | Use                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| Strix source + assessment 2026-07-29                      | Mechanism + gaps `[VERIFIED]`                                  |
| INTAFACED audit V2 + meta-audit                           | Prior absorb/reject `[VERIFIED in-repo]`                       |
| 2026 AppSec OSS/SaaS guides (Orca, Veracode, Endor, etc.) | Industry layer model `[web]`                                   |
| OWASP ASVS                                                | L2/L3 for financial-grade apps `[web]`                         |
| last30days engine 2026-07-29                              | Weak social signal; GitHub tool presence; X failed `[partial]` |
| “Would catch double-spend in practice”                    | Judgment until run on live stack                               |

**Residual risk:** No arsenal guarantees safety. Real money needs **independent** verification and ops discipline (access control, monitoring, key custody) beyond scanners.

---

## 12 · What Nitro decides later (not now)

When staging is real, pick:

1. Confirm **Tier 0** implements (Semgrep doctrine + gitleaks + property + cheat) before any Strix spend
2. First Strix campaign: **local** vs **staging** only
3. External pentest firm timing relative to partner/KYC go-live
4. Cloud Strix SaaS: **default no** unless Denon wants managed

**No install/run from this doc alone.** This is the map for when the time is right.
