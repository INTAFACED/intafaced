import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { AccountsSideBySide } from '@/components/trade-ops/accounts-side-by-side';
import { accountsUserId, readAccounts } from '@/lib/trade-ops/accounts';

/**
 * Accounts room (J-derivatives-26 #8): one person's venue account with its ratio history beside their partner balance,
 * read-only, each with its source and as-of time. The founder names the person by user id; both reads are logged by the
 * services that answer them.
 */
export const dynamic = 'force-dynamic';

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const founder = await requireFounderPage();
  const asked = (await searchParams).userId;
  const userId = accountsUserId(asked);
  const view = userId ? await readAccounts(founder, userId) : null;
  return (
    <DeskPage
      title="Accounts"
      description="One person’s venue account and its ratio history beside their partner balance. Read-only: every figure is its source’s own, with its time. Each look is logged where the person sees it."
    >
      <AccountsSideBySide asked={typeof asked === 'string' ? asked : ''} invalid={asked !== undefined && !userId} view={view} />
    </DeskPage>
  );
}
