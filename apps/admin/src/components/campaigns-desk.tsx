'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { Campaign, CampaignState } from '@intafaced/contracts/campaigns-catalogue';
import { Chip, type ChipTone } from '@/components/chip';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchCampaignsDesk } from '@/lib/campaigns-ops/builder-browser';
import { overviewOf, STATE_LABEL, STEP_LABEL, resumeStep, type CampaignsDeskView } from '@/lib/campaigns-ops/builder-model';
import './desk.css';

/**
 * CAMPAIGNS DESK (CM-campaign-types-01, J-campaigns-16 #1, #2, #10).
 *
 * What svc-campaigns holds, as it answered: the count in each state, the drafts with the step each resumes at, every
 * campaign and the calendar of time frames in the platform time zone. With no campaign every part says so; no figure here
 * is the console's own.
 */

export const STATE_TONE: Record<CampaignState, ChipTone> = {
  draft: 'neutral',
  pending_approval: 'warn',
  approved: 'info',
  scheduled: 'info',
  active: 'live',
  paused: 'warn',
  ended: 'neutral',
  closed: 'neutral',
  archived: 'neutral',
};

export function StateChip({ state }: { state: CampaignState }) {
  return (
    <span data-testid="campaign-state" data-state={state}>
      <Chip tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Chip>
    </span>
  );
}

export function PartFailed({ title, message, code }: { title: string; message: string; code: string | null }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-code={code ?? ''}>
      <strong>{title}</strong>
      <p>{message}</p>
      {code && <p className="dk-muted">Code: {code}</p>}
    </div>
  );
}

const builderHref = (c: Campaign) => `/more-ops/campaigns/builder?id=${encodeURIComponent(c.id)}`;

function Overview({ rows }: { rows: readonly Campaign[] }) {
  return (
    <section aria-labelledby="campaigns-overview-h" data-testid="campaigns-overview">
      <h2 id="campaigns-overview-h">Overview</h2>
      <dl className="dk-kv">
        {overviewOf(rows).map(({ label, count }) => (
          <div key={label} data-testid="campaigns-count">
            <dt>{label}</dt>
            <dd>{count === 0 ? 'None yet' : count}</dd>
          </div>
        ))}
      </dl>
      {rows.length === 0 && (
        <p className="dk-muted" data-testid="campaigns-overview-empty">
          No campaign exists yet. Start one with the builder; it stays a draft until a second founder approves it.
        </p>
      )}
    </section>
  );
}

function AllCampaigns({ rows }: { rows: readonly Campaign[] }) {
  return (
    <section aria-label="Campaigns" data-testid="campaigns-all">
      <h2>Every campaign</h2>
      {rows.length === 0 ? (
        <p className="dk-muted">No campaign yet. A draft is saved at every tab of the builder and listed here.</p>
      ) : (
        <table className="adm-table">
          <caption>Every campaign svc-campaigns holds, newest first; a draft with the tab it resumes at</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">State</th>
              <th scope="col">Resumes at</th>
              <th scope="col">Budget left of limit</th>
              <th scope="col">Revision</th>
              <th scope="col">Last saved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} data-testid="campaign-row" data-campaign-id={c.id}>
                <td>
                  {/* A full page load: the builder starts from the stored draft, and a client route change would leave the
                      router's announcement standing as a second alert beside the builder's own. */}
                  <a href={builderHref(c)}>{c.name}</a>
                </td>
                <td>{c.type}</td>
                <td>
                  <StateChip state={c.state} />
                </td>
                <td data-testid="campaign-resume-step">{c.state === 'draft' ? STEP_LABEL[resumeStep(c)] : 'Past draft'}</td>
                <td>{c.budget ? `${c.budget.left} of ${c.budget.limit} ${c.budget.asset}` : 'Not set'}</td>
                <td>{c.revision}</td>
                <td>{formatWhen(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Calendar({ view }: { view: CampaignsDeskView }) {
  const part = view.calendar;
  if (part.kind === 'failed') return <PartFailed title="Calendar unavailable" message={part.message} code={part.code} />;
  return (
    <section aria-label="Calendar of campaigns" data-testid="campaigns-calendar">
      <p className="dk-muted" data-testid="campaigns-calendar-zone">
        {part.data.timeZone
          ? `Platform time zone: ${part.data.timeZone}. Times below are UTC.`
          : 'The platform time zone is not set (owner value CAMPAIGNS_PLATFORM_TIME_ZONE): no campaign can go live until it is.'}
      </p>
      <table className="adm-table" role="grid" aria-label="Campaign calendar">
        <thead>
          <tr>
            <th scope="col">Starts</th>
            <th scope="col">Ends</th>
            <th scope="col">Name</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {part.data.entries.length === 0 ? (
            <tr>
              <td colSpan={4}>No campaign has a time frame yet.</td>
            </tr>
          ) : (
            part.data.entries.map((e) => (
              <tr key={e.id} data-testid="campaign-calendar-entry" data-campaign-id={e.id}>
                <td>{formatWhen(e.startsAt)}</td>
                <td>{formatWhen(e.endsAt)}</td>
                <td>{e.name}</td>
                <td>
                  <StateChip state={e.state} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

const DESK_TABS = ['campaigns', 'calendar'] as const;
const DESK_TAB_LABEL: Record<(typeof DESK_TABS)[number], string> = { campaigns: 'Campaigns', calendar: 'Calendar' };

export function CampaignsDeskScreen({
  view,
  loading,
  onRefresh,
}: {
  view: CampaignsDeskView | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<(typeof DESK_TABS)[number]>('campaigns');
  const rows = view && view.campaigns.kind === 'ok' ? view.campaigns.data : null;
  return (
    <div className="dk" data-testid="campaigns-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Campaigns</h1>
          <p>
            Build a campaign, send it for approval and take it live. One founder writes and asks; a different founder approves that
            revision. A budget is a limit the rewards draw on, never a balance: nothing is paid until a customer qualifies.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          data-variant="primary"
          onClick={() => window.location.assign('/more-ops/campaigns/builder')}
        >
          New campaign
        </button>
        <Link href="/more-ops/campaigns/waves">Waitlist waves</Link>
        <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `As of ${formatAsOf(view.asOf)} (when this console read svc-campaigns)` : 'No read yet'}</span>
      </div>
      {!view && <p className="dk-why">svc-campaigns could not be read. Nothing is shown rather than a guess.</p>}
      {view && view.campaigns.kind === 'failed' && (
        <PartFailed title="Campaigns unavailable" message={view.campaigns.message} code={view.campaigns.code} />
      )}
      {rows && <Overview rows={rows} />}
      <div role="tablist" aria-label="Campaigns desk" className="dk-row">
        {DESK_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="adm-btn"
            data-active={tab === t}
            onClick={() => setTab(t)}
          >
            {DESK_TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={DESK_TAB_LABEL[tab]}>
        {tab === 'campaigns' && rows && <AllCampaigns rows={rows} />}
        {tab === 'calendar' && view && <Calendar view={view} />}
      </div>
    </div>
  );
}

export function CampaignsDesk({ initial }: { initial: CampaignsDeskView | null }) {
  const [view, setView] = useState(initial);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    setView(await fetchCampaignsDesk());
    setLoading(false);
  }, []);
  return <CampaignsDeskScreen view={view} loading={loading} onRefresh={() => void reload()} />;
}
