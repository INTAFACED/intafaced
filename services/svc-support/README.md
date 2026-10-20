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
