import { useState } from 'react';
import {
  Button,
  Field,
  Input,
  KeyValue,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  fmtAmount,
  dec,
  type TableColumn,
} from '../rooms/ui';
import type { ListedMarket } from '../rooms/api';
import { useRoomApi } from '../rooms/read';
import { roomWords, type Words } from '../rooms/refusals';
import { optionsCopy } from './copy';
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

  const payoffColumns: TableColumn<PayoffRow>[] = [
    {
      id: 'spot',
      header: t('Price at expiry'),
      width: 160,
      pin: 'start',
      numeric: true,
      value: (r) => r.spot,
      cell: (r) => fmtAmount(r.spot, { places }),
    },
    {
      id: 'pnl',
      header: t('Result'),
      numeric: true,
      value: (r) => r.pnl,
      cell: (r) => {
        const v = dec(r.pnl)!;
        return (
          <span
            className={v > 0n ? 'text-up-text' : v < 0n ? 'text-down-text' : undefined}
          >{`${v > 0n ? '+' : ''}${fmtAmount(r.pnl, { places })}`}</span>
        );
      },
    },
    { id: 'word', header: t('Outcome'), cell: (r) => (dec(r.pnl)! > 0n ? t('Profit') : dec(r.pnl)! < 0n ? t('Loss') : t('Break-even')) },
  ];

  const money = (value: string) => fmtAmount(value, { places });

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-fg-2">{t('Strategy intro')}</p>

      <section aria-label={t('Presets')} className="flex flex-wrap items-end gap-3">
        <Field density="dense" label={t('Preset')}>
          <Select
            items={Object.fromEntries(PRESET_IDS.map((id) => [id, t(`Preset ${id}`)]))}
            value={preset}
            onValueChange={(v) => v && setPreset(v as PresetId)}
          >
            <SelectTrigger size={32} aria-label={t('Preset')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESET_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`Preset ${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field density="dense" label={t('Centre strike')}>
          <Input kind="decimal" precision={8} value={centre} onValueChange={setCentre} className="w-32" />
        </Field>
        <Field density="dense" label={t('Strike step')} error={presetError ? t('Preset needs numbers') : undefined}>
          <Input kind="decimal" precision={8} value={step} onValueChange={setStep} className="w-32" />
        </Field>
        <Button variant="secondary" size={32} onClick={applyPreset}>
          {t('Fill legs')}
        </Button>
        <Button variant="ghost" size={32} onClick={() => change([...legs, blankLeg(selected)])}>
          {t('Add leg')}
        </Button>
        <Button variant="ghost" size={32} disabled={legs.length === 0} onClick={() => change([])}>
          {t('Clear')}
        </Button>
      </section>

      {legs.length === 0 ? <p className="m-0 text-sm text-fg-2">{t('No legs yet')}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {legs.map((leg, i) => {
          const g = greeks?.[i];
          return (
            <li key={i} className="flex flex-col gap-2 rounded-sm border border-line bg-panel p-3">
              <div className="flex flex-wrap items-start gap-3">
                <SegmentedControl
                  aria-label={t('Leg side', { n: String(i + 1) })}
                  size={28}
                  value={leg.side}
                  onValueChange={(v) => patch(i, { side: v as Leg['side'] })}
                  items={[
                    { value: 'buy', label: t('Buy'), tone: 'up' },
                    { value: 'sell', label: t('Sell'), tone: 'down' },
                  ]}
                />
                <SegmentedControl
                  aria-label={t('Leg type', { n: String(i + 1) })}
                  size={28}
                  value={leg.right}
                  onValueChange={(v) => patch(i, { right: v as Leg['right'] })}
                  items={[
                    { value: 'call', label: t('Call') },
                    { value: 'put', label: t('Put') },
                  ]}
                />
                <Field density="dense" label={t('Strike')} error={fieldError(leg, 'strike')}>
                  <Input kind="decimal" precision={8} value={leg.strike} onValueChange={(v) => patch(i, { strike: v })} className="w-28" />
                </Field>
                <Field density="dense" label={t('Quantity')} error={fieldError(leg, 'qty')}>
                  <Input kind="decimal" precision={8} value={leg.qty} onValueChange={(v) => patch(i, { qty: v })} className="w-24" />
                </Field>
                <Field density="dense" label={t('Your price')} hint={t('Entered by you')} error={fieldError(leg, 'premium')}>
                  <Input
                    kind="decimal"
                    precision={8}
                    value={leg.premium}
                    onValueChange={(v) => patch(i, { premium: v })}
                    className="w-28"
                  />
                </Field>
                <Button
                  variant="ghost"
                  size={28}
                  aria-label={t('Remove leg', { n: String(i + 1) })}
                  onClick={() => change(legs.filter((_, at) => at !== i))}
                >
                  {t('Remove')}
                </Button>
              </div>
              {g ? (
                <p className="m-0 text-sm text-fg-2" aria-live="polite">
                  {g.kind === 'ok'
                    ? `${t('Delta')} ${fmtAmount(g.delta, { places })} · ${t('Gamma')} ${fmtAmount(g.gamma, { places })} · ${t('Vega')} ${fmtAmount(g.vega, { places })} · ${t('Theta')} ${fmtAmount(g.theta, { places })} · ${t('Value')} ${fmtAmount(g.npv, { places })}`
                    : `${t('Delta')} —  ${t('Gamma')} —  ${t('Vega')} —  ${t('Theta')} —  · ${g.words.title}. ${g.words.body}`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {legs.length > 0 && analysis === null ? <p className="m-0 text-sm text-warn">{t('Finish the legs')}</p> : null}

      {analysis ? (
        <section aria-label={t('Result at expiry')} className="flex flex-col gap-3">
          <p className="m-0 text-xs text-fg-2">{t('Not a quote')}</p>
          <KeyValue
            density="dense"
            items={[
              {
                label: t('Net price'),
                value:
                  analysis.netPremium.kind === 'flat'
                    ? t('Even')
                    : `${analysis.netPremium.kind === 'debit' ? t('You pay') : t('You receive')} ${money(analysis.netPremium.amount)}`,
              },
              { label: t('Best result'), value: analysis.maxProfit === UNLIMITED ? t('Unlimited') : money(analysis.maxProfit) },
              { label: t('Worst result'), value: analysis.maxLoss === UNLIMITED ? t('Unlimited') : money(analysis.maxLoss) },
              { label: t('Break-even'), value: analysis.breakEvens.length ? analysis.breakEvens.map(money).join(', ') : t('None') },
            ]}
          />
          <PayoffChart
            rows={analysis.rows}
            label={t('Payoff chart label')}
            lowLabel={t('Price {value}', { value: money(analysis.rows[0]!.spot) })}
            highLabel={t('Price {value}', { value: money(analysis.rows[analysis.rows.length - 1]!.spot) })}
          />
          <Table
            label={t('Result at expiry')}
            minWidth={480}
            density="dense"
            columns={payoffColumns}
            rows={analysis.rows}
            getRowId={(r) => r.spot}
          />
          <p className="m-0 text-xs text-fg-2">{t('Margin blocker')}</p>
        </section>
      ) : null}

      <section aria-label={t('Greeks')} className="flex flex-col gap-3">
        <h3 className="m-0 text-md font-medium text-fg">{t('Greeks')}</h3>
        <p className="m-0 text-sm text-fg-2">{t('Greeks intro')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field density="dense" label={t('Contract size')} hint={t('Contract size hint')}>
            <Input kind="decimal" precision={8} value={multiplier} onValueChange={setMultiplier} className="w-24" />
          </Field>
          <Field density="dense" label={t('Spot price')}>
            <Input
              kind="decimal"
              precision={8}
              value={inputs.spot}
              onValueChange={(v) => setInputs({ ...inputs, spot: v })}
              className="w-28"
            />
          </Field>
          <Field density="dense" label={t('Volatility')} hint={t('Volatility hint')}>
            <Input
              kind="decimal"
              precision={8}
              value={inputs.vol}
              onValueChange={(v) => setInputs({ ...inputs, vol: v })}
              className="w-24"
            />
          </Field>
          <Field density="dense" label={t('Years to expiry')}>
            <Input
              kind="decimal"
              precision={8}
              value={inputs.tte}
              onValueChange={(v) => setInputs({ ...inputs, tte: v })}
              className="w-24"
            />
          </Field>
          <Field density="dense" label={t('Interest rate')}>
            <Input
              kind="decimal"
              precision={8}
              value={inputs.rate}
              onValueChange={(v) => setInputs({ ...inputs, rate: v })}
              className="w-24"
            />
          </Field>
          <Field density="dense" label={t('Dividend yield')}>
            <Input
              kind="decimal"
              precision={8}
              value={inputs.yld}
              onValueChange={(v) => setInputs({ ...inputs, yld: v })}
              className="w-24"
            />
          </Field>
          <Button
            variant="secondary"
            size={32}
            className="mt-[22px]"
            loading={asking}
            disabled={analysis === null || !inputsReady}
            onClick={() => void askGreeks()}
          >
            {t('Get Greeks')}
          </Button>
        </div>
        {analysis === null ? (
          <p className="m-0 text-xs text-fg-2">{t('Greeks need legs')}</p>
        ) : !inputsReady ? (
          <p className="m-0 text-xs text-fg-2">{t('Greeks need inputs')}</p>
        ) : null}
      </section>
    </div>
  );
}
