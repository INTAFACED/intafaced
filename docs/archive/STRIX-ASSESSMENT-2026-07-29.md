# Strix assessment for INTAFACED

**Date:** 2026-07-29  
**Target:** [usestrix/strix](https://github.com/usestrix/strix) (Apache-2.0, PyPI `strix-agent`, v1.4.1)  
**Ask:** Full knowledge — not rubber-stamp; should we use it on INTAFACED, now, or later?  
**Constraint honored:** no INTAFACED code changes; static inspection only (no install/run of Strix).

**Verdict in one line:** **PARK until a non-prod deploy surface exists.** Real tool, wrong phase. When you have staging with mounted routers, run it once as a controlled live-exploit layer — never as CI law and never against production.

This is the same class already named in the audit program as **“STRX / auto-pentest agents”** and **“Live AI pentest frameworks (STRX-class)”** — out of scope until deploy plane. This doc is the deep read behind that line.

---

## 0 · Enhanced brief (what you were really asking)

### Surface ask

Check out Strix; understand it fully; decide use / now / later for INTAFACED.

### Unspoken needs (inferred)

1. **Is this the missing security magic** for the audit program, or marketing noise?
2. **Does it replace** agent code review, doctrine scanners, or Denon’s self-audit?
3. **Can it prove money-path bugs** (IDOR, race, double-spend, authz) with real exploits?
4. **Should it go in CI** on every PR (their README push)?
5. **Is it safe to install** while big audits run — secrets, Docker power, telemetry?
6. **Timing** so we don’t spend money/noise before there is a live surface to attack.
7. **Cloud vs local** — app.strix.ai vs self-hosted CLI for a financial monorepo.

### Better prompt (for next chat / Denon)

> Evaluate usestrix/strix as a **phase-gated** security capability for INTAFACED (custodial money OS, doctrine §0).  
> Read source + docs, not stars. Map: mechanism, sandbox power, cost, telemetry, false-positive posture, overlap with our L0 scanners (brand/custody/DoD + planned Semgrep/gitleaks) and multi-agent audits.  
> Answer only: (1) adopt / park / cut, (2) earliest phase it earns its keep, (3) exact first-run shape (target, mode, budget, telemetry off, non-prod), (4) what it must never replace.  
> Do not install or run without explicit go. Do not add to CI without a separate decision.

---

## 1 · What it actually is

**Type:** Standalone CLI + Docker sandbox + multi-agent LLM orchestration.  
**Not:** an agent skill/plugin, MCP server, monorepo library, or drop-in `pnpm` gate.

**Job:** Autonomous **AI penetration testing** — agents act like a junior red team: recon → map → attack → **validate with working PoCs** → report (and optionally suggest patches).

| Piece                  | Role                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Host CLI** (`strix`) | Orchestrates scan, TUI/headless, viewer, config, LLM calls                       |
| **Root agent**         | Orchestrator only — spawns children, does not spray payloads itself              |
| **Subagents**          | Hands-on recon / exploit / validation                                            |
| **Docker sandbox**     | Kali-based image with full offensive toolkit; tools run _inside_ the container   |
| **Skills**             | Markdown playbooks (IDOR, SQLi, race conditions, OAuth, GraphQL, Next.js, …)     |
| **Tools**              | Shell, Python exploit runtime, Caido HTTP proxy, browser, reporting, agent graph |
| **Outputs**            | `strix_runs/<run>/` findings, local web viewer, optional SARIF/PDF               |

**Scan modes** (docs): quick (minutes / CI), standard (~30–60m), deep (default, 1–4h).  
**Targets:** local directory, GitHub URL, live web URL; multi-target; instruction files; PR diff-scope.

**Provenance** `[VERIFIED 2026-07-29 via GitHub API + shallow clone]`:

- Org `usestrix` (created 2024-11), homepage strix.ai
- Repo created 2025-08-05; ~45k stars, ~4.7k forks, ~640 commits, latest release **v1.4.1** (2026-07-27)
- Language: mostly Python + viewer TypeScript
- Classifier in pyproject: **Development Status :: 3 - Alpha**
- Dominant contributor: `0xallam` (~470 commits); small core + bots
- Real recent engineering (budget wrap-up, Docker sandbox, cost tracking) — not a dead star-farm husk
- Star count is still hype-inflated risk: treat **content and maturity**, not popularity

---

## 2 · How it works (mechanism, not marketing)

1. You point `--target` at code and/or a URL.
2. Host starts a **sandbox container** (`ghcr.io/usestrix/strix-sandbox`, default tag in settings `1.1.0`).
3. Local source is staged into the sandbox (symlink-safe copy; large trees need `--mount`).
4. LLM agents (vendor agent SDK + LiteLLM multi-provider router) run with a hard system prompt that:
   - Injects **system-verified authorized targets** (scope cannot be expanded by free-form chat)
   - Requires **validation with PoCs** before counting findings
   - Pushes root agent to **delegate**, not self-spray
5. Agents use real tools: nmap, nuclei, sqlmap, semgrep, gitleaks, trufflehog, ffuf, playwright/browser, Caido proxy, custom Python exploits.
6. Findings land on disk; `strix view` serves a **localhost-only** dashboard (tokened).
7. Optional: headless `-n` for CI; non-zero exit if vulns found.

**Important capability posture:** This is **offense with proof**, not static lint. It is closest to “hire a red team for a few hours” than to `pnpm scan:custody`.

---

## 3 · Security gate (static — did not install/run)

| Check                                              | Result                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provenance                                         | Real org/repo; not a typosquat `[VERIFIED]`                                                                                                                                                      |
| License                                            | Apache-2.0 `[VERIFIED]`                                                                                                                                                                          |
| Hardcoded private secrets (sk-/ghp-/AKIA patterns) | None found in source tree greps `[VERIFIED]`                                                                                                                                                     |
| `osv-scanner` on source                            | No issues reported `[VERIFIED]`                                                                                                                                                                  |
| `trivy fs`                                         | **Did not complete** (DB download blocked in environment) — residual, not “clean”                                                                                                                |
| Install path                                       | `curl \| bash` downloads **prebuilt binary** to `~/.strix/bin` + pulls sandbox image — standard supply-chain trust issue                                                                         |
| Telemetry                                          | **On by default** → PostHog + Scarf; opt out `STRIX_TELEMETRY=0`. Claimed: no code/targets/finding bodies; only OS, model, scan mode, severity counts, CWE, cost aggregates `[VERIFIED source]`  |
| Sandbox power                                      | Kali image; `pentester` has **passwordless sudo**; container gets **NET_ADMIN + NET_RAW**; `host.docker.internal` for host-served apps; optional unbounded resources unless you set mem/CPU caps |
| Capability vs purpose                              | Matches claim (offensive testing). High power is intentional, not sneaky.                                                                                                                        |

**Security verdict:** 🟡 **Caution — legitimate offensive tool, not malware-shaped.**  
Safe only if: you own the target, telemetry off for sensitive work, budget caps, non-prod, and you accept Docker + binary/image supply chain (prefer pinned version / build from source for anything serious).

**Residual risk this check cannot kill:** novel malice in prebuilt binary/image; LLM exfil via model provider when source is in context; agent mistakes that hit the wrong host if scope is set carelessly; dependency vulns trivy never scanned.

---

## 4 · What INTAFACED already has vs what Strix adds

| Need                                                         | Already (or planned in audit V2)                                             | Strix                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Doctrine hard bans (money type, ledger only, brand, custody) | `pnpm verify`, brand/custody/DoD scanners; planned Semgrep L0                | **No** — does not know §0                                                     |
| Secrets in repo                                              | Planned gitleaks/trufflehog L12                                              | Can run those tools _as a side effect_ of a pentest agent — non-deterministic |
| Code-level vuln patterns                                     | Multi-agent audits, critic, maker-checker                                    | Partial SAST (semgrep in sandbox) then **dynamic try**                        |
| Authz / IDOR / race / business logic **with exploit proof**  | Weak today without a live surface; property tests + concurrent smoke planned | **Core strength** once something is listening                                 |
| CI gate every PR                                             | brand/custody/DoD                                                            | Possible but costly, flaky, wrong owner of “law”                              |
| Live production pentest                                      | Explicitly forbidden in residual audit                                       | Dangerous if pointed there                                                    |

**Overlap finding `[JUDGMENT]`:** Strix **does not replace** doctrine scanners or audit waves. It **complements** them only when there is a running app to abuse. Using it now as “another audit brain on the monorepo” mostly duplicates expensive LLM reading you already pay for — with more blast radius.

---

## 5 · Fit for INTAFACED (the three questions)

### 5.1 Should we use it on INTAFACED?

**Yes — later, as a specialized layer. No — as core process or CI law.**

Reasons for eventual yes:

- Product is a **financial OS** (custodial Fiat plane). When APIs exist, classic web vulns + money-path business logic matter more than star-count tooling.
- Strix’s skill set (IDOR, race conditions, authz, JWT, mass assignment, business logic) maps to real loss classes.
- PoC-or-bust posture is the right bar for “is this actually open?”

Reasons it must not become the spine:

- Alpha product; young repo; binary install + fat Kali image.
- Non-deterministic LLM cost and findings — cannot be Definition of Done.
- Does not encode doctrine §0 (ledger recipes, decimal money, brand).
- Your own audit meta already rejected wild auto-pentest until deploy plane.

### 5.2 Can we use it right now?

**Technically:** if Docker is running and you have an LLM API key, the tool can start.  
**Practically for INTAFACED today: no meaningful go.**

Why “not now”:

1. **No product surface** — routers not mounted; not a live API (START-HERE). White-box-only on a huge monorepo is a expensive SAST-ish agent you already approximate with audits + planned Semgrep.
2. **Parallel audit chats** — adding a red-team agent now creates noise, secret risk, and git/docs collision without blocking P0.
3. **Cost** — deep multi-agent runs burn serious LLM $; default deep mode is hours.
4. **Risk** — sandbox can reach host via `host.docker.internal`; monorepo may hold env/secrets; default telemetry on; install mutates shell PATH.
5. **Wrong gate** — putting it in CI today fails the “deterministic law” standard of brand/custody/DoD.

If someone insists on a “can we?” smoke: only with explicit go, telemetry off, max budget, **local throwaway target** or a **disposable fork without secrets** — not main monorepo as live target, not production, not while the big audit is mid-flight.

### 5.3 Should we use it later in the phase?

**Yes. Earliest earning phase:**

| Milestone                                           | Strix role                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Now** (Phase 0–2 code on main, routers unmounted) | **Park.** Prefer L0 machine scanners + audit program.                                                       |
| **P0-1 routers mounted** + local `platform:up`      | Optional **one** white-box+grey-box run on **local stack only**, instruction-focused on authz/money routes. |
| **Staging / non-prod deploy**                       | **Primary window.** Grey-box with test credentials; deep or standard; budget-capped; report → fix tickets.  |
| **Pre go-live**                                     | Repeat on staging; never as sole evidence of safety.                                                        |
| **Production**                                      | **No autonomous Strix** without a formal pentest engagement, written scope, and human red-team ownership.   |

Reopen condition (concrete):

> Staging URL (or local compose with mounted routers) exists, test users exist, secrets are not in the target tree, and Nitro/Denon give an explicit “run Strix” go with budget ceiling.

---

## 6 · If/when you run it — safe shape (do not run yet)

```text
# Preconditions: non-prod target only · Docker up · no prod credentials
export STRIX_TELEMETRY=0
export STRIX_LLM="…"          # strong model; this is judgment-heavy work
export LLM_API_KEY="…"
export STRIX_SANDBOX_MEM_LIMIT=4g   # example cap
# optional: STRIX_DOCKER_SANDBOX_NETWORK=… if you need isolation

strix -n \
  --target <STAGING_OR_LOCAL_APP_URL> \
  --target <path-to-relevant-services-only> \   # not entire monorepo first time
  --scan-mode standard \
  --instruction-file ./strix-roe.md \            # rules of engagement
  --max-budget <USD>                             # if supported in your version; else watch cost
```

**Rules of engagement file should say:**

- In-scope hosts only
- Test accounts only
- No production, no mainnet, no real user data
- Focus: authz/IDOR, race on withdraw/hold, session/JWT, admin vertical privilege
- Do not DDoS, do not destroy data outside test fixtures
- Stop and report if out-of-scope asset discovered

**Never:**

- Point at production
- Put LLM keys or prod secrets in the sandbox workspace
- Make Strix a required CI check before doctrine scanners are solid
- Trust “0 findings” as “safe to hold customer money”

---

## 7 · Cloud platform (app.strix.ai)

Managed SaaS: connect repos/domains, continuous pentest, autofix PRs.  
For INTAFACED: **default no** until legal/security review — source and findings leave your machine; financial monorepo + third-party red-team SaaS is a separate decision from local CLI. Local CLI with telemetry off is the only shape worth considering first.

---

## 8 · Cost / heaviness bill

| Item                       | Note                                            |
| -------------------------- | ----------------------------------------------- |
| Always-on in coding agents | **None** — not a skill/MCP                      |
| Host install               | Binary + PATH under `~/.strix`                  |
| Docker image               | Large Kali toolkit image; first pull heavy      |
| Per run                    | LLM tokens dominate (multi-agent, deep default) |
| CI every PR                | High $ + flaky + slow — reject as law           |
| Update story               | Fast-moving (1.2→1.4 in days); pin versions     |

---

## 9 · Ranked options

1. **PARK (recommended)** — Record decision; continue audit L0 + money residual; revisit at staging.
2. **Deferred pilot** — After `platform:up` / staging: one standard run, instruction-scoped, telemetry off, budget cap; human triages PoCs.
3. **Cut** — Only if you will always buy human pentesters and never want automated exploit validation (premature; tool is real).
4. **Install into CI now** — **Reject.** Wrong phase, wrong determinism model, cost/noise.

---

## 10 · Alignment with existing INTAFACED docs

Already decided (do not reverse without new evidence):

| Doc                                                     | Line                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md` | STRX / auto-pentest agents — **out of scope until deploy plane**          |
| `docs/AUDIT-V2-RESIDUAL-AND-STRESS-2026-07-29.md`       | Live AI pentest (STRX-class) — only with explicit Nitro go + **non-prod** |
| `docs/HANDOVER-AUDIT-V2-PASTE.md`                       | Live pentest against production — out                                     |

This assessment **confirms** those lines with mechanism-level evidence. It does not open a new “install now” path.

---

## 11 · Confidence & audit scope

| Claim class                                                                            | Basis                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Repo structure, version, sandbox design, telemetry fields, install script, skills list | Read from GitHub + shallow clone 2026-07-29        |
| Fit for INTAFACED phase                                                                | Cross-check START-HERE + audit meta docs           |
| “Would catch money bugs in practice”                                                   | Judgment — not run on this codebase                |
| Trivy clean                                                                            | **Not verified** (scanner DB failed)               |
| Star quality                                                                           | Hype-skepticism applied; not used as quality proof |

**Read:** README, pyproject, install.sh, Dockerfile, docker_client, runner, hooks, settings, system prompt, telemetry, docs (sandbox, scan modes, tools), skills inventory, audit residual/meta.  
**Skipped:** executing Strix, full dependency CVE deep-dive, reverse-engineering prebuilt release binary, reading every skill file end-to-end.

**Residual risk line:** Static review of a real offensive framework is not a guarantee of safety when run; the run itself is the risk surface (LLM + Docker + target). Do not treat this doc as permission to install.

---

## 12 · Decision stamp (fill when Nitro decides)

- [ ] PARK until staging (recommended default)
- [ ] Schedule pilot at: ******\_\_\_******
- [ ] Cut
- [ ] Other: ******\_\_\_******

Date / who: ******\_\_\_******
