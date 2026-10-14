import { useId } from 'react';
import { Info } from 'lucide-react';
import { ticketCopy } from './copy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Tooltip, TooltipContent, TooltipTrigger } from './deps';
import { postOnlyAllowed, TIF_VALUES, type Tif, type TicketOptions } from './options';
import './ticket.css';

/** A small info button with a one-line tooltip. The text also sits in the page for screen readers (it never depends on hover). */
export function InfoTip({ text, label }: { text: string; label: string }) {
  const id = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger className="tk-info" render={<button type="button" aria-label={label} aria-describedby={id} />}>
          <Info size={14} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent side="top">{text}</TooltipContent>
      </Tooltip>
      <span id={id} className="tk-sr">
        {text}
      </span>
    </>
  );
}

/** The plain name of a time in force. */
export function tifName(tif: Tif | 'PO', t: ReturnType<typeof ticketCopy.useCopy>['t']): string {
  return tif === 'IOC' ? t('TIF IOC') : tif === 'FOK' ? t('TIF FOK') : t('TIF GTC');
}

/**
 * Time in force and post-only for a limit order. Each has a one-line tooltip. Post-only is switched off and locked while
 * IOC or FOK is chosen: it is a promise to rest in the book, which those two never do.
 */
export function TicketOptionsRow({
  value,
  onChange,
  disabled = false,
}: {
  value: TicketOptions;
  onChange: (next: TicketOptions) => void;
  disabled?: boolean;
}) {
  const { t } = ticketCopy.useCopy();
  const names: Record<Tif, string> = { GTC: t('TIF GTC'), IOC: t('TIF IOC'), FOK: t('TIF FOK') };
  const tips: Record<Tif, string> = { GTC: t('Tip GTC'), IOC: t('Tip IOC'), FOK: t('Tip FOK') };
  const canPostOnly = postOnlyAllowed(value.timeInForce);
  return (
    <div className="tk-options" role="group" aria-label={t('Time in force')}>
      <div className="tk-opt">
        <span className="tk-opt-label">
          {t('Time in force')}
          <InfoTip text={tips[value.timeInForce]} label={t('About time in force')} />
        </span>
        <Select
          items={names}
          value={value.timeInForce}
          disabled={disabled}
          onValueChange={(next) => {
            const timeInForce = TIF_VALUES.find((v) => v === next);
            if (timeInForce) onChange({ timeInForce, postOnly: value.postOnly && postOnlyAllowed(timeInForce) });
          }}
        >
          <SelectTrigger size={32} className="tk-select" aria-label={t('Time in force')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIF_VALUES.map((tif) => (
              <SelectItem key={tif} value={tif}>
                {names[tif]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <PostOnlyField
        checked={value.postOnly}
        allowed={canPostOnly}
        disabled={disabled}
        onChange={(postOnly) => onChange({ timeInForce: value.timeInForce, postOnly: postOnly && canPostOnly })}
      />
    </div>
  );
}

/** The post-only switch with its one-line tooltip. `allowed` false (IOC or FOK chosen) locks it off and says why. */
export function PostOnlyField({
  checked,
  allowed,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  allowed: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = ticketCopy.useCopy();
  const switchId = useId();
  return (
    <div className="tk-opt tk-opt--switch">
      <label className="tk-opt-label" htmlFor={switchId}>
        {t('Post-only')}
      </label>
      <InfoTip text={allowed ? t('Tip post-only') : t('Tip post-only off')} label={t('About post-only')} />
      <Switch
        id={switchId}
        checked={checked && allowed}
        disabled={disabled || !allowed}
        onCheckedChange={(next) => onChange(next && allowed)}
      />
    </div>
  );
}
