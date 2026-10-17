# TV Program — AFK Overnight Contract (2026-08-09)

**Status:** COMPLETE · banked on `main` via #1597 · W11 L08 residual closed  
**Coordinator:** AFK overnight session (site single-writer) + W11 L08 honesty pass  
**Monorepo SoT:** `sites/sovereign-os/**`  
**Scoreboard:** [`TV-SITE-SCOREBOARD.md`](TV-SITE-SCOREBOARD.md)  
**Apply pack:** [`../TV-APPLY-PACK.md`](../TV-APPLY-PACK.md)  
**DNS runbook:** [`../TV-DNS-HOST-RUNBOOK.md`](../TV-DNS-HOST-RUNBOOK.md)

---

## 0 · Outcome (do not re-open as ACTIVE)

North star met for agent-owned waves:

1. Live public HTTPS serves the site (interim Pages URL)
2. W4 QA checklist green on scoreboard
3. Apply pack has URL + blurbs + contacts
4. Scoreboard W0–W4 DONE; W5 = PACK-READY-HUMAN-CLICK
5. Site package on monorepo `main` (#1597)

**Still human-only (not agent reopen triggers):**

- Nitro: optional DNS `trade.intafaced.com` (Class X)
- Denon/Nitro: entity name pick + TradingView form submit (W5 click)

**W6 post-grant charts:** NOT in this finish line.

---

## 1 · Hard constraints (still law for any future site edit)

| ID  | Need                     | Enforcement                                           |
| --- | ------------------------ | ----------------------------------------------------- |
| U1  | Zero oversight overnight | No questions mid-run; defaults locked                 |
| U2  | Compact chat on return   | One FINISHED packet + scoreboard + URL                |
| U3  | Actually finishes        | Exit gates machine-checkable                          |
| U4  | Not slop                 | DESIGN locks + ban list in build                      |
| U5  | Fast TV bar              | Compress copy; full rooms named                       |
| U6  | Parallel safe            | Single writer on `sites/sovereign-os/**`              |
| U7  | Subagents if used        | Full brief + exit artifact path; no dual site writers |
| U8  | DNS may be human         | Preview URL OK; DNS runbook left                      |
| U9  | Form submit may be human | Pack-ready is agent done for W5 if no TV login        |
| U10 | State in files           | Scoreboard + this contract always current             |

---

## 2 · Wave exit gates (historical — all met)

| Wave | DONE means                                                         | Status                 |
| ---- | ------------------------------------------------------------------ | ---------------------- |
| W0   | Copy bank + PRODUCT + DESIGN + claims + this contract + scoreboard | DONE                   |
| W1   | STACK-LOCK.md in sites package                                     | DONE                   |
| W2   | Host/DNS runbook; deploy method chosen                             | DONE                   |
| W3   | TV-APPLY-PACK.md                                                   | DONE                   |
| W4   | Live URL + QA checklist all yes                                    | DONE                   |
| W5   | Submitted OR pack-ready with one human click path                  | PACK-READY-HUMAN-CLICK |

---

## 3 · Defaults (frozen)

| Item               | Default                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Subdomain target   | `trade.intafaced.com`                                                                             |
| Interim public URL | https://zenyoda3.github.io/intafaced-sovereign-os/                                                |
| Entity on pack     | “Gate into Sensorium or Nitrogenics — confirm at submit” + email gateofsensorium@gmail.com        |
| Tech contact       | Denon · gateofsensorium@gmail.com                                                                 |
| Legal contact      | Same until named                                                                                  |
| Stack              | Static site (HTML/CSS/JS) in `sites/sovereign-os` — zero monorepo pnpm dependency for reliability |
| CTA                | `#waitlist` / mailto hello@intafaced.com — not payments cal.com primary                           |
| Chart              | No Advanced Charts; CSS terminal mock only                                                        |
| Path fence         | Never dual-write `05_Web_Front` / HUMAN product shell                                             |

---

## 4 · Path fence (attack surface)

| Allowed                                   | Banned                                  |
| ----------------------------------------- | --------------------------------------- |
| `sites/sovereign-os/**`                   | `vendor/**/05_Web_Front/**` shell craft |
| `docs/TV-*` · `docs/ops/TV-*` · copy bank | Invent prod DNS without Nitro           |
| Docs-only host runbook                    | Advanced Charts binary pre-grant        |
|                                           | Payments cal.com as primary CTA         |

---

## 5 · FINISHED packet (operator)

```
FINISHED — TV apply site
URL: https://zenyoda3.github.io/intafaced-sovereign-os/
QA: green
Apply pack: docs/TV-APPLY-PACK.md
PR: #1597 merged (monorepo SoT)
You: optional DNS trade.intafaced.com · entity confirm + TV form submit
```

_Contract COMPLETE — do not re-activate without a new product promise._
