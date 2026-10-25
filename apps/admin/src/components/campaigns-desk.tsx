'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { Campaign, CampaignState } from '@intafaced/contracts/campaigns-catalogue';
import { Chip, type ChipTone } from '@/components/chip';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchCampaignsDesk } from '@/lib/campaigns-ops/builder-browser';
import { countsByState, STATE_LABEL, STEP_LABEL, resumeStep, type CampaignDeskReply, type CampaignsDeskView } from '@/lib/campaigns-ops/builder-model';
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

/** The answer to the last change: the service's own sentence and code on a refusal. */
export function CampaignOutcome({ reply }: { reply: CampaignDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="campaign-outcome" data-code="">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="campaign-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
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
  const counts = countsByState(rows);
  return (
    <section aria-labelledby="campaigns-overview-h" data-testid="campaigns-overview">
      <h2 id="campaigns-overview-h">Overview</h2>
      {counts.length === 0 ? (
        <p className="dk-muted" data-testid="campaigns-overview-empty">
          No campaign exists yet. Start one with the builder; it stays a draft until a second founder approves it.
        </p>
      ) : (
        <dl className="dk-kv">
          {counts.map(({ state, count }) => (
            <div key={state} data-testid="campaigns-count" data-state={state}>
              <dt>{STATE_LABEL[state]}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Drafts({ rows }: { rows: readonly Campaign[] }) {
  const drafts = rows.filter((r) => r.state === 'draft');
  return (
    <section aria-labelledby="campaigns-drafts-h" data-testid="campaigns-drafts">
      <h2 id="campaigns-drafts-h">Drafts</h2>
      {drafts.length === 0 ? (
        <p className="dk-muted">No draft. A draft is saved at every step of the builder and listed here until it is sent for approval.</p>
      ) : (
        <table className="adm-table">
          <caption>Drafts, newest first, with the step each one resumes at</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Resumes at</th>
              <th scope="col">Revision</th>
              <th scope="col">Last saved</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((c) => (
              <tr key={c.id} data-testid="campaign-draft" data-campaign-id={c.id}>
                <td>
                  <Link href={builderHref(c)}>{c.name}</Link>
                </td>
                <td>{c.type}</td>
                <td data-testid="campaign-resume-step">{STEP_LABEL[resumeStep(c)]}</td>
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

function AllCampaigns({ rows }: { rows: readonly Campaign[] }) {
  return (
    <section aria-labelledby="campaigns-all-h" data-testid="campaigns-all">
      <h2 id="campaigns-all-h">Every campaign</h2>
      {rows.length === 0 ? (
        <p className="dk-muted">No campaign yet.</p>
      ) : (
        <table className="adm-table">
          <caption>Every campaign svc-campaigns holds, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">State</th>
              <th scope="col">Budget left of limit</th>
              <th scope="col">Revision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} data-testid="campaign-row" data-campaign-id={c.id}>
                <td>
                  <Link href={builderHref(c)}>{c.name}</Link>
                </td>
                <td>{c.type}</td>
                <td>
                  <StateChip state={c.state} />
                </td>
                <td>{c.budget ? `${c.budget.left} of ${c.budget.limit} ${c.budget.asset}` : 'Not set'}</td>
                <td>{c.revision}</td>
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
  return (
    <section aria-labelledby="campaigns-calendar-h" data-testid="campaigns-calendar">
      <h2 id="campaigns-calendar-h">Calendar</h2>
      {part.kind === 'failed' ? (
        <PartFailed title="Calendar unavailable" message={part.message} code={part.code} />
      ) : (
        <>
          <p className="dk-muted" data-testid="campaigns-calendar-zone">
            {part.data.timeZone
              ? `Platform time zone: ${part.data.timeZone}. Times below are UTC.`
              : 'The platform time zone is not set (owner value CAMPAIGNS_PLATFORM_TIME_ZONE): no campaign can go live until it is.'}
          </p>
          {part.data.entries.length === 0 ? (
            <p className="dk-muted">No campaign has a time frame yet.</p>
          ) : (
            <table className="adm-table">
              <caption>Every campaign with a time frame, by start</caption>
              <thead>
                <tr>
                  <th scope="col">Starts</th>
                  <th scope="col">Ends</th>
                  <th scope="col">Name</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {part.data.entries.map((e) => (
                  <tr key={e.id} data-testid="campaign-calendar-entry" data-campaign-id={e.id}>
                    <td>{formatWhen(e.startsAt)}</td>
                    <td>{formatWhen(e.endsAt)}</td>
                    <td>{e.name}</td>
                    <td>
                      <StateChip state={e.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

export function CampaignsDeskScreen({ view, loading, onRefresh }: { view: CampaignsDeskView | null; loading: boolean; onRefresh: () => void }) {
  const rows = view && view.campaigns.kind === 'ok' ? view.campaigns.data : null;
  return (
    <div className="dk" data-testid="campaigns-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Campaigns</h1>
          <p>
            Build a campaign, send it for approval and take it live. One founder writes and asks; a different founder approves
            that revision. A budget is a limit the rewards draw on, never a balance: nothing is paid until a customer qualifies.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <Link className="adm-btn" href="/more-ops/campaigns/builder">
          New campaign
        </Link>
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
      {rows && (
        <>
          <Overview rows={rows} />
          <Drafts rows={rows} />
          <AllCampaigns rows={rows} />
        </>
      )}
      {view && <Calendar view={view} />}
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
