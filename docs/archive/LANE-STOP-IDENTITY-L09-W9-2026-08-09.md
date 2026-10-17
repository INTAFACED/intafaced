# LANE STOP — L09 IDENTITY · wave 9 topup · 2026-08-09

## Operator block

```
LANE: L09 IDENTITY wave 9 topup
shipped: #1553 passkey withdraw step-up soft-auth E2E (kind isolation + trade:withdraw)
in flight: none on wall
parked: §8 affiliate rate magnitudes (Nitro) · KYC vendor Class X · pay:* grants invent · login/exchange rate-limit design fork · legacy TOTP re-encrypt batch (dual-read already safe) · fee-event emitters in trade/pay (not this wall)
Nitro must decide: none for merge · publish §8 tiers / KYC vendor / pay:* only if product wants them
SAFE TO CLOSE: yes
tip: 087e65f5
```

## Unit cards this wave

| PR    | Promise                                                | Done bar                                                                                            | Class |
| ----- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----- |
| #1553 | Passkey step-up soft-auth E2E after #1494 fence lifted | soft auth enrol → step-up → `trade:withdraw`; login≠step-up kind; single-use; freeze/session refuse | P     |

## Sealed re-verified on tip (not re-shipped)

| Seal                                         | Evidence                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- |
| #1488 multi-pod TOTP enrol                   | `pending-totp-store` unit suite green (local)                     |
| #1505 / #1477 affiliate payout refuse-closed | payout-engine **31** + rate-law / tier-honesty / commission green |
| #1238 TOTP anti-replay                       | sealed on tip                                                     |
| #1417 TOTP encrypt-at-rest                   | crypto unit suite green                                           |
| #1441 WebAuthn multi-pod challenges          | sealed                                                            |
| #1382 / #1448 passkey + recovery step-up     | product sealed; **#1553** pins soft-auth E2E                      |
| #1516 README honesty                         | tip README matches step-up factors + refuse-closed payout         |
| #1240 freeze→API keys                        | sealed                                                            |
| #1326 domain whitelist                       | sealed                                                            |
| #1348 KYC vault mechanism                    | gate + crypto green; vendor Class X parked                        |

## Engine A residual honesty

| Unit                                 | Verdict                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| A0 open identity PR bank             | empty at start; #1553 shipped+merged                         |
| A1 affiliate attribute/accrue/payout | mechanism residual-empty; rates refuse-closed without §8 law |
| A1 freeze / treeStatus               | residual-empty (non-pay honesty holds)                       |
| A1 TOTP multi-pod                    | sealed #1488                                                 |
| A2 PII isolation                     | store + gate on tip; vendor Class X / Nitro                  |
| A2 step-up                           | TOTP + recovery sealed; **passkey E2E shipped #1553**        |
| A3 Engine B chapter pass             | README auth+affiliates match code on tip after #1516         |
| A3 §8 rates / KYC vendor / pay:*     | park Nitro                                                   |

## Engine B chapter pass (this wave)

- **affiliates API** — attribute cycle/self/depth · accrue refuse-closed · payout refuse-closed without rates+ledger — **TRUE** (unit suites)
- **payout refuse-closed** — #1505/#1477 pin under tip — **TRUE**
- **freeze** — non-pay skip at accrue — **TRUE**
- **TOTP** — multi-pod pending + encrypt + anti-replay — **TRUE**
- **step-up** — TOTP/recovery/passkey all paths pinned (passkey soft-auth **#1553**) — **TRUE**
- **PII isolation** — pointer-only kyc_records + encrypted store; no vendor — **TRUE mechanism / park Class X**

## Engine C — attack surface

| Surface             | Finding                                           |
| ------------------- | ------------------------------------------------- |
| rate invent         | refuse-closed at accrual + payout                 |
| payout invent money | no recipe invent; ledger client optional refuse   |
| PII leak            | status strips providerRef; store not user-mounted |
| cycle attribute     | tree refuses self/cycle/depth                     |

## Local limits this wave

Colima VZ failed on this host (audio sandbox extension) — PG soft-auth suite sealed by **CI Tests** on #1553 (pass after kind-code fix). Non-PG sealed pack: **199/199** local before open.

## Next pickup (not this lane)

1. Do not invent §8 rates, pay:\* grants, or KYC vendor
2. Fee-event → affiliate accrue lives on trade/pay walls when those emitters ship
3. Rate limit = edge vs identity design fork if product prioritises
4. Optional legacy TOTP re-encrypt job (dual-read already safe)

Board-Delta: none (stop note only)
