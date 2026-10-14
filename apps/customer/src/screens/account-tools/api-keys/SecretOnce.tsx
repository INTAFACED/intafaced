import { useEffect, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { apiKeysCopy } from './copy';

/**
 * The new key, shown once. It lives only in this component's props and the page text: it is never written to
 * storage, the address bar or the console, and the parent drops it the moment the dialog closes.
 */
export function SecretOnce({ secret }: { secret: string }) {
  const { t } = apiKeysCopy.useCopy();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  }
  return (
    <div className="tools-secret">
      <p className="tools-secret__label" id="tools-secret-label">
        {t('secret label')}
      </p>
      <div className="tools-secret__row">
        <code className="tools-secret__key" aria-labelledby="tools-secret-label" data-testid="api-key-secret">
          {secret}
        </code>
        <Button variant="secondary" size={32} onClick={() => void copy()}>
          {state === 'done' ? t('copied') : t('copy')}
        </Button>
      </div>
      <span className="tools-sr" role="status">
        {state === 'done' ? t('copied') : state === 'failed' ? t('copy failed') : ''}
      </span>
      {state === 'failed' ? <p className="tools-note tools-note--warn">{t('copy failed')}</p> : null}
    </div>
  );
}
