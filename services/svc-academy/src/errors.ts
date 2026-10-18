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
  /** Programme prerequisites the caller has not enrolled in. */
  | 'academy.prerequisite_unmet'
  /** touchLesson secondsRead outside 0..TOUCH_LESSON_MAX_SECONDS. */
  | 'academy.seconds_out_of_range'
  /** Video slug is not on the named spine. */
  | 'academy.video_not_found'
  /** Watch position is negative, not an integer, or past a set duration. */
  | 'academy.video_position_out_of_range'
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
  | 'academy.holder_name_invalid';

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
  'academy.seconds_out_of_range',
  'academy.video_not_found',
  'academy.video_position_out_of_range',
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
  'academy.holder_name_invalid',
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
