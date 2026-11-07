'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KIND_WORD, KINDS, RISK_SIGNALS, RISK_WORD, type Kind, type RiskSignal } from '@/lib/agents-fleet/model';

/**
 * The agent fleet desk (AG-registry-01, AG-control-02): every agent on the platform as svc-agents stores it, with its
 * owner, publisher, channels and risk signals, the counts over the whole fleet, an audited CSV export of the filtered
 * rows, and the switches. Quarantine and a kind kill take one operator; every restore takes two distinct founders, and
 * the service holds that rule, not this page. A value not stored reads "not set", never a guess.
 */

interface Switch {
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly restoreRequestedBy: string | null;
}

interface Row {
  readonly ref: string;
  readonly name: string | null;
  readonly kind: Kind;
  readonly ownerId: string | null;
  readonly publisherId: string | null;
  readonly channels: readonly string[] | null;
  readonly riskSignals: readonly RiskSignal[];
  readonly status: 'active' | 'quarantined' | 'disabled_by_kind' | 'disabled';
  readonly lastRunAt: string | null;
  readonly quarantine: Switch | null;
  readonly kindSwitch: Switch | null;
}

interface Registry {
  readonly counts: { total: number; ownerless: number; unmanaged: number; disabled: number; quarantined: number };
  readonly rows: readonly Row[];
  readonly filtered: number;
  readonly more: boolean;
  readonly limit: number;
  readonly handles: Readonly<Record<string, string>>;
  readonly me: string;
  /** Identity did not name the accounts: the page shows account ids instead of handles. */
  readonly handlesUnread: boolean;
  /** The filter this answer is for: the matching count shows only for the filter on screen. */
  readonly riskFor: RiskSignal | '';
}

const NOT_SET = 'not set';
const STATUS_WORD: Record<Row['status'], string> = {
  active: 'Active',
  quarantined: 'Quarantined',
  disabled_by_kind: 'Disabled by kind',
  disabled: 'Disabled',
};
const CHANNEL_WORD: Record<string, string> = { my_agents: 'My agents', chat: 'Chat' };

const WORDS: Record<string, string> = {
  'agents.registry_list_limit_unset': 'The owner has not set how many agents one read shows, so the registry cannot be read yet.',
  'agents.reason_required': 'A reason is required.',
  'agents.agent_not_found': 'svc-agents has no such agent.',
  'agents.fleet_not_quarantined': 'This agent is not quarantined.',
  'agents.fleet_already_quarantined': 'This agent is already quarantined.',
  'agents.fleet_kind_not_off': 'This kind is not switched off.',
  'agents.fleet_kind_already_off': 'This kind is already switched off.',
  'agents.fleet_owner_present': 'This agent has an owner; it is never taken from them.',
  'agents.fleet_request_reused': 'This request was already used for something else. Try again.',
  'admin.agents_log_customer_not_found': 'No account has this handle.',
  'admin.agents_log_handle_too_common': 'Too many accounts start with this handle to find it here. Use the account id.',
  'admin.agents_log_customer_invalid': 'Type the new owner’s whole handle or their account id.',
};
const say = (code: string): string => `${WORDS[code] ?? 'The service refused this.'} (${code})`;
const requestId = (kind: string): string => `agents-fleet:${kind}:${crypto.randomUUID()}`;

type Sheet =
  | { readonly kind: 'quarantine'; readonly row: Row }
  | { readonly kind: 'reassign'; readonly row: Row }
  | { readonly kind: 'killKind' }
  | null;

