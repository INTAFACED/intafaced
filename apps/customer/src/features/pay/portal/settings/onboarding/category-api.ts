import { merchantCategoryViewSchema, type MerchantCategoryView } from '@intafaced/contracts/business-category';
import type { PortalTools } from '../../api-tools';
import './category-refusals';

// The business category (J-merchant-02 step 7, RC-merchant-08): svc-pay `merchant.category.get` and
// `merchant.category.choose`, parsed with the service's own schema.

export type CategoryView = MerchantCategoryView;
export type CategoryTerms = CategoryView['policy']['categories'][number];

/** The business is the page's resolved one; the service checks again who may read it and that only the owner chooses. */
export const categoryApi = ({ query, mutate }: PortalTools) => ({
  merchantCategory: (merchantId: string, signal?: AbortSignal) =>
    query('merchant.category.get', { merchantId }, merchantCategoryViewSchema, signal),
  merchantCategoryChoose: (merchantId: string, categoryKey: string, expectedTableVersion: number) =>
    mutate('merchant.category.choose', { merchantId, categoryKey, expectedTableVersion }, merchantCategoryViewSchema),
});
