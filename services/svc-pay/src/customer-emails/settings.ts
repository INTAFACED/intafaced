import type { Sql } from 'postgres';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import { automaticReceipts } from './receipt.js';

/**
 * Which customer emails a merchant sends. Each switch stays unset until they
 * choose. Nothing here is an address.
 */
export interface CustomerEmailSettings {
  readonly receipts: boolean | null;
  readonly refunds: boolean | null;
  readonly invoices: boolean | null;
  readonly updatedAt: string | null;
  readonly automaticReceipts: 'stopped' | 'not_connected';
}

export interface CustomerEmailPatch {
  readonly receipts?: boolean;
  readonly refunds?: boolean;
  readonly invoices?: boolean;
}

interface SettingsRow {
  receipts: boolean | null;
  refunds: boolean | null;
  invoices: boolean | null;
  updated_at: Date | null;
}

function view(row: SettingsRow | undefined): CustomerEmailSettings {
  const receipts = row?.receipts ?? null;
  return {
    receipts,
    refunds: row?.refunds ?? null,
    invoices: row?.invoices ?? null,
    updatedAt: row?.updated_at ? iso(row.updated_at) : null,
    automaticReceipts: automaticReceipts(receipts),
  };
}

export class CustomerEmailSettingsService {
  constructor(private readonly sql: Sql) {}

  async get(caller: MerchantCaller): Promise<CustomerEmailSettings> {
    assertPermission(caller, 'notifications.read');
    const rows = await this.sql<SettingsRow[]>`
      SELECT receipts, refunds, invoices, updated_at
        FROM pay.merchant_customer_email_settings
       WHERE merchant_id = ${caller.merchantId}`;
    return view(rows[0]);
  }

  /** Same values again keep the same updatedAt. An empty patch is refused. */
  async set(caller: MerchantCaller, patch: CustomerEmailPatch): Promise<CustomerEmailSettings> {
    assertPermission(caller, 'notifications.manage');
    const receiptsSet = patch.receipts !== undefined;
    const refundsSet = patch.refunds !== undefined;
    const invoicesSet = patch.invoices !== undefined;
    if (!receiptsSet && !refundsSet && !invoicesSet) {
      throw new MerchantOpsError('pay.customer_emails_empty', 'bad_request');
    }
    const receipts = patch.receipts ?? null;
    const refunds = patch.refunds ?? null;
    const invoices = patch.invoices ?? null;
    const rows = await this.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      return tx<SettingsRow[]>`
        INSERT INTO pay.merchant_customer_email_settings
          (merchant_id, receipts, refunds, invoices, updated_by)
        VALUES (
          ${caller.merchantId},
          ${receiptsSet ? receipts : null},
          ${refundsSet ? refunds : null},
          ${invoicesSet ? invoices : null},
          ${caller.userId}
        )
        ON CONFLICT (merchant_id) DO UPDATE SET
          receipts = CASE WHEN ${receiptsSet} THEN EXCLUDED.receipts ELSE pay.merchant_customer_email_settings.receipts END,
          refunds = CASE WHEN ${refundsSet} THEN EXCLUDED.refunds ELSE pay.merchant_customer_email_settings.refunds END,
          invoices = CASE WHEN ${invoicesSet} THEN EXCLUDED.invoices ELSE pay.merchant_customer_email_settings.invoices END,
          updated_by = CASE
            WHEN (
              (CASE WHEN ${receiptsSet} THEN EXCLUDED.receipts ELSE pay.merchant_customer_email_settings.receipts END)
                IS DISTINCT FROM pay.merchant_customer_email_settings.receipts
              OR (CASE WHEN ${refundsSet} THEN EXCLUDED.refunds ELSE pay.merchant_customer_email_settings.refunds END)
                IS DISTINCT FROM pay.merchant_customer_email_settings.refunds
              OR (CASE WHEN ${invoicesSet} THEN EXCLUDED.invoices ELSE pay.merchant_customer_email_settings.invoices END)
                IS DISTINCT FROM pay.merchant_customer_email_settings.invoices
            ) THEN EXCLUDED.updated_by
            ELSE pay.merchant_customer_email_settings.updated_by
          END,
          updated_at = CASE
            WHEN (
              (CASE WHEN ${receiptsSet} THEN EXCLUDED.receipts ELSE pay.merchant_customer_email_settings.receipts END)
                IS DISTINCT FROM pay.merchant_customer_email_settings.receipts
              OR (CASE WHEN ${refundsSet} THEN EXCLUDED.refunds ELSE pay.merchant_customer_email_settings.refunds END)
                IS DISTINCT FROM pay.merchant_customer_email_settings.refunds
              OR (CASE WHEN ${invoicesSet} THEN EXCLUDED.invoices ELSE pay.merchant_customer_email_settings.invoices END)
                IS DISTINCT FROM pay.merchant_customer_email_settings.invoices
            ) THEN now()
            ELSE pay.merchant_customer_email_settings.updated_at
          END
        RETURNING receipts, refunds, invoices, updated_at`;
    });
    const row = rows[0];
    if (!row) throw new MerchantOpsError('pay.customer_emails_unreadable', 'unavailable');
    return view(row);
  }
}
