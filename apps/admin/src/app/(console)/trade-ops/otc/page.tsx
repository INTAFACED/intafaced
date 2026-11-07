import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { QuoteDeskRead } from '@/components/trade-ops/copy-bots-otc';
import { readQuoteDesk } from '@/lib/trade-ops/copy-bots-otc-calls';

export const dynamic = 'force-dynamic';

const ROOM = '/trade-ops/otc';
const TABS = [
  { id: 'desk', label: 'Desk operations' },
  { id: 'exceptions', label: 'Exceptions' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * The OTC desk (CB-ops-04, J-copy-bots-otc-29): the desk's quotes with their statuses, and its settlement exceptions with
 * each settle saga's key, from svc-trade's operator read (`admin.copyBotsOtc.quoteDesk`). Read only: nothing here
 * settles, retries or voids a quote. `?tab=exceptions` opens the exceptions.
 */
export default async function OtcDeskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, config } = await requireFounderPage();
  const params = await searchParams;
  const tab: Tab = params.tab === 'exceptions' ? 'exceptions' : 'desk';
  const desk = await readQuoteDesk({ session, config });
  const href = (id: Tab) => (id === 'desk' ? ROOM : `${ROOM}?tab=${id}`);
  return (
    <DeskPage
      title="OTC desk"
      description="The desk's quotes with their statuses, and settlements that missed their deadline, each with its saga key. Read only."
      asOf={desk.asOf}
      state={desk.kind === 'ok' ? 'live' : desk.kind}
      stateReason={desk.kind === 'ok' ? undefined : desk.kind === 'refused' ? desk.code : desk.message}
    >
      <div className="flex flex-col gap-6">
        <div role="tablist" aria-label="OTC desk" className="flex gap-2 border-b border-line">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={href(t.id)}
              prefetch={false}
              role="tab"
              aria-selected={tab === t.id}
              className={`px-3 py-1 text-sm ${tab === t.id ? 'border-b-2 border-fg text-fg' : 'text-fg-2'}`}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
          <QuoteDeskRead desk={desk} href={href(tab)} part={tab === 'desk' ? 'quotes' : 'exceptions'} />
        </div>
      </div>
    </DeskPage>
  );
}
