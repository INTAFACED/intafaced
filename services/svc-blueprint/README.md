# svc-blueprint

**The Identity Blueprint (§7.1).** Phase 4.

Onboarding runs a guided session, the **Neural Engine** derives a profile from it, and this service persists that profile, places the user in a crew on complementary-profile heuristics, and shortlists mentors. It also owns the two promises §7.2 makes to the user: **export** and **hard delete**.

It also **composes the share card** — the acquisition artifact of §7.1 — at the two share sizes §7.2 names.

**What this service is not:** it does not hold balances, it does not contain the engine, and it does not rasterize. The engine is an external deployment reached over an HTTP contract at `BLUEPRINT_ENGINE_URL`; the card rasterizer is another, at `BLUEPRINT_CARD_RENDERER_URL`. What lives here are the `NeuralEngineClient` and `CardRenderer` interfaces in front of them.

---

## Branding — Doctrine §0.7

> User-facing copy references only: **Identity Blueprint**, **Sovereign Intelligence**, **Neural Engine**.

In this package the rule is stricter than "user-facing". No third-party system name appears anywhere — not in a comment, not in a variable, not in a test fixture, not in a migration. This is the one service where someone would naturally type a vendor's name while explaining what the engine does, so the rule is absolute here rather than contextual.

Two things enforce it:

