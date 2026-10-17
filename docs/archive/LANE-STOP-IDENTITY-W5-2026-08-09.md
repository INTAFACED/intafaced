# LANE STOP — L12 IDENTITY · wave 5 · 2026-08-09

## Operator block

```
LANE: L12 IDENTITY wave 5
shipped (merged):
  #1240 freeze also retires every API key
shipped (open — identity green; monorepo Tests often red on sibling agents matrix):
  #1238 TOTP code can only open the door once (Class M + adversarial)
  #1262 remove a lost security key
  #1272 reject leaves audit trail / re-apply
  #1280 optional referrer at signup
  #1326 API key domain list blocks foreign origins
  #1348 encrypted KYC document store (mechanism; no vendor)
  #1382 passkey step-up for withdraw (Class M)
in flight:
  babysit CI merge for the seven open identity PRs above
parked:
  · TOTP secret encrypt-at-rest — residual (pairs after #1238)
  · recovery codes on step-up — product residual
  · shared WebAuthn challenge store (multi-pod) — residual
  · pending TOTP enrolment durability (multi-pod) — residual
  · login/exchange rate limit — residual
  · fee-event → XP accrue — needs fee envelope agreement
  · §8 affiliate rates + payout Class M — Nitro / DIRECTION
  · pay:* grants — WITHHELD; never invent
  · KYC vendor webhook — Class X / Nitro
Nitro must decide:
  · none for merge of Class N/P/M units above (adversarial on #1238 body + #1382 body)
  · KYC vendor + §8 rates still Nitro-only if product wants them
SAFE TO CLOSE: no — open PRs still need green monorepo Tests (blocked by L01 agents fleet matrix vs merchant.runSession on tip) then merge
tip: 8f193a8e
```

## Unit cards banked this wave

| PR    | Promise                  | Done bar                                                | Class |
| ----- | ------------------------ | ------------------------------------------------------- | ----- |
| #1240 | Freeze cascade keys      | freeze → apiKeysRevoked; exchange dead                  | P     |
| #1238 | TOTP window replay       | same step → auth.mfa_invalid; enrol seeds last step     | M     |
| #1262 | WebAuthn remove          | self remove; foreign false                              | P     |
| #1272 | KYC reject audit         | stamps + resubmit + refuse approved                     | N     |
| #1280 | Signup referrer          | optional referrerId → attribute law                     | N     |
| #1326 | domain_whitelist enforce | empty open; foreign/missing Origin refuse               | P     |
| #1348 | §10 encrypted doc store  | kyc_documents ciphertext; gate bans PII cols; no vendor | P     |
| #1382 | WebAuthn step-up         | passkey-only can mint trade:withdraw 5m                 | M     |

## CI babysit note (main thrash)

Monorepo **Tests** job is failing on `svc-agents` fleet matrix:

- tip mounts `merchant.runSession` (#1284 family)
- matrix still claims `runSessionMounted: false` for merchant → test expects not mounted

**Identity unit code is not the fail.** Re-run / re-merge after L01 matrix honesty lands.

## Sealed / not re-shipped

- freeze→keys (#1240 on tip)
- pay:payout bot ban (DB CHECK 0009)
- KYC provider pointer not client-written on submit route
- xp / rank paths not reinvented

## Next agent pickup

1. `gh pr list --search "identity" --state open` + merge when Tests green
2. After #1238: TOTP encrypt-at-rest
3. Do not invent pay:* grants or §8 rates
4. Do not touch L01 matrix from this wall
