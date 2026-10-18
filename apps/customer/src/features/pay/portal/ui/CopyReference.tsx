import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { uiCopy } from './copy';

/** An ID the merchant may need to quote. Copying says it worked, or says it didn't, to everyone including screen readers. */
export function CopyReference({ value, what }: { value: string; what?: string }) {
  const { t } = uiCopy.useCopy();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="pp-actions">
      <code className="pp-wrap">{value}</code>
      <Button
        variant="ghost"
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
