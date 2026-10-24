import { CategoriesView } from '@/components/merchants/categories-view';
import { loadCategoryHistory, loadCategoryPolicy } from '@/lib/merchants/categories';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

export default async function CategoriesPage() {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const [policy, history] = await Promise.all([loadCategoryPolicy(ctx), loadCategoryHistory(ctx)]);
  return <CategoriesView policy={policy} history={history} />;
}
