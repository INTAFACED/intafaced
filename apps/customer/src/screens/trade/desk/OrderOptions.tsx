import { ChevronDown } from 'lucide-react';
import { deskCopy } from './copy';
import { Menu, MenuContent, MenuItem, MenuTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './deps';
import type { OrderType } from './order-math';
import { tifLabelKey, tifsFor, UNSUPPORTED_TYPES, type Tif, type TifHelpKey, type UnsupportedType } from './tif';

const TYPE_KEY = {
  trailingStop: 'Order type trailingStop',
} as const satisfies Record<UnsupportedType, string>;

/**
 * The order kinds the market does not take (trailing stop), listed in the strip's last slot but disabled: each row is
 * greyed and one line says why.
 */
export function MoreOrderTypes() {
  const { t } = deskCopy.useCopy();
  return (
    <Menu>
      <MenuTrigger className="dk-type-more" aria-label={t('More order types label')}>
        {t('More order types')}
        <ChevronDown size={14} aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start" className="dk-type-menu">
        <p className="dk-type-reason" role="note">
          {t('Order type unavailable')}
        </p>
        {UNSUPPORTED_TYPES.map((kind) => (
          <MenuItem key={kind} disabled className="dk-type-item">
            {t(TYPE_KEY[kind])}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Time in force, picked once for the Buy and Sell tickets. Market orders offer only what an immediate order can use. */
export function TifSelect({ type, tif, onTif }: { type: OrderType; tif: Tif; onTif: (tif: Tif) => void }) {
  const { t } = deskCopy.useCopy();
  const options = tifsFor(type);
  const items = Object.fromEntries(options.map((option) => [option, t(tifLabelKey(type, option))]));
  const help = t(`${tifLabelKey(type, tif)} help` as TifHelpKey);
  return (
    <div className="dk-tif">
      <span className="dk-tif-label" id="dk-tif-label">
        {t('Time in force')}
      </span>
      <Select items={items} value={tif} onValueChange={(next) => (next && next !== tif ? onTif(next as Tif) : undefined)}>
        <SelectTrigger size={32} className="dk-tif-trigger" aria-labelledby="dk-tif-label" title={help}>
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
