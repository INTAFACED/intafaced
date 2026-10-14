import { useState } from 'react';
import { Sparkline, ToggleGroup, ToggleGroupItem } from '@intafaced/ui';
import { direction, fmtPct, fmtUsd, fmtUsdChange } from '../../../data/format';
import { PreviewChip } from '../../../preview';
import type { SampleBotsRows } from '../../../preview/fixtures/bots';
import { botsCopy } from './copy';
import { totals } from './model';

/** Sample results across every bot: four numbers and one curve. All of it comes from the fixture and is labelled sample. */
export function Performance({ rows, empty }: { rows: SampleBotsRows; empty: boolean }) {
  const { t } = botsCopy.useCopy();
  const [range, setRange] = useState<'d7' | 'd30'>('d30');
  const running = totals(empty ? [] : rows.bots.filter((bot) => bot.state === 'running'));
  const all = totals(empty ? [] : rows.bots);
  const series = empty ? [] : rows.performance[range];
  const rangeText = range === 'd7' ? t('Range 7d') : t('Range 30d');
  const first = series[0];
  const last = series[series.length - 1];
  const dir = direction(all.profit);
  return (
    <section className="if-preview__panel bots-perf" aria-labelledby="bots-perf-h" data-testid="bots-performance">
      <div className="if-preview__panel-head">
        <h2 className="if-preview__h2" id="bots-perf-h">
          {t('Performance heading')}
        </h2>
        <PreviewChip />
        <div className="bots-perf__range">
          <ToggleGroup aria-label={t('Range label')} variant="pill" value={range} onValueChange={(next) => setRange(next as 'd7' | 'd30')}>
            <ToggleGroupItem value="d7">{t('Range 7d')}</ToggleGroupItem>
            <ToggleGroupItem value="d30">{t('Range 30d')}</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <dl className="bots-stats">
        <div>
          <dt>{t('Stat invested')}</dt>
          <dd className="if-num">{fmtUsd(running.invested)}</dd>
        </div>
        <div>
          <dt>{t('Stat profit')}</dt>
          <dd className="if-num" data-direction={dir ?? 'flat'}>
            {fmtUsdChange(all.profit)}
          </dd>
        </div>
        <div>
          <dt>{t('Stat return')}</dt>
          <dd className="if-num" data-direction={dir ?? 'flat'}>
            {fmtPct(all.profitRatio)}
          </dd>
        </div>
        <div>
          <dt>{t('Stat running')}</dt>
          <dd className="if-num">{running.running}</dd>
        </div>
        <div>
          <dt>{t('Stat fills')}</dt>
          <dd className="if-num">{all.fills}</dd>
        </div>
      </dl>
      {series.length > 1 ? (
        <figure className="bots-perf__chart">
          <Sparkline
            values={series}
            width={760}
            height={150}
            endDot
            label={t('Perf chart label', { range: rangeText })}
            className="bots-perf__svg"
          />
          <figcaption>
            <span className="if-num">{fmtUsd(first)}</span>
            <span className="if-num">{fmtUsd(last)}</span>
          </figcaption>
        </figure>
      ) : null}
      <p className="bots-fine">{t('Perf note')}</p>
    </section>
  );
}
