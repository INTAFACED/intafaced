'use client';

import { useCallback, useState } from 'react';
import {
  EXPORT_DATASETS,
  EXPORT_FIELDS,
  WATCH_LIST_LIMIT,
  type BudgetSplit,
  type CodeBatch,
  type CodeBatchResult,
  type ExportDataset,
  type ExportRequestResult,
  type WatchAlert,
  type WatchCampaign,
  type WatchOverview,
  type WatchVoucher,
} from '@intafaced/contracts/campaigns-watch';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { RuleAnswer } from '@/lib/campaigns-ops/builder-browser';
import { codesOfCsv, saveFile, watchChange, watchDownload, watchRead } from '@/lib/campaigns-ops/watch-browser';
import { StateChip } from './campaigns-desk';
import './desk.css';

/**
 * CAMPAIGN WATCH (J-campaigns-17; CM-campaign-admin-01, -02, CM-campaign-types-03).
 *
 * The overview of running campaigns and one campaign at a time, as svc-campaigns counted them on this read: no figure is
 * the console's own. A budget shows its limit as reserved plus spent plus left; nothing on this desk moves money. Codes
 * made in a batch are shown here once, to download, and are never stored in plain text by svc-campaigns or this console.
 */

type Refusal = Extract<RuleAnswer<never>, { ok: false }>;

function Refused({ refusal, testId }: { refusal: Refusal; testId: string }) {
  return (
    <div className="adm-callout" data-tone="danger" role="alert" data-testid={testId} data-code={refusal.code ?? ''}>
      <strong>{refusal.title}</strong>
      <p>
        {refusal.body}
        {refusal.code ? ` (${refusal.code})` : ''}
      </p>
      {refusal.next && <p className="dk-muted">{refusal.next}</p>}
    </div>
  );
}

function Count({ part, n }: { part: string; n: number }) {
  return (
    <p data-testid="watch-count" data-part={part} data-count={n}>
      {n === 0 ? 'None yet' : `${n} in all`}
      {n > WATCH_LIST_LIMIT ? `; the newest ${WATCH_LIST_LIMIT} are listed` : ''}
    </p>
  );
}

