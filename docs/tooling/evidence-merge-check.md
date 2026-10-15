# Evidence-based merge check

Run the gate from a clean, current `origin/main` worktree:

```sh
node tooling/scripts/merge-gate.mjs <pr-number> --head <full-head-sha>
```

The gate never merges. A changed head requires a new review and a new gate run. Gitleaks and Dependency audit must pass, all checks must finish, and code changes must have the applicable CI test coverage. Docs-only changes get an explicit report and still require the mandatory checks.

## Failure evidence

The comparison base is the PR's merge base with its target, not a recent convenient main run. A target change during the check invalidates the decision. There is no five-run history exemption and no permanent PR-only failure exemption.

Each failing check receives one of four classifications:

| Classification | Meaning                                                                                             | Merge effect                        |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Introduced     | Exact-base evidence differs from the head failure, or the corresponding base job passed             | Blocks                              |
| Inherited      | Exact head and base prove the same complete failure signatures, with an explicit owner and evidence | May pass for non-protected failures |
| Environmental  | Evidence identifies infrastructure failure, without proving the application passed                  | Blocks until a valid rerun          |
| Unknown        | Missing, ambiguous, unsupported, or mismatched evidence                                             | Blocks this PR invocation           |

An inherited exception requires a declaration in the PR body or comments:

```text
Inherited-Failure: CI/Tests (full) | owner=<responsible-owner> | evidence=<https-evidence-url>
```

A declaration alone is not proof. The gate verifies the exact runs, jobs, checkout commits, failure steps and failure signatures. Two assertions with the same test name but different errors or source locations do not match. Money and security failures remain blocking even when identical on the base. Unattributed failures cannot establish a safe exception.

The supported inherited case is a full CI test run with readable, attributed Vitest failure evidence. Its dependent CI merge seal may be accepted only when the seal proves that this same allowed test failure is its sole cause; extra seal failures block. Narrow shards, unsupported reporters and incomplete logs fail closed. This intentionally does not promise an exception for every existing red check.

For inherited exceptions, GitHub's `headSha` metadata alone is insufficient: a pull-request workflow can check out a synthetic merge commit. The inherited comparison requires the job's actual checkout commit to equal the requested commit. If the repository has no suitable run at either commit, the gate reports unknown. Arrange an exact-commit CI run; do not substitute a nearby main run or invent a local pass. This change does not install a rerun workflow or start infrastructure locally. When all checks pass, the gate preserves the existing head-bound GitHub check behavior: those checks may test the synthetic merge. It does not claim an isolated head/base rerun for that green path.

## Independent Opus review

Money/security PRs declare the author session and the independent reviewer session in their body or comments:

```text
Author-Session: <author-session-id>
Opus-Review: <full-head-sha> <reviewer-Claude-session-UUID> PASS
```

The reviewer must place the same exact-head review declaration in their own assistant response after reviewing. The gate reads `~/.claude/projects/*/<reviewer-session-id>.jsonl`. The transcript must identify that session and contain the review in a Claude Opus assistant message. User prompts, tool output, another model, another head, and the author reviewing their own change do not qualify.

Money roots reuse `tooling/ci/money-skip-inventory.mjs`. Additional security and shared execution roots live in `tooling/scripts/merge-review.mjs`, the single gate policy for protected scope. Rename source paths also count.

This is a local pilot assurance check, not cryptographic identity or GitHub branch protection. Someone who can alter local transcripts or author declarations can falsify those inputs. Review quality still requires judgment. The gate checks provenance and version binding; it does not establish that the reviewer found every defect.

## Gate changes and receipts

A gate edit must declare itself with a `gate:` or `ci:` title (or the existing equivalent marker) and pass main's gate. The production CLI checks that its gate code is main's clean copy before issuing a receipt. Running a modified PR copy does not authorize its own merge.

PASS receipts are private JSON files at:

```text
~/.cache/intafaced/merge-gate/receipts/<owner>/<repo>/<full-head-sha>.json
```

They record the repository, PR, exact head/base, gate revision, review and evidence. Writes are atomic. Offline fixtures never create production receipts. A failed new evaluation must not leave an earlier receipt usable. The later hook is a separate task: this PR installs no hooks and changes no settings.

A receipt is a local record of one check, not a promise that CI or the target branch can never change afterwards. Merge the reviewed exact head only, and rerun when relevant state changes. The lead owns the pilot's two real-PR refusal/pass demonstrations and the Claude Opus review of this gate PR.

## Offline verification

```sh
node --test tooling/scripts/gate-tools.test.mjs
node tooling/scripts/local-test-gates.test.mjs
```

Fixtures cover introduced, inherited, environmental and unknown failures; two different defects sharing a test name; protected failures also present on base; invalid or missing Opus review; gate edits; docs-only reporting; and receipt handling.
