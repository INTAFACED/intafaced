# Pay screening integration

Both KYB submit writers and the concrete payout destination store run regional
`checkAccess` and party screening. Crypto destinations also screen the wallet on
the configured `PAY_CRYPTO_CHAIN_ID`, represented as `eip155:<id>`. A missing
chain, dossier, verified context or provider refuses. No network is inferred from
an address, rail name or asset symbol.

The W9 guard checks fresh payout execution before the ledger hold or rail call.
Held payout recovery proceeds even when screening becomes unavailable; capture
and refund remain halt-only. Screening takes no row locks and never reacquires
merchant or link locks after later locks. Exceptions become typed refusals with
no retained sensitive cause. PostgreSQL retryable transaction errors still retry.

Migration `0062_pay_screening_reviews.sql` stores review cases by settlement and
attempt, with fixed provider metadata and a visible fixture flag. It contains no
party names, registration numbers or addresses. Execute review is durable before
refusal; an offered destination that refuses during admission is recorded only
after that transaction rolls back. Retries deduplicate. A later provider pass
resolves the queue entry; a new review reopens it. There is no manual override.
Operators read pending cases through `screening.reviews({limit})`, requiring
`admin:compliance` and an explicit page size from 1 to 200. This is a backend API;
no new operator screen is included.

Default runtime configuration has no provider, so screening refuses. A future
vendor adapter is injected through `PayScreeningService({sql,provider})`; selecting
or contacting a vendor is outside this implementation.

For synthetic local fixtures, explicitly set `APP_ENV=dev` or `test`,
`PAY_SCREENING_PROVIDER=fixture`, and `PAY_SCREENING_FIXTURE_CASES` to a JSON array
matching `ScreeningFixtureCase` from `@intafaced/screening`. Each case supplies
`reference:{merchantId,kybRef}`, `party:{name,country,registration,identityKycTier}`,
`partyOutcome`, and optional `wallets:[{address,chain,outcome}]`. Use visibly marked
TEST DATA. Region policy remains separate: supply its governed list or explicitly
set `INTAFACED_SCREENING_FAIL_CLOSED=off` in dev/test. Fixtures and the off switch
cannot admit staging, prod, unset or unknown environments. Invalid JSON and absent
cases refuse; they never imply pass. No fixture data is printed to logs.

`screening.db.test.ts` exercises real payout review/rollback, queue reopening,
unavailable refusal, replay/recovery and lock order against PostgreSQL. DB absence
fails the suite, with no green skip. Local execution requires `TEST_DATABASE_URL`
or a running Docker daemon for Testcontainers.
