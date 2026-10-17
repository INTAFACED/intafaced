# Collab audit — 2 vibe-coders on intafaced

**Audience:** Nitro + Denon  
**Date:** 2026-07-27  
**Status:** decision record — how we work, what is actually on, what to ignore for now  
**Claim tags:** `[VERIFIED 2026-07-27]` = checked live this session · `[ASSUMED]` = not re-checked

---

## Verdict (one paragraph)

Your research is right and is already the law of this repo in `CONTRIBUTING.md`. Denon mostly enabled what Free GitHub allows; **real branch protection (required PR + required CI + required approval) is not on** because the repo is private on Free — that is a GitHub plan limit, not a missed setting. Denon’s “name files so the router picks them up” is **only needed for the Next.js web app** (`apps/web`); **backend services use explicit tRPC routers**, so inventing a second auto-routing rule would be over-engineering. The highest-leverage fix right now is not more process — it is **actually reviewing each other’s PRs** (zero human reviews found on merged work) and **keeping PRs small**.

---

## Glossary (plain language)

| Term                     | What it means for you                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Repo**                 | The one shared project folder on GitHub. Yours: `Phantom-X-007/intafaced`.                                           |
| **main**                 | The official branch. Always supposed to be safe to run.                                                              |
| **Branch**               | A named side copy of the code for one piece of work.                                                                 |
| **Feature branch**       | Short-lived branch for one change. Delete after merge.                                                               |
| **GitHub Flow**          | Only model: branch → PR → review → merge to `main`. No long “develop” branch.                                        |
| **PR (pull request)**    | A proposal: “please put my branch into main.” Coordination + review live here.                                       |
| **Merge**                | Accept the PR into `main`. This repo: **squash** = one clean commit per PR.                                          |
| **Worktree**             | A second folder of the same repo on a different branch. Lets you (or an AI) work without stepping on another branch. |
| **Branch protection**    | GitHub server rule: blocks push to `main`, can require reviews + green CI.                                           |
| **CI (Actions)**         | Robots that run lint/typecheck/tests on every PR.                                                                    |
| **CODEOWNERS**           | File that auto-requests review from named people when paths change. On Free it _asks_; it does not _block_ merge.    |
| **Router**               | The map from “URL or API name” → “which code runs.”                                                                  |
| **tRPC**                 | How backend services expose APIs here. You **register** procedures in `router.ts` by hand.                           |
| **App Router (Next.js)** | How `apps/web` maps folders to URLs. **Folder path = URL.**                                                          |
| **Contracts**            | Shared API shapes in `packages/contracts`. Change the contract in its own PR before implementing it.                 |

---

## Your research checklist vs live repo

Canonical rules already live in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Do not invent a second collab doc that duplicates them.

