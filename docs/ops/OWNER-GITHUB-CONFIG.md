> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](../archive/GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Owner GitHub config — the five settings only an admin can change

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Current merge policy (2026-10-11):** follow [`AGENTS.md`](../../AGENTS.md). Merging follows the merge rule in AGENTS.md (merge check plus review of the exact head). Honor the actual required protection checks; the current branch summary requires `Gitleaks` and `Dependency audit`. Do not add full-suite checks, required human approvals, or an up-to-date-before-merge rule as part of this transition. Nitro decides live launches. The settings proposals and snapshots below are historical; their broader CI requirements do not override this policy.

**Optional owner setup tool:** agents must not run `tooling/scripts/setup-github.mjs`. Its proposed defaults now match this policy: `Gitleaks` and `Dependency audit`, zero required human approvals, and no up-to-date requirement. These defaults do not establish the live review or strictness settings. The setup, issue-sync, and swarm helpers stop their process on an explicit HTTP 403 or 429 before any permissive fallback can continue making requests. This is not a shared cross-agent request queue. Read current settings through permitted endpoints; do not use a 404 as proof that protection is absent or request extra admin access to avoid a failed check.

**Home for these findings.** They were queued 2026-08-04 inside `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md`, a campaign file that is otherwise dead. They are not campaign artifacts — they are standing repo-security facts, and they outlived the campaign. Moved here 2026-08-07.

**Who can act:** `Phantom-X-007` is the only `admin`. `ZenYoda3` and `shehzad002` have `write`. No agent can change any of this. **Do not** `PUT` protection, `PATCH` the repo, or run `tooling/scripts/setup-github.mjs` from an agent session.

**What changed since these were filed:** the repo went **public**. Every "needs GitHub Pro" blocker below was priced for a private repo and is now **free**. G1–G3 are still three admin clicks (G1 is no longer a 404 — the remaining clicks **strengthen** the thin rule).

**Live 2026-08-23** (`gh api`, identity with `write`; **no settings written**): `visibility=public` · `allow_auto_merge=false` · squash-only + delete-on-merge on · **`GET …/branches/main/protection` → 404** · `rulesets` → `[]` · collaborators Phantom **admin** / shehzad002 **write** / ZenYoda3 **write**. The 2026-08-15 “protection 200” snapshot **did not hold**. G1 is again “no rule on `main`”. Re-derive before clicking.

Re-derive before acting — do not trust this table's live column:

```
gh repo view --json visibility,isPrivate
gh api /repos/Phantom-X-007/intafaced --jq "{allow_auto_merge,allow_squash_merge,allow_merge_commit,delete_branch_on_merge}"
gh api /repos/Phantom-X-007/intafaced/branches/main/protection
gh api /repos/Phantom-X-007/intafaced/branches/main/protection/required_pull_request_reviews
gh api /repos/Phantom-X-007/intafaced/rulesets
gh api /repos/Phantom-X-007/intafaced/codeowners/errors
gh api /repos/Phantom-X-007/intafaced/collaborators --jq '.[] | "\(.login) \(.role_name)"'
```

| ID     | Finding                                                                                                                                                                                                                                  | State when filed (2026-08-04)                                  | Verified 2026-08-07                                                                         | Live 2026-08-15 (`gh api`, identity `Phantom-X-007`, **no settings written**)                                                                                                                                                          | Action                                                                                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | **`main` protection exists but is thin.** Force-push is already off for the rule. Admins can still bypass. CI merge gates are not the required checks. A **1-review** requirement (if still on) is a human bottleneck — turn it **off**. | `protection` → 404; `rulesets` → 403 _"Upgrade to GitHub Pro"_ | **Still 404.** Rulesets returned `[]`, not 403 — paywall gone with public switch            | Re-derive before clicking. 2026-08-15 snapshot: protection **200**, required checks = `Gitleaks` + `Dependency audit` only, `required_approving_review_count` = **1**, `require_code_owner_reviews` = **false**, `strict` = **false**. | Click 1 — require **CI job names** (`Doctrine gates`, `Typecheck & build`, `Tests` until shards land then `CI merge seal`, keep Gitleaks + Dependency audit). **Required approving reviews = 0.** Do **not** require “up to date before merge”. Force-push off. Optionally include admins so red cannot be bypassed. |
| **G2** | **CODEOWNERS is still advisory.** The file is valid; GitHub does not require a code-owner review to merge money or chain paths.                                                                                                          | Blocked on Pro                                                 | `codeowners/errors` → `[]` (file correct); unenforceable because G1 was unset               | `GET …/codeowners/errors` → `{ "errors": [] }`. `require_code_owner_reviews` = **false**.                                                                                                                                              | **Leave advisory.** Requiring owners waits on Nitro/Denon and re-creates the bottleneck. Review pings stay; merge does not.                                                                                                                                                                                          |
| **G3** | **`allow_auto_merge: false`.** Agents poll CI and merge by hand instead of queueing.                                                                                                                                                     | admin toggle                                                   | **Still `false`**                                                                           | `GET /repos/Phantom-X-007/intafaced` → `allow_auto_merge` **false**; `allow_squash_merge` **true**; `allow_merge_commit` **false**; `delete_branch_on_merge` **true**.                                                                 | Click 3 — enable auto-merge. Squash-only and auto-delete already on.                                                                                                                                                                                                                                                 |
| **G4** | **Nothing verified `main` after a merge.** `ci.yml` had no `push: main` trigger — removed as a thrift measure citing a 2,000-minute monthly pool.                                                                                        | private repo, metered                                          | **Actions are free** on public repos (standard runners). Budget it protected does not exist | Unchanged — workflow trigger is code, not an admin toggle. No owner click.                                                                                                                                                             | **DONE 2026-08-07** — `push: main` restored on `ci.yml`, thrift law deleted. No owner action needed                                                                                                                                                                                                                  |
| **G5** | **`ZenYoda3` is a shared identity.** Nitro-the-operator and his agent swarm commit as the same GitHub user, so **no ownership rule is mechanically attributable to a person.**                                                           | structural                                                     | Unchanged                                                                                   | Unchanged. Structural; not a settings click.                                                                                                                                                                                           | Structural. Do not "fix" in agents. Decide deliberately: a separate machine account for the swarm, or accept that authorship is not evidence                                                                                                                                                                         |

## Three clicks for `Phantom-X-007` (G1 / G3 — G2 stays off)

Agents cannot click these. Do not run `setup-github.mjs` unless you intend to write admin settings yourself. Re-derive live settings first (commands at the top).

1. **G1 — Settings → Branches → `main` rule.** Require status checks: **Doctrine gates**, **Typecheck & build**, **Tests** (swap to **CI merge seal** after named shards land), **Gitleaks**, **Dependency audit**. Set **required approving reviews = 0**. Do **not** require code owners. Do **not** require “up to date before merging” (rebase-wait is the old slowdown; `push:main` is the trunk seal). Force-push off. Optionally: do not allow bypassing (include administrators) so red cannot be admin-merged.
2. **G2 — leave CODEOWNERS advisory.** A required owner review waits on Nitro or Denon. The file already pings; that is enough.
3. **G3 — Settings → General → Pull Requests.** Enable **Allow auto-merge**. Squash-only and auto-delete are already on.

## Why G5 is the one worth thinking about

G1–G4 are settings. G5 is not.

Every ownership rule in this repo — the class matrix, the lane split, the human locks — assumes you can tell who did something. On the git record you cannot: 692 of the last 877 commits are authored `Nitro`, and Nitro does not type git commands. That means the entire coordination layer is enforcing a distinction the machine cannot see.

This does not need fixing today, and a machine account has its own costs. But it should be a decision rather than an accident, because it silently sets the ceiling on how much any ownership rule can ever be worth.

## G5 decision frame (2026-08-15)

**Tracker:** `GH-G5`. **Not an agent fix.** Agents do **not** create GitHub users, do **not** mint a second `write` collaborator, and do **not** seal this row by shipping prose. Denon already labelled G5 **structural** (table Action). This section prices the two options so the ceiling is chosen, not inherited.

**What the git record actually is.** `ZenYoda3` is one GitHub user with `write`. Nitro-the-operator and the Nitro agent swarm both push as that user. Commit author `Nitro` is therefore **not** evidence that a person typed the command. LIVE-LANES, the class matrix, and human locks still bind as **process** law. They are not mechanically recoverable from `git log` / GitHub blame.

**What a machine account would actually buy.** A second identity on the collaborators list, used only by swarm tokens, so later commits split “this PAT” vs “that PAT”. It does **not** prove a human sat at the keyboard: whoever holds either token can still push. Person-attribution stays a social fact. The machine only sees two logins.

### Option A — swarm machine account

A separate GitHub user (human-created, admin-invited) holds the swarm `GH_TOKEN`. `ZenYoda3` stays Nitro-the-operator.

| Cost             | Why it bites                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin act        | Someone must create the user, invite `write`, rotate tokens, and keep the split. Agents are forbidden to do that.                                                   |
| Secret sprawl    | Two PATs, two agent-auth files, two failure modes. A leaked swarm token is still `write` on a public money repo.                                                    |
| False confidence | CODEOWNERS / required reviewers still cannot tell “Nitro typed this” vs “Nitro’s laptop ran the agent”. Authorship becomes _token_ evidence, not _person_ evidence. |
| Process rewrite  | Every Nitro agent prompt, `gh` helper, and merge path must refuse `ZenYoda3`. One missed export and the split is theatre.                                           |
| Blame noise      | History before the cut stays mixed. Reviews that treat author as owner will still misread the old majority of commits.                                              |

Pick A only if Denon wants GitHub rails (after G1) to _treat swarm pushes as a distinct login_ — for example required-reviewer rules that exclude the swarm identity. That is an admin follow-on, not this docs PR.

### Option B — accept the authorship ceiling

Keep `ZenYoda3` as the shared Nitro write identity. Treat `git` author / GitHub user as **not evidence** of a person. Enforce who-coded-what in LIVE-LANES + tracker owner + PR body, the same way the repo already does.

| Cost                  | Why it bites                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mechanical ceiling    | No ownership rule that needs “this commit was a human” can ever be proven from git. That is the ceiling, stated.             |
| Audit stories         | External readers will keep counting “Nitro authored N commits” and be wrong. Correct them in prose; do not invent a git fix. |
| G1 still matters more | Branch protection and required checks constrain _what_ can land, not _which person_ landed it. G5 does not unblock G1.       |

This matches the table’s existing Action: structural; do not “fix” in agents.

### Recommendation (not a seal)

**Accept Option B** as the working default.

Denon already called G5 structural. Sealing Option A without an admin-created account would be a silent pick plus an incomplete act. Option A’s extra login does not restore person-attribution; it adds token hygiene and a second `write` seat for a distinction the coordination layer already stores off-git.

`GH-G5` stays **open** in `docs/ops/owner-ruling-packet.json` until Denon seals B (or explicitly orders A and a human creates the account). Agents continue: no GitHub user create; no G1–G4 live-column refresh here (P4-03 sibling).

## Related

- `docs/NITRO-DENON-OPS-REDESIGN-AUDIT-2026-08-07.md` §7 Rule 2 — why enforcing the money boundary in GitHub replaces the largest body of prose law.
- `tooling/scripts/setup-github.mjs` — exists, needs admin; agents must not run it.
