---
name: Bug
about: Something is wrong and someone else might hit it
title: '<area>: <what you saw>'
labels: bug
assignees: ''
---

<!-- Title: the area and the symptom, in plain words. Never a guessed cause. -->

## Seen

<!-- What happened, in the reporter's own words where you have them; the error text. -->

## Expected

## Source

<!-- Link to where it was seen: the failing run, PR, log or screenshot. -->

- Commit: <!-- the SHA it was seen on, or "unknown" -->
- How often: <!-- every time / sometimes / once, and what triggers it -->

```bash
# the shortest sequence that shows it
```

## Blast radius

- [ ] Touches money (ledger, orders, payments, escrow) — **drop everything**
- [ ] Blocks `main`
- [ ] Blocks a teammate
- [ ] Cosmetic / can wait

## Cause so far

<!-- Only what you checked, with the file:line or log line. Label anything else "hypothesis". Leave blank if you did not trace it. -->
