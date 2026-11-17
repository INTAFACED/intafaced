'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The outside assistant connections desk (J-agents-21 #15; AG-outside-04, AG-control-02): each person's own assistant,
 * connected through one of their agent API keys to one of their agent accounts, with the person, the account's cap, its
 * balance as the venue reports it, the key's state and its last call. Quarantine takes one founder and a reason: identity
 * revokes the key, so its next call is refused, and svc-trade ends the connection and writes the audit row naming the
 * founder and the reason. Below, that audit log as svc-trade stores it, re-read after every action. A value that could
 * not be read says so, never a guess.
 */

type Known<T> = { readonly known: true; readonly value: T } | { readonly known: false };

interface Quarantine {
  readonly operatorId: string;
  readonly reason: string;
  readonly at: string;
  readonly requestId: string;
}

interface Row {
  readonly keyId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly connectedAt: string;
  readonly endedAt: string | null;
  readonly asset: string | null;
  readonly cap: string | null;
  readonly accountStatus: string | null;
  readonly balance: Known<string>;
  readonly keyState: 'live' | 'revoked' | 'missing' | 'unknown';
  readonly lastAction: Known<{ at: string; method: string; path: string; status: number } | null>;
  readonly quarantine: Quarantine | null;
}

interface Connections {
  readonly rows: readonly Row[];
  readonly more: boolean;
  readonly limit: number;
  readonly test: boolean | null;
  readonly handles: Readonly<Record<string, string>>;
  readonly handlesUnread: boolean;
}

interface AuditRow extends Quarantine {
  readonly id: string;
  readonly action: string;
  readonly keyId: string;
  readonly userId: string;
}

interface Audit {
  readonly rows: readonly AuditRow[];
  readonly limit: number;
  readonly handles: Readonly<Record<string, string>>;
  readonly handlesUnread: boolean;
}

const KEY_WORD: Record<Row['keyState'], string> = { live: 'Live', revoked: 'Revoked', missing: 'Not found', unknown: 'Not read' };
const WORDS: Record<string, string> = {
  'agents.desk_reason_required': 'A reason is required.',
  'agents.desk_request_invalid': 'This request is not valid. Try again.',
  'agents.key_not_connected': 'This key trades no agent account.',
  'agents.desk_unavailable': 'The outside connections desk is off on this stack.',
  'identity.revoke_reason_unset': 'A reason is required.',
  'mfa.required': 'Sign in with your second factor to quarantine.',
  'operator.denied': 'Your session may not quarantine.',
};
const say = (code: string): string => `${WORDS[code] ?? 'The service refused this.'} (${code})`;

