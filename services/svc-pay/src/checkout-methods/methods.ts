import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  CHECKOUT_METHODS,
  checkoutMethodRuleSchema,
  type CheckoutMethodOffer,
  type CheckoutMethodRule,
  type CheckoutMethods,
  type CheckoutMethodsPreviewInput,
  type CheckoutMethodsSaveInput,
} from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import { compareDecimal } from '../registries/decimal.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import { PayError } from '../payment-service/internal.js';
import { connectionOf, defaultRules, METHOD_CATALOGUE, offerFor, payableMethods, type MethodRails } from './catalogue.js';

/**
 * The payment methods a business's hosted checkout offers (M-adv-payments-core-11, J-merchant-04 step 7): one row per
 * business in `pay.checkout_methods`; no row is the default. Every team role reads them and the preview; the owner and
 * admins (`profile.manage`) save them, from an interactive session. A save names the version it was made from, so it
 * never overwrites a newer one, and every save is logged with its request id (`pay.checkout_method_saves`), so a retried
 * one is recognised even after later saves. Nothing here moves money.
 */

interface MethodsRow {
  methods: unknown;
  version: number;
  updated_at: Date;
}

/**
 * The saved rules, read back strictly: each saved method once. A method the catalogue gained after the save is added at
 * the end, switched off, so a saved list keeps its order and nothing the owner did not choose is offered. A row that does
 * not read (a method the catalogue no longer has, a repeat, a bad amount) is not guessed at: the default stands in its
 * place, which offers only what the platform can take.
 */
export function savedRules(raw: unknown): CheckoutMethodRule[] | null {
  if (!Array.isArray(raw)) return null;
  const rules: CheckoutMethodRule[] = [];
  for (const item of raw) {
    const parsed = checkoutMethodRuleSchema.safeParse(item);
    if (!parsed.success) return null;
    rules.push(parsed.data);
  }
  const seen = new Set(rules.map((r) => r.method));
  if (seen.size !== rules.length || rules.length === 0) return null;
  for (const method of CHECKOUT_METHODS)
    if (!seen.has(method)) rules.push({ method, enabled: false, ruleAsset: null, minAmount: null, maxAmount: null });
  return rules;
}

/** The business's saved rules, or null when it never saved (or the row does not read). */
async function savedRulesOf(sql: Sql, merchantId: string): Promise<CheckoutMethodRule[] | null> {
  const [row] = await sql<Array<{ methods: unknown }>>`SELECT methods FROM pay.checkout_methods WHERE merchant_id = ${merchantId}`;
  return row ? savedRules(row.methods) : null;
}

/** The rules a business's checkout runs on: its saved ones, or the default. */
export async function rulesOf(sql: Sql, merchantId: string, rails: MethodRails): Promise<CheckoutMethodRule[]> {
  return (await savedRulesOf(sql, merchantId)) ?? defaultRules(rails);
}

/**
 * The method a hosted checkout opens with, from what the business offers for this payment (step 0 of
 * `openCheckoutSession`, before any row exists). The payer's choice must be one of the offered methods that can be paid;
 * with no choice, the only one is taken. More than one refuses `pay.checkout_method_required` and none refuses
 * `pay.checkout_no_method`, each with the offer so the page can show the choice or what is missing.
 *
 * The caller's method passes through unchanged, and the open goes on exactly as before methods could be set, when:
 * - the business never saved its methods and the payer named a method, or the platform has only one (the default offers
 *   what the platform can take, which routing already decides). When the business's category leaves it one of several
 *   (`rails` is already limited to the rails it allows), that one is the method. With several connected and none named, the default
 *   offer decides as a saved one does: crypto for a crypto payment and a bank transfer for a fiat one (J-merchant-04
 *   step 6), or the payer chooses;
 * - the platform has no connected method at all (the open refuses by the name of that operator gap);
 * - there is no country, no currency, or no link that can still be paid (the open refuses those by name further on).
 * A country that is not two letters, where the offer decides, refuses as a missing country.
 * Each of those refuses, if it does, before anything is written.
 */
export async function checkoutMethodFor(
  sql: Sql,
  rails: MethodRails,
  input: { linkToken: string; geoCountry?: string; assetId?: string; amount?: Amount; method?: string },
  now: Date,
): Promise<string | undefined> {
  const country = input.geoCountry?.trim().toUpperCase();
  if (!country) return input.method;
  const tokenHash = createHash('sha256').update(input.linkToken).digest('hex');
  if (rails.size === 0) return input.method;
  // A hint only, read without a lock: the open reads and locks the link again, and refuses a link that cannot be paid.
  const [link] = await sql<Array<{ merchant_id: string; amount: string | null; currency: string | null }>>`
    SELECT merchant_id, amount::text, currency FROM pay.payment_links
     WHERE token_hash = ${tokenHash} AND active
       AND (expires_at IS NULL OR expires_at >= ${now})
       AND (max_uses IS NULL OR uses < max_uses)`;
  const currency = link?.currency ?? input.assetId;
  if (!link || !currency) return input.method;
  const saved = await savedRulesOf(sql, link.merchant_id);
  if (!saved && input.method === undefined && rails.size === 1) return [...rails.keys()][0];
  if (!saved && (input.method !== undefined || rails.size < 2)) return input.method;
  const rules = saved ?? defaultRules(rails);
  // A country the offer cannot read must not skip the business's rules: routing would take it under a '*' profile.
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new PayError('Say which country you are paying from, as two letters', 'pay.routing_input_missing', { missing: ['geo'] });
  }
  const amount = link.amount ?? (input.amount !== undefined && input.amount > 0n ? formatAmount(input.amount) : undefined);
  const offer = offerFor(rules, rails, { country, currency, ...(amount ? { amount } : {}) });
  const payable = payableMethods(offer);
  if (input.method !== undefined) {
    const named = input.method.trim().toLowerCase();
    const picked = payable.find((m) => m === named);
    if (picked) return picked;
    throw new PayError('This business does not offer that payment method for this payment', 'pay.checkout_method_not_offered', { offer });
  }
  if (payable.length === 1) return payable[0];
  if (payable.length === 0) {
    throw new PayError('This business offers no payment method that can take this payment', 'pay.checkout_no_method', { offer });
  }
  throw new PayError('Choose how to pay', 'pay.checkout_method_required', { offer });
}

