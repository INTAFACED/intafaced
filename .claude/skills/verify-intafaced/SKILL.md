---
name: verify-intafaced
description: Drive INTAFACED's Customer web app on this checkout's own local test stack the way a person does, and keep the proof. Launch the stack, check that it is worth driving, drive one journey step or look at one page, keep the screenshots and reports, and clean up, with one command each. Use it when a change needs proving in the running app, before the first push of a journey branch, or instead of restarting the stack by hand or writing a one-off Playwright probe.
---

# Verify INTAFACED in the running app

Every command here is a word of the stack's own start, `pnpm local:stack verify <command>`, so the Mac's checks on a stack start (the disk floor, the heavy-job turn, the old-branch check) apply to it. Run them from the checkout's root. The code is `tooling/scripts/verify-app.mjs`. It wraps the stack (`tooling/scripts/local-test-stack.mjs`) and the journeys' own harness (`apps/customer/tests/real-app/`) and adds no harness of its own.

A local pass never counts as proof. The proof is the Real-app journeys run on the pull request's exact head (AGENTS.md, How work flows 4). This skill is how you see a change working before you push, and how you show what you saw.

**What a person touches:** the Customer app, a React and Vite web app, served by the stack at `http://127.0.0.1:3210`. Slot n adds 1000 × n to every port; `launch` and `doctor` print the address. The stack also serves:

- the founder console (`apps/admin`, port 3100), which operator journeys drive;
- the invitation site (port 3220);
- every service behind Edge (port 14500).

The journeys reach those through the same harness, so drive them through a journey step too.

