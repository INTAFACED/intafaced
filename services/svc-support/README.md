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

| Procedure              | Scope                 | Behaviour                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support.create`       | `support:write`       | Create ticket for principal. `phishing` category may carry pasted `messageHeaders` (refused on any other category); a `clientRequestId` makes a replay return the first ticket, and the same key with different content is `support.idempotency_conflict`. Signed-out reports wait on a rate-limited edge door. |
| `support.listMine`     | `support:read`        | List caller tickets                                                                                                                                                                                                                                                                                             |
| `support.listAll`      | `support:ops`         | Operator list                                                                                                                                                                                                                                                                                                   |
| `support.get`          | `support:read` / ops  | Self or operator                                                                                                                                                                                                                                                                                                |
| `support.comment`      | `support:write` / ops | Add comment. User reply on `resolved` reopens (clears assignee). User comment on `closed` refused.                                                                                                                                                                                                              |
| `support.listComments` | `support:read` / ops  | Thread for ticket                                                                                                                                                                                                                                                                                               |
| `support.setStatus`    | `support:ops`         | Status change + trail row                                                                                                                                                                                                                                                                                       |
| `support.events`       | `support:read` / ops  | Audit trail, oldest first                                                                                                                                                                                                                                                                                       |
| `support.accountState` | `support:ops`         | Grounding read (no userId)                                                                                                                                                                                                                                                                                      |
| `support.escalate`     | `support:ops`         | Case file; refuses if empty                                                                                                                                                                                                                                                                                     |
| `support.caseFile`     | `support:ops`         | Case file or null                                                                                                                                                                                                                                                                                               |
| `support.listKb`       | public                | Platform i18n-keyed spine                                                                                                                                                                                                                                                                                       |
| `support.searchKb`     | public                | Search spine by fragment                                                                                                                                                                                                                                                                                        |
| `support.getKb`        | public                | One article or null                                                                                                                                                                                                                                                                                             |
| `support.listQueue`    | `support:ops`         | Unassigned open/pending only                                                                                                                                                                                                                                                                                    |
| `support.next`         | `support:ops`         | Peek next free ticket                                                                                                                                                                                                                                                                                           |
| `support.claim`        | `support:ops`         | Exclusive claim (atomic)                                                                                                                                                                                                                                                                                        |

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
is logged in `ticket_property_log`; `listQueue` takes a `label` filter.
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
refuses `support.rating_window_invalid`. The emailed rating request waits on the mail path
(`vendor.email`); the in-app prompt does not.

Contact channels: the owner-set support email, phone and chat hours. `contactChannels` is public (a
signed-out visitor reads it) and answers each channel as a value or `null`; nothing is seeded and no address,
number or hour is built in. `setContactChannels` (`support:ops`, staff lead only, until the `support:admin` scope
exists) sets one or more from the revision it read, with a reason; `null` clears one. A change is logged
append-only in `contact_channel_log` under `support.contact:r<revision>`; the same change replayed returns the
first answer and a different change from a stale revision refuses `support.contact_revision_stale`.

## Migrations

```bash
DATABASE_URL=postgres://svc_support:svc_support@localhost:5433/intafaced pnpm --filter @intafaced/svc-support db:migrate
```

Dev bootstrap creates role/schema via `tooling/infra/postgres-init/01-service-schemas.sql`.
`tooling/infra/migrate-all.mjs` includes `svc-support`.

## Events

**None published.** Ticket create/status stay in-process until a bus catalog
subject is accepted (events PR first). No orphan subjects.

## Ledger

**No ledger recipes.** This service holds no balances and never calls
`packages/ledger-client`.
