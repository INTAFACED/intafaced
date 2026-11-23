import { useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { accountScreenCopy } from '../../../screens/account/copy';

/**
 * A titled panel of the Bank's account pages, drawn from the kit. `framed` draws it as a kit card, for a page whose
 * other panels are cards (Add money); inside a room's own section it stays bare, so no card sits inside a card.
 */
export function Panel({
  title,
  lead,
  children,
  id,
  framed = false,
}: {
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  id?: string;
  framed?: boolean;
}) {
  const heading = useId();
  const body = (
    <>
      <h3 id={heading}>{title}</h3>
      {lead && <p className="lt-hint">{lead}</p>}
      {children}
    </>
  );
  return framed ? (
    <section className="lt-region lt-stack" aria-labelledby={heading} id={id}>
      {body}
    </section>
  ) : (
    <section className="lt-stack" aria-labelledby={heading} id={id}>
      {body}
    </section>
  );
}

/** A control that is on the screen but cannot be used, with the reason next to it in plain words. */
export function DisabledAction({
  label,
  reason,
  tone = 'secondary',
}: {
  label: ReactNode;
  reason: ReactNode;
  tone?: 'primary' | 'secondary' | 'quiet';
}) {
  const id = useId();
  return (
    <div className="lt-stack">
      <div className="lt-actions">
        <Button tone={tone} disabled aria-describedby={id}>
          {label}
        </Button>
      </div>
      <p id={id} className="lt-hint">
        {reason}
      </p>
    </div>
  );
}

/** Copies `value` to the clipboard and says so for two seconds (the account screen's copy control, drawn from the kit). */
export function CopyValue({ value, label }: { value: string; label?: string }) {
  const { t } = accountScreenCopy.useCopy();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }
  return (
    <>
      <Button tone="secondary" aria-label={label ?? t('Copy account ID')} onClick={() => void copy()}>
        {state === 'done' ? t('Copied') : t('Copy')}
      </Button>
      <span className="lt-sr" role="status">
        {state === 'done' ? t('Copied') : state === 'failed' ? t('Copy failed') : ''}
      </span>
    </>
  );
}
