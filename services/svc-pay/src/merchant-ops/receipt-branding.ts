import { createHash } from 'node:crypto';
import { ASSET_AMOUNT_EXCEEDS_PRECISION, toAssetUnits } from '@intafaced/contracts';
import { formatMoney, locale } from '@intafaced/i18n';
import type { Sql, TransactionSql } from 'postgres';

type Db = Sql | TransactionSql;
import { resolvePayerCopy, PAYER_COPY_KEYS } from '../payer-copy.js';
import { MerchantOpsError } from './errors.js';
import { iso } from './money.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Receipt branding and payment status emails (M-adv-payments-core-07).
 *
 * Template rows are append-only. A merchant with none uses the ops default.
 * Preview formats the caller's amount at the asset registry's published places.
 * A blank place count refuses `ledger.asset_precision_unset`. Status email that
 * is off queues nothing. Status email that is on refuses `vendor.email` and
 * still queues nothing: this file never inserts into pay.payment_status_email_queue.
 */

export const STATUS_EMAIL_KINDS = ['succeeded', 'failed', 'refunded'] as const;
export type StatusEmailKind = (typeof STATUS_EMAIL_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StatusEmailNotConnected extends Error {
  readonly code = 'vendor.email' as const;
  readonly blockers = [{ code: 'vendor.email' }] as const;
  constructor() {
    super('vendor.email');
    this.name = 'StatusEmailNotConnected';
  }
}

export class ReceiptPrecisionUnset extends Error {
  readonly code = 'ledger.asset_precision_unset' as const;
  constructor() {
    super('ledger.asset_precision_unset');
    this.name = 'ReceiptPrecisionUnset';
  }
}

export class ReceiptPrecisionInvalid extends Error {
  readonly code = 'ledger.asset_precision_invalid' as const;
  constructor() {
    super('ledger.asset_precision_invalid');
    this.name = 'ReceiptPrecisionInvalid';
  }
}

/** Published decimal places for one asset. Null means the registry has not set them. */
export type ReceiptAssetPlaces = (assetId: string) => number | null | Promise<number | null>;

export interface ReceiptTemplateInput {
  readonly requestId: string;
  readonly logoRef: string | null;
  readonly accent: string | null;
  readonly footer: string;
  readonly language: string;
}

export interface ReceiptTemplateBody {
  readonly logoRef: string | null;
  readonly accent: string | null;
  readonly footer: string;
  readonly language: string;
}

export interface ReceiptTemplateView {
  readonly source: 'merchant' | 'ops_default' | 'unset';
  readonly versionId: string | null;
  readonly version: number | null;
  readonly logoRef: string | null;
  readonly accent: string | null;
  readonly footer: string | null;
  readonly language: string | null;
  readonly createdAt: string | null;
}

export interface ReceiptTemplateSave extends Omit<ReceiptTemplateView, 'source' | 'versionId' | 'version' | 'footer' | 'language'> {
  readonly source: 'merchant' | 'ops_default';
  readonly versionId: string;
  readonly version: number;
  readonly footer: string;
  readonly language: string;
  /** True when this call did not append a version (same request, or the same body). */
  readonly replayed: boolean;
}

export interface ReceiptBrandingPreview {
  readonly source: 'merchant' | 'ops_default';
  readonly versionId: string;
  readonly version: number;
  readonly logoRef: string | null;
  readonly accent: string | null;
  readonly footer: string;
  readonly language: string;
  readonly amountLabel: string;
  readonly amount: string;
  readonly places: number;
  readonly assetId: string;
}

export interface StatusEmailSettings {
  readonly succeeded: boolean | null;
  readonly failed: boolean | null;
  readonly refunded: boolean | null;
  readonly updatedAt: string | null;
}

export interface StatusEmailPatch {
  readonly succeeded?: boolean;
  readonly failed?: boolean;
  readonly refunded?: boolean;
}

interface VersionRow {
  id: string;
  version: number;
  logo_ref: string | null;
  accent: string | null;
  footer: string;
  language: string;
  body_hash: string;
  created_at: Date;
  merchant_id: string | null;
}

function assertRequestId(requestId: string): void {
  if (!UUID.test(requestId)) throw new MerchantOpsError('pay.receipt_request_invalid', 'bad_request');
}

function assertInteractive(caller: MerchantCaller): void {
  if (!caller.interactive) throw new MerchantOpsError('pay.receipt_interactive_only', 'forbidden');
}

export function assertReceiptAssetId(assetId: string): string {
  const id = assetId.trim();
  if (!/^[A-Z0-9]{1,16}$/.test(id)) throw new MerchantOpsError('pay.receipt_asset_invalid', 'bad_request');
  return id;
}

function canonicalAccent(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '') throw new MerchantOpsError('pay.receipt_accent_invalid', 'bad_request');
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text);
  if (hex) {
    const body = hex[1]!;
    const full = body.length === 3 ? [...body].map((c) => c + c).join('') : body;
    return `#${full.toUpperCase()}`;
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text);
  if (!rgb) throw new MerchantOpsError('pay.receipt_accent_invalid', 'bad_request');
  const channels = [rgb[1], rgb[2], rgb[3]].map((part) => {
    const value = Number(part);
    if (value > 255) throw new MerchantOpsError('pay.receipt_accent_invalid', 'bad_request');
    return value.toString(16).padStart(2, '0').toUpperCase();
  });
  return `#${channels.join('')}`;
}

