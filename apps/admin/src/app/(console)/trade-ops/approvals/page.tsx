import { PageSection } from '@intafaced/ui';
import { requireFounderPage } from '@/lib/founder-page';
import { readRestrictionHistory, readRestrictionState } from '@/lib/trade-ops/approvals-calls';
import { validateUserId } from '@/lib/trade-ops/restrictions';
import { ApprovalsAccount } from '@/components/trade-ops/approvals-account';
import { ApprovalsExplainer } from '@/components/trade-ops/approvals-explainer';
import { ApprovalsLookup } from '@/components/trade-ops/approvals-lookup';
import { ApprovalsPropose } from '@/components/trade-ops/approvals-propose';
import { ApprovalsQueue } from '@/components/trade-ops/approvals-queue';
import { DeskPage } from '@/components/trade-ops/desk-page';

export const dynamic = 'force-dynamic';

/**
 * Freezes & approvals: look up one account's trading restriction and history, ask for a change, and get a second
 * person to approve it. The account is chosen with ?user=<uuid>, so the result is read fresh on the server.
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ user?: string | string[] }> }) {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const raw = (await searchParams).user;
  const typed = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  const parsed = typed ? validateUserId(typed) : null;
  const userId = parsed?.ok ? parsed.value : '';
  const [state, history] = userId
    ? await Promise.all([readRestrictionState(ctx, userId), readRestrictionHistory(ctx, userId, 100)])
    : [null, null];

  const worst = [state, history].filter((o) => o !== null);
  const bad = worst.find((o) => o.kind !== 'ok');
  const pageState = worst.length === 0 ? undefined : bad ? (bad.kind === 'unknown' ? 'unknown' : 'refused') : 'live';
  const asOf = state?.asOf ?? null;
  const version = state?.kind === 'ok' && state.data.state ? state.data.state.version : null;
  const restricted = state?.kind === 'ok' && state.data.state ? state.data.state.restricted : null;

  return (
    <DeskPage
      title="Freezes & approvals"
      description="Restrict or restore one account's trading, with a second operator's approval."
      asOf={asOf}
      state={pageState}
      stateReason={bad && bad.kind === 'refused' ? bad.code : bad?.kind === 'unknown' ? bad.message : undefined}
    >
      <PageSection title="Three different freezes">
        <ApprovalsExplainer />
      </PageSection>
      <PageSection title="Account lookup">
        <div className="flex flex-col gap-4">
          <ApprovalsLookup userId={userId || typed} error={parsed && !parsed.ok ? parsed.message : undefined} />
          {state && history ? <ApprovalsAccount userId={userId} state={state} history={history} /> : null}
        </div>
      </PageSection>
      <div className="grid gap-6 xl:grid-cols-2">
        <PageSection title="Ask for a change">
          <ApprovalsPropose sessionUserId={session.userId} userId={userId} version={version} restricted={restricted} />
        </PageSection>
        <PageSection title="Approval queue">
          <ApprovalsQueue sessionUserId={session.userId} />
        </PageSection>
      </div>
    </DeskPage>
  );
}
