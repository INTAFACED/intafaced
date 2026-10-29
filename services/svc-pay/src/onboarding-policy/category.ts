import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  CATEGORY_CLASS_RAILS,
  businessCategoryTermsSchema,
  type BusinessCategory,
  type BusinessCategoryClass,
  type BusinessCategoryTerms,
  type CategoryPolicyEvent,
  type CategoryPolicyPreview,
  type CategoryPolicyPreviewInput,
  type CategoryPolicySetInput,
  type CategoryPolicyView,
  type MerchantCategoryChooseInput,
  type MerchantCategoryView,
} from '@intafaced/contracts';
import { consumePayApproval, payActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { PAY_BUSINESS_CATEGORY_CHANGE, businessCategoryChangeFields } from '../approval-bindings.js';
import { requireDualControl } from '../dual-control.js';
import { PayError } from '../payment-service/internal.js';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';

/**
 * Business categories (RC-merchant-08): the owner's versioned table of which businesses INTAFACED takes, and the one
 * category each business picks. See `packages/contracts/src/business-category.ts` for what each class means.
 *
 * TWO FOUNDERS. Every edit is proposed by one founder and approved by a different one through identity, bound to the
 * exact change (`preview` gives the hash). The approval is consumed before anything is written; a change made while it
 * was being approved refuses `pay.category_version_conflict` and writes nothing.
 *
 * BLANK REFUSES. While the table is empty a business cannot choose (`pay.business_category_policy_unset`) and is not
 * ready to go live. A restricted category with blank reserve terms keeps its businesses from taking payments
 * (`pay.reserve_terms_unset`). Nothing here invents a category, a reserve or a default class.
 */
export class CategoryPolicyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CategoryPolicyError';
  }
}

export const BUSINESS_CATEGORY_CHANGE_ACTION = PAY_BUSINESS_CATEGORY_CHANGE;

interface CategoryRow {
  key: string;
  label: string;
  class: BusinessCategoryClass;
  reserve_percent: string | null;
  reserve_hold_days: number | null;
  extra_documents: string[];
  version: number;
  updated_at: Date;
  updated_by: string;
  approved_by: string;
}

const COLUMNS = `key, label, class, reserve_percent::text AS reserve_percent, reserve_hold_days, extra_documents, version,
  updated_at, updated_by, approved_by`;

