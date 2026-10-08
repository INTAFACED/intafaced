'use client';

import { useEffect, useRef, useState } from 'react';
import { Panel } from '@intafaced/ui';
import { Chip } from './chip';
import {
  OPS_VIEWS,
  parseOpsData,
  type OpsView,
  type OpsCreate,
  type OpsData,
  type OpsReply,
  type OpsAuthority,
} from '@/lib/business-ops-contract';

const LABELS: Record<OpsView, string> = {
  contacts: 'Contacts',
  team: 'Team directory',
  revenue: 'Revenue',
  projects: 'Projects',
  fundraising: 'Fundraising',
  milestones: 'Milestones',
  custody: 'Custody',
  structured: 'Structured records',
};
const DESCRIPTIONS: Record<OpsView, string> = {
  contacts: 'Local contacts with source status for identity and support. Email addresses are shown only after an authorized read.',
  team: 'Directory handles and role descriptions. These records do not grant permissions; payroll is unavailable.',
  revenue: 'Warehouse metric values and freshness from the analytics replica. An unavailable or stale warehouse stays unavailable.',
  projects: 'Project titles and their recorded state. Create a project record through the Ops service.',
  fundraising: 'Raise names, target metadata and milestone labels. These records do not fund escrow or move value.',
  milestones: 'Milestone labels scoped to a recorded raise. The service has no completion or vesting action.',
  custody: 'Custody policy, key references and pending approval records. No private key material enters this desk.',
  structured: 'Names and leg labels only. Pricing, valuation and payoff calculation are unavailable.',
};
const CREATE_FOR: Partial<Record<OpsView, OpsCreate>> = {
  contacts: 'createContact',
  team: 'createTeamMember',
  projects: 'projects.create',
  fundraising: 'fundraising.create',
  custody: 'custody.createApproval',
  structured: 'structured.create',
};
const FIELDS: Record<OpsCreate, { name: string; label: string; required?: boolean; options?: string[] }[]> = {
  createContact: [
    { name: 'displayName', label: 'Contact name', required: true },
    { name: 'email', label: 'Contact email (optional)' },
  ],
  createTeamMember: [
    { name: 'handle', label: 'Directory handle', required: true },
    { name: 'role', label: 'Role description', required: true },
  ],
  'projects.create': [{ name: 'title', label: 'Project title', required: true }],
  'fundraising.create': [
    { name: 'name', label: 'Raise name', required: true },
    { name: 'targetAmount', label: 'Target amount metadata (optional decimal)' },
    { name: 'milestoneLabels', label: 'Milestone labels (comma separated)' },
  ],
  'custody.createApproval': [
    { name: 'fromTier', label: 'From tier', required: true, options: ['cold', 'warm', 'hot'] },
    { name: 'toTier', label: 'To tier', required: true, options: ['cold', 'warm', 'hot'] },
    { name: 'amount', label: 'Amount metadata (optional decimal)' },
  ],
  'structured.create': [
    { name: 'name', label: 'Record name', required: true },
    { name: 'legLabels', label: 'Leg labels (comma separated)' },
  ],
};
const UNKNOWN_KEY = 'intafaced.team.ops-unknown-command';

