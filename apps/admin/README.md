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

| Route           | What it does                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`        | Individual founder sign-in using password plus TOTP/recovery or WebAuthn.                                                                                                                  |
| `/crm`          | Investor-first relationship pipeline, preserved questionnaires, owner assignment, next actions and history.                                                                                |
| `/accounts`     | Inspect identity, trading or merchant control state; submit a versioned action with reason and confirmation; read audit history.                                                           |
| `/`             | Kill-switches. Every flag grouped by module, resolved at the current `LAUNCH_DROP`, with the reason it resolved that way. `ledger.posting` gets its own alarm panel.                       |
| `/launch`       | The §11 drop table, plus "what would be live at drop N" resolved against a chosen drop.                                                                                                    |
| `/jurisdiction` | Counsel-review status per matrix entry, the effective module × region rule grid, and a live `checkAccess()` readout.                                                                       |
| `/ledger`       | Freeze / unfreeze / reconcile. Freeze requires a written reason, a typed confirmation phrase, and an explicit acknowledgement.                                                             |
| `/tools`        | Operator tools already mounted on edge `/api/*/trpc/*` (bank.ops, KYC, freeze identity, merchantState, token mint, academy). Not-wired when env missing — never local green money success. |

## Friction is proportional to blast radius

- `reconcile` — read-only on the book. One click.
- `unfreeze` — resumes value movement. One acknowledgement.
- `freeze` — stops the platform. Reason (≥ 12 chars) **and** the literal phrase `FREEZE LEDGER` **and** a
  checked acknowledgement. All three, or the button stays dead.
- `ledger.posting` off — same reasoning on the kill-switch board: the switch is locked until the operator
  acknowledges the platform-wide blast radius in the panel above it.

## Wired (live)

**Module kill-switches** reach svc-edge through this console (#186 + A-P5-OPS):

| Console route                  | Edge                              | Env                                                         |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------- |
| `GET/POST /api/kill-switch`    | `/admin/kill-switches`            | `EDGE_URL` + `ADMIN_OPERATOR_TOKEN` (`admin:write` + MFA)   |
| `GET/POST /api/ledger-freeze`  | `/admin/ledger/freeze` · unfreeze | `EDGE_URL` + `ADMIN_TREASURY_TOKEN` (`admin:treasury`)      |
| `GET/POST /api/operator-tools` | `/api/{module}/trpc/{procedure}`  | current individual founder session; services enforce scopes |

The `/` board **loads live disabled modules** and **posts module kill/enable** with a required reason when the
control plane status is `reachable`. Per-flag rows remain session-staged (flag store §13).

Operator runbook: [`docs/OPS-KILL-SWITCH-RUNBOOK.md`](../../docs/OPS-KILL-SWITCH-RUNBOOK.md).

## Still not wired (honest residual)

`src/lib/operator-commands.ts` still stubs **ledger reconcile** (and the Ledger ops page still uses those stubs
for freeze/unfreeze UI — prefer `/api/ledger-freeze` when wiring that screen). Every simulated result says so
on its face; no invented money number.

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
