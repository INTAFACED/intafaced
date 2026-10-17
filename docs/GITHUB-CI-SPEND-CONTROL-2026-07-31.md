# GitHub CI spend control — RETIRED 2026-08-07

**Clarification 2026-10-09:** standard GitHub-hosted runner minutes have a zero bill on this public repo. Service limits and acceptable-use rules still apply. A 403 or 429 from GitHub is a stop; follow [`AGENT_PROTOCOL.md`](../tooling/agent-protocol/AGENT_PROTOCOL.md) §3 for cooldowns and access restrictions. Parallel pull requests and merge-when-done stay. The live external market-data smoke runs manually; operational third-party polling belongs on our own infrastructure. Do not restore `thrift-preflight`.

**Status:** **VOID. Not law. Do not follow, do not restore, do not reinvent.**  
**Was:** active operating law from 2026-07-31 to 2026-08-07.  
**This file is kept only so nobody rediscovers the problem and rebuilds the cure.**

---

## What it was

A rule set called **thrift**. It metered GitHub Actions runs and told agents to:

- batch work into fatter PRs instead of shipping one concern at a time,
- hold finished commits locally until a 24h run count "cooled",
- avoid opening PRs, avoid re-running CI, prefer docs-only PRs,
- treat run-count caps (soft ≥120 · total ≥220 · docs ≥120 · ci ≥160) as a reason to wait,
- keep `push: main` off `ci.yml` so a merge would not "double-bill",
- and, in the worst case, sit in a `THRIFT-HOLD` state instead of shipping.

It was enforced by `tooling/ci/thrift-preflight.mjs`, wired into `pnpm thrift:check`,
`.githooks/pre-push`, and `tooling/scripts/agent-pr.mjs`.

## Why it existed

The repo was **private**. GitHub Actions on a private repo bills the owner after a free
monthly pool of ~2,000 minutes, and in July 2026 that pool ran out during a two-agent
push/cancel thrash window. The spend was real and the owner could see it on a bill.

## Why it is void

**The repo is public.** Standard GitHub-hosted runner minutes are **free for public
repositories** — those minutes have no overage bill. Service limits and acceptable-use
rules still apply. Every spend rule above was buying something that now costs nothing,
and it was buying it with the only currency that matters here: shipped work.
Thrift's real cost was measured — a spend meter dressed as
a correctness gate made agents stop shipping (see the "WHY WARN BEFORE BLOCK" note in
`tooling/ci/value-gate.mjs`).

Removed **2026-08-07**: the preflight script, both package scripts, the `gates.mjs` entry,
the `pre-push` block, the `agent-pr.mjs` call, the `swarm.mjs` reporting, and the throttling
prose in every law doc. `push: main` was restored on `ci.yml` the same day.

## The one legitimate concern, and what handles it now

Thrift was right about exactly one thing: a **PR** push storm should not stack ten redundant
runs of the same branch. That is handled by
**`concurrency: … cancel-in-progress: true` on pull_request refs** — a new push to the same
PR cancels the superseded run. No policy, no meter, no human judgement.

**Update 2026-08-09 (not thrift):** on `main`, `ci.yml` sets **`cancel-in-progress` false**.
Under swarm merge bursts, cancelling unfinished trunk runs left almost no finished green/red
signal on intermediate tips (measured ~95% cancelled). Actions are free on this public repo;
finishing every main run is the point of `push:main`. See `ci.yml` concurrency comments and
`CONTRIBUTING.md` §1.

Two habits also survived thrift's deletion, for reasons that were never about money:

| Habit                              | Real reason                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| `pnpm verify` green before pushing | Local is seconds; a CI round trip is minutes. Fast feedback. |
| One service / one concern per PR   | Reviewability (CONTRIBUTING §15.1). Not batching.            |

Note the second one **inverts** thrift's advice: thrift said make PRs fatter to spend fewer
runs. That reason is gone. Small PRs get real reviews.

## If someone proposes bringing it back

A spend budget would need a new billing reason, such as going **private again** or choosing
billable runners. Visibility is a business/IP decision owned by Nitro and Denon — agents
never flip it. While standard runner minutes stay free, keep parallel pull requests and
merge-when-done; the old run-count meter stays deleted.

Rate-limit cooldowns and access restrictions still apply. A 403 or 429 stops GitHub activity;
report the response and keep independent local work moving. Actions must serve the repository's
development, testing, deployment, or publication. Use our own infrastructure for operational
third-party polling. Neither repeated refusals nor a third-party cron is a reason to restore thrift.

Live CI law: [`../AGENTS.md`](../AGENTS.md) · [`../CONTRIBUTING.md`](../CONTRIBUTING.md) ·
[`ops/SWARM-MANDATE.md`](ops/SWARM-MANDATE.md).
