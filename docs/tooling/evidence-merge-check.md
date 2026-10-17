# Evidence-based merge check

Run the gate from a clean, current `origin/main` worktree:

```sh
node tooling/scripts/merge-gate.mjs <pr-number> --head <full-head-sha>
```

The gate reports evidence and a merge command; it never merges. Gitleaks and Dependency audit must pass, all checks must finish, and code changes need applicable CI coverage. A changed head requires a fresh review and gate run. Changes to the target, declarations or checks during collection also invalidate the run. Docs-only changes get an explicit report, claim no test coverage, and still require mandatory checks and any applicable protected-path review.

## Protected scope and declarations

Paths are protected by default. The only ordinary exceptions are `packages/ui`, `packages/i18n`, and the exact root files `README.md`, `LICENSE`, and `NOTICE`. Money/security-sensitive names within those exceptions remain protected. Every `GATE_PATHS` entry is protected, including gate scripts, test selection and workflows. Both sides of a rename count. `tooling/scripts/merge-review.mjs` is the scope policy.

Declarations are accepted only from PR bodies whose author has GitHub `author_association` equal to `OWNER`, `MEMBER` or `COLLABORATOR`, and comments with one of those associations. The gate reads the PR association from the REST pull-request record, bound to the live head. An untrusted or missing author association contributes no body declarations; edits to that ignored body cannot force a rerun. Other commenters cannot supply or revoke declarations. Trusted comments are fingerprinted and re-read so edits or deletions require a new run. Put declarations on plain lines outside fences and blockquotes.

## Failure and execution evidence

Normal PR test jobs keep GitHub's default merge-result checkout, so they test integration with main. The gate binds that actual tested merge commit to the GitHub PR's current `merge_commit_sha` and verifies its two parents: the tested main tip and the exact PR head. That tested main parent must be the live `origin/main` ref fetched at the start of the run. Before the verdict the gate fetches `origin/main` again and refuses the run if that ref moved or the tested parent is no longer it. Before a PASS receipt it fetches once more (`mainCopyProblem`) and checks the same equality. A stale merge parent, or main moving during the run, refuses the run. The comparison base is that live main tip, not the older fork/merge-base or a convenient recent run. Checkout logs and GitHub commit metadata must agree; raw-head-only evidence cannot stand in for merged-result testing. This proof is required even for green test jobs. The full-PR review range separately uses the merge-base...head range.

A change to `package.json`, the lockfile, vitest or turbo config, `.github` or `tooling/ci` is not proved by an affected-only shard. It can pass coverage only when Tests (full) ran on the exact current merge result, every failing workspace is already in main's failure set at that same base (no new failure signatures and no new failing workspace), and an Opus evidence comment quotes the gate's canonical patch hash on a plain `Patch-Hash:` line. The same no-new-failures rule applies when main's Tests (full) is already red. A protected workspace that fails with the same signatures as main is excused only when the PR changes no file in that workspace; a change in that workspace still blocks. A red CI merge seal does not block again when that full-suite result is allowed. Definition of Done must run on its own, not behind the merge seal, and a skipped Definition of Done blocks. A new signature, a new failing workspace, a shard standing in for the full suite, two `Patch-Hash` lines for the current hash, or a missing patch-hash quote still blocks. A `Patch-Hash` line for an older hash is ignored.

Gitleaks and Dependency audit are required. Checks are keyed by Actions workflow id plus job name. A second workflow that reuses the name "CI" cannot collapse a red Typecheck, Doctrine or merge-seal job into its own green one. If two runs share one workflow id and a required job name, the gate fails closed. It does not keep the later green one. A rerun that still lists both results blocks until the duplicate is gone. Other jobs in the same workflow still collapse to the latest attempt. A check with no workflow id fails closed.

Coverage at the bound merge result and tested main parent requires the expected completed test command, attributable workspace execution summaries with positive executed-test totals, and a successful `Every infrastructure-backed suite actually ran` step with its completion report at both commits. Green status cannot override failed totals, a failed test-command step or explicit unhandled errors. Missing summaries, zero execution, unknown execution, or skipped/pending protected tests block. The full-suite denominator comes from main’s workspace manifests with test scripts, never only the tasks appearing in a log. A new or untested workspace absent from that trusted inventory is unknown and blocks; existing task output cannot stand in for it. Separate shards may jointly cover changed workspaces; the combined head and base evidence must each cover every required workspace. Supported policies cover the full suite and protocol, money, trade and pay-bank shards; unsupported reporters or commands fail closed.

