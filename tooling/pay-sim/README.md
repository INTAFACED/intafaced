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
database sweep. Cleanup is bounded to 5 seconds and a cleanup failure refuses a
pass report. A final CLI watchdog terminates at deadline plus 10 seconds if
startup or cleanup unexpectedly hangs; forced termination is an error and never
a successful run.

The capability manifest is pinned to main
`b8b8cbb220dda79f71401dadb8825ded2de91992`. At that base the W1 caps/approval
controls, W5 halts/exposure/automatic storm trip, W6 conversions/venue orders and
W9 screening provider are not built. Their assertions are explicitly reported as
**not built at pinned base**, never as passing. The payout DB fault exercises an
existing payout seam; it does not claim to test an unbuilt conversion order.

```sh
# Seven local safety/oracle/CLI tests, no PostgreSQL connection:
pnpm --filter @intafaced/pay-sim test:unit

# Mandatory real PostgreSQL acceptance tests plus unit tests:
APP_ENV=test TEST_DATABASE_URL=postgres://LOCAL_TEST_ROLE:LOCAL_TEST_PASSWORD@localhost:5433/intafaced_test pnpm --filter @intafaced/pay-sim test
```

The normal workspace `test` script discovers these tests through `tooling/*`.
Missing PostgreSQL fails the package test; it never returns a green skip. The
Vitest config explicitly sets `APP_ENV=test` and the existing test-only screening
fixture bypass. Production services and shared CI files are unchanged.
