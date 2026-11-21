import { utcSecond, VERDICT_TEXT, type BuilderAccountView } from '@/lib/trade-ops/builder-account-model';

/**
 * The builder account room (J-ops-console-28): our builder address's account mode at each venue as the venue reports it,
 * with the venue's time, beside the mode the venue requires to accrue builder fees, and the alerts sent to the owner's
 * named contact while it was out of that mode. A mode that can't be read reads "unknown", never "ok".
 */

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';

const Test = ({ on }: { on: boolean }) => (on ? <span className="ms-1 text-xs text-warn">TEST</span> : null);

export function BuilderAccount({ view }: { view: BuilderAccountView }) {
  const names = new Map(view.venues.map((v) => [v.venueId, v]));
  return (
    <div className="flex flex-col gap-6">
      <table data-testid="builder-account-venues" className={TABLE}>
        <caption className="text-start text-xs text-fg-2">Our builder address at each venue an order can be routed to</caption>
        <thead>
          <tr className="text-xs text-fg-2">
            <th>Venue</th>
            <th>Our builder address</th>
            <th>Account mode, as the venue reports it</th>
            <th>As of</th>
            <th>Mode required for builder fees</th>
            <th>Builder fees</th>
          </tr>
        </thead>
        <tbody>
          {view.venues.map((v) => (
            <tr key={v.venueId} data-venue={v.venueId} data-verdict={v.verdict} className="border-t border-line">
              <td data-cell="venue">
                {v.displayName ?? v.venueId}
                <Test on={v.test} />
              </td>
              <td data-cell="builder" className="font-mono text-xs">
                {v.builder}
              </td>
              <td data-cell="mode">
                {v.mode.status === 'read' ? (
                  <>
                    {v.mode.mode}
                    <Test on={v.test} />
                  </>
                ) : (
                  <>
                    unknown{' '}
                    <span className="text-xs text-fg-2">
                      ({v.mode.message}; {v.mode.code})
                    </span>
                  </>
                )}
              </td>
              <td data-cell="as-of">{v.mode.status === 'read' ? utcSecond(v.mode.asOf) : 'unknown'}</td>
              <td data-cell="required">
                {v.required.status === 'published' ? v.required.mode : v.required.status === 'not_published' ? 'not published' : 'unknown'}
              </td>
              <td
                data-cell="verdict"
                className={v.verdict === 'not_collected' ? 'text-down' : v.verdict === 'required_mode' ? 'text-fg' : 'text-warn'}
              >
                {VERDICT_TEXT[v.verdict]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="flex flex-col gap-2" aria-label="Builder mode alerts">
        <h2 className="text-sm font-medium text-fg">Alerts</h2>
        {view.alerting.status === 'on' ? (
          <p data-testid="builder-account-alerting" data-alerting="on" className="text-sm text-fg-2">
            An alert goes once to {view.alerting.contact} when our builder address leaves the mode a venue requires.
          </p>
        ) : (
          <p data-testid="builder-account-alerting" data-alerting="refused" className="text-sm text-warn">
            {view.alerting.message} ({view.alerting.code}).
          </p>
        )}
        {view.alerts.length === 0 ? (
          <p data-testid="builder-account-no-alerts" className="text-sm text-fg-2">
            No alert has been sent.
          </p>
        ) : (
          <table data-testid="builder-account-alerts" className={TABLE}>
            <thead>
              <tr className="text-xs text-fg-2">
                <th>Opened</th>
                <th>Venue</th>
                <th>Mode seen</th>
                <th>Mode required</th>
                <th>Sent to</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {view.alerts.map((a) => (
                <tr
                  key={a.id}
                  data-alert={a.id}
                  data-venue={a.venueId}
                  data-opened-at={a.openedAt}
                  data-state={a.clearedAt ? 'cleared' : 'open'}
                  className="border-t border-line"
                >
                  <td data-cell="opened">{utcSecond(a.openedAt)}</td>
                  <td data-cell="venue">
                    {names.get(a.venueId)?.displayName ?? a.venueId}
                    <Test on={names.get(a.venueId)?.test ?? false} />
                  </td>
                  <td data-cell="mode">{a.modeSeen}</td>
                  <td data-cell="required">{a.requiredMode}</td>
                  <td data-cell="contact">{a.contact}</td>
                  <td data-cell="state">
                    {a.clearedAt
                      ? `Cleared ${utcSecond(a.clearedAt)}${a.clearedMode ? `, back in ${a.clearedMode}` : ''}`
                      : 'Open: builder fees not collected'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
