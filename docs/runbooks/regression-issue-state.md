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
