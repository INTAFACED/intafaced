# svc-academy

**Live lobbies with capacity tiers (§8.3, §XIII)** plus the **curriculum library** (list · body · study guide · depth). Rooms gated free / staked / invite, sessions inside them, presence, a serializable 2D scene, and Blueprint-path playbooks, lessons and workbooks.

> §8.3: _"Lobbies: rooms (capacity tiers: free/staked/invite), stage + chat + shared charts via ws-gateway; streaming ingest v1 = LiveKit self-hosted (WebRTC SFU, self-hosted per sovereignty; behind `StreamProvider` interface)."_

**Shipped here.** Lobbies (`academy.lobbies`) and the curriculum READ surface (`curriculum` · `curriculumItem` · `curriculumStudyGuide(s)` · `curriculumDepth` — A-P5-2 and after).

**Deliberately not finished here**, each for a stated reason:

| Absent                                                                        | Why                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live audio/video                                                              | There is no SFU in this stack and no credential for one. The provider is `none` and **refuses** — see below.                                                                                                                          |
| Full DERIV//DESK library (20 playbooks + 3 workbooks)                         | Proprietary library is **not in this monorepo**. The 20 + 3 on tip are platform-native and written here, at full length — that is the honest claim, and it is not the licensed import, which stays residual rather than invented.     |
| Cert → **perk** invent / money                                                | D26-P1-C1: `grantCert` surfaces **real** identity perks after XP, or **refuses** when identity is unreadable / invent is requested. Academy never maps cert→perk and never invents perk money (`certs/perk-plane.ts`).                |
| Ambassador **IFC pay / revenue share** (programme + residencies Stage-1 ship) | **Money under rate authority (D26-P1-C2).** Appoint/freeze/badge and residency apply/decide are real. Owner-published IFC / share law opens dry-run quotes; live settlement refuses until Class M ledger recipes. Never invent rates. |
| Tournament **IFC prize pools** (ladder Stage-1 ships)                         | Seasons + standings + lifecycle edges are real. Blank/unset pools typed-refuse `academy.prize_pool_unset` (cannot start). Prize fund/payout refuse-closed — no invent IFC. Class M recipes are a separate PR.                         |

---

## This service is `custodial: false`, and the deployment is part of the proof

There is **no `LEDGER_URL`** in its environment and no ledger client in the process. It holds no credential that could reach anything which moves value — the same argument svc-dex's compose block makes. When ambassador pay lands (§8.3 "per-session IFC pay + sub revenue share (ledger recipes)"), it arrives as recipes in `packages/ledger-client` and a `LEDGER_URL`, as its own reviewable change.

The only `numeric(38,18)` column in the `academy` schema is `rooms.min_stake`, and it is a **threshold, not a balance** — a number this service compares against a stake it reads from svc-token, and never stores. It is `numeric(38,18)` because a threshold compared against a scaled amount must carry the same scale; it is a scaled `bigint` in memory and a decimal string on the wire, like every other amount in the OS.

---

## Who may take a seat

One pure function, `decideSeat()`, is the whole rule — read by the join path, by the "can I join" badge, and by its tests, so they cannot drift apart.

| Room access | Admitted when                                  |
| ----------- | ---------------------------------------------- |
| `free`      | there is a seat left                           |
| `staked`    | `stakeOf(caller) >= room.minStake`, and a seat |
| `invite`    | a live invitation, and a seat                  |

Two decisions worth naming:

- **The gate is checked before the seat count.** Telling somebody a room is full when they were never eligible sends them back to wait for a seat they could not use; telling them they need to stake first is something they can act on.
- **The host is admitted unconditionally.** A host who drops and reconnects would otherwise find their own session full — the seat they vacated having been taken while they were away — leaving the room with no stage. It is also why an ambassador running a staked room does not have to stake into it.

The stake gate **fails closed**, but it is only consulted for `staked` rooms (`needsStakeCheck`). That is what keeps an unreachable svc-token from emptying the free and invite-only lobbies too.

The seat itself is claimed under `SELECT … FOR UPDATE` on the session row, so two people racing for the last seat cannot both get it. The **gate** is evaluated before that lock is taken, deliberately: a stake lookup is a network call, and holding the busiest row in a live lobby across one would serialise every join behind svc-token's latency.

