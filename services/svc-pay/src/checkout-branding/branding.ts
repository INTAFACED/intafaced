import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { CHECKOUT_LOGO_TYPES, type CheckoutBranding, type CheckoutBrandingSaveInput } from '@intafaced/contracts';
import { decodeImageUpload } from '../catalog/image-bytes.js';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import type { CheckoutLogoRule } from './logo-rules.js';

/**
 * The look of a business's hosted checkout (M-payments-core-08, J-merchant-04 step 1): a brand colour and an optional
 * logo, one row per business in `pay.checkout_branding`; no row is the default look. Every team role reads it; the
 * owner and admins (`profile.manage`) save it, from an interactive session. A save names the version it was made from,
 * so it never overwrites a newer one, and every save is logged with its request id (`pay.checkout_branding_saves`), so a
 * retried one is recognised even after later saves. Nothing here moves money.
 */

type LogoType = (typeof CHECKOUT_LOGO_TYPES)[number];

interface BrandingRow {
  brand_color: string;
  logo_type: LogoType | null;
  logo_bytes: Buffer | null;
  logo_sha256: string | null;
  version: number;
  updated_at: Date;
}

const COLOR = /^#[0-9a-f]{6}$/;

/** What the hosted page shows for a business: its saved colour and logo, or null for the default look. */
export interface CheckoutLook {
  readonly brandColor: string;
  readonly logo: { readonly contentType: LogoType; readonly dataBase64: string } | null;
}

/**
 * The look the hosted page shows, from the columns of a `pay.checkout_branding` row (all null when the business has
 * none). A stored colour that is not six lower-case hex digits is not shown: the page keeps its own colours rather than
 * write an unchecked value into its style.
 */
export function checkoutLookOf(row: {
  brand_color: string | null;
  logo_type: string | null;
  logo_bytes: Buffer | null;
}): CheckoutLook | null {
  if (row.brand_color === null || !COLOR.test(row.brand_color)) return null;
  const logo =
    row.logo_bytes && row.logo_bytes.length > 0 && (CHECKOUT_LOGO_TYPES as readonly string[]).includes(row.logo_type ?? '')
      ? { contentType: row.logo_type as LogoType, dataBase64: row.logo_bytes.toString('base64') }
      : null;
  return { brandColor: row.brand_color, logo };
}

/** A new logo checked against the owner's rule: its type from its own first bytes, which must be the one it claims. */
function decodeLogo(rule: CheckoutLogoRule, logo: { contentType: string; dataBase64: string }) {
  if (rule.maxBytes === null) throw new MerchantOpsError('pay.checkout_logo_rules_unset', 'precondition');
  return decodeImageUpload(rule.maxBytes, logo, {
    tooLarge: 'pay.checkout_logo_too_large',
    unreadable: 'pay.checkout_logo_unreadable',
    typeRefused: 'pay.checkout_logo_type_refused',
  });
}

const FIELDS = 'brand_color, logo_type, logo_bytes, logo_sha256, version, updated_at';

export class CheckoutBrandings {
  constructor(
    private readonly sql: Sql,
    private readonly rule: CheckoutLogoRule,
  ) {}

  async get(caller: MerchantCaller): Promise<CheckoutBranding> {
    assertPermission(caller, 'profile.read');
    const sql = this.sql;
    const [row] = await sql<BrandingRow[]>`
      SELECT ${sql.unsafe(FIELDS)} FROM pay.checkout_branding WHERE merchant_id = ${caller.merchantId}`;
    return this.view(row);
  }

  /**
   * Save the look. The same request id with the same details answers with the look it saved; with other details it
   * refuses `pay.request_id_reused`. A save made from an older version refuses `pay.checkout_branding_stale`.
   */
  async save(caller: MerchantCaller, input: CheckoutBrandingSaveInput): Promise<{ branding: CheckoutBranding; replayed: boolean }> {
    assertPermission(caller, 'profile.manage');
    if (!caller.interactive) throw new MerchantOpsError('pay.checkout_branding_interactive_only', 'forbidden');
    const logo = input.logo ? decodeLogo(this.rule, input.logo) : input.logo;
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          expectedVersion: input.expectedVersion,
          brandColor: input.brandColor,
          logo: logo === undefined ? 'keep' : logo === null ? 'none' : `${logo.type}:${logo.sha256}`,
        }),
      )
      .digest('hex');
    const outcome = await this.sql.begin(async (tx) => {
      // One save at a time per business: the first save has no row to lock yet.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pay.checkout_branding:${caller.merchantId}`}, 0))`;
      const read = async () => {
        const [current] = await tx<BrandingRow[]>`
          SELECT ${tx.unsafe(FIELDS)} FROM pay.checkout_branding WHERE merchant_id = ${caller.merchantId}`;
        return current;
      };
      const [earlier] = await tx<Array<{ request_hash: string }>>`
        SELECT request_hash FROM pay.checkout_branding_saves
         WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
      if (earlier) {
        if (earlier.request_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        // Already saved: the answer is the look as it is now, which may hold later saves too.
        return { row: await read(), replayed: true };
      }
      const row = await read();
      if ((row?.version ?? 0) !== input.expectedVersion) throw new MerchantOpsError('pay.checkout_branding_stale', 'conflict');
      const kept =
        logo === undefined
          ? { type: row?.logo_type ?? null, bytes: row?.logo_bytes ?? null, sha256: row?.logo_sha256 ?? null }
          : logo === null
            ? { type: null, bytes: null, sha256: null }
            : logo;
      const [saved] = row
        ? await tx<BrandingRow[]>`
            UPDATE pay.checkout_branding
               SET brand_color = ${input.brandColor}, logo_type = ${kept.type}, logo_bytes = ${kept.bytes},
                   logo_sha256 = ${kept.sha256}, version = version + 1, updated_by = ${caller.userId}, updated_at = now()
             WHERE merchant_id = ${caller.merchantId}
            RETURNING ${tx.unsafe(FIELDS)}`
        : await tx<BrandingRow[]>`
            INSERT INTO pay.checkout_branding (merchant_id, brand_color, logo_type, logo_bytes, logo_sha256, updated_by)
            VALUES (${caller.merchantId}, ${input.brandColor}, ${kept.type}, ${kept.bytes}, ${kept.sha256}, ${caller.userId})
            RETURNING ${tx.unsafe(FIELDS)}`;
      await tx`
        INSERT INTO pay.checkout_branding_saves (merchant_id, request_id, request_hash, version, saved_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${hash}, ${saved!.version}, ${caller.userId})`;
      return { row: saved, replayed: false };
    });
    return { branding: this.view(outcome.row), replayed: outcome.replayed };
  }

  private view(row: BrandingRow | undefined): CheckoutBranding {
    const rules = { logoMaxBytes: this.rule.maxBytes, logoTypes: [...CHECKOUT_LOGO_TYPES] };
    if (!row) return { rules, look: { status: 'default' } };
    return {
      rules,
      look: {
        status: 'saved',
        brandColor: row.brand_color,
        logo:
          row.logo_type && row.logo_bytes && row.logo_sha256
            ? {
                contentType: row.logo_type,
                byteSize: row.logo_bytes.length,
                sha256: row.logo_sha256,
                dataBase64: row.logo_bytes.toString('base64'),
              }
            : null,
        version: row.version,
        updatedAt: iso(row.updated_at),
      },
    };
  }
}
