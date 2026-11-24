import { useRef, useState } from 'react';
import type { z } from 'zod';
import { Button, Switch } from '@intafaced/ui/lit';
import { TextField } from '@intafaced/ui/lit/templates';
import {
  RISK_ALERTS_GET,
  RISK_ALERTS_LIST,
  RISK_ALERTS_OFF,
  RISK_ALERTS_SET,
  type riskAlertListSchema,
  type riskAlertSchema,
  type riskAlertsViewSchema,
} from '@intafaced/contracts/trade-risk-alerts-procedures';
import { useApi } from '../../session';
import { usePolled } from '../../protocol';
import { Waiting } from '../../more';
import { usePreferences } from '../../../shared/preferences';
import { VENUE_POLL_MS } from '../venue/poll';
import { AsOfLine, TestMark } from '../venue/volt/VoltVenue';
import { positionsCopy } from './positions-copy';

type View = z.output<typeof riskAlertsViewSchema>;
type List = z.output<typeof riskAlertListSchema>;
type Alert = z.output<typeof riskAlertSchema>;
type T = ReturnType<typeof positionsCopy.useCopy>['t'];

/** The alert's time in the person's own time zone, to the second, with the exact instant on the element. */
function When({ iso }: { iso: string }) {
  const { timeZone } = usePreferences();
  let text: string;
  try {
    text = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
  } catch {
    text = iso;
  }
  return <time dateTime={iso}>{text}</time>;
}

const kindWords = (t: T, a: Alert) =>
  a.kind === 'margin'
    ? t('raKindMargin', { level: a.level, asset: a.asset })
    : a.kind === 'margin_call'
      ? t('raKindCall', { level: a.level })
      : t('raKindLiquidation', { level: a.level });

const askedWords = (t: T, a: Alert) =>
  a.asked === null ? t('raAskedNone') : t('raAsked', { asked: a.asked, asset: a.asset, level: a.level });

