/**
 * Create a TWAP / VWAP / POV schedule. The preview is the all-in view before anything is sent. When the slice scheduler is
 * off the room says so and does not make the call (a schedule created now would sit active and place nothing).
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, KeyValue, SegmentedControl, fmtAmount, fmtPrice, type Loadable } from '../rooms/ui';
import { useNow, useRoomApi } from '../rooms/read';
import { rememberId } from '../rooms/store';
import type { RoomWriter } from '../rooms/write';
import type { AlgoParent, AlgoPolicy } from '../rooms/api';
import { execCopy } from './copy';
import { useLast, type ExecMarket } from './data';
import {
  DURATION_PRESETS,
  CREATE_BLOCKER_CODE,
  algoClientId,
  createBlocker,
  defaultIntervalMs,
  newNonce,
  parseSeed,
  planSchedule,
  triggerProblem,
  wholeNumber,
  type PlanProblem,
  type Side,
} from './model';
import { ConfirmDialog, Pick, Why, placesFor, useWhen } from './parts';

export interface AlgoFormValues {
  symbol: string;
  side: Side;
  kind: 'twap' | 'vwap' | 'pov';
  duration: string;
  customSec: string;
  intervalSec: string;
  total: string;
  limit: string;
  pov: string;
  /** TWAP only: random slice sizes fixed by `seed`. */
  random: boolean;
  seed: string;
  /** TWAP only: blank starts at once; a price makes the schedule wait for the market to reach it. */
  trigger: string;
}

export const FORM_DEFAULTS: AlgoFormValues = {
  symbol: '',
  side: 'buy',
  kind: 'twap',
  duration: '1h',
  customSec: '',
  intervalSec: '',
  total: '',
  limit: '',
  pov: '1000',
  random: false,
  seed: '',
  trigger: '',
};

/** The numbers of an existing schedule as form values: schedules are never edited, a new one is made from them. */
export function valuesFrom(parent: AlgoParent): AlgoFormValues {
  const preset = DURATION_PRESETS.find((p) => p.ms === parent.durationMs);
  return {
    symbol: parent.symbol,
    side: parent.side,
    kind: parent.kind,
    duration: preset ? preset.id : 'custom',
    customSec: preset ? '' : String(Math.ceil(parent.durationMs / 1000)),
    intervalSec: String(Math.ceil(parent.sliceIntervalMs / 1000)),
    total: parent.totalQty,
    limit: parent.limitPrice ?? '',
    pov: String(parent.participationBps ?? 1000),
    random: parent.randomSeed != null,
    seed: parent.randomSeed != null ? String(parent.randomSeed) : '',
    trigger: parent.triggerPrice ?? '',
  };
}

const DUPLICATE = /already exists|duplicate/i;

/** The service's slice sizes for a random TWAP, read when the review opens; confirm waits for them. */
type SizesRead = { state: 'off' } | { state: 'loading' } | { state: 'ready'; sizes: string[] } | { state: 'refused'; code?: string };

