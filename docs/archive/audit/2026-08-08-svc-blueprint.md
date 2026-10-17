# svc-blueprint — promise audit 2026-08-08 (REPORT ONLY — the service is owner-locked)

Tip: `ff6b50c2`
Auditor: agent session — lane C
Claim gate:

```
✖ services/svc-blueprint — owner @shehzad002 (blueprint.attestations)
```

Owner-locked, so nothing here was changed. Reading and reporting are explicitly
still allowed; implementing is not.

This is a **partial** audit and says so up front. The claim gate was discovered
partway through the session (see `2026-08-08-svc-bank.md` for why the lane brief
believed otherwise), and with no fix possible the effort went to the promises
whose failure would cost the most: the privacy claims, the "no failure may
produce a URL" claim, and the guards nothing executes.

---

## Promises checked (8 of ~21)

| #   | Promise, quoted                                                                                                                                                                                                                                    | Verdict                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "**No failure may produce a URL.** Every `HttpCardRenderer` failure path — timeout, transport error, non-2xx, non-JSON body, contract mismatch, zero bytes — returns `{ status: 'unavailable', code, reason }` and never a URL, and never throws." | VERIFIED — every `catch` and every guard in `card/http-renderer.ts` returns the `unavailable` arm; the only `url` return is on the parsed success path                                                                  |
| 2   | "a test asserts that **no `numeric` column exists anywhere in the schema**"                                                                                                                                                                        | VERIFIED, and the test is REACHED — `blueprint-service.test.ts` queries `information_schema.columns … WHERE table_schema = 'blueprint' AND data_type = 'numeric'` and asserts an empty result. Not a guard nothing runs |
| 3   | "There is no `@intafaced/ledger-client` import in this package and there should never be one"                                                                                                                                                      | VERIFIED — no import of it anywhere in the package                                                                                                                                                                      |
| 4   | "`crews.xp` … is deliberately a `bigint` and not `numeric(38,18)` so it can never be mistaken for a balance"                                                                                                                                       | VERIFIED — `bigint` in the migration, and #2's guard is what keeps it that way                                                                                                                                          |
| 5   | "A CHECK constraint (`blueprints_profile_no_pii_ck`) rejects a profile blob carrying `birthData`, `responses`, `transcript` and friends"                                                                                                           | VERIFIED — the constraint exists in `0000_blueprint_init.sql` and is a database-level backstop, not only a TypeScript check                                                                                             |
| 6   | "`crews_capacity_positive_ck` — a capacity-0 crew that can never accept the member it was formed for"                                                                                                                                              | VERIFIED — `CHECK ("capacity" > 0)` present                                                                                                                                                                             |
| 7   | "`mentor_matches` … a mentor is never the student"                                                                                                                                                                                                 | VERIFIED — `CHECK ("student_id" <> "mentor_id")`                                                                                                                                                                        |
| 8   | "`fit_score`" is bounded                                                                                                                                                                                                                           | VERIFIED — `CHECK ("fit_score" >= 0 AND "fit_score" <= 10000)`, so a bps/percent unit mix-up cannot store an out-of-range score                                                                                         |

---

## Broken, fixed here

None. Nothing was fixed — the service is owner-locked.

## Broken, parked

None found in the promises reached. That is a real result for those eight, and
**not** a clean bill of health for the service: thirteen promises were not
attacked at all.

## Could NOT break, having tried

- **A card failure fabricating a URL.** Walked every exit of `HttpCardRenderer`
  looking for a path that returns a URL or throws past the caller. Timeout,
  transport error, non-2xx, unparseable body, contract mismatch and zero bytes
  all land on the `unavailable` arm. The claim in the README is the strongest
  sentence in the service and it holds.
- **Smuggling session input into the profile column.** The named PII keys are
  refused by a database CHECK, so a future caller that forgets the TypeScript
  path still cannot land the row.
- **Introducing a money column by stealth.** The schema guard is executed on
  every run and would fail the build on the first `numeric`.

## Not reached — named so silence is not read as coverage

Thirteen promises, listed by name because they are the next session's work if the
owner frees the path:

- "A user who re-runs matching must land in the **same crew**" — determinism of
  `crew-matching`, including whether the candidate-set bound is itself
  deterministic (the README says it must be `ORDER BY` + `LIMIT`, "never a
  sample"). **Not verified.**
- "The mentor heuristic is deliberately different … there is a test that fails if
  someone simplifies it that way" — the test's existence was not confirmed.
- "five concurrent joins against two seats" — the placement transaction that must
  not overfill a crew. Not attacked.
- "**The profile is never logged, never traced, never put on an event.**
  `BlueprintSpanAttributes` is a closed type" — not audited.
- "An export lists crewmates by id and role, never by profile" — not audited.
- "`card_asset_url` is written **only** on a real render, **only** for the
  portrait, and **only** by `card` — never by `export`" — not traced.
- Erasure: "erasing a user who never onboarded, erasing twice, and onboarding
  again after erasure" — the transaction boundary the README calls the second
  most bug-prone place in the service. Not attacked.
- Readiness reporting the engine but not gating on the card renderer — not
  exercised.
- "Every procedure operates on `ctx.principal.userId` and never on an id from the
  input" — spot-read, not swept.
- The four remaining CHECK constraints and the two unique indexes.

## What only an owner can decide

`services/svc-blueprint` is claimed by **@shehzad002** under
`blueprint.attestations`. An agent may not implement here. The unlock is the
owner commenting `agents free on services/svc-blueprint`, or a PR moving the
`owner` field in `tooling/tracker/features.mjs`.
