# Fix note — T-02 token_params live + T-04 bank S2S body-bind

**T-02:** Production `TokenService` loads `buyback` and `emission` from `token.token_params` (cached like fee schedule). Code defaults remain for tests via `loadParamsFromDb: false`.

**T-04:** `svc-bank` ledger HTTP client now uses `serviceAuthHeadersForBody` (same as token).

**T-01:** Explicit residual — `recordBuyback` is still operator burn-from-rewards; no market-buy invent. Documented in service comment.
