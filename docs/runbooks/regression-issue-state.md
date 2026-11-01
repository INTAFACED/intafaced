# Runbook: the state of a regression issue on main

**Who writes it:** whoever fixes, reverts or parks a regression issue. **Who reads it:** people, and scripts (for example the finish plan's `ready` check) through the GitHub REST API. **Since:** 1 Nov 2026 (W9 of the finish plan).

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
- **fixed** and **reverted** come with the issue closed. Main trust also closes a journey issue by itself once every step it names passes again.
- A later line replaces an earlier one. When a lane resumes a parked issue and fixes it, it writes a new `fixed` line.

There is no label. The blocker is free text, which a label can't hold, and one place for the state can't disagree with a second one.

## Reading it

1. List the issue's comments, oldest first (`GET /repos/INTAFACED/intafaced/issues/<n>/comments?per_page=100`, every page).
2. Keep only comments whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. The repository is public, so anyone else can comment, and their line counts for nothing.
3. In each kept comment, the first line matching `^Regression state: (fixed|reverted|parked)\b(.*)$` is that comment's state. Use a multiline match on the body, whose line breaks may be `\r\n`.
4. The newest such comment is the issue's state. For `parked`, the text after `— ` is the blocker.
5. An open issue with no state, or with only a blocker-less `parked` line, has no state. An open issue whose state is `fixed` or `reverted` is waiting for its proving run and still counts as open.

Example, from #7034:

```
Regression state: parked — J-portfolio-03 #1 is BLOCKED convert_kind: svc-bank has no convert activity kind. Lane B8.
```
