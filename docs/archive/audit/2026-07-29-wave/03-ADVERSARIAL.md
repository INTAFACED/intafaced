# Adversarial pass — mega-wave P0/P1

**Rule:** fresh context, read-only, assume broken. Critic does not implement.

| Finding                        | Critic result             | Evidence re-read                                                              |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| M-01 stake conflict            | **CONFIRMED**             | `token-service.ts` ON CONFLICT then posted `input.amount` without row compare |
| M-02 pending hide              | **CONFIRMED**             | listStakes excluded pending; optional stakeId                                 |
| M-03 convert limit             | **CONFIRMED**             | convertExecute re-quote check then placeOrder market without max bind         |
| L2-TOKEN-JURIS                 | **CONFIRMED**             | scopedProcedure without `{ module: 'token' }` while trade/pay use module      |
| L2-WA-UV                       | **CONFIRMED**             | preferred + parseAuthData UP-only                                             |
| P0 free mint / unauth withdraw | **REJECTED** (none found) | mount tests + recipe paths                                                    |
| #96 theater                    | **REJECTED**              | service throws + DAO no-op + CorsAllowlist                                    |
| #101 invent prices             | **REJECTED**              | QuoteRefusedError paths + tests                                               |

**Fix cheat-diff (this branch):** stake conflict test added; UV rejection test added; jurisdiction mount test added; no assertion strip; no empty catch on money paths.
