/**
 * svc-academy's own failure vocabulary.
 *
 * Codes are stable strings because they are what an SLO dashboard groups by and
 * what a client branches on. `academy.room_full` and `academy.stake_required`
 * are both "you cannot take this seat", and collapsing them would leave the
 * user unable to tell whether to wait or to stake.
 *
 * The two `_unavailable` codes are deliberately NOT refusals. They say "we
 * could not find out", which is a different sentence to "no" and belongs to an
 * operator rather than to the caller — see stake-source.ts and host-rights.ts
 * for why both still fail closed at the point of decision.
 */
export type AcademyErrorCode =
  | 'academy.room_not_found'
  | 'academy.session_not_found'
  | 'academy.session_not_live'
  | 'academy.not_host'
  | 'academy.room_full'
  | 'academy.stake_required'
  | 'academy.invite_required'
  | 'academy.stake_unavailable'
  | 'academy.stream_unavailable'
  /** §4.1 `rank_thresholds.perks.lobbyHostRights` — this rank does not host. */
  | 'academy.host_rights_required'
  | 'academy.host_rights_unavailable'
  /** Curriculum catalog slug is not in the day-one spine. */
  | 'academy.curriculum_not_found'
  /** Spatial scene failed Stage-1 schema / size gate. */
  | 'academy.scene_invalid'
  /** Concurrent host write — stale fingerprint. */
  | 'academy.scene_conflict'
  /** Duplicate avatar / participant / prop id in scene write. */
  | 'academy.scene_presence_collision'
  /** Ambassador programme Stage-1. */
  | 'academy.ambassador_not_found'
  | 'academy.ambassador_already_active'
  | 'academy.ambassador_already_frozen'
  | 'academy.ambassador_invalid'
  /** Tournament ladder Stage-1. */
  | 'academy.tournament_disabled'
  | 'academy.season_not_found'
  | 'academy.season_not_live'
  | 'academy.season_invalid'
  | 'academy.standing_invalid'
  /** Standings page limit unset — never invent 50 rows. */
  | 'academy.standings_limit_unset'
  /** In-memory list helpers — never invent all.length. */
  | 'academy.programme_list_limit_unset'
  | 'academy.residency_list_limit_unset'
  | 'academy.curriculum_list_limit_unset'
  | 'academy.paper_list_limit_unset'
  /** Trade public markets listing page size for paper-flag verify — never invent 50. */
  | 'academy.paper_markets_limit_unset'
  | 'academy.season_list_limit_unset'
  /** SQL ambassadors list — never dump the whole table. */
  | 'academy.ambassadors_list_limit_unset'
  /** SQL leftover lists after ambassadors — never dump the whole table. */
  | 'academy.rooms_list_limit_unset'
  | 'academy.sessions_list_limit_unset'
  | 'academy.seasons_list_limit_unset'
  | 'academy.open_residencies_list_limit_unset'
  /** SQL myResidencies — never dump every application for a user. */
  | 'academy.my_residencies_list_limit_unset'
  /** SQL myCerts — never dump every cert_grants row for a user. */
  | 'academy.my_certs_list_limit_unset'
  /** Paper trading Stage-3 ops kill-switch. */
  | 'academy.paper_trading_disabled'
  /**
   * A paper drill could not be valued because trade published no price for it.
   * An `_unavailable` on purpose: "we could not find out" is the honest answer,
   * and the dishonest one — picking a plausible number — is a fabricated price
   * told on this service's behalf. Refusing is the whole point.
   */
  | 'academy.paper_price_unavailable'
  /**
   * A simulated result reached the wire without its seal. This is OUR bug, not
   * the caller's: an unlabelled paper figure is indistinguishable from a real
   * one, which is the single failure this row exists to prevent.
   */
  | 'academy.paper_result_unlabelled'
  /**
   * A paper success payload claimed real custody (banned key) or flipped a
   * seal bit to true. D26-P1-C4: paper flag must never be readable as real money.
   */
  | 'academy.paper_looks_like_real_money'
  /**
   * TRADE_URL unset — academy cannot ask trade whether the market is paper.
   * Trusting `paper: true` on the wire would be a live drill with a paper label.
   */
  | 'academy.paper_flag_unverified'
  /** Caller claimed paper; trade's public listing says otherwise (or identity mismatch). */
  | 'academy.paper_flag_mismatch'
  /** Claimed market id/symbol is not on trade's public listing. */
  | 'academy.paper_market_unlisted'
  /** TRADE_URL is set but the markets listing could not be read. Fail closed. */
  | 'academy.paper_flag_unavailable'
  /** Residency applications Stage-1 (no pay). */
  | 'academy.residency_invalid'
  | 'academy.residency_not_found'
  | 'academy.residency_already_open'
  | 'academy.residency_not_pending'
  /** Certifications Stage-1 (no XP / no pay). */
  | 'academy.cert_not_found'
  | 'academy.cert_incomplete'
  | 'academy.cert_invalid'
  | 'academy.cert_already_granted'
  /** Stored VOD — MinIO/S3 unset. Not LiveKit. */
  | 'academy.video_storage_unconfigured'
  /** Playback URL missing signature, expired, or failed tier/stake gate. */
  | 'academy.video_grant_required'
  /** Signed-GET TTL unset — never invent seconds. */
  | 'academy.video_url_ttl_unset'
  /** S3 signing region unset — never invent us-east-1. */
  | 'academy.video_s3_region_unset'
  /** Lobby ceiling unset — never invent a seat count. */
  | 'academy.room_capacity_unset'
  /** Programme prerequisites the caller has not enrolled in, or an item prerequisite is unmet. */
  | 'academy.prerequisite_unmet'
  /** Item prerequisite graph contains a cycle. */
  | 'academy.prerequisite_cycle'
  /** Availability or due window is unpublished, inverted, or closed for this learner. */
  | 'academy.window_invalid'
  /** Per-learner extension was asked for without a reason. */
  | 'academy.reason_required'
  /** touchLesson secondsRead outside 0..TOUCH_LESSON_MAX_SECONDS. */
  | 'academy.seconds_out_of_range'
  /** Video slug is not on the named spine. */
  | 'academy.video_not_found'
  /** Watch position is negative, not an integer, or past a set duration. */
  | 'academy.video_position_out_of_range'
  /** Captions track was asked for and the owner has not published a URL. */
  | 'academy.video_captions_unpublished'
  /** Transcript was asked for and the owner has not published text. */
  | 'academy.video_transcript_unpublished'
  /** Seconds of stored position that count as watched. Blank is not zero. */
  | 'academy.watch_threshold_unset'
  /** Leave found no enrolment for this caller. */
  | 'academy.enrollment_not_found'
  /** Operator completionsByItem path is not a curriculum path. */
  | 'academy.path_not_found'
  /** opsMetrics from/to is not a UTC day range inside OPS_METRICS_MAX_DAYS. */
  | 'academy.metrics_range_invalid'
  | 'academy.my_completions_list_limit_unset'
  | 'academy.residency_cohorts_list_limit_unset'
  | 'academy.my_upcoming_sessions_list_limit_unset'
  | 'academy.grant_audit_list_limit_unset'
  /** Lesson has no owner-published assessment. */
  | 'academy.assessment_unpublished'
  /** Assessment questions exist and the pass mark does not. */
  | 'academy.pass_mark_unset'
  | 'academy.assessment_invalid'
  /** Owner-published attempt cap reached. */
  | 'academy.attempt_limit'
  /** Owner-published cooldown has not elapsed. */
  | 'academy.attempt_cooldown'
  /** Path has no owner-published certificate definition. */
  | 'academy.certificate_unpublished'
  /** certVerify rate max or window is blank. */
  | 'academy.verify_rate_unset'
  /** certVerify caller address is missing. Fail closed. */
  | 'academy.verify_address_unset'
  /** certVerify over the published per-address limit. */
  | 'academy.verify_rate_limited'
  /** The item has a prerequisite, so whether it is open depends on the reader's own record: sign in. */
  | 'academy.sign_in_required'
  | 'academy.holder_name_invalid'
  /** AC-articles-02: a slug equal to a reserved academy tab. */
  | 'academy.slug_reserved'
  /** AC-catalogue-03: no published course by that slug. A draft gets the same answer as a missing one. */
  | 'academy.course_not_found'
  /** AC-enrolment-01: the course or the chosen track is closed for enrolment; the message carries `reason=<reason>`. */
  | 'academy.enrolment_closed'
  /** The item's course rule (pass its quiz, watch its video) is not met, so it cannot be marked complete. */
  | 'academy.completion_rule_unmet'
  /** A request id already answered a different request (another item, another action). */
  | 'academy.request_reused'
  /** AC-quizzes-03: no attempt of the caller's with this id. */
  | 'academy.attempt_not_found'
  /** The attempt is finished or past its deadline, so it takes no more answers. */
  | 'academy.attempt_closed'
  /** The attempt is still open, so there is nothing to review. */
  | 'academy.attempt_open'
  /** A timed or staff-published quiz is taken with Start, not sent in one go. */
  | 'academy.attempt_required'
  /** AC-progress-02: the result is hidden until its date; the response says so rather than a number. */
  | 'academy.grades_hidden'
  /** The owner has not set how many to-do items a learner may keep. */
  | 'academy.planner_limit_unset'
  /** The learner already keeps as many to-do items as the owner allows. */
  | 'academy.planner_full'
  /** No to-do item of the caller's with this id. */
  | 'academy.todo_not_found'
  /** The goal is out of bounds, or there is no goal with its reminder on to send. */
  | 'academy.goal_invalid'
  /** A caption file is not WebVTT, or two tracks of one video share a language. */
  | 'academy.captions_invalid'
  /** AC-course-structure-01: the slug is already a course's, a shipped course's or a lesson's address. */
  | 'academy.course_slug_taken'
  /** The course moved on since the editor read it. */
  | 'academy.course_revision_stale'
  /** Only a draft's details are edited on the desk. */
  | 'academy.course_not_editable'
  /** The lifecycle has no such move from the course's state. */
  | 'academy.item_transition_illegal'
  /** A paid course has no price, so it is not published. */
  | 'academy.price_unset'
  /** The course's outline is empty, so it is not published. */
  | 'academy.course_outline_empty'
  | 'academy.courses_list_limit_unset'
  /** AC-course-structure-02: the owner has not set the outline section and item limits. */
  | 'academy.outline_limits_unset'
  /** The outline has more sections or items than the owner allows. */
  | 'academy.outline_too_large'
  /** The outline names a section or item id this course does not hold. */
  | 'academy.outline_item_unknown'
  /** AC-course-structure-03: the lesson has a newer revision than the one the editor read. */
  | 'academy.revision_stale'
  /** No such revision of this lesson. */
  | 'academy.lesson_revision_unknown'
  /** A subheader or a link holds no lesson. */
  | 'academy.item_has_no_lesson'
  /** An item with a lesson does not become a subheader or a link. */
  | 'academy.item_kind_locked'
  /** The owner has not set the lesson import size limit. */
  | 'academy.import_limit_unset'
  /** The lesson file is over the owner's size limit; it was not parsed. */
  | 'academy.import_too_large'
  /** AC-course-structure-04: no such assistant draft, or it was already decided the other way. */
  | 'academy.draft_not_found'
  /** Lesson blocks built by the service do not fit the lesson format (a block over its limit); nothing was written. */
  | 'academy.lesson_blocks_invalid'
  /** AC-assignments-01: only a learner enrolled in the course hands in its work. */
  | 'academy.enrolment_required'
  /** The hand-in lacks a text answer or a file the assignment requires; nothing was recorded. */
  | 'academy.submission_incomplete'
  /** No assignment with a saved brief at that item in a published course. */
  | 'academy.assignment_not_found'
  /** Staff withdrew the assignment, so nothing more is handed in. */
  | 'academy.assignment_closed'
  /** The hand-in was made against an older read; read the assignment again. */
  | 'academy.submission_version_stale'
  /** An assignment learners handed in to cannot leave the outline; withdraw it instead. */
  | 'academy.assignment_has_submissions'
  /** AC-assignments-03: peer review is on with no count of reviews each learner gives. */
  | 'academy.peer_count_unset'
  /** A rubric with no criteria, or two criteria of one name. */
  | 'academy.rubric_invalid'
  /** A review that does not give one of its levels for every criterion. */
  | 'academy.review_marks_invalid'
  /** No review of the caller's with that id on that assignment. */
  | 'academy.review_task_not_found'
  /** The review was already sent with other marks; it is not changed. */
  | 'academy.review_already_sent'
  /** A reviewed file could not be read back whole from our own store; nothing changed. */
  | 'academy.file_unavailable'
  /** AC-assignments-02: another grader holds this hand-in's lease. */
  | 'academy.grader_locked'
  /** The owner has not set how long a grader holds a hand-in (`ACADEMY_GRADER_LEASE_SECONDS`). */
  | 'academy.grader_lease_unset'
  /** A score that is above the assignment's points. */
  | 'academy.grade_invalid'
  /** AC-assignments-02: a bulk grade file whose header is not `learner,score,comment,reason`, or with no rows. */
  | 'academy.bulk_file_invalid'
  /** AC-certificates-02: a delayed issue rule with no delay. */
  | 'academy.cert_delay_unset'
  /** AC-certificates-02: a delayed issue rule while no issue sweep runs (`ACADEMY_CERT_ISSUE_SWEEP_SECONDS` blank). */
  | 'academy.cert_sweep_unset'
  /** AC-certificates-02: the certificate is issued when its delay ends; the message carries `issuesAt=<time>`. */
  | 'academy.cert_not_due'
  | 'academy.cert_revoked'
  /** No newest hand-in with that id on the assignment, or no grade on it to read. */
  | 'academy.submission_not_found'
  /** AC-videos-02: the owner has not set the upload size limit or the accepted video or handout types. */
  | 'academy.upload_limits_unset'
  /** The file is over the owner's upload size limit; no upload address was issued. */
  | 'academy.upload_too_large'
  /** The file's declared type is not one the owner accepts for that kind. */
  | 'academy.upload_type_refused'
  /** The stored file's leading bytes are not the declared type; the upload is refused. */
  | 'academy.file_type_mismatch'
  /** No upload with that id. */
  | 'academy.media_not_found'
  /** The stored object is missing or its size is not the declared size. */
  | 'academy.upload_incomplete'
  /** Captions need a stored video on the item first. */
  | 'academy.item_video_missing'
  /** AC-articles-01: only a lesson learners can read is featured. */
  | 'academy.featured_not_live'
  /** Withdrawing a lesson learners see no revision of. */
  | 'academy.lesson_not_live'
  /** No topic with that id. */
  | 'academy.topic_not_found'
  /** A topic already has that address under another name. */
  | 'academy.topic_slug_taken'
  /** The owner has not set how many topics a list shows. */
  | 'academy.topics_list_limit_unset'
  /** AC-catalogue-03: no private link with that id. */
  | 'academy.private_link_not_found'
  /** AC-catalogue-03: an archived or deleted course takes no new private link. */
  | 'academy.private_link_course_closed'
  /** AC-programmes-01: the owner has not set how many courses a programme may hold. */
  | 'academy.programme_limit_unset'
  /** AC-programmes-01: more courses than the owner's limit. */
  | 'academy.programme_too_large'
  /** AC-programmes-01: no programme at that address. */
  | 'academy.programme_not_found'
  /** AC-programmes-01: a new programme at an address another programme has. */
  | 'academy.programme_slug_taken'
  /** AC-rooms-01: the owner has not set how long a discussion post may be. */
  | 'academy.post_limit_unset'
  /** AC-rooms-01: a post or reply longer than the owner's limit. */
  | 'academy.post_too_long'
  /** AC-rooms-01: the owner has not set how large a post's image may be. */
  | 'academy.attachment_limit_unset'
  /** AC-rooms-01: a post's image over the owner's size limit. */
  | 'academy.attachment_too_large'
  /** AC-rooms-01: a file attached to a post that is not one of the image types, by its declared type or its content. */
  | 'academy.attachment_type_refused'
  /** AC-rooms-01: no discussion post or reply with that id the reader may open. */
  | 'academy.post_not_found'
  /** AC-rooms-01: the action belongs to someone else (only the asker marks the accepted answer). */
  | 'academy.permission_denied'
  /** AC-rooms-04: the owner has not set how long a message to the course team may be. */
  | 'academy.message_limit_unset'
  /** AC-rooms-04: a message longer than the owner's limit. */
  | 'academy.message_too_long'
  /** AC-rooms-04: no conversation with that id the reader is in. */
  | 'academy.conversation_not_found'
  /** AC-quizzes-01: the outline item is not a quiz. */
  | 'academy.quiz_not_found'
  /** AC-quizzes-01: a quiz with no questions is not published. */
  | 'academy.quiz_no_questions'
  /** AC-quizzes-01: more than one attempt is allowed and no scoring policy says which counts. */
  | 'academy.scoring_policy_unset'
  /** AC-quizzes-01: learners have attempts, so the questions stay and the quiz stays published (and in the outline). */
  | 'academy.item_has_attempts'
  /** AC-quizzes-01: the quiz needs an access code and the one given is missing or wrong. */
  | 'academy.access_code_invalid'
  /** AC-quizzes-01: the quiz has an IP filter and the caller's address could not be read. */
  | 'academy.ip_unreadable'
  /** AC-quizzes-01: the caller's address is outside the quiz's IP filter. */
  | 'academy.ip_not_allowed'
  /** AC-quizzes-01: an IP filter entry that is not an address or a CIDR range. */
  | 'academy.ip_rule_invalid'
  /** AC-quizzes-02: this survey already has the caller's answers (or this device's, when anonymous). */
  | 'academy.survey_duplicate'
  /** AC-release-access-01: learners have enrolled, so the course's pacing stays as it is. */
  | 'academy.pacing_locked'
  /** AC-release-access-01: the item's section has not opened for this learner yet. */
  | 'academy.not_released_yet'
  /** AC-release-access-02: a lesson, video, file or link records no completion on a course staff made, so it cannot be required. */
  | 'academy.prerequisite_unmeasured'
  /** AC-assignments-04: the gradebook weights do not add up to exactly 1. */
  | 'academy.weights_invalid'
  /** AC-assignments-04: a type names an item that is not one of the course's assignments or quizzes, twice, or drops them all. */
  | 'academy.grading_policy_invalid';