| Classification | Meaning                                                                                           | Merge effect                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Introduced     | Exact-base evidence differs, or covered base tests passed                                         | Blocks                                                                              |
| Inherited      | Exact commits prove matching complete failure signatures and an owner/evidence declaration exists | Full-suite match may pass; a protected workspace only if the PR leaves it untouched |
| Environmental  | Runner/infrastructure failure does not prove application execution                                | Blocks pending valid evidence                                                       |
| Unknown        | Missing, incomplete, ambiguous or unsupported evidence                                            | Blocks                                                                              |

An inherited exception needs one unambiguous declaration per check:

```text
Inherited-Failure: CI/Tests (full) | owner=<responsible-owner> | evidence=<https-evidence-url>
```

The declaration supplies accountability, not proof. Readable Vitest logs must reconcile all failing tasks, files, tests and occurrence counts. Error bodies, assertion differences and source locations form the signatures. Two defects sharing a test name do not match. Real escape bytes and literal `^[[..m` colour codes are stripped. Unhandled or unattributed errors and incomplete logs block.

A matching protected full-suite failure stays blocking when the PR changes a file in that workspace. It is excused only when the PR changes no file there. Other protected failures remain blocking. A non-protected exception requires equivalent full-suite jobs whose only failed step is the supported test command, with successful infrastructure execution backstops. Other failed checks must satisfy their own evidence requirements.

A green shard may use proven full-suite base coverage when no corresponding base shard ran. A failing shard needs its matching base job; if main does not run that job, it blocks. Matching shard failures still do not receive the full-suite exception. Fix the failing test. This change adds no new base-run producer, permanent exemption or local infrastructure launch. Separately dispatched raw-head evidence is diagnostic and cannot replace the merged-result check. Missing bound merge or tested-main runs remain unknown.

## Independent Opus review

Protected PRs declare their author session and reviewer identity:

```text
Author-Session: <author-session-UUID>
Opus-Review: <full-head-sha> <reviewer-session-UUID-or-agent-ID> PASS
```

The reviewer emits their own exact-head verdict in an assistant response after reviewing. Any non-PASS exact-head declaration blocks, even if a PASS also exists. A non-PASS exact-head verdict in a candidate reviewer transcript also blocks.

Write the reviewer's input before launching the review. From a checkout that can fetch this repo:

```sh
node tooling/scripts/merge-gate.mjs <pr-number> --head <full-head-sha> --reviewer-input <directory>
```

That fetches `origin/main` and the PR head commit, resolves the merge base, and writes `<directory>/canonical.patch` plus `reviewer-input.json` (hash, file list, base, head, and the patch path). Launch the reviewer with `canonical.patch` as a file. The prompt names that path and asks for an independent review. It must not contain the patch text, a verdict marker, or the head together with PASS. The assistant reads the file and quotes the hash and file list below.

The gate accepts these local Claude transcript locations:

- Root reviewer: `~/.claude/projects/<project>/<reviewer-session-UUID>.jsonl`.
- Reviewer sub-agent: `~/.claude/projects/<project>/<parent-session-UUID>/subagents/agent-<agent-ID>.jsonl`. Declare the agent ID; conversation entries must identify that agent, its parent session and sidechain status. Real telemetry records may omit sidechain status; conflicting identities still block and telemetry cannot approve.

The root session or sub-agent's parent must differ from the declared author session. Only Claude Opus assistant text supplies approval. The gate does not try to prove from the transcript that the reviewer ran `git diff`. It computes the canonical patch itself. The runner ignores global and system git config, and the diff options pin rename detection, prefixes, abbreviation and context so the hash does not depend on the machine:

```sh
GIT_NO_REPLACE_OBJECTS=1 git -c core.attributesFile=/dev/null -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.renames=false -c core.quotePath=true -c diff.orderFile=/dev/null diff --no-ext-diff --no-textconv --text --no-color --no-renames --diff-algorithm=myers --full-index --unified=3 <merge-base>...<head>
```