| Research item                           | Live status `[VERIFIED 2026-07-27]` | Notes                                                                                                                       |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| One repo, GitHub Flow only              | **Yes**                             | Documented + practiced (PRs #1–#3, #24 merged; #25–#27 open).                                                               |
| `main` always deployable                | **Intent yes**                      | Discipline + CI. Not server-enforced.                                                                                       |
| Short-lived feature branch → PR → merge | **Yes in process**                  | Branches: `feat/web-shell`, `feat/matching-engine`, `feat/admin-console`, `feat/i18n-scaffold`, `fix/config-operator-gaps`. |
| Never long-lived branches               | **Policy yes**                      | Enforce by habit (~2 days rule in CONTRIBUTING).                                                                            |
| Worktrees mandatory                     | **Yes tooling**                     | `pnpm wt` / `wt:list` / `wt:rm` in repo. Main checkout for pull/read only.                                                  |
| Branch protection on `main`             | **No**                              | API: protection 404; rulesets 403 “Upgrade to GitHub Pro…”.                                                                 |
| Require 1 PR approval                   | **Not enforced**                    | CODEOWNERS pings only.                                                                                                      |
| Require status checks                   | **Not enforced**                    | CI runs and reports; merge still possible on red.                                                                           |
| No direct pushes                        | **Partial**                         | Local `.githooks/pre-push` blocks `main` (bypassable with `--no-verify`). Server does not.                                  |
| Small focused PRs                       | **Policy yes · practice mixed**     | Open matching PR ~3.2k adds; web shell ~2.5k adds — too large for careful review.                                           |
| Clear PR title + description            | **Template yes**                    | `.github/pull_request_template.md` present.                                                                                 |
| Review each other                       | **Gap**                             | Merged PR #24: **zero reviews**. Open #25–#27: no reviews yet.                                                              |
| Issues only when useful                 | **Yes**                             | CONTRIBUTING §4 matches your research. Tracker is the board.                                                                |
| Simple CI: lint + typecheck + tests     | **Yes, stronger**                   | Active workflow: Doctrine gates · Typecheck & build · Tests · Definition of Done.                                           |

### What Denon _did_ enable (server-side)

`[VERIFIED 2026-07-27]` via GitHub API as collaborator:

- Private repo `Phantom-X-007/intafaced`, default branch `main`
- Collaborators: `@Phantom-X-007` (admin), `@ZenYoda3` (write)
- Squash-only merge · merge commits off · rebase off · **delete branch on merge** on
- CI workflow **CI** active
- Labels include money-path, doctrine, core, blocked-main, protocol-plane
- CODEOWNERS both handles; `codeowners/errors` → empty
- `allow_auto_merge` is **false** (setup script wanted true — minor, not required)

### What he could not enable on Free private

GitHub’s own docs (still current mid-2026): protected branches on **private** repos need **Pro / Team / Enterprise**. Free private = no enforced “require PR / require checks / require approval.” Public Free can use protection; this repo is private (correct for the product).

**Do not pay yet** unless merges start landing without review or `main` goes red from skipped CI. Discipline + the pre-push hook is enough for two people who talk daily. Pro (~$4/user/month) is the upgrade when a third person joins or trust slips once.

---

## Denon’s call — “name files so the router picks them up”

### What he meant (decoded)

When work touches **shared routing** (URLs, API entry points), name and place new files so the **existing router convention** discovers them — so you do **not** keep reopening one central “route table” and hand-wiring every new screen or endpoint.

### Critical take for _this_ codebase

| Layer                               | Does file name auto-wire?                                                          | What to do                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend `services/svc-*`**        | **No.** tRPC: you export a `router` and nest procedures in `src/router.ts`.        | Follow `tooling/agent-protocol/SERVICE_TEMPLATE.md`. One service shape: `router.ts`, `env.ts`, `db/schema.ts`, domain folders. **Do not invent file-based auto-routing for services.** |
| **`packages/contracts`**            | **No.** Explicit schemas + example router.                                         | Contract PR first, then implement.                                                                                                                                                     |
| **`apps/web` (Next.js App Router)** | **Yes.** Folder under `src/app/` **is** the URL (`app/trade/page.tsx` → `/trade`). | Name folders for the URL path. That _is_ Denon’s rule, already how Next works. No extra convention needed.                                                                             |
| **Shared packages**                 | N/A                                                                                | Export from `index.ts` as the package already does.                                                                                                                                    |

**Is it needed as a new team rule?**  
**No** — not as a third process layer. For web, Next.js already is the rule. For services, the service template already is the rule. Writing a separate “file names must correspond to the router” policy would over-engineer what the stack already forces.

**When his advice bites:** two people (or two AIs) add pages/endpoints on parallel branches and both invent different names for the same concept (`trade` vs `trading` vs `exchange`). Prevention: claim the feature in the tracker + Telegram, use the same path as the product name, open small PRs.

---

## What actually matters for you two (minimal set)

These five. Everything else is optional until it hurts.

1. **Never work in the main checkout** — `pnpm wt feat/...` then open editor + AI in that folder only.
2. **Never land work without a PR** — even “tiny” fixes.
3. **Green `pnpm verify` before you ask for review** — same checks CI runs.
4. **Review each other’s PRs before merge** — especially money paths (ledger, pay, identity auth). “Request changes” is normal.
5. **One service (or one app concern) per PR** — if the title needs “and”, split.

Already written in CONTRIBUTING. No new ceremony.

### Daily loop (both of you)

```
Telegram claim  →  pnpm tracker ready / claim in features.mjs
pnpm wt feat/<scope>-short
work only in that folder
pnpm verify
git push + gh pr create
other person reviews
squash-merge when green
pnpm wt:rm <branch>
```

Issues: only if >1 day, needs a decision, or is a bug others will hit. Else Telegram + PR.

---

## Live practice risks (more important than missing Pro)

`[VERIFIED 2026-07-27]`

1. **Self-merge without doctrine self-audit** — PR #24 authored and merged by `@Phantom-X-007`, reviews `[]`. Under asymmetric review that is allowed only with CI green + agent self-audit on money/doctrine (see `AGENTS.md`). Habit to document that audit is still thin.
2. **Oversized PRs** — matching engine and web shell are multi-thousand-line first cuts. Hard to review; easy to rubber-stamp. Prefer vertical slices (engine core + tests first; UI shell without full trade page; etc.).
3. **Parallel open work** — several feature branches at once is fine with worktrees; still claim in tracker so you don’t both build `web.shell`.
4. **Local folder name** — this machine’s clone is `Sovereign`, so worktrees resolve under `../sovereign-worktrees/…`. Onboarding paste still mentions another path; clone as `intafaced` if you want docs pathnames to match literally.
5. **You are on `main` locally with a dirty `AGENTS.md`** — do not build features here; create a worktree for any change.

---

## Research validity (still true in 2026)

| Claim                                        | Still true?                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GitHub Flow for small teams                  | Yes — still the default recommendation for small/medium teams vs classic Git Flow.                           |
| Short-lived branches + PR + protected main   | Yes — community + GitHub docs still push this for 2–3 person teams.                                          |
| Worktrees for multi-agent / AI parallel work | Yes — 2025–2026 AI workflow writeups treat worktrees as standard isolation (one agent per directory/branch). |
| Branch protection free on private repos      | **No** — still Pro/Team for private. Free only fully for public.                                             |

Your research stack is not over-engineered for two AI-heavy vibe-coders. The over-engineering risk is **adding more tools** (project boards, long branch models, custom file-routing frameworks) before the five habits above stick.

---

## Decisions (locked unless you reopen)

| #   | Decision                                                                                                                                        | Why                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Collab model = CONTRIBUTING as written (GitHub Flow + worktrees + PR review)                                                                    | Already matches research; one home for the fact.                                                                                                 |
| D2  | **Do not buy GitHub Pro yet**                                                                                                                   | Free gaps are social, not technical; upgrade when enforcement is worth $4.                                                                       |
| D3  | **No new “router file-naming” policy**                                                                                                          | Next.js path rules + service template cover it.                                                                                                  |
| D4  | Coordination = Telegram claim + tracker + PR                                                                                                    | Issues only when multi-day or decision-heavy.                                                                                                    |
| D5  | **Asymmetric review** — Denon merges on green CI + agent self-audit; Denon (or agent) reviews Nitro’s PRs. Nitro does not Approve Denon’s code. | Nitro is not a code reviewer; mutual Approve was theater. Supersedes earlier “one human Approve each way.” See `AGENTS.md` operator/Denon modes. |

---

## Gap audit — 2026-07-27 (second pass)

### Structure: already right — do not add more

These are **done enough** for two AI-heavy builders who want speed:

- GitHub Flow documented (`CONTRIBUTING.md`)
- CI full stack green on every PR
- Squash-only + delete branch on merge
- CODEOWNERS both people, zero errors
- Worktree tooling (`pnpm wt`)
- Tracker as the board (not a second project system)
- Agent hard rules (`AGENTS.md` + protocol)

**Do not add:** project boards, long-lived develop branches, custom file-routing frameworks, required Pro until a real incident, mandatory issues for every task.

### Holes that still exist (ranked)

| #   | Hole                                                                          | Blocks speed?                                        | Fix                                                                                                 |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | **Zero human reviews ever** — every merged PR self-merged by `@Phantom-X-007` | No today; yes when money/auth bugs ship              | Habit: other person Approves before merge. Free cannot enforce.                                     |
| 2   | **Only one author** — all PRs from Denon; `@ZenYoda3` has opened **none**     | Yes — not yet two-person flow                        | Nitro’s first real claim → worktree → PR this week.                                                 |
| 3   | **Huge open PRs** (2.5k–3.3k lines) with 0 reviews                            | Yes — review becomes theater                         | Prefer green small slices; for already-open big ones: skim for doctrine/money, don’t block forever. |
| 4   | **No server branch protection** (Free private)                                | Only if someone pushes `main`                        | Accept + pre-push hook; Pro later.                                                                  |
| 5   | **`pre-push` not executable** (`mode 100644` on GitHub)                       | Accidental `git push origin main` may not be blocked | `chmod +x .githooks/pre-push` and commit once.                                                      |
| 6   | **`allow_update_branch` false**                                               | Slight friction updating PRs                         | Optional: turn on in Settings → General → PRs.                                                      |
| 7   | Local clone named `Sovereign`                                                 | Path docs say `intafaced-worktrees`                  | Cosmetic; worktrees land in `sovereign-worktrees`.                                                  |

### Still needed on GitHub? Honest answer

**Almost nothing structural.**  
What is “needed” is **behavior**, not more repo settings:

1. Denon (or agent) self-audits money/doctrine before merge; Nitro’s agent can comment but is not a gate.
2. Both people open PRs (not only Denon).
3. Work only in worktrees.
4. Look at CI green before merge (not auto-enforced).

**Optional one-line repo fix (worth doing):** make `.githooks/pre-push` executable.  
**Optional QoL:** “Always suggest updating pull request branches.”  
**Defer:** GitHub Pro, Dependabot theater, auto-merge, extra labels, project boards.

### Effectiveness test

Right way **and** still fast =

```
claim → worktree → small PR → CI → other Approves → squash → delete worktree
```

Anything that adds steps without preventing a real collision (two agents same folder, broken main, unreviewed money path) is drag. The current design passes that test once the review habit exists.

---

## Optional later (not now)

- GitHub Pro → real required reviews + required checks
- `allow_auto_merge` true once checks are required
- Split large open PRs before merge if review stalls
- Fix onboarding path string if clone names keep diverging
- Dependabot / secret scanning when you want quieter dependency hygiene

---

## How to re-verify (commands)

```bash
export GH_TOKEN="$(tr -d '\n\r ' < ~/.grok/agent-auth/github_token)"
gh api repos/Phantom-X-007/intafaced/branches/main/protection   # expect 404 on Free private
gh api repos/Phantom-X-007/intafaced --jq '{allow_squash_merge, delete_branch_on_merge, private}'
gh pr list --repo Phantom-X-007/intafaced --state open
gh run list --repo Phantom-X-007/intafaced --limit 5
```

---

## Pointers

- How we collaborate: [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- Agent brief: [`AGENTS.md`](../AGENTS.md)
- Service shape: [`tooling/agent-protocol/SERVICE_TEMPLATE.md`](../tooling/agent-protocol/SERVICE_TEMPLATE.md)
- Second-dev paste: [`docs/ONBOARDING.md`](ONBOARDING.md)
- Work claim board: [`docs/TRACKER.md`](TRACKER.md) · `pnpm tracker ready`
- Plain map: [`START-HERE.md`](START-HERE.md) · session paste: [`NITRO-SESSION-PROMPT.md`](NITRO-SESSION-PROMPT.md)
- Nitro Phase 2 claim plan (session 1): [`PHASE2-NITRO-PLAN-2026-07-27.md`](PHASE2-NITRO-PLAN-2026-07-27.md)
