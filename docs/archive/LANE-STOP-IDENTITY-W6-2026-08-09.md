# LANE STOP — L12 IDENTITY · wave 6 · 2026-08-09

## Operator block

```
LANE: L12 IDENTITY wave 6
shipped: #1238 TOTP anti-replay · #1272 KYC reject audit · #1417 TOTP encrypt-at-rest · #1448 recovery step-up · #1441 WebAuthn multi-pod challenges · #1453 stop note
in flight: none
parked: pending TOTP enrolment durability (multi-pod Map) · login/exchange rate limit (edge vs identity) · §8 affiliate payout rates (Nitro) · pay:* grants never invent · KYC vendor Class X · legacy TOTP re-encrypt job (dual-read until re-enrol)
Nitro must decide: none for merge · ops set IDENTITY_TOTP_SECRET_KEY in prod · KYC vendor + §8 if product wants them
SAFE TO CLOSE: yes
tip: ce67aaec
```

## Unit cards this wave

| PR    | Promise                       | Done bar                                             | Class |
| ----- | ----------------------------- | ---------------------------------------------------- | ----- |
| #1238 | TOTP window replay            | same step → auth.mfa_invalid; enrol seeds last step  | M     |
| #1272 | reject audit + re-apply       | stamps + resubmit + refuse approved                  | N     |
| #1417 | TOTP secret encrypt-at-rest   | enc:v1: AES-GCM; dual-read legacy; prod key required | P     |
| #1448 | recovery on step-up           | TOTP first then burn recovery; 5m trade:withdraw     | M     |
| #1441 | WebAuthn multi-pod challenges | SQL store put/take/TTL/single-use                    | P     |

## Sealed / not re-shipped

- domain_whitelist (#1326) · passkey step-up (#1382) · KYC vault mechanism (#1348) · freeze→keys (#1240) · pay:payout bot ban · xpEarned consumer · affiliates.payout refuse pin

## Next pickup

1. Pending TOTP enrolment durability (after encrypt)
2. Do not invent pay:* grants or §8 rates