- `pnpm scan:brand` — repo-wide, in CI (`tooling/ci/brand-scan.mjs`).
- `src/brand.test.ts` — the same rule, run against this package as part of its own suite (§7.2's copy-scan, asserted from the inside). It reads its vocabulary out of the scanner rather than duplicating it, so this package contains no forbidden name even in the test that hunts for them. It is deliberately stricter than the repo scan: it also covers `.sql`, which `brand-scan.mjs` skips.

---

## API

tRPC (`src/router.ts`). Owner procedures operate on `ctx.principal.userId` and never on an id from the input — there is no "export that account" path, by design. `cardOf` is the exception: its input names whose share card, and visibility decides.

| Procedure       | Scope             | Purpose                                                                         |
| --------------- | ----------------- | ------------------------------------------------------------------------------- |
| `health`        | public            | Liveness                                                                        |
| `onboard`       | `blueprint:write` | Session → engine → profile → crew placement → mentor shortlist                  |
| `me`            | `blueprint:read`  | The caller's own Blueprint                                                      |
| `card`          | `blueprint:read`  | **§7.2 share card** — the caller's own, at either share size                    |
| `cardOf`        | `blueprint:read`  | Someone else's share card — gated by `blueprints.visibility` (not a public URL) |
| `setVisibility` | `blueprint:write` | Change the caller's own `private` / `crew` / `public`                           |
| `mentors`       | `blueprint:read`  | The caller's mentor shortlist — its own query, not `export()`                   |
| `export`        | `blueprint:read`  | **§7.2 portable** — everything this service holds, as JSON                      |
| `erase`         | `blueprint:write` | **§7.2 deletable** — hard delete that cascades                                  |

HTTP: `GET /health`, `GET /ready`. `/ready` is process-up (`ready: true` after listen). It reports `engine.usable` and `engine.mode` but does **not** flip `ready` off the 60s `isUsable` window — the HTTP adapter starts unusable until the first profile call, and gating kube on that would never admit the pod. Prod refuses `BLUEPRINT_ENGINE_MODE=mock` and a loopback/unset `BLUEPRINT_ENGINE_URL` at boot. The card renderer is reported and does **not** gate either: a card can be produced without a rasterizer, and refusing traffic because the PNG rail is absent would take down onboarding over a share image.

`blueprint` is non-custodial and `minTier: 'none'` in `JURISDICTION_MATRIX`, so the guard checks scope and region, not verification tier.

---

## Events

**Publishes**

| Subject                                   | When                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| `intafaced.blueprint.blueprint.created`   | A Blueprint exists — svc-identity sets `profiles.blueprint_id` |
| `intafaced.blueprint.crew_member.created` | Crew placement — svc-academy routes the lobby                  |
| `intafaced.blueprint.blueprint.deleted`   | Hard delete — every consumer drops cached profile data         |

**Consumes** — nothing yet.

**No payload on this bus carries profile content.** Not an axis, not a guardrail, not a curriculum path. Consumers that need the profile read it back through `packages/contracts` under the user's own authority. `crew_member.created` carries `role` because that is the crew's shape and svc-academy needs it to route a lobby.

### The identity reference is set and cleared by event, not by SQL

`profiles.blueprint_id` lives in svc-identity's schema. §2 forbids this service writing it. So:

- on create, `blueprintCreated` carries the id svc-identity stores;
- on erase, `blueprintDeleted` tells it to clear the field.

`blueprintDeleted` is keyed `blueprint.erase:<userId>:<blueprintId>` for the blueprint that was just erased. A redelivery of that erase shares the key. A later hard delete of a new blueprint is a different key, so a consumer that dedupes still clears the new id. svc-identity clears `profiles.blueprint_id` only when it still matches the payload blueprintId, so a late duplicate of an earlier erase cannot clear a blueprint the user has since created.

> ### Cascade completes across the bus (identity consumer on tip)
>
> `svc-identity` subscribes to `blueprintCreated` / `blueprintDeleted` via
> `subscribeBlueprintProfileEvents` (`events.ts` → `blueprint-profile.ts`) and
> sets/clears `profiles.blueprint_id` under §2. Unit proof lives in
> `svc-identity` `blueprint-profile.test.ts` (match-guard on redelivery /
> re-onboard). Blueprint-side `IdentityProjection` in tests remains a stand-in
> for _our_ publish half only — end-to-end cascade ownership is the identity
> subscriber, not that mock.
>
> Tracker mountain `blueprint.ownership` is **done** for Stage A honesty: docs +
> note match code. Residual (optional multi-service e2e, legal hold policy) is
> not a reopen of this mountain.

---

## Ledger

**This service holds no balances and posts no ledger transactions.**

There is no `@intafaced/ledger-client` import in this package and there should never be one. `crews.xp` is a count of shared achievement — it is deliberately a `bigint` and not `numeric(38,18)` so it can never be mistaken for a balance, and a test asserts that no `numeric` column exists anywhere in the schema. Doctrine §0.6 is satisfied here by there being no value to hold.

Crew treasuries are a real future feature (§33 Crew Vaults, Phase 5P) — and when they land, the money lives in the ledger and in `svc-protocol`, not here.

---

## The engine interface

`NeuralEngineClient` (`src/engine/neural-engine.ts`) is the whole surface of the dependency:

```ts
interface NeuralEngineClient {
  readonly id: string;
  readonly capabilities: readonly EngineCapability[];
  health(): EngineHealth;
  profile(request: BlueprintRequest): Promise<EngineProfileResult>;
}
```

Shape mirrors `LiquiditySource` in `packages/venue-adapter` (§5.2) on purpose — id, capabilities, synchronous `health()` for routing decisions, async work. An engineer who has read one adapter has read both.

Two implementations:

- **`HttpNeuralEngineClient`** — the real one. One POST, one schema check, one error taxonomy. It does not log the request body, does not retry on its own, and does not fall back to a default profile. A fabricated profile is indistinguishable downstream from a real one and would place a real person in a crew on the strength of a timeout.
- **`MockNeuralEngine`** — deterministic. The same session yields the same profile, always, which is what lets the tests assert a _specific_ placement rather than merely that one happened. `requestId` is excluded from the derivation: it identifies the call, not the person.

`BLUEPRINT_ENGINE_MODE` selects between them **explicitly**. There is no fallback to the mock when the real engine is unreachable — that would hand stub profiles to real people and look healthy doing it.

---

## Determinism

> A user who re-runs matching must land in the same crew.

Held up by four things:

1. **The scorer is pure.** `matching/crew-matching.ts` has no clock, no randomness and no I/O. Tested without a database.
2. **Ties break on crew id.** Equal scores are common. Postgres does not promise row order, so an unbroken tie would make placement depend on the order rows came back — a function of the candidate _set_ is the requirement, not of the sequence it arrived in.
3. **New crew ids are derived, not generated.** `newCrewId(season, founder)` is a hash. A retried placement forms the same crew instead of stranding an empty one; `gen_random_uuid()` would leave litter behind every network blip.
4. **Placement short-circuits on existing membership.** Re-running onboarding does not move anyone. The crew name is derived from the crew id too, so it survives a restore that a counter would not.

`Math.random()` and `Date.now()` appear nowhere on these paths. Timestamps are written (`match_runs.ts`); none is read back by anything that decides where a person goes.

### Complementary, not similar

The score rewards **difference**: a candidate scores highest against the crew that shares least with them. A crew of four people who all decide analytically has one perspective and four voices.

`crewRole` carries the most weight — four builders and no anchor is a crew that ships nothing and notices nobody. Rhythm and learning mode carry the least: a crew that disagrees about when to wake up has a scheduling problem, not a blind spot.

`EMPTY_CREW_SCORE` (6000 bps) is the one genuinely arbitrary number, and it does real work: **"best available" is not "good enough"**. A crew scoring below it loses to forming a new one, which is what keeps someone out of a crew of their own clones. Set it higher and the population shatters into crews of one; set it to zero and the echo chamber wins.

**The mentor heuristic is deliberately different.** A mentor should _differ_ in judgement (that difference is the lesson) and _match_ in learning mode (that sameness is the channel). Reusing the crew scorer here would shortlist mentors who cannot teach the student they were matched with — there is a test that fails if someone "simplifies" it that way.

---

## PII — §10

The profile is PII-adjacent. What the user actually said is PII outright.

- **Raw session input and birth data are never persisted.** They cross the wire to the engine and are dropped. There is no column for them, and that absence is the control — a column that does not exist cannot leak, cannot be logged, and cannot be recovered from a backup.
- A CHECK constraint (`blueprints_profile_no_pii_ck`) rejects a profile blob carrying `birthData`, `responses`, `transcript` and friends, so a future caller cannot smuggle session input into the column that four other services read.
- **The profile is never logged, never traced, never put on an event.** `BlueprintSpanAttributes` in `tracing.ts` is a closed type: every field is an id, a count, a duration or an enum. Adding to it is a deliberate act, visible in a diff.
- Error messages carry no session content — there is a test for that.
- An export lists crewmates by id and role, never by profile. A crewmate consented to being in a crew, not to being in someone else's data export.

---

## Deletion cascades — §7.2

`erase()` is a hard delete: not a soft delete, not a tombstone, not an anonymisation. One transaction, and afterwards no row in this schema references the user.

| What                                    | Why it is easy to miss                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `mentor_matches` on **both** columns    | Deleting only `student_id` leaves the user on other people's shortlists           |
| `match_runs`                            | Keyed by user; they hold crew ids and integers only, so deleting them is complete |
| `crew_members`                          | —                                                                                 |
| `blueprints`                            | —                                                                                 |
| Crews the departure emptied             | Otherwise a crew of zero still appears in matching and still carries a name       |
| `profiles.blueprint_id` in svc-identity | Cleared by **event** — §2 forbids writing another service's tables                |

Idempotent: erasing twice removes nothing the second time and publishes once. A user can onboard again afterwards and gets a genuinely new Blueprint, not a resurrected one.

---

## Database constraints as a backstop

The service checks these; the database enforces them regardless.

| Constraint                       | What it catches                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `blueprints_profile_no_pii_ck`   | **session input smuggled into the profile blob**, where it would then be exported everywhere |
| `blueprints_profile_shape_ck`    | a profile missing an axis, failing later as an unreadable score inside a match run           |
| `blueprints_user_idx` (unique)   | two Blueprints per account — "which one is you" resolved by whichever row was read first     |
| `crew_members_user_idx` (unique) | a retried placement putting someone in two crews                                             |
| `mentor_matches_pair_idx`        | a re-run stacking a duplicate row that appears twice in one shortlist                        |
| `mentor_matches_not_self_ck`     | a self-match scoring maximally on every affinity axis by construction                        |
| `crews_capacity_positive_ck`     | a capacity-0 crew that can never accept the member it was formed for                         |

---

## §13 socket — placement contention at Drop I

**This is the thing most likely to break §7.2's "under 3 minutes", and it is not the code being slow.**

Every `onboard()` call reads _every_ open crew in the season (`loadCandidates`) and then writes a `crew_members` row, all inside one `serializable` transaction. That is precisely the read-write overlap `serializable` exists to detect, which is correct — it is what stops two people both joining the last seat in a crew. The cost is that concurrent onboarding transactions abort and retry each other.

At normal load that is invisible: `maxAttempts: 5` with jittered backoff absorbs it, and the whole call runs in well under a second.

The problem is **Drop I is the Blueprint drop** (§11) — the one moment in the launch sequence when a large number of people onboard simultaneously, which is exactly when every transaction is contending over the same small set of crews. The failure mode is not a slow query; it is retry storms and `blueprint.onboarding` transactions exhausting their attempts. The three minutes would be spent in backoff, not in code.

Two compounding factors, both currently fine and both scaling badly:

- `loadCandidates` is an unbounded aggregate over all crews in the season. Fine at hundreds; a full scan at hundreds of thousands — inside the serializable transaction, which widens the conflict window in proportion.
- The conflict window covers the engine-independent part of onboarding only (the engine call is deliberately outside the transaction), but it still spans the candidate scan, the placement insert and the mentor shortlist write.

**Sockets, in the order they would be fitted:**

1. **Bound the candidate set** — filter to open, recent, in-season crews with a supporting index, and cap the number scored. Placement quality barely moves; the conflict window shrinks by orders of magnitude. Determinism is preserved as long as the bound is itself deterministic (an `ORDER BY` plus `LIMIT`, never a sample).
2. **Serialise placement per candidate crew** rather than per transaction — take the crew row lock first and drop to `read committed`, the pattern `packages/db`'s `transaction()` documents for exactly this case. Transactions then queue on a lock instead of aborting one another.
3. **Queue placement behind the reveal.** The user-visible flow is signup → session → reveal; crew placement does not have to be synchronous with it. Making placement a job would take it off the 3-minute path entirely and remove the spike from the request path.

None of this is needed for correctness today, and none of it is speculative work worth doing before there is load to measure. It is written down because the moment it matters is a launch, and a launch is the worst time to discover it.

---

## The share card — §7.1, §7.2

§7.1 calls it "the acquisition artifact, treat it as a product". §7.2 makes it an exit criterion:

> Card renders pixel-perfect at share sizes (1080×1350, 1200×630); no third-party system names anywhere in output (automated copy-scan test in CI)

**Composition is ours; rasterization is a rail.** That split is Doctrine §0.4, and it is the whole design:

| Half                               | Where                  | Needs              | Can it be absent?     |
| ---------------------------------- | ---------------------- | ------------------ | --------------------- |
| Compose the card (SVG)             | `card/compose.ts`      | nothing            | **No** — always works |
| Rasterize + host it (PNG at a URL) | `CardRenderer` adapter | renderer + storage | **Yes** — and says so |

`composeCard()` is a pure function: profile and crew in, SVG out. No clock, no randomness, no I/O. The SVG is **not a preview or a fallback** — it is a complete, resolution-independent card. What needs the rasterizer is a _hosted PNG at a URL_, because that is what a social platform fetches to unfurl a link.

### The rule that matters most

**No failure may produce a URL.** Every `HttpCardRenderer` failure path — timeout, transport error, non-2xx, non-JSON body, contract mismatch, zero bytes — returns `{ status: 'unavailable', code, reason }` and never a URL, and never throws. A fabricated asset URL is stored in `card_asset_url`, goes into an `og:image` tag, and is discovered when a share unfurls as a broken image on somebody else's timeline — precisely the moment this artifact exists to work.

`card_asset_url` is written **only** on a real render, **only** for the portrait, and **only** by `card` — never by `export`. §7.1's schema has one card column and portrait is the primary artifact, so letting the OG image overwrite it would make the column mean "whichever size was asked for last". And `export` is a tRPC `.query()`: retried, prefetched and cached, so it carries the card (`renderCard`, no writes) without acquiring `card`'s side effect. For the same reason `mentors` reads `mentor_matches` directly instead of plucking a field off `export()` — otherwise a shortlist request would compose an SVG and wait on an external rasterizer.

### It carries no personal data. None.

No name, no handle, no avatar, no birth data, no user id, no timestamp. Everything drawn is either derived by the Neural Engine (the five axes) or a crew's derived name. Two consequences, and both are the reason:

1. A card carrying nothing personal is **safe to make public by default** — and it is the one object here designed to leave the service.
2. There is no caller-supplied text, so it cannot be turned into a public renderer of arbitrary strings in INTAFACED branding.

**Open owner question:** whether a user may put their own display name on the card. It is the obvious product ask and it has a real abuse dimension, so it is not something this service decided on its own.

### The brand is read, not restated

Colours come from `@intafaced/ui/tokens` — the `/tokens` subpath carries no React. `packages/ui/src/tokens.ts` says "nothing hard-codes a hex outside this file", and a test fails on any hex in the card that is not a token. An acquisition artifact is the last place to invent a shade of orange.

Fonts are the token stacks, and they end in `system-ui`. A rasterizer without the brand display face produces a legible card in a system font — not a failure, but not the designed artifact either. Font provisioning belongs to whatever implements `CardRenderer`; nothing on this side can detect it.

### What is asserted

- Both canvases as **literal numbers** — 1080×1350 and 1200×630 — as `width`/`height` attributes _and_ a matching `viewBox`. (Attributes without a viewBox scale the artwork; a viewBox without attributes lets the rasterizer choose the resolution, and §7.2's numbers would then depend on renderer defaults.) The literals are written out rather than read from `CARD_DIMENSIONS`, so the test disagrees with the code instead of agreeing with it by construction.
- The §7.2 copy-scan runs on the **rendered output**, across every profile value the contract allows, with a negative control — a forbidden name could reach the card through an enum value without ever being typed in a file.
- Determinism, in-canvas bounds, tag balance, XML escaping (including a `<script>` smuggled through a crew name), and no UUID or date anywhere in the output.

### Configuration

| Variable                             | Default | Meaning                                                               |
| ------------------------------------ | ------- | --------------------------------------------------------------------- |
| `BLUEPRINT_CARD_RENDERER_URL`        | _unset_ | No renderer. Vector card still renders; raster reports `unconfigured` |
| `BLUEPRINT_CARD_RENDERER_TIMEOUT_MS` | 10000   | Shorter than the engine's 20s — nothing is waiting on the PNG         |
| `BLUEPRINT_CARD_RENDERER_API_KEY`    | _unset_ | Bearer token. Never logged                                            |

There is deliberately **no default URL**. One pointing at a host that does not exist would turn "this deployment has no renderer" — a permanent, honest state a surface can render immediately — into a timeout on every card request. Note that compose writes `${BLUEPRINT_CARD_RENDERER_URL:-}`, which sets the variable to the _empty string_ rather than leaving it absent; the schema normalises `''` to unset, and `env.test.ts` exists because without that the service crash-loops at boot over a rail it does not need.

**This stack has no rasterizer and no object storage**, so `blueprint.card` here returns a full SVG and `blueprint.card_renderer_unconfigured`. That is the honest state, not an outage.

---

## Not in this feature

- **A hosted PNG.** See above — the adapter exists, the rail does not, and the service says so rather than pretending.
- **Unauthenticated public card URLs.** `cardOf` is authenticated and gated by `blueprints.visibility` (`private` = owner only, `crew` = same crew, `public` = any signed principal). Denied and missing are the same `not_found`, so private Blueprints are not enumerable by id. A session-less unfurl URL (OG crawlers, share tokens) is still unbuilt — that is object storage + a revocable token (`ops.social-promotion` / Class X), not this procedure.
- On-chain rank attestations (`blueprint.attestations`, §19) — **leftover Shehzad**. D26-P1-I4 ships Fiat-plane refuse: PII on a card/attestation DTO fails by named code; product Done stays refused while the P0-12 threat-model bar is unmet (`docs/THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md`). This service does not write a chain.
- Crew vaults (§33) — Phase 5P, and the money lives in the ledger when it arrives.

---

## Shared-package changes in this PR

§15.2 says a shared-package change should be its own PR first. Flagging these rather than burying them:

- `packages/contracts/src/blueprint.ts` — **new.** The profile schema and the export/erase envelopes. §7.1 names three read-only downstream consumers of `blueprints.profile` (svc-trade, svc-academy, svc-agents); they read it through here and never import this service.
- `packages/events/src/catalog.ts` — three events added. The bus validates against the catalog, so this is unavoidable rather than optional.
- `packages/auth/src/scopes.ts` — `blueprint:read` / `blueprint:write`, plus the implication. `Scope` is a closed union; without these the router would have to authorise Blueprint access on an unrelated module's scope.
- `packages/contracts/src/blueprint.ts` — the card contract: `CARD_DIMENSIONS`, `cardSizeSchema`, `cardRasterSchema` (the `rendered | unavailable` union), `cardRenderSchema`, and `card` on `BlueprintContract`. `blueprintExportSchema` goes to **schemaVersion 2**, adding `card` — §7.2 promises "export (JSON + card)", and an export without the card was JSON only. Bumped rather than added silently: the literal exists so a consumer reading an archive can tell which shape it holds.
- `@intafaced/ui` is now a dependency of this service, for `@intafaced/ui/tokens` only. That subpath is plain data with no React import (`primitives.tsx` is a separate entry point and is never loaded here), and `packages/ui` is already in the Dockerfile manifest. The alternative — restating the brand hexes in this package — is the thing `tokens.ts` explicitly forbids.

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-blueprint db:migrate
pnpm --filter @intafaced/svc-blueprint test
pnpm scan:brand
```

## Tests

The matching heuristics are pure functions, tested exhaustively without a database — determinism under 200 repeated runs and under permutation of the candidate list, monotonicity, integer range across every crew size, tie-breaking, and the threshold that keeps someone out of a crew of clones.

The service paths run against real Postgres, because the parts most likely to hide a bug are the transaction boundaries: the placement that must not overfill a crew, and the erasure that must not leave a row behind. Neither is observable against a fake. The suite skips itself when Postgres is unreachable rather than failing.

Failure branches covered: an unavailable engine (nothing written, nothing announced, no session content in the error), a full crew rejecting a join, five concurrent joins against two seats, erasing a user who never onboarded, erasing twice, and onboarding again after erasure.
