# Denon Orchestration Protocol — RETIRED

**Superseded 2026-08-21.** Agents ship under [`AGENTS.md`](AGENTS.md) + [`.cursor/rules/inta.mdc`](.cursor/rules/inta.mdc) only.

**Full access:** no human gates. Merge when done, once the merge gate passes (`node tooling/scripts/merge-gate.mjs <pr> --head <sha>`, run from an up-to-date `origin/main` checkout). **A fully green main and `pnpm verify` are not ship gates.**

**Still binding (code integrity):** money through `ledger-client`, no money in `number`, refuse-closed for unset §8/sanctions in code.
