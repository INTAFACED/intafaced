# docs/

Current rules for agents and people: [`../AGENTS.md`](../AGENTS.md). How the code is laid out: [`ARCHITECTURE.md`](ARCHITECTURE.md). Services, ports and required env (generated): [`SERVICES.md`](SERVICES.md). Values blank until the owner publishes them, and the TEST profile: run `node tooling/scripts/owner-settings.mjs`, which writes `docs/OWNER-SETTINGS.md` on your machine (built on demand, never committed).

Old history docs were deleted. Git history keeps them (`git log --diff-filter=D -- docs/`). What stays here is current truth, or a file that code, tests or CI read by path. A kept file can still be dated: when it disagrees with AGENTS.md or the code, AGENTS.md and the code win.

## Folders

| Folder                     | What it is                             |
| -------------------------- | -------------------------------------- |
| [`adr/`](adr/)             | settled decisions                      |
| [`runbooks/`](runbooks/)   | operator procedures                    |
| [`refs/`](refs/)           | measured front-end references          |
| [`agents/`](agents/)       | issue tracker, labels and domain notes |
| [`security/`](security/)   | security review read by tooling        |
| [`decisions/`](decisions/) | decision notes cited by code           |
| [`audit/`](audit/)         | audit notes cited by code              |
| [`audits/`](audits/)       | audit records cited by code            |
| [`pay/`](pay/)             | payments notes cited by code           |

## Files kept at this level

Each is read or cited by path from a CI gate, script or config.

- Run and test locally: [`RUNNING.md`](RUNNING.md), [`LOCAL-TEST-STACK.md`](LOCAL-TEST-STACK.md), [`AI-GATEWAY-SOCKET.md`](AI-GATEWAY-SOCKET.md)
- What is left to build, by lane and journey (plan on top, generated tables below): [`ROADMAP.md`](ROADMAP.md) (`node tooling/scripts/roadmap.mjs`)
- Generated: [`TRACKER.md`](TRACKER.md) (`pnpm tracker`)
- Claims board read by `pnpm wt:gc`: [`LIVE-LANES.md`](LIVE-LANES.md)
- Licence position: [`LICENCE-POSITION.md`](LICENCE-POSITION.md)
- Secrets, keys and custody: [`A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md`](A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md), [`SECRET-ROTATION-READINESS.md`](SECRET-ROTATION-READINESS.md), [`SECRET-ROTATION-READINESS-2026-08-03.md`](SECRET-ROTATION-READINESS-2026-08-03.md), [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md), [`OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](OWNER-ACTIONS-NOTIFY-GATEWAYS.md), [`RUNBOOK-ETH-KEYSTORE-REENCRYPTION.md`](RUNBOOK-ETH-KEYSTORE-REENCRYPTION.md)
- Security and operations: [`OPS-KILL-SWITCH-RUNBOOK.md`](OPS-KILL-SWITCH-RUNBOOK.md), [`THREAT-MODEL-STAGING-DEPLOY.md`](THREAT-MODEL-STAGING-DEPLOY.md), [`THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md`](THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md)
