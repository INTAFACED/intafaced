# Pay simulator (W12)

**TEST DATA — no real money, no real merchants, no real keys or vendors.** This
CLI calls the existing `PayService` with real PostgreSQL, the reference
`MemoryLedger`, `MemoryChain` and actual `CryptoNativeAdapter`. PSP, broker and
gaming are synthetic scenario labels, not an accepted business classification.

From the repository root, build dependencies once:

```sh
pnpm exec turbo run build --filter=@intafaced/svc-pay --concurrency=1
APP_ENV=test TEST_DATABASE_URL=postgres://LOCAL_TEST_ROLE:LOCAL_TEST_PASSWORD@localhost:5433/intafaced_test pnpm --filter @intafaced/pay-sim simulate --iterations 2 --timeout-ms 60000
```

The shown credentials are placeholders. Use an existing **local** test PostgreSQL
role with `CREATEDB`. Only `localhost`, `127.0.0.1` and `[::1]`, a database ending
`_test`, and an explicit `APP_ENV=test` are accepted. Remote hosts, live database
names and URL query overrides refuse before connection. The CLI never starts a
database or contacts a vendor. It prints fixed failure text without connection
strings or credentials.

Each iteration runs one payment per archetype, alternates USDT/BTC across
iterations, captures, partially refunds and pays out the remainder. Amounts
(`100.25/10.01`, `80/5`, `40/1`) and zero fee bps are **TEST VALUES**. They are not
commercial terms. All value is synthetic; no conversion between assets occurs.

For each payment it redelivers signed sandbox events, retries the refund and
payout, injects three rail failures, then installs a PostgreSQL trigger that
rejects the durable rail outcome **after** the sandbox chain has sent. Recovery
must reuse the original broadcast. The failure hook is restored in `finally`.

The run independently checks every ledger transaction per asset, the ledger hash
chain/reconciliation, exact outbound keys/amounts/assets/destinations, and every
metrics projection row against a separate bigint loop over source rows. It
rebuilds metrics from empty and checks again. It reports verified checks only
after those assertions pass.

Iterations default to 1 and are capped at 100. The deadline defaults to 60 seconds
and cannot exceed 120 seconds. Each effect checks the deadline. SQL connection,
statement and lock waits are limited to 3 seconds, 5 seconds and 1 second. Expiry
or Ctrl-C cancels tracked clients and cleans up only the generated
`pay_sim_<random UUID>_test` database; there is no database enumeration or stale
database sweep. Dropping that database has its own budget: 3 seconds to connect
and 9 seconds for the drop, whose forced checkpoint is slow on a busy shared test
server. A cleanup failure refuses a pass report. A final CLI watchdog terminates
at deadline plus 17 seconds (startup headroom, then the cleanup connect and drop)
if startup or cleanup unexpectedly hangs; forced termination is an error and never
a successful run.

The capability manifest is pinned to main
`6e618f75a8ffd2ef7d254f72bbecbf29c559331f` (2026-10-17). On that commit, read from
this tree: W1 merchant-control guards and W5 halt guards exist (caps default off;
automatic storm trip is not in the halt guard). The W6 conversion service is in
`services/svc-pay/src/conversion/`; `createW6ConversionGuards` still returns
nothing. The W9 screening slot `createW9ScreeningGuards` still returns nothing.
This simulator does not assert W1, W5, W6 or W9. It reports that, and it does not
report them as passing. The payout DB fault exercises an existing payout seam.

```sh
# Local safety/oracle/CLI/fixture tests, no PostgreSQL connection:
pnpm --filter @intafaced/pay-sim test:unit

# Mandatory real PostgreSQL acceptance tests plus unit tests:
APP_ENV=test TEST_DATABASE_URL=postgres://LOCAL_TEST_ROLE:LOCAL_TEST_PASSWORD@localhost:5433/intafaced_test pnpm --filter @intafaced/pay-sim test
```

The normal workspace `test` script discovers these tests through `tooling/*`.
Missing PostgreSQL fails the package test; it never returns a green skip. The
Vitest config explicitly sets `APP_ENV=test` and the existing test-only screening
fixture bypass. Production services and shared CI files are unchanged.