**Isolation:** up to four stacks run at once, one per checkout, each in its own slot with its own ports (all but one: the TEST miner door listens on 3999 in every slot, so drive a mining-pool step only when the doctor's line says `other slots up: none`), state folder and journey results. A slot's state folder is long-lived: a stop keeps its data, so the database holds the accounts, orders and trades of every earlier run in that slot, by any checkout. Step tests make their own TEST person, so this rarely matters; a file marked `// Stack: fresh` needs a new state folder (`LOCAL_STACK_STATE`, in `docs/LOCAL-TEST-STACK.md`): set it on every verify command of that run, launch to stop. Never drive a stack this checkout did not start: the doctor refuses one, and so do the journeys' config and helpers. With every slot held, `launch` exits 3. Prove the change on CI's stack instead: `gh workflow run real-app-journeys.yml --ref <branch> -f journeys="<J-id>.pw.mjs"`.

## Launch

**Pick the feature first.** Run `pnpm local:stack verify map` (it needs no stack), pick a journey in `.claude/skills/verify-intafaced/features/index.md`, and read its `features/<J-id>.md` (Drive below says what each part means). Its Gotchas name what the launch must provide. A journey that reads past trades is launched with its id, so its first drive is not refused. That runs the TEST chart history step, which writes trades only for a market that has none yet: a slot's long-lived state folder usually keeps the history an earlier run wrote.

```sh
pnpm local:stack verify launch                 # this checkout's stack, built, started and readied
pnpm local:stack verify launch J-charts-desk-01 # also writes the TEST chart history when that journey reads past trades
pnpm local:stack verify launch --only edge,identity,trade,matching,ledger,customer,bank   # only these services
```

It starts the stack, or reuses this checkout's running one. It builds only when the source changed since the last build, and it migrates every schema of a service it starts. From an empty state folder, it also enrols the TEST founders. Then it readies the stack once, the way a journeys shard is readied: matching restarted, the TEST gates, the TEST market maker and the TEST content (`readyStack` in `tooling/scripts/journey-local.mjs`). It ends by running the doctor, which prints one line, `verify: doctor: worth driving (<checks> ok; ...)`, or every check when one fails.

**Ready** is the last line: `verify: launch: ready in <n>s: http://127.0.0.1:<port> (slot <n>; ...)`, exit 0. Any other end means it is not usable. The line above it says why, and `pnpm local:stack verify doctor` names the check that failed.

**The TEST chain needs anvil.** The stack runs it with the anvil binary named by `LOCAL_STACK_ANVIL_BIN`, else the first `anvil` on `PATH`. When neither names one, launch looks where Foundry installs it (`~/.foundry/bin`, the newest `~/.intafaced/foundry-<version>/`), says `verify: launch: anvil is not on PATH; the TEST chain uses the installed <path>`, and hands that path to the stack. When there is none anywhere, launch prints `chain: no anvil binary` and the health table shows `svc-indexer absent (no TEST chain)`. That is still ready, but a step on the TEST chain then fails, and the chain is the missing precondition. The feature file names each file that uses the chain.

**After a source edit,** run `launch` again. The start rebuilds what the edit touched. It restarts only the services whose build changed. The Customer server reads its files from disk on every request, so a Customer-only edit needs no restart. Readying is not repeated on the same stack.

The first start in a checkout builds everything: a few minutes, more under load. Later launches take seconds plus whatever the edit rebuilds. Teardown is `verify stop` (Cleanup). The start's own output, printed in the middle of launch's, ends `Stop: pnpm local:stack:stop`; under this skill, stop with `verify stop` instead, which also stops the TEST market maker launch started.

## Doctor

```sh
pnpm local:stack verify doctor
```

Read-only. It answers "is this instance worth driving?" from:

- the slot claims;
- the stack's own health table (`local-test-stack.mjs status`);
- its plan (`plan --json`);
- `.verify/launch.json`.

Its checks, one line each:

- `stack`: this checkout holds a live slot of its own.
- `health`: every service, the Customer, invitation and apex sites, the console and its HTTPS front answer.
- `market`: the TEST market maker is not down or stale.
- `owned`: every `svc-*` service answering on this slot's ports is a process this stack started (pid, command line, start time). The sites (Customer, invitation, apex, console and its HTTPS front) are checked by `health` only: the stack's plan lists services, not sites.
- `build`: the running processes are on the build on disk, and the source has not changed since that build.
- `readied`: `verify launch` readied this very stack.

It ends `verify: doctor: worth driving` (exit 0) or `verify: doctor: not worth driving (<check>). Fix: <command>` (exit 1). Above that it names every other slot that is up (`other slots up: none`, or each slot and its checkout); that is no check, only what shares the machine. Run it first whenever anything looks off. `drive` and `look` run it themselves, print its one line, and refuse an instance it fails.

## Drive

**One journey step, the way its test drives it:**

```sh
pnpm local:stack verify drive J-more-catalogue-15 '#1'   # one step; a bare 1 works too
pnpm local:stack verify drive J-home-ia-01 '#4' '#5'     # several
pnpm local:stack verify drive J-home-ia-01               # every step a test proves
```

Quote `'#1'` or write `1`: an unquoted `#1` starts a shell comment, and the drive then runs every step. A drive runs the step's own test, titled `<J-id> #<n>`, through the journeys' Playwright config (`apps/customer/tests/real-app/real-app.playwright.config.mjs`). So it has the same fixtures, the same TEST browser and headless Chromium at 1440×900, and the step proves here exactly what it proves in CI.

The tests reach the app as a person does: they sign up through the app's own form, open pages by path and act through roles, labels and `data-testid` handles. Where a journey names another actor (an operator, TEST funding, another trader), they use the stack's own tools. Two cases change what runs:

- Some files hand a TEST person or account from test to test: a serial file, or one using `journeyState`. There a later step acts as the person an earlier test made, so a drive of one step runs that file's tests from the first up to the step. The drive says so.
- A journey that reads past trades refuses on a stack without the TEST chart history and names the launch that writes it.

**One page, for a look the journey tests do not take** (a layout, one element's size, a room before its test exists):

```sh
pnpm local:stack verify look /predict
pnpm local:stack verify look /uc/account --sign-up                              # as a new TEST person, signed up through the app
pnpm local:stack verify look /predict --selector '[data-testid="prediction-blocker"]'   # also that element's box, text and picture
```

It runs `tooling/scripts/verify-look.pw.mjs` through the same config and harness. It asserts only that the page answered and the element is visible. What the page shows is for you to read in the evidence.

**Which feature to drive:** the feature map. Run `pnpm local:stack verify map`, then read `.claude/skills/verify-intafaced/features/README.md` (how to read it), `features/index.md` (every journey by module) and `features/<J-id>.md` (one feature's recipe). The map is generated from `docs/roadmap/journeys.json` and the journey tests' titles, so it is as current as they are. Never edit a generated file.

**Other actors, at hand:** `pnpm local:fund <email> <ASSET> <amount>` credits TEST funds through the ledger. The rest of the stack's TEST tools are in `docs/LOCAL-TEST-STACK.md`.

## Evidence

Every `drive` and `look` keeps one run folder: `.verify/runs/<UTC time>-<label>/`, in this checkout and ignored by git.

- `summary.md`: what was driven, the exact command to run it again (it starts with `cd` to the checkout and writes to a new temporary folder, `$OUT`, so a paste never empties this run's folder), the commit and whether `git status` was clean, the slot and address, start and end, exit code, and each test with PASS or FAIL, its `file:line` and its first error line. Under "What the harness said" are any `WORLD RESTORE` lines. Before a file runs, the harness puts the shared test world back after the journey file that ran last in this slot, which may be another checkout's or an earlier run's (its record is in `/tmp/intafaced-real-app`, `-<slot>` after a slot above 0). It prints a line only for what it could not put back; with none, the section says so. Read it before you trust a step that reads the shared order book or a market.
- `output.log`: everything the run printed.
- `summary.json`: the same, for a script.
- `report.json`: Playwright's JSON report.
- `results/<test>/test-finished-<n>.png`: the visible part of each page (1440×900) as the test ended, passed or failed. The journeys' own config takes it. A test that used several browsers (a second person, say) leaves one per page, and `summary.md` says so above them: the pages still open at the end come first, then each page whose browser the test closed earlier, so `-1` is not always the step's own result. Look at each before you say which shows it. A test that checks its refusal last ends on that refusal, so a PASS can end on a picture of "refused". A screenshot can miss a result that sits below the fold, so the test's assertions, in its file at the `file:line` `summary.md` names, are the proof of what the step checks. For a whole page as a person would scroll it, add a `look` at the same path. A test with no page leaves none. `trace.zip` is kept for a failed test.
- `look` only: `page.png` (full page), `page.aria.yml` (the page's ARIA snapshot), `page.url.txt`, and with `--selector`: `element.png`, `element.aria.yml` and `element.json` (box and text).

`pnpm local:stack verify evidence` lists the runs, newest first, with their verdicts.

What counts as proof:

- Exercise the real user path: a step's own test or a page as a person reaches it, never an internal setter or a test-only door the step's test does not itself use.
- Capture the action and the resulting state, not only the final screen: the step tests assert both, and `summary.md` names each test that did.
- Verify side effects (a ledger entry, an order, a notice) alongside what is visible. The step tests read them through the services' own doors.
- Use mocks only where a production boundary already isolates the outside system. The stack's TEST stand-ins (the model provider, chain, venue, partner bank and mailbox) are listed in `docs/LOCAL-TEST-STACK.md`, "Every Customer door is reachable".
- When the safe path is a TEST tool or a dry run, check what it actually skipped by observing it, not by its name.
- Report a step that cannot run with the command you ran and the precondition that was missing. Never report it as proven through another step.

## Cleanup

```sh
pnpm local:stack verify stop
```

It stops the stack only when `verify launch` started it. First the TEST market maker that launch's readying started is stopped through its own stop (by its pid file; it cancels its resting TEST orders), then the stack through the stack's own stop. That stop ends exactly the processes the stack recorded, each checked by pid file and command line, then Postgres, and frees the slot. Nothing is ever stopped by name or pattern. A stack this checkout already had running before `launch` is left running, and the line says so. Then it checks what you would check by hand: no port of this stack still answers. It reads the ports before the stop (the slot's own, and every port a process in the health table listened on) and prints `verify: stop: nothing answers on any of the stack's <count> ports (...): <ports>` (exit 0), or names each port still answering (exit 1; `lsof -nP -iTCP:<port> -sTCP:LISTEN` names the process). The evidence stays in `.verify/runs/`, and the last line names it.

The stack's process record and its health table can still show pids from an earlier stack in the same slot, another checkout's or an earlier run's; its stop reports those `not running` and touches nothing. The run never prints every process (anvil's children, Postgres's backends, a service a journey restarted), so check cleanup by those ports, not by pids.

Run `stop` after a failed attempt too, so a broken try strands no process or port. Ctrl-C on any verify command stops only its own child and leaves the stack up for `stop`.

## Helpers

| Command                                                              | What it does                                             | Exit                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm local:stack verify launch [<J-id> ...] [--only a,b]`           | start or reuse, rebuild what changed, ready once, doctor | 0 ready, 1 not, 3 no slot or refused                                                |
| `pnpm local:stack verify doctor`                                     | read-only: worth driving?                                | 0 yes, 1 no                                                                         |
| `pnpm local:stack verify drive <J-id> ['#n' ...]`                    | run those steps' tests, keep the evidence                | 0 passed, 1 failed or refused, 2 no such step                                       |
| `pnpm local:stack verify look <path> [--sign-up] [--selector <css>]` | one page's screenshot and ARIA snapshot                  | 0 answered, 1 not                                                                   |
| `pnpm local:stack verify map [<J-id> ...]`                           | write the feature map                                    | 0                                                                                   |
| `pnpm local:stack verify evidence`                                   | list kept runs                                           | 0                                                                                   |
| `pnpm local:stack verify stop`                                       | stop the stack `launch` started; keep the evidence       | 0 stopped, nothing left on its ports, or none; 1 not ours or a port still answering |

They are tested in `tooling/scripts/verify-app.test.mjs` (`node --test tooling/scripts/verify-app.test.mjs`), which CI's tooling tests run.

**Proven on:** a builder's Mac checkout with its own slot, which is the target this skill is for. A cloud container or CI runner also needs `LOCAL_STACK_STATE` outside `/root`, a `nats-server` binary and the screening variables (`docs/LOCAL-TEST-STACK.md`, "A fresh stack, or a cloud container"). Those steps are unverified here until a run there covers them.
