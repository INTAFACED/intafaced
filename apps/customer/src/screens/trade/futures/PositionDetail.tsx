import type { Position } from '@intafaced/exchange-contract/schemas';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, KeyValue, type KeyValueItem } from '@intafaced/ui';
import { fmtAmount, fmtPctPoints, fmtPrice } from '../../../data/format';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { MarginCall } from './api';
import { bpsToPct, stateOf } from './model';
import { PositionRowActions } from './PositionDialogs';
import { positionsCopy } from './positions-copy';
import { rowOf, signedAmount } from './positions-logic';
import { futuresRefusal } from './refusals';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

/** The margin-call panel. A call is shown only when one was delivered; "none" is a fact, not a green tick; undefined is "not asked". */
function MarginCallPanel({ call, t }: { call: MarginCall | null | undefined; t: T }) {
  const { timeZone } = usePreferences();
  const at = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : dayTime(ms, timeZone);
  };
  return (
    <section aria-label={t('Detail margin call')} className="rounded-sm border border-line p-3 text-sm">
      <h3 className="mb-1 text-sm font-medium">{t('Detail margin call')}</h3>
      {call === undefined ? (
        <p className="text-fg-2">{t('Detail margin call unchecked')}</p>
      ) : call === null ? (
        <p className="text-fg-2">{t('Detail margin call none')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          <li>{t('Detail margin call sequence', { sequence: String(call.sequence) })}</li>
          <li>{t('Detail margin call health', { pct: bpsToPct(call.healthBps) })}</li>
          <li className="text-fg-2">{t('Detail margin call called', { time: at(call.calledAt) })}</li>
          <li className="text-fg-2">{t('Detail margin call delivered', { time: at(call.deliveredAt) })}</li>
        </ul>
      )}
    </section>
  );
}

export function PositionDetail({
  position,
  marginCall,
  free,
  leverageCap,
  planeOff,
  onClose,
  onChanged,
  onReverse,
}: {
  position: Position;
  marginCall: MarginCall | null | undefined;
  free: string | null;
  leverageCap: string | null;
  planeOff: boolean;
  onClose(): void;
  onChanged(): void;
  onReverse?(p: Position): void;
}) {
  const { t } = positionsCopy.useCopy();
  const { timeZone } = usePreferences();
  const row = rowOf(position);
  const why = row.health.unknownWhy ? t(`Unknown why ${row.health.unknownWhy}`) : undefined;
  const pnl = signedAmount(position.unrealizedPnl, 8);
  const amount = (value: string | null) => (value === null ? null : fmtAmount(value, { places: 8 }));
  const price = (value: string | null) => (value === null ? null : fmtPrice(value, null));
  const closingReason = position.closingReason ? futuresRefusal({ code: position.closingReason }) : null;
  const items: KeyValueItem[] = [
    { key: 'id', label: t('KV id'), value: position.id, mono: true },
    { label: t('KV contract'), value: position.symbol },
    { label: t('KV side'), value: position.side === 'long' ? t('Side long') : t('Side short') },
    { label: t('KV size'), value: amount(position.contracts) },
    { label: t('KV contract size'), value: amount(position.contractSize) },
    { label: t('KV entry'), value: price(position.entryPrice) },
    {
      label: t('KV mark'),
      value: price(position.markPrice),
      hint: position.markPrice === null ? t('Positions mark unavailable') : undefined,
    },
    { label: t('KV notional'), value: amount(position.notional) },
    { label: t('KV leverage'), value: position.leverage === null ? null : `${fmtAmount(position.leverage, { places: 2 })}x` },
    { label: t('KV collateral'), value: amount(position.collateral) },
    { label: t('KV initial'), value: amount(position.initialMargin) },
    { label: t('KV maintenance'), value: amount(position.maintenanceMargin) },
    {
      label: t('KV unrealised'),
      value: pnl === null ? null : `${pnl} (${fmtPctPoints(position.percentage)})`,
      hint: pnl === null ? t('Positions mark unavailable') : undefined,
    },
    { label: t('KV realised'), value: signedAmount(position.realizedPnl, 8) },
    {
      label: t('KV ratio'),
      value:
        row.health.marginRatioPct === null
          ? null
          : t('Ratio value', { pct: row.health.marginRatioPct, band: t(`Band ${row.health.band}`) }),
      hint: why,
    },
    { label: t('KV liquidation'), value: price(position.liquidationPrice) },
    { label: t('KV distance'), value: row.distancePct === null ? null : fmtPctPoints(row.distancePct, { signed: false }) },
    {
      label: t('KV margin mode'),
      value: position.marginMode === null ? null : position.marginMode === 'isolated' ? t('Mode isolated') : t('Mode cross'),
    },
    { label: t('KV status'), value: stateOf(position) === 'closing' ? t('State closing') : t(`State ${row.state}`) },
    ...(closingReason ? [{ label: t('KV closing reason'), value: closingReason.body }] : []),
    { label: t('KV updated'), value: dayTime(position.timestamp, timeZone) },
  ];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('Dialog close')} className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Detail title', { contract: position.symbol })}</DialogTitle>
          <DialogDescription>{t('Detail description')}</DialogDescription>
        </DialogHeader>
        <div className="mt-3 flex flex-col gap-4">
          <KeyValue items={items} density="dense" />
          <MarginCallPanel call={marginCall} t={t} />
          <section aria-label={t('Detail actions')}>
            <PositionRowActions
              position={position}
              free={free}
              leverageCap={leverageCap}
              planeOff={planeOff}
              onChanged={onChanged}
              {...(onReverse ? { onReverse } : {})}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
