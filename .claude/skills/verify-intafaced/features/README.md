# INTAFACED verification map

This folder is the maintained source for verifying what a person can do in INTAFACED. Each feature is one journey in `docs/roadmap/journeys.json`. Its steps are the journey tests titled `<J-id> #<n>` in `apps/customer/tests/real-app/`. Run `pnpm local:stack verify map` first: it writes `index.md` and one `<J-id>.md` per journey here, from those two sources. This README is the only file here written by hand. A step's words change in the journey list and its test, never in a generated file.

## Baseline preconditions

- `pnpm local:stack verify launch` ended `ready`, and `pnpm local:stack verify doctor` ends `worth driving`.
- The stack is this checkout's own, in its own slot: Customer at `http://127.0.0.1:3210` plus 1000 × slot. The doctor prints it.
- The stack was readied by `launch`: the TEST gates applied, the TEST market maker quoting, and the TEST content seeded (earn pools, loan products, house inventory, the TEST P2P method).
- A journey that reads past trades was launched with its id (`launch <J-id>`), so the TEST chart history exists.
- Never drive an instance this run did not start.

## Driving conventions

- Drive a step through its own test: `pnpm local:stack verify drive <J-id> '#<n>'`. Most step tests sign up a TEST person of their own; read the step's test for where it starts.
- A file that runs serially shares one TEST person across its steps. A drive of one of its steps runs the whole file, and says so.
- Each file's `// World:` line names what it changes in the shared stack (orders on the book, service restarts, gates, the posting freeze, the stack's tools). The harness puts the world back between files.
- For a page no step test covers yet, use `pnpm local:stack verify look <path> [--sign-up] [--selector <css>]`.
- The tests act through roles, accessible names, labels and `data-testid` or `data-*` handles, never through coordinates or tab order.
- Treat every command as literal. Quote `'#<n>'`: an unquoted `#` starts a shell comment.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen. The step test asserts both, and the run's `summary.md` names each test.
- UI proof is the run folder: `summary.md`, the screenshot of each page as its test ended, and for `look` the page's ARIA snapshot.
- Side effects are proven by the step tests' reads through the services' own doors (the ledger, an order, a notice), not by the screen alone.
- Record the feature id and the step with every artifact: the run folder's name and `summary.md` carry both.
- Report a step that cannot run with the command you ran and the precondition that was missing. If the seed lacks it, say so; never weaken the test to pass.
- Never report a step as verified through a different step, or a part-of-a-step test as the step.
- A local pass is never the proof: the Real-app journeys run on the pull request's exact head is.

## Feature entry contract

Each generated feature file starts with an H1 title (`<J-id>: <journey title>`) and one paragraph: who the journey is for, where in the app, its order and marks, and which test files drive it. It then has exactly four H2 sections, in this order.

1. `Sub-features` lists each step as `#<n>` with the words of the test that proves it, and its marks (parked, later, deferred).
2. `How to get to it (user POV)` lists the paths a person opens, as the journey's tests open them.
3. `Driving it with verify` starts with `Preconditions:`, then pairs each step with its exact drive command and the test whose pass is the observable result.
4. `Gotchas` lists what can waste or invalidate a run: serial files, past-trade reads, a fresh-stack need, a live market, tests that prove no step, steps no test proves yet, and marks.

## Features

`index.md`, generated, lists every journey by module with how many of its steps a drive can prove now. Start from the journey your change touches. `docs/roadmap/journeys.json` holds the journey list. `index.md` is its readable view, never a second copy kept by hand.