function message(code?: string): string {
  const copy: Record<string, string> = {
    'admin.ops_read_unconfigured':
      'Ops reads require EDGE_URL and a separate ADMIN_OPS_READ_TOKEN with ops:read. General admin access does not grant this authority.',
    'admin.ops_write_unconfigured': 'Ops creates require EDGE_URL and a separate ADMIN_OPS_WRITE_TOKEN with ops:write.',
    'admin.ops_forbidden': 'The service refused this Ops scope or jurisdiction. The current principal has no authority for this request.',
    'admin.ops_unauthorized':
      'The service requires an authenticated Ops principal. Refresh operator access through the authenticated proxy.',
    'admin.ops_invalid_response': 'The service returned an invalid projection. No records or monetary values were accepted.',
    'admin.ops_network_unavailable': 'The Ops service did not answer. A create attempt may already have reached it.',
    'admin.bff_gate_unconfigured':
      'The operator deployment gate is unavailable. Configure the authenticated proxy before reading or changing Ops records.',
    'admin.bff_gate': 'The operator deployment gate refused access. Use the authenticated operator proxy.',
    'ops.warehouse_unwired': 'The analytics warehouse replica is not connected. Revenue cannot be read.',
    'ops.warehouse_lag_stale': 'Warehouse freshness is stale. Revenue cannot be presented as current.',
    'ops.warehouse_lag_unknown': 'Warehouse freshness has not been measured. Revenue remains unavailable.',
    'ops.custody_freeze_unset': 'The custody freeze policy is unset. Approval creation remains blocked by the service.',
    'ops.custody_frozen': 'Custody is frozen. Approval creation remains blocked by the service.',
  };
  return (
    copy[code ?? ''] ?? 'This request was refused or failed. Review the named service code and refresh operator access before continuing.'
  );
}

async function readReply(response: Response): Promise<OpsReply> {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 502, code: 'admin.ops_invalid_response' };
  const raw = body as OpsReply & { error?: string };
  if (typeof raw.ok !== 'boolean') return { ok: false, status: response.status, code: raw.code ?? 'admin.ops_invalid_response' };
  return { ...raw, ok: raw.ok && response.ok, status: response.status };
}

