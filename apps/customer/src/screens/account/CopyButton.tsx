import { useEffect, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { accountScreenCopy } from './copy';

/** Copies `value` to the clipboard and says so for two seconds. The value is shown by the caller, never changed here. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = accountScreenCopy.useCopy();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
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
      <Button variant="secondary" size={32} aria-label={label ?? t('Copy account ID')} onClick={() => void copy()}>
        {state === 'done' ? t('Copied') : t('Copy')}
      </Button>
      <span className="acct-sr" role="status">
        {state === 'done' ? t('Copied') : state === 'failed' ? t('Copy failed') : ''}
      </span>
    </>
  );
}
