# The tester profile's seed image (docker-compose.tester.yml `seed`, J-home-ia-11 #1): the app image, plus svc-bank's own
# release binary where the TEST content seed runs it (`svc-bank test-seed`, tooling/scripts/local-test-seed.mjs
# BANK_BIN). Both come from the images compose builds for this stack (its `additional_contexts`), so the seed runs
# exactly the code the stack runs. LOCAL TEST only: no deployment builds it.
FROM app AS seed
USER root
COPY --from=bank /app/svc-bank /app/crates/svc-bank/dist/svc-bank
USER node
