# Wave 6 · residual depth / needle-moving audit · 2026-08-09

**Criterion audited (was missing from structure audit):**  
Does each lane still have **high queue mass** — lots of real, tip-open, needle-moving work — so a long cook **moves the product**, not 8 tidy padded rows?

**Tip at audit:** `a688e231` · **~62 open PRs**  
**Paste tip at issue:** `8da2c561` (mild drift; re-derive still mandated)

---

## Unspoken need (named)

| Phrase                          | Meaning                                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| **Residual depth / queue mass** | How much craft is still open on tip for this wall                        |
| **Needle-moving**               | Changes user/money/safety/ops truth — not cosmetic thrash                |
| **Anti-thin / anti-pad**        | Engine A rows must map to open breaks, parks, or README falsify chapters |
| **Sustained cook**              | Hours of A+B work, not a 20-minute drain into Nitro-only                 |

---

## Method

Per lane score from:

1. Open PRs mapped to wall (product/test/docs babysit still work)
2. W4/W5 stop-note **parked** craft (not only Class X)
3. Paste Engine A craft vs babysit vs Nitro-park ratio
4. Grades: **THICK** · **OK** · **THIN** · **THIN-NITRO**

**THICK** = enough open inventory for multi-hour needle-moving cook.  
**THIN / THIN-NITRO** = risk of early empty or human-blocked theater unless Engine B is brutal.

---

## Per-lane depth score (present tip)

| Lane         | Grade                    | Open PRs (wall)                                           | Why                                                                                                                                  |
| ------------ | ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| L01 AGENTS   | **THICK**                | 0 product open but W5 parks + WIP ghosts + fleet residual | Law-thin agent rows park OK; craft on fleet/money-scope/scanner still real                                                           |
| L02 ACADEMY  | **THICK**                | 4                                                         | certs/scores PRs + parks                                                                                                             |
| L03 P2P      | **OK→THICK**             | 3                                                         | stop + integrity fixes + ghosts                                                                                                      |
| L04 PAY      | **THICK**                | 11                                                        | largest open cluster + §8 parks for forward path                                                                                     |
| L05 TRADE    | **THICK**                | 6                                                         | copy fee-share, stops, liq residuals                                                                                                 |
| L06 BANK     | **OK→thickened**         | 2 (+ ledger-client mis-map)                               | Parks lean Nitro; paste Engine A/B/C filled (ramps/reconcile/cards/standing orders)                                                  |
| L07 MARKET   | **OK→thickened**         | 1 Class M (#1189)                                         | Commerce needle + stake-gate/commission/refuse matrix filled                                                                         |
| L08 NOTIFY   | **THIN→thickened**       | 0 at score time                                           | W5 SAFE yes; pin/replica/reaper/kill + full Engine B on disk                                                                         |
| L09 INDEXER  | **THICK**                | 6                                                         | cold start, halt, tests                                                                                                              |
| L10 WS       | **THICK**                | 6                                                         | isolation, NATS, tape                                                                                                                |
| L11 SHELL    | **THICK**                | 7                                                         | candles, i18n, palette, float money                                                                                                  |
| L12 IDENTITY | **OK→THICK**             | 2 (+ recent merges on tip)                                | Vault/passkey still residual depth; open PR babysit                                                                                  |
| L13 TOKEN    | **THIN-NITRO→thickened** | 0 product                                                 | README auto-vs-person + crash/stake/buyback claim-before-burn + T-0x craft — **paste on disk now** (prior audit claim was premature) |
| L14 LEDGER   | **THICK**                | 4                                                         | purpose, recipes, reconcile                                                                                                          |
| L15 BOARD    | **THICK**                | 5                                                         | claim-check, FREEZE, fabricated-money                                                                                                |
| L16 VENDOR   | **THICK**                | 4                                                         | money-scan, dual-book, dependabot HOLDs                                                                                              |

---

## Wave-level judgment

| Question                        | Answer                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Is wave 6 mostly needle-moving? | **Yes** — pay/trade/shell/ws/indexer/tooling/vendor especially                                           |
| Any inefficient seats?          | **L08 / L13** were the weak spots (drained to seals + Nitro parks); **thickened in paste-w6** this audit |
| Is N=16 still justified?        | **Yes** for this tip — open PR mass + multi-wall residual; not 16 empty checklists                       |
| Going forward?                  | Next `new` must re-score depth; cut or merge THIN-NITRO walls if parks are only Class X                  |

---

## Failures found / fixes

| Issue                             | Fix                                                                      |
| --------------------------------- | ------------------------------------------------------------------------ |
| Structure audit missed queue mass | This depth audit + criterion named for runbook                           |
| L08 thin residual                 | Paste L08 Engine A/B/C expanded (needle units + chapters)                |
| L13 thin-nitro                    | Paste L13 **actually** expanded (was still thin after first audit claim) |
| L06/L07 empty Done bars           | Engine A/B/C filled so cooks do not idle into Nitro parks only           |
| Tip drift (identity)              | Builders re-derive; L12 must not re-ship #1348/#1382/#1326 if on tip     |
| Depth not in runbook              | Runbook §5.1 depth gate + failure mode added                             |

---

## Prompt language (for future audits / `new`)

> **Depth gate:** For each lane, residual must support a **long cook that moves the needle** — open PRs + parked craft + README falsify chapters. Fail **thin** or **Nitro-only padded** queues. Prefer fewer thick walls over many empty seats.

---

## Fix pass (same day — go depth)

| File                                      | Change                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| `docs/paste-w6/L08.md`                    | thickened (notify pin/replica/reaper)                           |
| `docs/paste-w6/L13.md`                    | full token residual + Done bars + Engine B/C (was still thin)   |
| `docs/paste-w6/L06.md` · `L07.md`         | bank/market Engine A/B/C filled                                 |
| `docs/paste-w6/L02–L04, L09–L12, L14–L16` | **all blank Done-bar cells filled** (0 blanks remain wave-wide) |
| `docs/COORDINATOR-WAVE-RUNBOOK.md`        | §5 + §5.1 depth gate permanent                                  |

**Wave-wide check:** every Engine A row has a non-empty Done bar (verified script).

---

## Bottom line

**Wave 6 depth gate: PASS after thicken.**  
**Heavy residual rewrite:** L08, L13 (+ L06/L07 chapters).  
**Done-bar pass:** all 16 lanes.  
**No full re-issue.** Re-paste only if a builder chat still holds a pre-thicken copy (esp. L06–L08, L13).