/** `5.00` and `05` read as `5`, `7.50` as `7.5`: one spelling per value, kept as text, never a float. */
function percentText(stored: string): string {
  const [whole = '', fraction = ''] = stored.split('.');
  const int = whole.replace(/^0+(?=\d)/, '');
  const frac = fraction.replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function termsOf(row: CategoryRow): BusinessCategoryTerms {
  return {
    key: row.key,
    label: row.label,
    class: row.class,
    reserve:
      row.reserve_percent === null || row.reserve_hold_days === null
        ? null
        : { percent: percentText(row.reserve_percent), holdDays: row.reserve_hold_days },
    extraDocuments: [...row.extra_documents],
  };
}

function viewOf(row: CategoryRow): BusinessCategory {
  return {
    ...termsOf(row),
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    approvedBy: row.approved_by,
  };
}

function termsFromInput(input: CategoryPolicyPreviewInput): BusinessCategoryTerms {
  return {
    key: input.key,
    label: input.label.trim(),
    class: input.class,
    reserve: input.reserve ? { percent: percentText(input.reserve.percent), holdDays: input.reserve.holdDays } : null,
    extraDocuments: input.extraDocuments.map((d) => d.trim()),
  };
}

/** One canonical string for the approval hash: key order fixed, so two founders hash the same change the same way. */
function canonicalTerms(terms: BusinessCategoryTerms): string {
  return JSON.stringify([
    terms.key,
    terms.label,
    terms.class,
    terms.reserve ? [terms.reserve.percent, terms.reserve.holdDays] : null,
    terms.extraDocuments,
  ]);
}

const sameTerms = (a: BusinessCategoryTerms, b: BusinessCategoryTerms) => canonicalTerms(a) === canonicalTerms(b);

async function tableVersion(sql: Sql): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.business_category_events`;
  return Number(row?.n ?? '0');
}

/** Every edit of the table, and every business choosing against it, takes this lock (choices share it). */
const TABLE_LOCK = 'pay:business-category-table';

export interface MerchantLookup {
  getMerchant(merchantId: string): Promise<{ id: string; kybStatus: string }>;
}

export class CategoryPolicyService {
  constructor(
    private readonly sql: Sql,
    private readonly approvals: ActionApprovalConsumer,
  ) {}

  async list(): Promise<CategoryPolicyView> {
    // One snapshot, so the rows and the version always belong together.
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx.unsafe<CategoryRow[]>(`SELECT ${COLUMNS} FROM pay.business_categories ORDER BY key`);
        return { tableVersion: await tableVersion(tx), categories: rows.map(viewOf) };
      },
      { isolation: 'repeatable read', maxAttempts: 3 },
    );
  }

  async history(key: string | undefined, limit: number): Promise<CategoryPolicyEvent[]> {
    const rows = await this.sql<
      Array<{
        seq: string;
        key: string;
        actor_id: string;
        approver_id: string;
        before: unknown;
        after: unknown;
        reason: string;
        created_at: Date;
      }>
    >`
      SELECT seq::text AS seq, key, actor_id, approver_id, before, after, reason, created_at
        FROM pay.business_category_events
       WHERE ${key === undefined ? this.sql`true` : this.sql`key = ${key}`}
       ORDER BY seq DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      seq: Number(r.seq),
      key: r.key,
      actorId: r.actor_id,
      approverId: r.approver_id,
      before: r.before === null ? null : businessCategoryTermsSchema.parse(r.before),
      after: businessCategoryTermsSchema.parse(r.after),
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** What the change needs (always a second founder) and the hash their approval must bind to. Reads only. */
  async preview(input: CategoryPolicyPreviewInput): Promise<CategoryPolicyPreview> {
    const plan = await this.plan(this.sql, input);
    return {
      needsDualControl: true,
      reasons: [plan.before === null ? 'category_added' : 'category_changed'],
      actionType: BUSINESS_CATEGORY_CHANGE_ACTION,
      payloadHash: payActionPayloadHash(BUSINESS_CATEGORY_CHANGE_ACTION, plan.hashFields),
    };
  }

  async set(actorId: string, input: CategoryPolicySetInput): Promise<BusinessCategory> {
    const plan = await this.plan(this.sql, input);
    const approver = await consumePayApproval(this.approvals, input, BUSINESS_CATEGORY_CHANGE_ACTION, plan.hashFields);
    const approverId = requireDualControl(actorId.trim().toLowerCase(), approver.trim().toLowerCase());
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${TABLE_LOCK}, 0))`;
        const again = await this.plan(tx, input);
        if ((again.before?.version ?? null) !== (plan.before?.version ?? null)) {
          throw new CategoryPolicyError(
            'The category changed while the change was being approved; reload and ask again',
            'pay.category_version_conflict',
          );
        }
        const t = plan.after;
        const [saved] =
          plan.before === null
            ? await tx.unsafe<CategoryRow[]>(
                `INSERT INTO pay.business_categories (key, label, class, reserve_percent, reserve_hold_days, extra_documents, version, updated_by, approved_by)
                 VALUES ($1, $2, $3, $4::numeric, $5, $6::text[], 1, $7, $8)
                 RETURNING ${COLUMNS}`,
                [t.key, t.label, t.class, t.reserve?.percent ?? null, t.reserve?.holdDays ?? null, t.extraDocuments, actorId, approverId],
              )
            : await tx.unsafe<CategoryRow[]>(
                `UPDATE pay.business_categories
                    SET label = $2, class = $3, reserve_percent = $4::numeric, reserve_hold_days = $5, extra_documents = $6::text[],
                        version = version + 1, updated_at = now(), updated_by = $7, approved_by = $8
                  WHERE key = $1
                 RETURNING ${COLUMNS}`,
                [t.key, t.label, t.class, t.reserve?.percent ?? null, t.reserve?.holdDays ?? null, t.extraDocuments, actorId, approverId],
              );
        if (!saved) throw new CategoryPolicyError('The category was not written', 'pay.category_not_written');
        await tx`
          INSERT INTO pay.business_category_events (key, actor_id, approver_id, before, after, reason)
          VALUES (${t.key}, ${actorId}, ${approverId}, ${plan.before ? tx.json(termsOf(plan.before)) : null}, ${tx.json(t)}, ${input.reason.trim()})
        `;
        return viewOf(saved);
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
  }

  /**
   * The table as a business reads it, and the category it chose. `locked` once a verified business has chosen: a
   * verified business with no category (approved before the table had any) may still make its first choice.
   */
  async merchantView(merchants: MerchantLookup, merchantId: string): Promise<MerchantCategoryView> {
    const merchant = await merchants.getMerchant(merchantId);
    // One snapshot, so a business never chooses from an old list against a newer version.
    const { rows, mine, version } = await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx.unsafe<CategoryRow[]>(`SELECT ${COLUMNS} FROM pay.business_categories ORDER BY label, key`);
        const [mine] = await tx<Array<{ category_key: string; table_version: string; chosen_at: Date }>>`
          SELECT category_key, table_version::text AS table_version, chosen_at FROM pay.merchant_categories WHERE merchant_id = ${merchantId}
        `;
        return { rows, mine, version: await tableVersion(tx) };
      },
      { isolation: 'repeatable read', maxAttempts: 3 },
    );
    const chosenRow = mine ? rows.find((r) => r.key === mine.category_key) : undefined;
    return {
      merchantId,
      policy: { tableVersion: version, categories: rows.map(termsOf) },
      chosen:
        mine && chosenRow
          ? { category: termsOf(chosenRow), tableVersion: Number(mine.table_version), chosenAt: mine.chosen_at.toISOString() }
          : null,
      locked: merchant.kybStatus === 'approved' && mine !== undefined,
    };
  }

  /**
   * The business picks its category, against the table version it read. The same category again changes nothing.
   * Once a verified business has chosen, only INTAFACED operations may change it (`pay.category_locked`). The
   * merchant row is locked here, so a choice and a KYB approval (which checks the choice) never cross.
   */
  async choose(merchants: MerchantLookup, actorId: string, input: MerchantCategoryChooseInput): Promise<MerchantCategoryView> {
    await transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${TABLE_LOCK}, 0))`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pay:merchant-category:${input.merchantId}`}, 0))`;
        await merchants.getMerchant(input.merchantId);
        const [merchant] = await tx<Array<{ kyb_status: string }>>`
          SELECT kyb_status::text AS kyb_status FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        const version = await tableVersion(tx);
        if (version === 0) {
          throw new CategoryPolicyError('No business categories are published yet', 'pay.business_category_policy_unset');
        }
        const [mine] = await tx<Array<{ category_key: string }>>`
          SELECT category_key FROM pay.merchant_categories WHERE merchant_id = ${input.merchantId}
        `;
        if (mine?.category_key === input.categoryKey) return;
        if (version !== input.expectedTableVersion) {
          throw new CategoryPolicyError(
            'The category table changed since you loaded it; reload and choose again',
            'pay.category_policy_changed',
          );
        }
        const [category] = await tx<Array<{ key: string }>>`SELECT key FROM pay.business_categories WHERE key = ${input.categoryKey}`;
        if (!category) throw new CategoryPolicyError('No such business category', 'pay.category_not_found');
        if (merchant?.kyb_status === 'approved' && mine) {
          throw new CategoryPolicyError(
            'The business is verified, so only INTAFACED operations can change its category',
            'pay.category_locked',
          );
        }
        await tx`
          INSERT INTO pay.merchant_categories (merchant_id, category_key, table_version, chosen_by)
          VALUES (${input.merchantId}, ${input.categoryKey}, ${version}, ${actorId})
          ON CONFLICT (merchant_id) DO UPDATE
            SET category_key = EXCLUDED.category_key, table_version = EXCLUDED.table_version,
                chosen_by = EXCLUDED.chosen_by, chosen_at = now()
        `;
        await tx`
          INSERT INTO pay.merchant_category_events (merchant_id, category_key, table_version, actor_id)
          VALUES (${input.merchantId}, ${input.categoryKey}, ${version}, ${actorId})
        `;
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
    return this.merchantView(merchants, input.merchantId);
  }

  /** Reads only. The rules a change must meet before anything is approved or written. */
  private async plan(sql: Sql, input: CategoryPolicyPreviewInput) {
    const after = termsFromInput(input);
    const [before] = await sql.unsafe<CategoryRow[]>(`SELECT ${COLUMNS} FROM pay.business_categories WHERE key = $1`, [input.key]);
    if (input.expectedVersion === null) {
      if (before) throw new CategoryPolicyError('That category exists; send its current version to edit it', 'pay.category_exists');
    } else if (!before) {
      throw new CategoryPolicyError('No such business category', 'pay.category_not_found');
    } else if (before.version !== input.expectedVersion) {
      throw new CategoryPolicyError('The category changed since you loaded it; reload and retry', 'pay.category_version_conflict');
    }
    if (before && sameTerms(termsOf(before), after)) {
      throw new CategoryPolicyError('The category already reads exactly that', 'pay.category_unchanged');
    }
    return {
      before: before ?? null,
      after,
      hashFields: businessCategoryChangeFields({
        key: input.key,
        expectedVersion: String(input.expectedVersion),
        after: canonicalTerms(after),
        reason: input.reason.trim(),
      }),
    };
  }
}

/** The rule a business's chosen category puts on its payments; null when it has chosen none. */
export async function merchantCategoryRule(
  sql: Sql,
  merchantId: string,
): Promise<{ key: string; class: BusinessCategoryClass; reserveSet: boolean } | null> {
  const [row] = await sql<Array<{ key: string; class: BusinessCategoryClass; reserve_set: boolean }>>`
    SELECT c.key, c.class, (c.reserve_percent IS NOT NULL) AS reserve_set
      FROM pay.merchant_categories mc
      JOIN pay.business_categories c ON c.key = mc.category_key
     WHERE mc.merchant_id = ${merchantId}
  `;
  return row ? { key: row.key, class: row.class, reserveSet: row.reserve_set } : null;
}

/**
 * Approving a business (KYB) once the table has categories: it must have chosen one, and not a prohibited one. Without
 * this, a business that never chose would go live with no category rule at all, and verified it could no longer choose.
 * While the table is empty the go-live checklist names `category_policy_unset` and approval is not refused here.
 */
export async function assertCategoryApprovable(sql: Sql, merchantId: string): Promise<void> {
  if ((await tableVersion(sql)) === 0) return;
  const rule = await merchantCategoryRule(sql, merchantId);
  if (!rule) throw new PayError('The business has not chosen its category, so it cannot be approved', 'pay.category_not_chosen');
  if (rule.class === 'prohibited') {
    throw new PayError(`Businesses in category ${rule.key} are not taken`, 'pay.category_prohibited', { category: rule.key });
  }
}

/** The rails a business may take payments on by its category; null when its category sets no limit (or it has none). */
export function categoryRails(rule: { class: BusinessCategoryClass } | null): readonly string[] | null {
  if (!rule || rule.class === 'prohibited') return null;
  return CATEGORY_CLASS_RAILS[rule.class];
}

/** Refuses a payment the business's category does not allow. A prohibited category takes nothing. */
export function assertCategoryAllows(
  rule: { key: string; class: BusinessCategoryClass; reserveSet: boolean } | null,
  railId: string | null,
  options: { sandboxKey?: boolean } = {},
): void {
  if (!rule) return;
  if (rule.class === 'prohibited') {
    throw new PayError(`Businesses in category ${rule.key} are not taken`, 'pay.category_prohibited', { category: rule.key });
  }
  if (rule.class === 'restricted' && !rule.reserveSet) {
    throw new PayError(`The reserve terms for category ${rule.key} are not set`, 'pay.reserve_terms_unset', { category: rule.key });
  }
  const allowed = categoryRails(rule);
  // A sandbox API key may only use sandbox rails, which move no value, so its integration tests keep working; a
  // prohibited category and blank reserve terms still refuse above.
  if (options.sandboxKey) return;
  if (allowed && (railId === null || !allowed.includes(railId))) {
    throw new PayError(`Category ${rule.key} takes payments on ${allowed.join(', ')} only`, 'pay.category_rail_refused', {
      category: rule.key,
      railId,
      allowed,
    });
  }
}

/** Go-live blockers from the category table and the business's choice. */
export async function categoryBlockers(
  sql: Sql,
  merchantId: string,
): Promise<Array<'category_policy_unset' | 'category_not_chosen' | 'category_prohibited' | 'reserve_terms_unset'>> {
  if ((await tableVersion(sql)) === 0) return ['category_policy_unset'];
  const rule = await merchantCategoryRule(sql, merchantId);
  if (!rule) return ['category_not_chosen'];
  if (rule.class === 'prohibited') return ['category_prohibited'];
  if (rule.class === 'restricted' && !rule.reserveSet) return ['reserve_terms_unset'];
  return [];
}

/**
 * Guard slot (seams/slots/rc-merchant-08-category.ts): new intake only. A payment already admitted is never refused by
 * a later category change, so an authorize or capture of it, a replay and a recovery all pass.
 */
export function createCategoryGuards(deps: { sql: Sql }): PartialPayGuards {
  return {
    async beforePaymentAdmit(ctx) {
      if (ctx.kind !== 'payment.create' || ctx.replay.kind !== 'fresh') return;
      const rail = typeof ctx.payload.railAdapter === 'string' ? ctx.payload.railAdapter : null;
      try {
        assertCategoryAllows(await merchantCategoryRule(ctx.tx ?? deps.sql, ctx.merchantId), rail, {
          sandboxKey: ctx.payload.sandbox === true,
        });
      } catch (err) {
        // The callers refuse by name before admission; this is the same rule read again inside the transaction, so
        // a category changed in between still refuses (a guard refuses only with a `pay.guard_*` code).
        if (err instanceof PayError) throw new PayGuardRefusal(`pay.guard_${err.code.slice('pay.'.length)}`, 'refused');
        throw err;
      }
    },
  };
}

/** The category rule of the business behind a payment link token; null for an unknown link or no category. */
export async function checkoutCategoryRule(
  sql: Sql,
  linkToken: string,
): Promise<{ key: string; class: BusinessCategoryClass; reserveSet: boolean } | null> {
  const tokenHash = createHash('sha256').update(linkToken).digest('hex');
  const [row] = await sql<Array<{ key: string; class: BusinessCategoryClass; reserve_set: boolean }>>`
    SELECT c.key, c.class, (c.reserve_percent IS NOT NULL) AS reserve_set
      FROM pay.payment_links l
      JOIN pay.merchant_categories mc ON mc.merchant_id = l.merchant_id
      JOIN pay.business_categories c ON c.key = mc.category_key
     WHERE l.token_hash = ${tokenHash}
  `;
  return row ? { key: row.key, class: row.class, reserveSet: row.reserve_set } : null;
}
