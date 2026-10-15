# Evidence-based merge check

Run the gate from a clean, current `origin/main` worktree:

```sh
node tooling/scripts/merge-gate.mjs <pr-number> --head <full-head-sha>
```

The gate reports evidence and a merge command; it never merges. Gitleaks and Dependency audit must pass, all checks must finish, and code changes need applicable CI coverage. A changed head requires a fresh review and gate run. Changes to the target, declarations or checks during collection also invalidate the run. Docs-only changes get an explicit report, claim no test coverage, and still require mandatory checks and any applicable protected-path review.

## Protected scope and declarations

Paths are protected by default. The only ordinary exceptions are `packages/ui`, `packages/i18n`, and the exact root files `README.md`, `LICENSE`, and `NOTICE`. Money/security-sensitive names within those exceptions remain protected. Every `GATE_PATHS` entry is protected, including gate scripts, test selection and workflows. Both sides of a rename count. `tooling/scripts/merge-review.mjs` is the scope policy.

Declarations are accepted only from the PR body and comments with GitHub `author_association` equal to `OWNER`, `MEMBER` or `COLLABORATOR`. Other commenters cannot supply or revoke declarations. Trusted comments are fingerprinted and re-read so edits or deletions require a new run. Put declarations on plain lines outside fences and blockquotes.

## Failure and execution evidence

The comparison base is the PR's exact merge base with its target. A nearby main run, a recent-run window and GitHub's run `headSha` alone are insufficient. Checkout logs must prove the actual full head and base commits; synthetic merge checkouts do not qualify. This proof is required even for green CI test jobs.

Coverage requires the expected completed test command, attributable workspace execution summaries with positive executed-test totals, and a successful `Every infrastructure-backed suite actually ran` step with its completion report at both commits. Green status cannot override failed totals, a failed test-command step or explicit unhandled errors. Missing summaries, zero execution, unknown execution, or skipped/pending protected tests block. The full-suite denominator comes from main’s workspace manifests with test scripts, never only the tasks appearing in a log. A new or untested workspace absent from that trusted inventory is unknown and blocks; existing task output cannot stand in for it. Separate shards may jointly cover changed workspaces; the combined head and base evidence must each cover every required workspace. Supported policies cover the full suite and protocol, money, trade and pay-bank shards; unsupported reporters or commands fail closed.

| Classification | Meaning                                                                                           | Merge effect                                             |
| -------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Introduced     | Exact-base evidence differs, or covered base tests passed                                         | Blocks                                                   |
| Inherited      | Exact commits prove matching complete failure signatures and an owner/evidence declaration exists | Only eligible non-protected full-suite failures may pass |
| Environmental  | Runner/infrastructure failure does not prove application execution                                | Blocks pending valid evidence                            |
| Unknown        | Missing, incomplete, ambiguous or unsupported evidence                                            | Blocks                                                   |

An inherited exception needs one unambiguous declaration per check:

```text
Inherited-Failure: CI/Tests (full) | owner=<responsible-owner> | evidence=<https-evidence-url>
```

The declaration supplies accountability, not proof. Readable Vitest logs must reconcile all failing tasks, files, tests and occurrence counts. Error bodies, assertion differences and source locations form the signatures. Two defects sharing a test name do not match. Real escape bytes and literal `^[[..m` colour codes are stripped. Unhandled or unattributed errors and incomplete logs block.

Matching protected failures remain blocking. A non-protected exception requires equivalent full-suite jobs whose only failed step is the supported test command, with successful infrastructure execution backstops. Other failed checks must satisfy their own evidence requirements.

A green shard may use proven full-suite base coverage when no corresponding base shard ran. A failing shard needs its matching base job; if main does not run that job, it blocks. Matching shard failures still do not receive the full-suite exception. Fix the failing test. This change adds no new base-run producer, permanent exemption or local infrastructure launch. Missing exact-commit runs remain unknown.

## Independent Opus review

Protected PRs declare their author session and reviewer identity:

```text
Author-Session: <author-session-UUID>
Opus-Review: <full-head-sha> <reviewer-session-UUID-or-agent-ID> PASS
```

The reviewer emits their own exact-head verdict in an assistant response after reviewing. Any non-PASS exact-head declaration blocks, even if a PASS also exists. A non-PASS exact-head verdict in a candidate reviewer transcript also blocks.

The gate accepts these local Claude transcript locations:

- Root reviewer: `~/.claude/projects/<project>/<reviewer-session-UUID>.jsonl`.
- Reviewer sub-agent: `~/.claude/projects/<project>/<parent-session-UUID>/subagents/agent-<agent-ID>.jsonl`. Declare the agent ID; conversation entries must identify that agent, its parent session and sidechain status. Real telemetry records may omit sidechain status; conflicting identities still block and telemetry cannot approve.

The root session or sub-agent's parent must differ from the declared author session. Only Claude Opus assistant text supplies approval. Before its verdict, the transcript must show a successful Bash tool call reading the exact-head patch and a successful tool result containing diff output. Supported reads include `git show <full-head-sha>`, `git diff <base>..<full-head-sha>`, or `git diff <base> <full-head-sha>`. A supported GitHub read asserts the head immediately before reading the diff in the same invocation:

```sh
test "$(gh pr view <pr-number> --json headRefOid --jq .headRefOid)" = <full-head-sha> && gh pr diff <pr-number>
```

A filename/stat-only read does not qualify. The reviewer transcript must never execute `git commit` or `git push`. Review prompts must not prescribe a verdict marker or combine the exact head with PASS; ask for an independent review and findings. Prompted approval, tool output and another model cannot approve. Review provenance is revalidated before receipt publication.

This is an accident guard, not a security boundary. A process running as this Mac user can forge transcripts, author declarations or receipt JSON. Distinct session IDs do not establish distinct humans or sound judgment, and a recorded diff read does not prove every defect was found.

## Gate changes and receipts

Gate edits need a `gate:` or `ci:` title (or the existing equivalent marker), an exact-head Opus review, and main's gate. The production CLI fetches `origin/main` and requires its current revision and clean gate dependencies before evaluation and receipt publication. A modified PR copy cannot authorize itself.

PASS receipts are private, atomically written JSON files:

```text
~/.cache/intafaced/merge-gate/receipts/<owner>/<repo>/<full-head-sha>.json
```

They record the repository, PR, exact head/base, freshly checked `liveHead`, trusted `gateSha`, evidence, review and `createdAt`. A new evaluation invalidates the old receipt first; a refusal cannot leave an earlier PASS usable. Offline fixtures use isolated receipt directories.

`validatePassReceipt` requires the receipt head and `liveHead` to match the live PR head, `gateSha` to match the current trusted gate revision, and a valid non-future timestamp no older than 30 minutes by default. The future hook must check all three bindings: live head, current gate revision and age. JSON remains forgeable by the same user. This change installs no hook and changes no settings.

The lead owns the pilot's real-PR refusal/pass demonstrations and the independent Opus review of this gate PR.

## Offline verification

```sh
node --test tooling/scripts/gate-tools.test.mjs
node tooling/scripts/local-test-gates.test.mjs
```

Fixtures cover classification, exact-commit execution and coverage, protected scope, trusted declarations, review transcript provenance, gate-copy enforcement, docs-only reports and receipt freshness. A trimmed real CI log exercises literal colour escapes and incomplete failure evidence. Offline fixtures do not establish a live PR's CI or review verdict.
