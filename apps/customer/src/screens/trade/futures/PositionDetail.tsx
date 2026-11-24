import type { Position } from '@intafaced/exchange-contract/schemas';
import { KeyValue, Sheet } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPctPoints, fmtPrice } from '../../../data/format';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { MarginCall } from './api';
import { bpsToPct, stateOf } from './model';
import { PositionRowActions } from './PositionDialogs';
import { positionsCopy } from './positions-copy';
import { rowOf, signedAmount } from './positions-logic';
import { futuresRefusal } from './refusals';
import { kvRows, type KvItem } from './kv-rows';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

/** The margin-call panel. A call is shown only when one was delivered; "none" is a fact, not a green tick; undefined is "not asked". */
function MarginCallPanel({ call, t }: { call: MarginCall | null | undefined; t: T }) {
  const { timeZone } = usePreferences();
  const at = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : dayTime(ms, timeZone);
  };
  return (
    <section aria-label={t('Detail margin call')} className="lt-callout">
      <h3 className="lt-strong">{t('Detail margin call')}</h3>
      {call === undefined ? (
        <p className="lt-quiet">{t('Detail margin call unchecked')}</p>
      ) : call === null ? (
        <p className="lt-quiet">{t('Detail margin call none')}</p>
      ) : (
        <ul className="lt-list lt-tight">
          <li>{t('Detail margin call sequence', { sequence: String(call.sequence) })}</li>
          <li>{t('Detail margin call health', { pct: bpsToPct(call.healthBps) })}</li>
          <li className="lt-quiet">{t('Detail margin call called', { time: at(call.calledAt) })}</li>
          <li className="lt-quiet">{t('Detail margin call delivered', { time: at(call.deliveredAt) })}</li>
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
  const items: KvItem[] = [
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
    <Sheet
      open
      title={t('Detail title', { contract: position.symbol })}
      description={t('Detail description')}
      closeLabel={t('Dialog close')}
      onClose={onClose}
    >
      <div className="lt-stack">
        <KeyValue rows={kvRows(items)} />
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
    </Sheet>
  );
}
