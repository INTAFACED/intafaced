import { useState } from 'react';
import { Button, DecimalField, Segmented, Select } from '@intafaced/ui/lit';
import { KeyValue, Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount, dec } from '../rooms/ui';
import type { ListedMarket } from '../rooms/api';
import { useRoomApi } from '../rooms/read';
import { roomWords, type Words } from '../rooms/refusals';
import { optionsCopy } from './copy';
import { kvRow } from './notices';
import { PayoffChart } from './PayoffChart';
import { analyse, buildPreset, legIssues, PRESET_IDS, UNLIMITED, type Leg, type LegField, type PayoffRow, type PresetId } from './model';

type GreeksView =
  { kind: 'ok'; delta: string; gamma: string; vega: string; theta: string; npv: string } | { kind: 'refused'; words: Words };

const blankLeg = (from: ListedMarket | null): Leg => ({
  side: 'buy',
  right: from?.optionType ?? 'call',
  strike: from?.strike ?? '',
  qty: '1',
  premium: '',
});

const places = 6;

export function StrategyTab({
  selected,
  onGreeksLinked,
}: {
  selected: ListedMarket | null;
  onGreeksLinked: (linked: boolean | null) => void;
}) {
  const { t } = optionsCopy.useCopy();
  const api = useRoomApi();
  const [legs, setLegs] = useState<Leg[]>([]);
  const [multiplier, setMultiplier] = useState('1');
  const [preset, setPreset] = useState<PresetId>('straddle');
  const [centre, setCentre] = useState(selected?.strike ?? '');
  const [step, setStep] = useState('');
  const [presetError, setPresetError] = useState(false);
  const [inputs, setInputs] = useState({ spot: '', vol: '', tte: '', rate: '0', yld: '0' });
  const [greeks, setGreeks] = useState<Array<GreeksView> | null>(null);
  const [asking, setAsking] = useState(false);

  const change = (next: Leg[]) => {
    setLegs(next);
    setGreeks(null);
  };
  const patch = (i: number, part: Partial<Leg>) => change(legs.map((leg, at) => (at === i ? { ...leg, ...part } : leg)));
  const analysis = analyse(legs, multiplier);

  function applyPreset() {
    const built = buildPreset(preset, centre, step);
    setPresetError(built === null);
    if (built) change(built);
  }

  const inputsReady =
    dec(inputs.spot) !== null &&
    dec(inputs.spot)! > 0n &&
    dec(inputs.vol) !== null &&
    dec(inputs.vol)! > 0n &&
    dec(inputs.tte) !== null &&
    dec(inputs.tte)! > 0n &&
    dec(inputs.rate) !== null &&
    dec(inputs.yld) !== null;

  async function askGreeks() {
    setAsking(true);
    const answers = await Promise.all(
      legs.map((leg) =>
        api.greeks({
          right: leg.right,
          spot: inputs.spot,
          strike: leg.strike,
          volatility: inputs.vol,
          timeToExpiry: inputs.tte,
          riskFreeRate: inputs.rate,
          dividendYield: inputs.yld,
        }),
      ),
    );
    const views = answers.map((answer): GreeksView => {
      if (!answer.ok) return { kind: 'refused', words: roomWords({ reason: answer.reason, message: answer.message, code: answer.code }) };
      if (!answer.data.ok) return { kind: 'refused', words: roomWords({ code: answer.data.code, message: answer.data.message }) };
      const { delta, gamma, vega, theta, npv } = answer.data;
      return { kind: 'ok', delta, gamma, vega, theta, npv };
    });
    setGreeks(views);
    onGreeksLinked(
      views.some((v) => v.kind === 'ok')
        ? true
        : views.some((v) => v.kind === 'refused' && v.words.code?.includes('unlinked'))
          ? false
          : null,
    );
    setAsking(false);
  }

  const fieldError = (leg: Leg, field: LegField): string | undefined => {
    const issue = legIssues(leg)[field];
    if (issue !== 'invalid') return undefined;
    return field === 'premium' ? t('Price cannot be negative') : t('Must be above zero');
  };

  const payoffColumns: Column<PayoffRow>[] = [
    { key: 'spot', label: t('Price at expiry'), align: 'end', cell: (r) => fmtAmount(r.spot, { places }) },
    {
      key: 'pnl',
      label: t('Result'),
      align: 'end',
      cell: (r) => {
        const v = dec(r.pnl)!;
        return <span data-dir={v > 0n ? 'up' : v < 0n ? 'down' : undefined}>{`${v > 0n ? '+' : ''}${fmtAmount(r.pnl, { places })}`}</span>;
      },
    },
    { key: 'word', label: t('Outcome'), cell: (r) => (dec(r.pnl)! > 0n ? t('Profit') : dec(r.pnl)! < 0n ? t('Loss') : t('Break-even')) },
  ];

  const money = (value: string) => fmtAmount(value, { places });

  const decimal = (label: string, value: string, onValueChange: (v: string) => void, extra?: { hint?: string; error?: string }) => (
    <DecimalField label={label} value={value} onValueChange={onValueChange} precision={8} hint={extra?.hint} error={extra?.error} />
  );

  return (
    <div className="lt-stack">
      <p className="lt-hint">{t('Strategy intro')}</p>

      <section aria-label={t('Presets')} className="lt-toolbar">
        <Select
          label={t('Preset')}
          value={preset}
          onChange={(v) => setPreset(v as PresetId)}
          options={PRESET_IDS.map((id) => ({ value: id, label: t(`Preset ${id}`) }))}
        />
        {decimal(t('Centre strike'), centre, setCentre)}
        {decimal(t('Strike step'), step, setStep, { error: presetError ? t('Preset needs numbers') : undefined })}
        <Button onClick={applyPreset}>{t('Fill legs')}</Button>
        <Button tone="quiet" onClick={() => change([...legs, blankLeg(selected)])}>
          {t('Add leg')}
        </Button>
        <Button tone="quiet" disabled={legs.length === 0} onClick={() => change([])}>
          {t('Clear')}
        </Button>
      </section>

      {legs.length === 0 ? <p className="lt-hint">{t('No legs')}</p> : null}
      <ul className="lt-list">
        {legs.map((leg, i) => {
          const g = greeks?.[i];
          return (
            <li key={i} className="lt-stack">
              <div className="lt-toolbar">
                <Segmented
                  label={t('Leg side', { n: String(i + 1) })}
                  value={leg.side}
                  onChange={(v) => patch(i, { side: v as Leg['side'] })}
                  options={[
                    { value: 'buy', label: t('Buy') },
                    { value: 'sell', label: t('Sell') },
                  ]}
                />
                <Segmented
                  label={t('Leg type', { n: String(i + 1) })}
                  value={leg.right}
                  onChange={(v) => patch(i, { right: v as Leg['right'] })}
                  options={[
                    { value: 'call', label: t('Call') },
                    { value: 'put', label: t('Put') },
                  ]}
                />
                {decimal(t('Strike'), leg.strike, (v) => patch(i, { strike: v }), { error: fieldError(leg, 'strike') })}
                {decimal(t('Quantity'), leg.qty, (v) => patch(i, { qty: v }), { error: fieldError(leg, 'qty') })}
                {decimal(t('Your price'), leg.premium, (v) => patch(i, { premium: v }), {
                  hint: t('Entered by you'),
                  error: fieldError(leg, 'premium'),
                })}
                <Button
                  tone="quiet"
                  aria-label={t('Remove leg', { n: String(i + 1) })}
                  onClick={() => change(legs.filter((_, at) => at !== i))}
                >
                  {t('Remove')}
                </Button>
              </div>
              {g ? (
                <p className="lt-hint" aria-live="polite">
                  {g.kind === 'ok'
                    ? `${t('Delta')} ${fmtAmount(g.delta, { places })} · ${t('Gamma')} ${fmtAmount(g.gamma, { places })} · ${t('Vega')} ${fmtAmount(g.vega, { places })} · ${t('Theta')} ${fmtAmount(g.theta, { places })} · ${t('Value')} ${fmtAmount(g.npv, { places })}`
                    : `${t('Delta')} —  ${t('Gamma')} —  ${t('Vega')} —  ${t('Theta')} —  · ${g.words.title}. ${g.words.body}`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {legs.length > 0 && analysis === null ? <p className="lt-alert">{t('Finish the legs')}</p> : null}

      {analysis ? (
        <section aria-label={t('Result at expiry')} className="lt-stack">
          <p className="lt-hint">{t('Not a quote')}</p>
          <KeyValue
            rows={[
              kvRow(
                t('Net price'),
                analysis.netPremium.kind === 'flat'
                  ? t('Even')
                  : `${analysis.netPremium.kind === 'debit' ? t('You pay') : t('You receive')} ${money(analysis.netPremium.amount)}`,
              ),
              kvRow(t('Best result'), analysis.maxProfit === UNLIMITED ? t('Unlimited') : money(analysis.maxProfit)),
              kvRow(t('Worst result'), analysis.maxLoss === UNLIMITED ? t('Unlimited') : money(analysis.maxLoss)),
              kvRow(t('Break-even'), analysis.breakEvens.length ? analysis.breakEvens.map(money).join(', ') : t('None')),
            ]}
          />
          <PayoffChart
            rows={analysis.rows}
            label={t('Payoff chart label')}
            lowLabel={t('Price {value}', { value: money(analysis.rows[0]!.spot) })}
            highLabel={t('Price {value}', { value: money(analysis.rows[analysis.rows.length - 1]!.spot) })}
          />
          <div className="lt-scroll-x">
            <Table caption={t('Result at expiry')} mode="pro" columns={payoffColumns} rows={analysis.rows} rowKey={(r) => r.spot} />
          </div>
          <p className="lt-hint">{t('Margin blocker')}</p>
        </section>
      ) : null}

      <section aria-label={t('Greeks')} className="lt-stack">
        <h3 className="lt-heading">{t('Greeks')}</h3>
        <p className="lt-hint">{t('Greeks intro')}</p>
        <div className="lt-toolbar">
          {decimal(t('Contract size'), multiplier, setMultiplier, { hint: t('Contract size hint') })}
          {decimal(t('Spot price'), inputs.spot, (v) => setInputs({ ...inputs, spot: v }))}
          {decimal(t('Volatility'), inputs.vol, (v) => setInputs({ ...inputs, vol: v }), { hint: t('Volatility hint') })}
          {decimal(t('Years to expiry'), inputs.tte, (v) => setInputs({ ...inputs, tte: v }))}
          {decimal(t('Interest rate'), inputs.rate, (v) => setInputs({ ...inputs, rate: v }))}
          {decimal(t('Dividend yield'), inputs.yld, (v) => setInputs({ ...inputs, yld: v }))}
          <Button aria-busy={asking || undefined} disabled={analysis === null || !inputsReady || asking} onClick={() => void askGreeks()}>
            {t('Get Greeks')}
          </Button>
        </div>
        {analysis === null ? (
          <p className="lt-hint">{t('Greeks need legs')}</p>
        ) : !inputsReady ? (
          <p className="lt-hint">{t('Greeks need inputs')}</p>
        ) : null}
      </section>
    </div>
  );
}
