'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ReadBlock } from '@/components/ops-desk';
import { CUSTOMER_TABS, RECORD_SOURCE_UNWIRED, TAB_LABELS, type CustomerTab } from '@/lib/customer-record/record';
import type { ReadOutcome, ReadSpec, Unavailable } from '@/lib/ops-desk/types';
import './desk.css';

export interface CustomerRecordProps {
  readonly userId: string;
  readonly founderId: string;
  readonly tab: CustomerTab;
  readonly reads: readonly ReadSpec[];
  readonly outcomes: Readonly<Record<string, ReadOutcome>>;
  readonly unwired: readonly Unavailable[];
}

/**
 * One customer's record: a tab per area, the open tab read when the page opened. Each read answers or refuses on its own; a part
 * no service can read for one account says so with the reason. Nothing here changes the account.
 */
export function CustomerRecord({ userId, founderId, tab, reads, outcomes, unwired }: CustomerRecordProps) {
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const ctx = { userId: founderId, onChanged: () => router.refresh() };
  const base = `/accounts/${encodeURIComponent(userId)}`;
  return (
    <div className="dk-stack" data-testid="customer-record">
      <header className="dk-stack">
        <p>
          <Link href="/accounts">← Account controls</Link>
        </p>
        <h1>Customer record</h1>
        <p className="dk-muted">
          Account <code data-testid="customer-record-id">{userId}</code>. Read as you, from each service’s own operator read; nothing is
          summed or kept by this console. Restricting the account is on Account controls, with a second founder.
        </p>
      </header>
      <nav aria-label="Customer record areas">
        <ul className="dk-row" role="list">
          {CUSTOMER_TABS.map((t) => (
            <li key={t}>
              <Link
                href={t === 'money' ? base : `${base}?tab=${t}`}
                aria-current={t === tab ? 'page' : undefined}
                data-testid={`customer-tab-${t}`}
                className="dk-tab"
              >
                {TAB_LABELS[t]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className="dk-stack" aria-labelledby="h-customer-tab" data-testid={`customer-panel-${tab}`}>
        <h2 id="h-customer-tab">{TAB_LABELS[tab]}</h2>
        {reads.map((spec) => (
          <ReadBlock key={spec.id} spec={spec} outcome={outcomes[spec.id]} ctx={ctx} openKey={openKey} onOpen={setOpenKey} />
        ))}
        {unwired.map((u) => (
          <article key={u.id} className="adm-callout" data-tone="warn" data-testid={`unwired-${u.id}`} data-state="unwired">
            <strong>{u.label}: no source</strong>
            <p>{u.reason}</p>
            <p className="dk-muted">Code: {RECORD_SOURCE_UNWIRED}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