The file list is taken from `diff --git` headers, so a pure rename, a mode-only change and an empty new file still count. Both sides of a rename count. An unquoted path that contains spaces is read as `a/P b/P` split into equal halves, which is unambiguous because `--no-renames` makes both sides the same path. When GitHub's PR file list is available, the patch's paths must match it. The runner sets `GIT_NO_REPLACE_OBJECTS=1` and pins Myers. `diff.orderFile` is `/dev/null`: an empty config value makes Git 2.54 refuse every patch (`failed to read orderfile ''`), and `/dev/null` is the empty file that overrides a local order file. The output buffer is 64 MB; a truncated git buffer is a failure, not a patch. The gate fetches the PR head before it computes that patch and refuses the run when the fetched tip is a different commit. The assistant report counts only when it quotes the hash and file list on plain lines, exactly:

```text
Patch-Hash: <64-hex sha256 of the canonical patch bytes>
Patch-File: <each file path, one line, no extras>
```

A fenced example does not count. A diff command in the transcript does not count, including a direct `git diff <base>...<head>`, `git show`, a path-limited diff, or `gh pr diff`. Quoting the hash of a patch that `.gitattributes -diff` turned into "Binary files differ" does not count: `--text` keeps that file's contents in the canonical patch, and `core.attributesFile=/dev/null` drops the extra user attributes file.

The patch is supplied as a file, so these transcript shapes are not proof and do not block: `git -C`, a `VAR=` prefix, `git -c`, and tool output that was saved because it was large. `git commit` and `git push` still block. Review prompts must not prescribe a verdict marker or combine the exact head with PASS; ask for an independent review and findings. Prompted approval, tool output and another model cannot approve. The quote of the hash is the binding, not the shape of the command that printed the patch. Review provenance, including the patch hash, is revalidated before receipt publication. That re-check also runs for an infrastructure-only change, such as `packages/ui/package.json`, not only for a protected path.

Review independence is an accident guard, not a security boundary. A process running as this Mac user can write a transcript that quotes the hash and file list without reading the patch, and can forge transcripts, author declarations or receipt JSON. Distinct session IDs do not establish distinct humans or sound judgment. The quote binds the report to the patch the gate computed. It does not prove the reviewer found every defect. If the client truncates the prompt that carried the patch, this check cannot see that truncation; a quote of any hash other than the full canonical patch still fails.

## Gate changes and receipts

Gate edits need a `gate:` or `ci:` title (or the existing equivalent marker), an exact-head Opus review, and main's gate. The production CLI fetches `origin/main` and requires its current revision and clean gate dependencies before evaluation and receipt publication. A modified PR copy cannot authorize itself.

PASS receipts are private, atomically written JSON files:

```text
~/.cache/intafaced/merge-gate/receipts/<owner>/<repo>/<full-head-sha>.json
```

They record the repository, PR, exact head/base, freshly checked `liveHead`, trusted `gateSha`, evidence, review and `createdAt`. A new evaluation invalidates the old receipt first; a refusal cannot leave an earlier PASS usable. Offline fixtures use isolated receipt directories.

`validatePassReceipt` fetches `origin/main` and requires `receipt.base` to equal that live ref before the receipt is trusted. `--match-head-commit` binds only the head, so main moving after the receipt must still refuse the merge. It also requires the receipt head and `liveHead` to match the live PR head, `gateSha` to match the current trusted gate revision, and a valid non-future timestamp no older than 30 minutes by default. A call that does not fetch fails closed. JSON remains forgeable by the same user. This change installs no hook and changes no settings.

The lead owns the pilot's real-PR refusal/pass demonstrations and the independent Opus review of this gate PR.

## Offline verification

```sh
node --test tooling/scripts/gate-tools.test.mjs
node tooling/scripts/local-test-gates.test.mjs
```

Fixtures cover classification, exact-commit execution and coverage, protected scope, trusted declarations, review transcript provenance, gate-copy enforcement, docs-only reports and receipt freshness. A trimmed real CI log exercises literal colour escapes and incomplete failure evidence. Offline fixtures do not establish a live PR's CI or review verdict.
