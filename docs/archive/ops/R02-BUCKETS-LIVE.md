# Free product buckets — tip after shell merge cluster

**Tip:** re-derive `git log -1 --oneline origin/main` (last freeze: `f96ac6b4`)  
**SPAWN_NOW:** none  
**freeProduct:** 0 · **blocked:** P-WS-REPORT  
**Proof:** NO-FLEET · :8090 foreign

| id                                        | bucket       | proof                         |
| ----------------------------------------- | ------------ | ----------------------------- |
| RP1                                       | MERGED       | #468                          |
| RP4                                       | MERGED       | #468                          |
| RP2                                       | MERGED       | #465                          |
| RP3                                       | MERGED       | #467                          |
| RP-LAND-*                                 | RESIDUAL_OWN | #455/#456/#457 on tip         |
| AFK-UC-COMP                               | MERGED       | #462                          |
| AFK-CMDK-ROUTES                           | MERGED       | #463                          |
| AFK-FOOTER                                | MERGED       | #464                          |
| AFK-IDENT/LAB/HELP/WHITEPAPER/APPDOWNLOAD | RESIDUAL_OWN | already honest                |
| META-* / B12 / B13 / P0.4 / AFK-RESCAN    | RESIDUAL_OWN | process / NO-FLEET            |
| AFK-INDEX                                 | RESIDUAL_OWN | RP2 #465 landed Index honesty |
| P-WS-REPORT                               | BLOCKED      | WS integrity open paths       |

## Cannot parallel

- path collision only: sockets.js was #467→#462 ordered — **done**
- depth UI until P-WS free
