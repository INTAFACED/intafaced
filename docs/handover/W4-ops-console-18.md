# WIP handover: J-ops-console-18 (W4, svc-ops lane)

Delete this file before the PR is marked ready. Nothing below is built yet: no code or test was written before the pause.

## State on 2026-11-06 ~10:15 UTC

- Steps green: none. No `apps/customer/tests/real-app/J-ops-console-18.pw.mjs` yet; no CRM desk code yet.
- Step text read from project-state `operation-zero/modules/ops-console/acceptance/journeys.md` (12 steps).
- Open PRs touching svc-ops CRM or `apps/admin` CRM files: none at 09:45 UTC.

## Design worked out (next session starts from here)

Write the step test first, then build:

1. **Test** `apps/customer/tests/real-app/J-ops-console-18.pw.mjs`, `test.describe.serial`, one test per step titled `J-ops-console-18 #<n>`.
   Founders sign in once per context (`founderSignIn(page,'a'|'b')`); API setup through `approverSessions(ctx).a.crmToken()`;
   the non-admin is the stack's TEST operator (`operatorSessions(ctx).a.crmToken()`), which svc-ops refuses `ops.crm.operator_forbidden`.
2. **svc-ops** new module `services/svc-ops/src/crm-desk/` (own migration `<UTC stamp>_crm_desk.sql`, tRPC `outreach.desk.*`
   mounted beside `createOutreachRouter`, founder check = `authority` + `config.founders`): custom fields (unique via a
   unique-values table), records (contact, company, deal, task; numeric(36,18) amounts; revision; soft delete; history),
   relations (both sides), search (records + existing enquiries, typed hits, service count), per-founder tab layout,
   saved views, two-founder hard delete with `ops.crm.self_approval_refused`, purge refusing `ops.crm.retention_unconfigured`,
   resumable import (rows applied once by `(import_id,row_no)`), export audit, pipeline with service stage sums as decimal
   strings and a group limit, task calendar, mailbox connect refusal + `ops.mail.alias_refused`, compose -> queued with
   `vendor.email` refusal (business key `crm-desk:message:<id>`), calendar events, campaigns (eligible/skip counts, merge
   variables, `ops.outreach.daily_cap_unset`, batch resume once each, `ops.outreach.domain_unverified`), safeguards set by
   founders in the console and blank by default (daily cap, complaint/bounce thresholds -> `ops.outreach.thresholds_unset`,
   retention, sending domain), signed delivery events, HMAC unsubscribe tokens (`ops.outreach.unsubscribe_link_invalid`),
   permanent suppressions, DNS check naming the missing record and showing `vendor.email` for the provider check.
3. **Step 12** goes in the existing `services/svc-ops/src/outreach/crm.ts` beside `reviewedInvestor`: a merchant
   opportunity cannot be invited to a call, booked or moved past `new` until its merchant questionnaire is complete
   (`ops.crm.merchant_questionnaire_required`, with a "Send questionnaire" action in `crm-workspace.tsx`).
4. **Console**: new room `apps/admin/src/app/(console)/crm/desk/page.tsx` and proxy `apps/admin/src/app/api/crm/desk/route.ts`.
