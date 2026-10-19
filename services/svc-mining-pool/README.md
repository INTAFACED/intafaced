## Service keys: inbound share ingest

`POST /submitShare` names the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. `/trpc` is unchanged: it names no service caller. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
