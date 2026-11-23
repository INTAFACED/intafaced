# svc-academy (Rust)

The Academy. It replaced the TypeScript service (`services/svc-academy`, deleted in the change that made this crate serve; read it in git history before that merge), ported one slice at a time. Compose runs it from its own image (`Dockerfile`, after the one-shot `svc-academy-migrate`), and the local test stack builds and starts the binary.

## The door

Every call the TypeScript router serves is one row of `src/door/calls.rs`: path, query or mutation, scope or public, guarded or not, approval-gated or not, and the slice that owns it. `src/door/mod.rs` answers in the TypeScript's order: find the call and check its method; for a scoped call, authenticate, check the scope and the region; read and check the input; for an approval-gated call, check the operator and the approval ids; then the slice answers. A guarded call turns a refusal into its answer by the error table (`src/door/errors_table.rs`, through `errors::Refusal::guarded`); an unguarded one answers a 500 with the refusal's own words.

`calls.rs`, `errors_table.rs`, `schemas.json` and the parity fixtures were recorded from the TypeScript by `scripts/record-door.mjs`. With the TypeScript deleted they are the reference: a change to a call is made in these files and the Rust together, and the recorders (`scripts/record-*.mjs`) exit 2 saying there is nothing to record from.

## Where things are

| Module                  | What it holds                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/door/`             | the call table, the input checks (`inputs.rs`, zod's own verdicts through `service_kit::schema`), the dispatch |
| `src/errors.rs`         | `AcademyError`, every other refusal type, `user_copy`                                                          |
| `src/access.rs`         | the approval precheck, `read_approval_ids`, `payload_hash`                                                     |
| `src/ports.rs`          | one trait per outside dependency, each with its stand-in; `Ports::ready()` is `/ready`                         |
| `src/db.rs`             | `Store`, `transaction(pool, isolation, f)`, `transaction_retrying`, `sqlstate`, `refusal`                      |
| `src/settings.rs`       | the owner settings register (`admin.settingsStatus`)                                                           |
| `src/env.rs`            | every environment key, its default and refusal                                                                 |
| `src/slices/<slice>.rs` | each slice's handlers; a call not ported yet refuses as not ported                                             |
| `src/lobbies/`          | the lobbies' store, seat rules, scenes, calendar, stream provider and outside clients (`slices/lobbies.rs`)    |
| `migrations/`           | the `academy` schema's migrations (the TypeScript's `drizzle` files), built in; `svc-academy migrate [--down]` |

## Porting a slice

1. In `src/slices/<slice>.rs`, match `ctx.call.path` and answer it. `ctx.input` is the checked input (`service_kit::schema::Value`), `ctx.principal` the caller, `ctx.service()?` the pool, `ctx.ports` the outside world, `ctx.approval` the checked approval ids. Return `Ok(Some(json))`, or a `Refusal`.
2. Run the replay for the slice, which prints each answer it still owes:

```sh
WIRE_REPLAY_SLICE=<slice> cargo test -p svc-academy --test it -- wire_replay:: --nocapture
WIRE_REPLAY_STRICT=<slice> cargo test -p svc-academy --test it -- wire_replay:: # fails while <slice> owes any answer
```

The replay fails on any difference the door decides (401, scope 403, input 400, approval 412, the door's own calls, every refusal code's answer). The handler's answers are owed by their slice until they match.

Calls that consume an approval but are not flagged approval-gated in the table (`createSeason`, `revokeCert`, `grantCertException`) call `access::approval_precheck` themselves where the TypeScript handler does.

`tests/fixtures/lobbies-parity.golden.json` was recorded from the TypeScript (`scripts/record-lobbies.mjs`) and is the reference now.

## Tests

`cargo test -p svc-academy`. `tests/db_pg.rs` and `tests/lobbies_pg.rs` need a Postgres (`TEST_DATABASE_URL_ACADEMY` or `TEST_DATABASE_URL`, an admin database whose name ends in `_test`); without one it skips, and with `REQUIRE_POSTGRES=1` it fails.
