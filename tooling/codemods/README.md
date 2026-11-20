# Clean-up scripts (codemods)

One script per kind of clean-up, run over the whole repository in one change. A pull request whose product diff is
exactly a script's output is judged as a clean-up change: types, build, unit tests (the wire replays among them), the
CANARY journeys that boot the stack and the app, and only the journeys the touched-journeys map gives for its paths,
never the full journeys run (`tooling/ci/cleanup-replay.mjs`, `tooling/ci/journey-touch.mjs`).

1. Land the script first: `tooling/codemods/<name>.mjs`, Node built-ins only, run from the repository root with
   `node tooling/codemods/<name>.mjs`, deterministic, no network. It runs no journeys.
2. Run it on a branch from the newest `main`, commit its output untouched, and put `Codemod: <name>` on its own line in
   the pull request body. CI reruns the script on the merge base and compares.
3. A hand edit to product code beside the output, or only part of it, makes the pull request an ordinary one again.