export function BusinessOps() {
  const [view, setView] = useState<OpsView>('contacts');
  const [limit, setLimit] = useState(50);
  const [raiseId, setRaiseId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [authority, setAuthority] = useState<OpsAuthority | null>(null);
  const [read, setRead] = useState<OpsReply | null>(null);
  const [busy, setBusy] = useState(true);
  const [writeBusy, setWriteBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [receipt, setReceipt] = useState<OpsReply | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const writeLock = useRef(false);
  const operation = CREATE_FOR[view];

  useEffect(() => {
    try {
      setUnknown(sessionStorage.getItem(UNKNOWN_KEY));
    } catch {
      setUnknown('Command recovery storage unavailable');
    }
    let live = true;
    void fetch('/api/business-ops?view=authority', { cache: 'no-store' })
      .then(readReply)
      .then((reply) => {
        if (live) setAuthority(reply.ok ? (reply.authority ?? null) : null);
      })
      .catch(() => {
        if (live) setAuthority(null);
      });
    return () => {
      live = false;
    };
  }, [refresh]);

  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    setBusy(true);
    setRead(null);
    const query = new URLSearchParams({
      view,
      ...(view === 'revenue' ? {} : { limit: String(limit) }),
      ...(view === 'milestones' && raiseId.trim() ? { raiseId: raiseId.trim() } : {}),
    });
    void fetch(`/api/business-ops?${query}`, { cache: 'no-store', signal: abort.signal })
      .then(readReply)
      .then((reply) => {
        if (!live) return;
        if (reply.ok) {
          try {
            reply.data = parseOpsData(view, reply.data);
          } catch {
            reply = { ok: false, status: 502, code: 'admin.ops_invalid_response' };
          }
        }
        setRead(reply);
        setBusy(false);
      })
      .catch(() => {
        if (live) {
          setRead({ ok: false, status: 502, code: 'admin.ops_network_unavailable' });
          setBusy(false);
        }
      });
    return () => {
      live = false;
      abort.abort();
    };
  }, [view, limit, raiseId, refresh]);

  function select(next: OpsView) {
    if (writeLock.current) return;
    setView(next);
    setFields({});
    setAcknowledged(false);
    setConfirmation('');
    setReceipt(null);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (
      !operation ||
      writeLock.current ||
      unknown ||
      !authority?.writeConfigured ||
      !acknowledged ||
      confirmation !== `CREATE ${operation}`
    )
      return;
    const input: Record<string, unknown> = { ...fields };
    for (const field of FIELDS[operation]) {
      if (field.name === 'milestoneLabels' || field.name === 'legLabels')
        input[field.name] = (fields[field.name] ?? '')
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean);
      if (field.name === 'targetAmount' || field.name === 'amount') input[field.name] = fields[field.name]?.trim() || null;
    }
    try {
      sessionStorage.setItem(UNKNOWN_KEY, operation);
    } catch {
      setUnknown('Command recovery storage unavailable');
      return;
    }
    writeLock.current = true;
    setWriteBusy(true);
    setReceipt(null);
    let result: OpsReply;
    try {
      result = await readReply(
        await fetch('/api/business-ops', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation, input, acknowledged, confirmation }),
        }),
      );
      if (result.ok && (!result.record || typeof result.record.id !== 'string' || typeof result.record.label !== 'string'))
        result = { ok: false, status: 502, code: 'admin.ops_invalid_response', uncertain: true };
      if (!result.ok && result.status >= 500 && result.uncertain !== false) result.uncertain = true;
    } catch {
      result = { ok: false, status: 502, code: 'admin.ops_network_unavailable', uncertain: true };
    }
    setReceipt(result);
    if (result.uncertain) setUnknown(operation);
    else {
      try {
        sessionStorage.removeItem(UNKNOWN_KEY);
      } catch {
        setUnknown('Command recovery storage unavailable');
      }
      if (result.ok) {
        setFields({});
        setAcknowledged(false);
        setConfirmation('');
        setRefresh((n) => n + 1);
      }
    }
    writeLock.current = false;
    setWriteBusy(false);
  }

  const data = read?.ok ? read.data : undefined;
  const custodyBlocked = view === 'custody' && data?.freeze?.status !== 'open';
  const ready = operation && FIELDS[operation].every((field) => !field.required || fields[field.name]?.trim());
  const canWrite = Boolean(authority?.writeConfigured && read?.ok && !writeBusy && !unknown && !custodyBlocked);

  return (
    <div className="adm-stack">
      <div className="adm-pagehead">
        <div>
          <h1>Business operations</h1>
          <p>
            Contacts, directory and operating records from Ops. Separate <code>ops:read</code> and <code>ops:write</code> principals are
            checked by the service; customer and general admin sessions do not grant access.
          </p>
        </div>
        <button className="adm-btn" onClick={() => setRefresh((n) => n + 1)} disabled={writeBusy || busy}>
          Refresh Ops
        </button>
      </div>
      <div className="adm-ops-tabs" aria-label="Business operations jobs">
        {OPS_VIEWS.map((item) => (
          <button className="adm-btn" key={item} aria-pressed={view === item} disabled={writeBusy} onClick={() => select(item)}>
            {LABELS[item]}
          </button>
        ))}
      </div>
      <div className="adm-pagehead">
        <div>
          <h2>{LABELS[view]}</h2>
          <p>{DESCRIPTIONS[view]}</p>
        </div>
        {view !== 'revenue' && (
          <div className="adm-field">
            <label htmlFor="ops-limit">Maximum records in this read</label>
            <select
              id="ops-limit"
              className="adm-select"
              value={limit}
              disabled={writeBusy}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      {view === 'milestones' && (
        <div className="adm-field">
          <label htmlFor="ops-raise-filter">Raise ID (optional filter)</label>
          <input
            id="ops-raise-filter"
            className="adm-input"
            value={raiseId}
            disabled={writeBusy}
            onChange={(event) => setRaiseId(event.target.value)}
          />
        </div>
      )}
      <section aria-live="polite" aria-busy={busy}>
        {busy ? (
          <p>Reading {LABELS[view].toLowerCase()}…</p>
        ) : read && !read.ok ? (
          <div className="adm-callout" data-tone="warn">
            <strong>{read.status === 401 || read.status === 403 ? 'Access refused' : 'Read unavailable'}</strong>
            {message(read.code)} <code>{read.code}</code>
          </div>
        ) : data ? (
          <OpsProjection view={view} data={data} />
        ) : (
          <p>No authorized projection has been read.</p>
        )}
      </section>
      {view !== 'revenue' && read?.ok && (
        <p className="adm-footnote">
          This read is limited to the first {limit} records. The service offers no cursor or total count. A full page may have more records;
          increase the explicit limit up to 200. The directory, projects, raises and approvals currently use service process storage; this
          desk does not promise durable retention.
        </p>
      )}
      {view === 'team' && (
        <div className="adm-callout" data-tone="warn">
          <strong>Payroll unavailable</strong>
          <code>ops.payroll_invent_forbidden</code>. Directory roles do not create payroll or change access permissions.
        </div>
      )}
      {view === 'fundraising' && (
        <div className="adm-callout" data-tone="warn">
          <strong>Escrow and vesting unavailable</strong>
          <code>ops.fundraising_chain_unwired</code>. Creating a raise stores metadata; no funding rail or asset unit is supplied by this
          contract. Target metadata is displayed exactly without interpreting a currency.
        </div>
      )}
      {view === 'custody' && (
        <div className="adm-callout" data-tone="warn">
          <strong>Execution and key wrapping unavailable</strong>
          <code>ops.custody_chain_unwired</code> / <code>ops.custody_keys_forbidden</code>. The service cannot execute a multi-signature
          movement or accept real keys. An approval is a pending record only; its amount has no currency definition in this contract.
        </div>
      )}
      {unknown && (
        <div className="adm-callout" data-tone="danger" role="alert">
          <strong>Command outcome unresolved</strong>
          <code>{unknown}</code>. Creates remain locked across reload. Read the service records and investigate the original attempt before
          another create; this contract has no idempotency key or request-status lookup. Do not blindly repeat it.
        </div>
      )}
      {operation && (
        <Panel title={`Create ${view === 'custody' ? 'approval record' : LABELS[view].toLowerCase()}`}>
          <form className="adm-stack" onSubmit={create}>
            {!authority?.writeConfigured && (
              <p className="adm-blocked">
                Disabled — a gated deployment with a separate ADMIN_OPS_WRITE_TOKEN carrying ops:write is required. Configuration is not
                proof of permission; the service checks each command.
              </p>
            )}
            {custodyBlocked && <p className="adm-blocked">Approval creation requires a freshly read open custody freeze policy.</p>}
            <div className="adm-cols">
              {FIELDS[operation].map((field) => (
                <div className="adm-field" key={field.name}>
                  <label htmlFor={`ops-${field.name}`}>{field.label}</label>
                  {field.options ? (
                    <select
                      id={`ops-${field.name}`}
                      className="adm-select"
                      disabled={!canWrite}
                      required={field.required}
                      value={fields[field.name] ?? ''}
                      onChange={(event) => setFields({ ...fields, [field.name]: event.target.value })}
                    >
                      <option value="">Choose a tier</option>
                      {field.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`ops-${field.name}`}
                      className="adm-input"
                      type={field.name === 'email' ? 'email' : 'text'}
                      required={field.required}
                      disabled={!canWrite}
                      value={fields[field.name] ?? ''}
                      onChange={(event) => setFields({ ...fields, [field.name]: event.target.value })}
                      autoComplete="off"
                    />
                  )}
                </div>
              ))}
            </div>
            <label className="adm-check">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={!canWrite}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I reviewed this new service record and understand the operation. It does not grant account permissions or move funds.
              </span>
            </label>
            <div className="adm-field">
              <label htmlFor="ops-confirm">
                Type <code>CREATE {operation}</code> to confirm
              </label>
              <input
                id="ops-confirm"
                className="adm-input"
                disabled={!canWrite}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <button
                className="adm-btn"
                data-tone="primary"
                type="submit"
                disabled={!canWrite || !ready || !acknowledged || confirmation !== `CREATE ${operation}`}
              >
                {writeBusy ? 'Awaiting service…' : 'Create record'}
              </button>
            </div>
          </form>
        </Panel>
      )}
      {receipt && (
        <div className="adm-callout" data-tone={receipt.ok ? 'info' : 'warn'} role="status">
          <strong>{receipt.ok ? 'Service returned a record' : receipt.uncertain ? 'Outcome unknown' : 'Create refused'}</strong>
          {receipt.ok ? (
            <>
              <span>{receipt.record?.label}</span> · record <code>{receipt.record?.id}</code>
            </>
          ) : (
            <>
              {message(receipt.code)} <code>{receipt.code}</code>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OpsProjection({ view, data }: { view: OpsView; data: OpsData }) {
  const items: { id: string; label: string; detail: string }[] = [];
  if (view === 'contacts')
    data.contacts?.forEach((r) => items.push({ id: r.id, label: r.displayName, detail: `${r.email ?? 'Email absent'} · ${r.source}` }));
  if (view === 'team') data.members?.forEach((r) => items.push({ id: r.id, label: r.handle, detail: r.role }));
  if (view === 'projects') data.projects?.forEach((r) => items.push({ id: r.id, label: r.title, detail: r.status }));
  if (view === 'fundraising')
    data.raises?.forEach((r) => items.push({ id: r.id, label: r.name, detail: `Target metadata: ${r.targetAmount ?? 'absent'}` }));
  if (view === 'milestones') data.milestones?.forEach((r) => items.push({ id: r.id, label: r.label, detail: `Raise ${r.raiseId}` }));
  if (view === 'structured')
    data.records?.forEach((r) => items.push({ id: r.id, label: r.name, detail: r.legLabels.join(' · ') || 'No leg labels' }));
  if (view === 'custody')
    data.approvals?.forEach((r) =>
      items.push({ id: r.id, label: `${r.fromTier} → ${r.toTier}`, detail: `${r.status} · amount metadata: ${r.amount ?? 'absent'}` }),
    );
  return (
    <div className="adm-stack">
      {data.identity && (
        <p className="adm-footnote">
          Identity source: {data.identity.status} {data.identity.code && <code>{data.identity.code}</code>}.{' '}
          {data.support && (
            <>
              Support source: {data.support.status} <code>{data.support.code}</code>.
            </>
          )}
        </p>
      )}
      {view === 'revenue' ? (
        <>
          <p>
            Freshness: {data.freshness}.{' '}
            <Chip tone={data.mayLabelLive ? 'live' : 'warn'}>{data.mayLabelLive ? 'Service permits live label' : 'Not live'}</Chip>
          </p>
          {data.points?.length ? (
            <div className="adm-scroll" tabIndex={0} role="region" aria-label="Revenue metrics">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Value</th>
                    <th>Dimension</th>
                  </tr>
                </thead>
                <tbody>
                  {data.points.map((point, i) => (
                    <tr key={`${point.metricId}-${i}`}>
                      <td>{point.metricId}</td>
                      <td className="adm-num">{point.value}</td>
                      <td>{point.dim ?? 'absent'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No warehouse metric points were returned.</p>
          )}
        </>
      ) : (
        <>
          {view === 'custody' && (
            <>
              <dl className="adm-kv">
                <dt>Wrap policy</dt>
                <dd>
                  {data.wrap?.status} <code>{data.wrap?.code}</code>
                </dd>
                <dt>Freeze policy</dt>
                <dd>
                  {data.freeze?.status} <code>{data.freeze?.code}</code>
                </dd>
              </dl>
              {data.tiers?.map((tier) => (
                <div key={tier.id}>
                  <h3>{tier.id} key references</h3>
                  {tier.keys.length ? (
                    <ul>
                      {tier.keys.map((key) => (
                        <li key={key.id}>
                          {key.label} · <code>{key.id}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No key references returned.</p>
                  )}
                </div>
              ))}
            </>
          )}
          {items.length ? (
            <ul className="adm-ops-records">
              {items.map((r) => (
                <li key={r.id}>
                  <div>
                    <strong>{r.label}</strong>
                    <p className="adm-desc">{r.detail}</p>
                  </div>
                  <code>{r.id}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No {view === 'custody' ? 'approval records' : LABELS[view].toLowerCase()} returned in this authorized read.</p>
          )}
        </>
      )}
    </div>
  );
}
