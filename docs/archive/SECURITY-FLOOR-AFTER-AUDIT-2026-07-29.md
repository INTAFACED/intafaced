# Security floor after audit (2026-07-29)

**One home for “where security stands” after the product audit closed.**  
**Not** a second arsenal. Detail catalogs stay in the research maps (local until shipped).  
**Product trust floor remains:** [`PEACE-OF-MIND-AUDIT-CURRENT.md`](./PEACE-OF-MIND-AUDIT-CURRENT.md). Residual after #86: [`POST-MERGE-RESIDUAL-AFTER-86.md`](./POST-MERGE-RESIDUAL-AFTER-86.md).

| Field                | Value                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| **Verified against** | `origin/main` tip **`60031cf`** (includes #80, #81, #82)                                       |
| **This doc date**    | 2026-07-29                                                                                     |
| **Claim tags**       | `[VERIFIED 2026-07-29]` code/CI presence via git + `gh` on tip · research maps not yet on main |
| **Do not use**       | Stale local checkouts behind main; July-27 “routers unmounted”; V2 paste as open job           |

---

## Verdict (one line)

**Track A (everyday security law): PARTIAL — product doors closed; secret scan + doctrine-as-code + property/cheat automation still missing. Product go-live: blocked by rails/chain/perimeter/kill-path + L2-6, not by “need another full audit.”**

---

## Reality freeze (do not argue with memory)

| Fact                              | Proof                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Full A–E audit **closed** on main | #80 + #81 code; #82 orientation docs; `FULL-AUDIT-PROGRAM` status CLOSED                                                      |
| Living product scoreboard         | `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` on main (tip note may still say `88e5e33`; actual tip is `60031cf` after #82 docs-only) |
| Next Denon wave                   | **Only** `docs/WAVE-AUDIT.md` (+ optional `.grok/workflows/denon-wave-audit.rhai`) — no full archaeology                      |
| Platform surface                  | Routers mounted; `pnpm platform:up` exists; edge + fleet on main                                                              |
| Not real-money product            | Rails/sandbox, chain propped/NullChain; vendor **quarantined**                                                                |
| Open product residual             | **L2-6** S2S body-bind; real rails/chain; operator freeze/kill proven; vendor never without Nitro yes                         |
| CI on money fix tips              | #80 / #81 **success**; #82 docs CI was still in progress at verify time (docs-only)                                           |
| Open product PR                   | #84 Stream A claim (docs) — not a security program                                                                            |

**Warning:** Research security docs (`SECURITY-WHEN-PLAIN`, `BULLETPROOF-ARSENAL`, `STRIX-ASSESSMENT`) were **local working-tree only** at verification — **not on `origin/main`**. Ship them only after phase language is corrected (below).

---

## Product audit vs security tooling (do not conflate)

| Layer                                                                         | Status                                                                             | Meaning                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Product open doors** (authz, mounts, purpose pots, claim-order, IDOR, etc.) | **Closed on main** via #80/#81                                                     | Denon can keep building under WAVE-AUDIT                                                                                            |
| **Everyday law / Track A tooling**                                            | **Partial**                                                                        | brand/custody/DoD/verify are real; gitleaks / Semgrep-doctrine / property suite / automated cheat-diff are **not** installed as law |
| **Attack readiness / Track B**                                                | **Map now · run later** (phase **advanced**: stack _can_ listen via `platform:up`) | Strix still **PARKED** until deliberate non-prod campaign + explicit Nitro go                                                       |

---

## Track A — item by item

| Claim                                                      | Status                                            | Evidence / gap                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Keep brand / custody / DoD / `pnpm verify` green           | **DONE**                                          | `package.json` scripts; CI runs brand + custody first; #80/#81 CI green                                                                   |
| Grow machine doctrine checks (Semgrep-class + money greps) | **PARTIAL / thin**                                | custody + brand + DoD exist; **no** Semgrep config/rules on main; no dedicated money-as-number CI scan beyond existing tests/scanners     |
| Secret scanning always-on (gitleaks / TruffleHog-class)    | **MISSING**                                       | no tool/config/workflow hit on `origin/main`                                                                                              |
| Stronger money proofs (property / invariant tests)         | **PARTIAL**                                       | Strong **example + isolation** tests in ledger-client / services for fixed bugs; **no** `fast-check` (or equivalent) property suite found |
| AI false-green / cheat detection on money diffs            | **PARTIAL (process only)**                        | Required in WAVE-AUDIT / meta-audit prose; **no** automated checker in `tooling/ci`                                                       |
| Multi-agent audit / maker-checker                          | **DONE as closed program + standing wave recipe** | Full program closed; WAVE-AUDIT mandates critic + cross-family when available — not a permanent bot                                       |

---

## Track B — phase check (correct the maps)

| Item                                                                         | Research phase                     | After audit (correct)                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZAP-class DAST                                                               | Near (after routers)               | **Near now eligible** — routers mounted + `platform:up`; still not “must do today”                                                                                  |
| Concurrent smoke (k6-class)                                                  | Near                               | **Near now eligible** — same; optional high leverage before go-live, not before Denon builds                                                                        |
| Strix                                                                        | Parked until non-prod live surface | **Still correctly PARKED** until you schedule a **non-prod** campaign + ROE + budget + telemetry off. Never merge-blocking CI. Never prod without formal engagement |
| ASVS mapping + human pentest + SCA/images                                    | Pre real customer money            | **Still correctly later**                                                                                                                                           |
| Explicit non-goals (Strix CI law, cloud Strix default, buy every AI pentest) | Skip                               | **Still correct**                                                                                                                                                   |

---

## Already done (product + process) — with pointers

1. **P0/P1 open doors** — #80 (`4461e88`): protocol `/trpc`, awardXp service-only, pay ownership, internal HMAC, dex ports, brand/CI after vendor, tracker honesty
2. **P1 money crash windows L3-1/2/3** — fixed (withdraw reverse finalization; stake/earn pending→active) — findings + #80
3. **P2 structural money/auth** — #81 (`88e5e33`): purpose escrow/stake, region in principal HMAC, P2P party reads, S2S not host-published, tracker done evidence, protocol UI honesty
4. **Peace floor + wave recipe** — #80/#82: `PEACE-OF-MIND-AUDIT-CURRENT.md`, `WAVE-AUDIT.md`, `docs/audit/2026-07-29/*`
5. **Proof artifacts that exist:** threat model `05-THREAT-MODEL.md`, journey table `06-MONEY-JOURNEY-TABLE.md`, L0 notes `04-L0-MACHINE.md` (thin but present)
6. **Doctrine scanners as law:** brand-scan, custody-scan, DoD gate inside verify

---

## Partial / claimed but not real

| Claim                                       | What’s missing to call “done”                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| V2 “proof upgrades complete”                | Property tests + automated cheat-diff never became repo law; L0 notes admit PG money tests skipped locally  |
| Findings “P2 parked” table                  | **Stale** — many rows closed by #81; only **L2-6** (+ go-live list) should stay open on the living floor    |
| AUDIT-V2 body “READY TO RUN”                | Banner says CLOSED; body still reads as open job — treat banner + PEACE as truth                            |
| HANDOVER-AUDIT-V2-PASTE                     | Superseded banner exists; do **not** paste as new open residual job                                         |
| Research “NOW: routers unmounted”           | **Wrong** on live main — routers mounted; near-phase attack tools are _available_, not _due_                |
| Arsenal “NOW routers unmounted” timeline    | Same correction                                                                                             |
| “Session prompt points at security when-to” | Security maps not on main yet; main session prompt still has **stale Phase 2 “trade not on main”** language |
| PEACE tip SHA                               | Update to `60031cf` when next docs touch                                                                    |

---

## Should add **now** (only high leverage — max 3)

Ordered by money-risk / regression prevention, not novelty:

1. **Secret scanning as always-on law** (gitleaks or TruffleHog verified) on PR + main — cheap, stops irreversible key leaks; audit did not install this.
2. **Doctrine machine growth** — either Semgrep CE custom rules _or_ tighter home greps in `tooling/ci` for money-as-number / bare `ledger.post` / cross-service SQL (encode §0, don’t wait for Strix).
3. **On every money PR (process → optional small script):** failure/invariant test required + cheat-diff greps (empty catch / assertion strip / `@ts-ignore` on money paths). Prefer a tiny home script over buying swarm-orchestrator day one.

**Do not add now:** Strix install, ZAP CI theater, AI-pentest SaaS, full CodeQL Pro, another full-repo audit.

**Optional soon (not “stop Denon”):** one **property-test** file on ledger hold/escrow/stake invariants; short **k6 concurrent smoke** once someone regularly runs `platform:up`.

---

## Still correctly later

- Strix campaign (non-prod, ROE, budget, telemetry off)
- Independent human pentest before real customer money
- ASVS L2→L3 matrix as go-live evidence
- SCA + image scan on what actually ships
- L2-6 S2S body-bind (needs real design; not a drive-by)
- Chaos / CSPM / SBOM at deploy maturity

---

## Conflicts — which wins

| Conflict                                                     | Winner                                                                                 | Why                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------- |
| Research maps vs product audit on open money doors           | **Product audit / PEACE / #80+#81**                                                    | Code + green CI on tip       |
| Research “routers unmounted / NOW only static” vs START-HERE | **START-HERE + live main**                                                             | mounts + platform:up exist   |
| V2 residual “must fix L3-1/2/3” vs PEACE                     | **PEACE + findings FIXED rows**                                                        | residual money shipped       |
| Arsenal shopping list vs WAVE-AUDIT                          | **WAVE-AUDIT for after Denon**                                                         | program closed; delta only   |
| Local uncommitted research docs vs main                      | **main for product truth**; research maps are **draft until shipped with phase fixes** | not on origin at verify time |

### Exact edits for research / orientation docs (when shipping)

1. `SECURITY-WHEN-PLAIN.md`: replace “routers still not a real public API” with “stack can run via platform:up; not public customer money.” Move ZAP/k6 to **eligible near**, not blocked on mounts. Point Track A status to **this floor**.
2. `BULLETPROOF-ARSENAL-2026-07-29.md` §5: change `NOW (routers unmounted)` → `NOW (post-audit; mounts exist; secret/Semgrep/property still to grow)`. Mark multi-agent full program **CLOSED**; wave audit standing.
3. `STRIX-ASSESSMENT`: keep PARK; earliest run = deliberate local/staging with ROE (eligible earlier than maps first assumed).
4. `NITRO-SESSION-PROMPT` (on main): drop “Phase 2 Trade not on main”; link PEACE + WAVE-AUDIT + this floor + security when-to once shipped.
5. `PEACE-OF-MIND`: tip SHA → `60031cf`; residual list already correct enough (L2-6 + go-live).
6. `02-FINDINGS` P2 table: annotate closed-by-#81 or leave as historical snapshot with banner.
7. `AUDIT-V2` body status line: set **CLOSED** consistently with banner.

---

## Recommended next moves (money-risk order)

### For Nitro (product)

1. **Let Denon keep building** under the peace floor — no full re-audit. After his merges: agents run WAVE-AUDIT only.
2. **Do not go live with real user money** until rails + chain + host perimeter + operator kill path are real; keep vendor quarantined unless you explicitly product-decide otherwise.
3. **When you want a security tooling PR:** authorize agents to ship (1) secret scan law, (2) doctrine machine rules, (3) optional property + cheat greps — not Strix.

### For agents

1. Orient every session from **`origin/main`**, not a behind checkout; floor = PEACE + this doc.
2. After Denon waves → **WAVE-AUDIT only**.
3. Next high-leverage security implementation PR (when Nitro says ship tooling): gitleaks (or equivalent) in CI → doctrine Semgrep/greps → money PR cheat-diff helper.
4. **Never** install/run Strix without explicit Nitro go + named non-prod target.
5. Ship research security docs only **after** phase-language fixes above (or land this floor first on main).

---

## Explicit non-problems (so we don’t reopen theater)

- Rebuilding trade/matching/pay/p2p/bank
- Re-running full A–E without fire on main
- Treating “arsenal written” as “safe for real money”
- Strix as merge-blocking CI
- Parallel second security program next to WAVE-AUDIT

---

## Sources used this pass

- `git fetch` + `origin/main` @ `60031cf`
- PR #80, #81, #82 bodies + merge SHAs; CI conclusions for #80/#81
- On-main: PEACE, WAVE-AUDIT, FULL-AUDIT-PROGRAM, AUDIT-V2 banner, audit/2026-07-29/\*
- On-main tooling: `package.json` scripts, `.github/workflows/ci.yml`, `tooling/ci/*`
- Local draft maps: SECURITY-WHEN-PLAIN, BULLETPROOF-ARSENAL, STRIX-ASSESSMENT (not on main at verify)
