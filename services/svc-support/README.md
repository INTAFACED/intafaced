# svc-support

Support desk for `ops.support` — tickets + knowledge base + operator queue.

**Durable store:** Postgres schema `support` (role `svc_support`). Memory store
remains for unit tests only. Multi-replica claims use an atomic `UPDATE … WHERE
assignee_id IS NULL`.

No ledger posts. No refund money path. Refunds are requests only; money stays in
pay/ledger recipes elsewhere.

Doctrine: §0.6 no balances here; brand scan on KB copy; agent optional later.

## The desk can say what it read

Three properties, added together because each is useless without the others.

**Audit trail** — `support.ticket_events`. Every state change writes its own row
in the SAME transaction, so there is no path that moves a ticket without
recording who moved it and from what. Append-only and dense-sequenced by unique
index in the database, not just in TypeScript. Claims lock the ticket row
(`FOR UPDATE`) before writing trail `fromStatus`, so a concurrent status move
cannot invent a second `open → pending`. Escalation writes the case file and
the `escalated` trail row in one transaction. `src/lifecycle.ts` holds the
legal moves; migration 0002 re-asserts the full edge table in Postgres (not
only `closed` terminal). Self-transitions are refused rather than written as a
row recording no change.

**Account-state grounding** — `src/account-state.ts` READS
`accountStateSchema` (`userId` + `status` + `kycTier`, three fields) from
svc-identity per request. It is deliberately not a local projection: a desk
holding its own copy of account status lets an operator reassure a user from a
stale view of a freeze. `accountState` takes no `userId` — the id comes off the
ticket, so `support:ops` is not a platform-wide account lookup. An unreachable
identity plane answers `{status:'unread', reason:'plane_dark'}` and never an
invented `active`.

**Escalation case file** — `support.case_files`, immutable once written.
Citations are `{kind, ref, sha256 digest}`: proof of what was read, never a copy
of it, so the record cannot become the PII archive §10 keeps documents out of.
An escalation citing nothing is refused at three layers — the builder, the zod
contract, and a CHECK constraint. There is no `amount` field anywhere;
`money_request` is a reason NAME that files a request for whoever owns the
pay/ledger recipe.

**No SLA.** Queue priority is a score, not a promise. Every queue row carries
`timingKind: score_not_promise` and `sla: false` — never `eta` / `dueAt` /
`slaMinutes`. Describing support timing to a user needs an owner ruling
(DIRECTION §8 item 9).

## API

tRPC under `/trpc` (edge mounts `/api/support`). Principal via edge HMAC
(`EDGE_PRINCIPAL_SECRET`).

