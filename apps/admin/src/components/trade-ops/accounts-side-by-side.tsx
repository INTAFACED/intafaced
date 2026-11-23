import type { Part } from '@/lib/part';
import type { AccountsView, PartnerBalances, VenueAccounts } from '@/lib/trade-ops/accounts';
import '@/components/desk.css';

type Sample = VenueAccounts['accounts'][number]['history'][number];

const STATE_WORDS: Record<string, string> = { healthy: 'Healthy', margin_call: 'Margin call' };
const ratioOf = (s: Sample) => (s.marginRatio.known ? s.marginRatio.value : 'Not reported');
const stateOf = (s: Sample) => (s.crossState ? (STATE_WORDS[s.crossState] ?? s.crossState) : 'No cross position');

function Failed({ part, testId }: { part: Extract<Part<unknown>, { kind: 'failed' }>; testId: string }) {
  return (
    <p role="alert" data-testid={testId} data-code={part.code ?? ''}>
      {part.message}
    </p>
  );
}

/** The person's venue accounts: the margin now and its ratio history, every figure the venue's, each with its as-of time. */
function VenueSide({ part }: { part: Part<VenueAccounts> }) {
  if (part.kind === 'failed') return <Failed part={part} testId="venue-failed" />;
  const d = part.data;
  return (
    <>
      <p className="dk-muted" data-testid="venue-source" data-source={d.source}>
        Source: {d.source}, as it reported each figure, at the time shown. INTAFACED holds none of this money.
      </p>
      {d.accounts.length === 0 ? (
        <p className="dk-muted" data-testid="venue-none">
          This person has signed for no venue account through INTAFACED.
        </p>
      ) : null}
      {d.accounts.map((a) => (
        <div key={`${a.owner}:${a.subAccount ?? ''}`} className="dk-stack" data-testid="venue-account" data-owner={a.owner}>
          <h4>Venue account {a.owner}</h4>
          {a.now ? (
            <dl className="dk-kv" data-testid="venue-now" data-as-of={a.now.asOf}>
              <dt>State</dt>
              <dd data-cell="state">{stateOf(a.now)}</dd>
              <dt>Margin ratio</dt>
              <dd data-cell="ratio">{ratioOf(a.now)}</dd>
              <dt>Equity</dt>
              <dd data-cell="equity">
                {a.now.equity} {a.now.asset}
              </dd>
              <dt>Maintenance requirement</dt>
              <dd data-cell="maintenance">
                {a.now.maintenanceMargin} {a.now.asset}
              </dd>
              <dt>As of</dt>
              <dd data-cell="as-of">{a.now.asOf}</dd>
            </dl>
          ) : (
            <p className="dk-muted">{d.source} reports no margin summary for this account.</p>
          )}
          <h5>Ratio history</h5>
          {a.history.length === 0 ? (
            <p className="dk-muted" data-testid="history-none">
              Our door has kept no reading of this account’s margin.
            </p>
          ) : (
            <div className="dk-table-wrap" role="region" aria-label="Ratio history" tabIndex={0}>
              <table data-testid="ratio-history">
                <thead>
                  <tr>
                    <th>As of</th>
                    <th>State</th>
                    <th>Margin ratio</th>
                    <th>Equity</th>
                    <th>Maintenance requirement</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {a.history.map((h) => (
                    <tr key={h.asOf} data-as-of={h.asOf}>
                      <td data-cell="as-of">{h.asOf}</td>
                      <td data-cell="state">{stateOf(h)}</td>
                      <td data-cell="ratio">{ratioOf(h)}</td>
                      <td data-cell="equity">
                        {h.equity} {h.asset}
                      </td>
                      <td data-cell="maintenance">
                        {h.maintenanceMargin} {h.asset}
                      </td>
                      <td data-cell="source">{d.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** The person's spending balances, as the partner reports them, each with the partner's label and as-of time. */
function PartnerSide({ part }: { part: Part<PartnerBalances> }) {
  if (part.kind === 'failed') return <Failed part={part} testId="partner-failed" />;
  const d = part.data;
  if (!d.heldByPartner)
    return (
      <p className="dk-muted" data-testid="partner-none">
        No partner holds this person’s spending money.
      </p>
    );
  return (
    <div className="dk-table-wrap" role="region" aria-label="Partner balance" tabIndex={0}>
      <table data-testid="partner-balances">
        <thead>
          <tr>
            <th>Account</th>
            <th>Balance</th>
            <th>Source</th>
            <th>As of</th>
          </tr>
        </thead>
        <tbody>
          {d.spaces.map((s) => (
            <tr key={s.spaceId} data-space={s.spaceId} data-kind={s.kind} data-state={s.state}>
              <td data-cell="name">{s.kind === 'primary' ? `Main ${s.assetId}` : s.name}</td>
              <td data-cell="balance">
                {s.balance} {s.assetId}
                {s.state === 'stale' ? ' (older than the partner’s freshness limit)' : ''}
              </td>
              <td data-cell="source">{s.source}</td>
              <td data-cell="as-of">{s.asOf}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The founder names the person; their venue account and partner balance then read side by side, read-only. */
export function AccountsSideBySide({ asked, invalid, view }: { asked: string; invalid: boolean; view: AccountsView | null }) {
  return (
    <div className="dk-stack" data-testid="accounts-room">
      <form method="get" action="/trade-ops/accounts" className="dk-row">
        <label>
          Person (user id) <input name="userId" defaultValue={asked} required autoComplete="off" spellCheck={false} />
        </label>
        <button type="submit">Look up</button>
      </form>
      {invalid ? (
        <p role="alert" data-testid="accounts-invalid">
          That is not a user id. Paste the person’s user id from their account record.
        </p>
      ) : null}
      {view ? (
        <div className="dk-grid-2" data-testid="accounts-side-by-side" data-user={view.userId} data-read-at={view.readAt}>
          <section className="dk-stack" data-testid="venue-side" aria-label="Venue account">
            <h3>Venue account</h3>
            <VenueSide part={view.venue} />
          </section>
          <section className="dk-stack" data-testid="partner-side" aria-label="Partner balance">
            <h3>Partner balance</h3>
            <PartnerSide part={view.partner} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
