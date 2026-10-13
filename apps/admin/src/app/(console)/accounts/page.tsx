import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AccountControls } from '@/components/account-controls';

export default async function AccountsPage() {
  requireModulePage('accounts');
  const { session } = await requireFounderPage();
  return <AccountControls csrf={session.csrf} />;
}