| Procedure                  | Scope                 | Behaviour                                                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support.create`           | `support:write`       | Create ticket for principal. `phishing` category may carry pasted `messageHeaders` (refused on any other category); a `clientRequestId` makes a replay return the first ticket, and the same key with different content is `support.idempotency_conflict`. Signed-out reports wait on a rate-limited edge door. |
| `support.listMine`         | `support:read`        | List caller tickets, each with `customerStatus` (`awaiting_reply`, `open`, `solved`: whose turn it is, never a time); `get` carries it on the owner's read                                                                                                                                                      |
| `support.createdByRequest` | `support:read`        | The caller's own ticket a `create` key made, or null; a page whose create answer was lost reads this instead of sending again                                                                                                                                                                                   |
| `support.listAll`          | `support:ops`         | Operator list                                                                                                                                                                                                                                                                                                   |
| `support.get`              | `support:read` / ops  | Self or operator                                                                                                                                                                                                                                                                                                |
| `support.comment`          | `support:write` / ops | Add comment. User reply on `resolved` reopens (clears assignee). User comment on `closed` refused.                                                                                                                                                                                                              |
| `support.listComments`     | `support:read` / ops  | Thread for ticket                                                                                                                                                                                                                                                                                               |
| `support.setStatus`        | `support:ops`         | Status change + trail row                                                                                                                                                                                                                                                                                       |
| `support.events`           | `support:read` / ops  | Audit trail, oldest first                                                                                                                                                                                                                                                                                       |
| `support.accountState`     | `support:ops`         | Grounding read (no userId)                                                                                                                                                                                                                                                                                      |
| `support.escalate`         | `support:ops`         | Case file; refuses if empty                                                                                                                                                                                                                                                                                     |
| `support.caseFile`         | `support:ops`         | Case file or null                                                                                                                                                                                                                                                                                               |
| `support.listKb`           | public                | Platform i18n-keyed spine                                                                                                                                                                                                                                                                                       |
| `support.searchKb`         | public                | Search spine by fragment                                                                                                                                                                                                                                                                                        |
| `support.getKb`            | public                | One article or null                                                                                                                                                                                                                                                                                             |
| `support.listQueue`        | `support:ops`         | Unassigned open/pending only                                                                                                                                                                                                                                                                                    |
| `support.next`             | `support:ops`         | Peek next free ticket                                                                                                                                                                                                                                                                                           |
| `support.claim`            | `support:ops`         | Exclusive claim (atomic)                                                                                                                                                                                                                                                                                        |

HTTP: `GET /health`, `GET /ready` (`stage: 4-audited-grounded-desk`,
`store: postgres`, `accountStateSource: svc-identity`, desk vs
`agents.support` split fields, `identityGroundingRefuse` named
`support.identity_grounding_unwired` when the S2S secret is blank).

**Env:** `INTERNAL_SERVICE_SECRET` is REQUIRED — the grounding read is an S2S
call and `/internal/account/:userId` hard-401s an unauthenticated caller.
Refusing to boot without it is deliberate: a desk that started anyway would
report every account as unread, which from an operator's chair is
indistinguishable from every account genuinely being unreadable.
`IDENTITY_URL` defaults to `http://localhost:4002` for a dev stack.
`STAFF_HEARTBEAT_WINDOW_SECONDS` is an owner value and stays blank by default:
blank means staff availability (online, busy, offline) is manual, the desk says
automatic offline is not set (`staffAvailabilityPolicy`), and a heartbeat
refuses `support.heartbeat_window_unset`.
Desk groups: while no group exists every support:ops caller sees the whole queue
(`deskScope` says `restricted: false`). Once any group exists an agent sees the
tickets of their groups plus tickets assigned to them, a lead also sees tickets in
no group (so a new one can reach a group), and a ticket outside the scope answers
as not found on every operator door. `SUPPORT_ALL_GROUPS_ROLES` (comma separated
`agent`, `lead`) is an owner value, blank by default: it marks roles that see every group.
A lead can add themselves to any group, so group scope limits agents, not leads.
Agent-set priority, type and labels (`setProperties`, `ticketProperties`) live in `ticket_properties`
beside the ticket, never on it: the ticket owner reads the ticket and must not see them. Each change
is logged in `ticket_property_log`, which staff read with `propertyChanges` (one entry per field changed,
oldest first; the console shows them in the ticket history); `listQueue` takes a `label` filter.
A ticket can be put `on_hold` by an agent, with a reason (the status note, shown in the owner's history).
On hold leaves the queue; a customer reply on `pending` or `on_hold` puts it back to `open` with one trail
row. `ticket_lifecycle` (beside the ticket) keeps who it waits on, when the first public reply went out
(every operator comment is public; there are no internal notes) and the closed request a new one follows
(`create` with `followsTicketId`, the caller's own closed ticket, else `support.follow_up_invalid`);
staff read it with `ticketLifecycle`. These facts are written just after the ticket write, so a crash
between the two leaves them stale until the next reply or status change.

Ratings: the owner rates a resolved or closed request once (`rate`, replay safe). `ratedMine` returns the ids of the caller's own rated requests, so a list can offer "rate this" on the rest. `ratingSummary`
(`support:ops`) takes a stated window `[from, to)` with no default and covers the requests resolved or
closed now whose last change falls in it: solved count, responses, count per score 1 to 5 and the rated
share in basis points (null with nothing solved, so the screen shows no percentage). With no ratings it
returns zero responses and the screen shows no average. A window that does not start before it ends
refuses `support.rating_window_invalid`. The emailed rating request is announced on the bus (see Events);
whether anyone is emailed is svc-notify's answer and waits on the mail path (`vendor.email`). The in-app
prompt does not wait on either.

Contact channels: the owner-set support email, phone and chat hours. `contactChannels` is public (a
signed-out visitor reads it) and answers each channel as a value or `null`; nothing is seeded and no address,
number or hour is built in. `setContactChannels` (`support:ops`, staff lead only, until the `support:admin` scope
exists) sets one or more from the revision it read, with a reason; `null` clears one. A change is logged
append-only in `contact_channel_log` under `support.contact:r<revision>`; the same change replayed returns the
stored state (it already applied) and a different change from a stale revision refuses `support.contact_revision_stale`.

Macros and signatures (SP-desk-02): `macros` lists the desk's shared macros and `macroApply` fills one from a request
without writing anything (any agent, `support:ops`). `macroSave` (`support:ops`, staff lead only, until the
`support:admin` scope exists) is desk configuration, so it uses the same `actor.role !== 'lead'` check and the same
`support.not_lead` code as `setContactChannels` and `setAttachmentSettings`. A body may use only the closed placeholder
list `SUPPORT_MACRO_PLACEHOLDERS` in `packages/contracts` (today only `{{ticket.id}}` is filled; a placeholder the desk cannot fill stays as written and
is named); an unknown one refuses `support.macro_placeholder_unknown` on save. A reply still holding a placeholder
refuses `support.macro_placeholder_blank` on send. A shortcode below the owner-set minimum refuses
`support.shortcode_too_short`, a blank minimum `support.shortcode_rule_unset`. `signature` and `signatureSet` read
and write the caller's own signature, from the revision read; the console puts it in a public reply's draft as it is
composed, and the service adds nothing on send.

Awaiting reply: `awaitingMine` (`support:read`) answers how many of the caller's own open requests wait on their reply and
which has waited longest, as a count and one pointer (no list, so no page size). The ticket the owner reads still never carries
`waitingOn`; a resolved or closed request waits on nobody.

Help article audiences (SP-help-centre-02): every article has an audience, `public` (the default), `signed_in` or `staff`,
kept on the immutable version row. `listKb`, `searchKb`, `getKb` (with or without a version), `kbRelated` and `kbFeedback`
show an article only to a reader its audience allows, decided from the signed principal on every path: a visitor has no
principal, the desk is a `support:ops` principal. The filter runs before the page limit, so a hidden article takes no
place in a page and is in no count, and it answers exactly like a missing id (`null`, or the same refusal). `setKbAudience`
(`support:ops`) takes the revision the desk read, writes a new version that keeps the keys and topic, and one audit row
(`support.kb_audience_changes`: article, from, to, revisions, actor; append-only). The same audience again changes nothing
and writes no row. A stale revision is a CONFLICT (`support.kb.revision_stale`); an audience outside the list never
reaches the service and, if it does, refuses `support.kb_audience_invalid`. Per-segment visibility is not built: whether it
is wanted is a thread decision, and `support.kb_segment_cap_unset` is not introduced until it is.

Attachment limits (SP-tickets-02): the owner sets the largest file (`maxBytes`), the allowed content types and the number of
files one request may hold (`maxCount`) in `support.attachment_settings`, one row with a revision and an append-only log
(`support.attachment_settings_log`, keyed `support.attachment_settings:r<revision>`). All three start blank and nothing is
seeded. `attachmentLimits` (`support:read`) answers them with `missing`, the first of the five pieces an attach lacks
(store, scanner, size, types, count); `attachmentStatus` (`support:ops`) lists the five and whether each is set;
`setAttachmentSettings` (`support:ops`, staff lead, a reason, the revision read) changes them. A limit the deployment's desk
supplies wins over the owner's row. An attach with a blank piece refuses `support.attachments_unconfigured` naming the key,
and a blank count refuses `support.attachment_count_unset`; a request already at its count refuses
`support.attachment_count_reached`, decided under the ticket row lock so two files cannot both take the last place, and a
replay of an attach already made is never refused for the count. The store and the scanner are deployment configuration:
production wires neither, so every attach refuses naming `support.attachment_store`. For the test stack only,
`SUPPORT_ATTACHMENT_STORE=local-test-memory` (bytes kept in this process, lost on restart) and
`SUPPORT_MALWARE_SCANNER=local-test-eicar` (infected only for the EICAR test string) install LOCAL-TEST adapters; boot
throws `support.attachment_adapter_refused` unless `APP_ENV` is exactly `dev` or `test`, and for any other name. Size, types
and count still come from the owner's settings, so a journey sets them through the admin card first.

Scan state: a file's row is written `scanning` first (`support.ticket_attachments.scan_state`, migration 0024; rows from before
read `clean`). Bytes reach the final store key only after a clean verdict, then the row is marked `clean`. An infected one marks the row
`blocked`, stores nothing and refuses `support.attachment_scan_refused`, and a blocked file holds no place on the request; a
scanner that cannot say (or fails) keeps the bytes under a held key (`held/<key>`) that nothing serves, leaves the row
`scanning` and refuses `support.attachment_scan_unknown`. A clean pass moves held bytes to the final key and drops the held
copy; a block that lands while the scan runs, or a later infected verdict, purges both keys. A row only ever leaves
`scanning` once. `attachmentDownload` (owner) and `attachmentDownloadOps` (the assigned operator) serve a file only when it is
clean, as base64 under the fixed type `application/octet-stream` and always as an attachment; a file that is not the caller's
answers as not found. A retry under the same request id never scans or stores twice. `rescanHeldAttachments` scans held files
again; it runs on a timer only when the owner has set both `SUPPORT_ATTACHMENT_RESCAN_SECONDS` and
`SUPPORT_ATTACHMENT_RESCAN_BATCH`, and with either blank held files wait for the owner's retry. A held file whose bytes never
reached the store stays held. `ticketAttachments` (`support:read`) lists the files on one ticket with their scan state and no store
key, for the owner or for an operator who may see the ticket; its page size is the caller's and a blank one refuses
`support.list_attachments_limit_unset`.

Agent upload: `attachOps` (`support:ops`) lets the operator the ticket is assigned to add a file for its owner. Same limits, scanner,
store and count as the owner's attach; the file belongs to the owner, who sees it like a comment, and
`support.ticket_attachments.uploaded_by` (migration 0025) names the operator, `null` when the owner added it. A ticket that is not
the caller's answers as not found. The retry key is the operator's own, so an operator and an owner never replay each other.

Bulk update (SP-tickets-07): `bulkUpdate` (`support:ops`) applies one change (an assignee, a status or a priority) to several
requests under one batch key; `bulkPolicy` says the batch size. The size is the owner's `SUPPORT_BULK_CAP` and stays blank by
default: while blank, the policy answers `cap: null` and a batch refuses `support.bulk_cap_unset`; a batch over the cap
refuses `support.bulk_too_large`; neither touches a request. Each request goes through the path a single change takes (`setStatus`,
`assignTo`, `setTicketProperties`) under the key `bulk:<batchKey>:<ticketId>`, so each writes its own trail row and a replayed batch
changes nothing twice and returns the first answers. The answer lists every request as `changed`, `unchanged` (already at the asked status) or `refused` with the
typed code the single change gives, and the rest of the batch still runs. Assigning needs a lead and is refused once up front.

Merge duplicates (SP-tickets-07): `mergeTickets` (`support:ops`, reason required) folds a duplicate request (the source) into the one
that stays (the survivor). It is irreversible. Both requests must be below resolved (open, pending or on hold) and belong to the same
requester account, otherwise `support.merge_not_allowed`; the same request twice is `support.merge_same_ticket`. In one transaction the
comments and files move to the survivor, the source ends `closed` (its `mergedInto` read from `support.ticket_merges`), and a `merged`
trail row lands on both requests. A rating or an escalation case file stays on the source. The key is (source, survivor): a replay returns
the stored result and moves nothing. `previewMerge` reads what would move and what stays, for the confirmation.

## Migrations

```bash
DATABASE_URL=postgres://svc_support:svc_support@localhost:5433/intafaced pnpm --filter @intafaced/svc-support db:migrate
```

Dev bootstrap creates role/schema via `tooling/infra/postgres-init/01-service-schemas.sql`.
`tooling/infra/migrate-all.mjs` includes `svc-support`.

## Events

One subject, on the `support` stream: `intafaced.support.ticket.resolved`. The first time a ticket becomes
`resolved`, a trigger writes a row in `support.rating_requests` in the same transaction as the status
change (a reopen and a second resolve write nothing more, so the customer is asked once). The row is
published with the key `support.rating_request:<ticketId>` and marked; a sweep at boot and every minute
publishes the rest. A failed publish keeps the row and never fails the status change. With the bus
unreachable the desk still serves, the rows stay pending and each sweep tries to connect again. Tickets resolved before migration
0021 are not asked. Ticket create and other status moves stay in-process. No orphan subjects.

## Ledger

**No ledger recipes.** This service holds no balances and never calls
`packages/ledger-client`.
