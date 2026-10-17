# LANE: PAY wave 3 — stop board · 2026-08-09

```
LANE: PAY wave 3
shipped:   #1181 public REST reachable through the edge
           #1192 crypto payout refuses bank IBAN before hold (+ user withdraw)
           #1195 bank-payout named and refused honestly (absent)
           #1196 checkout rail pick records skip reasons
           #1197 money suite uses shared postgres probe
           #1198 suspension mid-flight stops authorize/capture
           #1205 checkout writes rail.selected (if merged)
           #1206 docs stop promising partial capture / body userId / wrong error code
in flight: re-derive `gh pr list --search pay`
parked:    hold+suspend strand after withdrawHold (G4) — Class M ops path
           stuck-pending settlement release (G3) — product event
           routing costs / approval rates — Nitro §8 blanks
           KYB as money gate — needs grant path first
           chargeback recipe wire — owner banner
           subscriptions invoice-and-watch — transplant bank scheduler
           address/ref shape validation (kind gate is not address validation)
           payfac area enforcement on money paths
           evm-chain.live private probe — CI EVM decision
Nitro must decide: who grants pay:* scopes / fee tables / chargeback sign-off /
  crypto subs vs protocol FORBIDDEN_SIGNATURES / live acquirer — or none new this wave
SAFE TO CLOSE: yes for this cook cycle once #1205+#1206 land or are parked
tip: re-derive git log -1 --oneline origin/main
```

## What a merchant/user got

1. **REST works at the edge** — `/api/pay/v1/*` no longer 404s (#1181).
2. **Wrong destination kind cannot drain funds** — IBAN on crypto refused before hold, merchant + user (#1192).
3. **Bank settlement can be named** — honest absent refuse, not a silent unknown (#1195).
4. **Checkout can explain its rail pick** — decision record + `rail.selected` event (#1196 / #1205).
5. **Suspend mid-flight stops progress** — no authorize/capture after cut-off (#1198).
6. **Docs no longer promise partial capture or body `userId`** (#1206).

## Engine B

One full README/public-surface pass completed. Ship-ready docs lies fixed in #1206. Remaining falsification targets (races, payfac areas on money paths, sandbox laundering under override) parked for next cook.

## Ghosts

`pay.public-api` / `pay.payfac` stale owners cleared with merge evidence in #1181.
