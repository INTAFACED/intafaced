# apps/customer

The customer app (Vite and React). Rules for the whole repo are in the root `AGENTS.md`; this file holds the few that are only about this app.

- Run: `pnpm --filter @intafaced/customer dev`. Tests: `pnpm --filter @intafaced/customer test`. Typecheck: `pnpm --filter @intafaced/customer typecheck`.

## Types from the contracts

New screens take their types from `@intafaced/contracts`. Do not declare response schemas by hand.

- Name a procedure once with the service's own schemas, then call it with `readContract` or `writeContract` (`src/shared/contract-call.ts`). Input and output types are inferred; the output is still parsed at runtime.
- Worked example: `src/features/account/rank-perks-api.ts` and `RankPerks.tsx`.
- The contracts root pulls in server code. Import only a browser-safe subpath such as `@intafaced/contracts/identity`. If the schema you need has none, add a subpath export to `packages/contracts` in its own PR first (`browser-entry-closure.check.mjs` there proves it).
- Narrow with `.refine` or `.extend` on the contract schema. Never copy its fields.
- Where no contract exists yet, say so at the top of the file and keep the hand-written schema small, tolerant of extra keys, and with decimal strings for money.
