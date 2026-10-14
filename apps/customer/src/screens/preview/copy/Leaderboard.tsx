import { useState } from 'react';
import { BadgeCheck, TriangleAlert } from 'lucide-react';
import {
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sparkline,
  StateBlock,
  ToggleGroup,
  ToggleGroupItem,
} from '@intafaced/ui';
import { fmtPct, fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import type { SampleRiskBand, SampleTrader } from '../../../preview/fixtures/copy';
import { copyTradingCopy } from './copy';
import { ranked, type Period, type SortKey } from './model';

export function CheckBadge({ status }: { status: SampleTrader['check']['status'] }) {
  const { t } = copyTradingCopy.useCopy();
  if (status === 'verified')
    return (
      <span className="cp-badge" data-status="verified">
        <BadgeCheck size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('Check verified')}
      </span>
    );
  if (status === 'warning')
    return (
      <span className="cp-badge" data-status="warning">
        <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('Check warning')}
      </span>
    );
  return (
    <span className="cp-badge" data-status="pending">
      {t('Check pending')}
    </span>
  );
}

/**
 * The leaderboard: invented traders with sample stats, sorted and filtered here on the page. Picking a row shows that trader's profile
 * and follow settings; the Follow button opens the "nothing was sent" sheet.
 */
export function Leaderboard({
  traders,
  selected,
  onSelect,
}: {
  traders: readonly SampleTrader[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { t } = copyTradingCopy.useCopy();
  const [period, setPeriod] = useState<Period>('d30');
  const [sort, setSort] = useState<SortKey>('return');
  const [risk, setRisk] = useState<SampleRiskBand | 'all'>('all');
  const [checkedOnly, setCheckedOnly] = useState(false);
  const rows = ranked(traders, { period, sort, risk, checkedOnly });
  const riskItems = { all: t('Risk all'), low: t('Risk low'), medium: t('Risk medium'), high: t('Risk high') };
  const sortItems = { return: t('Sort return'), drawdown: t('Sort drawdown'), followers: t('Sort followers'), winRate: t('Sort winRate') };
  return (
    <section className="if-preview__panel cp-board" aria-labelledby="cp-board-h" data-testid="copy-leaderboard">
      <div className="if-preview__panel-head cp-board__head">
        <h2 className="if-preview__h2" id="cp-board-h">
          {t('Board heading')}
        </h2>
        <PreviewChip />
        <ToggleGroup
          aria-label={t('Period label')}
          variant="pill"
          value={period}
          onValueChange={(next) => setPeriod(next as Period)}
          className="cp-board__period"
        >
          <ToggleGroupItem value="d7">{t('Period d7')}</ToggleGroupItem>
          <ToggleGroupItem value="d30">{t('Period d30')}</ToggleGroupItem>
          <ToggleGroupItem value="d90">{t('Period d90')}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <p className="cp-fine">
        {t('All sample')} {t('Names note')}
      </p>
      <div className="cp-filters">
        <div className="cp-field">
          <span className="cp-field__label" id="cp-sort-label">
            {t('Sort label')}
          </span>
          <Select items={sortItems} value={sort} onValueChange={(next) => next && setSort(next as SortKey)}>
            <SelectTrigger aria-labelledby="cp-sort-label" size={32} className="cp-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(sortItems) as SortKey[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {sortItems[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="cp-field">
          <span className="cp-field__label" id="cp-risk-label">
            {t('Risk label')}
          </span>
          <Select items={riskItems} value={risk} onValueChange={(next) => next && setRisk(next as SampleRiskBand | 'all')}>
            <SelectTrigger aria-labelledby="cp-risk-label" size={32} className="cp-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(riskItems) as Array<keyof typeof riskItems>).map((key) => (
                <SelectItem key={key} value={key}>
                  {riskItems[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="cp-check">
          <Checkbox checked={checkedOnly} onCheckedChange={setCheckedOnly} />
          {t('Checked only')}
        </label>
      </div>
      {rows.length === 0 ? (
        <StateBlock kind="empty" title={t('Empty board title')} body={t('Empty board body')} />
      ) : (
        <div className="cp-table-wrap">
          <table className="cp-table">
            <caption className="cp-sr">{t('Board heading')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('Col rank')}</th>
                <th scope="col">{t('Col trader')}</th>
                <th scope="col" className="cp-num">
                  {t('Col return')}
                </th>
                <th scope="col">{t('Col curve')}</th>
                <th scope="col" className="cp-num">
                  {t('Col drawdown')}
                </th>
                <th scope="col" className="cp-num">
                  {t('Col win')}
                </th>
                <th scope="col" className="cp-num">
                  {t('Col followers')}
                </th>
                <th scope="col" className="cp-num">
                  {t('Col funds')}
                </th>
                <th scope="col" className="cp-num">
                  {t('Col min')}
                </th>
                <th scope="col" className="cp-sr">
                  {t('Col follow')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((trader, index) => (
                <tr
                  key={trader.id}
                  data-trader={trader.id}
                  data-selected={trader.id === selected || undefined}
                  onClick={() => onSelect(trader.id)}
                >
                  <td className="cp-rank if-num">{index + 1}</td>
                  <th scope="row" className="cp-who">
                    <button type="button" className="cp-pick" aria-pressed={trader.id === selected} onClick={() => onSelect(trader.id)}>
                      <span className="cp-avatar" aria-hidden="true">
                        {trader.name.slice(-1)}
                      </span>
                      <span className="cp-who__text">
                        <span className="cp-who__name">{trader.name}</span>
                        <span className="cp-who__meta">
                          {trader.style} · {t(`Risk badge ${trader.risk}` as 'Risk badge low')}
                        </span>
                      </span>
                    </button>
                    <CheckBadge status={trader.check.status} />
                  </th>
                  <td className="cp-num if-num" data-direction={trader.returns[period].startsWith('-') ? 'down' : 'up'}>
                    {fmtPct(trader.returns[period])}
                  </td>
                  <td className="cp-spark">
                    <Sparkline
                      values={trader.curve}
                      width={88}
                      height={28}
                      baseline={false}
                      label={t('Curve label', { name: trader.name })}
                    />
                  </td>
                  <td className="cp-num if-num">{fmtPct(trader.drawdown, { signed: false })}</td>
                  <td className="cp-num if-num">{fmtPct(trader.winRate, { signed: false })}</td>
                  <td className="cp-num if-num">{trader.followers}</td>
                  <td className="cp-num if-num">{fmtUsd(trader.copiedFunds, { compact: true })}</td>
                  <td className="cp-num if-num">{fmtUsd(trader.minCopy)}</td>
                  <td className="cp-act">
                    <PreviewActionButton product="copy" variant="secondary" size={28} onClick={undefined}>
                      {t('Follow')}
                    </PreviewActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
