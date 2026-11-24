# svc-blueprint's port to Rust: the notes each slice starts from

`services/svc-blueprint` is the Identity Blueprint: one onboarding session sent to the Neural Engine, the profile it
returns, crew placement, a mentor shortlist, the share card, and export and hard delete. It holds no balance and posts
nothing to the ledger. This crate is its Rust port, one slice at a time; until the switch the TypeScript service is the
one that runs, and nothing is served from here (the binary only runs `svc-blueprint migrate [--down]`).

## What is here already

- `src/door/`: every call of svc-blueprint's records, read from their published schema
  (`packages/contracts/procedures/svc-blueprint.schema.json`), so a new record is served with no edit. The checks run
  in the TypeScript's order: route and method, then sign-in, scope and the `blueprint` module's region (minimum tier
  `none`), then the record's zod input (`inputs.rs`, `schemas.json`, the refine in `src/refines.rs`). Past those, a call
  is its slice's (`handle` in `door/mod.rs`), and what it returns is parsed by the record's output schema, as tRPC
  does. `schemas.json` also holds the row schemas (`BlueprintRow`, `MentorMatchRow`) a handler checks rows with as read.
- The store: `migrations/` (the `drizzle` files, held identical by a test until the switch), `src/migrate.rs` with the
  `migrate` binary (`src/main.rs`), and the pool (`src/db.rs`). `tests/support` gives each database test a copy of a
  migrated template.
- `src/env.rs`: `env.ts` field by field, its engine refine and `assertProdEngine`.
- `src/errors.rs`: `BlueprintError` and `AttestationSurfaceError` codes and both ways the router answers a refusal:
  `mapped` (`toTrpcError`) and `unmapped` (`me`, `mentors`, `export` send whatever they throw as a 500, bug included).
- `scripts/record-door.mjs` writes `schemas.json` and the fixtures from the TypeScript; `--check` fails when one is
  stale. `tests/`: the wire replay (`services/svc-blueprint/src/wire-replay.golden.json`), input, env and refusal
  parity, and `port_notes.rs`, which holds the `## Slices` list below to `door::Slice::of`. The recorder also writes
  `tests/fixtures/card.golden.json`: the cards `composeCard` drew, the zero-PII bar's verdicts and what
  `HttpCardRenderer` sent and returned (`tests/card_parity.rs`).

