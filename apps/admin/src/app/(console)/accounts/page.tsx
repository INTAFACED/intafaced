import { requireFounderPage } from '@/lib/founder-page';
import { AccountControls } from '@/components/account-controls';

export default async function AccountsPage() {
  const { session } = await requireFounderPage();
  return <AccountControls csrf={session.csrf} />;
}