export class AcademyError extends Error {
  constructor(
    message: string,
    readonly code: AcademyErrorCode,
  ) {
    super(message);
    this.name = 'AcademyError';
  }
}

/** L3 — full academy error code catalog (stable for operator boards). */
export const ACADEMY_ERROR_CODES: readonly AcademyErrorCode[] = [
  'academy.room_not_found',
  'academy.session_not_found',
  'academy.session_not_live',
  'academy.not_host',
  'academy.room_full',
  'academy.stake_required',
  'academy.invite_required',
  'academy.stake_unavailable',
  'academy.stream_unavailable',
  'academy.host_rights_required',
  'academy.host_rights_unavailable',
  'academy.curriculum_not_found',
  'academy.scene_invalid',
  'academy.scene_conflict',
  'academy.scene_presence_collision',
  'academy.ambassador_not_found',
  'academy.ambassador_already_active',
  'academy.ambassador_already_frozen',
  'academy.ambassador_invalid',
  'academy.tournament_disabled',
  'academy.season_not_found',
  'academy.season_not_live',
  'academy.season_invalid',
  'academy.standing_invalid',
  'academy.standings_limit_unset',
  'academy.programme_list_limit_unset',
  'academy.residency_list_limit_unset',
  'academy.curriculum_list_limit_unset',
  'academy.paper_list_limit_unset',
  'academy.paper_markets_limit_unset',
  'academy.season_list_limit_unset',
  'academy.ambassadors_list_limit_unset',
  'academy.rooms_list_limit_unset',
  'academy.sessions_list_limit_unset',
  'academy.seasons_list_limit_unset',
  'academy.open_residencies_list_limit_unset',
  'academy.my_residencies_list_limit_unset',
  'academy.my_certs_list_limit_unset',
  'academy.paper_trading_disabled',
  'academy.paper_price_unavailable',
  'academy.paper_result_unlabelled',
  'academy.paper_looks_like_real_money',
  'academy.paper_flag_unverified',
  'academy.paper_flag_mismatch',
  'academy.paper_market_unlisted',
  'academy.paper_flag_unavailable',
  'academy.residency_invalid',
  'academy.residency_not_found',
  'academy.residency_already_open',
  'academy.residency_not_pending',
  'academy.cert_not_found',
  'academy.cert_incomplete',
  'academy.cert_invalid',
  'academy.cert_already_granted',
  'academy.video_storage_unconfigured',
  'academy.video_grant_required',
  'academy.video_url_ttl_unset',
  'academy.video_s3_region_unset',
  'academy.room_capacity_unset',
  'academy.prerequisite_unmet',
  'academy.prerequisite_cycle',
  'academy.window_invalid',
  'academy.reason_required',
  'academy.seconds_out_of_range',
  'academy.video_not_found',
  'academy.video_position_out_of_range',
  'academy.video_captions_unpublished',
  'academy.video_transcript_unpublished',
  'academy.watch_threshold_unset',
  'academy.enrollment_not_found',
  'academy.path_not_found',
  'academy.metrics_range_invalid',
  'academy.my_completions_list_limit_unset',
  'academy.residency_cohorts_list_limit_unset',
  'academy.my_upcoming_sessions_list_limit_unset',
  'academy.grant_audit_list_limit_unset',
  'academy.assessment_unpublished',
  'academy.pass_mark_unset',
  'academy.assessment_invalid',
  'academy.attempt_limit',
  'academy.attempt_cooldown',
  'academy.certificate_unpublished',
  'academy.verify_rate_unset',
  'academy.verify_address_unset',
  'academy.verify_rate_limited',
  'academy.sign_in_required',
  'academy.holder_name_invalid',
  'academy.slug_reserved',
  'academy.course_not_found',
  'academy.enrolment_closed',
  'academy.completion_rule_unmet',
  'academy.request_reused',
  'academy.attempt_not_found',
  'academy.attempt_closed',
  'academy.attempt_open',
  'academy.attempt_required',
  'academy.grades_hidden',
  'academy.planner_limit_unset',
  'academy.planner_full',
  'academy.todo_not_found',
  'academy.goal_invalid',
  'academy.captions_invalid',
  'academy.course_slug_taken',
  'academy.course_revision_stale',
  'academy.course_not_editable',
  'academy.item_transition_illegal',
  'academy.price_unset',
  'academy.course_outline_empty',
  'academy.courses_list_limit_unset',
  'academy.outline_limits_unset',
  'academy.outline_too_large',
  'academy.outline_item_unknown',
  'academy.revision_stale',
  'academy.lesson_revision_unknown',
  'academy.item_has_no_lesson',
  'academy.item_kind_locked',
  'academy.import_limit_unset',
  'academy.import_too_large',
  'academy.draft_not_found',
  'academy.lesson_blocks_invalid',
  'academy.enrolment_required',
  'academy.submission_incomplete',
  'academy.assignment_not_found',
  'academy.assignment_closed',
  'academy.submission_version_stale',
  'academy.assignment_has_submissions',
  'academy.peer_count_unset',
  'academy.rubric_invalid',
  'academy.review_marks_invalid',
  'academy.review_task_not_found',
  'academy.review_already_sent',
  'academy.file_unavailable',
  'academy.grader_locked',
  'academy.grader_lease_unset',
  'academy.grade_invalid',
  'academy.bulk_file_invalid',
  'academy.cert_delay_unset',
  'academy.cert_sweep_unset',
  'academy.cert_not_due',
  'academy.cert_revoked',
  'academy.submission_not_found',
  'academy.upload_limits_unset',
  'academy.upload_too_large',
  'academy.upload_type_refused',
  'academy.file_type_mismatch',
  'academy.media_not_found',
  'academy.upload_incomplete',
  'academy.item_video_missing',
  'academy.featured_not_live',
  'academy.lesson_not_live',
  'academy.topic_not_found',
  'academy.topic_slug_taken',
  'academy.topics_list_limit_unset',
  'academy.private_link_not_found',
  'academy.private_link_course_closed',
  'academy.programme_limit_unset',
  'academy.programme_too_large',
  'academy.programme_not_found',
  'academy.programme_slug_taken',
  'academy.post_limit_unset',
  'academy.post_too_long',
  'academy.attachment_limit_unset',
  'academy.attachment_too_large',
  'academy.attachment_type_refused',
  'academy.post_not_found',
  'academy.permission_denied',
  'academy.message_limit_unset',
  'academy.message_too_long',
  'academy.conversation_not_found',
  'academy.quiz_not_found',
  'academy.quiz_no_questions',
  'academy.scoring_policy_unset',
  'academy.item_has_attempts',
  'academy.access_code_invalid',
  'academy.ip_unreadable',
  'academy.ip_not_allowed',
  'academy.survey_duplicate',
  'academy.pacing_locked',
  'academy.not_released_yet',
  'academy.prerequisite_unmeasured',
  'academy.weights_invalid',
  'academy.grading_policy_invalid',
  'academy.ip_rule_invalid',
] as const;