---

## Who may open a room — and why it is not a scope

`academy:write` is issued to every session (`packages/auth/src/scopes.ts`), because taking a seat is a write and a lobby nobody may sit in is not a lobby.

Hosting is a different question, and §4.1 already answered it: `rank_thresholds.perks` is "the machine-readable perk table other services query", and the field it carries for this service is **`lobbyHostRights`** — false at ranks 0–3, true from rank 4 (`services/svc-identity/src/rank/thresholds.ts`). `createRoom` reads it from svc-identity over the internal S2S secret and refuses without it.

Had hosting ridden on the scope, issuing `academy:write` would have handed room creation to every account on the platform in the same commit. §XIII's model is ambassadors and operators running rooms, not anyone with a login.

The perk is checked on `createRoom` **and nowhere else**. `invite`, `scheduleSession`, `startSession`, `endSession` and `updateScene` check `assertHost` against a room the caller already owns. Rank can fall, and a host whose rank slipped mid-residency must still be able to end the session they are running and empty the room — re-checking the perk on `endSession` would strand live attendees in a session nobody is allowed to close.

Like the stake gate, it **fails closed**: an unreadable perk table refuses hosting rather than admitting it, because the alternative is opening room creation to the whole platform for the length of an svc-identity outage.

---

## Streaming is `none`, and says so

`ACADEMY_STREAM_PROVIDER` accepts one value in this build: `none`. §8.3 names LiveKit self-hosted as the v1 ingest; **there is no LiveKit deployment in this environment and no API key for one.**

So `NullStreamProvider` **refuses by name** rather than returning a plausible token. A stub that answered `{ url: 'wss://…', token: 'dev' }` would let a lobby open, let attendees take seats, and fail silently in every browser — which reads to the user as "the platform is broken" and to an operator watching `/health` as nothing at all. `src/stream/provider.test.ts` exists to keep that property when a real provider is added beside this one.

Lobbies still run without it: seats, presence, capacity, invites and the 2D scene canvas need no provider, which is why `join` never calls one.

`/ready` reports `stream.usable: false` rather than 503. A lobby without an SFU is a degraded lobby, not a dead service, and 503 would take the Academy out of the fleet over a feature the rest of it does not need. Tracked as §13 socket `socket.stream-provider`.

---

## API

tRPC, mounted at `/trpc`, reached through svc-edge at `/api/academy` (port 4016).

| Procedure                     | Scope           | Purpose                                                     |
| ----------------------------- | --------------- | ----------------------------------------------------------- |
| `health`                      | public          | Liveness                                                    |
| `curriculum`                  | `academy:read`  | List the spine (filter by Blueprint path / kind)            |
| `curriculumItem`              | `academy:read`  | One item: markdown body **plus** its teaching scaffolding   |
| `curriculumStudyGuide`        | `academy:read`  | One item's objectives / key terms / self-check, no body     |
| `curriculumStudyGuides`       | `academy:read`  | Study guides for a whole path — one call for an index       |
| `curriculumDepth`             | `academy:read`  | Depth inventory; **names** anything under the floor         |
| `rooms` / `room`              | `academy:read`  | Lobbies and their terms                                     |
| `session`                     | `academy:read`  | One session and its live occupancy                          |
| `join` / `leave`              | `academy:write` | Take or vacate a seat                                       |
| `streamCredential`            | `academy:write` | Join token for the stage — refused while provider is `none` |
| `createRoom`                  | `academy:write` | Host a lobby — **also gated on §4.1 `lobbyHostRights`**     |
| `invite`                      | `academy:write` | Invite somebody to an invite-only room (host only)          |
| `scheduleSession`             | `academy:write` | Schedule a session in a room (host only)                    |
| `startSession` / `endSession` | `academy:write` | Host controls                                               |
| `updateScene`                 | `academy:write` | Write the 2D scene (host only)                              |

### Curriculum

- Paths are exactly Blueprint `curriculumPath`: `foundations` · `markets` · `builder` · `sovereign`.
- Kinds: `playbook` · `workbook` · `lesson`.
- Pure in-process library — no DB table, no progress, no money. **Registry** is
  `src/curriculum/catalog.ts` (slugs, paths, ordering, queries, and no prose at
  all); **content** is `src/curriculum/content.ts` (every body, plus objectives,
  key terms and self-check questions per slug).
