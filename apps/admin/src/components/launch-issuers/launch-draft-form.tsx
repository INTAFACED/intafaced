'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import {
  ALLOCATION_METHODS,
  LAUNCH_TYPES,
  PERIOD_NAMES,
  draftPayload,
  type LaunchDraftForm,
  type LaunchEventRow,
  type LaunchIssuer,
} from '@/lib/launch-issuers/model';
import '@/components/desk.css';

/**
 * A new launch draft (J-more-catalogue-14 #1). The draft is stored by svc-token and is not published: it is listed only in
 * this console until it is announced. Two founders approve exactly the fields typed here. Every figure typed is the founders'
 * own; nothing is filled in for them.
 */

const EMPTY: LaunchDraftForm = {
  id: '',
  issuerId: '',
  type: '',
  projectName: '',
  symbol: '',
  periods: ['', '', '', '', ''],
  method: '',
  perUserCap: '',
  ticketSize: '',
  price: '',
  paymentAsset: '',
  rateSource: '',
};

export function LaunchDraftDesk({
  issuers,
  drafts,
  issuersFailed,
  draftsCapped,
  userId,
}: {
  issuers: LaunchIssuer[];
  drafts: LaunchEventRow[];
  issuersFailed: string | null;
  draftsCapped: boolean;
  userId: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<LaunchDraftForm>(EMPTY);
  const set = (key: keyof LaunchDraftForm) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const setPeriod = (i: number) => (value: string) =>
    setForm((f) => ({ ...f, periods: f.periods.map((p, j) => (j === i ? value : p)) as LaunchDraftForm['periods'] }));
  const built = draftPayload(form);
  const action: ControlAction = {
    heading: 'Save this launch as a draft',
    submitLabel: 'Ask a second founder to approve this draft',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'token.launch.event.create', event: built.ok ? built.event : '' }),
  };

  return (
    <div className="dk" data-testid="launch-draft-desk">
      <div className="adm-pagehead">
        <div>
          <h1>New launch draft</h1>
          <p>A draft is stored by svc-token and stays unpublished until two founders announce it. Times are UTC.</p>
        </div>
        <Link className="adm-btn" href="/launch">
          Launch issuers
        </Link>
      </div>
      <form className="dk-stack" aria-label="New launch" onSubmit={(e) => e.preventDefault()}>
        <div className="dk-row">
          <label>
            Launch id
            <input value={form.id} onChange={(e) => set('id')(e.target.value)} />
          </label>
          <label>
            Issuer
            <select value={form.issuerId} onChange={(e) => set('issuerId')(e.target.value)}>
              <option value="">Choose</option>
              {issuers.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.state})
                </option>
              ))}
            </select>
          </label>
          <label>
            Type
            <select value={form.type} onChange={(e) => set('type')(e.target.value)}>
              <option value="">Choose</option>
              {LAUNCH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="dk-row">
          <label>
            Project name
            <input value={form.projectName} onChange={(e) => set('projectName')(e.target.value)} />
          </label>
          <label>
            Symbol
            <input value={form.symbol} onChange={(e) => set('symbol')(e.target.value)} />
          </label>
        </div>
        <div className="dk-row">
          {PERIOD_NAMES.map((name, i) => (
            <label key={name}>
              {name} (UTC)
              <input type="datetime-local" value={form.periods[i]} onChange={(e) => setPeriod(i)(e.target.value)} />
            </label>
          ))}
        </div>
        <div className="dk-row">
          <label>
            Allocation method
            <select value={form.method} onChange={(e) => set('method')(e.target.value)}>
              <option value="">Not set</option>
              {ALLOCATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cap per account (blank: not set)
            <input inputMode="decimal" value={form.perUserCap} onChange={(e) => set('perUserCap')(e.target.value)} />
          </label>
          <label>
            Ticket size (blank: not set)
            <input inputMode="decimal" value={form.ticketSize} onChange={(e) => set('ticketSize')(e.target.value)} />
          </label>
        </div>
        <div className="dk-row">
          <label>
            Price (blank: not set)
            <input inputMode="decimal" value={form.price} onChange={(e) => set('price')(e.target.value)} />
          </label>
          <label>
            Currency (blank: not set)
            <input value={form.paymentAsset} onChange={(e) => set('paymentAsset')(e.target.value)} />
          </label>
          <label>
            Rate source (blank: not set)
            <input value={form.rateSource} onChange={(e) => set('rateSource')(e.target.value)} />
          </label>
        </div>
      </form>
      <ControlDesk
        key="launch-draft"
        endpoint="/api/launch/issuers"
        userId={userId}
        blockedReason={issuersFailed}
        formHold={built.ok ? null : built.message}
        action={action}
        consequence="svc-token stores the draft once under its launch id: the same id with the same details is a retry, and the same id with other details is refused. A draft is not published and moves no money."
        blockedButtonLabel="Drafts unavailable"
        onChanged={() => router.refresh()}
      />
      <section className="dk-stack" aria-labelledby="launch-drafts-h">
        <h2 id="launch-drafts-h">Stored drafts</h2>
        {draftsCapped && (
          <p className="dk-muted" role="note">
            These are the drafts among the launches opening latest; older drafts are not listed here.
          </p>
        )}
        {drafts.length === 0 ? (
          <p className="dk-muted">No draft is stored.</p>
        ) : (
          <ul aria-label="Stored drafts">
            {drafts.map((d) => (
              <li key={d.id} data-launch={d.id}>
                {d.projectName} ({d.symbol}) <code>{d.id}</code> for {d.issuer.name}, revision {d.revision}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