export function AgentsFleetDesk({ csrf }: { csrf: string }) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [risk, setRisk] = useState<RiskSignal | ''>('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState(false);
  // Only the latest read fills the table: an earlier filter's answer that lands late is dropped.
  const latest = useRef(0);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> => {
      const response = await fetch('/api/agents-fleet', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!response) return { ok: false, code: 'admin.upstream_unavailable' };
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, code: (data as { code?: string } | null)?.code ?? `http.${response.status}` };
      return { ok: true, data };
    },
    [csrf],
  );

  const read = useCallback(
    async (riskSignal: RiskSignal | '') => {
      const mine = ++latest.current;
      const answer = await post({ action: 'registry', riskSignal });
      if (mine !== latest.current) return;
      if (!answer.ok) {
        setProblem(say(answer.code));
        return;
      }
      setProblem(null);
      setRegistry({ ...(answer.data as Omit<Registry, 'riskFor'>), riskFor: riskSignal });
    },
    [post],
  );

  useEffect(() => {
    void read('');
  }, [read]);

  /** Runs one switch and re-reads the stored state; a lost answer is never repeated with a new key. */
  async function act(body: Record<string, unknown>, done: (data: Record<string, unknown>) => string) {
    setBusy(true);
    const answer = await post(body);
    setBusy(false);
    if (!answer.ok) {
      setProblem(say(answer.code));
      await read(risk);
      return;
    }
    setSheet(null);
    setNotice(done(answer.data as Record<string, unknown>));
    await read(risk);
  }

  async function exportRows() {
    setBusy(true);
    const answer = await post({ action: 'export', riskSignal: risk, requestId: requestId('export') });
    setBusy(false);
    if (!answer.ok) {
      setProblem(say(answer.code));
      return;
    }
    const { csv, rows } = answer.data as { csv: string; rows: number };
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-fleet${risk ? `-${risk}` : ''}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(`Export recorded in the audit log: ${rows} ${rows === 1 ? 'agent' : 'agents'}.`);
  }

  const who = (id: string | null): string => (id === null ? NOT_SET : (registry?.handles[id.toLowerCase()] ?? id));
  const offKinds = KINDS.flatMap((kind) => {
    const sw = registry?.rows.find((row) => row.kind === kind && row.kindSwitch)?.kindSwitch ?? null;
    return sw ? [{ kind, sw }] : [];
  });

  return (
    <div className="dk-stack" data-testid="agents-fleet">
      <h1>Agent fleet</h1>
      <p className="dk-muted">
        Every agent on the platform as svc-agents stores it. Quarantine and a kind kill take one operator; a restore takes two different
        founders. Every switch and every export is written to the audit log.
      </p>
      {problem && (
        <p role="alert" className="adm-callout" data-tone="warn">
          {problem}
        </p>
      )}
      {notice && (
        <p role="status" className="adm-callout" data-tone="info">
          {notice}
        </p>
      )}
      {registry && (
        <>
          {registry.handlesUnread && <p className="dk-muted">Identity did not answer, so accounts show as ids, not handles.</p>}
          <dl className="dk-row">
            <div>
              <dt>Total</dt>
              <dd data-testid="fleet-total">{registry.counts.total}</dd>
            </div>
            <div>
              <dt>Ownerless</dt>
              <dd data-testid="fleet-ownerless">{registry.counts.ownerless}</dd>
            </div>
            <div>
              <dt>Unmanaged</dt>
              <dd data-testid="fleet-unmanaged">{registry.counts.unmanaged}</dd>
            </div>
            <div>
              <dt>Quarantined</dt>
              <dd data-testid="fleet-quarantined">{registry.counts.quarantined}</dd>
            </div>
            <div>
              <dt>Disabled</dt>
              <dd data-testid="fleet-disabled">{registry.counts.disabled}</dd>
            </div>
          </dl>
          <div className="dk-row">
            <label>
              Risk signal
              <select
                value={risk}
                onChange={(event) => {
                  const next = event.target.value as RiskSignal | '';
                  setRisk(next);
                  setNotice(null);
                  void read(next);
                }}
              >
                <option value="">All agents</option>
                {RISK_SIGNALS.map((signal) => (
                  <option key={signal} value={signal}>
                    {RISK_WORD[signal]}
                  </option>
                ))}
              </select>
            </label>
            <p>Matching: {registry.riskFor === risk ? <span data-testid="fleet-filtered">{registry.filtered}</span> : '…'}</p>
            <button type="button" className="adm-btn" onClick={() => void exportRows()} disabled={busy}>
              Export CSV (every matching agent)
            </button>
            <button type="button" className="adm-btn" onClick={() => setSheet({ kind: 'killKind' })} disabled={busy}>
              Kill a kind
            </button>
          </div>
          {offKinds.map(({ kind, sw }) => (
            <div key={kind} className="adm-callout" data-tone="warn">
              <p>
                {KIND_WORD[kind]} agents are switched off by <span data-testid="kind-operator">{who(sw.setBy)}</span>: {sw.reason}
              </p>
              {sw.restoreRequestedBy === null ? (
                <button
                  type="button"
                  className="adm-btn"
                  disabled={busy}
                  aria-label={`Restore a kind (${KIND_WORD[kind]})`}
                  onClick={() =>
                    void act(
                      { action: 'restoreKind', kind, requestId: requestId('restore-kind') },
                      () => `Restore of ${KIND_WORD[kind]} waiting for a second founder.`,
                    )
                  }
                >
                  Restore a kind
                </button>
              ) : sw.restoreRequestedBy.toLowerCase() === registry.me ? (
                <p>Restore of {KIND_WORD[kind]} waiting for a second founder.</p>
              ) : (
                <button
                  type="button"
                  className="adm-btn"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      { action: 'restoreKind', kind, requestId: requestId('restore-kind') },
                      () => `${KIND_WORD[kind]} agents restored.`,
                    )
                  }
                >
                  Confirm restore of {KIND_WORD[kind]}
                </button>
              )}
            </div>
          ))}
          <section role="region" aria-label="Agents on the platform">
            {registry.rows.length === 0 ? (
              <p className="dk-muted">No agent matches.</p>
            ) : (
              <div className="dk-table-wrap">
                <table className="dk-table">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Publisher</th>
                      <th scope="col">Channels</th>
                      <th scope="col">Risk signals</th>
                      <th scope="col">Status</th>
                      <th scope="col">Set by</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registry.rows.map((row) => (
                      <FleetRow
                        key={row.ref}
                        row={row}
                        me={registry.me}
                        who={who}
                        busy={busy}
                        onSheet={setSheet}
                        onRestore={() =>
                          void act({ action: 'restore', ref: row.ref, requestId: requestId('restore') }, (data) =>
                            data.outcome === 'restored' ? 'Agent restored.' : 'Restore waiting for a second founder.',
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {registry.more && <p className="dk-muted">More agents match than one read shows ({registry.limit}). Narrow the filter.</p>}
          </section>
        </>
      )}
      {sheet && (
        <SheetDialog
          sheet={sheet}
          busy={busy}
          onCancel={() => setSheet(null)}
          onSubmit={(fields) => {
            if (sheet.kind === 'quarantine')
              void act(
                { action: 'quarantine', ref: sheet.row.ref, reason: fields.reason, requestId: requestId('quarantine') },
                () => 'Agent quarantined: 1 audited action.',
              );
            else if (sheet.kind === 'reassign')
              void act(
                { action: 'reassign', ref: sheet.row.ref, owner: fields.owner, requestId: requestId('reassign') },
                () => 'Owner set.',
              );
            else
              void act({ action: 'killKind', kind: fields.kind, reason: fields.reason, requestId: requestId('kill-kind') }, (data) => {
                const n = typeof data.agents === 'number' ? data.agents : 0;
                return `${KIND_WORD[fields.kind as Kind]}: ${n} ${n === 1 ? 'agent' : 'agents'} switched off in 1 audited action.`;
              });
          }}
        />
      )}
    </div>
  );
}

function FleetRow({
  row,
  me,
  who,
  busy,
  onSheet,
  onRestore,
}: {
  row: Row;
  me: string;
  who: (id: string | null) => string;
  busy: boolean;
  onSheet: (sheet: Sheet) => void;
  onRestore: () => void;
}) {
  const setter = row.quarantine ?? row.kindSwitch;
  const pending = row.quarantine?.restoreRequestedBy ?? null;
  return (
    <tr data-agent-ref={row.ref}>
      <td>{row.name ?? NOT_SET}</td>
      <td>{KIND_WORD[row.kind]}</td>
      <td data-testid="fleet-owner">{row.ownerId === null ? 'No owner' : who(row.ownerId)}</td>
      <td>{who(row.publisherId)}</td>
      <td>{row.channels && row.channels.length > 0 ? row.channels.map((c) => CHANNEL_WORD[c] ?? c).join(', ') : NOT_SET}</td>
      <td>{row.riskSignals.length > 0 ? row.riskSignals.map((s) => RISK_WORD[s]).join(', ') : 'None'}</td>
      <td data-testid="fleet-status">
        {STATUS_WORD[row.status]}
        {setter ? ` · ${setter.reason}` : ''}
      </td>
      <td>{setter ? <span data-testid="audit-operator">{who(setter.setBy)}</span> : '—'}</td>
      <td>
        {row.quarantine === null ? (
          <button type="button" className="adm-btn" disabled={busy} onClick={() => onSheet({ kind: 'quarantine', row })}>
            Quarantine
          </button>
        ) : pending === null ? (
          <button type="button" className="adm-btn" disabled={busy} onClick={onRestore}>
            Restore
          </button>
        ) : pending.toLowerCase() === me ? (
          <span>Restore waiting for a second founder</span>
        ) : (
          <button type="button" className="adm-btn" disabled={busy} onClick={onRestore}>
            Confirm restore
          </button>
        )}
        {row.ownerId === null && row.kind === 'product' ? (
          <button type="button" className="adm-btn" disabled={busy} onClick={() => onSheet({ kind: 'reassign', row })}>
            Reassign
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function SheetDialog({
  sheet,
  busy,
  onCancel,
  onSubmit,
}: {
  sheet: Exclude<Sheet, null>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (fields: { reason: string; owner: string; kind: Kind }) => void;
}) {
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState('');
  const [kind, setKind] = useState<Kind>('customer_built');
  const title = sheet.kind === 'quarantine' ? 'Quarantine agent' : sheet.kind === 'reassign' ? 'Reassign agent' : 'Kill a kind';
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="adm-callout" data-tone="info">
      <h2>{title}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ reason, owner, kind });
        }}
      >
        {sheet.kind !== 'killKind' && <p>{sheet.row.name ?? sheet.row.ref}</p>}
        {sheet.kind === 'killKind' && (
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_WORD[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        {sheet.kind === 'reassign' ? (
          <label>
            New owner (handle or account id)
            <input value={owner} onChange={(event) => setOwner(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        ) : (
          <label>
            Reason (written to the audit log)
            <input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
          </label>
        )}
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
          {sheet.kind === 'quarantine' ? 'Quarantine' : sheet.kind === 'reassign' ? 'Reassign' : 'Kill every agent of this kind'}
        </button>
        <button type="button" className="adm-btn" onClick={onCancel}>
          Cancel
        </button>
      </form>
    </div>
  );
}