- Unknown slug → `academy.curriculum_not_found` (NOT_FOUND).
- A catalog row cannot ship without a body and a scaffold: both lookups throw at
  module load, so an item that teaches nothing fails where a human sees it rather
  than serving an empty screen.
- `estimatedMinutes` is derived from the body at 200 words per minute, never
  hand-typed, so it cannot drift away from what it describes.

#### Depth, and why there is a surface for it

`curriculumInventory` answers _are there 20 playbooks and 3 workbooks_. Counting
is not reading: an older 40-character stub gate once let every spine item pass
while the median body was 258 characters. That gate is gone.

`curriculumDepth` and the import pipeline both use the editorial floor
`CURRICULUM_MIN_BODY_CHARS` (**900** characters). Depth returns `thinSlugs` —
naming what falls short rather than asserting that nothing does. `allDeep` is
true only when the list is empty. Bodies are English (`en`); other locales fall
back and report `fellBack: true` via `curriculumItemLocalized` — a translation
is never invented.

### Certifications → XP (`academy.certs`)

| Procedure                  | Scope           | Purpose                                                                                       |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `certDefinitions`          | `academy:read`  | Code-seeded certs and the curriculum slugs each requires                                      |
| `enrollCertPath`           | `academy:write` | Enrol the caller on a path                                                                    |
| `markCurriculumComplete`   | `academy:write` | Mark one curriculum item complete (idempotent)                                                |
| `grantCert`                | `academy:write` | Grant the caller's cert when complete, **publish XP**, then **real identity perks or refuse** |
| `myCerts` / `certProgress` | `academy:read`  | What the caller has earned, and what is missing                                               |
| `certXpPlane`              | `academy:read`  | Is this process publishing awards, under which module/action, at what value                   |
| `certPerkPlane`            | `academy:read`  | Perks via identity rank only; invent perk money refuse-closed (D26-P1-C1)                     |
| `certPerkIntent`           | `admin:write`   | Attempt invent cert→perk money — always refuse, never amounts                                 |

`grantCert` is safe to call twice. The grant is idempotent on `(user, cert)` and the award carries the same business key, so a repeat is dropped by identity rather than paid twice — that is also how an award missed during a bus outage is recovered. XP amounts are a v0 policy in `src/certs/xp-policy.ts` with a conservative default; product may retune them, and a cert with no policy publishes **nothing** (no XP, no perk-grant shape) rather than an invented amount. After XP, `perks` is either a **real** `rank_thresholds.perks` readout from svc-identity or a **refuse** (unpriced / identity unreadable / invent path) — academy never invents perk money or a cert→perk map (`src/certs/perk-plane.ts`, D26-P1-C1).

### Item release (AC-release-access-02)

Curriculum slugs the lesson screen already opens (journey J-academy-03 step 3). No stored rule means the item stays open. Programme enrolment checks are unchanged.

