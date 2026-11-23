# Glossary

Each word below has one meaning in this repo: the one its checks use today. Other pages point here instead of defining it again. A word that needs a new meaning changes here, in the same change as the checks that read it.

A **live step** is a step of a live journey in `docs/roadmap/journeys.json` that is neither deferred nor parked (`liveJourneys()` in `tooling/scripts/roadmap.mjs`).

- **Built:** the code for a slice or step is merged on `main`. Nothing more: a built step may still fail, and a merged pull request is not done. A slice usually takes more than one pull request, so a merge that names it means started (`roadmap.mjs --progress`).
- **Proven** (a step, on one commit): the step passes in a finished Real-app journeys run on that commit (`real-app-journeys.yml`); it is not on that run's not-proven list, which holds every set-aside step and every test that passed only on its retry (`tooling/ci/journey-verdict.mjs`); and its proof read is not WEAK or MISMATCH (`proof v2 read`, `tooling/ci/step-read.mjs`). On a pull request, the run on its exact head proves the steps its title names (`tooling/ci/journey-seal.mjs`). The count of proven steps reads runs on `main` only.
- **Done** (a journey): its live steps pass in the Real-app journeys run on `main` (`AGENTS.md`, How work flows 9). A merge is not done; a step that only passed on a pull request's head is not done.
- **Finished** (INTAFACED): every live journey is done. Custody journeys marked Later stay in this set (`roadmap.mjs`).

Not these words:

- A **finished run** in the workflows and the seal is a GitHub run that has completed, as opposed to one still running. It says nothing about passing.
- A service's **Definition of Done** is the per-service gate, `pnpm gate` (`tooling/agent-protocol/AGENT_PROTOCOL.md` §8, `tooling/ci/dod-gate.mjs`). It is a check on one service's code, not a journey being done.
