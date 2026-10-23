'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import type { AccountControlResult, AccountControlState, AccountControlTarget } from '@intafaced/contracts';
import { ACCOUNT_GAPS, ACCOUNT_LINKS } from '@/lib/ops-desk/accounts-gaps';
import { formatAsOf } from '@/lib/as-of';
import { ControlDesk } from '@/components/control-desk';

function controlExplanation(area: 'identity' | 'trading' | 'merchant'): string {
  if (area === 'identity')
    return 'Identity restrictions revoke current sessions and credentials. Restoration requires a new sign-in and does not revive revoked credentials.';
  if (area === 'trading')
    return 'Trading restrictions apply to new trading operations. Existing admitted operations retain their recovery rules.';
  return 'Merchant restrictions apply to new merchant operations. Previously admitted recovery remains bound to the original operation.';
}

function resultText(result: AccountControlResult): string {
  if (result.outcome === 'changed') return `Account ${result.action === 'restrict' ? 'restricted' : 'restored'}.`;
  if (result.outcome === 'noop') return 'The account already had the requested state.';
  if (result.outcome === 'conflict') return 'The account changed since inspection. Review the current state.';
  return 'The service refused this action.';
}

export function AccountControls({ csrf, founderId }: { csrf: string; founderId: string }) {
  const [area, setArea] = useState<'identity' | 'trading' | 'merchant'>('identity');
  const [id, setId] = useState('');
  const [state, setState] = useState<AccountControlState | null>(null);
  const [history, setHistory] = useState<AccountControlResult[]>([]);
  const [result, setResult] = useState<AccountControlResult | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const target: AccountControlTarget = area === 'merchant' ? { area, merchantId: id } : { area, userId: id };
  const controlAction = state?.restricted ? 'Restore access' : 'Restrict access';
  async function read(path: string) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'Your founder session was refused. Sign in again.'
          : 'The control service could not confirm this account. No change has been requested.',
      );
    return (await response.json()) as unknown;
  }
  async function inspect() {
    setReadAt(null);
    const params = new URLSearchParams({ area, id });
    const current = (await read(`/api/accounts?${params}`)) as AccountControlState | null;
    if (!current) throw new Error('Account not found.');
    setState(current);
    setReadAt(new Date().toISOString());
    const events = (await read(`/api/accounts?${params}&history=true&limit=50`)) as AccountControlResult[];
    setHistory(events);
  }
  return (
    <section className="adm-workspace">
      <p className="adm-eyebrow">Account administration</p>
      <h1>Account controls</h1>
      <p>Inspect an account before restricting or restoring access. Every attempt records your identity and reason.</p>
      <form
        className="adm-filters"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setState(null);
          setResult(null);
          setHistory([]);
          setConfirmed(false);
          try {
            await inspect();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Inspection failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Account area
          <select
            disabled={busy}
            value={area}
            onChange={(event) => {
              setArea(event.target.value as typeof area);
              setState(null);
              setHistory([]);
              setResult(null);
            }}
          >
            <option value="identity">Identity access</option>
            <option value="trading">Trading operations</option>
            <option value="merchant">Merchant operations</option>
          </select>
        </label>
        <label>
          {area === 'merchant' ? 'Merchant ID' : 'Platform user ID'}
          <input
            disabled={busy}
            required
            value={id}
            onChange={(event) => {
              setId(event.target.value.trim());
              setState(null);
              setHistory([]);
              setResult(null);
            }}
            pattern="[0-9a-fA-F-]{36}"
            maxLength={36}
            autoComplete="off"
          />
        </label>
        <button disabled={busy}>Inspect account</button>
      </form>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {state && (
        <div className="adm-control-card">
          <h2>{state.restricted ? 'Restricted' : 'Access permitted'}</h2>
          {readAt && (
            <p className="adm-subtle" data-testid="account-asof">
              As of {formatAsOf(readAt)} (when this console read the account)
            </p>
          )}
          <p className="adm-subtle">{controlExplanation(area)}</p>
          {area === 'identity' && state.restricted ? (
            <div data-testid="account-unfreeze">
              <ControlDesk
                key={`${id}:${state.version}`}
                endpoint="/api/accounts/restore"
                userId={founderId}
                blockedReason={null}
                action={{
                  heading: 'Lift this account’s freeze',
                  submitLabel: 'Ask a second founder to approve lifting the freeze',
                  needsReason: true,
                  reasonLabel: 'Why (kept in the account’s control history, 12 to 500 characters)',
                  build: (why) => ({ kind: 'identity.account.unfreeze', userId: id.toLowerCase(), reason: why, version: state.version }),
                }}
                consequence="Two different people must agree: you make the request here, a different founder pastes the packet on their own console and approves it, and then either of you runs it. Identity spends the approval once and refuses a founder approving their own request."
                blockedButtonLabel="Restore unavailable"
                onChanged={() => {
                  void inspect().catch(() => setError('The account could not be read again. Inspect the account again.'));
                }}
              />
            </div>
          ) : (
            <form
              className="adm-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!confirmed) return;
                setBusy(true);
                setError('');
                setResult(null);
                const input = {
                  target,
                  action: state.restricted ? 'restore' : 'restrict',
                  reason: reason.trim(),
                  expectedVersion: state.version,
                };
                const key = JSON.stringify(input);
                const requestId = pending.current?.key === key ? pending.current.requestId : crypto.randomUUID();
                pending.current = { key, requestId };
                try {
                  const response = await fetch('/api/accounts', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
                    body: JSON.stringify({ ...input, requestId }),
                  });
                  if (!response.ok)
                    throw new Error(
                      'The change could not be confirmed. Inspect the account before retrying; the request is retained for a safe retry.',
                    );
                  const value = (await response.json()) as AccountControlResult;
                  setResult(value);
                  pending.current = null;
                  setConfirmed(false);
                  if ('after' in value) setState(value.after);
                  else if (value.current) setState(value.current);
                  try {
                    await inspect();
                  } catch {
                    setError(
                      'The service confirmed the outcome below, but the latest account history could not be loaded. Inspect the account again.',
                    );
                  }
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : 'Change unavailable.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Reason
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label className="adm-check">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this
                account and intend to {state.restricted ? 'restore' : 'restrict'} this area.
              </label>
              <button className={state.restricted ? '' : 'adm-danger-button'} disabled={busy || !confirmed || reason.trim().length < 3}>
                {busy ? 'Waiting for confirmation…' : controlAction}
              </button>
            </form>
          )}
        </div>
      )}
      {result && (
        <p role={result.outcome === 'refused' || result.outcome === 'conflict' ? 'alert' : 'status'}>
          {resultText(result)} <small>Reference {result.auditId}</small>
        </p>
      )}
      <h2>What this desk cannot show</h2>
      <div data-testid="account-gaps">
        {ACCOUNT_GAPS.map((g) => (
          <div key={g.id} className="adm-callout" data-tone="warn">
            <strong>Not available: {g.label}</strong>
            <p>{g.reason}</p>
            <p className="adm-subtle">Back-end need {g.need} in the console’s needs list.</p>
          </div>
        ))}
        <ul>
          {ACCOUNT_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href}>{l.label}</Link> <span className="adm-subtle">{l.why}</span>
            </li>
          ))}
        </ul>
      </div>
      {state && (
        <>
          <h2>Control history</h2>
          {history.length === 0 ? (
            <p>No recorded control attempts.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table">
                <caption className="adm-sr-only">Most recent 50 control attempts</caption>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Outcome</th>
                    <th>Actor</th>
                    <th>Approved by</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((event) => (
                    <tr key={event.auditId}>
                      <td>{new Date(event.occurredAt).toLocaleString()}</td>
                      <td>{event.action}</td>
                      <td>{event.outcome}</td>
                      <td>{event.actorUserId?.slice(0, 8) ?? 'Unauthenticated'}</td>
                      <td>{'approverUserId' in event && event.approverUserId ? event.approverUserId.slice(0, 8) : '—'}</td>
                      <td>{event.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