| Procedure                                    | Scope          | Purpose                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itemRelease`                                | `academy:read` | This learner's state: locked, unlocked, started, completed. Also the window (`availableFrom`, `availableUntil`, `dueAt`, each null when unset) and this caller's latest extension (`extendedUntil`, `reason`, `grantedAt`, `grantedBy`)                                   |
| `curriculumItem` / `curriculumItemLocalized` | `academy:read` | The body, only when this learner is not locked. A lock refuses `academy.prerequisite_unmet` with `missing=<slugs>`, or `academy.window_invalid` for the window, before any body leaves                                                                                    |
| `admin.setItemPrerequisites`                 | `admin:write`  | Replace one item's prerequisites. A cycle refuses `academy.prerequisite_cycle`                                                                                                                                                                                            |
| `admin.setItemWindow`                        | `admin:write`  | Availability start and end, optional due. End before start refuses `academy.window_invalid`. All null clears the window                                                                                                                                                   |
| `admin.grantItemExtension`                   | `admin:write`  | Extend one learner past the binding end. A blank reason refuses `academy.reason_required`. Replay is the learner, the item, and `clientRequestId`. The same item, reason, and end returns the first grant. A different item, reason, or end is refused and writes nothing |

`itemRelease` never returns another learner's extension. With no window, the three dates are null so the card can say not set.

`markCurriculumComplete` refuses `academy.prerequisite_unmet` or `academy.window_invalid` while the item is locked. A completion already stored stays completed.

**Follow-ups, not in this change:** cohort and course-wide extensions, staff reset, and audit rows for `setItemPrerequisites` and `setItemWindow`.

### Completing an item (AC-progress-01)

Journey J-academy-03 steps 1, 2 and 10. The course outline beside an open item carries Complete and continue and Undo.

| Procedure                | Scope           | Purpose                                                                                                                                                                                                                                              |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markCurriculumComplete` | `academy:write` | Records the completion once; a repeat answers with the stored one. An item whose course rule is unmet refuses `academy.completion_rule_unmet` with `rule=<rule>`                                                                                     |
| `undoCurriculumComplete` | `academy:write` | Undoes the completion recorded at the given `completedAt`, so progress drops and items that need it (and are not complete) lock again. Replay key is the learner and `clientRequestId`; one reused for another item refuses `academy.request_reused` |
| `courseOutline`          | `academy:read`  | Each item also says its `rule` (`view`, `score`, `watch`), whether this learner has met it (`ruleMet`), and `completedAt` for the current completion                                                                                                 |
| `touchLesson`            | `academy:write` | The customer reader calls it each time an item opens, so Continue in My learning opens the same item on any device                                                                                                                                   |

A rule is `score` when a quiz is published for the item (a passing attempt meets it; a quiz with no pass mark refuses `academy.pass_mark_unset`), otherwise `view`, which opening the item meets. `watch` is in the contract for the video slice (AC-videos-01) and is not returned yet. `cert_item_completions` holds what is complete now; `item_completion_events` (migration 0015) keeps every Complete and Undo, so completing again after an Undo is a new event. A certificate already granted is not taken back by an Undo.

### Timed quizzes (AC-quizzes-03)

Journey J-academy-03 steps 6 and 7. Staff publish a quiz on an item; the learner takes it one question at a time against a clock the server keeps.

