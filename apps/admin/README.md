# apps/admin — Operator Console

The §14.6 surface: _"Admin controls: kill-switch + config surface in `apps/admin`."_ Until this app existed,
every module shipped with an unverifiable checkbox against that line.

Next.js 15 App Router, hand-scaffolded (no `create-next-app` — it fights the repo tsconfig and prettier).

```bash
pnpm --filter @intafaced/admin dev     # http://localhost:3100
pnpm --filter @intafaced/admin build
pnpm --filter @intafaced/admin typecheck
```

## Doctrine

- **No money logic.** This app reads configuration and issues operator commands. It never computes a balance,
  never posts an entry, and imports nothing from `@intafaced/ledger-client`.
- **No duplicated truth.** Flags come from `FLAG_REGISTRY`, resolution from `resolveAll()` / `isEnabled()`,
  geo rules from `JURISDICTION_MATRIX`, decisions from `checkAccess()`. The console cannot drift from what the
  services enforce, because it holds no copy of what they enforce.
- **App-local approved design tokens.** The selected graphite/lime palette is defined as `--if-*` custom properties in `src/app/globals.css`, recorded in `.21st/design.json`. Components use those tokens and `color-mix()` tints; shared trading and danger semantics retain their meanings.
- **Nothing cached.** `export const dynamic = 'force-dynamic'` in the root layout. A stale kill-switch board is
  worse than no board.

## Screens

