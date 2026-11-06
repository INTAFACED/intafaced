# WIP handover: W4 weak-test fixer (support-public, wallet, identity, developer), 6 Nov

Paused by the owner's checkpoint before any test file was edited. This note keeps what was found; delete it when the
work resumes. No journey file changed; no `cloud/W4-weak2-*` branch exists.

Steps owed (all still WEAK, none edited): J-support-public-01 #8; -03 #3 #5; -04 #2 #3 #6 #8; -08 #5; -10 #1 #2 #5;
-07 #5 #6 #7; -16 #1 #2 #3 #5 #6 #7 #8 #9; -19 #5 #8; -20 #2 #3 #4 #6; J-wallet-01 #1 #3 #5 #6; -02 #2 #3 #7 #8;
-03 #1; -05 #2 #6 #8; J-identity-02 #1 #2 #7; -03 #1 #2 #6; -05 #2; -08 #6; -11 #2; J-developer-02 #4 #7 #8.
Readers' notes: project-state `research/retro-2026-10-30/data/grades-*.json` and `research/proof-v2/reads/step-2.json`.

## Findings so far (code reads only, no runs: the local stack was still building)

- J-support-public-01 #8: over the rate limit, assert the vote response is 429 with `support.feedback_rate_exceeded`
  (services/svc-support/src/router.ts:182); today only the copy is checked (J-support-public-01.pw.mjs:499).
- J-support-public-03 #3, likely product gap: the row says "needs an email sender"; the customer copy says "needs an
  email delivery provider" (test :116); only services/svc-support/src/guest-requests.ts:142 says "email sender".
- J-support-public-03 #3 #5: no API read of `support.guest_requests` (status `pending_delivery`) found yet to prove
  "stays pending" and "no row stored".
- J-support-public-07 #6 and -19 #5, blocked by tooling: svc-notify always gets `NOTIFY_STATUS_MAIL_TRANSPORT:
'local-outbox'` (tooling/scripts/local-stack-services/notify.mjs) with no off switch for `restartWith`, so the
  no-sender branch (`vendor.email`) can't be driven without a shared-setup change (full journeys run).
- J-support-public-07: #5 needs a non-maintenance notice with a category, and the empty state; #6 needs a notice
  published while unconfirmed (no mail); #7 needs its own failed proof-of-work check and an exact subscriber count.
- J-wallet-01 #1, likely product gap: no per-network balance read (`bank.balances.byNetwork` absent from
  services/svc-bank/src/router/portfolio.router.ts) and no per-network rows in the app; Locked is hard-coded '0' (:42)
  and should come from `bank.portfolio.balanceBreakdown`; grouping should match `bank.portfolio.allocation`.
- J-wallet-03 #1: its row's slice is DEFERRED until launch prep; the blank-threshold clause may fail.
- J-identity-02 #1, likely product gap: sign-in matches handle or email only (svc-identity auth-service.ts ~1532);
  phone is refused `vendor.sms`. #2: lockout code `auth.too_many_attempts`. #7: frozen and closed both answer
  `auth.account_frozen` with `accountState`; no TEST helper closes an account yet (stack.mjs staffFreeze is freeze only).
- Baseline: docs/runbooks/journey-baseline.json is a gate file, and journey-baseline-guard.mjs accepts a strengthened
  entry only when its `strengthenedBy` commit is already on main, so a newly failing step can't be listed in the same
  test PR as the task asks; the lead decides how.
