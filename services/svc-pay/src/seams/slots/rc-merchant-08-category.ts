import type { Sql } from 'postgres';
import { createCategoryGuards } from '../../onboarding-policy/category.js';
import type { PartialPayGuards } from '../guards.js';

/**
 * Guard slot for RC-merchant-08 business categories.
 *
 * New intake only: a business whose category is prohibited opens no payment and no checkout session
 * (`pay.category_prohibited`); a restricted one with blank reserve terms takes nothing (`pay.reserve_terms_unset`);
 * a standard one takes every rail; a permissionless one takes crypto-native only and a restricted one no card rail
 * (`CATEGORY_CLASS_RAILS`; a rail its list does not name refuses `pay.category_rail_refused`).
 * A business that has chosen no category is not refused here: its go-live checklist says so.
 */
export function createRcMerchant08CategoryGuards(deps: { sql: Sql }): PartialPayGuards {
  return createCategoryGuards(deps);
}