/** One table of alerts: a position's in its panel, or the account's margin calls in the Margin calls tab. */
function AlertTable({ alerts, testId }: { alerts: readonly Alert[]; testId: string }) {
  const { t } = positionsCopy.useCopy();
  return (
    <table data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">{t('raHTime')}</th>
          <th scope="col">{t('raHMarket')}</th>
          <th scope="col">{t('raHAlert')}</th>
          <th scope="col">{t('raHMargin')}</th>
          <th scope="col">{t('raHRatio')}</th>
          <th scope="col">{t('raHAsked')}</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((a) => (
          <tr key={a.alertKey} data-key={a.alertKey} data-kind={a.kind} data-symbol={a.symbol}>
            <td data-cell="time">
              <When iso={a.at} />
            </td>
            <td data-cell="market">{a.symbol}</td>
            <td data-cell="alert">{kindWords(t, a)}</td>
            <td className="lt-mono" data-cell="margin">
              {a.marginWithResult}
            </td>
            <td className="lt-mono" data-cell="ratio">
              {a.marginRatio === null ? '—' : `${a.marginRatio}%`}
            </td>
            <td data-cell="asked">{askedWords(t, a)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Margin and liquidation-risk alerts on one isolated position (J-derivatives-06 #6; svc-trade src/venue/risk-alerts.ts):
 * the person turns them on and may set a margin level and a margin-ratio level; with neither set the toggle says to set
 * them, and the liquidation alert still goes out at 100%. Our engine sends one alert per crossing to their inbox; this
 * panel lists what went out. Every figure is the service's and the venue's own.
 */
export function RiskAlertsPanel({ owner, symbol, venueName }: { owner: string; symbol: string; venueName: string }) {
  const { t } = positionsCopy.useCopy();
  const api = useApi();
  const read = usePolled<View>(
    (signal) => api.call(RISK_ALERTS_GET, { owner, symbol }, { signal }),
    `risk-alerts:${owner}:${symbol}`,
    VENUE_POLL_MS,
  );
  const view = read.data;
  const [margin, setMargin] = useState<string | null>(null);
  const [ratio, setRatio] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: 'ok' | 'refused'; text: string } | null>(null);
  const busy = useRef(false);

  const asset = view?.asset ?? '';
  const setting = view?.setting ?? null;
  const on = setting?.on ?? false;
  // The form starts from the saved levels; what the person types replaces them.
  const marginValue = margin ?? setting?.marginLevel ?? '';
  const ratioValue = ratio ?? setting?.ratioLevel ?? '';

  async function act(f: () => Promise<{ ok: true; data: View } | { ok: false; message: string }>) {
    if (busy.current) return;
    busy.current = true;
    setSaid(null);
    try {
      const answer = await f();
      if (!answer.ok) return setSaid({ tone: 'refused', text: t('raRefused', { detail: answer.message }) });
      setMargin(null);
      setRatio(null);
      setSaid({ tone: 'ok', text: t('raSaved') });
    } finally {
      busy.current = false;
      read.reload();
    }
  }
  const save = () => act(() => api.call(RISK_ALERTS_SET, { owner, symbol, marginLevel: marginValue, ratioLevel: ratioValue }));
  const toggle = (next: boolean) => (next ? save() : act(() => api.call(RISK_ALERTS_OFF, { owner, symbol })));

  const parts = [
    setting?.marginLevel ? t('raPartMargin', { level: setting.marginLevel, asset }) : null,
    setting?.ratioLevel ? t('raPartRatio', { level: setting.ratioLevel }) : null,
    t('raPartLiquidation'),
  ].filter((x): x is string => x !== null);
  const state = !on ? t('raOff') : !setting?.marginLevel && !setting?.ratioLevel ? t('raNoLevels') : t('raOn', { parts: parts.join(', ') });

  return (
    <section className="lt-stack" aria-label={t('raTitle', { symbol })} data-testid="risk-alerts-panel">
      <h3>
        {t('raTitle', { symbol })} <TestMark test={view?.venue.test ?? false} />
      </h3>
      <p className="lt-hint">{t('raLead', { venue: view?.venue.name ?? venueName })}</p>
      {view === null && read.failure ? (
        <p className="lt-refusal" role="alert">
          {t('raRefused', { detail: read.failure.message })}
        </p>
      ) : view === null ? (
        <Waiting label={t('raTitle', { symbol })} />
      ) : (
        <>
          {view.position ? (
            <>
              <dl>
                <dt>{t('raMarginNow', { asset })}</dt>
                <dd className="lt-mono" data-line="ra-margin">
                  {view.position.marginWithResult}
                </dd>
                <dt>{t('raRatioNow')}</dt>
                <dd className="lt-mono" data-line="ra-ratio">
                  {view.position.marginRatio === null ? t('raRatioNone', { venue: view.venue.name }) : `${view.position.marginRatio}%`}
                </dd>
              </dl>
              <AsOfLine asOf={view.position.asOf} />
            </>
          ) : null}
          <div
            className="lt-stack"
            data-testid="risk-alerts-toggle"
            data-armed-margin={setting?.armed.margin ?? false}
            data-armed-call={setting?.armed.marginCall ?? false}
            data-armed-liquidation={setting?.armed.liquidation ?? false}
          >
            <Switch checked={on} onChange={(next) => void toggle(next)} label={t('raToggle')} aria-describedby="risk-alerts-state" />
            <p id="risk-alerts-state" data-line="ra-state">
              {state}
            </p>
          </div>
          <TextField
            label={t('raMarginLevel', { asset })}
            hint={t('raLevelHint')}
            inputMode="decimal"
            value={marginValue}
            onChange={setMargin}
          />
          <TextField label={t('raRatioLevel')} hint={t('raLevelHint')} inputMode="decimal" value={ratioValue} onChange={setRatio} />
          <Button onClick={() => void save()}>{t('raSave')}</Button>
          {said?.tone === 'refused' ? (
            <p className="lt-refusal" role="alert" data-testid="risk-alerts-said">
              {said.text}
            </p>
          ) : null}
          {said?.tone === 'ok' ? (
            <p className="lt-hint" role="status" data-testid="risk-alerts-said">
              {said.text}
            </p>
          ) : null}
          <h4>{t('raAlertsTitle')}</h4>
          {view.alerts.length === 0 ? (
            <p className="lt-hint">{t('raAlertsNone')}</p>
          ) : (
            <AlertTable alerts={view.alerts} testId="risk-alerts" />
          )}
        </>
      )}
    </section>
  );
}

/** The Margin calls tab (J-derivatives-06 #7): every margin call and liquidation alert on one venue account, newest first. */
export function MarginCalls({ owner, venue }: { owner: string; venue: { id: string; name: string } }) {
  const { t } = positionsCopy.useCopy();
  const api = useApi();
  const read = usePolled<List>(
    (signal) => api.call(RISK_ALERTS_LIST, { owner }, { signal }),
    `margin-calls:${owner}:${venue.id}`,
    VENUE_POLL_MS,
  );
  const calls = (read.data?.alerts ?? []).filter((a) => a.kind !== 'margin');
  return (
    <section className="lt-stack" aria-label={t('callsTitle', { venue: venue.name })} data-testid="margin-calls-room" data-venue={venue.id}>
      <h2>
        {t('callsTitle', { venue: venue.name })} <TestMark test={read.data?.venue.test ?? false} />
      </h2>
      <p className="lt-hint">{t('callsLead')}</p>
      {read.data === null && read.failure ? (
        <p className="lt-refusal" role="alert">
          {t('callsFailed', { venue: venue.name, detail: read.failure.message })}
        </p>
      ) : read.data === null ? (
        <Waiting label={t('callsTitle', { venue: venue.name })} />
      ) : calls.length === 0 ? (
        <p className="lt-hint">{t('callsNone', { venue: venue.name })}</p>
      ) : (
        <AlertTable alerts={calls} testId="margin-calls" />
      )}
    </section>
  );
}
