import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AccountControls } from '@/components/account-controls';
import { AccountSearch } from '@/components/account-search';
import { CustomerRecordFinder } from '@/components/customer-record-finder';

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('accounts');
  const { session } = await requireFounderPage();
  const q = (await searchParams).q;
  return (
    <>
      <AccountSearch key={typeof q === 'string' ? q : ''} initialQuery={typeof q === 'string' ? q : null} />
      <CustomerRecordFinder />
      <AccountControls csrf={session.csrf} founderId={session.userId} />
    </>
  );
}
