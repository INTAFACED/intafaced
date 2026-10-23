# svc-mining-pool

**Mining pool: share ingest, PPLNS payout planning and epoch payouts.** Shares arrive on `POST /submitShare` and are stored per window; the epoch job plans a PPLNS split and pays it through the `rewardPay` ledger recipe. This service holds no balance: value moves only through svc-ledger.

Signed-in reads for the Mining room (`overview`, `connection`, `probe`) publish only what the owner set. A blank overview, host, port, probe limit or probe timeout refuses with `mining.overview_unset`, `mining.connection_unset`, `mining.probe_limit_unset` or `mining.probe_timeout_unset`. The probe opens a TCP connection to that host and port only, stores nothing, and stops at `mining.probe_limit_reached`. No mining password is returned.

## Service keys: inbound share ingest

`POST /submitShare` names the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. `/trpc` is unchanged: it names no service caller. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