| Procedure            | Scope           | Purpose                                                                                                                                                                                      |
| -------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.setQuiz`      | `admin:write`   | Publishes (or, with `quiz: null`, takes down) a quiz on an item, with a reason. Questions carry the key; a slug in the code catalogue refuses                                                |
| `assessment.get`     | `academy:read`  | The quiz as the learner reads it: pass mark, `timeLimitSeconds`, `attemptLimit`, `reviewMode`, questions without the key                                                                     |
| `assessment.start`   | `academy:write` | Returns the open attempt, or opens one with a deadline of now plus the time limit. Refuses `academy.pass_mark_unset` with no pass mark and `academy.attempt_limit` once the limit is used up |
| `assessment.current` | `academy:read`  | The open attempt with the same deadline and the answers saved so far; `secondsLeft` is counted on the server at each read, so a refresh shows the same time left                             |
| `assessment.answer`  | `academy:write` | Saves one choice (the latest wins). An attempt past its deadline is finished first and refuses `academy.attempt_closed`                                                                      |
| `assessment.finish`  | `academy:write` | Scores the saved answers once; a second finish returns the same result                                                                                                                       |
| `assessment.review`  | `academy:read`  | A finished attempt of the caller's own: each answer against the key, or the score only (`questions: null`). Refuses `academy.attempt_not_found` and `academy.attempt_open`                   |

`quizzes` and `quiz_attempts` (migration 0016) hold the published quizzes and timed attempts; at most one attempt per learner and item is open. Each attempt keeps a copy of the quiz as it was at Start (key included, never sent), so a later staff edit or take-down changes neither its scoring nor its review, and an open attempt can still be finished. A finished attempt also writes one row to `assessment_attempts` (`client_attempt_id = quiz-attempt:<id>`), so the attempt history, the attempt limit, the cooldown and the `score` completion rule read one place. Start keeps the same attempt limit and cooldown as `assessment.submit`, under the same per-learner lock. A staff-published or timed quiz refuses `assessment.submit` with `academy.attempt_required`, and any quiz refuses it while an attempt is open (`academy.attempt_open`), so the clock cannot be skipped. An attempt left open past its deadline is finished at the deadline by the next read or write; its score was fixed by what was saved by then, so a read only records it. A pass mark above the questions' points is refused. Quizzes in the code catalogue (`ASSESSMENT_CATALOG`) still take precedence.

### Progress, grades and the planner (AC-progress-02)

Journey J-academy-03 steps 8 and 9. `/academy/progress` in the customer app shows course progress, grades and the planner above the access and grant records.

| Procedure                  | Scope           | Purpose                                                                                                                                                                                                                                                                      |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `myProgress`               | `academy:read`  | Per enrolled course: `percent` complete (decimal string, one place) over every item the learner can see, with each item's `completedAt`. Grades: per quiz the best attempt as decimal strings, or `pending` with `hiddenUntil`; averages per type over released results only |
| `planner.get`              | `academy:read`  | The caller's to-do items, `todoLimit`, `revision` (every add counted), the weekly goal with `doneThisWeek`, and `reminderMail: 'vendor.email'`                                                                                                                               |
| `planner.addTodo`          | `academy:write` | Adds one item named by `clientKey` (the client sends `todo:<revision>`); a replay returns the stored item, the same key for other text refuses `academy.request_reused`. Refuses `academy.planner_limit_unset` and `academy.planner_full`                                    |
| `planner.setTodoDone`      | `academy:write` | Marks one of the caller's items done or not done; refuses `academy.todo_not_found` for anyone else's                                                                                                                                                                         |
| `planner.removeTodo`       | `academy:write` | Removes one of the caller's items; the row stays (`removed_at`), so a late replay of its add does not bring it back                                                                                                                                                          |
| `planner.setGoal`          | `academy:write` | Saves the weekly goal (1 to 100 items, `academy.goal_invalid` otherwise) and the reminder choice                                                                                                                                                                             |
| `planner.sendGoalReminder` | `academy:write` | Answers `{ sent: false, mail: 'vendor.email' }`: Academy has no mail sender, so nothing is sent or queued. Refuses `academy.goal_invalid` without a goal whose reminder is on                                                                                                |

`admin.setQuiz` takes `resultsHiddenUntil`: until then the quiz's results are pending everywhere the learner reads them (finish answers `result.hidden`, `assessment.attempts` gives no score, `assessment.review` refuses `academy.grades_hidden`, and a hidden pass does not meet the item's `score` rule). Each score row keeps the date it was finished under (`assessment_attempts.hidden_until`), and a result shows after the later of that and the quiz's current date, so a re-publish without the date or a take-down never releases it early. The grades row is a quiz's best attempt: a passing one first, then the highest share of points. `ACADEMY_PLANNER_TODO_LIMIT` is the owner's per-learner cap; unset, adding refuses. The local stack sets a TEST value. Migration 0017 adds `quizzes.results_hidden_until`, `planner_todos` and `learning_goals`.

### Video player tracks (AC-videos-01)

Journey J-academy-03 step 4. The Videos screen already calls `videos` and `videoPlayback`. Those still play the file when captions, the transcript, or the watch threshold are blank.

| Procedure               | Scope          | Purpose                                                                                                                                                                                                                           |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `videos`                | `academy:read` | Named spine. `captionsPublished` and `transcriptPublished` are false until the owner sets them. `captionsUrl` stays null. No duration or transcript is guessed.                                                                   |
| `videoCaptions`         | `academy:read` | Signed captions URL behind the same tier and stake gate as playback. No URL refuses `academy.video_captions_unpublished`.                                                                                                         |
| `videoTranscript`       | `academy:read` | Transcript text behind that same gate, with a signed URL. No text refuses `academy.video_transcript_unpublished`.                                                                                                                 |
| `videoProgress.watched` | `academy:read` | This caller's stored position against `ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS`. Blank, zero, or a fraction refuses `academy.watch_threshold_unset`. No stored row is not watched. The threshold is not cut down to fit a duration. |

`videoProgress.get` and `videoProgress.set` are unchanged. Play, pause, seek, and volume are the player itself. This service does not publish a speed list.

### Videos on items, caption tracks and the watch rule (AC-videos-01)

Journey J-academy-03 steps 4 and 5. Staff attach a spine video to a curriculum item. The reader then shows the player: our own controls, a speed menu, a quality menu that lists only the original file (there is no transcode path), captions by language, a transcript that follows playback, full screen, and keyboard keys. Opening the item resumes at the stored position.

| Procedure              | Scope           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itemVideo`            | `academy:read`  | The video attached to one item, or `videoSlug: null`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `videoPlayer`          | `academy:read`  | Behind the playback gate: the renditions that exist (`original`), the caption tracks as cues (an empty list means no captions), `saveEverySeconds` and `watchThresholdSeconds` as the owner set them (null when unset)                                                                                                                                                                                                                                   |
| `videoProgress.set`    | `academy:write` | Also answers `completedItems`: the attached `watch` items that are complete while the stored position is at or past the threshold (the same answer on a replay). A save that crosses the threshold completes each one that is open to the caller, not complete, and whose video the playback gate lets the caller watch. A locked item keeps the position, and Complete finishes it once it opens. After an Undo, watching on does not complete it again |
| `admin.setItemVideo`   | `admin:write`   | Attach a spine video to an item (it then completes by `watch`), or take it off with `videoSlug: null`. Reason required                                                                                                                                                                                                                                                                                                                                   |
| `admin.setVideoTracks` | `admin:write`   | Replace every caption track of one video: WebVTT text per language, checked first (`academy.captions_invalid` for a bad file or a repeated language); `[]` removes them. Reason required                                                                                                                                                                                                                                                                 |

