/**
 * VIP applications on Postgres, through the REST routes (SP-fees-vip-04, J-cex-spot-10 #7): what is kept and how, the
 * same request again, a request id reused for another file, one pending application per person, two at once, and
 * every refusal leaving nothing behind. TEST rules and a TEST key only.
 */
import Fastify from 'fastify';
import { createDecipheriv } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { TestDatabase } from '@intafaced/db';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseFeeScheduleJson, type OwnerFeeSchedule } from './fee-schedule.js';
import { VipApplicationStore, proofAad } from './vip-applications.js';
import { VIP_APPLICATIONS_PATH, registerVipRest } from './vip-rest.js';
import { ALICE, BOB, openTradeDatabase } from './__tests__/saga-trade-fixture.js';

const EDGE = 'a-vip-applications-edge-secret-long-enough-x';
const KEY = Buffer.alloc(32, 9);
const PDF = Buffer.from('%PDF-1.7 TEST proof of status, never a real statement');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('TEST')]);

const schedule = (application: unknown): OwnerFeeSchedule =>
  parseFeeScheduleJson(
    JSON.stringify({
      published: true,
      version: 'test-vip',
      defaultPairGroup: 'g',
      rows: [
        { pairGroup: 'g', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
        { pairGroup: 'g', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null },
      ],
      tierProgram: {
        thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000' }],
        volumeQuotes: ['USDT'],
        snapshotTimeUtc: null,
        downgradeGraceDays: null,
        subAccounts: null,
        botsAndCopy: null,
        application,
      },
    }),
  );
const OPEN = schedule({ proofTypes: ['application/pdf', 'image/png'], maxBytes: 1024 });

function signed(userId: string, scopes = ['trade:read', 'trade:write']): Record<string, string> {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'), 'x-intafaced-region': 'DE' };
}

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;
const sql = () => {
  if (!db) throw new Error('database not ready');
  return db.sql;
};

beforeAll(async () => {
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);
beforeEach(async () => {
  await sql()`ALTER TABLE trade.vip_application_events DISABLE TRIGGER vip_application_events_append_only_trg`;
  await sql()`ALTER TABLE trade.vip_applications DISABLE TRIGGER vip_applications_status_only_trg`;
  await sql()`TRUNCATE trade.vip_trials, trade.vip_application_events, trade.vip_applications`;
  await sql()`ALTER TABLE trade.vip_application_events ENABLE TRIGGER vip_application_events_append_only_trg`;
  await sql()`ALTER TABLE trade.vip_applications ENABLE TRIGGER vip_applications_status_only_trg`;
});

async function app(fees: OwnerFeeSchedule = OPEN, key: Buffer | null = KEY) {
  const server = Fastify();
  registerVipRest(server, {
    edgeSecret: EDGE,
    serviceName: 'svc-trade',
    store: new VipApplicationStore(sql(), key),
    scheduleAt: async () => fees,
  });
  await server.ready();
  return server;
}

const body = (requestId: string, file: Buffer = PDF, contentType = 'application/pdf', fileName = 'statement.pdf') => ({
  requestId,
  proof: { fileName, contentType, bytesBase64: file.toString('base64') },
});
const rows = () => sql()<Array<{ status: string }>>`SELECT status FROM trade.vip_applications`;

describe('sending a VIP application', () => {
  it('keeps the proof encrypted, bound to its row, and shows the person only its metadata', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: { ...body('vip-req-0001'), note: 'TEST' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { application } = res.json();
    expect(application).toMatchObject({
      requestId: 'vip-req-0001',
      status: 'pending',
      proof: { fileName: 'statement.pdf', contentType: 'application/pdf', byteLength: PDF.length },
      note: 'TEST',
      scheduleVersion: 'test-vip',
    });
    expect(JSON.stringify(application)).not.toContain(PDF.toString('base64'));
    const [row] = await sql()<Array<{ proof_ciphertext: Buffer; proof_nonce: Buffer; request_key: string }>>`
      SELECT proof_ciphertext, proof_nonce, request_key FROM trade.vip_applications WHERE id = ${application.id}
    `;
    expect(row!.request_key).toBe(`vip-application:${ALICE}:vip-req-0001`);
    expect(row!.proof_ciphertext.includes(PDF)).toBe(false);
    const open = (aad: Buffer) => {
      const d = createDecipheriv('aes-256-gcm', KEY, row!.proof_nonce);
      d.setAAD(aad);
      d.setAuthTag(row!.proof_ciphertext.subarray(-16));
      return Buffer.concat([d.update(row!.proof_ciphertext.subarray(0, -16)), d.final()]);
    };
    expect(open(proofAad(application.id, application.proof.sha256)).equals(PDF)).toBe(true);
    expect(() => open(proofAad('33333333-3333-4333-8333-333333333333', application.proof.sha256))).toThrow();

    const listed = await server.inject({ method: 'GET', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE) });
    expect(listed.json()).toEqual({
      rules: { proofTypes: ['application/pdf', 'image/png'], maxBytes: 1024 },
      closed: null,
      applications: [application],
    });
    expect((await server.inject({ method: 'GET', url: VIP_APPLICATIONS_PATH, headers: signed(BOB) })).json().applications).toEqual([]);
    expect(await sql()`SELECT status, actor_role FROM trade.vip_application_events`).toEqual([
      { status: 'pending', actor_role: 'applicant' },
    ]);
  });

  it('answers the same request again with the application it made, and refuses its id for another file', async () => {
    const server = await app();
    const first = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0002'),
    });
    const again = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0002'),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().application.id).toBe(first.json().application.id);
    const other = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0002', PNG, 'image/png'),
    });
    expect([other.statusCode, other.json().code]).toEqual([409, 'vip.request_reused']);
    expect(await rows()).toHaveLength(1);
  });

  it('answers a kept request after the rules change, and refuses its id for the same file under another name', async () => {
    const first = await (
      await app()
    ).inject({ method: 'POST', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE), payload: body('vip-req-0020') });
    expect(first.statusCode).toBe(201);
    const closed = await app(schedule(null), null);
    const again = await closed.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0020'),
    });
    expect([again.statusCode, again.json().application.id]).toEqual([200, first.json().application.id]);
    const renamed = await (
      await app()
    ).inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0020', PDF, 'application/pdf', 'other.pdf'),
    });
    expect([renamed.statusCode, renamed.json().code]).toEqual([409, 'vip.request_reused']);
    expect(await rows()).toHaveLength(1);
  });

  it('takes a new application once the last one is decided', async () => {
    const server = await app();
    const first = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0021'),
    });
    await sql()`UPDATE trade.vip_applications SET status = 'rejected' WHERE id = ${first.json().application.id}`;
    const next = await server.inject({ method: 'POST', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE), payload: body('vip-req-0022') });
    expect(next.statusCode, next.body).toBe(201);
    expect((await rows()).map((r) => r.status).sort()).toEqual(['pending', 'rejected']);
  });

  it('says why applications are not open before anyone sends a file', async () => {
    const unset = await (await app(schedule(null))).inject({ method: 'GET', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE) });
    expect(unset.json()).toEqual({ rules: null, closed: 'vip.application_unset', applications: [] });
    const unkeyed = await (await app(OPEN, null)).inject({ method: 'GET', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE) });
    expect(unkeyed.json()).toEqual({ rules: null, closed: 'vip.proof_key_unset', applications: [] });
  });

  it('keeps one pending application per person, also when two are sent at once', async () => {
    const server = await app();
    const both = await Promise.all(
      ['vip-req-0003', 'vip-req-0004'].map((id) =>
        server.inject({ method: 'POST', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE), payload: body(id) }),
      ),
    );
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(both.find((r) => r.statusCode === 409)!.json().code).toBe('vip.application_open');
    expect(await rows()).toHaveLength(1);
    // Another person is not held up by it.
    expect(
      (await server.inject({ method: 'POST', url: VIP_APPLICATIONS_PATH, headers: signed(BOB), payload: body('vip-req-0005') })).statusCode,
    ).toBe(201);
  });

  it.each([
    [
      'a file type not on the owner list',
      OPEN,
      KEY,
      body('vip-req-0006', Buffer.from('TEST'), 'text/plain', 'proof.txt'),
      400,
      'vip.file_type_unsupported',
    ],
    [
      'a file that is not the type it is sent as',
      OPEN,
      KEY,
      body('vip-req-0007', PDF, 'image/png', 'proof.png'),
      400,
      'vip.file_not_its_type',
    ],
    ['rules the owner has not published', schedule(null), KEY, body('vip-req-0008'), 503, 'vip.application_unset'],
    ['no proof key', OPEN, null, body('vip-req-0009'), 503, 'vip.proof_key_unset'],
    ['a body with an extra field', OPEN, KEY, { ...body('vip-req-0010'), tier: 'test-vip-1' }, 400, 'vip.request_invalid'],
    ['a note with a control character', OPEN, KEY, { ...body('vip-req-0014'), note: 'TEST\u0000' }, 400, 'vip.request_invalid'],
    [
      'a name with a direction override',
      OPEN,
      KEY,
      body('vip-req-0015', PDF, 'application/pdf', 'statement\u202Efdp.exe'),
      400,
      'vip.request_invalid',
    ],
  ] as const)('refuses %s and keeps nothing', async (_name, fees, key, payload, status, code) => {
    const server = await app(fees, key);
    const res = await server.inject({ method: 'POST', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE), payload });
    expect([res.statusCode, res.json().code]).toEqual([status, code]);
    expect(await rows()).toHaveLength(0);
  });

  it('names the accepted types when it refuses one', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE),
      payload: body('vip-req-0011', Buffer.from('TEST'), 'text/plain', 'proof.txt'),
    });
    expect(res.json()).toMatchObject({ code: 'vip.file_type_unsupported', accepted: ['application/pdf', 'image/png'] });
  });

  it('asks for a signed person with the right scope', async () => {
    const server = await app();
    expect((await server.inject({ method: 'GET', url: VIP_APPLICATIONS_PATH })).statusCode).toBe(401);
    const readOnly = await server.inject({
      method: 'POST',
      url: VIP_APPLICATIONS_PATH,
      headers: signed(ALICE, ['trade:read']),
      payload: body('vip-req-0012'),
    });
    expect(readOnly.statusCode).toBe(403);
  });

  it('never changes a kept proof, and never deletes an application', async () => {
    const server = await app();
    const { application } = (
      await server.inject({ method: 'POST', url: VIP_APPLICATIONS_PATH, headers: signed(ALICE), payload: body('vip-req-0013') })
    ).json();
    await expect(sql()`UPDATE trade.vip_applications SET proof_sha256 = ${'0'.repeat(64)} WHERE id = ${application.id}`).rejects.toThrow(
      /only the status changes/,
    );
    await expect(sql()`DELETE FROM trade.vip_applications WHERE id = ${application.id}`).rejects.toThrow(/DELETE is not permitted/);
    await expect(sql()`DELETE FROM trade.vip_application_events`).rejects.toThrow(/append-only/);
  });
});
