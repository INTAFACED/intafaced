# packages/contracts + packages/db — promise audit 2026-08-08

Tip: `32efec96`

33 promises checked, in both directions: database → TypeScript (does the type
agree with the CHECK?) and TypeScript → database (is there a backstop, or is the
only guard a code path raw SQL can bypass?). That second direction is the #1050
shape, and it produced three clean instances.

Nothing in this file was fixed in this session — see "parked" for why each one
is somebody's decision or somebody else's lane.

## Promises checked (33)

VERIFIED (14): money is never a float — every service `.sql` and `schema.ts`
searched for `real` / `double precision` / `float4` / `float8` /
`doublePrecision()`, zero hits, re-run with a positive control. Timestamps are
always tz-aware. `citext` requires the extension, and every path that runs the
migration creates it. `packages/db` holds no table definitions. CI asserts the
up/down pair exists (the gate is stronger than its own docstring claims). Schema
isolation is a real grant, not a convention — `CREATE SCHEMA … AUTHORIZATION`,
no REVOKE needed because PUBLIC never had USAGE. The statement timeout on money
paths. `assertTestDatabase` asks Postgres for `current_database()` rather than
trusting the URL. The per-run database always ends in `_test`. The sanctioned
Postgres probe is the only one. `infra-verdict` genuinely runs after turbo and
genuinely refuses to print COMPLETE while the unreported register is non-empty.
`verifyServiceCall`, `verifyForwardedPrincipal`, and raw-body byte preservation
all behave exactly as documented. `blueprints_profile_no_pii_ck` — a real DB
CHECK rejecting seven PII key names, matching its contract exactly. **This is
what the three broken ones below should look like.**

BROKEN (19): below.

## Broken, fixed here

None. Every finding is either in another session's lane or turns on a decision.
Stated plainly rather than padded.

## Broken, parked — with the reason

### Highest value first

**`amount()` says `numeric(38,18)`; svc-trade's `leverage` ships `numeric(8,2)`.**
`leverage` is taken verbatim from the request body, `parseAmount` accepts 18 dp,
and the **un-rounded** value computes `initialMargin`, which is posted to the
ledger — then Postgres rounds the stored `leverage` to 2 dp. The row's
`leverage` and `margin_initial` are then mutually inconsistent and the API
reports a leverage the money was not sized with. The only constraint is
`CHECK (leverage > 0)` — range, not scale. Only svc-ledger has a schema-drift
test; svc-trade and svc-pay have none.
**Parked:** the fix is a migration in `services/svc-trade`, which `claim-check`
reports **human-claimed by @Nitro (trade.mm-bot)** — "an agent must NOT implement
here." This is the one finding in this audit where a live money path is
currently wrong, and it needs either an `agents free on <path>` ruling or a
human. One `SELECT 3.567::numeric(8,2)` settles the last untested link (that
Postgres rounds rather than rejects); ~95% confident from documented behaviour,
not run.

**S2S body binding can never be turned on.** `raw-body.ts:94` promises that a
service requiring body binding without it "rejects every caller with
`body-unavailable` — loudly … because the alternative is accepting unverified
bodies while believing otherwise." `verifyServiceHeaders` takes a third options
argument carrying the mode; `edge.ts:205` calls it with **two**. Options default
to `{}`, so the mode is `accept-both` permanently, for every `serviceProcedure`.
An operator can set `INTERNAL_SERVICE_BODY_BIND=require` — the variable is on
the shared env schema, so it is accepted — and believe replay is closed. Nothing
changes; a captured v1 signature stays replayable against any body for 300s.
**Parked:** the fix is an API change to `EdgeContextOptions` plus per-service
wiring, and it flips a security posture across seven services, two of them on a
claimed mountain. That is a decision with an argument attached, not a patch.

**The read-only marker short-circuits the whole writer denylist.**
`ops-analytics-warehouse.ts:82` promises "writer-looking usernames are refused
even if role claims 'readonly'". The marker check returns `{ok:true}` **before**
the forbidden-fragment loop, and `_ro` is a substring of `_role` and `_root`. So
`writer_role`, `postgres_root`, `admin_role` and `svc_ledger_rw_rotator` all
pass; only a bare `svc_ledger` is refused. Currently latent — nothing calls the
function yet.
**Parked only for lane discipline** — this is a genuine three-line correctness
fix in `packages/contracts` (run the loop first, or anchor with `endsWith`) and
is the single best next unit for whoever takes this file.

**The "honesty" module is unexported, uncalled, and its money-law check tests
nothing.** `analytics-metric-honesty.ts` is absent from `index.ts`; the only
repo-wide reference is a filename in a KEEPERS array in a CI scan.
`moneyMetricsRefuseNumber()` is documented as "money metrics must not use number
values" and its body is `listMoneyMetricIds().length > 0` — it never inspects a
value's type and cannot return false while any money metric exists. The gate
guarding it checks `existsSync` only, and its reachability loop explicitly skips
any file that imports repo code, which this one does. **Anti-vacuity confirmed:
the gate proves the file exists and nothing else.**
**Parked:** deleting is the lazy fix; whether this is scaffolding for something
planned is a product call.

