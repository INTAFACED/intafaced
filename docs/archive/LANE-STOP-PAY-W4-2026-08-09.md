# LANE: PAY wave 4 — stop board · 2026-08-09

```
LANE: PAY wave 4
shipped:   #1234 G4 hold+suspend — resume finishes open payout hold (Class M)
           #1235 destination shape — EVM/IBAN before hold + pre-claim isAddress (Class M)
           #1236 G3 stuck pending release — settlement.released + later window (Class M)
           #1249 ghost clear nitro-pay-w3 on pay.public-api + pay.subscriptions (Class N)
           #1250 subscription watch — capture settles execution (Class M)
           #1251 Engine C — pay:payout MFA + SESSION_SCOPES refuse merchant money (Class P)
in flight: re-derive `gh pr list --search pay-w4` — merge when CI green (rate-limit may delay babysit)
parked:    routing costs / approval rates — Nitro §8 blanks
           KYB as money gate — needs grant path first
           chargeback recipe wire — owner banner (recipes exist; wire Nitro-only)
           payfac area enforcement on money paths — tree exists; areas not yet on capture/refund/payout
           card mandate rail — pay.mandate_rail_absent
           subscription dunning + merchant surface + pre-charge notify
           IFSC bank dest shape — no partner table
           dual-book settle-before-status-update residual (named in G4 adversarial)
Nitro must decide: who grants pay:* / fee tables / chargeback sign-off /
  crypto subs vs protocol FORBIDDEN_SIGNATURES / live acquirer — or none new this wave
SAFE TO CLOSE: yes for this cook cycle once open PRs green+merged or parked with pick-up
tip: re-derive git log -1 --oneline origin/main
```

## What a merchant/user got

1. **Payout hold cannot be stranded by suspend** — crash after hold, then suspend, resume finishes (#1234).
2. **Gibberish destinations refused before money moves** — structural EVM + IBAN (#1235).
3. **Stuck settlement freeze has an ops release** — payments re-enter a later window (#1236).
4. **Subscription invoice tracks payment** — capture marks execution settled (#1250).
5. **Ghost owners cleared** — wall not dual-fenced by dead nitro-pay-w3 (#1249).
6. **Session cannot drain merchant money without scopes/MFA** — pinned tests (#1251).

## Engine B

README/public-surface lies were largely fixed in W3 (#1206). This wave focused on money-path residual + attack-surface pins. Remaining: README lines for `settlement.release` + `pay.invalid_destination_ref` (honesty, Class N).

## Sealed re-verify (do not re-ship)

#1181 edge REST · #1172/#1198 suspend · #1173 settlement freeze · #1192 kind gate · #1195 bank-payout absent · #1205/#1206 · #1214 invoice runner (ask half).
