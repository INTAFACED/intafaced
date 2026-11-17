'use client';

import { OutcomeNotice } from './outcome-notice';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { STATE_LABEL, shownTime, shownVersions, type FeeHistory } from '@/lib/trade-ops/fees-versions-model';
import { builderFeeViews, builderRateText, type BuilderCaps, type BuilderDraftLine } from '@/lib/trade-ops/builder-fees-model';

/**
 * The Fees room's builder fees (J-cex-spot-17 #1 #3): our fee on the customer's own venue account, by venue and market
 * group, version by version, beside the cap the venue itself publishes (read from the venue through svc-trade). Every
 * rate is the stored decimal string; a cap the venue does not publish reads "not published".
 */

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';

/** The venue's cap per market, as the venue publishes it. */
function VenueCaps({ caps }: { caps: Outcome<BuilderCaps> | null }) {
  if (caps === null)
    return (
      <p className="text-sm text-fg-2" data-fees="builder-caps-unread">
        The venue&apos;s builder-fee cap was not read for this view, so no version that sets a builder fee can be proposed.
      </p>
    );
  if (caps.kind !== 'ok')
    return (
      <div className="flex flex-col gap-1 text-sm" data-fees="builder-caps-unread">
        <p className="text-fg">
          The venue&apos;s builder-fee cap could not be read, so no version that sets a builder fee can be proposed.
        </p>
        <OutcomeNotice outcome={caps} />
      </div>
    );
  const c = caps.data;
  return (
    <div className="flex flex-col gap-1" data-fees="builder-caps" data-venue={c.venueId}>
      <p className="text-xs text-fg-2">
        {c.test ? 'TEST · ' : ''}
        {c.displayName} ({c.venueId}): the most builder fee it lets an order carry, as it publishes it, read {shownTime(c.asOf)}. A version
        is never written above it.
      </p>
      <table className={TABLE}>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Kind</th>
            <th scope="col">Venue cap</th>
          </tr>
        </thead>
        <tbody>
          {c.markets.map((m) => (
            <tr key={m.symbol} data-builder-cap={m.symbol}>
              <th scope="row">{m.symbol}</th>
              <td>{m.kind}</td>
              <td className="if-num">{m.capBps === null ? 'not published' : builderRateText(m.capBps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** #1 builder-fee versions by venue and market group: every scheduled version, the current one and up to five before. */
export function BuilderFeeVersions({ history, now, caps }: { history: FeeHistory; now: Date; caps: Outcome<BuilderCaps> | null }) {
  const venues = builderFeeViews(shownVersions(history.history, now));
  return (
    <div className="flex flex-col gap-4" data-fees="builder-versions">
      <VenueCaps caps={caps} />
      {venues.length === 0 ? (
        <p className="text-sm text-fg-2" data-fees="no-builder-versions">
          No version shown sets a builder fee: venue orders carry the boot owner value, or refuse when it is blank.
        </p>
      ) : null}
      {venues.map((v) => (
        <section key={v.venueId} data-builder-venue={v.venueId} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{v.venueId}</h3>
          {v.groups.map((g) => (
            <div key={g.group} data-builder-group={g.group} className="flex flex-col gap-1">
              <h4 className="text-sm">{g.group}</h4>
              <p className="text-xs text-fg-2">
                {g.markets === null
                  ? 'Every market of the venue not named in another group.'
                  : g.markets.length
                    ? `Markets: ${g.markets.join(', ')}`
                    : 'No market is named in this group in the latest version.'}
              </p>
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">State</th>
                    <th scope="col">Takes effect</th>
                    <th scope="col">Builder fee</th>
                  </tr>
                </thead>
                <tbody>
                  {g.lines.map((line) => (
                    <tr key={line.version} data-version={`v${line.version}`} data-state={line.state}>
                      <th scope="row" className="if-num">
                        v{line.version}
                      </th>
                      <td>{STATE_LABEL[line.state]}</td>
                      <td className="if-num">{shownTime(line.effectiveAt)}</td>
                      <td className="if-num">{line.rate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** #3 the proposal's builder fees: one field per (venue, group) the base version sets. */
export function BuilderFeeInputs({
  lines,
  onChange,
}: {
  lines: readonly BuilderDraftLine[];
  onChange: (i: number, feeBps: string) => void;
}) {
  if (lines.length === 0)
    return <p className="text-sm text-fg-2">The version this starts from sets no builder fee, so there is none to change here.</p>;
  return (
    <table className={TABLE} data-fees="builder-propose">
      <thead>
        <tr>
          <th scope="col">Venue / market group</th>
          <th scope="col">Builder fee (bps)</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={`${l.venueId}:${l.group}`}>
            <th scope="row">
              {l.venueId} / {l.group}
            </th>
            <td>
              <input
                className="adm-input"
                inputMode="decimal"
                aria-label={`Builder fee bps, ${l.venueId} / ${l.group}`}
                value={l.feeBps}
                onChange={(e) => onChange(i, e.target.value)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
