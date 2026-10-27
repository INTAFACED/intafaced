/**
 * AC-order-02 — the owner settings register reports state, never a value or default.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import { createAcademyRouter } from '../router.js';
import { PENDING_OWNER_SETTINGS, settingsRegister, type SettingsEnv } from './register.js';

const FULL: SettingsEnv = {
  ACADEMY_OUTLINE_MAX_SECTIONS: 20,
  ACADEMY_OUTLINE_MAX_ITEMS: 200,
  ACADEMY_LESSON_IMPORT_MAX_BYTES: 8192,
  ACADEMY_UPLOAD_MAX_BYTES: 1_048_576,
  ACADEMY_TOPICS_LIST_LIMIT: 100,
  ACADEMY_GRADER_LEASE_SECONDS: 900,
  ACADEMY_GRADE_REPORT_ROWS: 500,
  ACADEMY_CERT_ISSUE_SWEEP_SECONDS: 60,
  ACADEMY_PROGRAMME_MAX_COURSES: 4,
  ACADEMY_POST_MAX_CHARS: 4000,
  ACADEMY_POST_IMAGE_MAX_BYTES: 262144,
  ACADEMY_MESSAGE_MAX_CHARS: 4000,
  ACADEMY_UPLOAD_VIDEO_TYPES: ['video/webm'],
  ACADEMY_UPLOAD_HANDOUT_TYPES: ['application/pdf'],
  ACADEMY_MAX_ROOM_CAPACITY: 7,
  ACADEMY_PAPER_MARKETS_LIMIT: 3,
  TRADE_URL: 'http://trade.test',
  ACADEMY_STREAM_PROVIDER: 'livekit',
  ACADEMY_VIDEO_S3_ENDPOINT: 'http://s3.test',
  ACADEMY_VIDEO_S3_BUCKET: 'b',
  ACADEMY_VIDEO_S3_ACCESS_KEY: 'k',
  ACADEMY_VIDEO_S3_SECRET_KEY: 's',
  ACADEMY_VIDEO_S3_REGION: 'r',
  ACADEMY_VIDEO_URL_TTL_SECONDS: 11,
  ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS: 15,
  ACADEMY_VIDEO_POSITION_SAVE_SECONDS: 5,
  ACADEMY_CERT_VERIFY_RATE_MAX: 2,
  ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS: 13,
  ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON: '{"published":true}',
  ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON: '{"published":true}',
};

const row = (env: SettingsEnv, key: string) => {
  const r = settingsRegister(env).find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};

describe('settingsRegister (AC-order-02)', () => {
  it('blank env: every row is not_set, nothing defaulted', () => {
    const rows = settingsRegister({});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === 'not_set')).toBe(true);
  });

  it('keys are unique and pending rows are all listed read-only with no code', () => {
    const rows = settingsRegister({});
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    for (const key of PENDING_OWNER_SETTINGS) {
      expect(row({}, key)).toEqual({ key, state: 'not_set', store: 'pending', readOnly: true, refusalCode: null });
    }
  });

  it('every env-backed row turns set when its value is set', () => {
    const rows = settingsRegister(FULL).filter((r) => r.store !== 'pending' && r.key !== 'tournament_prize_pool');
    expect(rows.every((r) => r.state === 'set')).toBe(true);
  });

  it('the prize pool is always not_set and refuse-closed', () => {
    expect(row(FULL, 'tournament_prize_pool')).toMatchObject({
      state: 'not_set',
      store: 'refuse_closed',
      readOnly: true,
      refusalCode: 'academy.prize_pool_unset',
    });
  });

  it('each row names its refusal code while blank', () => {
    expect(row({}, 'room_capacity').refusalCode).toBe('academy.room_capacity_unset');
    expect(row({}, 'paper_markets_limit').refusalCode).toBe('academy.paper_markets_limit_unset');
    expect(row({}, 'paper_flag_source').refusalCode).toBe('academy.paper_flag_unverified');
    expect(row({}, 'live_video_provider').refusalCode).toBe('academy.stream_unavailable');
    expect(row({}, 'video_storage').refusalCode).toBe('academy.video_storage_unconfigured');
    expect(row({}, 'video_s3_region').refusalCode).toBe('academy.video_s3_region_unset');
    expect(row({}, 'video_url_ttl').refusalCode).toBe('academy.video_url_ttl_unset');
    expect(row({}, 'watch_threshold').refusalCode).toBe('academy.watch_threshold_unset');
    expect(row({}, 'section_limit')).toMatchObject({ state: 'not_set', store: 'env', refusalCode: 'academy.outline_limits_unset' });
    expect(row({}, 'item_limit')).toMatchObject({ state: 'not_set', store: 'env', refusalCode: 'academy.outline_limits_unset' });
    expect(row({}, 'lesson_import_size_limit')).toMatchObject({
      state: 'not_set',
      store: 'env',
      refusalCode: 'academy.import_limit_unset',
    });
    expect(row({}, 'topics_list_limit')).toMatchObject({ state: 'not_set', refusalCode: 'academy.topics_list_limit_unset' });
    for (const key of ['upload_size_limit', 'upload_video_types', 'upload_handout_types'])
      expect(row({}, key)).toMatchObject({ state: 'not_set', store: 'env', refusalCode: 'academy.upload_limits_unset' });
    expect(row({ ACADEMY_UPLOAD_VIDEO_TYPES: ['video/webm'] }, 'upload_video_types').state).toBe('set');
    expect(row({}, 'cert_verify_rate').refusalCode).toBe('academy.verify_rate_unset');
    expect(row({}, 'ambassador_ifc_pay_law').refusalCode).toBe('academy.ambassador_pay.rates_unset');
    expect(row({}, 'ambassador_revenue_share_law').refusalCode).toBe('academy.ambassador_revenue_share.rates_unset');
  });

  it("stream provider 'none' is the not-chosen value, not set", () => {
    expect(row({ ACADEMY_STREAM_PROVIDER: 'none' }, 'live_video_provider').state).toBe('not_set');
  });

  it('whitespace strings are blank', () => {
    expect(row({ ...FULL, TRADE_URL: '  ' }, 'paper_flag_source').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_VIDEO_S3_REGION: ' ' }, 'video_s3_region').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON: '' }, 'ambassador_ifc_pay_law').state).toBe('not_set');
  });

  it('zero, negative or fractional numbers are not set', () => {
    expect(row({ ...FULL, ACADEMY_MAX_ROOM_CAPACITY: 0 }, 'room_capacity').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_PAPER_MARKETS_LIMIT: -1 }, 'paper_markets_limit').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_VIDEO_URL_TTL_SECONDS: 1.5 }, 'video_url_ttl').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS: 0 }, 'watch_threshold').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_VIDEO_POSITION_SAVE_SECONDS: 0 }, 'video_position_save').state).toBe('not_set');
  });

  it('video storage needs all four parts', () => {
    for (const k of [
      'ACADEMY_VIDEO_S3_ENDPOINT',
      'ACADEMY_VIDEO_S3_BUCKET',
      'ACADEMY_VIDEO_S3_ACCESS_KEY',
      'ACADEMY_VIDEO_S3_SECRET_KEY',
    ] as const) {
      expect(row({ ...FULL, [k]: '' }, 'video_storage').state).toBe('not_set');
    }
  });

  it('verify rate needs both max and window', () => {
    expect(row({ ...FULL, ACADEMY_CERT_VERIFY_RATE_MAX: undefined }, 'cert_verify_rate').state).toBe('not_set');
    expect(row({ ...FULL, ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS: undefined }, 'cert_verify_rate').state).toBe('not_set');
  });

  it('never leaks a value: rows carry only key/state/store/readOnly/refusalCode', () => {
    const text = JSON.stringify(settingsRegister(FULL));
    for (const secret of ['http://s3.test', 'http://trade.test', '"published"', '"s"', '"k"']) {
      expect(text).not.toContain(secret);
    }
    for (const r of settingsRegister(FULL)) {
      expect(Object.keys(r).sort()).toEqual(['key', 'readOnly', 'refusalCode', 'state', 'store']);
    }
  });
});

const SECRET = 'an-academy-settings-status-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function signed(scopes: string[]) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-settings-status',
  });
}

const caller = (scopes: string[], env?: SettingsEnv) =>
  createAcademyRouter({} as AcademyService, {}, undefined, undefined, null, env).createCaller(signed(scopes));

describe('academy.admin.settingsStatus door (AC-order-02)', () => {
  it('admin:read gets the register from the wired env', async () => {
    const out = await caller(['admin:read'], FULL).admin.settingsStatus();
    expect(out.rows).toEqual(settingsRegister(FULL));
  });

  it('unwired router reports every row not_set', async () => {
    const out = await caller(['admin:read']).admin.settingsStatus();
    expect(out.rows.every((r) => r.state === 'not_set')).toBe(true);
  });

  it('a learner session without admin:read is refused', async () => {
    await expect(caller(['academy:read', 'academy:write']).admin.settingsStatus()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an unauthenticated call is refused', async () => {
    const anon = createAcademyRouter({} as AcademyService).createCaller(edgeContext({ headers: {}, id: 'anon' }));
    await expect(anon.admin.settingsStatus()).rejects.toBeTruthy();
  });
});
