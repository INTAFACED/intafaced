# The shape: the one way to add each thing

Copy the example named here, not the nearest file: much of the code is older than this page and is the work list, not the pattern. Each rule says what fails if you take another way; where nothing fails yet, it says so.

## 1. A call between two parts: one record

Every call from the app to a service, or from one service to another, is written once as a record. The record holds the address, what goes in, what comes out, every refusal, who may call, and sample inputs. The route, the app's client and the published schema are made from it.

1. Write the record with `defineProcedure` (`packages/contracts/src/procedure.ts`) in the service's records file in `packages/contracts/src/`. Copy `packages/contracts/src/tax-procedures.ts`: `name`, `service`, `module`, `transport`, `kind`, `path`, `access`, `refusals`, `input`, `output`, `samples` (at least one `accept` and one `refuse`).
2. Run `pnpm --filter @intafaced/contracts procedures:write`. It writes `packages/contracts/src/procedure-registry.ts` and `packages/contracts/procedures.schema.json`; never edit either by hand.
3. The service mounts it: a service whose router is made from records adds one handler to its `mountRecords` call (copy `exampleRouter` in `packages/contracts/src/procedure-mount.test.ts`; a Rust service mounts its records the way `crates/svc-tax/src/wire.rs` does); in a router not made from records yet, the one call is `mountRecord(RECORD, handler, refusalOf)` from `@intafaced/contracts/procedure-mount`, in place of a hand-written `scopedProcedure(...)`. `refusalOf` reads the service's own error type, written once per service (copy `exampleRefusal` in `packages/contracts/src/procedure-mount.test.ts`).
4. The app calls `api.call(RECORD, input)`, importing the record from its `@intafaced/contracts/<file>` subpath (copy `apps/customer/src/screens/money/pnl-source.ts`). A check every caller needs on the reply goes in the record's `accept`; one only this caller needs goes in `api.call`'s `accept` option.

Never call by name (`api.query('bank', 'spaces.list', ...)`, `api.mutate(...)`), and never write a second schema for a call's input or reply.

What fails the other way: `apps/customer/src/app/recorded-calls.test.ts` (a recorded call named by its module and path in the app), `packages/contracts/src/procedure-registry.test.ts` (a stale registry or schema file), the record's own sample test (`crates/svc-tax/tests/procedure_samples.rs`), and `garden/no-hand-schema` (a schema copied by hand). A call by name to a call with no record yet fails nothing yet.

## 2. A feature: one folder, one entry

A screen goes in `apps/customer/src/screens/<id>/index.tsx` when its id is in `apps/customer/src/app/screens.ts`; every other room goes in `apps/customer/src/features/<area>/`, with its screens, calls and words together. Other code imports a feature only through its entry, `apps/customer/src/features/<area>/index.ts` (copy `apps/customer/src/features/pay/index.ts`), never a file inside it.

What fails the other way: nothing yet for an import into another feature's inside.

## 3. Each piece of state: one owner

Each service owns its tables and its settings; another service asks it through a record (rule 1) or an event declared in `packages/events/src/catalog.ts`. Only the ledger posts, and only through `packages/ledger-client/src/recipes/`. Only svc-identity owns people and freezes one account; the platform-wide posting freeze belongs to svc-ledger.

What fails the other way: `tooling/ci/boundary-scan.mjs` (one service's SQL on another's schema, a dependency on or import from another service), `pnpm scan:custody` (`tooling/ci/custody-scan.mjs`: a Protocol Plane service importing a ledger write recipe).

## 4. One way to do each thing in the app

- **Load data** with a data hook from `apps/customer/src/data/hooks.ts` (`useSource`) or `useResource` (`apps/customer/src/shared/resource.ts`); never a `useEffect` that fetches.
- **Route** through the area's routes file named in `apps/customer/README.md`; a new top-level screen id goes in `ScreenId` (`apps/customer/src/app/screen-types.ts`) first.
- **Draw** with `packages/ui` and its role tokens (`.claude/rules/design.md`); a part being moved keeps its exact output, bugs included.

What fails the other way: `garden/no-effect-in-product` (an effect in product code), `apps/customer/src/app/one-main.test.ts` (a page with two main landmarks), `tooling/ci/look-drift.mjs` (a raw colour, size or physical side). A second live stream fails nothing yet.

## 5. A service is put together in one place

A service builds its parts and passes them in once, at start-up, in `services/<service>/src/index.ts` (copy `services/svc-quant/src/index.ts`: each store and client is made there and handed to the service's constructor; a Rust service does the same in `crates/<service>/src/service.rs`, as `crates/svc-tax/src/service.rs` does). No module replaces another's function after start-up (`proto.placeOrder = ...`) or installs itself by being imported.

What fails the other way: nothing yet.

## 6. A list is made by code

A list of things the code already knows (records, services, packages, routes) is generated from them and checked for staleness; nobody keeps it by hand. Copy `packages/contracts/scripts/procedure-registry.mjs` (a file written from what it finds, with a `--check` that fails when stale).

What fails the other way: `packages/contracts/src/procedure-registry.test.ts`, `tooling/scripts/services-map.test.mjs` (`docs/SERVICES.md`), `tooling/ci/architecture-map.test.mjs` (`docs/ARCHITECTURE.md`, and every path this page names). A new hand-kept list fails nothing yet.
