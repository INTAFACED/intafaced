import { useState } from 'react';
import {
  AmountInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from '@intafaced/ui';
import { fmtPct, fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import type { SampleBotFrequency, SampleBotKind, SampleBotPair, SampleBotsRows } from '../../../preview/fixtures/bots';
import { botsCopy } from './copy';
import { GridChart } from './GridChart';
import { GRID_MAX, GRID_MIN, exceeds, marketFor, planDca, planGrid, planTwap } from './model';

type Rows = SampleBotsRows;

function PairSelect({ rows, value, onChange }: { rows: Rows; value: SampleBotPair; onChange: (pair: SampleBotPair) => void }) {
  const { t } = botsCopy.useCopy();
  const items = Object.fromEntries(rows.markets.map((market) => [market.pair, market.pair]));
  return (
    <div className="bots-field bots-field--select">
      <span className="bots-field__label" id="bots-pair-label">
        {t('Pair label')}
      </span>
      <Select items={items} value={value} onValueChange={(next) => next && onChange(next as SampleBotPair)}>
        <SelectTrigger aria-labelledby="bots-pair-label" className="bots-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {rows.markets.map((market) => (
            <SelectItem key={market.pair} value={market.pair}>
              {market.pair}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Facts({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="bots-facts">
      {items.map(([label, value]) => (
        <div key={label} className="bots-facts__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The create flow for one bot. Every field is local to this page; the Start button opens the "nothing was sent" sheet. */
export function CreatePanel({ rows, kind }: { rows: Rows; kind: SampleBotKind }) {
  const { t } = botsCopy.useCopy();
  const balance = fmtUsd(rows.sampleBalance);

  const [grid, setGrid] = useState({ ...rows.defaults.grid, stopOutside: true });
  const [dca, setDca] = useState({ ...rows.defaults.dca });
  const [twap, setTwap] = useState({ ...rows.defaults.twap });

  const gridPrice = marketFor(rows, grid.pair).price;
  const gridPlan = planGrid({ ...grid, price: gridPrice });
  const dcaPlan = planDca(dca);
  const twapPlan = planTwap(twap);

  const problem =
    kind === 'grid'
      ? gridPlan.problem === 'range'
        ? t('Range problem')
        : gridPlan.problem === 'grids'
          ? t('Grids problem', { min: GRID_MIN, max: GRID_MAX })
          : gridPlan.problem === 'invest'
            ? t('Invest problem')
            : null
      : kind === 'dca'
        ? dcaPlan.problem === 'perBuy'
          ? t('Dca per buy problem')
          : dcaPlan.problem === 'buys'
            ? t('Dca buys problem')
            : null
        : twapPlan.problem === 'total'
          ? t('Twap total problem')
          : twapPlan.problem === 'hours'
            ? t('Twap hours problem')
            : twapPlan.problem === 'interval'
              ? t('Twap interval problem')
              : null;

  const spend = kind === 'grid' ? grid.invest : kind === 'dca' ? dca.perBuy : twap.total;
  const over = problem === null && exceeds(spend, rows.sampleBalance) ? t('Over balance', { balance }) : null;

  return (
    <section className="if-preview__panel bots-create" aria-labelledby="bots-create-h" data-testid="bots-create">
      <div className="if-preview__panel-head">
        <h2 className="if-preview__h2" id="bots-create-h">
          {t('Create heading')}
        </h2>
        <PreviewChip />
      </div>
      <p className="bots-balance">
        {t('Sample balance')} <strong className="if-num">{balance}</strong>
      </p>

      {kind === 'grid' ? (
        <div className="bots-form" data-kind="grid">
          <PairSelect rows={rows} value={grid.pair} onChange={(pair) => setGrid({ ...grid, pair })} />
          <AmountInput label={t('Lowest price')} unit="USDT" precision={2} tick="100" value={grid.low} onValueChange={(low) => setGrid({ ...grid, low })} />
          <AmountInput label={t('Highest price')} unit="USDT" precision={2} tick="100" value={grid.high} onValueChange={(high) => setGrid({ ...grid, high })} />
          <AmountInput label={t('Grids')} precision={0} tick="1" min="0" value={grid.grids} onValueChange={(grids) => setGrid({ ...grid, grids })} />
          <AmountInput label={t('Investment')} unit="USDT" precision={2} tick="50" value={grid.invest} onValueChange={(invest) => setGrid({ ...grid, invest })} />
          <label className="bots-switch">
            <Switch checked={grid.stopOutside} onCheckedChange={(stopOutside) => setGrid({ ...grid, stopOutside })} aria-label={t('Close outside range')} />
            <span>{t('Close outside range')}</span>
          </label>
          <h3 className="bots-h3">{t('Grid summary heading')}</h3>
          {gridPlan.problem === null ? (
            <>
              <GridChart plan={gridPlan} priceText={fmtUsd(gridPrice)} />
              <Facts
                items={[
                  [t('Gap between orders'), `${fmtUsd(gridPlan.step)} (${fmtPct(gridPlan.stepRatio, { signed: false })})`],
                  [t('Each order'), fmtUsd(gridPlan.perOrder)],
                  [t('Orders placed'), t('Buy and sell split', { buys: gridPlan.buys, sells: gridPlan.sells })],
                ]}
              />
              {!gridPlan.priceInRange ? <p className="bots-warn">{t('Out of range')}</p> : null}
            </>
          ) : null}
        </div>
      ) : null}

      {kind === 'dca' ? (
        <div className="bots-form" data-kind="dca">
          <PairSelect rows={rows} value={dca.pair} onChange={(pair) => setDca({ ...dca, pair })} />
          <AmountInput label={t('Buy per time')} unit="USDT" precision={2} tick="5" value={dca.perBuy} onValueChange={(perBuy) => setDca({ ...dca, perBuy })} />
          <div className="bots-field bots-field--select">
            <span className="bots-field__label" id="bots-frequency-label">
              {t('Frequency')}
            </span>
            <Select
              items={{ hourly: t('Hourly'), daily: t('Daily'), weekly: t('Weekly'), monthly: t('Monthly') }}
              value={dca.frequency}
              onValueChange={(frequency) => frequency && setDca({ ...dca, frequency: frequency as SampleBotFrequency })}
            >
              <SelectTrigger aria-labelledby="bots-frequency-label" className="bots-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">{t('Hourly')}</SelectItem>
                <SelectItem value="daily">{t('Daily')}</SelectItem>
                <SelectItem value="weekly">{t('Weekly')}</SelectItem>
                <SelectItem value="monthly">{t('Monthly')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <AmountInput label={t('Number of buys')} precision={0} tick="1" value={dca.buys} onValueChange={(buys) => setDca({ ...dca, buys })} />
          <AmountInput label={t('Take profit')} unit="%" precision={0} tick="1" value={dca.takeProfit} onValueChange={(takeProfit) => setDca({ ...dca, takeProfit })} />
          <h3 className="bots-h3">{t('Dca summary heading')}</h3>
          {dcaPlan.problem === null ? (
            <Facts
              items={[
                [t('Total budget'), fmtUsd(dcaPlan.total)],
                [t('Number of buys'), String(dcaPlan.buys)],
                [t('Spread over'), dcaPlan.days <= 1 ? t('Spread one day') : t('Spread days', { days: dcaPlan.days })],
              ]}
            />
          ) : null}
        </div>
      ) : null}

      {kind === 'twap' ? (
        <div className="bots-form" data-kind="twap">
          <SegmentedControl
            aria-label={t('Side')}
            size={40}
            fullWidth
            value={twap.side}
            onValueChange={(side) => setTwap({ ...twap, side: side as 'buy' | 'sell' })}
            items={[
              { value: 'buy', label: t('Buy'), tone: 'up' },
              { value: 'sell', label: t('Sell'), tone: 'down' },
            ]}
          />
          <PairSelect rows={rows} value={twap.pair} onChange={(pair) => setTwap({ ...twap, pair })} />
          <AmountInput label={t('Total size')} unit="USDT" precision={2} tick="100" value={twap.total} onValueChange={(total) => setTwap({ ...twap, total })} />
          <div className="bots-field bots-field--chips">
            <span className="bots-field__label" id="bots-hours-label">
              {t('Spread across')}
            </span>
            <ToggleGroup aria-labelledby="bots-hours-label" variant="pill" value={twap.hours} onValueChange={(hours) => setTwap({ ...twap, hours })}>
              {['1', '4', '12', '24'].map((hours) => (
                <ToggleGroupItem key={hours} value={hours}>
                  {hours} {t('Hours unit')}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <AmountInput label={t('Slice every')} unit={t('Minutes unit')} precision={0} tick="1" value={twap.intervalMinutes} onValueChange={(intervalMinutes) => setTwap({ ...twap, intervalMinutes })} />
          <AmountInput label={t('Max slippage')} unit="%" precision={2} tick="0.05" value={twap.slippage} onValueChange={(slippage) => setTwap({ ...twap, slippage })} />
          <h3 className="bots-h3">{t('Twap summary heading')}</h3>
          {twapPlan.problem === null ? (
            <Facts items={[[t('Slices'), String(twapPlan.slices)], [t('Each slice'), fmtUsd(twapPlan.perSlice)]]} />
          ) : null}
        </div>
      ) : null}

      {problem ? (
        <p className="bots-warn" role="alert">
          {problem}
        </p>
      ) : null}
      {over ? <p className="bots-warn">{over}</p> : null}

      <PreviewActionButton product="bots" variant="primary" size={48} fullWidth className="bots-start">
        {t('Start bot')}
      </PreviewActionButton>
      <p className="bots-fine">{t('Create note')}</p>
    </section>
  );
}
