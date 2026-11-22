import { ChevronDown } from 'lucide-react';
import { deskCopy } from './copy';
import { Menu, MenuContent, MenuItem, MenuTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@intafaced/ui/lit';
import type { OrderType } from './order-math';
import { REFUSED_TAB_KEY, tifLabelKey, tifsFor, UNSUPPORTED_TYPES, type Tif, type TifHelpKey } from './tif';

const TYPE_KEY = REFUSED_TAB_KEY;

/**
 * The order kinds the market does not take (trailing stop), listed in the strip's last slot but disabled: each row is
 * greyed and one line says why.
 */
export function MoreOrderTypes() {
  const { t } = deskCopy.useCopy();
  return (
    <Menu>
      <MenuTrigger className="lt-icon-button" aria-label={t('More order types label')}>
        {t('More order types')}
        <ChevronDown size={14} aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start">
        <p className="lt-note" role="note">
          {t('Order type unavailable')}
        </p>
        {UNSUPPORTED_TYPES.map((kind) => (
          <MenuItem key={kind} disabled>
            {t(TYPE_KEY[kind])}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
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
  const items = Object.fromEntries(SELF_TRADE.map(([mode, key]) => [mode, t(key)]));
  return (
    <div className="lt-field">
      <span className="lt-label" id="dk-stp-label">
        {t('Self trade')}
      </span>
      <Select items={items} value="cancel_maker">
        <SelectTrigger
          size="sm"
          className="lt-grow"
          aria-labelledby="dk-stp-label"
          aria-describedby="dk-stp-note"
          title={t('Self trade cancel maker help')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {SELF_TRADE.map(([mode, key]) => (
            <SelectItem
              key={mode}
              value={mode}
              disabled={mode !== 'cancel_maker'}
              title={mode === 'cancel_maker' ? t('Self trade cancel maker help') : t('Self trade unavailable')}
            >
              {t(key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  const items = Object.fromEntries(options.map((option) => [option, t(tifLabelKey(type, option))]));
  const help = t(`${tifLabelKey(type, tif)} help` as TifHelpKey);
  return (
    <div className="lt-field">
      <span className="lt-label" id="lt-label">
        {t('Time in force')}
      </span>
      <Select items={items} value={tif} onValueChange={(next) => (next && next !== tif ? onTif(next as Tif) : undefined)}>
        <SelectTrigger size="sm" className="lt-grow" aria-labelledby="lt-label" title={help}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {options.map((option) => (
            <SelectItem key={option} value={option} title={t(`${tifLabelKey(type, option)} help` as TifHelpKey)}>
              {items[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
