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

- **unbuilt**: the step has no passing result in any run in `runsRead`. That is every completed run on `main` in its range that was not cancelled; a cancelled run was replaced by a later push and has no results, and `noReport` names the few whose report had expired.
- **regression**: the step passed on `main` before. It is allowed only for a step that is not money and is named by an open regression issue whose state line is `parked` with a blocker (above). The entry names that issue.

**Money.** A step is money when any of its slices (`steps[].slices` in `docs/roadmap/journeys.json`) has a `touches` entry in `docs/roadmap/slices.json` naming a package that depends on `@intafaced/ledger-client`. The dependency test is `dependsOnLedgerClient` in `tooling/ci/review-marker.mjs`: any of dependencies, devDependencies, peerDependencies or optionalDependencies. A touch maps to a package folder this way: `svc-<x>` is `services/svc-<x>`, `packages/<x>` is itself, `customer: …` is `apps/customer`, and `admin: …` is `apps/admin`. A touch with no `package.json` (four today, such as `packages/stealth`) depends on nothing yet, so it is not money. A step missing from `journeys.json` counts as money. `moneyRuleAt` names the commit the rule was computed on, and `moneyPackages` lists every package whose manifest depends on `@intafaced/ledger-client` there, whether or not a slice touches it. A reader recomputes `money` and refuses an entry where the two disagree. A money step may be in `steps` only as `unbuilt`.

**`notBaselined`** lists the steps that failed in the named run but may not be baselined. These are money steps that passed on `main` before, and steps with no open issue that carries a state. They are listed so a reader can see them, and they count as failing until they pass.

The file is rewritten only from a finished run on `main`, by a PR that names the run. A step that has passed on `main` is never added as `unbuilt`, because that would hide a regression.