| Route                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`              | Individual founder sign-in using password plus TOTP/recovery or WebAuthn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/crm`                | Investor-first relationship pipeline, preserved questionnaires, owner assignment, next actions and history.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/accounts`           | Inspect identity, trading or merchant control state; submit a versioned action with reason and confirmation; read audit history.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/`                   | Kill-switches. Every flag grouped by module, resolved at the current `LAUNCH_DROP`, with the reason it resolved that way. `ledger.posting` gets its own alarm panel.                                                                                                                                                                                                                                                                                                                                                                                           |
| `/launch`             | The §11 drop table, plus "what would be live at drop N" resolved against a chosen drop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/jurisdiction`       | Counsel-review status per matrix entry, the effective module × region rule grid, and a live `checkAccess()` readout.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/ledger`             | Posting freeze / unfreeze (two-founder, disabled until the ledger returns its version), reconciliation controls (list as the founder; define, change and a two-founder run on the treasury transport, parked with the missing setting named without it), and pay halts.                                                                                                                                                                                                                                                                                        |
| `/support`            | Support queue, ticket detail, claim, and one change (assignee, status or priority) to several ticked requests at once; the batch size is the owner's blank setting.                                                                                                                                                                                                                                                                                                                                                                                            |
| `/support/settings`   | Support contact details: the email, phone and chat hours the help centre shows; a lead sets them, others read.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/notify`             | Notification delivery health by channel, with failures. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `/notify/status`      | Status page desk: what visitors read on /status with each reading's source and age, the components, groups, outside sources and owner values (saved from the revision read, with a reason), readings entered by hand for outside dependencies, and badge snippets per component.                                                                                                                                                                                                                                                                               |
| `/notify/incidents`   | Incident desk: declare an incident from a founder template or written by hand, ask for the approval its publish spends, approve another founder's request (the approver never publishes), post updates and resolve (final); define and retire templates (none supplied).                                                                                                                                                                                                                                                                                       |
| `/notify/maintenance` | Maintenance desk: schedule a window with the components it touches and reminder offsets (blank is none), the four-eyes publish, the state svc-notify derives (scheduled, in progress, verifying, completed, cancelled), the operators' moves with their reasons (a reopen is refused), and each reminder sent once.                                                                                                                                                                                                                                            |
| `/notify/notices`     | Announcement desk: write an announcement filed under one of the founders' categories (or none), the four-eyes publish, and the category list itself (an owner value, blank means the kinds alone; svc-notify refuses any category not on it with `status.category_unknown`).                                                                                                                                                                                                                                                                                   |
| `/notify/subscribers` | Status subscribers: who gets status updates by state and source, how each channel leaves (a channel with no sender named by its code), the delivery rows of one published notice with Send again (no row doubled), the two subscribe safeguards (blank refuses), and imports (a duplicate address is one record).                                                                                                                                                                                                                                              |
| `/tools`              | Operator tools already mounted on edge `/api/*/trpc/*` (bank.ops, KYC, freeze identity, merchantState, token mint, academy). Not-wired when env missing — never local green money success.                                                                                                                                                                                                                                                                                                                                                                     |
| `/bank-ops`           | Bank operations (read-only): earn pools, loan products, card programme, ramp programme and fiat probe, business-bank rules. Every figure carries the time it was read; loans book, pool totals, card and ramp volumes, business queue and the frozen-account list are printed as "Not available" with the reason.                                                                                                                                                                                                                                              |
| `/pay-ops`            | Personal Pay operations (read-only): rejected standing orders with a record read on request and a lookup by transfer id, failed bills and global sends with all-time totals, and transfer health over 24 hours and 7 days, each with its read time. One-off failures, pending lists and every operator action are named as not available or switched off, with the reason.                                                                                                                                                                                     |
| `/identity-ops/keys`  | Access-token signing keys: the key that signs now, previous keys still verifying, and the ids the identity host holds a secret for. Rotate and remove-old are two-founder requests (identity issues the approval, a different founder signs it, svc-identity spends it once). Only key ids appear; secrets are never entered here.                                                                                                                                                                                                                             |
| `/identity-ops/oauth` | Third-party OAuth apps outside developers registered: waiting, approved and suspended, each with client id, developer account, declared scopes and every redirect address, with the time it was read. Approve or suspend is one founder's decision with a written reason (and the app name typed back to approve); svc-identity needs the compliance permission and a second factor, and refuses the developer approving their own app. The logo is printed as an address and never loaded.                                                                    |
| `/p2p-ops`            | P2P operations (read-only): service posture, dispute backlog and the open-dispute queue with case detail, late settlements. Escalation and ruling are shown switched off with why (no service procedure / moves escrow). Offers and orders: not available.                                                                                                                                                                                                                                                                                                     |
| `/academy-ops`        | Academy operations: content inventory, depth and import status, certificate definitions, seasons, paper-trading posture, ambassadors (appoint, freeze and lift the freeze, each as a two-founder request), residency applications (accept or reject as a two-founder request). Enrolments and the grant audit: not available.                                                                                                                                                                                                                                  |
| `/more-ops`           | Agents (route table), Quant (health), Mining, Launch, Market (vendor applications and approved or suspended vendors with approve, reject, suspend as a two-founder request; public listings; commission), Token (governance proposals, burned supply, next emission epoch; reads only) and Campaigns. What a service cannot give is named, not zeroed.                                                                                                                                                                                                         |
| `/custody-ops`        | Custody approvals, built for a phone: tasks waiting on this approver, recent tasks, registered approvers and one task to read and decide. Approve and reject are typed back with the fingerprint prefix; svc-pay refuses the starter and unregistered approvers.                                                                                                                                                                                                                                                                                               |
| `/system/users`       | Staff and founders: the signed-in founder and the enrolment door, the staff roster svc-identity stores (`staff.list`), each member's page (`/system/users/:staffId`: record, roles with assign and unassign, disable and remove, and the access overview from `staff.access`), and the invite of one named person (never a link). Every change is a two-founder request spending its `identity.staff.*` or `identity.roles.*` approval. While svc-identity does not serve these procedures every page says so by code and every control is drawn switched off. |
| `/system/roles`       | Staff roles from `roles.list`: built-in roles show that the owner has not set their mapping (`identity.role_mapping_unset`) and are never assignable; custom roles show what they allow and deny. The custom-role editor (area by verb by environment, unset is denied) proposes a define that a second founder approves.                                                                                                                                                                                                                                      |
| `/protocol-ops`       | Protocol operations (read-only): chain status, audit status, indexer finality and DEX health, each with the time it was read, and the named blockers in front of every Protocol action (the customer rooms' wording, copied). A service that cannot be reached is shown as "could not load" and counts as a blocker. The network is labelled from the chain id a service reports and is never INTACHAIN or audited.                                                                                                                                            |

## Friction is proportional to blast radius

Every state-changing control here follows one flow: **request, second founder approves, run, then read the state again.**

- Request: a reason (12 to 500 characters) and the exact phrase (`KILL <module>`, `RE-ENABLE <module>`, `FREEZE LEDGER`,
  `UNFREEZE LEDGER`). Identity records an approval bound to a hash of that exact request.
- Approve: a DIFFERENT founder pastes the request packet, reads it in plain words, types the phrase and approves.
  Identity refuses the requester approving their own request. The approver's console recomputes the hash from
  what they read, so an edited packet cannot get a different request approved.
- Run: the owning service (svc-edge or svc-ledger) spends the approval once. The page shows what the service said,
  then reads the state again. It never advances a badge on its own. A 2xx counts only when the body shows the state asked for.
- Undo: re-enable and unfreeze are the same flow. The requester can withdraw an unused request; the other founder can reject it.
- Pay halts: setting a halt is one founder; clearing needs a second, different founder (svc-pay enforces it).
- Identity is never offered a kill: the console needs it to approve the way back.

## Module desks

`src/lib/ops-desk/catalog.ts` lists every read a desk makes (procedure, input, the columns it expects) and every figure it cannot show, with the number of the back-end need in `admin-BACKEND-NEEDS.md`. A catalogue test reads each owning service's router and fails if a read names a procedure that is not a query there. Reads run as the signed-in founder through svc-edge; the services check scopes, so a refused read says so in words and the rest of the desk still loads. Every list read has an "Export CSV" of exactly the rows shown (the filename carries the read time; cells that start with = + - @ are quoted as text). The only actions are `market.vendor.vet`, `academy.ambassador.appoint/freeze/unfreeze` and `academy.residency.decide`, all run through the two-founder flow above.

## Inspected transports

**Module kill-switches** reach svc-edge through this console (#186 + A-P5-OPS):

| Console route                              | Edge                                    | Env                                                                        |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------- |
| `GET/POST /api/kill-switch`                | `/admin/kill-switches`                  | `EDGE_URL` + `ADMIN_OPERATOR_TOKEN` (`admin:write` + MFA)                  |
| `GET/POST /api/ledger-freeze`              | `/admin/ledger/freeze` · unfreeze       | `EDGE_URL` + `ADMIN_TREASURY_TOKEN` (`admin:treasury`)                     |
| `GET /api/ledger-reconciliation`           | `/admin/ledger/reconciliation/controls` | current individual founder session (`admin:compliance`)                    |
| `POST /api/ledger-reconciliation` · `/run` | `…/controls` · `/update` · `/run`       | `EDGE_URL` + `ADMIN_TREASURY_TOKEN` (`admin:treasury`); run is two-founder |
| `GET/POST /api/operator-tools`             | `/api/{module}/trpc/{procedure}`        | current individual founder session; services enforce scopes                |

The `/` board reads current module state and audit, and each module's panel hosts its kill and re-enable controls. The run step is sent with the console's static operator credential, so the edge's own audit names that credential; the founders' identities and the reason are in identity's approval record and the console's log line.

Also mounted here, all read through the signed-in founder's own session: `/api/pay-halts` (svc-pay `payHalts.*`), `/api/support` (svc-support `listQueue` / `get` / `claim`), `/api/notify-health` (svc-notify `operatorDeliveries`), and `/api/compliance` (edge `/admin/compliance/*`, console operator credential).

Operator runbook: [`docs/OPS-KILL-SWITCH-RUNBOOK.md`](../../docs/OPS-KILL-SWITCH-RUNBOOK.md).

## Still not wired (honest residual)

Every gap is filed in `~/.codex/context/work/tasks/admin-BACKEND-NEEDS.md`. In short: ledger freeze and unfreeze stay disabled until svc-ledger's `GET /operator/freeze` returns its version; identity cannot list pending approvals, so the request packet is handed over by the founders; founder sessions do not carry `support:ops` or `admin:read`, so the support and notify desks show the service's refusal until identity grants them.

Current main's founder page and BFF gates remain authoritative and asynchronous. Browser mutation helpers obtain the current founder CSRF nonce before POST; an absent or malformed nonce is a definite no-dispatch refusal. A valid posting record cannot settle an unknown command.

## Founder sessions and deployment

Set `ADMIN_ORIGIN` to the exact HTTPS origin (planned `https://admin.intafaced.com`),
`EDGE_URL` to the internal edge base URL, and `ADMIN_SESSION_SECRET` to a canonical
base64url encoding of 32 random bytes. Generate that secret in the deployment
secret store; never commit it. Local HTTP is allowed only for localhost or
127.0.0.1 with explicit `APP_ENV=dev` or `test`.

The trusted ingress must preserve the public `Host` (including a configured
nondefault port), overwrite `X-Forwarded-Proto` with exactly one `https` value
(`http` only for explicitly configured local HTTP), and prevent direct external
access to the Next listener. Next may construct route request URLs with its
internal hostname and port; BFF authority therefore uses the preserved `Host`
and validated protocol instead. `X-Forwarded-Host` is ignored and cannot repair
a wrong `Host`. Empty, malformed, multiple or wrong protocol values refuse.
This header contract does not prove TLS; ingress configuration provides it.
Mutations still require the exact configured browser `Origin`, session CSRF
nonce and current live founder authority.

Sign-in uses the existing identity service. Every protected page and BFF request
requires the actual user's current enabled founder entitlement, active session
and live MFA. The sealed host-only Secure/HttpOnly/SameSite=Strict cookie holds
credentials until access-token expiry; credentials never enter browser storage
or JSON responses. Mutations also require the exact origin and session CSRF nonce.
There is no positive authority cache. Revoked founders can still sign out.
The former shared proxy-secret header does not authorize the console.

CRM and account BFFs forward the caller's Bearer token. Legacy account mutation
forms direct operators to `/accounts`, where inspection supplies the current
version. Trade and merchant controls report unavailable until their owned service
implementations are deployed; a UI receipt alone is not runtime enforcement.
The separate legacy platform kill/ledger/warehouse adapters still require their
existing server-side service credentials in addition to the founder gate. This
change does not grant new treasury or platform administrator scopes.

Deploy identity founder controls and ops CRM with their migrations and explicit
configuration before testing the complete workflow. Configure the exact host and
HTTPS ingress, keep cookie/key values out of logs, and verify revocation and
restart behavior against the deployed services. Notification delivery, provider
analytics, retention and backup restoration require their own launch evidence.

**Edge kill restart durability (not multi-replica):** svc-edge may set `EDGE_KILL_STATE_PATH`
(default `.data/edge-kill-state.json`) so a single-host bounce keeps incident kills. Multi-edge
shared state remains §13.

Strings are not i18n-keyed. §14.4 asks for that on user-facing copy; this console has one audience — the
operator — and keying it before the catalogue exists would add indirection without adding a reader. It is a
deliberate deviation, not an oversight, and it is listed on the DoD gate's manual sign-off block.

## Gaps found in `packages/config`

Recorded here because the console had to work around each of them.

1. **No provenance on flag resolution.** `resolveAll()` answers "is it on?", never "why?". On a kill-switch
   board the second question is the one that matters. `src/lib/flag-state.ts` derives it by re-asking
   `isEnabled()` with narrowed contexts — correct, but it should be a `explain(key, ctx)` in `flags.ts`.
2. **`DROP_ORDER` is private.** There is no exported way to compare two drops, so ordering is read off the
   `DROPS` tuple with `indexOf`.
3. **Drops have no labels.** §11 names the six phases (Tease, Blueprint, Lobby preview, Soft launch, Public
   drop, Seasons); the code has only `'0' | 'I' | …`. `src/lib/drops.ts` carries them for now.
4. **`ruleFor()` is private.** Any UI that renders the _effective_ rule rather than a yes/no decision has to
   recompose `entry.modules?.[m] ?? DEFAULT_MODULE_RULES[m]` itself. See `effectiveRule()` in
   `src/components/jurisdiction-board.tsx`.
5. **`checkAccess()` returns `requiredTier` only on denial.** An allowed decision cannot report the tier that
   was required, so the console cannot show "allowed, and this is what it took".
6. **Two modules have no flag at all** — `market` and `indexer`. `tooling/ci/dod-gate.mjs` fails a service
   whose module id never appears in `flags.ts`, so both are a blocked Definition of Done the day their service
   lands. The console lists them under "Modules with no kill-switch".

## Protected founder CRM workflows

`/crm` includes enquiry review, a global reporting summary, a bounded due-task queue, campaign/source configuration, controlled duplicate review and original-submission exports. The protected `/api/crm/workflows` BFF forwards each founder's actual Bearer token after current entitlement/MFA and CSRF checks. It validates shared schemas and result targets; mutation receipts without actor fields are checked against the immutable protected workflow audit for the matching request, founder, subject and action. An old replay outside the most recent 100 audit records refuses confirmation rather than inventing attribution.

Global summaries query the owned metrics port; table counts are explicitly page-local. Audience, stage and owner filters scope totals and exports; text search only scopes the enquiry table. Unknown source evidence stays unknown. Papermark Free reports `api_access_unavailable`, never zero imported analytics or a verified recipient.

Enquiry detail fetches protected original-contact provenance and binds the original submission/contact to the requested opportunity's canonical contact. A merge changes canonical linkage while preserving original contacts, answers and verification evidence. Manual merges require explicit source/target choices, current contact revisions, a reason and confirmation. Staff see both records before acting.

Task transitions bind both opportunity and task revisions. Finishing the primary next-action task for an open enquiry requires a replacement. Call invitation, booking and follow-up evidence is labelled **manually recorded**: these forms do not dispatch email or pretend a message was sent. The separate enquiry-message form queues transactional messages through the owned ops outbox. It discloses the original submission recipient even after a canonical merge, binds the queue receipt to the founder/opportunity/submission, and distinguishes durable queue acknowledgement from gateway acceptance, arrival and unresolved dispatch. It exposes no resend button for unknown acceptance. Real gateway configuration and delivery evidence remain deployment requirements.

Exports are explicit authenticated mutations, bounded to 1–200 original submissions per page, audited and downloaded only when requested. Each JSON page includes initial consent, preserved answers, original/canonical contact linkage and capture attribution. Browser code retains the request UUID after ambiguous writes and acknowledges saved receipts independently from a failed refresh.

Deploy the matching reviewed svc-ops service and its outreach migrations before using these panels. Desktop/mobile browser recordings use clearly labelled synthetic identity/ops fixtures; they prove UI and transport behavior, not production service readiness.

Contact privacy previews the canonical contact and every merged alias before explicit whole-cluster confirmation. Starting saves an intent and pauses that cluster; one explicit advancement performs one bounded notification-erasure step. Unknown receipts remain pending with originals retained. Either current founder can recover an existing intent from the selected contact after reloading, without a reference lookup or automatically issuing destructive commands. Completion clears the old selected view only after its bound receipt. Accepted external email and independently downloaded exports cannot be recalled here. Automatic retention stays disabled until the outreach policy is configured; operational backup/restore handling belongs to svc-ops.
