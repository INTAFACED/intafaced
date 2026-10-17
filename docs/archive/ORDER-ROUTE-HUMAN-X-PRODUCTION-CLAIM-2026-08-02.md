# Human X — production claim checklist (plain language)

**For Nitro.** Agents cannot green these. This is the **only** gate left after agent-max B-layer (L1–L4 when CX-8 CI is green on tip).

**Rule:** Do **not** say “stable for real money” until **every required row below is done by a human** (you / ops / counsel).

---

## What agents already proved (not your homework)

| Proof                                                                                                                     | Where you can see it                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| CEX chaos / properties / reconcile / seed honesty                                                                         | Main CI Tests (order-route suites)                                       |
| Dual-book second book blocked (door + scans + LIVE mints 0)                                                               | Main + dual-book scans                                                   |
| DEX **quotes** honest (no invent price)                                                                                   | Main                                                                     |
| **Assembled stack CI:** health · edge place/cancel · **two-user fill** · ledger balance moved · stress + idempotent place | GitHub Actions workflow **Order-path CX-8** on tip after agent-max merge |

Open: GitHub → Actions → **Order-path CX-8** → latest green on `main`.

**Agent-side order-route + post-pile deep audit is finished** (see `docs/audit/2026-08-02-post-pile-deep/AGENT-COMPLETE-SEAL-2026-08-02.md`). Remaining product mountains (pay card, futures risk, etc.) are **shehzad M1–M7**, not more agent order-route invent.

---

## Your checklist (do in order when you mean live money)

| #      | Item                                                  | Where                        | Done when                                                                                           | Skip?                         |
| ------ | ----------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| **X1** | Secrets are **real**, not `dev-only-*` placeholders   | Secret store / host env only | Prod `INTERNAL_SERVICE_SECRET`, `EDGE_PRINCIPAL_SECRET`, JWT, DB passwords rotated; never committed | Required                      |
| **X2** | Prod DB + NATS + fleet actually running               | Your server / cloud          | Ledger, matching, trade, identity healthy (deploy / `platform:up` equivalent)                       | Required                      |
| **X3** | Fund **test** then **small real** accounts on purpose | Ops deposit rails            | Real deposit path works; balances from rails, not scripts inventing money                           | Required                      |
| **X4** | Kill-switch drill                                     | Admin / kill board           | Spot kill stops **new** orders; cancel still works; **you saw it once**                             | Required                      |
| **X5** | Prod RPC / chain (if any custody path is live)        | Infra                        | You accept chain/RPC as production, not anvil-only                                                  | Skip if no chain custody live |
| **X6** | Go-live **yes** decision                              | Your call (write it)         | Written: “we take real money on the proven **spot** path”                                           | Required                      |
| **X7** | Counsel / jurisdiction                                | Legal                        | Only if you operate where it matters                                                                | Optional by jurisdiction      |

---

## How to walk this without technical deep-dives

1. Ask whoever runs servers: “Are prod secrets real and is the fleet up?” → **X1–X2**.
2. Deposit a tiny amount yourself on staging/prod test account → **X3**.
3. Flip kill with an operator watching; place once (should fail new); cancel an open if any → **X4**.
4. If you hold user crypto keys on-chain: confirm RPC is real prod → **X5**.
5. Say yes in writing (Telegram/docs is fine) → **X6**.
6. Lawyer only if your country/setup needs it → **X7**.

You do **not** need to re-run git, open PRs, or re-prove chaos tests.

---

## What you do **not** need to do

- Re-run git / open PRs / merge agent green CI
- Re-prove chaos unit tests or CX-8 (agents own that)
- “Approve architecture” for agent residual
- Green shehzad M7 Java work (separate human owner)

---

## After X1–X6 (and X7 if required)

Then (and only then) agents/docs may say **stable for real money on the proven spot path** — still not futures / OTC / copy invent / unproven rails.

**Until then:** high water = agent-max B-layer (assembled L1–L4 in CI). **Not go-live.**

---

## If something on the agent side is red

- CX-8 red on `main` → agent must fix; **not** your Human X.
- Human X is only about **your** secrets, fleet, money, kill, and yes decision.
