# LANE STOP — L09 IDENTITY · wave 8 · 2026-08-09

## Operator block

```
LANE: L09 IDENTITY wave 8
shipped: #1516 README + comments match real step-up (TOTP/recovery/passkey) and refuse-closed affiliate payout (pays only when owner rates + ledger wired)
in flight: none on wall
parked: §8 affiliate rate magnitudes (Nitro) · KYC vendor Class X · pay:* grants invent · login/exchange rate-limit design fork · legacy TOTP re-encrypt batch (dual-read already safe) · soft-auth passkey step-up E2E in identity.test (Denon #1494 fence until support desk lands) · tracker identity.step-up note outside this wall
Nitro must decide: none for merge · publish §8 tiers / KYC vendor / pay:* only if product wants them
SAFE TO CLOSE: yes
tip: 481c7065
```

## Unit cards this wave

| PR    | Promise                                       | Done bar                                                                | Class |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------- | ----- |
| #1516 | README lied on step-up + always-refuse payout | matrix + ledger section + affiliate comments match router/payout-engine | N     |

## Sealed re-verified on tip (not re-shipped)

| Seal                                         | Evidence                                                            |
| -------------------------------------------- | ------------------------------------------------------------------- |
| #1488 multi-pod TOTP enrol                   | `pending-totp-store` + PG pending table; unit suite green           |
| #1505 / #1477 affiliate payout refuse-closed | payout-engine 31 tests + router mount refuse codes; no invent rates |
| #1238 TOTP anti-replay                       | sealed on tip; README anti-replay line true                         |
| #1417 TOTP encrypt-at-rest                   | dual-read + enrol key gate; crypto unit suite green                 |
| #1441 WebAuthn multi-pod challenges          | sealed                                                              |
| #1382 / #1448 passkey + recovery step-up     | sealed; README now matches                                          |
| #1240 freeze→API keys                        | sealed                                                              |
| #1326 domain whitelist                       | api-key-origin unit suite green                                     |
| #1348 KYC vault mechanism                    | sealed; vendor Class X parked                                       |

## Engine A residual honesty

| Unit                      | Verdict                                                      |
| ------------------------- | ------------------------------------------------------------ |
| A0 open identity PR bank  | empty at start; #1516 shipped+merged                         |
| A1 TOTP multi-pod         | sealed #1488 holds                                           |
| A1 affiliate payout       | refuse-closed holds; no invent bps; mechanism residual-empty |
| A1 WebAuthn / freeze      | residual-empty (product)                                     |
| A2 domain whitelist       | holds                                                        |
| A2 legacy TOTP re-encrypt | park ops (dual-read safe)                                    |
| A3 §8 rates / KYC vendor  | park Nitro                                                   |
| A3 stop note              | this file                                                    |

## Engine B chapter pass

- **TOTP** — mechanism residual-empty; honesty fixed where README lied on recovery
- **affiliate** — refuse-closed + fan-out sealed; README always-refuse lie fixed
- **WebAuthn** — multi-pod + step-up + remove sealed
- **freeze** — identity freeze→keys sealed
- **domain** — whitelist enforce sealed

## Denon fence observed

Did **not** dual-edit #1494 paths: `auth-service.ts` · `identity.test.ts` · `index.ts` · `packages/contracts/src/identity.ts`.

## Next pickup (not this lane)

1. Do not invent §8 rates, pay:\* grants, or KYC vendor
2. After #1494 merges: optional soft-auth passkey step-up E2E + any tracker note outside identity wall
3. Rate limit = edge vs identity design fork if product prioritises