function canonicalLogo(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '' || text.includes('://') || text.includes('..') || /\s/.test(text) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw new MerchantOpsError('pay.receipt_logo_invalid', 'bad_request');
  }
  return text;
}

function canonicalFooter(raw: string): string {
  const text = raw.trim();
  if (text.length > 500 || text.includes('\0')) throw new MerchantOpsError('pay.receipt_footer_invalid', 'bad_request');
  return text;
}

function canonicalLanguage(raw: string): string {
  const found = locale(raw.trim());
  if (!found) throw new MerchantOpsError('pay.receipt_language_invalid', 'bad_request');
  return found.code;
}

/** One stored snapshot. A blank accent or logo is stored as none, not a default. */
export function normalizeReceiptTemplate(input: ReceiptTemplateInput): ReceiptTemplateBody {
  return {
    logoRef: canonicalLogo(input.logoRef),
    accent: canonicalAccent(input.accent),
    footer: canonicalFooter(input.footer),
    language: canonicalLanguage(input.language),
  };
}

function bodyHash(body: ReceiptTemplateBody): string {
  const canonical = JSON.stringify({
    accent: body.accent,
    footer: body.footer,
    language: body.language,
    logoRef: body.logoRef,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function assertPlaces(places: number): void {
  if (!Number.isInteger(places) || places < 0 || places > 18) throw new ReceiptPrecisionInvalid();
}

/**
 * Format `amount` with every published place for `localeCode`. Extra non-zero
 * places refuse; they are not rounded.
 */
export function formatReceiptAmount(amount: string, places: number, localeCode: string, assetId: string): string {
  assertPlaces(places);
  const asset = assertReceiptAssetId(assetId);
  const text = amount.trim();
  const parsed = toAssetUnits(text, places);
  if (!parsed.ok) {
    if (parsed.code === ASSET_AMOUNT_EXCEEDS_PRECISION) {
      throw new MerchantOpsError('pay.receipt_amount_exceeds_precision', 'bad_request');
    }
    throw new MerchantOpsError('pay.receipt_amount_invalid', 'bad_request');
  }
  return formatMoney(text, asset, localeCode, {
    minFractionDigits: places,
    maxFractionDigits: places,
    display: 'code',
  });
}

function unsetView(): ReceiptTemplateView {
  return {
    source: 'unset',
    versionId: null,
    version: null,
    logoRef: null,
    accent: null,
    footer: null,
    language: null,
    createdAt: null,
  };
}

function viewOf(row: VersionRow, source: 'merchant' | 'ops_default'): ReceiptTemplateView {
  return {
    source,
    versionId: row.id,
    version: row.version,
    logoRef: row.logo_ref,
    accent: row.accent,
    footer: row.footer,
    language: row.language,
    createdAt: iso(row.created_at),
  };
}

function saveOf(row: VersionRow, source: 'merchant' | 'ops_default', replayed: boolean): ReceiptTemplateSave {
  const view = viewOf(row, source);
  return {
    source,
    versionId: view.versionId!,
    version: view.version!,
    logoRef: view.logoRef,
    accent: view.accent,
    footer: view.footer!,
    language: view.language!,
    createdAt: view.createdAt,
    replayed,
  };
}

export class ReceiptBrandingService {
  constructor(
    private readonly sql: Sql,
    private readonly placesOf: ReceiptAssetPlaces | null,
  ) {}

  async getForMerchant(caller: MerchantCaller): Promise<ReceiptTemplateView> {
    assertPermission(caller, 'profile.read');
    const resolved = await this.resolve(caller.merchantId);
    return resolved ? viewOf(resolved.row, resolved.source) : unsetView();
  }

  async saveForMerchant(caller: MerchantCaller, input: ReceiptTemplateInput): Promise<ReceiptTemplateSave> {
    assertPermission(caller, 'profile.manage');
    assertInteractive(caller);
    return this.save(caller.merchantId, caller.userId, input, 'merchant');
  }

  async getOpsDefault(): Promise<ReceiptTemplateView> {
    const row = await this.latest(this.sql, null);
    return row ? viewOf(row, 'ops_default') : unsetView();
  }

  async saveOpsDefault(actorId: string, input: ReceiptTemplateInput): Promise<ReceiptTemplateSave> {
    if (actorId.trim() === '') throw new MerchantOpsError('pay.founder_authority_missing', 'forbidden');
    return this.save(null, actorId, input, 'ops_default');
  }

  async preview(caller: MerchantCaller, input: { amount: string; assetId: string }): Promise<ReceiptBrandingPreview> {
    assertPermission(caller, 'profile.read');
    const resolved = await this.resolve(caller.merchantId);
    if (!resolved || resolved.row.language === null) throw new MerchantOpsError('pay.receipt_template_unset', 'precondition');
    const assetId = assertReceiptAssetId(input.assetId);
    const places = await this.places(assetId);
    const row = resolved.row;
    return {
      source: resolved.source,
      versionId: row.id,
      version: row.version,
      logoRef: row.logo_ref,
      accent: row.accent,
      footer: row.footer,
      language: row.language,
      amountLabel: resolvePayerCopy(PAYER_COPY_KEYS.amount, {}, row.language),
      amount: formatReceiptAmount(input.amount, places, row.language, assetId),
      places,
      assetId,
    };
  }

  /**
   * Pin the template a receipt is issued with. Not called while email delivery
   * refuses `vendor.email`. A retry of `requestId` returns the first pin.
   */
  async pinIssuedReceipt(
    caller: MerchantCaller,
    requestId: string,
  ): Promise<{ issueId: string; templateVersionId: string; replayed: boolean }> {
    assertPermission(caller, 'profile.manage');
    assertInteractive(caller);
    assertRequestId(requestId);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`receipt-issue:${caller.merchantId}`}, 0))`;
      const prior = await tx<Array<{ id: string; template_version_id: string }>>`
        SELECT id, template_version_id FROM pay.receipt_issues
         WHERE merchant_id = ${caller.merchantId} AND request_id = ${requestId}::uuid`;
      if (prior[0]) return { issueId: prior[0].id, templateVersionId: prior[0].template_version_id, replayed: true };
      const resolved = await this.resolve(caller.merchantId, tx);
      if (!resolved) throw new MerchantOpsError('pay.receipt_template_unset', 'precondition');
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO pay.receipt_issues (merchant_id, request_id, template_version_id, actor_id)
        VALUES (${caller.merchantId}, ${requestId}::uuid, ${resolved.row.id}, ${caller.userId})
        RETURNING id`;
      const issue = rows[0];
      if (!issue) throw new MerchantOpsError('pay.receipt_template_unreadable', 'unavailable');
      return { issueId: issue.id, templateVersionId: resolved.row.id, replayed: false };
    });
  }

  async statusGet(caller: MerchantCaller): Promise<StatusEmailSettings> {
    assertPermission(caller, 'notifications.read');
    const rows = await this.sql<
      Array<{ succeeded: boolean | null; failed: boolean | null; refunded: boolean | null; updated_at: Date | null }>
    >`
      SELECT succeeded, failed, refunded, updated_at
        FROM pay.merchant_status_email_settings
       WHERE merchant_id = ${caller.merchantId}`;
    return statusView(rows[0]);
  }

  async statusSet(caller: MerchantCaller, patch: StatusEmailPatch): Promise<StatusEmailSettings> {
    assertPermission(caller, 'notifications.manage');
    assertInteractive(caller);
    const succeededSet = patch.succeeded !== undefined;
    const failedSet = patch.failed !== undefined;
    const refundedSet = patch.refunded !== undefined;
    if (!succeededSet && !failedSet && !refundedSet) throw new MerchantOpsError('pay.status_email_empty', 'bad_request');
    const rows = await this.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      return tx<Array<{ succeeded: boolean | null; failed: boolean | null; refunded: boolean | null; updated_at: Date }>>`
        INSERT INTO pay.merchant_status_email_settings
          (merchant_id, succeeded, failed, refunded, updated_by)
        VALUES (
          ${caller.merchantId},
          ${succeededSet ? patch.succeeded! : null},
          ${failedSet ? patch.failed! : null},
          ${refundedSet ? patch.refunded! : null},
          ${caller.userId}
        )
        ON CONFLICT (merchant_id) DO UPDATE SET
          succeeded = CASE WHEN ${succeededSet} THEN EXCLUDED.succeeded ELSE pay.merchant_status_email_settings.succeeded END,
          failed = CASE WHEN ${failedSet} THEN EXCLUDED.failed ELSE pay.merchant_status_email_settings.failed END,
          refunded = CASE WHEN ${refundedSet} THEN EXCLUDED.refunded ELSE pay.merchant_status_email_settings.refunded END,
          updated_by = CASE
            WHEN (
              (CASE WHEN ${succeededSet} THEN EXCLUDED.succeeded ELSE pay.merchant_status_email_settings.succeeded END)
                IS DISTINCT FROM pay.merchant_status_email_settings.succeeded
              OR (CASE WHEN ${failedSet} THEN EXCLUDED.failed ELSE pay.merchant_status_email_settings.failed END)
                IS DISTINCT FROM pay.merchant_status_email_settings.failed
              OR (CASE WHEN ${refundedSet} THEN EXCLUDED.refunded ELSE pay.merchant_status_email_settings.refunded END)
                IS DISTINCT FROM pay.merchant_status_email_settings.refunded
            ) THEN EXCLUDED.updated_by
            ELSE pay.merchant_status_email_settings.updated_by
          END,
          updated_at = CASE
            WHEN (
              (CASE WHEN ${succeededSet} THEN EXCLUDED.succeeded ELSE pay.merchant_status_email_settings.succeeded END)
                IS DISTINCT FROM pay.merchant_status_email_settings.succeeded
              OR (CASE WHEN ${failedSet} THEN EXCLUDED.failed ELSE pay.merchant_status_email_settings.failed END)
                IS DISTINCT FROM pay.merchant_status_email_settings.failed
              OR (CASE WHEN ${refundedSet} THEN EXCLUDED.refunded ELSE pay.merchant_status_email_settings.refunded END)
                IS DISTINCT FROM pay.merchant_status_email_settings.refunded
            ) THEN now()
            ELSE pay.merchant_status_email_settings.updated_at
          END
        RETURNING succeeded, failed, refunded, updated_at`;
    });
    const row = rows[0];
    if (!row) throw new MerchantOpsError('pay.status_email_unreadable', 'unavailable');
    return statusView(row);
  }

  /**
   * Send test. Off or unset returns `{ queued: false }` and writes nothing.
   * On refuses `vendor.email` before any queue or issue row.
   */
  async sendTest(caller: MerchantCaller, kind: StatusEmailKind): Promise<{ queued: false }> {
    assertPermission(caller, 'notifications.manage');
    assertInteractive(caller);
    if (!STATUS_EMAIL_KINDS.includes(kind)) throw new MerchantOpsError('pay.status_email_kind_invalid', 'bad_request');
    const settings = await this.statusGet(caller);
    const on = settings[kind] === true;
    if (!on) return { queued: false };
    throw new StatusEmailNotConnected();
  }

  private async places(assetId: string): Promise<number> {
    if (!this.placesOf) throw new ReceiptPrecisionUnset();
    let places: number | null;
    try {
      places = await this.placesOf(assetId);
    } catch {
      throw new MerchantOpsError('pay.receipt_precision_unavailable', 'unavailable');
    }
    if (places === null) throw new ReceiptPrecisionUnset();
    assertPlaces(places);
    return places;
  }

  private async resolve(merchantId: string, db: Db = this.sql): Promise<{ row: VersionRow; source: 'merchant' | 'ops_default' } | null> {
    const own = await this.latest(db, merchantId);
    if (own) return { row: own, source: 'merchant' };
    const ops = await this.latest(db, null);
    if (ops) return { row: ops, source: 'ops_default' };
    return null;
  }

  private async latest(db: Db, merchantId: string | null): Promise<VersionRow | undefined> {
    const sql = this.sql;
    const rows = await db<VersionRow[]>`
      SELECT id, version, logo_ref, accent, footer, language, body_hash, created_at, merchant_id
        FROM pay.receipt_template_versions
       WHERE ${merchantId === null ? sql`merchant_id IS NULL` : sql`merchant_id = ${merchantId}`}
       ORDER BY version DESC
       LIMIT 1`;
    return rows[0];
  }

  private async save(
    merchantId: string | null,
    actorId: string,
    input: ReceiptTemplateInput,
    source: 'merchant' | 'ops_default',
  ): Promise<ReceiptTemplateSave> {
    assertRequestId(input.requestId);
    const body = normalizeReceiptTemplate(input);
    const hash = bodyHash(body);
    const lock = `receipt-template:${merchantId ?? 'ops'}`;
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      if (merchantId !== null) {
        const owned = await tx<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE`;
        if (!owned[0]) throw new MerchantOpsError('pay.merchant_not_found', 'not_found');
      }
      const sql = this.sql;
      const prior = await tx<Array<{ version_id: string; body_hash: string }>>`
        SELECT version_id, body_hash FROM pay.receipt_template_requests
         WHERE request_id = ${input.requestId}::uuid
           AND ${merchantId === null ? sql`merchant_id IS NULL` : sql`merchant_id = ${merchantId}`}`;
      if (prior[0]) {
        if (prior[0].body_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        const stored = await this.versionInScope(tx, prior[0].version_id, merchantId);
        return saveOf(stored, source, true);
      }
      const latest = await this.latest(tx, merchantId);
      if (latest && latest.body_hash === hash) {
        await this.insertRequest(tx, merchantId, input.requestId, hash, latest.id, actorId);
        return saveOf(latest, source, true);
      }
      const version = (latest?.version ?? 0) + 1;
      const inserted = await tx<VersionRow[]>`
        INSERT INTO pay.receipt_template_versions
          (merchant_id, version, logo_ref, accent, footer, language, body_hash, actor_id)
        VALUES (
          ${merchantId}, ${version}, ${body.logoRef}, ${body.accent}, ${body.footer}, ${body.language}, ${hash}, ${actorId}
        )
        RETURNING id, version, logo_ref, accent, footer, language, body_hash, created_at, merchant_id`;
      const row = inserted[0];
      if (!row) throw new MerchantOpsError('pay.receipt_template_unreadable', 'unavailable');
      await this.insertRequest(tx, merchantId, input.requestId, hash, row.id, actorId);
      return saveOf(row, source, false);
    });
  }

  private async versionInScope(db: Db, versionId: string, merchantId: string | null): Promise<VersionRow> {
    const sql = this.sql;
    const rows = await db<VersionRow[]>`
      SELECT id, version, logo_ref, accent, footer, language, body_hash, created_at, merchant_id
        FROM pay.receipt_template_versions
       WHERE id = ${versionId}
         AND ${merchantId === null ? sql`merchant_id IS NULL` : sql`merchant_id = ${merchantId}`}`;
    const row = rows[0];
    if (!row) throw new MerchantOpsError('pay.receipt_template_unreadable', 'unavailable');
    return row;
  }

  private async insertRequest(
    db: Db,
    merchantId: string | null,
    requestId: string,
    hash: string,
    versionId: string,
    actorId: string,
  ): Promise<void> {
    await db`
      INSERT INTO pay.receipt_template_requests (merchant_id, request_id, body_hash, version_id, actor_id)
      VALUES (${merchantId}, ${requestId}::uuid, ${hash}, ${versionId}, ${actorId})`;
  }
}

function statusView(
  row: { succeeded: boolean | null; failed: boolean | null; refunded: boolean | null; updated_at: Date | null } | undefined,
): StatusEmailSettings {
  return {
    succeeded: row?.succeeded ?? null,
    failed: row?.failed ?? null,
    refunded: row?.refunded ?? null,
    updatedAt: row?.updated_at ? iso(row.updated_at) : null,
  };
}
