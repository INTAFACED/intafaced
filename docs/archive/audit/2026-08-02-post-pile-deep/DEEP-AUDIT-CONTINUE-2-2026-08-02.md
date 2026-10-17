# Deep audit continue-2 — residual close

**Date:** 2026-08-02  
**Tip base:** `6f96795` (#394)

## Closed this wave

| Residual                                       | Fix                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Kill restart wipe (single host)                | `EDGE_KILL_STATE_PATH` hydrate + persist; unit test                                  |
| Admin BFF open POST                            | Optional `ADMIN_BFF_SHARED_SECRET` + `x-intafaced-admin-bff` on kill + freeze routes |
| Favorite silent fail                           | Exchange toggleFavorite / row catch + error warn                                     |
| OTC AdPublish partner formula / invent balance | Honest formula copy; balance default 0                                               |
| Fee allocation invent 80/20                    | en.js content1 honesty                                                               |

## Still open

| Item                                | Owner        |
| ----------------------------------- | ------------ |
| True SSO / multi-replica kill store | Ops · §13    |
| svc-pay S2S v2                      | shehzad #346 |
| M7 entity save                      | shehzad      |
| JVM 410                             | Docker       |
| Human X                             | Nitro        |
| M1–M7 product                       | shehzad      |

**Not go-live. Not BOARD-COMPLETE.**
