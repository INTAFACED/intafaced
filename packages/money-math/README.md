# @intafaced/money-math

The decimal math of `@intafaced/ledger-client/money`, re-exported on its own: `parseAmount`, `formatAmount`, `SCALE`,
`MAX_AMOUNT`, `add`, `sub`, `mul`, `div`, `mulBps`, `compare` and the rest. Decimal strings on the wire, scaled bigint
in memory, explicit rounding.

Front ends that only format and compare amounts (`apps/customer`) depend on this package, not on ledger-client, so they
cannot import a ledger recipe or client. The code lives in `packages/ledger-client/src/money.ts`; change it there.