function Budget({ budget, label }: { budget: BudgetSplit; label: string }) {
  return (
    <dl className="dk-kv" aria-label={label} data-testid="watch-budget" data-asset={budget.asset}>
      {(
        [
          ['Limit', budget.limit],
          ['Reserved', budget.reserved],
          ['Spent', budget.spent],
          ['Left', budget.left],
        ] as const
      ).map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd data-budget={term.toLowerCase()}>
            {value} {budget.asset}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── The overview ─────────────────────────────────────────────────────────────────────────────────────────────────

const KPI_LABEL: [keyof WatchOverview['kpis'], string][] = [
  ['running', 'Campaigns that went live'],
  ['live', 'Live now'],
  ['participants', 'Participants'],
  ['vouchersIssued', 'Vouchers issued'],
  ['vouchersClaimed', 'Vouchers claimed'],
  ['redemptions', 'Rewards and redemptions'],
];

function Alerts({ alerts, onChange }: { alerts: WatchAlert[]; onChange: () => Promise<void> }) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const flip = async (a: WatchAlert) => {
    setBusy(true);
    setRefusal(null);
    const answer = await watchChange<WatchAlert>({ op: 'alert', kind: a.kind, enabled: !a.enabled });
    if (!answer.ok) setRefusal(answer);
    await onChange();
    setBusy(false);
  };
  return (
    <section aria-label="Alerts" data-testid="watch-alerts">
      <h2>Alerts</h2>
      {refusal && <Refused refusal={refusal} testId="alert-refusal" />}
      <ul>
        {alerts.map((a) => (
          <li key={a.kind} data-testid="watch-alert" data-kind={a.kind} data-enabled={a.enabled}>
            <strong>{a.title}</strong>
            <span data-testid="alert-threshold">
              {a.threshold === null ? `Threshold: not set (owner value ${a.setting})` : `Threshold: ${a.threshold}`}
            </span>
            <span>{a.enabled ? 'On' : 'Off'}</span>
            <button type="button" className="adm-btn" disabled={busy} onClick={() => void flip(a)}>
              {a.enabled ? `Switch off: ${a.title}` : `Switch on: ${a.title}`}
            </button>
            {a.enabled && a.firing.length === 0 && <span className="dk-muted">Nothing trips it now.</span>}
            {a.firing.length > 0 && (
              <ul aria-label={`${a.title} now`}>
                {a.firing.map((f) => (
                  <li key={`${f.campaignId ?? 'all'}`}>
                    {f.name}: {f.detail}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OverviewScreen({ view, reload }: { view: WatchOverview; reload: () => Promise<void> }) {
  return (
    <>
      <section aria-label="Key figures" data-testid="watch-kpis">
        <h2>Key figures</h2>
        <dl className="dk-kv">
          {KPI_LABEL.map(([key, label]) => (
            <div key={key} data-testid="watch-kpi" data-kpi={key} data-count={view.kpis[key]}>
              <dt>{label}</dt>
              <dd>{view.kpis[key] === 0 ? 'None yet' : view.kpis[key]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label="Budgets" data-testid="watch-budgets">
        <h2>Budgets</h2>
        <p className="dk-muted">
          Summed over campaigns that went live. The limit is what is reserved, plus what is spent, plus what is left.
        </p>
        {view.budgets.length === 0 ? (
          <p>No running campaign has a budget yet.</p>
        ) : (
          view.budgets.map((b) => <Budget key={b.asset} budget={b} label={`Budget in ${b.asset}`} />)
        )}
      </section>
      <section aria-label="Redemption trend" data-testid="watch-trend">
        <h2>Redemption trend</h2>
        <table className="adm-table">
          <caption>Rewards and redemptions written each day (UTC), the last 14 days</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Rewards and redemptions</th>
            </tr>
          </thead>
          <tbody>
            {view.trend.map((d) => (
              <tr key={d.day} data-testid="watch-trend-day" data-day={d.day} data-count={d.redemptions}>
                <td>{d.day}</td>
                <td>{d.redemptions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label="Top campaigns" data-testid="watch-top">
        <h2>Top campaigns</h2>
        {view.top.length === 0 ? (
          <p>No campaign has gone live yet.</p>
        ) : (
          <table className="adm-table">
            <caption>Running campaigns with the most rewards and redemptions</caption>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">State</th>
                <th scope="col">Rewards and redemptions</th>
                <th scope="col">Participants</th>
              </tr>
            </thead>
            <tbody>
              {view.top.map((t) => (
                <tr key={t.campaignId} data-testid="watch-top-row" data-campaign-id={t.campaignId}>
                  <td>
                    <a href={`/more-ops/campaigns/watch?id=${encodeURIComponent(t.campaignId)}`}>{t.name}</a>
                  </td>
                  <td>
                    <StateChip state={t.state} />
                  </td>
                  <td>{t.redemptions}</td>
                  <td>{t.participants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Alerts alerts={view.alerts} onChange={reload} />
      <section aria-label="Running campaigns" data-testid="watch-running">
        <h2>Running campaigns</h2>
        {view.campaigns.length === 0 ? (
          <p>No campaign has gone live yet.</p>
        ) : (
          <ul>
            {view.campaigns.map((c) => (
              <li key={c.campaignId}>
                <a href={`/more-ops/campaigns/watch?id=${encodeURIComponent(c.campaignId)}`}>{c.name}</a> <StateChip state={c.state} />
              </li>
            ))}
          </ul>
        )}
        {view.kpis.running > view.campaigns.length && (
          <p className="dk-muted">The newest {view.campaigns.length} are listed; open an older one from the campaigns desk.</p>
        )}
      </section>
    </>
  );
}

// ── One campaign ─────────────────────────────────────────────────────────────────────────────────────────────────

function Batches({ view, reload }: { view: WatchCampaign; reload: () => Promise<void> }) {
  const [reference, setReference] = useState('');
  const [count, setCount] = useState('');
  const [importRef, setImportRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fresh, setFresh] = useState<{ reference: string; codes: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const id = view.campaign.id;

  const act = async <T,>(body: Record<string, unknown>, done: (data: T) => void) => {
    setBusy(true);
    setRefusal(null);
    setNotice(null);
    const answer = await watchChange<T>(body);
    if (answer.ok) done(answer.data);
    else setRefusal(answer);
    await reload();
    setBusy(false);
  };

  const generate = () =>
    act<CodeBatchResult>({ op: 'generate', campaignId: id, reference: reference.trim(), count: Number(count) }, (r) => {
      if (r.codes) {
        setFresh({ reference: r.batch.reference, codes: r.codes });
        setNotice(`${r.codes.length} codes made in batch ${r.batch.reference}. Download them now: they are shown once and never stored.`);
      } else {
        setNotice(`Batch ${r.batch.reference} was already made. Its codes were given out once, when it was made, and are not stored.`);
      }
    });

  const importCsv = async () => {
    if (!file) return;
    const codes = codesOfCsv(await file.text());
    await act<CodeBatchResult>({ op: 'import', campaignId: id, reference: importRef.trim(), codes }, (r) =>
      setNotice(
        r.created
          ? `Imported ${r.batch.count} codes as batch ${r.batch.reference}. Only their hashes and last four characters are stored.`
          : `Batch ${r.batch.reference} was already imported. Nothing new was stored.`,
      ),
    );
  };

  const download = () => {
    if (!fresh) return;
    saveFile(
      new Blob([['code', ...fresh.codes].join('\n') + '\n'], { type: 'text/csv' }),
      `${fresh.reference.replace(/[^A-Za-z0-9._-]/g, '_')}-codes.csv`,
    );
    // The codes leave the page with the file: nothing here can show them again.
    setFresh(null);
    setNotice('The codes were downloaded. They are not stored anywhere, so this was the only download.');
  };

  const publish = (b: CodeBatch) =>
    act<CodeBatch>({ op: 'publish', batchId: b.id }, (p) => setNotice(`Batch ${p.reference} is published: customers can claim its codes.`));

  return (
    <section aria-label="Code batches" data-testid="watch-batches">
      <h2>Code batches</h2>
      <p className="dk-muted">
        Codes made or imported here are stored as their hash and last four characters only. A batch&apos;s codes are claimable once it is
        published to customers.
      </p>
      {notice && (
        <p role="status" data-testid="batch-notice">
          {notice}
        </p>
      )}
      {refusal && <Refused refusal={refusal} testId="batch-refusal" />}
      {fresh && (
        <button type="button" className="adm-btn" data-variant="primary" onClick={download}>
          Download the codes (once)
        </button>
      )}
      <form aria-label="Generate a code batch" className="dk-row" onSubmit={(e) => (e.preventDefault(), void generate())}>
        <div className="adm-field">
          <label htmlFor="watch-batch-ref">Batch name</label>
          <input id="watch-batch-ref" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="watch-batch-count">How many codes</label>
          <input id="watch-batch-count" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        </div>
        <button type="submit" className="adm-btn" disabled={busy || !reference.trim() || !/^[1-9]\d*$/.test(count)}>
          Generate codes
        </button>
      </form>
      <form aria-label="Import codes from a CSV" className="dk-row" onSubmit={(e) => (e.preventDefault(), void importCsv())}>
        <div className="adm-field">
          <label htmlFor="watch-import-ref">Import name</label>
          <input id="watch-import-ref" maxLength={80} value={importRef} onChange={(e) => setImportRef(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="watch-import-file">CSV file</label>
          <input id="watch-import-file" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="dk-muted">One code per row, in the first column; a header row named code is skipped.</p>
        </div>
        <button type="submit" className="adm-btn" disabled={busy || !importRef.trim() || !file}>
          Import codes
        </button>
      </form>
      {view.batches.length === 0 ? (
        <p data-testid="batches-empty">No code batch yet.</p>
      ) : (
        <table className="adm-table">
          <caption>Code batches, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Batch</th>
              <th scope="col">Made</th>
              <th scope="col">Codes</th>
              <th scope="col">State</th>
              <th scope="col">Made by</th>
              <th scope="col">Publish</th>
            </tr>
          </thead>
          <tbody>
            {view.batches.map((b) => (
              <tr key={b.id} data-testid="watch-batch" data-batch-id={b.id} data-state={b.state}>
                <td>{b.reference}</td>
                <td>{b.source === 'generated' ? 'Generated' : 'Imported'}</td>
                <td>{b.count}</td>
                <td>{b.state === 'published' ? `Published ${formatWhen(b.publishedAt!)} (UTC)` : 'Not published'}</td>
                <td className="dk-packet">{b.createdBy}</td>
                <td>
                  {b.state === 'generated' && (
                    <button type="button" className="adm-btn" disabled={busy} onClick={() => void publish(b)}>
                      Publish to customers: {b.reference}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Vouchers({ view, reload }: { view: WatchCampaign; reload: () => Promise<void> }) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const deactivate = async (v: WatchVoucher) => {
    setBusy(true);
    setRefusal(null);
    const answer = await watchChange<WatchVoucher>({ op: 'deactivate', voucherId: v.id });
    if (!answer.ok) setRefusal(answer);
    await reload();
    setBusy(false);
  };
  const can = (v: WatchVoucher) => ['generated', 'published', 'active', 'claimed', 'partially_used'].includes(v.state);
  return (
    <section aria-label="Vouchers" data-testid="watch-vouchers">
      <h2>Vouchers</h2>
      <Count part="vouchers" n={view.vouchers.count} />
      {view.vouchers.byState.length > 0 && (
        <p data-testid="vouchers-by-state">{view.vouchers.byState.map((s) => `${s.state.replace('_', ' ')}: ${s.count}`).join(' · ')}</p>
      )}
      {refusal && <Refused refusal={refusal} testId="voucher-refusal" />}
      {view.vouchers.rows.length > 0 && (
        <table className="adm-table">
          <caption>Vouchers, newest first, by the last four characters of their code</caption>
          <thead>
            <tr>
              <th scope="col">Code ends</th>
              <th scope="col">State</th>
              <th scope="col">Batch</th>
              <th scope="col">Claimed by</th>
              <th scope="col">Issued</th>
              <th scope="col">Deactivate</th>
            </tr>
          </thead>
          <tbody>
            {view.vouchers.rows.map((v) => (
              <tr key={v.id} data-testid="watch-voucher" data-voucher-id={v.id} data-state={v.state}>
                <td>…{v.codeLastFour}</td>
                <td>{v.state.replace('_', ' ')}</td>
                <td className="dk-packet">{v.batchId ?? 'Issued one at a time'}</td>
                <td className="dk-packet">{v.claimedBy ?? 'Not claimed'}</td>
                <td>{formatWhen(v.issuedAt)} (UTC)</td>
                <td>
                  {can(v) && (
                    <button type="button" className="adm-btn" disabled={busy} onClick={() => void deactivate(v)}>
                      Deactivate voucher …{v.codeLastFour}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const DATASET_LABEL: Record<ExportDataset, string> = { participants: 'Participants', redemptions: 'Redemptions', vouchers: 'Vouchers' };

function Exports({ view, reload }: { view: WatchCampaign; reload: () => Promise<void> }) {
  const [dataset, setDataset] = useState<ExportDataset>('participants');
  const [fields, setFields] = useState<string[]>([...EXPORT_FIELDS.participants]);
  const [notice, setNotice] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    setRefusal(null);
    setNotice(null);
    const answer = await watchChange<ExportRequestResult>({ op: 'export', campaignId: view.campaign.id, dataset, fields });
    if (answer.ok)
      setNotice(
        answer.data.created
          ? `Export ${answer.data.job.id} is ${answer.data.job.state}.`
          : `The same export is already ${answer.data.job.state} (${answer.data.job.id}); no second job was started.`,
      );
    else setRefusal(answer);
    await reload();
    setBusy(false);
  };
  const download = async (jobId: string) => {
    setRefusal(null);
    const got = await watchDownload(jobId);
    if (got.ok) saveFile(got.blob, got.filename);
    else setRefusal(got);
  };
  return (
    <section aria-label="Exports" data-testid="watch-exports">
      <h2>Exports</h2>
      {notice && (
        <p role="status" data-testid="export-notice">
          {notice}
        </p>
      )}
      {refusal && <Refused refusal={refusal} testId="export-refusal" />}
      <form aria-label="Request an export" onSubmit={(e) => (e.preventDefault(), void ask())}>
        <div className="adm-field">
          <label htmlFor="watch-export-dataset">Export</label>
          <select
            id="watch-export-dataset"
            value={dataset}
            onChange={(e) => {
              const d = e.target.value as ExportDataset;
              setDataset(d);
              setFields([...EXPORT_FIELDS[d]]);
            }}
          >
            {EXPORT_DATASETS.map((d) => (
              <option key={d} value={d}>
                {DATASET_LABEL[d]}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend>Fields</legend>
          {(EXPORT_FIELDS[dataset] as readonly string[]).map((f) => (
            <label key={f}>
              <input
                type="checkbox"
                checked={fields.includes(f)}
                onChange={(e) => setFields(e.target.checked ? [...fields, f] : fields.filter((x) => x !== f))}
              />
              {f}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="adm-btn" disabled={busy || fields.length === 0}>
          Request the export
        </button>
      </form>
      {view.exports.length === 0 ? (
        <p data-testid="exports-empty">No export yet.</p>
      ) : (
        <table className="adm-table">
          <caption>Exports of this campaign, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Export</th>
              <th scope="col">Fields</th>
              <th scope="col">State</th>
              <th scope="col">Rows</th>
              <th scope="col">Link works until</th>
              <th scope="col">File</th>
            </tr>
          </thead>
          <tbody>
            {view.exports.map((j) => (
              <tr key={j.id} data-testid="watch-export" data-export-id={j.id} data-state={j.state}>
                <td>{DATASET_LABEL[j.dataset]}</td>
                <td>{j.fields.join(', ')}</td>
                <td>{j.state}</td>
                <td>{j.rows ?? 'Not yet'}</td>
                <td>{j.expiresAt ? `${formatWhen(j.expiresAt)} (UTC)` : 'Not ready'}</td>
                <td>
                  {j.state === 'ready' && (
                    <button type="button" className="adm-btn" onClick={() => void download(j.id)}>
                      Download export {j.id}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CampaignScreen({ view, reload }: { view: WatchCampaign; reload: () => Promise<void> }) {
  return (
    <>
      <p>
        <StateChip state={view.campaign.state} /> {view.campaign.type} campaign
      </p>
      <section aria-label="Budget" data-testid="watch-campaign-budget">
        <h2>Budget</h2>
        {view.budget ? <Budget budget={view.budget} label="This campaign's budget" /> : <p>Not set.</p>}
      </section>
      <section aria-label="Participation" data-testid="watch-participation">
        <h2>Participation</h2>
        <Count part="participation" n={view.participation.count} />
        {view.participation.rows.length > 0 && (
          <table className="adm-table">
            <caption>Accounts that joined, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {view.participation.rows.map((p) => (
                <tr key={p.accountId}>
                  <td className="dk-packet">{p.accountId}</td>
                  <td>{formatWhen(p.joinedAt)} (UTC)</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Vouchers view={view} reload={reload} />
      <section aria-label="Redemptions" data-testid="watch-redemptions">
        <h2>Redemptions</h2>
        <Count part="redemptions" n={view.redemptions.count} />
        {view.redemptions.rows.length > 0 && (
          <table className="adm-table">
            <caption>Rewards and voucher redemptions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Account</th>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
                <th scope="col">Written</th>
              </tr>
            </thead>
            <tbody>
              {view.redemptions.rows.map((r) => (
                <tr key={r.rewardKey}>
                  <td className="dk-packet">{r.rewardKey}</td>
                  <td className="dk-packet">{r.accountId}</td>
                  <td>
                    {r.amount} {r.asset}
                  </td>
                  <td>{r.state.replace('_', ' ')}</td>
                  <td>{formatWhen(r.createdAt)} (UTC)</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Publications" data-testid="watch-publications">
        <h2>Publications</h2>
        <Count part="publications" n={view.publications.count} />
        {view.publications.rows.length > 0 && (
          <table className="adm-table">
            <caption>Code batches published to customers, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Vouchers</th>
                <th scope="col">Published by</th>
                <th scope="col">Published</th>
              </tr>
            </thead>
            <tbody>
              {view.publications.rows.map((p) => (
                <tr key={p.id}>
                  <td>{p.reference}</td>
                  <td>{p.vouchers}</td>
                  <td className="dk-packet">{p.publishedBy}</td>
                  <td>{formatWhen(p.publishedAt)} (UTC)</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Batches view={view} reload={reload} />
      <Exports view={view} reload={reload} />
    </>
  );
}

export type WatchInitial =
  { kind: 'overview'; answer: RuleAnswer<WatchOverview> } | { kind: 'campaign'; id: string; answer: RuleAnswer<WatchCampaign> };

export function CampaignsWatch({ initial }: { initial: WatchInitial }) {
  const [answer, setAnswer] = useState<RuleAnswer<WatchOverview | WatchCampaign>>(initial.answer);
  const [loading, setLoading] = useState(false);
  const query = initial.kind === 'campaign' ? `?id=${encodeURIComponent(initial.id)}` : '';
  const reload = useCallback(async () => {
    setLoading(true);
    setAnswer(await watchRead<WatchOverview | WatchCampaign>(query));
    setLoading(false);
  }, [query]);
  const title = initial.kind === 'campaign' && answer.ok ? (answer.data as WatchCampaign).campaign.name : 'Campaign watch';
  return (
    <div className="dk" data-testid="campaigns-watch" data-view={initial.kind}>
      <div className="adm-pagehead">
        <div>
          <h1>{title}</h1>
          <p>
            Running campaigns as svc-campaigns counted them on this read. A budget is a limit, never a balance: what is reserved, spent and
            left adds up to it, and nothing on this desk moves money.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <a href="/more-ops/campaigns">Campaigns desk</a>
        {initial.kind === 'campaign' && <a href="/more-ops/campaigns/watch">Every running campaign</a>}
        <button type="button" className="adm-btn" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        {answer.ok && <span className="dk-asof">As of {formatAsOf(answer.data.asOf)} (when svc-campaigns counted)</span>}
      </div>
      {!answer.ok && <Refused refusal={answer} testId="watch-unavailable" />}
      {answer.ok && initial.kind === 'overview' && <OverviewScreen view={answer.data as WatchOverview} reload={reload} />}
      {answer.ok && initial.kind === 'campaign' && <CampaignScreen view={answer.data as WatchCampaign} reload={reload} />}
    </div>
  );
}