/** L3 — catalog size. */
export function academyErrorCodeCount(): number {
  return ACADEMY_ERROR_CODES.length;
}

/** L3 — true when code is in the published catalog. */
export function isAcademyErrorCode(value: string): value is AcademyErrorCode {
  return (ACADEMY_ERROR_CODES as readonly string[]).includes(value);
}

/** L3 — unavailable codes (operator, not user refusal). */
export function academyUnavailableErrorCodes(): readonly AcademyErrorCode[] {
  return ACADEMY_ERROR_CODES.filter((c) => c.endsWith('_unavailable'));
}

/** L3 — board card. */
export function academyErrorCatalogBoardCard(): {
  readonly total: number;
  readonly unavailable: number;
  readonly hostRelated: number;
} {
  const hostRelated = ACADEMY_ERROR_CODES.filter((c) => c.includes('host')).length;
  return {
    total: academyErrorCodeCount(),
    unavailable: academyUnavailableErrorCodes().length,
    hostRelated,
  };
}

/** L3 — status line. */
export function academyErrorCatalogStatusLine(): string {
  const c = academyErrorCatalogBoardCard();
  return `total=${c.total} unavailable=${c.unavailable} hostRelated=${c.hostRelated}`;
}

/** L3 — parse status. Invalid → null. */
export function parseAcademyErrorCatalogStatusLine(
  line: string,
): { readonly total: number; readonly unavailable: number; readonly hostRelated: number } | null {
  const m = line.trim().match(/^total=(\d+) unavailable=(\d+) hostRelated=(\d+)$/);
  if (!m) return null;
  return { total: Number(m[1]), unavailable: Number(m[2]), hostRelated: Number(m[3]) };
}

/** L3 — true when status matches catalog. */
export function academyErrorCatalogStatusLineMatches(): boolean {
  const p = parseAcademyErrorCatalogStatusLine(academyErrorCatalogStatusLine());
  if (!p) return false;
  const c = academyErrorCatalogBoardCard();
  return p.total === c.total && p.unavailable === c.unavailable && p.hostRelated === c.hostRelated;
}

/** L3 — export header. */
export function academyErrorCatalogExportHeader(): string {
  return 'code';
}

/** L3 — export lines. */
export function academyErrorCatalogExportLines(): readonly string[] {
  return ACADEMY_ERROR_CODES.slice();
}

/** L3 — full export. */
export function academyErrorCatalogExportText(): string {
  return [academyErrorCatalogExportHeader(), ...academyErrorCatalogExportLines()].join('\n');
}

/** L3 — true when total is within [min,max]. Invalid → false. */
export function academyErrorCodeCountInRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = academyErrorCodeCount();
  return n >= min && n <= max;
}