An item with a published quiz completes by `score`; otherwise an item with a video completes by `watch`. Pressing Complete on a `watch` item refuses `academy.completion_rule_unmet` until it is watched, `academy.watch_threshold_unset` while the threshold is blank, and the playback gate's own refusal when the caller may not watch the video. Caption files may carry header lines (`Kind:`, `Language:`); the transcript shows cue words without WebVTT tags. `ACADEMY_VIDEO_POSITION_SAVE_SECONDS` is the owner's save interval while playing; unset, the player saves on pause and on leaving only, and says so. A published minimum stake of zero needs no stake read, so playback does not wait on the stake source then. Migration 0018 adds `item_videos` and `video_tracks`.

The local stack runs a TEST video store (`tooling/scripts/local-video-store.mjs`). It serves one generated 12-second TEST video under the spine's object key, and only for a valid, unexpired signed URL. It also sets TEST owner values: a 300-second link, tier `none`, stake `0`, a 4-second threshold and a 2-second save interval. `LOCAL_STACK_ACADEMY_VIDEO_STORAGE=off` on a start or restart leaves storage blank instead.

A seat belongs to `ctx.principal.userId`. **No procedure takes a userId from the input except `invite` and `admin.grantItemExtension`**, where naming somebody else _is_ the operation — invite is host-only, and the extension is `admin:write`. The scene is written **whole** by the host, not merged per attendee: merging would need a conflict model this does not have, and half a merge is a room that renders differently for different people.

---

## Events

**Publishes:** `intafaced.identity.xp.earned`, on certification grant and nowhere else. **Consumes:** none.

This section used to read "**No NATS connection at all**", and the reason it gave was that the §8.3 event this service would eventually emit is exactly that one — "and certification ships with the curriculum. Connecting to the bus to publish nothing would add a boot dependency that can fail, in exchange for no capability." Certification has now shipped, so the capability is real and the connection buys it.

The boot-dependency objection is answered rather than dropped. The connect is attempted and a failure **degrades**: lobbies, seats, scenes, curriculum and paper drills never needed the bus, so svc-academy stays in the fleet and says what it lost — `/ready` reports `xp.usable: false` and `grantCert` returns `xp: { emitted: false, reason: 'publisher_unavailable' }`. Nothing is silently dropped, because the award is keyed on the grant (`academy.cert:cert:<userId>:<certId>`): granting again re-publishes it, and identity's `xp_events ON CONFLICT (idempotency_key) DO NOTHING` makes the repeat a no-op. That is the whole recovery story — no outbox, no sweep.

svc-identity remains the only writer to `rank_state` and the only place a perk is decided (§4.1). Academy awards XP; it does not rank anybody.

**Reads over HTTP** (both authenticated with the shared internal service secret):