export function AlgoForm({
  markets,
  policy,
  writer,
  userId,
  prefill,
  onCreated,
  onCheck,
}: {
  markets: readonly ExecMarket[];
  policy: Loadable<AlgoPolicy>;
  writer: RoomWriter;
  userId: string | null;
  prefill: { values: AlgoFormValues; token: number } | null;
  onCreated: (id: string) => void;
  onCheck: (id: string) => void;
}) {
  const { t } = execCopy.useCopy();
  const room = useRoomApi();
  const when = useWhen();
  const now = useNow(15_000);
  const [form, setForm] = useState<AlgoFormValues>({ ...FORM_DEFAULTS, symbol: markets[0]?.symbol ?? '' });
  const [nonce, setNonce] = useState(newNonce);
  const [review, setReview] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [sizes, setSizes] = useState<SizesRead>({ state: 'off' });
  const set = <K extends keyof AlgoFormValues>(key: K, value: AlgoFormValues[K]) => setForm((f) => ({ ...f, [key]: value }));

  // A schedule cannot be edited, so "create new with these numbers" starts a new intent with a new id.
  useEffect(() => {
    if (!prefill) return;
    setForm(prefill.values);
    setNonce(newNonce());
    setDuplicate(false);
  }, [prefill]);

  const market = markets.find((m) => m.symbol === form.symbol) ?? null;
  const last = useLast(form.symbol);
  const durationMs =
    form.duration === 'custom'
      ? (wholeNumber(form.customSec) ?? 0) * 1000 || null
      : (DURATION_PRESETS.find((p) => p.id === form.duration)?.ms ?? null);
  const intervalMs =
    form.intervalSec.trim() === ''
      ? durationMs === null
        ? null
        : defaultIntervalMs(durationMs)
      : (wholeNumber(form.intervalSec) ?? 0) * 1000 || null;
  const povBps = wholeNumber(form.pov);
  const { plan, problems } = useMemo(
    () =>
      planSchedule({
        kind: form.kind,
        total: form.total,
        durationMs,
        intervalMs,
        lot: market?.lotSize ?? null,
        tick: market?.tickSize ?? null,
        minAmount: market?.minAmount ?? null,
        limit: form.limit,
        last,
        taker: market?.taker ?? null,
        participationBps: povBps,
        startMs: now,
      }),
    [form, durationMs, intervalMs, market, last, povBps, now],
  );

  const clientAlgoId = algoClientId(nonce);
  const blockerKey = createBlocker(policy.status === 'ready' ? policy.data.capability : null, market?.open === true);
  const blocker = blockerKey ? t(blockerKey) : null;
  const immature = policy.status === 'ready' && policy.data.immatureKinds.includes(form.kind);
  const problemWord = (p: PlanProblem) => t(`Plan problem ${p}`, { max: '500' });
  const general = problems.find((p) => p === 'tooManySlices' || p === 'sliceTooSmall' || p === 'sliceBelowMin');
  const twap = form.kind === 'twap';
  const seed = twap && form.random ? parseSeed(form.seed) : null;
  const seedBad = twap && form.random && seed === null;
  const triggerBad = twap && triggerProblem(form.trigger);
  const trigger = twap && !triggerBad && form.trigger.trim() ? form.trigger.trim() : null;
  const canReview = plan !== null && blocker === null && writer.signedIn && !seedBad && !triggerBad;
  const sizesBlock = seed !== null && sizes.state !== 'ready';

  async function openReview() {
    setReview(true);
    if (seed === null || !market) {
      setSizes({ state: 'off' });
      return;
    }
    setSizes({ state: 'loading' });
    const answer = await room.algoPreviewSizes({
      symbol: market.symbol,
      totalQty: form.total,
      durationMs: durationMs!,
      sliceIntervalMs: intervalMs!,
      randomSeed: seed,
    });
    setSizes(answer.ok ? { state: 'ready', sizes: answer.data.sliceQtys } : { state: 'refused', code: answer.code });
  }

  async function send() {
    if (!plan || !market || sizesBlock) return;
    setDuplicate(false);
    const result = await writer.run({
      kind: 'algo',
      id: clientAlgoId,
      symbol: market.symbol,
      call: async () => {
        const answer = await room.algoCreate({
          symbol: market.symbol,
          side: form.side,
          totalQty: form.total,
          durationMs: durationMs!,
          sliceIntervalMs: intervalMs!,
          kind: form.kind,
          clientAlgoId,
          ...(form.limit.trim() ? { limitPrice: form.limit.trim() } : {}),
          ...(form.kind === 'pov' ? { participationBps: povBps! } : {}),
          ...(seed !== null ? { randomSeed: seed } : {}),
          ...(trigger !== null ? { triggerPrice: trigger } : {}),
        });
        if (!answer.ok && DUPLICATE.test(answer.message)) setDuplicate(true);
        return answer;
      },
    });
    setReview(false);
    if (result.kind === 'done') {
      rememberId('algo', userId, result.data.id);
      onCreated(result.data.id);
      setNonce(newNonce());
    }
  }

  const amountPlaces = placesFor(market?.lotSize);
  const q = market?.quote ?? '';
  const rows = plan
    ? [
        { label: t('Market'), value: form.symbol },
        { label: t('Side'), value: form.side === 'buy' ? t('Buy') : t('Sell') },
        { label: t('Kind'), value: form.kind.toUpperCase() },
        { label: t('Total size'), value: `${fmtAmount(form.total, { places: amountPlaces })} ${market?.base ?? ''}` },
        {
          label: t('Slices planned'),
          value: String(plan.slices),
          hint: t('Every {seconds} s', { seconds: String(Math.round(intervalMs! / 1000)) }),
        },
        seed !== null
          ? { label: t('Size per slice'), value: t('Random sizes', { seed: String(seed) }) }
          : {
              label: t('Size per slice'),
              value: `${fmtAmount(plan.perSlice, { places: amountPlaces })} ${market?.base ?? ''}`,
              hint: t('Last slice takes the remainder: {size}', { size: fmtAmount(plan.lastSlice, { places: amountPlaces }) }),
            },
        {
          label: t('Limit price'),
          value: form.limit.trim() ? fmtPrice(form.limit, market?.tickSize) : t('No limit, slices go in at the market'),
        },
        {
          label: t('Estimated value'),
          value: plan.estNotional === null ? null : `${fmtAmount(plan.estNotional, { places: 2 })} ${q}`,
          hint: t('Estimate at the last price, not a quote'),
        },
        {
          label: t('Fee estimate'),
          value: plan.estFee === null ? null : `${fmtAmount(plan.estFee, { places: 4 })} ${q}`,
          hint: t('Upper estimate at the taker rate'),
        },
        { label: t('Held now'), value: t('Nothing'), hint: t('Each slice holds funds only when it is placed') },
        { label: t('Ends about'), value: when(plan.endsAt) },
        { label: t('Request id'), value: clientAlgoId, mono: true },
        ...(trigger !== null ? [{ label: t('Trigger price'), value: fmtPrice(trigger, market?.tickSize) }] : []),
      ]
    : [];

  return (
    <section aria-label={t('New schedule')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <h3 className="m-0 text-md font-medium text-fg">{t('New schedule')}</h3>
      <Field label={t('Market')}>
        <Pick
          label={t('Market')}
          value={form.symbol}
          options={markets.map((m) => ({ value: m.symbol, label: m.symbol }))}
          onChange={(v) => set('symbol', v)}
        />
      </Field>
      <SegmentedControl
        aria-label={t('Side')}
        size={32}
        fullWidth
        value={form.side}
        onValueChange={(v) => set('side', v as Side)}
        items={[
          { value: 'buy', label: t('Buy'), tone: 'up' },
          { value: 'sell', label: t('Sell'), tone: 'down' },
        ]}
      />
      <Field label={t('Kind')} hint={immature ? t('Immature volume warning') : undefined}>
        <Pick
          label={t('Kind')}
          value={form.kind}
          options={[
            { value: 'twap', label: t('TWAP') },
            { value: 'vwap', label: t('VWAP') },
            { value: 'pov', label: t('POV') },
          ]}
          onChange={(v) => set('kind', v)}
        />
      </Field>
      <Field
        label={t('Total size ({asset})', { asset: market?.base ?? '' })}
        error={problems.includes('total') && form.total ? problemWord('total') : problems.includes('lot') ? problemWord('lot') : undefined}
      >
        <Input
          kind="decimal"
          aria-label={t('Total size ({asset})', { asset: market?.base ?? '' })}
          value={form.total}
          onValueChange={(v) => set('total', v)}
          precision={amountPlaces}
          density="dense"
        />
      </Field>
      <Field label={t('Duration')} error={problems.includes('duration') ? problemWord('duration') : undefined}>
        <Pick
          label={t('Duration')}
          value={form.duration}
          options={[
            ...DURATION_PRESETS.map((p) => ({ value: p.id, label: t(`Duration ${p.id}`) })),
            { value: 'custom', label: t('Custom') },
          ]}
          onChange={(v) => set('duration', v)}
        />
      </Field>
      {form.duration === 'custom' ? (
        <Field label={t('Custom duration, seconds')} hint={t('Between 1 second and 24 hours (86400)')}>
          <Input
            aria-label={t('Custom duration, seconds')}
            value={form.customSec}
            onValueChange={(v) => set('customSec', v.replace(/\D/g, ''))}
            density="dense"
          />
        </Field>
      ) : null}
      <Field
        label={t('Slice interval, seconds')}
        hint={t('Empty uses {seconds} s', {
          seconds: durationMs === null ? '—' : String(Math.round(defaultIntervalMs(durationMs) / 1000)),
        })}
        error={problems.includes('interval') ? problemWord('interval') : undefined}
      >
        <Input
          aria-label={t('Slice interval, seconds')}
          value={form.intervalSec}
          onValueChange={(v) => set('intervalSec', v.replace(/\D/g, ''))}
          density="dense"
        />
      </Field>
      {form.kind === 'pov' ? (
        <Field
          label={t('Participation, basis points')}
          hint={t('1 to 10000, so 1000 is 10% of volume')}
          error={problems.includes('participation') ? problemWord('participation') : undefined}
        >
          <Input
            aria-label={t('Participation, basis points')}
            value={form.pov}
            onValueChange={(v) => set('pov', v.replace(/\D/g, ''))}
            density="dense"
          />
        </Field>
      ) : null}
      <Field
        label={t('Limit price (optional)')}
        hint={t('No limit means market slices')}
        error={problems.includes('limit') ? problemWord('limit') : undefined}
      >
        <Input
          kind="decimal"
          aria-label={t('Limit price (optional)')}
          value={form.limit}
          onValueChange={(v) => set('limit', v)}
          precision={placesFor(market?.tickSize)}
          density="dense"
        />
      </Field>
      {twap ? (
        <>
          <label className="flex items-center gap-2 text-sm text-fg">
            <Checkbox checked={form.random} onCheckedChange={(v) => set('random', v === true)} />
            <span>{t('Random slice sizes')}</span>
          </label>
          {form.random ? (
            <Field label={t('Seed')} hint={t('Seed hint')} error={seedBad && form.seed.trim() ? t('Seed problem') : undefined}>
              <Input aria-label={t('Seed')} value={form.seed} onValueChange={(v) => set('seed', v.replace(/\D/g, ''))} density="dense" />
            </Field>
          ) : null}
          <Field label={t('Start when the price reaches')} hint={t('Trigger hint')} error={triggerBad ? t('Trigger problem') : undefined}>
            <Input
              kind="decimal"
              aria-label={t('Start when the price reaches')}
              value={form.trigger}
              onValueChange={(v) => set('trigger', v)}
              precision={placesFor(market?.tickSize)}
              density="dense"
            />
          </Field>
        </>
      ) : null}
      <Field label={t('Request id')} hint={t('Made once for this request, so a re-send cannot create a second schedule')}>
        <Input aria-label={t('Request id')} value={clientAlgoId} readOnly density="dense" />
      </Field>

      {plan ? <KeyValue density="dense" aria-label={t('Preview')} items={rows.slice(4, 11)} /> : null}
      {general ? <Why>{problemWord(general)}</Why> : null}
      {blockerKey && blocker ? <Why code={CREATE_BLOCKER_CODE[blockerKey]}>{blocker}</Why> : null}
      {!writer.signedIn ? <Why>{t('Sign in to create')}</Why> : null}
      {duplicate ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg">
          <Badge tone="warn">{t('Already sent')}</Badge>
          <span>{t('Already sent body')}</span>
          <Button variant="secondary" size={32} onClick={() => onCheck(clientAlgoId)}>
            {t('Check status')}
          </Button>
        </div>
      ) : null}
      <Button size={40} fullWidth disabled={!canReview || writer.busy || writer.note.state !== 'none'} onClick={() => void openReview()}>
        {t('Review schedule')}
      </Button>
      <ConfirmDialog
        open={review}
        title={t('Create this schedule?')}
        description={t('Confirm schedule body')}
        rows={rows}
        confirmLabel={t('Create schedule')}
        busy={writer.busy}
        confirmDisabled={sizesBlock}
        onConfirm={() => void send()}
        onCancel={() => setReview(false)}
      >
        {seed === null ? null : sizes.state === 'ready' ? (
          <ol aria-label={t('Slice sizes')} className="m-0 flex list-decimal flex-col gap-1 ps-5 text-sm text-fg">
            {sizes.sizes.map((size, i) => (
              <li key={i}>{`${fmtAmount(size, { places: amountPlaces })} ${market?.base ?? ''}`}</li>
            ))}
          </ol>
        ) : sizes.state === 'refused' ? (
          <Why code={sizes.code}>{t('Slice sizes refused')}</Why>
        ) : (
          <p className="m-0 text-sm text-fg-2">{t('Slice sizes loading')}</p>
        )}
      </ConfirmDialog>
    </section>
  );
}
