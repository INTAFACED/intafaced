# ADR — Inheritance vs never-a-guardian (S-K7 → S-L2)

**Status:** accepted  
**Date:** 2026-08-08  
**Board:** S-K7 (required before S-L2 legacy vaults)  
**Law:** §34 legacy / `socket.social-recovery` — platform must never be a guardian

## Decision

Legacy (inheritance) recovery **may only use keys the user sets and can revoke**.

| Allowed                                         | Forbidden                                        |
| ----------------------------------------------- | ------------------------------------------------ |
| User-chosen heirs                               | Platform EOA / multisig as guardian              |
| Time-locks the user configures                  | Platform quorum that can move funds              |
| Social recovery among **user-picked** guardians | Any path where INTAFACED staff can vote recovery |

If a design requires the platform to be a party to move funds, **it stays a socket** — we do not ship a “legacy vault” that violates never-a-guardian.

## Consequences

- **S-L2 code does not start** until an implementation matches this ADR.
- Crew vaults (S-L1) are unrelated: shared treasury among peers, not platform recovery.
- Product copy must not promise platform-assisted inheritance.
