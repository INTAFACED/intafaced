# Agent execution protocol

[`AGENTS.md`](../../AGENTS.md) is the one set of rules. The map of the tree is [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md). If this file and `AGENTS.md` disagree, `AGENTS.md` wins. This path remains so older links resolve.

Cold start, full access: ship without a human permission gate. Coordination map: [`docs/COORDINATION-TRUTH-LAYERS.md`](../../docs/COORDINATION-TRUTH-LAYERS.md). Internet leverage law: [`docs/INTERNET-LEVERAGE-LAW.md`](../../docs/INTERNET-LEVERAGE-LAW.md). A second money book is out.

## 3 · GitHub refusals and gates

A 403 or 429 from GitHub means stop GitHub requests and report the response, without a retry loop or a change of account or token. Share the refusal with other active agents; independent local work can continue. Resume a rate-limited request only after `Retry-After` or the exhausted limit's `X-RateLimit-Reset` time; if neither header is supplied, wait at least 60 seconds before explicitly resuming. Resolve an account or permission restriction before resuming. Keep code work parallel, pace GitHub API requests, and avoid repeated status polling.

Never weaken a correctness gate. Report unrelated baseline failures and checks that could not run. Do not claim unverified behavior works.

The canonical text is `AGENTS.md` under GitHub refusals.

## 8 · Definition of Done

A module ships when `pnpm gate <service>` is green and the checklist it prints is signed. A merge does not authorize a production deployment, live credentials, or real funds. Nitro decides a live launch.

The canonical text is `AGENTS.md` under Module done.
