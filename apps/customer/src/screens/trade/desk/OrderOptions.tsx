import { ChevronDown } from 'lucide-react';
import { deskCopy } from './copy';
import { Menu } from '@intafaced/ui/lit';
import { Select } from '@intafaced/ui/lit/templates';
import { SPOT_TICKET_ORDER_TYPES } from '@intafaced/contracts/spot-order-types';
import type { OrderType } from './order-math';
import type { TypeReasonKey } from './order-type-access';
import { REFUSED_TAB_KEY, tifLabelKey, tifsFor, TYPE_TAB_KEY, UNSUPPORTED_TYPES, type Tif, type TifHelpKey } from './tif';

/**
 * The order kinds the ticket does not offer here, listed in the strip's last slot but disabled (J-cex-spot-04 #1): the
 * ticket types this market, its state or this account's mode refuses (`refusedTypes`), then the kinds the service
 * never takes (trailing stop). Each row is greyed and names its own reason.
 */
export function MoreOrderTypes({ refused }: { refused: ReadonlyMap<OrderType, TypeReasonKey> }) {
  const { t } = deskCopy.useCopy();
  return (
    <Menu
      size="sm"
      align="start"
      triggerLabel={t('More order types label')}
      label={
        <>
          {t('More order types')}
          <ChevronDown size={14} aria-hidden="true" />
        </>
      }
      items={[
        ...SPOT_TICKET_ORDER_TYPES.flatMap((kind) => {
          const reason = refused.get(kind);
          return reason === undefined ? [] : [{ kind, name: t(TYPE_TAB_KEY[kind]), reason: t(reason) }];
        }),
        ...UNSUPPORTED_TYPES.map((kind) => ({ kind, name: t(REFUSED_TAB_KEY[kind]), reason: t('Type reason trailing stop') })),
      ].map(({ kind, name, reason }) => ({
        key: kind,
        testId: `dk-type-off-${kind}`,
        label: (
          <>
            <span data-testid="dk-type-name">{name}</span>
            <span data-testid="dk-type-reason">{reason}</span>
          </>
        ),
        disabled: true,
        onSelect: () => undefined,
      }))}
    />
  );
}

/** Self-trade modes as the API names them. The engine does only the first; the others are listed, disabled, with why. */
const SELF_TRADE = [
  ['cancel_maker', 'Self trade cancel maker'],
  ['cancel_taker', 'Self trade cancel taker'],
  ['cancel_both', 'Self trade cancel both'],
] as const;

/** What an order does when it would match one of the person's own resting orders. Picked once for both tickets. */
export function SelfTradeSelect() {
  const { t } = deskCopy.useCopy();
  return (
    <div className="lt-field">
      <span className="lt-label" id="dk-stp-label">
        {t('Self trade')}
      </span>
      <Select
        size="sm"
        className="lt-grow"
        labelledBy="dk-stp-label"
        describedBy="dk-stp-note"
        title={t('Self trade cancel maker help')}
        value="cancel_maker"
        options={SELF_TRADE.map(([mode, key]) => ({
          value: mode,
          label: t(key),
          disabled: mode !== 'cancel_maker',
          title: mode === 'cancel_maker' ? t('Self trade cancel maker help') : t('Self trade unavailable'),
        }))}
      />
      <span className="lt-note" id="dk-stp-note">
        {t('Self trade unavailable')}
      </span>
    </div>
  );
}

/** The person's own label for the next order: up to 16 characters, the service's limit. Empty sends none. */
export function TagField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = deskCopy.useCopy();
  return (
    <label className="lt-field" title={t('Order tag help')}>
      <span className="lt-label">{t('Order tag')}</span>
      <input
        type="text"
        className="lt-grow"
        value={value}
        maxLength={16}
        placeholder={t('Order tag placeholder')}
        onChange={(event) => onChange(event.target.value)}
        aria-label={t('Order tag')}
      />
    </label>
  );
}

/** Time in force, picked once for the Buy and Sell tickets. Market orders offer only what an immediate order can use. */
export function TifSelect({ type, tif, onTif }: { type: OrderType; tif: Tif; onTif: (tif: Tif) => void }) {
  const { t } = deskCopy.useCopy();
  const options = tifsFor(type);
  const help = t(`${tifLabelKey(type, tif)} help` as TifHelpKey);
  return (
    <div className="lt-field">
      <span className="lt-label" id="lt-label">
        {t('Time in force')}
      </span>
      <Select
        size="sm"
        className="lt-grow"
        labelledBy="lt-label"
        title={help}
        value={tif}
        onChange={(next) => (next !== tif ? onTif(next as Tif) : undefined)}
        options={options.map((option) => ({
          value: option,
          label: t(tifLabelKey(type, option)),
          title: t(`${tifLabelKey(type, option)} help` as TifHelpKey),
        }))}
      />
    </div>
  );
}
