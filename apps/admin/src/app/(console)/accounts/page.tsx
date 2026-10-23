import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AccountControls } from '@/components/account-controls';
import { AccountSearch } from '@/components/account-search';
import { CustomerRecordFinder } from '@/components/customer-record-finder';

export default async function AccountsPage() {
  requireModulePage('accounts');
  const { session } = await requireFounderPage();
  return (
    <>
      <AccountSearch />
      <CustomerRecordFinder />
      <AccountControls csrf={session.csrf} founderId={session.userId} />
    </>
  );
}