- svc-token `/internal/stake/:userId` — staked lobbies only
- svc-identity `/internal/rank/:userId/perks` — `createRoom` only

---

## Ledger

**None.** This service uses no ledger recipes and moves no value — see the custodial note at the top. There is no paid entry path in this PR: the `staked` tier is a **threshold test against a stake svc-token already holds**, not a payment, so nothing is ever debited, held or escrowed here, and there is no in-flight state a crash could strand.

That is the answer to the question this codebase asks everywhere — _if the process dies exactly here, whose money is stranded and how does it come back?_ — and the answer is nobody's, because no money entered. If entry ever becomes **paid** rather than stake-gated, that answer changes, and it arrives as ledger recipes plus a `LEDGER_URL` in its own reviewable change.

---

## Testing

| Suite                            | Covers                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/access/room-access.test.ts` | The seating rule: every access tier, the ordering of refusals, host bypass, invite expiry                                                                                                                                                       |
| `src/host-rights.test.ts`        | The §4.1 hosting perk, and that every unreadable answer refuses                                                                                                                                                                                 |
| `src/stream/provider.test.ts`    | That no fabricated join credential can leave the module                                                                                                                                                                                         |
| `src/curriculum/catalog.test.ts` | Spine non-empty, path/kind filters, unknown slug null — **plus** library integrity: unique slugs, unique order per path, every body over the depth floor, scaffolding on every item, no orphan content, every item passing the import validator |
| `src/router.mount.test.ts`       | The mount boundary, scope enforcement, curriculum surface, real rather than 404                                                                                                                                                                 |

All five are pure and need **no database** — none opens a connection, and none points at the shared `intafaced` instance.

The service's SQL paths are exercised through the fleet's e2e suite rather than a per-service Postgres harness: this service holds no value, and its failure mode is an empty room rather than a lost balance, so the harness cost is better spent on services that move money. The one SQL path that would repay a harness is the capacity race under `FOR UPDATE`, and that is the honest gap in this suite.

## Ambassador programme (Stage-1 status + D26-P1-C2 rate authority)

Appoint / freeze / public badge. Residencies apply/decide are non-money. **IFC / revenue-share rates are owner-only.**

| Capability                        | Gate                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| Open lobby / invite / run session | `lobbyHostRights` (svc-identity)                                   |
| Programme badge active            | `ambassadors.status = active`                                      |
| Appoint / freeze                  | operator `admin:write`                                             |
| IFC / share **rate authority**    | `ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON` / `…_REVENUE_SHARE_LAW_JSON` |
| IFC / share **dry-run quote**     | published law (+ accepted residency for `residencyIfcPayQuote`)    |
| IFC / share **live settlement**   | **Refuse** until Class M ledger recipe (separate PR)               |

Blank law JSON → unpublished → refuse invent. Published law opens quote path only; amounts come from the owner JSON, never from code defaults.

Migration: `drizzle/0001_ambassadors.sql`.

## Tournament ladders (Stage-1 — no prize money)

Seasons + ranked standings. **No prize pools.** Kill-switch: `ACADEMY_TOURNAMENT_ENABLED` (flag `academy.tournament`).

| Capability                             | Gate                            |
| -------------------------------------- | ------------------------------- |
| List seasons / standings               | `academy:read` when enabled     |
| Create season / set status / set score | `admin:write`                   |
| Prize fund / payout                    | **Not built** (Class M Stage-2) |

Anti-cheat basics: scores only while season `live`; rank = score DESC, earlier `updated_at` wins ties; frozen/ended refuse score writes.

Migration: `drizzle/0002_tournaments.sql`.

## Paper trading (no live money)

Workbook paper drills consume trade's `paper` market flag. **No prices invented here.** Ops kill-switch: `ACADEMY_PAPER_TRADING_ENABLED` (flag `academy.paper-trading`) — when false, `paperDrill` and `paperDrillResult` refuse `academy.paper_trading_disabled`. Live trade on svc-trade is unaffected.

`paperDrill` answers "may this workbook be drilled on this market". `paperDrillResult` answers "what did it come to" — it replays the caller's completed steps and trade's fills and returns the reading of them. It is **stateless**: academy stores no run and no position, so the caller holds the events and this service holds the rules.

| Capability                            | Gate                                          |
| ------------------------------------- | --------------------------------------------- |
| `paperDrill` / `paperOpsStatus`       | `academy:read` when enabled                   |
| `paperDrillResult`                    | `academy:read` when enabled                   |
| Kill paper without killing live       | `ACADEMY_PAPER_TRADING_ENABLED=false`         |
| Real ledger holds / live `placeOrder` | **Never** — trade Stage-1 isolation           |
| A result that is not labelled         | **Never** — `academy.paper_result_unlabelled` |

### Two rules that are enforced, not documented

**Everything a drill produces is sealed.** `sealSimulated` is the only constructor for a paper payload, and every wire schema requires the seal as literals — `simulated: true`, `venue: 'paper'`, `realLedger: false`, `withdrawable: false`, `realMoney: false`, plus the disclaimer in full. The run itself carries `simulated: true`, so every projection (board card, both status lines, the CSV export) reads the label from one place rather than remembering to add it. A status line with the label stripped no longer parses; it does not degrade into something readable as live.

**D26-P1-C4 harden — paper never readable as real money.** After the seal, `assertPaperNeverReadableAsRealMoney` deep-scans the outbound payload and refuses (`academy.paper_looks_like_real_money`) any custody-looking key (`availableBalance`, `ledgerTxId`, `holdAmount`, …), any seal bit flipped to true (`realMoney` / `live` / `isLive`), or a non-paper `venue`. Public doors: `paperDrill` / `paperDrillResult` also `.strict()`-refuse inbound `realMoney`/`live` claims (they must not strip-and-proceed). `paperOpsStatus` reports `realMoney: false`, `simulated: true`, `venue: 'paper'` and refuses if the service presents paper as live. Progress / identity / step-bar projections also carry `realMoney: false`; status and export lines require `realMoney=0` to parse.

**Nothing is priced here.** Prices, sizes and the mark are the ones **trade published**, handed in as decimal strings — a JSON number is a 400, not a coercion. A fill with no published price is `academy.paper_price_unavailable`; an open position with no published mark comes back `unrealisedPnl: null, markUnavailable: true`. Neither is filled in with a plausible number.

`paper/ledger-isolation.test.ts` reads every module under `src/paper/` and fails the build on any import of the ledger's write surface (client, recipes, `orderHold`, `tradeFill`, `.post(`). The decimal **math** from `@intafaced/ledger-client` is allowed and required — a simulated figure uses the one money implementation, or it is a float pretending.

**D26-P1-C4 — paper flag is not taken on trust.** `paperDrill` / `paperDrillResult` call `assertCallerPaperFlagVerified` before the workbook loop. Trade's public `GET /api/v1/markets` `paper` field is the source of truth (env `TRADE_URL`). A caller that sends `paper: true` for a live listing is refused `academy.paper_flag_mismatch`. If `TRADE_URL` is unset, the drill refuses `academy.paper_flag_unverified` rather than trusting the wire. Listing unreachable → `academy.paper_flag_unavailable`. Missing/false paper on the body still refuses `not_paper` / `no_market` (never a silent live drill). Simulated results stay sealed; this service still posts nothing to the ledger.

## Curriculum import pipeline (Stage-1)

- Content source on tip: **platform-native-expansion** (licensed import pending product/Class X).
- `curriculumInventory` reports spine counts vs title 20 playbooks + 3 workbooks. `titlePromiseMet` is **true** on tip — met by platform-native content, **not** by a licensed library dump. Read it with `curriculumDepth`: the counts were met before any of the items were worth reading.
- Import records validated by `validateImportRecord` / brand checklist (no outbound URLs, no empty stubs). The catalog holds itself to that same bar — `catalog.test.ts` runs every spine item through the validator.
- Do **not** invent proprietary library titles as if the import landed.

## Service-to-service calls to `GET /internal/curriculum`

Only svc-agents may call this door. It accepts the shared service secret and, when `S2S_AUTH_MODE` is `dual` or `keypair`, a call signed with svc-agents' own key (`S2S_KEYRING` holds the public keys). `keypair` refuses the shared secret. Any other authenticated service is refused. Unset `S2S_AUTH_MODE` leaves the door on the shared secret alone. No key is committed; real keys are supplied by the deploy environment.