export class CheckoutMethodSettings {
  constructor(
    private readonly sql: Sql,
    /** The platform's connected methods, read at each call (the rails can change health, never their declaration). */
    private readonly rails: () => MethodRails,
  ) {}

  async get(caller: MerchantCaller): Promise<CheckoutMethods> {
    assertPermission(caller, 'profile.read');
    const [row] = await this.sql<MethodsRow[]>`
      SELECT methods, version, updated_at FROM pay.checkout_methods WHERE merchant_id = ${caller.merchantId}`;
    return this.view(row);
  }

  /** What a payer in that country paying that currency and amount would be offered, as the hosted page asks it. */
  async preview(caller: MerchantCaller, input: CheckoutMethodsPreviewInput): Promise<CheckoutMethodOffer> {
    assertPermission(caller, 'profile.read');
    const rails = this.rails();
    return offerFor(await rulesOf(this.sql, caller.merchantId, rails), rails, input);
  }

  /**
   * Save the methods. The same request id with the same details was made already: it answers `replayed` with the methods
   * as they are now (a later save may have changed them). With other details it refuses `pay.request_id_reused`. A save
   * made from an older version refuses `pay.checkout_methods_stale`.
   */
  async save(caller: MerchantCaller, input: CheckoutMethodsSaveInput): Promise<{ methods: CheckoutMethods; replayed: boolean }> {
    assertPermission(caller, 'profile.manage');
    if (!caller.interactive) throw new MerchantOpsError('pay.checkout_methods_interactive_only', 'forbidden');
    for (const rule of input.methods) {
      // Compared as decimals, never as numbers.
      if (rule.minAmount !== null && rule.maxAmount !== null && compareDecimal(rule.minAmount, rule.maxAmount) > 0)
        throw new MerchantOpsError('pay.checkout_method_rule_inverted', 'bad_request');
    }
    const hash = createHash('sha256')
      .update(JSON.stringify({ expectedVersion: input.expectedVersion, methods: input.methods }))
      .digest('hex');
    const outcome = await this.sql.begin(async (tx) => {
      // One save at a time per business: the first save has no row to lock yet.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pay.checkout_methods:${caller.merchantId}`}, 0))`;
      const read = async () => {
        const [current] = await tx<MethodsRow[]>`
          SELECT methods, version, updated_at FROM pay.checkout_methods WHERE merchant_id = ${caller.merchantId}`;
        return current;
      };
      const [earlier] = await tx<Array<{ request_hash: string }>>`
        SELECT request_hash FROM pay.checkout_method_saves
         WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
      if (earlier) {
        if (earlier.request_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        return { row: await read(), replayed: true };
      }
      const row = await read();
      if ((row?.version ?? 0) !== input.expectedVersion) throw new MerchantOpsError('pay.checkout_methods_stale', 'conflict');
      const methods = tx.json(input.methods as never);
      const [saved] = row
        ? await tx<MethodsRow[]>`
            UPDATE pay.checkout_methods
               SET methods = ${methods}, version = version + 1, updated_by = ${caller.userId}, updated_at = now()
             WHERE merchant_id = ${caller.merchantId}
            RETURNING methods, version, updated_at`
        : await tx<MethodsRow[]>`
            INSERT INTO pay.checkout_methods (merchant_id, methods, updated_by)
            VALUES (${caller.merchantId}, ${methods}, ${caller.userId})
            RETURNING methods, version, updated_at`;
      await tx`
        INSERT INTO pay.checkout_method_saves (merchant_id, request_id, request_hash, version, saved_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${hash}, ${saved!.version}, ${caller.userId})`;
      return { row: saved, replayed: false };
    });
    return { methods: this.view(outcome.row), replayed: outcome.replayed };
  }

  private view(row: MethodsRow | undefined): CheckoutMethods {
    const rails = this.rails();
    const rules = row ? savedRules(row.methods) : null;
    return {
      status: row && rules ? 'saved' : 'default',
      version: row?.version ?? 0,
      updatedAt: row && rules ? iso(row.updated_at) : null,
      methods: (rules ?? defaultRules(rails)).map((rule) => ({
        rule,
        connection: connectionOf(rule.method, rails),
        currencies: METHOD_CATALOGUE[rule.method].currencies,
      })),
    };
  }
}
