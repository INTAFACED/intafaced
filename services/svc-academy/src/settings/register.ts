/**
 * AC-order-02 — the owner settings register.
 *
 * One list of every class-a owner value the academy refuses on when blank, with
 * its state (`set` / `not_set`) and the typed code a learner or operator sees
 * while it is blank. The founder settings page and the learner refusals draw
 * from this one list so they cannot drift apart.
 *
 * The register reports STATE only. It never carries the value itself, and it
 * never shows a default: a blank value is `not_set`, full stop. Rows whose
 * value has no store yet (the settings record arrives with
 * AC-course-structure-01) are listed as `not_set` with `store: 'pending'`, so
 * the page shows the real blocker instead of hiding the row. Ambassador pay,
 * revenue share and tournament prize pools stay refuse-closed and appear here
 * only as read-only rows.
 */
import type { AcademyErrorCode } from '../errors.js';

export type SettingState = 'set' | 'not_set';
/** `env` = the deployment sets it; `pending` = no store exists yet; `refuse_closed` = read-only, refuses until a Class M recipe lands. */
export type SettingStore = 'env' | 'pending' | 'refuse_closed';

export interface SettingRow {
  readonly key: string;
  readonly state: SettingState;
  readonly store: SettingStore;
  readonly readOnly: boolean;
  /** Typed refusal shown while the value is blank (null when the blank state has no code of its own yet). */
  readonly refusalCode:
    | AcademyErrorCode
    | 'academy.prize_pool_unset'
    | 'academy.report_limit_unset'
    | 'academy.ambassador_pay.rates_unset'
    | 'academy.ambassador_revenue_share.rates_unset'
    | null;
}

/** The env subset the register reads. Every field optional: absent means blank. */
export interface SettingsEnv {
  readonly ACADEMY_MAX_ROOM_CAPACITY?: number | undefined;
  readonly ACADEMY_OUTLINE_MAX_SECTIONS?: number | undefined;
  readonly ACADEMY_OUTLINE_MAX_ITEMS?: number | undefined;
  readonly ACADEMY_LESSON_IMPORT_MAX_BYTES?: number | undefined;
  readonly ACADEMY_UPLOAD_MAX_BYTES?: number | undefined;
  readonly ACADEMY_TOPICS_LIST_LIMIT?: number | undefined;
  readonly ACADEMY_GRADER_LEASE_SECONDS?: number | undefined;
  readonly ACADEMY_GRADE_REPORT_ROWS?: number | undefined;
  readonly ACADEMY_BULK_FILE_MAX_BYTES?: number | undefined;
  readonly ACADEMY_CERT_ISSUE_SWEEP_SECONDS?: number | undefined;
  readonly ACADEMY_PROGRAMME_MAX_COURSES?: number | undefined;
  readonly ACADEMY_POST_MAX_CHARS?: number | undefined;
  readonly ACADEMY_POST_IMAGE_MAX_BYTES?: number | undefined;
  readonly ACADEMY_MESSAGE_MAX_CHARS?: number | undefined;
  readonly ACADEMY_UPLOAD_VIDEO_TYPES?: readonly string[] | undefined;
  readonly ACADEMY_UPLOAD_HANDOUT_TYPES?: readonly string[] | undefined;
  readonly ACADEMY_PAPER_MARKETS_LIMIT?: number | undefined;
  readonly TRADE_URL?: string | undefined;
  readonly ACADEMY_STREAM_PROVIDER?: 'none' | 'livekit' | undefined;
  readonly ACADEMY_VIDEO_S3_ENDPOINT?: string | undefined;
  readonly ACADEMY_VIDEO_S3_BUCKET?: string | undefined;
  readonly ACADEMY_VIDEO_S3_ACCESS_KEY?: string | undefined;
  readonly ACADEMY_VIDEO_S3_SECRET_KEY?: string | undefined;
  readonly ACADEMY_VIDEO_S3_REGION?: string | undefined;
  readonly ACADEMY_VIDEO_URL_TTL_SECONDS?: number | undefined;
  readonly ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS?: number | undefined;
  readonly ACADEMY_VIDEO_POSITION_SAVE_SECONDS?: number | undefined;
  readonly ACADEMY_CERT_VERIFY_RATE_MAX?: number | undefined;
  readonly ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS?: number | undefined;
  readonly ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON?: string | undefined;
  readonly ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON?: string | undefined;
}

const filled = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';
const positiveInt = (v: number | undefined): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const state = (ok: boolean): SettingState => (ok ? 'set' : 'not_set');

/**
 * Owner values named by the academy slices that have no store on main yet.
 * They are listed so the settings page shows each one as "not set" with its
 * real blocker; none carries a number.
 */
export const PENDING_OWNER_SETTINGS: readonly string[] = [
  'undelete_window',
  'dwell_seconds',
  'expiry_duration',
  'nudge_timings',
  'retention_period',
  'custom_role_count',
  'mail_recipient_limit',
  'mail_digest_limit',
  'assistant_provider',
];

