/**
 * Create a TWAP / VWAP / POV schedule, or a chase. The preview is the all-in view before anything is sent. When the slice scheduler is
 * off the room says so and does not make the call (a schedule created now would sit active and place nothing).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Segmented, Tag } from '@intafaced/ui/lit';
import { Checkbox, KeyValue } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPrice, type Loadable } from '../rooms/ui';
import { useNow, useRoomApi } from '../rooms/read';
import { rememberId } from '../rooms/store';
import type { RoomWriter } from '../rooms/write';
import type { AlgoParent, AlgoPolicy, PovBasis } from '../rooms/api';
import { execCopy } from './copy';
import { useLast, type ExecMarket } from './data';
import {
  DURATION_PRESETS,
  CREATE_BLOCKER_CODE,
  algoClientId,
  bpsAsPercent,
  chaseDistanceBps,
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
import { ConfirmDialog, DecimalField, Pick, TextField, Unknown, Why, placesFor, useWhen } from './parts';

export interface AlgoFormValues {
  symbol: string;
  side: Side;
  kind: 'twap' | 'vwap' | 'pov' | 'chase';
  duration: string;
  customSec: string;
  intervalSec: string;
  total: string;
  limit: string;
  pov: string;
  /** POV only: what the participation rate is applied to. */
  basis: PovBasis;
  /** TWAP only: random slice sizes fixed by `seed`. */
  random: boolean;
  seed: string;
  /** TWAP only: blank starts at once; a price makes the schedule wait for the market to reach it. */
  trigger: string;
  /** Chase only: the maximum distance from the start price, a percent. Blank refuses. */
  chase: string;
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
  basis: 'traded_volume',
  random: false,
  seed: '',
  trigger: '',
  chase: '',
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
    basis: parent.povBasis ?? 'traded_volume',
    random: parent.randomSeed != null,
    seed: parent.randomSeed != null ? String(parent.randomSeed) : '',
    trigger: parent.triggerPrice ?? '',
    chase: parent.chaseMaxDistanceBps != null ? bpsAsPercent(parent.chaseMaxDistanceBps) : '',
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
  // Each review asks afresh; an answer to an earlier ask is dropped, so the list always matches the numbers sent.
  const sizesAsk = useRef(0);
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
  const chase = form.kind === 'chase';
  const chaseBps = chase ? chaseDistanceBps(form.chase) : null;
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
        // A chase's only bound is its distance: a limit typed under another kind is not sent with it.
        limit: form.kind === 'chase' ? '' : form.limit,
        last,
        taker: market?.taker ?? null,
        participationBps: povBps,
        chaseDistance: form.chase,
        startMs: now,
      }),
    [form, durationMs, intervalMs, market, last, povBps, now],
  );

  const clientAlgoId = algoClientId(nonce);
  const blockerKey = createBlocker(policy.status === 'ready' ? policy.data.capability : null, market?.open === true);
  const blocker = blockerKey ? t(blockerKey) : null;
  const immature = policy.status === 'ready' && policy.data.immatureKinds.some((k) => k === form.kind);
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
    const ask = ++sizesAsk.current;
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
    if (ask !== sizesAsk.current) return;
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
          // A chase has no slices: its one order lives for the whole duration.
          sliceIntervalMs: chase ? durationMs! : intervalMs!,
          kind: form.kind,
          clientAlgoId,
          ...(chase ? { chaseDistanceBps: chaseBps! } : {}),
          ...(!chase && form.limit.trim() ? { limitPrice: form.limit.trim() } : {}),
          ...(form.kind === 'pov' ? { participationBps: povBps!, povBasis: form.basis } : {}),
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
        { label: t('Kind'), value: chase ? t('Chase') : form.kind.toUpperCase() },
        { label: t('Total size'), value: `${fmtAmount(form.total, { places: amountPlaces })} ${market?.base ?? ''}` },
        chase
          ? { label: t('Slices planned'), value: t('One order that follows the book') }
          : {
              label: t('Slices planned'),
              value: String(plan.slices),
              hint: t('Every {seconds} s', { seconds: String(Math.round(intervalMs! / 1000)) }),
            },
        chase
          ? { label: t('Size per slice'), value: `${fmtAmount(form.total, { places: amountPlaces })} ${market?.base ?? ''}` }
          : seed !== null
            ? { label: t('Size per slice'), value: t('Random sizes', { seed: String(seed) }) }
            : {
                label: t('Size per slice'),
                value: `${fmtAmount(plan.perSlice, { places: amountPlaces })} ${market?.base ?? ''}`,
                hint: t('Last slice takes the remainder: {size}', { size: fmtAmount(plan.lastSlice, { places: amountPlaces }) }),
              },
        chase
          ? {
              label: t('Maximum chase distance'),
              value: `${form.chase.trim()} %`,
              hint: t('Chase stops beyond it'),
            }
          : {
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
        trigger !== null
          ? { label: t('Ends about'), value: t('After the trigger price is reached') }
          : { label: t('Ends about'), value: when(plan.endsAt) },
        { label: t('Request id'), value: clientAlgoId, mono: true },
        ...(trigger !== null ? [{ label: t('Trigger price'), value: fmtPrice(trigger, market?.tickSize) }] : []),
      ]
    : [];

  const digits = (v: string) => v.replace(/\D/g, '');
  return (
    <section aria-label={t('New schedule')} className="lt-col-main">
      <h3>{t('New schedule')}</h3>
      <Pick
        label={t('Market')}
        value={form.symbol}
        options={markets.map((m) => ({ value: m.symbol, label: m.symbol }))}
        onChange={(v) => set('symbol', v)}
      />
      <Segmented
        label={t('Side')}
        value={form.side}
        onChange={(v) => set('side', v)}
        options={[
          { value: 'buy', label: t('Buy') },
          { value: 'sell', label: t('Sell') },
        ]}
      />
      <Pick
        label={t('Kind')}
        hint={immature ? t('Immature volume warning') : undefined}
        value={form.kind}
        options={[
          { value: 'twap', label: t('TWAP') },
          { value: 'vwap', label: t('VWAP') },
          { value: 'pov', label: t('POV') },
          { value: 'chase', label: t('Chase') },
        ]}
        onChange={(v) => set('kind', v)}
      />
      <DecimalField
        label={t('Total size ({asset})', { asset: market?.base ?? '' })}
        error={problems.includes('total') && form.total ? problemWord('total') : problems.includes('lot') ? problemWord('lot') : undefined}
        value={form.total}
        onValueChange={(v) => set('total', v)}
        precision={amountPlaces}
      />
      <Pick
        label={t('Duration')}
        error={problems.includes('duration') ? problemWord('duration') : undefined}
        value={form.duration}
        options={[...DURATION_PRESETS.map((p) => ({ value: p.id, label: t(`Duration ${p.id}`) })), { value: 'custom', label: t('Custom') }]}
        onChange={(v) => set('duration', v)}
      />
      {form.duration === 'custom' ? (
        <TextField
          label={t('Custom duration, seconds')}
          hint={t('Between 1 second and 24 hours (86400)')}
          value={form.customSec}
          onValueChange={(v) => set('customSec', digits(v))}
        />
      ) : null}
      {chase ? (
        <DecimalField
          label={t('Maximum chase distance, %')}
          hint={t('Chase distance hint')}
          error={problems.includes('chaseDistance') ? problemWord('chaseDistance') : undefined}
          value={form.chase}
          onValueChange={(v) => set('chase', v)}
          precision={2}
        />
      ) : null}
      {chase ? null : (
        <TextField
          label={t('Slice interval, seconds')}
          hint={t('Empty uses {seconds} s', {
            seconds: durationMs === null ? '—' : String(Math.round(defaultIntervalMs(durationMs) / 1000)),
          })}
          error={problems.includes('interval') ? problemWord('interval') : undefined}
          value={form.intervalSec}
          onValueChange={(v) => set('intervalSec', digits(v))}
        />
      )}
      {form.kind === 'pov' ? (
        <Pick
          label={t('Participation basis')}
          hint={t(`Participation basis hint ${form.basis}`)}
          value={form.basis}
          options={[
            { value: 'traded_volume', label: t('Traded volume') },
            { value: 'opposite_liquidity', label: t('Opposite-side liquidity') },
          ]}
          onChange={(v) => set('basis', v)}
        />
      ) : null}
      {form.kind === 'pov' ? (
        <TextField
          label={t('Participation, basis points')}
          hint={t('1 to 10000, so 1000 is 10% of volume')}
          error={problems.includes('participation') ? problemWord('participation') : undefined}
          value={form.pov}
          onValueChange={(v) => set('pov', digits(v))}
        />
      ) : null}
      {chase ? null : (
        <DecimalField
          label={t('Limit price (optional)')}
          hint={t('No limit means market slices')}
          error={problems.includes('limit') ? problemWord('limit') : undefined}
          value={form.limit}
          onValueChange={(v) => set('limit', v)}
          precision={placesFor(market?.tickSize)}
        />
      )}
      {twap ? (
        <>
          <Checkbox
            label={t('Random slice sizes')}
            checked={form.random}
            onChange={(event) => set('random', event.currentTarget.checked)}
          />
          {form.random ? (
            <TextField
              label={t('Seed')}
              hint={t('Seed hint')}
              error={seedBad && form.seed.trim() ? t('Seed problem') : undefined}
              value={form.seed}
              onValueChange={(v) => set('seed', digits(v))}
            />
          ) : null}
          <DecimalField
            label={t('Start when the price reaches')}
            hint={t('Trigger hint')}
            error={triggerBad ? t('Trigger problem') : undefined}
            value={form.trigger}
            onValueChange={(v) => set('trigger', v)}
            precision={placesFor(market?.tickSize)}
          />
        </>
      ) : null}
      <TextField
        label={t('Request id')}
        hint={t('Made once for this request, so a re-send cannot create a second schedule')}
        value={clientAlgoId}
        readOnly
      />

      {plan ? (
        <KeyValue
          label={t('Preview')}
          rows={rows.slice(4, 11).map((r) => ({ label: r.label, value: r.value ?? <Unknown />, note: r.hint, ltr: r.mono }))}
        />
      ) : null}
      {general ? <Why>{problemWord(general)}</Why> : null}
      {blockerKey && blocker ? <Why code={CREATE_BLOCKER_CODE[blockerKey]}>{blocker}</Why> : null}
      {!writer.signedIn ? <Why>{t('Sign in to create')}</Why> : null}
      {duplicate ? (
        <div className="lt-toolbar">
          <Tag>{t('Already sent')}</Tag>
          <span>{t('Already sent body')}</span>
          <Button onClick={() => onCheck(clientAlgoId)}>{t('Check status')}</Button>
        </div>
      ) : null}
      <Button tone="primary" block disabled={!canReview || writer.busy || writer.note.state !== 'none'} onClick={() => void openReview()}>
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
        onCancel={() => {
          sizesAsk.current += 1;
          setReview(false);
        }}
      >
        {seed === null ? null : sizes.state === 'ready' ? (
          <ol aria-label={t('Slice sizes')}>
            {sizes.sizes.map((size, i) => (
              <li key={i}>{`${fmtAmount(size, { places: amountPlaces })} ${market?.base ?? ''}`}</li>
            ))}
          </ol>
        ) : sizes.state === 'refused' ? (
          <Why code={sizes.code}>{t('Slice sizes refused')}</Why>
        ) : (
          <p className="lt-hint">{t('Slice sizes loading')}</p>
        )}
      </ConfirmDialog>
    </section>
  );
}
