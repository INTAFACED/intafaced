# Board Clear — Human blockers (deferred queue)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Rule:** Append only while agent residual remains. This file **is** the Nitro inbox — do not create `docs/ops/NITRO-INBOX.md`.  
**Flush:** After AGENT-COMPLETE (all agent-owned rows Done/Cut), orchestrator finalizes this file and reports once.

**Agent residual remaining?** **Yes (partial)** — shell freeProduct often 0, but platform M1–M7 + Class X + infra blockers remain.  
**Last refresh:** 2026-08-04 (install / cost emergency).

---

**Ownership note (2026-08-04):** Shehzad is **Protocol Plane + INTACHAIN only** (THREE-WAY + GITHUB-OWNERSHIP-SHEHZAD). Pay/bank/futures/identity residual reclaimed for Nitro agents after #346 handoff. Tip law wins over stale M1–M7 rows below.

## Deferred X1–X5 (Nitro only / Denon admin)

> **MOVED 2026-08-07 → [`docs/ops/OWNER-GITHUB-CONFIG.md`](ops/OWNER-GITHUB-CONFIG.md).**
> These are standing repo-security facts, not campaign artifacts, and they outlived the campaign.
> The new home carries the current state: the repo is **public**, so the "needs GitHub Pro"
> blocker on X2/X3 is gone and four of the five are now free to fix.
> **The table below is frozen as filed on 2026-08-04. Do not act on it — act on the new home.**
>
> Note also: these `X1–X5` are **ticket IDs**, and they collide with the `X1–X5`
> **escalation classes** in `BOARD-CLEAR-DECISION-AUTHORITY.md:42-46`, where X1 means
> _production go-live / real mainnet money_. An agent escalating a genuine money event
> lands in a billing table. Use the new home's `G1–G5` for the config findings.

| ID  | Queued (UTC)      | Issue                                                                                                                                                                                                                             | Sandbox/§13 tried?                        | Status             |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------ |
| X1  | 2026-08-04T01:00Z | **Actions billing** — last 24h ~677 runs (≈90 CI + ≈582 Docs-format). `paths-ignore` moved spend, did not remove it. Issue #197 already hit ceiling once (2026-07-30). **Only Denon can see the bill.** Confirm headroom tonight. | value-gate shipping on Docs-format (#721) | OPEN — Denon       |
| X2  | 2026-08-04T01:00Z | **Branch protection on `main`** — `gh api …/protection` → 404; rulesets → 403 “Upgrade to GitHub Pro”. Any push-capable identity can force-push main. `tooling/scripts/setup-github.mjs` exists; needs admin.                     | agents cannot                             | OPEN — Denon       |
| X3  | 2026-08-04T01:00Z | **CODEOWNERS advisory only** on private repo without Pro — Shehzad money paths can merge with zero review.                                                                                                                        | agents cannot                             | OPEN — Denon       |
| X4  | 2026-08-04T01:00Z | **`allow_auto_merge: false`** — swarm polls CI and merges by hand; admin toggle.                                                                                                                                                  | agents cannot                             | OPEN — Denon       |
| X5  | 2026-08-04T01:00Z | **ZenYoda3 dual identity** — Nitro operator + swarm share one GitHub identity → no ownership rule is mechanically enforceable (same Pro/protection gap as X2). Structural; do not “fix” in agents.                                | n/a                                       | OPEN — Denon/Nitro |

---

## Mountain rows still open — with who actually owns them on tip

**This table used to read `shehzad002` on all eight rows. Six of those locks were dissolved by the 2026-08-04 law** (THREE-WAY-DISTRIBUTION §2 + GITHUB-OWNERSHIP-SHEHZAD): Shehzad is Protocol Plane + INTACHAIN only, so only the two `protocol.*` rows are still a human blocker. The prose note above said this; the table did not, and a table that contradicts the sentence above it is read as the lock. Corrected below.

| Row                        | Owner on tip                      | What’s left (honest)                                                                         | Waiting on                               |
| -------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| pay.gateway (+ expand)     | shehzad002 **until #346 handoff** | Card sandbox + KYB + durable list — PR #346 open and CONFLICTING                             | shehzad merge fix **or** handoff comment |
| protocol.smart-accounts    | **shehzad002** (chain)            | Deploy + audit package                                                                       | S-A1 — genuine human blocker             |
| protocol.amm (+ lending/…) | **shehzad002** (chain)            | After SA                                                                                     | S-A2 — genuine human blocker             |
| trade.futures              | **Nitro agents** (was M3)         | Risk/margin/liq/mark truth; unlocks B-WS-2 live positions. Implement from D-S-01, not invent | Denon spec, not a human lock             |
| trade.otc / copy / algo    | **Nitro agents** (was M4)         | Real engines. Agents must not invent mids/rates — thin §13 or from tip law                   | Denon spec, not a human lock             |
| identity sub-account money | **Nitro agents** (was M5)         | Money routing graph (UI list already shipped) + leak tests                                   | nothing — claimable                      |
| Phase 5 bank money         | **Nitro agents** (was M6)         | `bank.earn` shipped `done` 2026-08-04; cards ledger half + ramps crypto leg remain           | nothing — claimable                      |
| dual-book / Java residual  | **Nitro agents** (was M7)         | After path-clear vs Denon open custody PRs                                                   | Denon open PR file sets                  |

**Still a real human blocker on this table:** the two `protocol.*` rows, and `pay.gateway` only until #346 is finished or handed off. Everything else is agent work under Class M rigor — Class X (issuer keys, prod go-live, licence) stays Nitro human wherever it appears, which is a decision gate, not an ownership lock.

### Agent §13 residual (not a human steal)

| ID     | Row        | Socket                                                                 | Owner after |
| ------ | ---------- | ---------------------------------------------------------------------- | ----------- |
| B-WS-2 | ws.gateway | Live futures **position** private stream E2E — needs correct M3 events | M3 + agent  |

---

## Open shehzad/Denon PRs needing human eyes (snapshot)

_Re-derive with `gh pr list`. Snapshot is advisory._

| PR        | Note                                               |
| --------- | -------------------------------------------------- |
| #346      | shehzad M1 pay — **CONFLICTING**; babysit only     |
| #428      | Denon p2p instruments — open; no dual-edit         |
| #432–#448 | Denon money/config/CI residual wave — babysit only |

---

## Last flush

**2026-08-04** — Cost + protection blockers written to X1–X5 (were empty since 2026-08-02).  
Human M1–M7 still OPEN → BOARD-COMPLETE not claimed.  
Agent residual = F-STANDBY / P1–P5 ladder when freeProduct=0 — not stamp mills.

**2026-08-04 (later)** — Mountain table re-derived against the 2026-08-04 ownership law. M3–M7 are **not** human blockers and had been reading as locks for as long as the table was the only thing anyone scrolled to; X1–X5 unchanged and still Denon. Human blockers now: X1–X5, `protocol.smart-accounts`, `protocol.amm`, and `pay.gateway` until #346 resolves. BOARD-COMPLETE still not claimed.
