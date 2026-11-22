import { displayAmount } from '../../shared/money';
import { t as copyText } from './copy';
import { analysisCopy } from './quant-analysis-copy';
import { HYPOTHESIS_COPY, MODEL_COPY, type HistoricalSnapshot } from './quant-analysis';
export function QuantHistoricalRecord({ snapshot, view }: { snapshot: HistoricalSnapshot | null; view: object }) {
  const { Copy, t, requestedLocale, languageFor, directionFor } = analysisCopy.useCopy();
  const record = snapshot?.view === view ? snapshot : null;
  const modelName = (kind: string) => (kind in MODEL_COPY ? t(MODEL_COPY[kind as keyof typeof MODEL_COPY]) : kind);
  const count = new Intl.NumberFormat(requestedLocale, { maximumFractionDigits: 0 });
  const time = (value: string) => (
    <time dateTime={value} lang={requestedLocale}>
      {new Intl.DateTimeFormat(requestedLocale, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'UTC',
        timeZoneName: 'short',
      }).format(new Date(value))}
    </time>
  );
  return (
    <section className="lt-panel">
      <h2 className="lt-panel-title">{copyText('quant.historical.result')}</h2>
      <div className="lt-stack" lang={languageFor('completed')} dir={directionFor('completed')}>
        {record ? (
          <>
            <header className="lt-stack-tight">
              <h3>
                <Copy k="completed" />
              </h3>
              <p>
                <Copy k="claim" />
              </p>
              <p>
                <Copy k="verdict" /> · {t(HYPOTHESIS_COPY[record.request.outOfSampleStatus])}
              </p>
              <p>
                <Copy k="variants" />: <span lang={requestedLocale}>{count.format(record.request.strategyVariantCount)}</span>
              </p>
            </header>
            <div className="lt-stack-tight">
              <span className="lt-hint">
                <Copy k="original" />
              </span>
              <span className="lt-mono" lang="zxx">
                {record.data.strategyId}
              </span>
              <p>
                <Copy k="requestedSymbol" /> · <span lang="zxx">{record.request.symbol}</span>
              </p>
            </div>
            <div className="lt-cols-2">
              {(['in', 'out'] as const).map((part) => (
                <section key={part}>
                  <h4>{t(part === 'in' ? 'inWindow' : 'outWindow')}</h4>
                  {time(part === 'in' ? record.data.walkForward.inSampleFrom : record.data.walkForward.outOfSampleFrom)}
                  <p>
                    {time(part === 'in' ? record.data.walkForward.inSampleTo : record.data.walkForward.outOfSampleTo)} ·{' '}
                    <Copy k="endExcluded" />
                  </p>
                </section>
              ))}
            </div>
            <div className="lt-cols-2">
              {(['inSample', 'outOfSample'] as const).map((part) => (
                <section key={part}>
                  <h4>
                    {t(part === 'inSample' ? 'inFills' : 'outFills')} ·{' '}
                    <span lang={requestedLocale}>{count.format(record.data[part].fillCount)}</span>
                  </h4>
                  <div className="lt-figure" tabIndex={0} aria-label={t(part === 'inSample' ? 'inFills' : 'outFills') + ' · ' + t('quote')}>
                    <strong lang="zxx" data-exact-amount={record.data[part].notional}>
                      {displayAmount(record.data[part].notional)}
                    </strong>
                  </div>
                  <p className="lt-hint">
                    <Copy k="quote" />
                  </p>
                </section>
              ))}
            </div>
            <div className="lt-stack-tight">
              <p>
                <Copy k="notional" />
              </p>
              <p>
                <Copy k="limits" />
              </p>
            </div>
            <details className="lt-stack-tight">
              <summary>
                <Copy k="inspect" />
              </summary>
              <h4>
                <Copy k="costs" />
              </h4>
              {(['fees', 'slippage', 'latency'] as const).map((key) => (
                <section key={key}>
                  <h4>
                    {t(key)} · {modelName(record.request.costModel[key].kind)}
                  </h4>
                  <p lang="und">{record.request.costModel[key].source}</p>
                </section>
              ))}
              <section>
                <h4>
                  <Copy k="runLabel" />
                </h4>
                <p className="lt-mono" lang="zxx">
                  {record.data.runId}
                </p>
                <p className="lt-hint">
                  <Copy k="repeating" />
                </p>
              </section>
            </details>
          </>
        ) : (
          <>
            <h3>
              <Copy k="empty" />
            </h3>
            <p className="lt-hint">
              <Copy k="emptyBody" />
            </p>
          </>
        )}
      </div>
    </section>
  );
}
