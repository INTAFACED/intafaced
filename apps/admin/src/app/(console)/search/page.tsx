import { CrossSearch } from '@/components/cross-search';
import '@/components/desk.css';
import { requireFounderPage } from '@/lib/founder-page';
import { searchPlan, searchQuery } from '@/lib/search/cross-search';
import { crossSearch } from '@/lib/search/server';

/**
 * The cross-desk search (`/search?q=`, OPS-payments-desk-01): one term asked of accounts, the ledger and payments as the
 * signed-in founder, each desk answering or refusing in its own section. It belongs to no single module: each section checks
 * its own module is on. A refresh is a new search; nothing is cached.
 */
export const dynamic = 'force-dynamic';

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const founder = await requireFounderPage();
  const raw = (await searchParams).q;
  const parsed = searchQuery(typeof raw === 'string' ? raw : null);
  if ('error' in parsed) {
    return (
      <div className="dk-stack" data-testid="cross-search">
        <h1>Search</h1>
        <p className="adm-callout" data-tone="warn" role="status" data-testid="cross-search-problem">
          {parsed.error}
        </p>
      </div>
    );
  }
  const answer = await crossSearch(founder, searchPlan(parsed.q));
  return <CrossSearch answer={answer} />;
}
