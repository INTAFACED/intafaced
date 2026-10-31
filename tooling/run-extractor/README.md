# Run extractor

`node tooling/run-extractor/run-steps.mjs <run id> --against <previous run-M.json> --out run-N.json` writes one finished Real-app journeys run's passed and failed steps, and its diff against the previous run, in the shape of project-state `research/retro-2026-10-30/data/run-*.json` (needs `gh` with read access).
