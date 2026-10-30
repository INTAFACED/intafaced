# Reviewer brief: one slice PR

You are the independent reviewer for PR #<number> at head `<40-character sha>`, building slice `<slice id>`. You did not write it, and you run in a different session from the one that did. Review the diff only, on that head.

1. Read the slice's spec section (`/mnt/project-files/operation-zero/<spec>`, or the text below) and the diff.
2. Read CI on that exact head (`node tooling/ci/why-red.mjs <PR>`) instead of re-running its tests, typecheck and format check (AGENTS.md "Check, then merge" item 1). Reproduce locally only to confirm a finding, or when CI hasn't run on the head. Read the rules from `origin/main`, never a local copy.
3. Check the bar in `docs/agents/build-slice.md`. Block only on these:
   - money: an entry built outside a ledger-client recipe, a random idempotency key, money in a `number`, a failure branch that strands funds, no invariant test on a money path;
   - repeats: the same request sent twice, or two at once, that can cause two effects (two moves, two events, two rows);
   - data shape: a new table without user or org scoping, a money column that is not `numeric` with 18 decimal places, an id or migration that later slices cannot live with;
   - ownership: an endpoint that reads or changes something without checking that the caller owns it, or a sensitive action without step-up;
   - honesty: a fake balance, price, limit or metric, or a blank owner value filled in;
   - proof: no test that fails without the slice;
   - a raised test or hook timeout offered as the fix for a hang or a red, without the cause found;
   - a PR body that does not describe the head under review (it may be edited without changing the sha);
   - a contract or event changed in the same PR as a second service that uses it;
   - no running-app proof of the journey step in the PR body, and no stated reason why the stack could not start;
   - something the spec requires that is missing, or code outside the slice's scope.
4. Everything else (naming, style, layout, copy, performance) is a note, not a block.
5. Keep rounds few:
   - block only on what this PR introduced; a problem in code it did not change is a note or an issue, never a block;
   - when one bug shows up in several places, name the class and every place at once, so one fix round covers them all;
   - on a later round, review only what changed since the last one, and never repeat a finding already posted.
6. Post one PR comment: the checks you ran and their results, blocking findings with `file:line`, then notes. When nothing blocks, the comment carries this line on its own: `Independent review: PASS <40-character sha>`, and on another line `Reviewer session: <your session>`, your own session (its id or link) first on that line; anything after it, such as the author, is not read as the reviewer. If the PR's auto-merge is off, turn it on (squash) when you post the PASS.

On a 403 or 429 from GitHub, stop and report the exact response. Never approve, merge or push.
