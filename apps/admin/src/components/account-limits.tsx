'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AccountLimitOverride, AccountLimitResult, AccountLimitsState } from '@intafaced/contracts';
import { ControlDesk } from '@/components/control-desk';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { aboveCeiling, allowanceRefusal, ceilingFor, overrideFigures, type AllowanceRow } from '@/lib/accounts/limits';

/** As identity's figure: at most 20 whole digits and 18 decimals. */
const FIGURE = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;

/** The end time of an override that lasts `minutes` from now, to the second: taken when it is sent, never earlier. */
function endsAfter(minutes: number): string {
  return new Date(Math.floor((Date.now() + minutes * 60_000) / 1000) * 1000).toISOString();
}
const RAIL = 'withdrawal';

function figureOf(text: string): string | null | undefined {
  const value = text.trim();
  if (value === '') return null;
  return FIGURE.test(value) && !/^0(?:\.0+)?$/.test(value) ? value : undefined;
}

function statusText(row: AccountLimitOverride): string {
  if (row.status === 'active') return 'In force';
  if (row.status === 'expired') return 'Ended at its stored time: the base limit applies';
  return `Ended early by ${row.clearedBy?.slice(0, 8) ?? 'a founder'}: the base limit applies`;
}

function historyText(event: AccountLimitResult): string {
  if (event.outcome === 'refused') return `refused (${event.code})${event.ceiling ? ` · ceiling ${event.ceiling}` : ''}`;
  if (event.outcome === 'conflict') return 'conflict (restriction.version_conflict)';
  return event.action === 'clear' ? 'ended early' : `set: ${overrideFigures(event.after)}`;
}

/**
 * What svc-pay, which enforces the withdrawal limit, applies to this customer now for each asset: the base figure for their
 * verification level, an override in force, what the last 24 hours used and what is left. Read again whenever `reading`
 * changes, so an override set or ended here shows at once.
 */
