import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  KeyValue,
  SegmentedControl,
} from '@intafaced/ui';
import type { Listing } from '../../../features/trade/trade-api';
import type { z } from 'zod';
import type { algoSchema } from '../../../features/trade/tool-api';
import { useTicker } from '../../../data';
import { dec, str, times } from '../../../data/decimal';
import { ratioPercent } from './desk';
import { displayAmount } from '../../../shared/money';
import type { AlgoPolicy, RoomApi } from './api';
import { roomCopy } from './copy';
import type { WriteGuard } from './guard';
import { InfoNote, RefusalNote, SelectField } from './parts';
import { formatClock, minutesToMs, planSlices, MAX_DURATION_MS } from './plan';

type Step = 1 | 2 | 3;
export type BotKind = 'twap' | 'vwap' | 'pov';
export type CreatedAlgo = z.infer<typeof algoSchema>;

const PRESETS = [
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '60', label: '1 h' },
  { value: '240', label: '4 h' },
] as const;

const newAlgoId = () => `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function TwapWizard({
  open,
  kind,
  onOpenChange,
  api,
  guard,
  policy,
  markets,
  available,
  onCreated,
}: {
  open: boolean;
  kind: BotKind;
  onOpenChange: (open: boolean) => void;
  api: RoomApi;
  guard: WriteGuard;
  policy: AlgoPolicy | null;
  markets: Listing[];
  /** What the customer can use of an asset, or null while it is unknown. */
  available: (asset: string) => string | null;
  onCreated: (algo: CreatedAlgo) => void;
}) {
  const { t } = roomCopy.useCopy();
  const [step, setStep] = useState<Step>(1);
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState('');
  const [duration, setDuration] = useState('60');
  const [interval, setInterval_] = useState('5');
  const [limit, setLimit] = useState('');
  const [participation, setParticipation] = useState('1000');
  const [touched, setTouched] = useState(false);
  const [algoId, setAlgoId] = useState(newAlgoId);

  const market = markets.find((m) => m.symbol === symbol) ?? null;
  useEffect(() => {
    if (open && !market && markets[0]) setSymbol((markets.find((m) => m.symbol === 'BTC/USDT') ?? markets[0]).symbol);
  }, [open, market, markets]);

  const ticker = useTicker(symbol || 'BTC/USDT', { intervalMs: 15_000 });
  const last = ticker.status === 'ready' ? ticker.data.last : null;

  const durationMs = minutesToMs(duration);
  const intervalMs = minutesToMs(interval);
  const plan = useMemo(
    () =>
      market && durationMs !== null && intervalMs !== null
        ? planSlices({ totalQty: qty, durationMs, sliceIntervalMs: intervalMs, lotSize: market.precision.amount })
        : null,
    [market, qty, durationMs, intervalMs],
  );
  const estimate = useMemo(() => {
    const q = dec(plan && plan.ok ? plan.planned : null);
    const p = dec(limit || last);
    return q !== null && p !== null ? str(times(q, p)) : null;
  }, [plan, limit, last]);

  const spendAsset = market ? (side === 'buy' ? market.quote : market.base) : '';
  const have = spendAsset ? available(spendAsset) : null;
  const need = side === 'buy' ? estimate : plan && plan.ok ? plan.planned : null;
  const short = have !== null && need !== null && (dec(need) ?? 0n) > (dec(have) ?? 0n);

  const tooMany = plan && plan.ok && plan.slices > 500;
  const problems = {
    market: market ? '' : t('Choose a market'),
    qty: (dec(qty) ?? 0n) > 0n ? '' : t('Enter an amount above zero'),
    plan:
      plan === null
        ? t('Enter the run time and the gap between slices in minutes')
        : plan.ok
          ? tooMany
            ? t('That is more than 500 slices. Make the gap longer.')
            : ''
          : plan.why === 'belowLot'
            ? t('The amount is below one lot after it is split into slices')
            : plan.why === 'tooLong'
              ? t('A run can last 24 hours at most')
              : plan.why === 'schedule'
                ? t('The gap between slices can’t be longer than the whole run')
                : t('Enter an amount above zero'),
    limit: !limit || (dec(limit) ?? 0n) > 0n ? '' : t('Enter a price above zero, or leave it empty'),
    participation:
      kind !== 'pov' || ((dec(participation) ?? 0n) >= 1n && (dec(participation) ?? 0n) <= 10_000n * 10n ** 18n)
        ? ''
        : t('Enter 1 to 10000'),
  };
  const ok1 = !problems.market;
  const ok2 = !problems.qty && !problems.plan && !problems.limit && !problems.participation;
  const show = (m: string) => (touched ? m : '');

  const reset = () => {
    setStep(1);
    setTouched(false);
    setAlgoId(newAlgoId());
    guard.setFailure(null);
  };
  const next = () => {
    setTouched(true);
    if ((step === 1 && ok1) || (step === 2 && ok2)) {
      setTouched(false);
      setStep((step + 1) as Step);
    }
  };
  const start = () => {
    if (!market || durationMs === null || intervalMs === null || !plan || !plan.ok || guard.busy || guard.locked) return;
    void guard.run(
      { kind: 'algo', id: algoId, symbol: market.symbol },
      () =>
        api.createTwap({
          symbol: market.symbol,
          side,
          totalQty: qty,
          durationMs,
          sliceIntervalMs: intervalMs,
          ...(limit ? { limitPrice: limit } : {}),
          clientAlgoId: algoId,
          kind,
          ...(kind === 'pov' ? { participationBps: Number(participation) } : {}),
        }),
      (algo) => {
        onCreated(algo);
        onOpenChange(false);
        reset();
      },
    );
  };

  const kindWord = kind === 'twap' ? t('Time-weighted (TWAP)') : kind === 'vwap' ? t('Volume-weighted (VWAP)') : t('Participation (POV)');
  const schedulerOff = policy !== null && !policy.capability.jobsEnabled;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="cb-dialog">
        <DialogHeader>
          <DialogTitle>{t('Set up a {kind} bot', { kind: kindWord })}</DialogTitle>
          <DialogDescription>
            {t('Step {step} of 3. It places small orders over time instead of one big order.', { step })}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="cb-form">
            <SelectField
              label={t('Market')}
              value={symbol}
              onChange={setSymbol}
              options={markets.map((m) => ({ value: m.symbol, label: m.symbol }))}
              placeholder={t('Choose a market')}
            />
            <div className="cb-selectfield">
              <span className="cb-label">{t('Side')}</span>
              <SegmentedControl
                aria-label={t('Side')}
                size={40}
                fullWidth
                value={side}
                onValueChange={(v) => setSide(v === 'sell' ? 'sell' : 'buy')}
                items={[
                  { value: 'buy', label: t('Buy') },
                  { value: 'sell', label: t('Sell') },
                ]}
              />
            </div>
            {show(problems.market) ? <p className="cb-error">{problems.market}</p> : null}
            <InfoNote>{t('The bot trades with your real balance on this market. Each slice is an ordinary order.')}</InfoNote>
          </div>
        ) : null}

        {step === 2 && market ? (
          <div className="cb-form">
            <Field
              label={t('Total amount ({asset})', { asset: market.base })}
              hint={t('Lot size {lot}', { lot: market.precision.amount })}
              error={show(problems.qty || (plan && !plan.ok && plan.why === 'belowLot' ? problems.plan : ''))}
              required
            >
              <Input kind="decimal" value={qty} onValueChange={setQty} precision={8} trailing={market.base} />
            </Field>
            <div className="cb-selectfield">
              <span className="cb-label">{t('Run time')}</span>
              <SegmentedControl
                aria-label={t('Run time')}
                size={32}
                fullWidth
                value={PRESETS.some((p) => p.value === duration) ? duration : 'custom'}
                onValueChange={(v) => v !== 'custom' && setDuration(v)}
                items={[...PRESETS.map((p) => ({ value: p.value, label: p.label })), { value: 'custom', label: t('Custom') }]}
              />
            </div>
            <Field
              label={t('Run time (minutes)')}
              hint={t('Up to 1440')}
              error={show(durationMs === null || (plan && !plan.ok && plan.why === 'tooLong') ? problems.plan : '')}
              required
            >
              <Input kind="decimal" value={duration} onValueChange={setDuration} precision={2} />
            </Field>
            <Field
              label={t('Gap between slices (minutes)')}
              error={show(plan && !plan.ok && plan.why === 'schedule' ? problems.plan : tooMany ? problems.plan : '')}
              required
            >
              <Input kind="decimal" value={interval} onValueChange={setInterval_} precision={2} />
            </Field>
            {kind === 'pov' ? (
              <Field
                label={t('Share of market volume (basis points)')}
                hint={t('1000 is 10%')}
                error={show(problems.participation)}
                required
              >
                <Input kind="decimal" value={participation} onValueChange={setParticipation} precision={0} />
              </Field>
            ) : null}
            <Field
              label={t('Price limit ({asset})', { asset: market.quote })}
              hint={
                side === 'buy'
                  ? t('Optional. A buy slice never pays more than this.')
                  : t('Optional. A sell slice never takes less than this.')
              }
              error={show(problems.limit)}
            >
              <Input kind="decimal" value={limit} onValueChange={setLimit} precision={8} trailing={market.quote} />
            </Field>
            {plan && plan.ok ? (
              <KeyValue
                items={[
                  { label: t('Slices'), value: String(plan.slices) },
                  {
                    label: t('Each slice'),
                    value: kind === 'twap' ? `${displayAmount(plan.perSlice)} ${market.base}` : t('Sized from market volume'),
                  },
                  ...(kind === 'twap' ? [{ label: t('Last slice'), value: `${displayAmount(plan.lastSlice)} ${market.base}` }] : []),
                  { label: t('Left out (below one lot)'), value: `${displayAmount(plan.leftOut)} ${market.base}` },
                  { label: t('Runs for'), value: durationMs === null ? null : formatClock(Math.min(durationMs, MAX_DURATION_MS)) },
                ]}
              />
            ) : null}
          </div>
        ) : null}

        {step === 3 && market && plan && plan.ok ? (
          <div className="cb-form">
            {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
            <section aria-label={t('What it will do')}>
              <h3 className="cb-h3">{t('What it will do')}</h3>
              <KeyValue
                items={[
                  { label: t('Bot'), value: kindWord },
                  { label: t('Market'), value: market.symbol },
                  { label: t('Side'), value: side === 'buy' ? t('Buy') : t('Sell') },
                  { label: t('Total to trade'), value: `${displayAmount(plan.planned)} ${market.base}` },
                  { label: t('Slices'), value: `${plan.slices}, every ${interval} min` },
                  {
                    label: t('Price limit'),
                    value: limit ? `${displayAmount(limit)} ${market.quote}` : t('None, each slice trades at the market'),
                  },
                ]}
              />
            </section>
            <section aria-label={t('All-in before you start')} className="cb-cost">
              <h3 className="cb-h3">{t('All-in before you start')}</h3>
              <KeyValue
                items={[
                  {
                    label:
                      side === 'buy'
                        ? t('Estimated cost, before fees and price moves')
                        : t('Estimated proceeds, before fees and price moves'),
                    value: estimate === null ? null : `${displayAmount(estimate)} ${market.quote}`,
                    hint: limit
                      ? t('At your price limit')
                      : last
                        ? t('At the last price {price}', { price: last })
                        : t('No price available right now'),
                  },
                  {
                    label: t('Trading fee'),
                    value: t('Each slice pays the normal fee for this market ({maker} maker, {taker} taker)', {
                      maker: ratioPercent(market.maker) ?? '—',
                      taker: ratioPercent(market.taker) ?? '—',
                    }),
                  },
                  {
                    label: t('You can use now ({asset})', { asset: spendAsset }),
                    value: have === null ? null : displayAmount(have),
                  },
                  { label: t('Funds are held'), value: t('Slice by slice, when each order is placed. Nothing is locked up front') },
                ]}
              />
            </section>
            {short ? (
              <InfoNote tone="warn">
                {t('You may not have enough {asset} for the whole run. Slices that cannot be paid are refused.', { asset: spendAsset })}
              </InfoNote>
            ) : null}
            {schedulerOff ? (
              <InfoNote tone="warn">
                {t(
                  'The scheduler that places slices is switched off in this environment. The bot can be created and watched, but no slice is placed until it runs.',
                )}
              </InfoNote>
            ) : null}
            <InfoNote>{t('Stop ends the remaining slices. Slices already filled stay filled.')}</InfoNote>
          </div>
        ) : null}

        <DialogFooter>
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep((step - 1) as Step)} disabled={guard.busy}>
              {t('Back')}
            </Button>
          ) : null}
          {step < 3 ? (
            <Button onClick={next}>{t('Next')}</Button>
          ) : (
            <Button onClick={start} loading={guard.busy} disabled={guard.locked || !guard.signedIn}>
              {t('Start bot')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
