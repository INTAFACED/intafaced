# Runbook: the state of a regression issue on main

**Who writes it:** whoever fixes, reverts or parks a regression issue. **Who reads it:** people, and scripts through the GitHub REST API (the finish plan's `ready` check, which lives in the project's planning repository, not here). **Since:** 1 Nov 2026 (W9 of the finish plan).

## Which issues

A regression issue is an issue whose title starts with `Journey broken on main: ` or `Broken on main: `. These are the titles Main trust opens (`tooling/ci/post-merge-trust.mjs`). An issue opened by hand about a red on `main` counts too, if the reading script lists it.

Count each issue once, by its number. The REST issues list also returns pull requests (an item with a `pull_request` key), so skip those. Paginated reads can return one issue on two pages; count it once and report the duplicate.

## The state line

Each regression issue carries its state as one line, on a line of its own, in a comment on the issue:

```
Regression state: fixed <the PR, and the main run that passed it>
Regression state: reverted <the revert PR>
Regression state: parked — <the named blocker>
```

- **parked** is the default while building is paused. The blocker names what is missing, in words a person can check: the unbuilt part, the owner decision, or the stack profile. Add the lane that picks it up. A `parked` line with no blocker after the dash is no state.
- **fixed** and **reverted** are written only once a finished run on `main` has passed what the issue names, and that run is named on the line. Then the issue is closed, if Main trust has not closed it already (it closes a journey issue once every step it names passes again). A fix that is merged but not yet proved on `main` leaves the issue parked or unstated.
- A later line replaces an earlier one. When a lane resumes a parked issue and fixes it, it writes a new `fixed` line.
- When a break comes back after its issue closed, Main trust opens a new issue. That is a new regression, and it needs its own line.

There is no label. The blocker is free text, which a label can't hold, and one place for the state can't disagree with a second one.

## Reading it

1. List the issue's comments, oldest first (`GET /repos/INTAFACED/intafaced/issues/<n>/comments?per_page=100`, every page).
2. Keep only comments whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. The repository is public, so anyone else can comment, and their line counts for nothing.
3. In each kept comment, remove every `\r`, skip the lines inside fenced code blocks (between lines starting with three backticks), and take the first remaining line that matches `^Regression state: (fixed|reverted|parked)\b`. That is the comment's state.
4. The newest such comment is the issue's state. For `parked`, the blocker is what follows the dash: the line must match `^Regression state: parked\s+[—–-]+\s*(\S.*)$` (an em dash, an en dash or a hyphen are all accepted).
5. An open issue with no state line, or with a `parked` line that has no blocker, has no state.

Example, from #7034:

```
Regression state: parked — J-portfolio-03 #1 is BLOCKED convert_kind: svc-bank has no convert activity kind. Lane B8.
```

## The journeys baseline

The Real-app journeys run on `main` runs every written step, built or not, so it is never fully green while building is paused. [`journey-baseline.json`](journey-baseline.json) lists the steps that may fail on `main`, from one finished run that it names. Main counts as healthy when CI and Customer Money browser checks are green on `main`, and the newest finished Real-app journeys run has no failing step outside the baseline's `steps`. Any new failure is red, and so is a step that passed in the named run and is skipped or missing in a later one. So is any failing money step, unless the baseline lists it as unbuilt (the lead's bar, 1 Nov 2026, project-state #926 change 1).

A step is keyed `J-<module>-NN#<n>`, as Main trust keys it (`stepStates` in `tooling/ci/post-merge-trust.mjs`); `file` is the file of the test that failed in the named run (a journey can span several files). Each entry in `steps` has a `state`:

- **unbuilt**: the step has no passing result in any run in `runsRead`. That is every completed run on `main` in its range that was not cancelled; a cancelled run was replaced by a later push and has no results, and `noReport` names the few whose report had expired. A step whose test is ahead of the code (below) is unbuilt too.
- **regression**: the step passed on `main` before. It is allowed only for a step that is not money and is named by an open regression issue whose state line is `parked` with a blocker (above). The entry names that issue.

**Money.** A step is money when any of its slices (`steps[].slices` in `docs/roadmap/journeys.json`) has a `touches` entry in `docs/roadmap/slices.json` naming `packages/ledger-client` or a package that depends on it, which is AGENTS.md's money code. `packages/ledger-client` is money by name, since it does not depend on itself; for every other package the dependency test is `dependsOnLedgerClient` in `tooling/ci/review-marker.mjs`: any of dependencies, devDependencies, peerDependencies or optionalDependencies. A touch maps to a package folder this way: `svc-<x>` is `services/svc-<x>`, `packages/<x>` is itself, `customer: …` is `apps/customer`, and `admin: …` is `apps/admin`. A touch with no `package.json` (four today, such as `packages/stealth`) depends on nothing yet, so it is not money. A step missing from `journeys.json` counts as money. `moneyRuleAt` names the commit the rule was computed on, and `moneyPackages` lists `packages/ledger-client` and every package whose manifest depends on `@intafaced/ledger-client` there, whether or not a slice touches it. A step with no slice is not money. A reader recomputes `money` and refuses an entry where the two disagree. A money step may be in `steps` only as `unbuilt`, which includes a step whose test is ahead of the code (below).

**Test ahead of code.** A step counts as unbuilt when its current test has never passed on `main`. Its current test dates from the last commit that made that step stricter, so a pass of an earlier, weaker test proved a smaller claim (the lead's calls of 1 Nov 2026, 11:00 and 11:04 UTC, adopting W9's recommendation). Such an entry carries these fields, and a reader checks each one:

1. `strengthenedBy`: the full 40-character sha of the last commit that made the step stricter. That commit must be on `main` and must change the entry's `file`. The entry also names the step's `blocker` and `lane`.
2. **Product code** is any file under `apps/`, `services/` or `packages/` that matches none of `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/testing/**`, `**/*.test.*`, `**/*.spec.*`, `**/*.pw.mjs` and `**/*.journey.ts`. Anything else (`tooling/`, `docs/`, `modules/`) is not product code. The reader reads the commit's files from `GET /repos/INTAFACED/intafaced/commits/<sha>`.
3. `priorTestProof`: required only when the `strengthenedBy` commit contains product code. It shows that the product did not break, because the step's test as it stood just before that commit passes on current `main`. Its fields are `{ "mainSha": <the 40-character sha of main the weaker test ran against>, "command": <the exact command>, "log": <the repository path of the saved output> }`. The log is committed with the baseline, in [`journey-baseline-proof/`](journey-baseline-proof/), and starts with the commit the weaker test came from. If the weaker test fails there, the step is a real regression, so it is fixed or reverted, never baselined.
4. For every entry: no completed run on `main` from `strengthenedBy` on passed the step. A pass ends the rule for that step: from then on, a failure is a regression.
5. The issue stays open, and its state line is `parked`, in this form: `Regression state: parked — test ahead of code: <strengthenedBy> (#<pr>) made <step> stricter; <blocker>. Lane <lane>.`

**`notBaselined`** lists the steps that failed in the named run but may not be baselined. These are money steps that passed on `main` before (unless their test is ahead of the code), and steps with no open issue that carries a state. These steps are listed so a reader can see them, and they count as failing until they pass.

The file is rewritten only from a finished run on `main`, by a PR that names the run. A step that has passed on `main` is never added as `unbuilt`, because that would hide a regression. The one exception is a step whose test is ahead of the code, as defined above.
