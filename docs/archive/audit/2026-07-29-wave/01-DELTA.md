# Delta inventory — since #86 (`60031cf`) → `27ce1d4`

## Merged commits (named)

| SHA / PR                            | What                   | Risk class             |
| ----------------------------------- | ---------------------- | ---------------------- |
| #87 convert RFQ + market IOC        | trade money path       | money                  |
| #90 protocol.amm                    | unsigned AMM builders  | plane / protocol       |
| #96 vendor residual                 | unfreeze/CORS/TRUNCATE | vendor custody residue |
| #97 token governance                | proposals + voting     | money-adjacent         |
| #99 CI money Postgres               | harness honesty        | proof                  |
| #89 pay /trpc mount                 | mount honesty          | money surface          |
| #98 Stream A plan                   | app docs/UI            | product                |
| #91 WS trade tape                   | public market data     | public surface         |
| #93 WebAuthn                        | passwordless auth      | auth                   |
| #94 stake/unstake + epoch mint live | money                  | money                  |
| #100 Denon return board             | docs                   | none                   |
| docs #84/#88/#92/#95                | peace/stream A         | none                   |

## Surfaces judged this wave

convert · token stake/unstake/mint · governance vote · pay user-money/merchant · protocol AMM · WS trade tape · WebAuthn · vendor #96 · tracker done honesty · open PR #101 · open PR #102 (skim)

## Author note

Merged post-#86 product commits on GitHub are largely under Nitro’s account (agent-operator). Denon’s open **#101** is the large pre-merge release (market seed + dex.quote + screening). Audit covers **all of main’s unaudited delta**, not only Denon’s login.
