import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatMoney } from '@intafaced/i18n';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { createFounderAdminRouter } from '../namespaces/founder-admin.js';
import { createFounderOpsRouter, createMerchantOpsRouter } from './router.js';
import { ReceiptBrandingService } from './receipt-branding.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_receipt_branding_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const places = (assetId: string) => (assetId === 'USDT' ? 6 : null);

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: nid(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; message?: string; cause?: { code?: string; blockers?: Array<{ code: string }> } };
    return { code: err.code, message: err.message, cause: err.cause?.code, blockers: err.cause?.blockers };
  }
  throw new Error('expected a refusal');
}

describe('receipt branding and status emails (M-adv-payments-core-07)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const other = nid();
  const viewer = nid();
  const developer = nid();
  const finance = nid();
  const founderUser = nid();
  let merchant = '';
  const founderFetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ result: { data: { status: 'enabled', userId: founderUser, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  const founderAuthority = createFounderAuthority({ ...identity, fetcher: founderFetcher });

  const api = () =>
    mergeRouters(
      createMerchantOpsRouter({ sql, founderAuthority, receiptPlaces: places }),
      createFounderAdminRouter(founderAuthority, {
        ops: createFounderOpsRouter({ sql, founderAuthority, receiptPlaces: places }),
      }),
    );
  const as = (userId: string, over: Partial<Principal> = {}) => api().createCaller(ctxOf(principalOf(userId, over)));
  const branding = () => new ReceiptBrandingService(sql, places);

  const opsBody = {
    requestId: nid(),
    logoRef: 'ops-logo',
    accent: '#112233',
    footer: 'Ops footer',
    language: 'en',
  };
  const shopBody = {
    requestId: nid(),
    logoRef: 'shop-logo',
    accent: 'rgb(10, 20, 30)',
    footer: 'Thanks for paying',
    language: 'de',
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${other})`;
    for (const [userId, role] of [
      [viewer, 'viewer'],
      [developer, 'developer'],
      [finance, 'finance'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${userId}, ${role}, 'active', ${owner}, now())`;
    }
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('refuses a preview until a template exists, and an empty email save', async () => {
    const missing = await refusal(() => as(owner).merchantOps.receiptBranding.preview({ amount: '1', assetId: 'USDT' }));
    expect(missing).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.receipt_template_unset' });
    const fresh = await as(owner).merchantOps.statusEmails.get({});
    expect(fresh).toEqual({ succeeded: null, failed: null, refunded: null, updatedAt: null });
    const empty = await refusal(() => as(owner).merchantOps.statusEmails.set({}));
    expect(empty).toMatchObject({ code: 'BAD_REQUEST', cause: 'pay.status_email_empty' });
  });

  it('uses the ops default, then the merchant snapshot, with every locale place', async () => {
    const founder = as(founderUser);
    const ops = await founder.founderAdmin.ops.receiptTemplate.save(opsBody);
    expect(ops).toMatchObject({
      source: 'ops_default',
      logoRef: 'ops-logo',
      footer: 'Ops footer',
      language: 'en',
      version: 1,
      replayed: false,
    });
    const fromOps = await as(owner).merchantOps.receiptBranding.preview({ amount: '1234.5', assetId: 'USDT' });
    expect(fromOps).toMatchObject({ source: 'ops_default', logoRef: 'ops-logo', footer: 'Ops footer', places: 6, assetId: 'USDT' });
    expect(fromOps.amount).toBe(formatMoney('1234.5', 'USDT', 'en', { minFractionDigits: 6, maxFractionDigits: 6, display: 'code' }));

    const saved = await as(owner).merchantOps.receiptBranding.save(shopBody);
    expect(saved).toMatchObject({
      source: 'merchant',
      logoRef: 'shop-logo',
      accent: '#0A141E',
      footer: 'Thanks for paying',
      language: 'de',
      version: 1,
      replayed: false,
    });
    const shown = await as(viewer).merchantOps.receiptBranding.preview({ amount: '1234.5', assetId: 'USDT' });
    expect(shown.logoRef).toBe('shop-logo');
    expect(shown.footer).toBe('Thanks for paying');
    expect(shown.places).toBe(6);
    expect(shown.amount).toBe(formatMoney('1234.5', 'USDT', 'de', { minFractionDigits: 6, maxFractionDigits: 6, display: 'code' }));
    const separator = new Intl.NumberFormat('de-DE').formatToParts(1.1).find((part) => part.type === 'decimal')!.value;
    expect(shown.amount.split(' ')[0]!.split(separator)[1]).toBe('500000');

    const again = await as(owner).merchantOps.receiptBranding.save({ ...shopBody, requestId: nid() });
    expect(again.versionId).toBe(saved.versionId);
    expect(again.replayed).toBe(true);
    const changed = await as(owner).merchantOps.receiptBranding.save({ ...shopBody, requestId: nid(), footer: 'Updated footer' });
    expect(changed.version).toBe(2);
    expect(changed.versionId).not.toBe(saved.versionId);
    const first = await sql<Array<{ footer: string }>>`
      SELECT footer FROM pay.receipt_template_versions WHERE id = ${saved.versionId}`;
    expect(first[0]!.footer).toBe('Thanks for paying');
    const replay = await as(owner).merchantOps.receiptBranding.save(shopBody);
    expect(replay.versionId).toBe(saved.versionId);
    expect(replay.replayed).toBe(true);
    const clash = await refusal(() => as(owner).merchantOps.receiptBranding.save({ ...shopBody, footer: 'Other' }));
    expect(clash).toMatchObject({ code: 'CONFLICT', cause: 'pay.request_id_reused' });

    const foreign = await as(other).merchantOps.receiptBranding.get({});
    expect(foreign).toMatchObject({ source: 'ops_default', logoRef: 'ops-logo' });
    expect(foreign.footer).not.toBe('Thanks for paying');
  });

  it('keeps an issued receipt on the version it was pinned with', async () => {
    const caller = { merchantId: merchant, userId: owner, role: 'owner' as const, viaApiKey: false, interactive: true };
    const requestId = nid();
    const pinned = await branding().pinIssuedReceipt(caller, requestId);
    const next = await as(owner).merchantOps.receiptBranding.save({ ...shopBody, requestId: nid(), footer: 'After the receipt' });
    const retry = await branding().pinIssuedReceipt(caller, requestId);
    expect(retry).toMatchObject({ issueId: pinned.issueId, templateVersionId: pinned.templateVersionId, replayed: true });
    expect(retry.templateVersionId).not.toBe(next.versionId);
    const later = await branding().pinIssuedReceipt(caller, nid());
    expect(later.templateVersionId).toBe(next.versionId);
    await expect(sql`UPDATE pay.receipt_template_versions SET footer = 'edited' WHERE id = ${pinned.templateVersionId}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM pay.receipt_issues WHERE id = ${pinned.issueId}`).rejects.toThrow(/append-only/);
  });

  it('queues nothing when email is off, and refuses vendor.email when it is on', async () => {
    const off = await as(owner).merchantOps.statusEmails.sendTest({ kind: 'succeeded' });
    expect(off).toEqual({ queued: false });
    const stopped = await as(finance).merchantOps.statusEmails.set({ succeeded: false, failed: false, refunded: false });
    expect(stopped.succeeded).toBe(false);
    const stillOff = await as(finance).merchantOps.statusEmails.sendTest({ kind: 'failed' });
    expect(stillOff).toEqual({ queued: false });
    const issuesBefore = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.receipt_issues`;
    await as(owner).merchantOps.statusEmails.set({ succeeded: true });
    const sent = await refusal(() => as(owner).merchantOps.statusEmails.sendTest({ kind: 'succeeded' }));
    expect(sent).toMatchObject({ code: 'PRECONDITION_FAILED', message: 'vendor.email', cause: 'vendor.email' });
    expect(sent.blockers).toEqual([{ code: 'vendor.email' }]);
    const queued = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.payment_status_email_queue`;
    const issuesAfter = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.receipt_issues`;
    expect(queued[0]!.n).toBe(0);
    expect(issuesAfter[0]!.n).toBe(issuesBefore[0]!.n);

    const viewerSet = await refusal(() => as(viewer).merchantOps.receiptBranding.save({ ...shopBody, requestId: nid() }));
    const financeTemplate = await refusal(() => as(finance).merchantOps.receiptBranding.save({ ...shopBody, requestId: nid() }));
    const developerEmail = await refusal(() => as(developer).merchantOps.statusEmails.set({ refunded: true }));
    expect(viewerSet).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    expect(financeTemplate).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    expect(developerEmail).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    const key = await refusal(() =>
      as(owner, { kid: 'ifc_test' }).merchantOps.receiptBranding.save({ ...shopBody, requestId: nid(), footer: 'From a key' }),
    );
    expect(key).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.receipt_interactive_only' });
    const unsetPlaces = await refusal(() => as(owner).merchantOps.receiptBranding.preview({ amount: '1', assetId: 'BTC' }));
    expect(unsetPlaces).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ledger.asset_precision_unset',
      cause: 'ledger.asset_precision_unset',
    });
    const tooFine = await refusal(() => as(owner).merchantOps.receiptBranding.preview({ amount: '1.1234567', assetId: 'USDT' }));
    expect(tooFine).toMatchObject({ code: 'BAD_REQUEST', cause: 'pay.receipt_amount_exceeds_precision' });
  });
});