export function settingsRegister(env: SettingsEnv): readonly SettingRow[] {
  const rows: SettingRow[] = [
    {
      key: 'room_capacity',
      state: state(positiveInt(env.ACADEMY_MAX_ROOM_CAPACITY)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.room_capacity_unset',
    },
    {
      key: 'paper_markets_limit',
      state: state(positiveInt(env.ACADEMY_PAPER_MARKETS_LIMIT)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.paper_markets_limit_unset',
    },
    {
      key: 'paper_flag_source',
      state: state(filled(env.TRADE_URL)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.paper_flag_unverified',
    },
    {
      // 'none' is the explicit "not chosen" value: the provider refuses, so it is not set.
      key: 'live_video_provider',
      state: state(env.ACADEMY_STREAM_PROVIDER !== undefined && env.ACADEMY_STREAM_PROVIDER !== 'none'),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.stream_unavailable',
    },
    {
      key: 'video_storage',
      state: state(
        filled(env.ACADEMY_VIDEO_S3_ENDPOINT) &&
          filled(env.ACADEMY_VIDEO_S3_BUCKET) &&
          filled(env.ACADEMY_VIDEO_S3_ACCESS_KEY) &&
          filled(env.ACADEMY_VIDEO_S3_SECRET_KEY),
      ),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.video_storage_unconfigured',
    },
    {
      key: 'video_s3_region',
      state: state(filled(env.ACADEMY_VIDEO_S3_REGION)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.video_s3_region_unset',
    },
    {
      key: 'video_url_ttl',
      state: state(positiveInt(env.ACADEMY_VIDEO_URL_TTL_SECONDS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.video_url_ttl_unset',
    },
    {
      key: 'watch_threshold',
      state: state(positiveInt(env.ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.watch_threshold_unset',
    },
    {
      // Blank refuses nothing: the player saves on pause and on leaving only, and says so.
      key: 'video_position_save',
      state: state(positiveInt(env.ACADEMY_VIDEO_POSITION_SAVE_SECONDS)),
      store: 'env',
      readOnly: false,
      refusalCode: null,
    },
    {
      // Both halves or nothing: index.ts wires the limiter only when both are set.
      key: 'cert_verify_rate',
      state: state(positiveInt(env.ACADEMY_CERT_VERIFY_RATE_MAX) && positiveInt(env.ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.verify_rate_unset',
    },
    {
      key: 'ambassador_ifc_pay_law',
      state: state(filled(env.ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON)),
      store: 'refuse_closed',
      readOnly: true,
      refusalCode: 'academy.ambassador_pay.rates_unset',
    },
    {
      key: 'ambassador_revenue_share_law',
      state: state(filled(env.ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON)),
      store: 'refuse_closed',
      readOnly: true,
      refusalCode: 'academy.ambassador_revenue_share.rates_unset',
    },
    {
      key: 'section_limit',
      state: state(positiveInt(env.ACADEMY_OUTLINE_MAX_SECTIONS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.outline_limits_unset',
    },
    {
      key: 'item_limit',
      state: state(positiveInt(env.ACADEMY_OUTLINE_MAX_ITEMS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.outline_limits_unset',
    },
    {
      key: 'lesson_import_size_limit',
      state: state(positiveInt(env.ACADEMY_LESSON_IMPORT_MAX_BYTES)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.import_limit_unset',
    },
    {
      key: 'topics_list_limit',
      state: state(positiveInt(env.ACADEMY_TOPICS_LIST_LIMIT)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.topics_list_limit_unset',
    },
    {
      key: 'lease_length',
      state: state(positiveInt(env.ACADEMY_GRADER_LEASE_SECONDS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.grader_lease_unset',
    },
    {
      key: 'grade_report_rows',
      state: state(positiveInt(env.ACADEMY_GRADE_REPORT_ROWS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.report_limit_unset',
    },
    {
      key: 'bulk_file_max_bytes',
      state: state(positiveInt(env.ACADEMY_BULK_FILE_MAX_BYTES)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.bulk_limit_unset',
    },
    {
      // Blank runs no sweep, so a delayed certificate would wait for its learner to come back: delayed rules refuse.
      key: 'cert_issue_sweep',
      state: state(positiveInt(env.ACADEMY_CERT_ISSUE_SWEEP_SECONDS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.cert_sweep_unset',
    },
    {
      // Blank: a programme takes no course, so a save with courses refuses.
      key: 'programme_max_courses',
      state: state(positiveInt(env.ACADEMY_PROGRAMME_MAX_COURSES)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.programme_limit_unset',
    },
    {
      // Blank: every discussion post and reply refuses.
      key: 'post_max_chars',
      state: state(positiveInt(env.ACADEMY_POST_MAX_CHARS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.post_limit_unset',
    },
    {
      // Blank: a post with an image refuses; a post without one is not affected.
      key: 'post_image_max_bytes',
      state: state(positiveInt(env.ACADEMY_POST_IMAGE_MAX_BYTES)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.attachment_limit_unset',
    },
    {
      // Blank: every message to or from a course team refuses.
      key: 'message_max_chars',
      state: state(positiveInt(env.ACADEMY_MESSAGE_MAX_CHARS)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.message_limit_unset',
    },
    {
      key: 'upload_size_limit',
      state: state(positiveInt(env.ACADEMY_UPLOAD_MAX_BYTES)),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.upload_limits_unset',
    },
    {
      key: 'upload_video_types',
      state: state((env.ACADEMY_UPLOAD_VIDEO_TYPES?.length ?? 0) > 0),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.upload_limits_unset',
    },
    {
      key: 'upload_handout_types',
      state: state((env.ACADEMY_UPLOAD_HANDOUT_TYPES?.length ?? 0) > 0),
      store: 'env',
      readOnly: false,
      refusalCode: 'academy.upload_limits_unset',
    },
    {
      // No store and no recipe: always not set, always refuse-closed.
      key: 'tournament_prize_pool',
      state: 'not_set',
      store: 'refuse_closed',
      readOnly: true,
      refusalCode: 'academy.prize_pool_unset',
    },
  ];
  for (const key of PENDING_OWNER_SETTINGS) {
    rows.push({ key, state: 'not_set', store: 'pending', readOnly: true, refusalCode: null });
  }
  return rows;
}
