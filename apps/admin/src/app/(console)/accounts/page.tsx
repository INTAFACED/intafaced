import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AccountControls } from '@/components/account-controls';
import { CustomerRecordFinder } from '@/components/customer-record-finder';

export default async function AccountsPage() {
  requireModulePage('accounts');
  const { session } = await requireFounderPage();
  return (
    <>
      <CustomerRecordFinder />
      <AccountControls csrf={session.csrf} />
    </>
  );
}