A slice replaces `Err(not_ported(..))` for its calls in `door/mod.rs` with its handlers, and passes
`WIRE_REPLAY_STRICT=<slice>` (the replay's stubs make every handler reach a dependency that refuses, so its owed answers
are each call's first dependency and its unset-setting refusals). Each slice adds database tests for what it writes.

## What the calls share

- **The caller is the signed principal.** Every call but `health` acts on `ctx.principal.userId`, never an id from the
  input; only `cardOf` names whose card to read, and the viewer is still the principal.
- **Owner settings, blank refuses.** `BLUEPRINT_CREW_CAPACITY` (`blueprint.crew_capacity_unset`),
  `BLUEPRINT_MENTOR_SHORTLIST_SIZE` (`mentor_shortlist_unset`), `BLUEPRINT_SEASON` (`season_unset`),
  `BLUEPRINT_SHARES_PER_OWNER` (`share_limit_unset`), `BLUEPRINT_OPENS_LIST_LIMIT` (`opens_list_limit_unset`):
  `published*` in `blueprint-service.ts`. A refusal is a 412 with its code; never a default.
- **The store.** Postgres schema `blueprint`, search path `blueprint,public`; writes that decide placement run
  `serializable` with up to five attempts (`transaction` from `@intafaced/db`, which retries a serialization failure). The two migrations are
  `services/svc-blueprint/drizzle/0000_blueprint_init.sql` and `0001_card_shares.sql`, copied into `migrations/`.
- **Rows are checked as read** (`BlueprintRow`, `ShareRow`, `OpenerRow`, `CrewRow`, ...): a row that fails its schema is
  a 500, not a guess.
- **The profile never leaves except to its owner**: not on an event, a span, an error message or a log line.
- **Events** (`packages/events/src/catalog.ts`, JetStream through `@intafaced/events`): `blueprintCreated` and
  `crewMemberCreated` after onboarding, `blueprintDeleted` after erase. svc-identity consumes `blueprintCreated` and
  `blueprintDeleted` (`profiles.blueprint_id`); `crewMemberCreated` is for svc-academy and svc-agents. Idempotency keys
  are business keys (`blueprint.created:<id>`, `blueprint.erase:<user>:<blueprint>`, the crew membership's).
- **Outside dependencies** behind one interface each: the Neural Engine (`engine/neural-engine.ts`: `http-engine.ts`
  over HTTP, `mock-engine.ts` in process, chosen by `BLUEPRINT_ENGINE_MODE`, never by fallback) and the card rasterizer
  (`card/card-renderer.ts`: `http-renderer.ts`, or `UnconfiguredCardRenderer` when `BLUEPRINT_CARD_RENDERER_URL` is
  unset, which still returns the vector card with a typed reason for no PNG).

## Where each call lives

| Call             | Kind, scope                 | Handler (`services/svc-blueprint/src/`)                                                                                                                                                     | Tables                                                                | Other parts                                                                                                                                                        |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `health`         | query, public               | `router.ts`                                                                                                                                                                                 | none                                                                  | served by the shell                                                                                                                                                |
| `me`             | query, `blueprint:read`     | `get`                                                                                                                                                                                       | `blueprints`                                                          | unmapped refusals                                                                                                                                                  |
| `setVisibility`  | mutation, `blueprint:write` | `setVisibility`                                                                                                                                                                             | `blueprints`                                                          |                                                                                                                                                                    |
| `mentors`        | query, `blueprint:read`     | `mentors`                                                                                                                                                                                   | `mentor_matches`                                                      | unmapped refusals                                                                                                                                                  |
| `onboard`        | mutation, `blueprint:write` | `onboard`: `deriveProfile`, `upsertBlueprint`, `placeInCrew` (`loadCandidates`, `formStartFreshCrew`, `formCrew`, `insertMembership`, `recordMatchRun`), `writeMentorShortlist`, `announce` | `blueprints`, `crews`, `crew_members`, `match_runs`, `mentor_matches` | the engine; `matching/crew-matching.ts`, `matching/mentor-matching.ts`, `deterministic.ts` (crew ids from a SHA-256 of their inputs, never randomness); two events |
| `card`           | query, `blueprint:read`     | `card`, `renderCard`                                                                                                                                                                        | `blueprints`, `crews`, `crew_members`                                 | `card/compose.ts` (the SVG, byte for byte), the renderer, `attestations/zero-pii.ts`                                                                               |
| `cardOf`         | query, `blueprint:read`     | `cardFor`: `visibleBlueprint`, `openThroughShare`, `shareCard`                                                                                                                              | also `card_shares`, `card_opens` (an open is logged)                  | `visibility.ts` (`mayViewCard`); denied and missing are one `NOT_FOUND`                                                                                            |
| `shares.create`  | mutation, `blueprint:write` | `createShare`                                                                                                                                                                               | `blueprints`, `card_shares`                                           | share limit setting                                                                                                                                                |
| `shares.list`    | query, `blueprint:read`     | `listShares`, `toCardShare`                                                                                                                                                                 | `card_shares`, `card_opens`                                           |                                                                                                                                                                    |
| `shares.revoke`  | mutation, `blueprint:write` | `revokeShare`                                                                                                                                                                               | `card_shares`                                                         |                                                                                                                                                                    |
| `shares.openers` | query, `blueprint:read`     | `shareOpeners`                                                                                                                                                                              | `card_shares`, `card_opens`, `crew_members`                           | opens list limit setting                                                                                                                                           |
| `export`         | query, `blueprint:read`     | `export`: `get`, `renderCard`, `sharesForExport`, `opensForExport`                                                                                                                          | every table, read                                                     | unmapped refusals                                                                                                                                                  |
| `erase`          | mutation, `blueprint:write` | `erase`                                                                                                                                                                                     | every table, deleted                                                  | `blueprintDeleted`                                                                                                                                                 |

`joinCrew` is not on the router (no record): it is ported with `onboard`'s membership code only if a caller needs it.

## The callers

- The customer app, through svc-edge's `/api/blueprint` prefix (`BLUEPRINT_URL`): `apps/customer/src/features/more/`
  (`Blueprint.tsx`, `blueprint-reads.ts`, `BlueprintSharedCard.tsx`, `BlueprintCrew.tsx`, the room). Each call is made
  by its record (`api.call(BLUEPRINT_..., input)`).
- No service calls svc-blueprint. svc-identity reads only its events.

## Slices

- `profile` (ported: `src/profile.rs`, `tests/profile_db.rs`): `me`, `setVisibility`, `mentors`; brought the
  migrations, the pool and the migrate binary.
- `onboard` (after `profile`): `onboard`; the engine client (HTTP and mock), crew and mentor matching, and the event bus.
- `card` (ported: `src/card/`, `src/zero_pii.rs`, `tests/card_db.rs`, `tests/card_parity.rs`): `card`, `cardOf`; the
  card's SVG, the renderer client (`card::renderer::from_env` picks it as `index.ts` does), visibility, the zero-PII bar
  and the share-link open.
- `shares` (after `card`): `shares.create`, `shares.list`, `shares.revoke`, `shares.openers`.
- `privacy` (after `onboard`, `shares`): `export`, `erase`.

After the slices, the switch: the binary (`/health`, `/ready` as `readiness.ts` reports the engine and renderer), the
Dockerfile and compose wiring, and the TypeScript service deleted in the same change.
