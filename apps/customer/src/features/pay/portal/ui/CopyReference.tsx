import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { uiCopy } from './copy';

/** An ID the merchant may need to quote. Copying says it worked, or says it didn't, to everyone including screen readers. */
export function CopyReference({ value, what }: { value: string; what?: string }) {
  const { t } = uiCopy.useCopy();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="lt-actions">
      <code className="lt-wrap">{value}</code>
      <Button
        tone="quiet"
        aria-label={what ? t('copyLabel', { what }) : undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {t('copy')}
      </Button>
      <span role={state === 'failed' ? 'alert' : 'status'}>
        {state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : ''}
      </span>
    </div>
  );
}