function WithdrawalAllowances({ userId, reading }: { userId: string; reading: string }) {
  /** undefined while reading; a string when svc-pay could not be read at all. */
  const [rows, setRows] = useState<AllowanceRow[] | string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/accounts/limits/allowance?id=${encodeURIComponent(userId)}`, { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as { rows?: AllowanceRow[]; upstream?: string; code?: string } | null;
        const next = res.ok && Array.isArray(body?.rows) ? body.rows : allowanceRefusal(body?.upstream ?? body?.code ?? null);
        if (live) setRows(next);
      } catch {
        if (live) setRows(allowanceRefusal(null));
      }
    })();
    return () => {
      live = false;
    };
  }, [userId, reading]);

  return (
    <>
      <h3>Withdrawal limits now (svc-pay)</h3>
      {rows === undefined ? (
        <p className="adm-subtle">Reading what svc-pay applies…</p>
      ) : typeof rows === 'string' ? (
        <p className="adm-alert" role="alert" data-testid="account-limits-allowance-refused">
          {rows}
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="account-limits-allowance-none">
          svc-pay has no withdrawal limit set for any asset, so it refuses every withdrawal (pay.guard_withdrawal_limit_unset).
        </p>
      ) : (
        <div className="adm-table-scroll">
          <table className="adm-crm-table" data-testid="account-limits-allowance">
            <caption className="adm-sr-only">The withdrawal limits svc-pay applies to this customer now</caption>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Base (verification level)</th>
                <th>Override</th>
                <th>In force</th>
                <th>Used, last 24 hours</th>
                <th>Left</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((one) => {
                if ('refused' in one)
                  return (
                    <tr key={one.assetId} data-testid={`account-allowance-${one.assetId}`}>
                      <td>{one.assetId}</td>
                      <td colSpan={5}>{allowanceRefusal(one.refused)}</td>
                    </tr>
                  );
                const row = one.allowance;
                return (
                  <tr key={one.assetId} data-testid={`account-allowance-${one.assetId}`}>
                    <td>{one.assetId}</td>
                    <td>
                      {overrideFigures(row.base)} <span className="adm-subtle">(level {row.tier})</span>
                    </td>
                    <td>
                      {row.override
                        ? `${overrideFigures(row.override)} until ${new Date(row.override.expiresAt).toLocaleString()}`
                        : 'No override'}
                    </td>
                    <td>{overrideFigures(row)}</td>
                    <td>{row.used24h}</td>
                    <td>
                      per transaction {row.remaining.perTx} · over 24 hours {row.remaining.rolling24h} · most now {row.maxNow}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Limit overrides of one customer (J-ops-console-04 #12): the owner policy (longest lifetime, ceilings), each override
 * with its stored end time and status, a new override, and ending one early. At or under the owner ceiling one founder
 * sets it here; above it, it is a two-founder request (you propose, the other founder approves on their own console, you
 * run it). After the stored end time identity stops answering with the override, and the base limit applies again.
 */
export function AccountLimits({
  userId,
  founderId,
  readOnly = null,
}: {
  userId: string;
  founderId: string;
  /** Why nothing here may change (an archived record), or null. */
  readOnly?: string | null;
}) {
  const id = userId.toLowerCase();
  /** undefined while reading or unreadable, null when identity has no such customer. */
  const [state, setState] = useState<AccountLimitsState | null | undefined>(undefined);
  const [history, setHistory] = useState<AccountLimitResult[] | null>([]);
  const [error, setError] = useState('');
  const [assetId, setAssetId] = useState('');
  const [perTx, setPerTx] = useState('');
  const [rolling, setRolling] = useState('');
  const [minutes, setMinutes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    const query = encodeURIComponent(id);
    const [stateResponse, historyResponse] = await Promise.all([
      fetch(`/api/accounts/limits?id=${query}`, { cache: 'no-store' }),
      fetch(`/api/accounts/limits?id=${query}&history=true&limit=50`, { cache: 'no-store' }),
    ]);
    if (!stateResponse.ok) {
      setState(undefined);
      setError('Identity (svc-identity) did not answer for this customer’s limit overrides. Nothing can be changed until it does.');
      return;
    }
    setState((await stateResponse.json()) as AccountLimitsState | null);
    setHistory(historyResponse.ok ? ((await historyResponse.json()) as AccountLimitResult[]) : null);
  }, [id]);

  useEffect(() => {
    void load().catch(() => setError('Identity (svc-identity) did not answer for this customer’s limit overrides.'));
  }, [load]);

  const refresh = () => {
    void load().catch(() => setError('The limit overrides could not be read again. Inspect the account again.'));
  };

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setReply(null);
    try {
      const res = await fetch('/api/accounts/limits/override', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await founderMutationHeaders()) },
        body: JSON.stringify(body),
      });
      const answer = (await res.json().catch(() => null)) as { ok: boolean; text: string } | null;
      setReply(answer ?? { ok: false, text: 'The console could not read the answer. Read the account again before asking again.' });
      if (answer?.ok) setReason('');
    } catch {
      setReply({ ok: false, text: 'The console could not reach identity. Read the account again before asking again.' });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const policy = state?.policy;
  const self = id === founderId.toLowerCase();
  const ceilings = policy?.configured ? policy.ceilings.filter((row) => row.rail === RAIL) : [];
  /** Changes whenever an override is set, ended or reaches its end time, so the svc-pay figures are read again. */
  const reading = JSON.stringify(state?.overrides.map((row) => [row.assetId, row.version, row.status]) ?? []);
  const ceiling = policy && assetId ? ceilingFor(policy, RAIL, assetId) : null;
  const current = state?.overrides.find((row) => row.rail === RAIL && row.assetId === assetId) ?? null;
  const version = current?.version ?? '0';
  const figures = { perTx: figureOf(perTx), rolling24h: figureOf(rolling) };
  // One minute under the owner's longest lifetime, so a browser clock a little ahead of identity's is not refused.
  const maxMinutes = policy?.configured ? Number(policy.maxLifetimeHours) * 60 - 1 : 0;
  /** The reading a direct change is made on: the override version and the newest history entry. */
  const basis = history === null ? null : { version, after: history[0]?.auditId ?? null };
  const minuteCount = /^[1-9]\d{0,5}$/.test(minutes.trim()) ? Number(minutes.trim()) : null;
  const raise =
    ceiling !== null &&
    figures.perTx !== undefined &&
    figures.rolling24h !== undefined &&
    aboveCeiling({ perTx: figures.perTx, rolling24h: figures.rolling24h }, ceiling);
  const blocked = readOnly
    ? readOnly
    : !state
      ? null
      : !policy?.configured
        ? 'The owner has not set the limit override policy (IDENTITY_LIMIT_OVERRIDE_POLICY), so identity sets no override (identity.limit_ceiling_unset).'
        : self
          ? 'You cannot change the limits of your own account; the other founder can (identity.limit_self_forbidden).'
          : state.closed
            ? 'The account is closed, so identity sets no override (identity.limit_account_closed).'
            : null;
  const formHold =
    assetId === ''
      ? 'Choose an asset first.'
      : figures.perTx === undefined || figures.rolling24h === undefined
        ? 'A figure is a number above zero with at most 18 decimals, or blank to keep the base figure.'
        : figures.perTx === null && figures.rolling24h === null
          ? 'Set at least one figure.'
          : minuteCount === null
            ? 'Say how long the override lasts, in whole minutes.'
            : minuteCount > maxMinutes
              ? `The owner allows at most ${policy?.configured ? policy.maxLifetimeHours : '?'} hours, so at most ${maxMinutes} minutes here (identity.limit_lifetime_exceeded).`
              : null;
  const directHold =
    formHold ??
    (basis === null
      ? 'The override history could not be read, and a change is keyed on it. Inspect the account again.'
      : reason.trim().length < 12 || reason.trim().length > 255
        ? 'Give a reason of 12 to 255 characters.'
        : null);

  return (
    <div className="adm-control-card" data-testid="account-limits">
      <h2>Limit overrides</h2>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {state === undefined && !error && <p className="adm-subtle">Reading the customer’s limit overrides…</p>}
      {state === null && !error && <p>Identity has no customer with this id, so it has no limits (target.not_found).</p>}
      {/* svc-pay's own read, shown whatever identity answered: it names its own blockers. */}
      <WithdrawalAllowances userId={id} reading={reading} />
      {state && policy && (
        <>
          <p className="adm-subtle">
            An override replaces a withdrawal limit figure for one asset until its stored end time; after it, the base limit applies again.
            The base limits stay with the service that enforces them (svc-pay’s withdrawal limits by verification level); what it applies
            now is shown below the overrides.
          </p>
          <p data-testid="account-limits-policy">
            {policy.configured ? (
              <>
                Longest override: {policy.maxLifetimeHours} hours. Above the ceiling the other founder must approve:{' '}
                {ceilings.map((row) => `${row.assetId} ${row.ceiling}`).join(', ') || 'no withdrawal ceiling set'}.
              </>
            ) : (
              <>Limit override policy: not set (IDENTITY_LIMIT_OVERRIDE_POLICY, identity.limit_ceiling_unset).</>
            )}
          </p>
          {state.overrides.length === 0 ? (
            <p data-testid="account-limits-none">No overrides: the base limits apply.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-limits-overrides">
                <caption className="adm-sr-only">This customer’s limit overrides</caption>
                <thead>
                  <tr>
                    <th>Limit</th>
                    <th>Figures</th>
                    <th>Ends</th>
                    <th>Status</th>
                    <th>Set by</th>
                    <th>Approved by</th>
                    <th>End now</th>
                  </tr>
                </thead>
                <tbody>
                  {state.overrides.map((row) => (
                    <tr key={`${row.rail}:${row.assetId}`} data-testid={`account-limit-${row.rail}-${row.assetId}`}>
                      <td>
                        {row.rail} {row.assetId} <span className="adm-subtle">v{row.version}</span>
                      </td>
                      <td>{overrideFigures(row)}</td>
                      <td>{new Date(row.expiresAt).toLocaleString()}</td>
                      <td>{statusText(row)}</td>
                      <td>{row.setBy.slice(0, 8)}</td>
                      <td>{row.approvedBy?.slice(0, 8) ?? '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="adm-btn"
                          disabled={
                            busy || row.status !== 'active' || readOnly !== null || self || history === null || reason.trim().length < 12
                          }
                          title={
                            row.status !== 'active'
                              ? 'This override has already ended.'
                              : (readOnly ??
                                (self
                                  ? 'You cannot change the limits of your own account.'
                                  : reason.trim().length < 12
                                    ? 'Give a reason first.'
                                    : undefined))
                          }
                          onClick={() =>
                            void post({
                              action: 'clear',
                              userId: id,
                              rail: row.rail,
                              assetId: row.assetId,
                              reason: reason.trim(),
                              basis: { version: row.version, after: history?.[0]?.auditId ?? null },
                            })
                          }
                        >
                          End now
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {readOnly === null && !self && (
            <div className="adm-field">
              <label htmlFor="limit-reason">
                Why, for an override you set yourself or end now (kept in the override history, 12 to 255 characters)
              </label>
              <textarea
                id="limit-reason"
                className="adm-textarea"
                rows={2}
                maxLength={255}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )}
          {blocked ? (
            <p className="adm-subtle" data-testid="account-limits-blocked">
              {blocked}
            </p>
          ) : (
            <fieldset className="adm-fieldset">
              <legend>Override a withdrawal limit</legend>
              <div className="adm-field">
                <label htmlFor="limit-asset">Asset</label>
                <select id="limit-asset" value={assetId} onChange={(event) => setAssetId(event.target.value)}>
                  <option value="">Choose an asset</option>
                  {ceilings.map((row) => (
                    <option key={row.assetId} value={row.assetId}>
                      {row.assetId} (ceiling {row.ceiling})
                    </option>
                  ))}
                </select>
              </div>
              <div className="adm-field">
                <label htmlFor="limit-per-tx">Per transaction (blank keeps the base figure)</label>
                <input
                  id="limit-per-tx"
                  className="adm-input"
                  inputMode="decimal"
                  value={perTx}
                  onChange={(event) => setPerTx(event.target.value)}
                />
              </div>
              <div className="adm-field">
                <label htmlFor="limit-rolling">Over 24 hours (blank keeps the base figure)</label>
                <input
                  id="limit-rolling"
                  className="adm-input"
                  inputMode="decimal"
                  value={rolling}
                  onChange={(event) => setRolling(event.target.value)}
                />
              </div>
              <div className="adm-field">
                <label htmlFor="limit-minutes">Lasts for (minutes)</label>
                <input
                  id="limit-minutes"
                  className="adm-input"
                  inputMode="numeric"
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                />
                {minuteCount !== null && (
                  <span className="adm-subtle">
                    {' '}
                    Ends {minuteCount} minutes after it is sent (the exact time is stored and shown above once set), and the base limit
                    applies again.
                  </span>
                )}
              </div>
              {formHold === null && (
                <p data-testid="account-limits-path">
                  {raise
                    ? `Above the ${assetId} ceiling of ${ceiling}: the other founder must approve this override.`
                    : `At or under the ${assetId} ceiling of ${ceiling}: you can set it yourself.`}
                </p>
              )}
              {!raise && (
                <>
                  <div className="dk-row">
                    <button
                      type="button"
                      className="adm-btn"
                      data-tone="primary"
                      disabled={busy || directHold !== null}
                      onClick={() =>
                        void post({
                          action: 'set',
                          userId: id,
                          rail: RAIL,
                          assetId,
                          perTx: figures.perTx,
                          rolling24h: figures.rolling24h,
                          expiresAt: endsAfter(minuteCount!),
                          reason: reason.trim(),
                          basis,
                        })
                      }
                    >
                      {busy ? 'Sending…' : 'Set override'}
                    </button>
                    {directHold && <span className="dk-why">{directHold}</span>}
                  </div>
                </>
              )}
            </fieldset>
          )}
          {reply && (
            <p role={reply.ok ? 'status' : 'alert'} data-testid="account-limits-reply">
              {reply.text}
            </p>
          )}
          {!blocked && (
            <ControlDesk
              key={`limit:${id}:${assetId}:${version}`}
              endpoint="/api/accounts/limits"
              userId={founderId}
              blockedReason={null}
              formHold={
                formHold ?? (raise ? null : 'This override is at or under the ceiling, so you set it yourself with Set override above.')
              }
              action={{
                heading: 'Raise this limit above the ceiling',
                submitLabel: 'Ask the other founder to approve the override',
                needsReason: true,
                reasonLabel: 'Why (kept in the override history, 12 to 255 characters)',
                build: (why) => ({
                  kind: 'identity.account.limit_override',
                  userId: id,
                  rail: RAIL,
                  assetId,
                  perTx: figures.perTx ?? null,
                  rolling24h: figures.rolling24h ?? null,
                  expiresAt: minuteCount === null ? '' : endsAfter(minuteCount),
                  reason: why,
                  version,
                }),
              }}
              consequence="Both founders must agree: you make the request here, the other founder pastes the packet on their own console and approves it, and then you run it. Identity accepts only a founder as the approver, checks again when it runs, and sets the override only if it is still at the version you read. No money moves."
              blockedButtonLabel="Override unavailable"
              onChanged={refresh}
            />
          )}
          <h3>Override history</h3>
          {history === null ? (
            <p className="adm-alert" role="alert">
              Identity did not answer for the override history.
            </p>
          ) : history.length === 0 ? (
            <p>No recorded overrides.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-limits-history">
                <caption className="adm-sr-only">Most recent 50 override attempts</caption>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Limit</th>
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
                      <td>
                        {event.rail} {event.assetId}
                      </td>
                      <td>{historyText(event)}</td>
                      <td>{event.actorUserId?.slice(0, 8) ?? 'Unauthenticated'}</td>
                      <td>{event.outcome === 'changed' ? (event.approverUserId?.slice(0, 8) ?? '—') : '—'}</td>
                      <td>{event.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