**64 of 68 `.down.sql` files have never been executed.** `migrate.ts:6` quotes
§14 "All schema migrations reversible **and applied in CI**". `up` genuinely is.
`down` runs in exactly one place repo-wide — svc-indexer's own store test,
covering its 4. The `--down` flag exists in every service's migrate script and
is invoked by no workflow, no root script, no test. The repo writes its own
indictment next door: _"A reversal that has never been executed is a file, not a
rollback plan."_ `services/svc-bank/drizzle/0001_position_pending.down.sql` is a
comment plus `SELECT 1;` — it satisfies the non-emptiness check and reverses
nothing.
**Parked:** the fix is a CI job that applies and reverses every migration. That
is real CI minutes, and the `SELECT 1;` proves some reversals are genuinely
impossible. Someone has to decide what "reversible" means here.

**A suite probes an external dependency, skips on every CI run, and is invisible
to all three honesty mechanisms.** `infra-journal.ts:41` claims "**every** probe
for an external dependency writes one line here, whichever way it went."
`cors.browser.e2e.test.ts` is `describe.skipIf(!chromium)` and records nothing —
it _cannot_, because `InfraDependency` is `postgres | evm-chain | nats` and
there is no `browser`. It is not on the unreported-suites register, and the
skip-honesty scan matches only three hardcoded probe shapes, none of them a
dynamic playwright import. And it skips every run: no workflow installs the
browser (zero playwright hits under `.github/`, against a positive control).
This is the exact "92 successful, 92 total" false green the journal was built to
kill, one dependency over — on the only suite that proves CORS is enforced.
**Parked:** two options with different costs — install playwright in CI
(restores the proof, costs minutes) or add `'browser'` to `InfraDependency` and
journal the skip (cheap, closes the false green, restores nothing). That is a
budget call.

### The #1050 shape — three instances, all fail-closed today

- **`instruments.ts:381`** requires `symbol === base/quote`. svc-trade's CHECKs
  cover base≠quote, tick, lot, qty, bps and listed_at — **no symbol↔pair check**.
  `INSERT … VALUES ('BTC/USDT','ETH','USDC',…)` passes everything, and the
  unique index is on `symbol` alone, so the row is addressable and disagrees
  with itself.
- **`identity.ts:36`** types `rank: z.number().int().min(0)`. The DB CHECK covers
  `xp` and `season_xp` only. `UPDATE identity.rank_state SET rank = -1`
  succeeds; every later `rank.get` then throws on **output** validation.
- **`blueprint.ts:60`** requires 8 profile keys; the DB CHECK requires the 5
  axes. A hand-written 5-axis row satisfies the database and fails the contract
  in svc-academy and svc-agents.

**Parked:** each is a one-line migration, and each is in a service outside this
lane (`svc-trade` is human-claimed; `svc-identity` and `svc-blueprint` belong to
other sessions).

### Smaller, recorded so they are not re-derived

- **`instruments.ts:33`** — "There is not a `number` in this file that describes
  a price or a size", and `:417` compares `Number(maxQty) < Number(minQty)`.
  `minQty: '1.000000000000000001'` and `maxQty: '1'` both `Number()` to `1`, so
  the refine passes and the schema accepts maxQty < minQty. The DB does catch
  it, so this is a contracts-layer defect only. One-line fix.
- **`instruments.ts:338`** — "All three agree because this is the one place the
  shape is declared" is false: the only symbols any service imports are the
  three schedule helpers. `instrumentSchema`, `INSTRUMENTS`, `instrumentById`
  and `instrumentsForPlane` have zero non-test references, no market row is ever
  parsed through it, and `packages/exchange-contract` carries none of the three
  fields the file names as its reason to exist.
- **`bps()` "stored as a plain integer"** — `numeric(8,0)` is not an integer
  type, returns a string, and silently rounds a fractional input. svc-bank
  contradicts the docstring in writing and uses `integer` deliberately. No
  reachable silent-rounding write today; held shut by author discipline.
- **`testing.ts:410`** still documents `STALE_AFTER_MS` as "2h" after `:54` set
  it to 15 minutes, and the "~700x headroom" beside it was computed against the
  old value. Comment only.
- **`ops-analytics.ts:26`** names `liveMaxLagSeconds: 60` the live ceiling while
  `lagFreshness` returns `live` only at ≤30. Fail-closed, but the number
  republished to operators is the wrong one.

## Could NOT break, having tried

`verifyServiceCall`, attacked with whitespace / `+` / exponent timestamps (the
preimage is rebuilt from the parsed value, so they canonicalise), upper-case /
short / `0x` digests (the pattern is anchored), the `Buffer.from('zz','hex')`
empty-buffer equality trick (length is checked first), and v1↔v2 confusion (v2
is domain-tagged and length-prefixed). `verifyForwardedPrincipal` — omitting the
region header to strip jurisdiction binding fails the signature, because the
region is inside the preimage; signature-before-`JSON.parse` ordering holds.
Raw-body byte preservation — the buffer is retained before the parse and nothing
re-serialises. Float money, naive timestamps, `amount()` returning a string
(read from the installed drizzle typings for both versions on disk).
`migration-check.mjs` is the strongest anti-drift construct found: it strips
comments, requires a real statement, checks destructive-verb acknowledgement,
discovers services by glob with an exact 68/68 pairing, and fails if `ci.yml`
stops running it.

**Method note worth carrying forward:** the first float-money sweep used `\b` in
`git grep -E`, which POSIX ERE does not support. It matched zero and would have
passed forever. Every negative in this file was re-run with a positive control.
**That test is worth applying to any CI scan in this repo** — a scan that cannot
match is indistinguishable from a codebase that is clean.
