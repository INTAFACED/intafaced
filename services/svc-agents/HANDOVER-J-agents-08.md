# WIP handover: J-agents-08 (delete this file before the PR leaves draft)

Research only so far; no feature code is written. This note keeps what was found so the next session starts from it.

## State on main (Real-app journeys run 42190055515, main 8047efa9)

- J-agents-08 starts passes; #1 to #7 fail. The test `apps/customer/tests/real-app/J-agents-08.pw.mjs` was written ahead of the feature.
- #1, #2, #4, #7 fail at missing controls (Access region, Account access form, Allowance form, Allowances table).
- #3 and #5 fail on a strict-mode clash: `textbox /^Ask the agent/` matches both the Test panel and the Session panel on the agent's Test page. The test must scope to one region.

## Specs read

- Step text: project-state `operation-zero/modules/agents/acceptance/journeys.md` (J-agents-08).
- AG-spend-02 and AG-spend-03: `operation-zero/modules/agents/specs/agents-spend.md`. RC-agents-06: `specs/recon-2026-10-20.md`.
- OWNER 186 (1): E-4, agent tools that move money, is on for TEST money only; real money stays off until Launch hardening.

## Design found so far

- Rules (#1): new rules store (allow or deny, action, scope); deny wins at any scope; "Only allow what a rule allows" makes no-match refuse (`agents.policy_no_match`).
- Access (#2): access rows per agent (sub-account ids, expiry; blank expiry refuses `agents.access_expiry_unset`); sub-accounts listed from identity `subAccounts.list`; ownership re-asserted at use.
- Allowance (#3, #4, #7): a limit row, never a balance (`agents.allowance_unset`, `_exceeded`, `_revoked`); draws are intent rows under a row lock, keyed `agents:allowance:<grant>:<period>:<seq>`.
- Order (#5, #6): svc-agents calls svc-trade's own order placement as the person, with `forwardedPrincipalHeaders(ctx)` (already used in `src/own/routes.ts`), `clientOrderId` = `agents:act:<session>:<action>`, and svc-trade's `tag` (1 to 16 chars) to mark the agent. The preview's price and fee come from svc-trade, never from model text.

## Open question to settle first

- Step 2 limits access to sub-account A, and step 6 places an order on the person's book. Main can't fund a sub-account today: `recipes.subAccountTransfer` moves only between sub-account pots, and nothing calls it. Either the order goes to sub-account A (needs a funding path), or access covers sub-accounts while the main account is reached through the rules of #1. Decide this before building, and choose #1's rule action so it doesn't block #6's order.