export function AgentsOutsideDesk({ csrf }: { csrf: string }) {
  const [connections, setConnections] = useState<Connections | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [auditProblem, setAuditProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  // One request id per opened sheet: a lost answer is asked again with the same id, never a new one.
  const pending = useRef<string | null>(null);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> => {
      const response = await fetch('/api/agents-outside', {
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

  const read = useCallback(async () => {
    const mine = ++latest.current;
    const [list, log] = await Promise.all([post({ action: 'connections' }), post({ action: 'audit' })]);
    if (mine !== latest.current) return;
    if (list.ok) {
      setProblem(null);
      setConnections(list.data as Connections);
    } else setProblem(say(list.code));
    if (log.ok) {
      setAuditProblem(null);
      setAudit(log.data as Audit);
    } else setAuditProblem(say(log.code));
  }, [post]);

  useEffect(() => {
    void read();
  }, [read]);

  async function quarantine(row: Row, reason: string) {
    pending.current ??= `agents-outside:quarantine:${crypto.randomUUID()}`;
    setBusy(true);
    const answer = await post({ action: 'quarantine', keyId: row.keyId, reason, requestId: pending.current });
    setBusy(false);
    if (!answer.ok) {
      setProblem(say(answer.code));
      await read();
      return;
    }
    pending.current = null;
    setSheet(null);
    setNotice('Connection quarantined: the key is revoked and the audit log names you and your reason.');
    await read();
  }

  const who = (handles: Readonly<Record<string, string>> | undefined, id: string): string => handles?.[id.toLowerCase()] ?? id;

  return (
    <section className="dk-stack" role="region" aria-label="Outside assistant connections" data-testid="agents-outside">
      <h2>Outside assistant connections</h2>
      <p className="dk-muted">
        Each person&apos;s own assistant, trading their own agent account through an agent API key. Balances are as the venue reports them
        {connections?.test ? ' (TEST venue)' : ''}. Quarantine revokes the key and ends the connection; it takes a reason, written to the
        audit log.
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
      {connections && (
        <>
          {connections.handlesUnread && <p className="dk-muted">Identity did not answer, so people show as ids, not handles.</p>}
          {connections.rows.length === 0 ? (
            <p className="dk-muted">No outside assistant is connected yet.</p>
          ) : (
            <div className="dk-table-wrap">
              <table className="dk-table">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Agent account</th>
                    <th scope="col">Cap</th>
                    <th scope="col">Balance</th>
                    <th scope="col">Key</th>
                    <th scope="col">Last action</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.rows.map((row) => (
                    <tr key={`${row.keyId}:${row.connectedAt}`} data-key-id={row.keyId}>
                      <td data-testid="outside-person">{who(connections.handles, row.userId)}</td>
                      <td>
                        <code>{row.accountId}</code>
                        {row.accountStatus ? ` · ${row.accountStatus}` : ''}
                      </td>
                      <td data-testid="outside-cap">{row.cap === null ? 'Not read' : `${row.cap} ${row.asset ?? ''}`.trim()}</td>
                      <td data-testid="outside-balance">
                        {row.balance.known ? `${row.balance.value} ${row.asset ?? ''}`.trim() : 'Not read from the venue'}
                      </td>
                      <td data-testid="outside-key">
                        {KEY_WORD[row.keyState]} · <code>{row.keyId}</code>
                      </td>
                      <td data-testid="outside-last-action">
                        {!row.lastAction.known
                          ? 'Not read'
                          : row.lastAction.value === null
                            ? 'No call yet'
                            : `${row.lastAction.value.at} · ${row.lastAction.value.method} ${row.lastAction.value.path} · ${row.lastAction.value.status}`}
                      </td>
                      <td data-testid="outside-status">
                        {row.quarantine
                          ? `Quarantined by ${who(connections.handles, row.quarantine.operatorId)} · ${row.quarantine.reason}`
                          : row.endedAt
                            ? 'Ended'
                            : 'Connected'}
                      </td>
                      <td>
                        {row.quarantine === null && row.endedAt === null ? (
                          <button
                            type="button"
                            className="adm-btn"
                            disabled={busy}
                            onClick={() => {
                              pending.current = null;
                              setNotice(null);
                              setSheet(row);
                            }}
                          >
                            Quarantine
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {connections.more && <p className="dk-muted">More connections exist than one read shows ({connections.limit}).</p>}
        </>
      )}
      {auditProblem && (
        <p role="alert" className="adm-callout" data-tone="warn">
          The audit log could not be read: {auditProblem}
        </p>
      )}
      {audit && (
        <section role="region" aria-label="Outside connections audit log">
          <h3>Outside connections audit log</h3>
          {audit.rows.length === 0 ? (
            <p className="dk-muted">No switch has been recorded yet.</p>
          ) : (
            <div className="dk-table-wrap">
              <table className="dk-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Operator</th>
                    <th scope="col">Action</th>
                    <th scope="col">Person</th>
                    <th scope="col">Key</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.rows.map((row) => (
                    <tr key={row.id} data-key-id={row.keyId}>
                      <td>{row.at}</td>
                      <td data-testid="outside-audit-operator">{who(audit.handles, row.operatorId)}</td>
                      <td>{row.action === 'quarantine' ? 'Quarantine' : row.action}</td>
                      <td>{who(audit.handles, row.userId)}</td>
                      <td>
                        <code>{row.keyId}</code>
                      </td>
                      <td data-testid="outside-audit-reason">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="dk-muted">The newest {audit.limit} rows, newest first.</p>
        </section>
      )}
      {sheet && (
        <QuarantineDialog row={sheet} busy={busy} onCancel={() => setSheet(null)} onSubmit={(reason) => void quarantine(sheet, reason)} />
      )}
    </section>
  );
}

function QuarantineDialog({
  row,
  busy,
  onCancel,
  onSubmit,
}: {
  row: Row;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div role="dialog" aria-modal="true" aria-label="Quarantine connection" className="adm-callout" data-tone="info">
      <h3>Quarantine connection</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(reason);
        }}
      >
        <p>
          Key <code>{row.keyId}</code> on agent account <code>{row.accountId}</code>
        </p>
        <label>
          Reason (written to the audit log)
          <input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
        </label>
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
          Quarantine
        </button>
        <button type="button" className="adm-btn" onClick={onCancel}>
          Cancel
        </button>
      </form>
    </div>
  );
}
