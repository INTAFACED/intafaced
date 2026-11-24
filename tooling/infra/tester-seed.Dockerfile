# The tester profile's image (docker-compose.tester.yml `seed`, `test-chain`, `test-venue`; J-home-ia-11 #1): the app
# image, plus svc-bank's own release binary where the TEST content seed runs it (`svc-bank test-seed`,
# tooling/scripts/local-test-seed.mjs BANK_BIN), and anvil for the TEST chain (local-test-chain.mjs serve). The app and
# bank images are the ones compose builds for this stack (its `additional_contexts`), so the seed runs exactly the code
# the stack runs; anvil comes from the pinned foundry image docker-compose.yml's `evm` runs. LOCAL TEST only: no
# deployment builds it.
FROM app AS seed
USER root
COPY --from=bank /app/svc-bank /app/crates/svc-bank/dist/svc-bank
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
USER node
