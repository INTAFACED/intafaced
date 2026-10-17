# Research pack — residual R2 `ws.gateway`

**Lane:** residual-ws · **Date:** 2026-07-31 · **Tip:** re-check origin/main  
**Collision:** frontend Wave A / #261 withdraw honesty — **do not touch vendor/**  
**Class:** N (honesty + tests) until futures engine (M/P)

## Law

- Tracker law: `done` = reachable + tested + unpropped
- Empty honest > inventing futures positions
- Private WS JWT fail-closed (#227 audited money-class PASS)

## On main now

- Public depth: `ws.depth` **done**
- Public tape + private orders/fills + positions channel: svc-ws
- Positions: `positionUpdated` bus → hub fanout; no publisher until trade.futures
- Tests: hub/source prove owner isolation + silence when no publish

## Gaps blocking title `done`

1. No trade.futures engine producing `positionUpdated`
2. Tracker title still reads as four product streams

## DoD for this honesty ship

- [x] Tracker note states empty-honest positions + not done without futures
- [x] Existing tests: no invent when silent
- [ ] LIVE-LANES claim residual-ws

## Risks

- Marking `done` would lie about futures product
- Frontend must not invent position rows either (their lane)

## First PR

Tracker honesty + LIVE-LANES claim + grind STATUS + compaction CONTINUE (this fire)
