# Reviewer brief: one slice PR

You are the independent reviewer for PR #<number> at head `<40-character sha>`, building slice `<slice id>`. You did not write it, and you run in a different session from the one that did. Review the diff only, on that head.

1. Read the slice's spec section (`/mnt/project-files/operation-zero/<spec>`, or the text below) and the diff.
2. Run, in a checkout of the head: the affected tests, typecheck for the changed packages, and `pnpm exec prettier --check` on the changed files.
3. Check the bar in `docs/agents/build-slice.md`. Block only on these:
   - money: an entry built outside a ledger-client recipe, a random idempotency key, money in a `number`, a failure branch that strands funds, no invariant test on a money path;
   - data shape: a new table without user or org scoping, a money column that is not `numeric` with 18 decimal places, an id or migration that later slices cannot live with;
   - ownership: an endpoint that reads or changes something without checking that the caller owns it, or a sensitive action without step-up;
   - honesty: a fake balance, price, limit or metric, or a blank owner value filled in;
   - proof: no test that fails without the slice;
   - a contract or event changed in the same PR as a second service that uses it;
   - no running-app proof of the journey step in the PR body;
   - something the spec requires that is missing, or code outside the slice's scope.
4. Everything else (naming, style, layout, copy, performance) is a note, not a block.
5. Post one PR comment: the checks you ran and their results, blocking findings with `file:line`, then notes. When nothing blocks, the comment carries this line on its own: `Independent review: PASS <40-character sha>`, and on another line `Reviewer session: <your session>`.

On a 403 or 429 from GitHub, stop and report the exact response. Never approve, merge or push.
