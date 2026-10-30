# svc-mining-pool

**Mining pool: share ingest, PPLNS payout planning and epoch payouts.** Shares arrive on `POST /submitShare` and are stored per window; the epoch job plans a PPLNS split and pays it through the `rewardPay` ledger recipe. This service holds no balance: value moves only through svc-ledger.

Signed-in reads for the Mining room (`overview`, `connection`, `probe`) publish only what the owner set. A blank overview, host, port, probe limit or probe timeout refuses with `mining.overview_unset`, `mining.connection_unset`, `mining.probe_limit_unset` or `mining.probe_timeout_unset`. The probe opens a TCP connection to that host and port only, stores nothing, and stops at `mining.probe_limit_reached`. No mining password is returned.

## The miner door (stratum-style, TCP)

A rig connects to the host and port the Mining room shows, and speaks one JSON request a line (`src/stratum-door.ts`): `mining.subscribe`, then `mining.authorize ["<account id>.<worker name>"]` (the account id and worker name the room copies; no worker name is the `default` worker), then the pool sends `mining.notify` with the job (the window id, the pool's own header for that window, account and rig, and the published proof-of-work parameters). `mining.submit ["<user>", "<job id>", "<nonce>"]` goes through the same checked ingest as `POST /submitShare`: the pool checks the work and weighs it 1, and a refused share keeps nothing (`mining.pow_invalid`, `mining.share_duplicate`, `mining.job_stale` with a new job, `mining.stratum_unauthorized`, `mining.account_invalid`, `mining.stratum_malformed`, `mining.stratum_method_unknown`). A line longer than 4096 bytes closes the connection.

The door opens only when the owner publishes `MINING_STRATUM_LISTEN_PORT`, `MINING_STRATUM_WINDOW_SECONDS` (60 to 2678400; windows count from the Unix epoch) and `MINING_STRATUM_ASSET_ID`; any blank keeps it closed and the log says `mining.stratum_unset`. With no published proof-of-work parameters `mining.authorize` refuses `mining.pow_spec_unset`: the door takes only work the pool can check. Testnet work earns no credit (`mining.testnet_no_credit` at payout).

## Service keys: inbound share ingest

`POST /submitShare` names the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. `/trpc` is unchanged: it names no service caller. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
